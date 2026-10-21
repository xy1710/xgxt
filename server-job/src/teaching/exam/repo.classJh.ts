/**
 * 考试仓储 · 初高（sms_class_jh）· 表 t_class_exam + t_class_exam_field
 *
 * 特点：单班 + 内容项存 JSON（exam_content_types / content_full_score）+ 有审批状态
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
import type {
  ExamContentItem,
  ExamCustomField,
  ExamDetail,
  ExamListQuery,
  ExamRow,
  ExamSaveBody,
} from '../shared/dto';
import { EXAM_CONTENT_TYPE_NAME, EXAM_STATUS_NAME, EXAM_TYPE_NAME } from '../shared/dto';
import { tbl, tblIns } from '../shared/uniTable';

const T = 't_class_exam';
const F = 't_class_exam_field';
const C = 't_class_info';
const STAGE = 'jh' as const;

function jArr(v: unknown): number[] {
  try {
    const x = JSON.parse(String(v ?? '[]'));
    return Array.isArray(x) ? x.map(Number) : [];
  } catch {
    return [];
  }
}
function jObj(v: unknown): Record<string, number> {
  try {
    const x = JSON.parse(String(v ?? '{}'));
    return x && typeof x === 'object' ? (x as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function mapRow(r: Record<string, any>): ExamRow {
  const types = jArr(r.exam_content_types);
  const status = Number(r.exam_status ?? 2);
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '初高部',
    examName: String(r.exam_name ?? ''),
    examType: Number(r.exam_type ?? 0),
    examTypeName: EXAM_TYPE_NAME[Number(r.exam_type)] ?? '未知',
    examDate: String(r.exam_date ?? '').slice(0, 10),
    classIds: r.class_id ? [String(r.class_id)] : [],
    classNames: String(r.class_name ?? ''),
    contentTypes: types,
    contentNames: types.map((t) => EXAM_CONTENT_TYPE_NAME[t] ?? '未知').join(' / '),
    status,
    statusName: EXAM_STATUS_NAME[status] ?? '已提交',
    creatorName: (r.create_by_name as string) ?? null,
    remark: (r.remark as string) ?? null,
  };
}

export async function list(q: ExamListQuery): Promise<ExamRow[]> {
  const qb = tbl(db, 'sms_class_jh', T, STAGE).where('is_deleted', 0);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.examType) qb.andWhere('exam_type', q.examType);
  if (q.startDate) qb.andWhere('exam_date', '>=', q.startDate);
  if (q.endDate) qb.andWhere('exam_date', '<=', q.endDate);
  if (q.keyword) qb.andWhere('exam_name', 'like', `%${q.keyword}%`);
  const rows = (await qb.orderBy('exam_date', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function detail(id: string): Promise<ExamDetail | null> {
  const rec = (await tbl(db, 'sms_class_jh', T, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!rec) return null;
  const full = jObj(rec.content_full_score);
  const contents: ExamContentItem[] = jArr(rec.exam_content_types).map((t) => ({
    type: t,
    name: EXAM_CONTENT_TYPE_NAME[t] ?? '未知',
    fullScore: full[String(t)] ?? full[t] ?? null,
  }));
  const fs = (await tbl(db, 'sms_class_jh', F, STAGE).where({ exam_id: id, is_deleted: 0 }).orderBy('sort_no')) as Array<
    Record<string, any>
  >;
  const fields: ExamCustomField[] = fs.map((f) => ({
    name: String(f.field_name ?? ''),
    type: String(f.field_type ?? ''),
    sortNo: Number(f.sort_no ?? 0),
  }));
  return { record: mapRow(rec), contents, fields };
}

export async function save(body: ExamSaveBody, userId: string, userName: string) {
  if (!body.classIds?.length) throw new Error('缺少班级');
  const classId = body.classIds[0];
  const cls = (await tbl(db, 'sms_class_jh', C, STAGE).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!cls) throw new Error('班级不存在');

  const types = (body.contents ?? []).map((c) => Number(c.type));
  const fullMap: Record<string, number> = {};
  for (const c of body.contents ?? []) {
    if (c.fullScore !== null && c.fullScore !== undefined) fullMap[String(c.type)] = Number(c.fullScore);
  }
  const now = new Date();
  const payload = {
    exam_name: body.examName,
    exam_type: body.examType,
    exam_date: body.examDate,
    class_id: cls.id,
    class_name: cls.class_name,
    exam_content_types: JSON.stringify(types),
    content_full_score: Object.keys(fullMap).length ? JSON.stringify(fullMap) : null,
    remark: body.remark ?? null,
    update_time: now,
    update_by: userId,
  };

  if (body.id) {
    await tbl(db, 'sms_class_jh', T, STAGE).where({ id: body.id }).update(payload);
    return { id: body.id };
  }
  const id = randomUUID();
  await tblIns(db, 'sms_class_jh', T, STAGE, {
    id,
    ...payload,
    exam_status: 1, // 草稿
    create_by_name: userName,
    is_deleted: 0,
    create_time: now,
    create_by: userId,
  });
  return { id };
}

export async function remove(id: string, userId: string) {
  await tbl(db, 'sms_class_jh', T, STAGE).where({ id }).update({ is_deleted: 1, update_time: new Date(), update_by: userId });
}
