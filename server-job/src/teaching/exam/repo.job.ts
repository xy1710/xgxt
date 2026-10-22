/**
 * 考试仓储 · 实训（sms_job）· 表 t_job_exam
 *
 * 特点：**支持多班**（class_ids 逗号分隔）+ 时间是 datetime
 *      + 内容项只是逗号分隔的类型码（**没有满分**）+ 没有自定义字段
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import type {
  ExamContentItem,
  ExamDetail,
  ExamListQuery,
  ExamRow,
  ExamSaveBody,
} from '../shared/dto';
import { EXAM_CONTENT_TYPE_NAME, EXAM_TYPE_NAME } from '../shared/dto';
import { tbl, tblIns } from '../shared/uniTable';
import { assertExamNotDuplicated } from './uniExamUnique';
import { visibleClassIds } from '../shared/dataScope';

const T = 't_job_exam';
const C = 't_job_class';
const STAGE = 'job' as const;

/** ⚠️ 主库连接没开 dateStrings，datetime 会以 Date 返回，这里统一成 YYYY-MM-DD */
function fmtDate(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

function splitIds(v: unknown): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function splitNums(v: unknown): number[] {
  return splitIds(v).map(Number).filter((n) => Number.isFinite(n));
}

function mapRow(r: Record<string, any>, contents: ExamContentItem[] = []): ExamRow {
  const types = contents.length ? contents.map((c) => c.type) : splitNums(r.content_types);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '就业部',
    examName: String(r.exam_name ?? ''),
    examType: Number(r.exam_type ?? 0),
    examTypeName: (r.exam_type_name as string) || EXAM_TYPE_NAME[Number(r.exam_type)] || '未知',
    examTypeCustom: (r.exam_type_name as string) || null,
    examDate: fmtDate(r.exam_time),
    classIds: splitIds(r.class_ids),
    classNames: String(r.class_names ?? ''),
    contentTypes: types,
    contentNames: types.map((t) => EXAM_CONTENT_TYPE_NAME[t] ?? '未知').join(' / '),
    status: 2, // 实训无审批状态
    statusName: '已提交',
    creatorName: (r.creator_name as string) || (r.create_by_name as string) || null,
    remark: (r.remark as string) ?? null,
  };
}

export async function list(q: ExamListQuery, user?: any): Promise<ExamRow[]> {
  const qb = tbl(db, 'sms_job', T, STAGE).where('is_deleted', 0);
  // 多班：用 FIND_IN_SET 精确匹配逗号串里的某一个 id
  if (q.classId) qb.andWhereRaw('FIND_IN_SET(?, class_ids)', [q.classId]);
  if (q.examType) qb.andWhere('exam_type', q.examType);
  if (q.startDate) qb.andWhere('exam_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) qb.andWhere('exam_time', '<=', `${q.endDate} 23:59:59`);
  if (q.keyword) qb.andWhere('exam_name', 'like', `%${q.keyword}%`);
  /* ★ 数据范围：实训考试是「多班共考」，班级存在 class_ids 逗号串里 → 用 FIND_IN_SET */
  if (user) {
    const ids = await visibleClassIds(STAGE, user);
    if (ids && !ids.length) return [];
    if (ids) {
      qb.andWhereRaw(
        '(' + ids.map(() => 'FIND_IN_SET(?, class_ids)').join(' OR ') + ')',
        ids,
      );
    }
  }
  const rows = (await qb.orderBy('exam_time', 'desc')) as Array<Record<string, any>>;
  return rows.map((r) => mapRow(r));
}

export async function detail(id: string): Promise<ExamDetail | null> {
  const rec = (await tbl(db, 'sms_job', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  return { record: mapRow(rec), contents: [], fields: [] };
}

export async function save(body: ExamSaveBody, userId: string, userName = '') {
  const ids = body.classIds ?? [];
  if (!ids.length) throw new Error('缺少班级');
  const classes = (await tbl(db, 'sms_job', C, STAGE).whereIn('id', ids).where('is_deleted', 0)) as Array<
    Record<string, any>
  >;
  if (!classes.length) throw new Error('班级不存在');
  const names = classes.map((c) => String(c.class_name ?? '')).join('、');

  /** ★ 同日同名 + 班级有交集即算重复（任务 #20，见 repo.class.ts 同类注释与迁移 20261016_007） */
  await assertExamNotDuplicated(db, STAGE, {
    classIds: classes.map((c) => String(c.id)),
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
    // exam_time 是 datetime：统一存当天 09:00（沿用原逻辑的"当天考试"语义）
    exam_time: new Date(`${body.examDate}T09:00:00`),
    class_ids: classes.map((c) => String(c.id)).join(','),
    class_names: names,
    content_types: (body.contents ?? []).map((c) => Number(c.type)).join(','),
    remark: body.remark ?? null,
    update_time: now,
    update_by: userId,
  };

  if (body.id) {
    await tbl(db, 'sms_job', T, STAGE).where({ id: body.id }).update(payload);
    return { id: body.id };
  }
  const id = randomUUID();
  await tblIns(db, 'sms_job', T, STAGE, {
    id,
    ...payload,
    creator_id: userId,
    creator_name: null,
    is_deleted: 0,
    create_time: now,
    create_by: userId,
  });
  return { id };
}

export async function remove(id: string, userId: string) {
  await tbl(db, 'sms_job', T, STAGE).where({ id }).update({ is_deleted: 1, update_time: new Date(), update_by: userId });
}
