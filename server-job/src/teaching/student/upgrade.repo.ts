/**
 * 学生档案 · 升云记录数据访问（统一表 sms_common.t_uni_student_upgrade）
 * ============================================================
 * 2026-10-20 批注：学生档案页加【升云】（初高部 → 大学部开放班级），
 * 升云后要在学生详情「基础信息」里看到一条记录：原班主任 / 原班级 / 操作人。
 *
 * 【为什么单独一张表】
 *   升云会把档案从初高库搬到大学库（初高那条逻辑删除），
 *   原班级 / 原班主任这些信息搬完就没了 → 必须落一份快照。
 *   表在 sms_common，两个学段的详情页读同一份。
 *
 * ⚠️ 本文件只做「记录」的读写，档案搬运在 service.upgradeToUniversity 里，
 *    由它同一个事务调用这里 —— 不要在这里反向依赖学生仓储（会成环）。
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { commonDb } from '../../class/db';
import type { StudentUpgradeRow } from '../shared/dto';
import { fmtDateTime } from '../shared/format';

const T = 't_uni_student_upgrade';

/** 一条升云记录（写入用） */
export interface UpgradeInsertInput {
  studentNo: string;
  studentName: string;
  fromStudentId: string;
  fromClassId: string | null;
  fromClassName: string | null;
  fromHeadTeacherId: string | null;
  fromHeadTeacherName: string | null;
  toStudentId: string;
  toClassId: string;
  toClassName: string;
  toHeadTeacherName: string | null;
  operatorId: string | null;
  operatorName: string | null;
  remark?: string | null;
  upgradeTime: Date;
}

/**
 * 写一条升云记录（事务内调用：conn 传 trx 才能跟着回滚）
 *
 * ⚠️ 表名必须带 `sms_common.` 前缀：传进来的 trx 通常挂在 sms_class 连接上，
 *    裸表名会去 sms_class 库找 → 「数据表不存在（请先执行 npm run migrate）」
 *    —— 迁移其实早跑了，纯粹是用错了库（和 uniTable.ts 里记的同类坑）。
 */
export async function insertUpgrade(input: UpgradeInsertInput, conn: Knex = commonDb): Promise<string> {
  const id = randomUUID();
  await conn(`sms_common.${T}`).insert({
    id,
    student_no: input.studentNo,
    student_name: input.studentName,
    from_stage: 'jh',
    from_student_id: input.fromStudentId,
    from_class_id: input.fromClassId,
    from_class_name: input.fromClassName,
    from_head_teacher_id: input.fromHeadTeacherId,
    from_head_teacher_name: input.fromHeadTeacherName,
    to_stage: 'class',
    to_student_id: input.toStudentId,
    to_class_id: input.toClassId,
    to_class_name: input.toClassName,
    to_head_teacher_name: input.toHeadTeacherName,
    upgrade_time: input.upgradeTime,
    operator_id: input.operatorId,
    operator_name: input.operatorName,
    remark: input.remark ?? null,
    is_deleted: 0,
    create_time: input.upgradeTime,
    create_by: input.operatorId,
  });
  return id;
}

function mapRow(r: Record<string, any>): StudentUpgradeRow {
  return {
    id: String(r.id),
    studentNo: String(r.student_no ?? ''),
    studentName: String(r.student_name ?? ''),
    fromClassName: r.from_class_name ?? null,
    fromHeadTeacherName: r.from_head_teacher_name ?? null,
    toClassName: r.to_class_name ?? null,
    toHeadTeacherName: r.to_head_teacher_name ?? null,
    operatorId: r.operator_id ?? null,
    operatorName: r.operator_name ?? null,
    upgradeTime: fmtDateTime(r.upgrade_time),
    remark: r.remark ?? null,
  };
}

/**
 * 按学号取升云记录（学生详情用）
 *
 * ⚠️ 按**学号**查而不是学生ID：升云后大学那条是新 id，
 *    原初高 id 已经逻辑删除，只有学号是两边一致的（批注要求学号不变）。
 */
export async function listByStudentNo(studentNo: string): Promise<StudentUpgradeRow[]> {
  const no = String(studentNo || '').trim();
  if (!no) return [];
  const rows = (await commonDb(T)
    .where({ student_no: no, is_deleted: 0 })
    .orderBy('upgrade_time', 'desc')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}
