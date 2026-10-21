/**
 * 升实训（2026-10-20 批注）
 * ============================================================
 * 批注原文（班级管理页，红框在操作列）：
 *   「【升实训】：部门选择为就业部，不再有班主任，教员，助教，选择项目经理，
 *     就业老师，班级名称可以进行修改，选择就业部的阶段方案」
 *   + 追问确认：「整班全部转入」「升实训改变部门，可更改班级名称，也可保持原班级名称不变」
 *
 * 【口径 —— 这不是"新建一个实训班再把学生挪过去"，而是"这个班换部门"】
 *   ① 在 `sms_job.t_job_class` 建一个实训班（dept_code=3、stage_key='job'）：
 *      班级名称默认沿用原班名（可改）、阶段取「就业部阶段方案」、班级状态=开放；
 *      班主任 / 教员 / 助教 **全部为空**（批注要求），只填项目经理 + 就业老师。
 *   ② 原班学生整套搬到 `sms_job.t_student_base`（状态 → 实训中 8），
 *      同时写实训花名册 `t_job_class_student`（不写花名册，班级详情里就没人）。
 *   ③ 原班级与学生记录**逻辑删除** —— 等价于"搬到就业部"：大学部列表里不再有它，
 *      就业部/实训列表里出现新班。
 *
 * 【为什么不复用 /api/class/info/training/upgrade（老升实训）】
 *   老接口是"交棒"模型：要求必须六阶段、把原班状态改成"实训中"、生成交接单、
 *   沿用学员原班级号，且项目经理之外还保留班主任/教员。与本次批注的口径不一致，
 *   硬改会破坏仍在使用它的大学模块页面，所以新开一条独立链路。
 *
 * ⚠️ 只允许大学部（class）班级升实训：初高部学生要先「升云」到大学部再走这一步。
 */

import { randomUUID } from 'crypto';
import { BizCode, ClassStatus, DeptCode, StudentStatus } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { db as classDb } from '../../class/db';
import { phaseCodeCol, tbl, tblInsTrx, tblTrx } from '../shared/uniTable';
import { loadStagePlanOptions } from '../shared/stagePlans';
import { assertStageView } from './service';
import { genClassCode } from './repo.job';

export interface TrainingUpgradeInput {
  classId: string;
  /** 不传 = 沿用原班名 */
  className?: string;
  /** 就业部阶段方案的阶段编码（301/302/303…） */
  phaseCode?: number;
  projectManagerId?: string;
  projectManagerName?: string;
  employmentTeacherId?: string;
  employmentTeacherName?: string;
  remark?: string | null;
}

