/**
 * 考试仓储 · 大学（sms_class）· 表 t_class_exam + t_class_exam_content + t_class_exam_field
 *
 * 特点：单班 + 内容项在**子表**（exam_content_type/full_score/content_name）
 *      + 自定义字段是**全局定义**（t_class_exam_field 无 exam_id，对所有考试生效）
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import type {
  ExamContentItem,
  ExamCustomField,
  ExamDetail,
  ExamListQuery,
  ExamRow,
  ExamSaveBody,
} from '../shared/dto';
import { EXAM_CONTENT_TYPE_NAME, EXAM_TYPE_NAME } from '../shared/dto';
import { tbl, tblInsTrx, tblTrx } from '../shared/uniTable';
import { applyClassScope } from '../shared/dataScope';
import { assertExamNotDuplicated } from './uniExamUnique';

const T = 't_class_exam';
const CT = 't_class_exam_content';
const F = 't_class_exam_field';
const C = 't_class_info';
const STAGE = 'class' as const;

function mapRow(r: Record<string, any>, contents: ExamContentItem[] = []): ExamRow {
  const types = contents.map((c) => c.type);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '大学部',
    examName: String(r.exam_name ?? ''),
    examType: Number(r.exam_type ?? 0),
    examTypeName: (r.exam_type_name as string) || EXAM_TYPE_NAME[Number(r.exam_type)] || '未知',
    examTypeCustom: (r.exam_type_name as string) || null,
    examDate: String(r.exam_date ?? '').slice(0, 10),
    classIds: r.class_id ? [String(r.class_id)] : [],
    classNames: String(r.class_name ?? ''),
    contentTypes: types,
    contentNames: types.map((t) => EXAM_CONTENT_TYPE_NAME[t] ?? '未知').join(' / '),
    status: 2, // 大学无审批状态，恒为"已提交"
    statusName: '已提交',
    creatorName: (r.creator_name as string) || (r.create_by_name as string) || null,
    remark: null,
  };
}

async function contentsOf(examIds: string[]): Promise<Map<string, ExamContentItem[]>> {
  const out = new Map<string, ExamContentItem[]>();
  if (!examIds.length) return out;
  const rows = (await tbl(db, 'sms_class', CT, STAGE)
    .whereIn('exam_id', examIds)
    .where('is_deleted', 0)) as Array<
    Record<string, any>
  >;
  for (const c of rows) {
    const k = String(c.exam_id);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push({
      type: Number(c.exam_content_type),
      name: (c.content_name as string) || EXAM_CONTENT_TYPE_NAME[Number(c.exam_content_type)] || '未知',
      fullScore: c.full_score === null || c.full_score === undefined ? null : Number(c.full_score),
    });
  }
  return out;
}

export async function list(q: ExamListQuery, user?: any): Promise<ExamRow[]> {
  const qb = tbl(db, 'sms_class', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.examType) qb.andWhere('exam_type', q.examType);
  if (q.startDate) qb.andWhere('exam_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('exam_date', '<=', q.endDate);
  if (q.keyword) qb.andWhere('exam_name', 'like', `%${q.keyword}%`);
  /* ★ 数据范围：班主任只看自己带的班的考试；项目经理/就业按交棒阶段 */
  if (user && !(await applyClassScope(qb, 'class_id', STAGE, user))) return [];
  const rows = (await qb.orderBy('exam_date', 'desc')) as Array<Record<string, any>>;
  const cmap = await contentsOf(rows.map((r) => String(r.id)));
  return rows.map((r) => mapRow(r, cmap.get(String(r.id)) ?? []));
}

