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
import { tbl, tblTrx, useUni } from '../shared/uniTable';

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
    examTypeName: EXAM_TYPE_NAME[Number(r.exam_type)] ?? '未知',
    examDate: String(r.exam_date ?? '').slice(0, 10),
    classIds: r.class_id ? [String(r.class_id)] : [],
    classNames: String(r.class_name ?? ''),
    contentTypes: types,
    contentNames: types.map((t) => EXAM_CONTENT_TYPE_NAME[t] ?? '未知').join(' / '),
    status: 2, // 大学无审批状态，恒为"已提交"
    statusName: '已提交',
    creatorName: (r.creator_name as string) ?? null,
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

export async function list(q: ExamListQuery): Promise<ExamRow[]> {
  const qb = tbl(db, 'sms_class', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.examType) qb.andWhere('exam_type', q.examType);
  if (q.startDate) qb.andWhere('exam_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('exam_date', '<=', q.endDate);
  if (q.keyword) qb.andWhere('exam_name', 'like', `%${q.keyword}%`);
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

export async function save(body: ExamSaveBody, userId: string) {
  if (!body.classIds?.length) throw new Error('缺少班级');
  const classId = body.classIds[0];
  const cls = (await tbl(db, 'sms_class', C, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const now = new Date();
  const payload = {
    exam_name: body.examName,
    exam_type: body.examType,
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
      await tblTrx(trx, 'sms_class', CT, STAGE)
        .where({ exam_id: id, is_deleted: 0 })
        .update({ is_deleted: 1, update_time: now });
    } else {
      id = randomUUID();
      await tblTrx(trx, 'sms_class', T, STAGE).insert({
        id,
        ...payload,
        ...(useUni(STAGE) ? { edu_stage: STAGE } : {}),
        creator_id: userId,
        creator_name: null,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }
    for (const c of body.contents ?? []) {
      await tblTrx(trx, 'sms_class', CT, STAGE).insert({
        id: randomUUID(),
        ...(useUni(STAGE) ? { edu_stage: STAGE } : {}),
        exam_id: id,
        exam_content_type: Number(c.type),
        full_score: c.fullScore ?? 0,
        content_name: c.name ?? EXAM_CONTENT_TYPE_NAME[Number(c.type)] ?? null,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
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