export interface TrainingUpgradeResult {
  targetClassId: string;
  targetClassName: string;
  classCode: string;
  moved: number;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 按账号 id 取姓名（前端没传 name 时的兜底；与老升实训同一口径） */
async function accountNameOf(id: string): Promise<string | null> {
  if (!id) return null;
  try {
    const [rows] = (await classDb.raw(
      `SELECT user_name AS n FROM \`sms_portal\`.t_sys_account WHERE id = ? LIMIT 1`,
      [id],
    )) as unknown as [Array<{ n?: string }>, unknown];
    return rows?.[0]?.n ?? null;
  } catch {
    return null;
  }
}

export async function upgradeClassToTraining(
  input: TrainingUpgradeInput,
  user: any,
): Promise<TrainingUpgradeResult> {
  // 升实训 = 跨部门动作：源是大学部、目标是实训，两个学段的访问权限都要有
  await assertStageView(user, 'class');
  await assertStageView(user, 'job');

  const classId = String(input.classId ?? '').trim();
  if (!classId) throw new BizError(BizCode.PARAM_ERROR, '缺少班级ID');

  const src = (await tbl(classDb, 'sms_class', 't_class_info', 'class')
    .where({ id: classId, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!src) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在或已删除');

  const srcName = String(src.class_name ?? '');
  const className = String(input.className ?? '').trim() || srcName;

  // 阶段必须落在「就业部阶段方案」里 —— 批注："选择就业部的阶段方案"
  const phaseCode = Number(input.phaseCode);
  const plans = await loadStagePlanOptions();
  const empPhases = plans.filter((p) => p.deptCode === DeptCode.EMPLOYMENT).flatMap((p) => p.phases);
  if (!Number.isFinite(phaseCode) || !empPhases.some((p) => p.value === phaseCode)) {
    throw new BizError(BizCode.PARAM_ERROR, '请选择「就业部阶段方案」里的阶段');
  }

  const pmId = String(input.projectManagerId ?? '').trim();
  if (!pmId) throw new BizError(BizCode.PARAM_ERROR, '请选择「项目经理」后再升实训');
  const etId = String(input.employmentTeacherId ?? '').trim();
  if (!etId) throw new BizError(BizCode.PARAM_ERROR, '请选择「就业老师」后再升实训');
  const pmName = String(input.projectManagerName ?? '').trim() || (await accountNameOf(pmId)) || '';
  const etName = String(input.employmentTeacherName ?? '').trim() || (await accountNameOf(etId)) || '';
  if (!pmName) throw new BizError(BizCode.PARAM_ERROR, '所选「项目经理」在系统账号里不存在，请重新选择');
  if (!etName) throw new BizError(BizCode.PARAM_ERROR, '所选「就业老师」在系统账号里不存在，请重新选择');

  const students = (await tbl(classDb, 'sms_class', 't_class_student', 'class')
    .where({ class_id: classId, is_deleted: 0 })) as Array<Record<string, any>>;
  if (!students.length) throw new BizError(BizCode.PARAM_ERROR, '该班级没有学生，无法升实训');

  const newId = randomUUID();
  const classCode = await genClassCode();
  const now = new Date();
  const today = ymd(now);
  const userId = user?.userId || 'system';
  const remark = String(input.remark ?? '').trim() || `由大学部「${srcName}」升实训`;

  return classDb.transaction(async (trx) => {
    /* ① 建实训班：班主任/教员/助教一律为空，只留项目经理 + 就业老师 */
    await tblInsTrx(trx, 'sms_job', 't_job_class', 'job', {
      id: newId,
      class_code: classCode,
      class_name: className,
      dept_code: DeptCode.EMPLOYMENT,
      [phaseCodeCol()]: phaseCode,
      stage_key: 'job',
      head_teacher_id: null,
      head_teacher_name: null,
      teacher_id: null,
      teacher_name: null,
      assistant_id: null,
      assistant_name: null,
      project_manager_id: pmId,
      project_manager_name: pmName,
      employment_teacher_id: etId,
      employment_teacher_name: etName,
      // 大学表叫 room、实训表叫 classroom
      classroom: src.room ?? null,
      open_date: today,
      close_date: null,
      student_count: students.length,
      class_status: ClassStatus.OPEN,
      attendance_rate: null,
      remark,
      is_deleted: 0,
      create_time: now,
      create_by: userId,
      update_time: now,
      update_by: userId,
    });

    /* ② 学生主档 + 花名册（两个都写，缺一个班级详情就是空名单） */
    for (const s of students) {
      const sid = randomUUID();
      await tblInsTrx(trx, 'sms_job', 't_student_base', 'job', {
        id: sid,
        student_no: s.student_no,
        student_name: s.student_name,
        gender: s.gender,
        age: s.age ?? null,
        birth_date: s.birth_date ?? null,
        dept_code: DeptCode.EMPLOYMENT,
        class_id: newId,
        class_name: className,
        // 批注：实训班不再有班主任 / 教员 / 助教
        head_teacher_id: null,
        head_teacher_name: null,
        teacher_id: null,
        teacher_name: null,
        assistant_id: null,
        assistant_name: null,
        student_status: StudentStatus.TRAINING,
        [phaseCodeCol()]: phaseCode,
        phone: s.phone ?? null,
        parent_name: s.parent_name ?? null,
        parent_phone: s.parent_phone ?? null,
        education: s.education ?? null,
        enroll_date: s.enroll_date ?? null,
        native_place: s.origin ?? null,
        graduate_school: s.graduate_school ?? null,
        home_address: s.home_address ?? null,
        id_card: s.id_card ?? null,
        dorm_id: s.dorm_id ?? null,
        dorm_no: s.dorm_no ?? null,
        attendance_rate: s.attendance_rate ?? null,
        repeat_count: s.repeat_count ?? 0,
        remark: s.remark ?? null,
        // 大学表的列名：recruit_phone / consult_phone
        admission_teacher: s.recruit_teacher_name ?? null,
        admission_teacher_phone: s.recruit_phone ?? null,
        consult_teacher: s.consult_teacher_name ?? null,
        consult_teacher_phone: s.consult_phone ?? null,
        stage_key: 'job',
        is_deleted: 0,
        create_time: now,
        create_by: userId,
        update_time: now,
        update_by: userId,
      });

      await tblInsTrx(trx, 'sms_job', 't_job_class_student', 'job', {
        id: randomUUID(),
        class_id: newId,
        class_name: className,
        student_id: sid,
        student_no: s.student_no ?? null,
        student_name: s.student_name ?? null,
        join_date: today,
        join_type: 1,
        status: 1,
        remark: '升实训入班',
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }

    /* ③ 源学生 + 源班逻辑删除（= 整个班从大学部搬到就业部） */
    await tblTrx(trx, 'sms_class', 't_class_student', 'class')
      .where({ class_id: classId, is_deleted: 0 })
      .update({ is_deleted: 1, update_time: now, update_by: userId });
    await tblTrx(trx, 'sms_class', 't_class_info', 'class')
      .where({ id: classId })
      .update({ is_deleted: 1, update_time: now, update_by: userId });

    return { targetClassId: newId, targetClassName: className, classCode, moved: students.length };
  });
}