export async function detail(id: string): Promise<ExamDetail | null> {
  const rec = (await tbl(db, 'sms_class', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  const cmap = await contentsOf([id]);
  const contents = cmap.get(id) ?? [];
  const fs = (await tbl(db, 'sms_class', F, STAGE).where('is_deleted', 0)) as Array<Record<string, any>>;
  const fields: ExamCustomField[] = fs.map((f, i) => ({
    name: String(f.field_key ?? ''),
    type: String(f.field_type ?? ''),
    sortNo: i,
  }));
  return { record: mapRow(rec, contents), contents, fields };
}

export async function save(body: ExamSaveBody, userId: string, userName = '') {
  if (!body.classIds?.length) throw new Error('缺少班级');
  const classId = body.classIds[0];
  const cls = (await tbl(db, 'sms_class', C, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  /**
   * ★ 同班同日同名查重（任务 #20）
   *
   * 原来靠统一表的 `uk_exam(exam_name, exam_date, edu_stage)` 兜底，但那个唯一键
   * ① 老表根本没有（违反铁律⑧「不凭空加唯一索引」）；
   * ② 不含 `class_id` → 两个班同一天各有一场「期中考试」会被**误拦**；
   * ③ 让「开关关放行 / 开关开拒绝」行为不一致。
   * → 已由迁移 `20261016_007` 删除，改由本函数在写入前查重（两种模式同一段逻辑）。
   */
  await assertExamNotDuplicated(db, STAGE, {
    classIds: [classId],
    examName: body.examName,
    examDate: body.examDate,
    excludeId: body.id,
  });

  const now = new Date();
  const payload = {
    exam_name: body.examName,
    exam_type: body.examType,
    /* ★ 「其他」时把自定义名称落库（varchar50，见 sql/init/uni-tables.sql） */
    exam_type_name: body.examType === 5 ? (body.examTypeName || null) : null,
    exam_date: body.examDate,
    class_id: cls.id,
    class_name: cls.class_name,
    attendee_count: 0,
    update_time: now,
    update_by: userId,
  };

  const examId = await db.transaction(async (trx) => {
    let id = body.id;
    if (id) {
      await tblTrx(trx, 'sms_class', T, STAGE).where({ id }).update(payload);
    } else {
      id = randomUUID();
      await tblInsTrx(trx, 'sms_class', T, STAGE, {
        id,
        ...payload,
        creator_id: userId,
        /* ★ 之前写死 null → 列表「创始人」永远是「—」 */
        creator_name: userName || null,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }

    /**
     * ★★ 考试内容「整体替换」= **按 (exam_id, exam_content_type) upsert**（与 P2 出勤同款修正）
     *
     * 【为什么不能「先整体软删、再插入」】
     *   统一表 `t_uni_exam_content` 上有唯一键
     *     `uk_exam_content (exam_id, exam_content_type, edu_stage)`
     *   —— 这是**刻意的业务约束**：一场考试里一种内容项只应有一行。
     *   而软删只是把 `is_deleted` 置 1，**行还在、唯一键仍被占住**
     *   → 紧接着的 insert 必报
     *     `Duplicate entry '...' for key 't_uni_exam_content.uk_exam_content'`
     *
     * 【为什么老表模式一直"看起来正常"】
     *   老表 `t_class_exam_content` 只有 `idx_ec_exam(exam_id)` 普通索引，
     *   没有 (exam_id, exam_content_type) 唯一约束 → 软删 + 重插能过，
     *   只是悄悄堆历史行。属「老表宽松掩盖了代码缺陷」，切读统一表才炸出来。
     *
     * 【改法】
     *   已存在（含软删行）→ 原地 update 并复活 `is_deleted: 0`
     *   不存在 → insert
     *   本次未提交的旧内容项 → 逻辑删除（保留审计）
     */
    const prevContents = (await tblTrx(trx, 'sms_class', CT, STAGE)
      .where({ exam_id: id })
      .select('id', 'exam_content_type')) as Array<Record<string, any>>;
    const prevByType = new Map(prevContents.map((r) => [Number(r.exam_content_type), String(r.id)]));
    const submittedTypes = new Set((body.contents ?? []).map((c) => Number(c.type)));

    const staleIds = prevContents
      .filter((r) => !submittedTypes.has(Number(r.exam_content_type)))
      .map((r) => String(r.id));
    if (staleIds.length) {
      await tblTrx(trx, 'sms_class', CT, STAGE)
        .whereIn('id', staleIds)
        .update({ is_deleted: 1, update_time: now, update_by: userId });
    }

    for (const c of body.contents ?? []) {
      const type = Number(c.type);
      const contentPayload = {
        full_score: c.fullScore ?? 0,
        content_name: c.name ?? EXAM_CONTENT_TYPE_NAME[type] ?? null,
        update_time: now,
        update_by: userId,
      };
      const prevId = prevByType.get(type);
      if (prevId) {
        // 复用原行（软删过的行唯一键仍被占用，必须原地复活而不是新建）
        await tblTrx(trx, 'sms_class', CT, STAGE)
          .where({ id: prevId })
          .update({ ...contentPayload, is_deleted: 0 });
      } else {
        await tblInsTrx(trx, 'sms_class', CT, STAGE, {
          id: randomUUID(),
          exam_id: id,
          exam_content_type: type,
          ...contentPayload,
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }
    return id!;
  });

  return { id: examId };
}

export async function remove(id: string, userId: string) {
  const now = new Date();
  await db.transaction(async (trx) => {
    await tblTrx(trx, 'sms_class', T, STAGE)
      .where({ id })
      .update({ is_deleted: 1, update_time: now, update_by: userId });
    await tblTrx(trx, 'sms_class', CT, STAGE)
      .where({ exam_id: id, is_deleted: 0 })
      .update({ is_deleted: 1, update_time: now });
  });
}
