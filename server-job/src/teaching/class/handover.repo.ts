/**
 * 班级交接 · 数据访问（统一表 sms_common.t_uni_class_handover）
 * ============================================================
 * 2026-10-19 批注：班级管理操作列加【交接】，一次交接同时记 5 个岗位的原/新负责人，
 * 并在班级详情里能看到记录。
 *
 * 【为什么在 sms_common】
 *   交接是跨部门（初高 / 大学 / 实训）同一个动作，三张老表各缺字段，
 *   所以建一张统一表，靠 stage 区分学段 —— 与阶段方案表同一个库。
 *
 * ⚠️ 只做「记录」的读写；改班级负责人由适配器调用各学段仓储完成，
 *    这里不碰任何业务表，避免跨库事务问题。
 */

import { randomUUID } from 'crypto';
import { commonDb } from '../../class/db';
import type {
  ClassHandoverPayload,
  ClassHandoverRole,
  ClassHandoverRow,
  ClassStage,
} from '../shared/dto';
import { CLASS_STAGE_NAME } from '../shared/dto';

const T = 't_uni_class_handover';

/** 交接里的 5 个岗位（顺序 = 页面展示顺序） */
export const HANDOVER_ROLES = [
  'headTeacher',
  'teacher',
  'assistant',
  'projectManager',
  'employmentTeacher',
] as const;
export type RoleKey = (typeof HANDOVER_ROLES)[number];

/** 一个岗位上的某个人（id/name 可能为空 = 该岗位没有人） */
export interface StaffSlot {
  id: string | null;
  name: string | null;
}

/** 岗位 → 表列名（camelCase → snake_case，一一对应，不用字典表） */
const COL: Record<RoleKey, string> = {
  headTeacher: 'head_teacher',
  teacher: 'teacher',
  assistant: 'assistant',
  projectManager: 'project_manager',
  employmentTeacher: 'employment_teacher',
};

function roleOf(row: Record<string, any>, key: RoleKey): ClassHandoverRole {
  const p = COL[key];
  return {
    oldId: row[`old_${p}_id`] ?? null,
    oldName: row[`old_${p}_name`] ?? null,
    newId: row[`new_${p}_id`] ?? null,
    newName: row[`new_${p}_name`] ?? null,
  };
}

function mapRow(row: Record<string, any>): ClassHandoverRow {
  return {
    id: String(row.id),
    stage: row.stage as ClassStage,
    stageName: row.stage_name || CLASS_STAGE_NAME[row.stage as ClassStage] || '',
    classId: String(row.class_id),
    className: String(row.class_name ?? ''),
    deptCode: row.dept_code === null || row.dept_code === undefined ? null : Number(row.dept_code),
    headTeacher: roleOf(row, 'headTeacher'),
    teacher: roleOf(row, 'teacher'),
    assistant: roleOf(row, 'assistant'),
    projectManager: roleOf(row, 'projectManager'),
    employmentTeacher: roleOf(row, 'employmentTeacher'),
    handoverDate: row.handover_date ? String(row.handover_date).slice(0, 10) : null,
    reason: row.reason ?? null,
    operatorId: row.operator_id ?? null,
    operatorName: row.operator_name ?? null,
    createTime: row.create_time ? String(row.create_time).slice(0, 19) : null,
  };
}

/** 某班的交接记录（新的在前） */
export async function listHandovers(
  stage: ClassStage,
  classId: string,
): Promise<ClassHandoverRow[]> {
  const rows = (await commonDb(T)
    .where({ class_id: classId, stage, is_deleted: 0 })
    .orderBy('handover_date', 'desc')
    .orderBy('create_time', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export interface InsertHandoverArgs {
  stage: ClassStage;
  classId: string;
  className: string;
  deptCode: number | null;
  /** 变更前（班级当前值） */
  old: Record<RoleKey, StaffSlot>;
  /** 变更后（提交的值；未换人的岗位 = 原值） */
  next: Record<RoleKey, StaffSlot>;
  handoverDate: string | null;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
}

/** 写一条交接记录 */
export async function insertHandover(a: InsertHandoverArgs): Promise<ClassHandoverRow> {
  const id = randomUUID();
  const now = new Date();
  const row: Record<string, any> = {
    id,
    class_id: a.classId,
    class_name: a.className,
    stage: a.stage,
    stage_name: CLASS_STAGE_NAME[a.stage] || '',
    dept_code: a.deptCode,
    handover_date: a.handoverDate,
    reason: a.reason,
    operator_id: a.operatorId,
    operator_name: a.operatorName,
    is_deleted: 0,
    create_by: a.operatorId,
    create_time: now,
  };
  for (const key of HANDOVER_ROLES) {
    const p = COL[key];
    row[`old_${p}_id`] = a.old[key].id;
    row[`old_${p}_name`] = a.old[key].name;
    row[`new_${p}_id`] = a.next[key].id;
    row[`new_${p}_name`] = a.next[key].name;
  }
  await commonDb(T).insert(row);
  return mapRow(row);
}

/** 前端只传「要换的人」；没传的字段 = 该岗位不变 */
export function pickNew(payload: ClassHandoverPayload, key: RoleKey): StaffSlot {
  const id = String((payload as Record<string, any>)[`${key}Id`] ?? '').trim();
  const name = String((payload as Record<string, any>)[`${key}Name`] ?? '').trim();
  return { id: id || null, name: name || null };
}
