/**
 * 班级 · 学生换班（末班 / 升班）
 * ============================================================
 * 【业务口径（2026-10-20 用户确认）】
 *   末班：成绩不好 → 转到「进度相同或更慢」的班重修（进度 = 阶段码 stage_code）
 *   升班：成绩好 → 跳到「进度更快」的班
 *
 * 【数据落点】全部在 sms_common 的统一表，可放同一个事务里：
 *   · t_uni_student        学生的班籍（class_id/class_name + 目标班三岗老师快照）
 *   · t_uni_class_student  实训侧的成员表（job 才有行，jh/class 为空）
 *   · t_uni_class_transfer 换班留痕（from → to + 原因 + 时间）
 *   · t_uni_repeat         末班记录（含本场考试快照）+ 学生 repeat_count + 1
 *
 * 【★ 2026-10-22 用户新口径：末班 / 升班不再是「点一下直接生效」】
 *   改为：点末班/升班 → 生成一条**待接收单**（t_uni_consult_push）→
 *   目标班的班主任在「教学管理 → 待接收学员」页面点「接收」后才真正入班。
 *   理由：换班是**转人**，必须由接收方（目标班班主任）确认，
 *   否则发起方一句话就把别人的班撤了，责任不对等。
 *
 *   两种单据的区分（沿用老模块约定，接收端已支持）：
 *     · 末班（repeat）→ is_repeat_in = 1，source_system='grade-repeat'
 *       接收时：repeat_count + 1、写末班记录（带成绩快照）
 *     · 升班（promote）→ source_system='transfer'
 *       接收时：只转班籍，不计末班次数
 *
 *   学生的班籍 / 末班记录 / 换班留痕全部在**接收成功时**才写。
 */

import { randomUUID } from 'crypto';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { uniDb } from '../shared/uniTable';
import { assertClassInScope } from '../shared/dataScope';
import type { ClassStage } from '../shared/dto';

export type TransferMode = 'repeat' | 'promote';

type ClassRow = {
  id: string;
  class_name: string;
  stage_code: number | null;
  class_status: number | null;
  head_teacher_id: string | null;
  head_teacher_name: string | null;
  teacher_id: string | null;
  teacher_name: string | null;
  assistant_id: string | null;
  assistant_name: string | null;
  dept_code: number | null;
};

/** 已结业（CLASS_STATUS 4）的班不再作为换班目标 */
const CLOSED_STATUS = 4;

/** 待接收单状态：1 待接收（与老模块 ConsultStatus.PENDING 一致） */
const PUSH_STATUS_PENDING = 1;

async function classOf(stage: ClassStage, id: string): Promise<ClassRow> {
  const row = (await uniDb('t_uni_class')
    .where({ id, edu_stage: stage, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!row) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      '班级不存在或已被删除，请刷新列表后重试（若刚删了班级，请先在班级管理里恢复）',
    );
  }
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(row.id),
    class_name: String(row.class_name ?? ''),
    stage_code: n(row.stage_code),
    class_status: n(row.class_status),
    head_teacher_id: (row.head_teacher_id as string) ?? null,
    head_teacher_name: (row.head_teacher_name as string) ?? null,
    teacher_id: (row.teacher_id as string) ?? null,
    teacher_name: (row.teacher_name as string) ?? null,
    assistant_id: (row.assistant_id as string) ?? null,
    assistant_name: (row.assistant_name as string) ?? null,
    dept_code: row.dept_code === null || row.dept_code === undefined ? null : Number(row.dept_code),
  };
}

/**
 * 可选目标班级
 * @param mode repeat = 末班（进度 ≤ 当前）；promote = 升班（进度 > 当前）
 */
export async function transferTargets(
  stage: ClassStage,
  fromClassId: string,
  mode: TransferMode,
): Promise<Array<{ id: string; name: string; stageCode: number | null; headTeacherName: string | null }>> {
  const from = await classOf(stage, fromClassId);
  const rows = (await uniDb('t_uni_class')
    .where({ edu_stage: stage, is_deleted: 0 })
    .select('id', 'class_name', 'stage_code', 'class_status', 'head_teacher_name')) as Array<Record<string, any>>;

  return rows
    .filter((r) => String(r.id) !== from.id)
    .filter((r) => Number(r.class_status ?? 0) !== CLOSED_STATUS)
    .filter((r) => {
      if (from.stage_code === null) return true; // 进度未知 → 不拦，人工判断
      const sc = r.stage_code === null || r.stage_code === undefined ? null : Number(r.stage_code);
      if (sc === null) return true;
      return mode === 'repeat' ? sc <= from.stage_code : sc > from.stage_code;
    })
    .map((r) => ({
      id: String(r.id),
      name: String(r.class_name ?? ''),
      stageCode: r.stage_code === null || r.stage_code === undefined ? null : Number(r.stage_code),
      headTeacherName: (r.head_teacher_name as string) ?? null,
    }))
    .sort((a, b) => (b.stageCode ?? 0) - (a.stageCode ?? 0));
}

/** 待接收单号：LB{年月日}{4位流水}（与老模块末班推送同款，便于一眼认出） */
async function nextPushNo(): Promise<string> {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `LB${ymd}`;
  const row = (await uniDb('t_uni_consult_push')
    .where('consult_no', 'like', `${prefix}%`)
    .orderBy('consult_no', 'desc')
    .first()) as Record<string, any> | undefined;
  let seq = 1;
  if (row?.consult_no) {
    const n = parseInt(String(row.consult_no).slice(prefix.length), 10);
    if (!Number.isNaN(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export async function transferStudent(
  body: {
    stage: ClassStage;
    studentId: string;
    fromClassId: string;
    toClassId: string;
    mode: TransferMode;
    reason?: string | null;
    /** 末班留成绩快照时传（后端按该场考试读这名学生的成绩） */
    examId?: string | null;
  },
  user: any,
): Promise<{ ok: true; toClassName: string; pushNo: string; pending: true }> {
  const { stage, studentId, fromClassId, toClassId, mode } = body;
  if (!studentId || !fromClassId || !toClassId) {
    throw new BizError(BizCode.PARAM_ERROR, '缺少学生或班级参数');
  }
  if (fromClassId === toClassId) throw new BizError(BizCode.PARAM_ERROR, '目标班级不能与当前班级相同');

  // 只能动自己带的班（交棒模型的数据范围）
  await assertClassInScope(stage, fromClassId, user, '该班级成绩');

  const from = await classOf(stage, fromClassId);
  const to = await classOf(stage, toClassId);

  if (from.stage_code !== null && to.stage_code !== null) {
    if (mode === 'repeat' && to.stage_code > from.stage_code) {
      throw new BizError(BizCode.PARAM_ERROR, '末班只能转到进度相同或更慢的班级');
    }
    if (mode === 'promote' && to.stage_code <= from.stage_code) {
      throw new BizError(BizCode.PARAM_ERROR, '升班只能转到进度更快的班级');
    }
  }

  const stu = (await uniDb('t_uni_student')
    .where({ id: studentId, edu_stage: stage, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!stu) throw new BizError(BizCode.PARAM_ERROR, '学生不存在');
  if (String(stu.class_id ?? '') !== fromClassId) {
    throw new BizError(BizCode.PARAM_ERROR, '该学生已不在原班级，请刷新后重试');
  }

  // 末班：带上本场考试成绩快照（接收时由接收端取最近一次成绩）
  let examName: string | null = null;
  if (mode === 'repeat' && body.examId) {
    const ex = (await uniDb('t_uni_exam')
      .where({ id: body.examId, edu_stage: stage, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;
    examName = (ex?.exam_name as string) ?? null;
  }

  const now = new Date();
  const userId = user?.userId || 'system';
  const reason = (body.reason || '').trim() || (mode === 'repeat' ? '末班转班重修' : '升班');

  // 同一学员不允许同时有多条待接收单（与老模块 repeat-handoff 同口径）
  const dup = (await uniDb('t_uni_consult_push')
    .where({ origin_student_id: studentId, apply_status: PUSH_STATUS_PENDING, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (dup) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `该学员已有一条待接收的${mode === 'repeat' ? '末班' : '升班'}记录（${dup.consult_no}），请先让班主任处理`,
    );
  }

  const pushNo = await nextPushNo();

  /**
   * ★ 只写待接收单，**不动学生的班籍**。
   *   班籍变更 / 末班记录 / 换班留痕，都等目标班班主任在「待接收学员」点接收后再写
   *   （接收端：class/modules/consult/consult.route.ts 的 /receive）。
   */
  await uniDb('t_uni_consult_push').insert({
    id: randomUUID(),
    edu_stage: stage,
    consult_no: pushNo,
    student_name: stu.student_name ?? null,
    gender: stu.gender ?? null,
    phone: stu.phone ?? null,
    parent_phone: stu.parent_phone ?? null,
    age: stu.age ?? null,
    education: stu.education ?? null,
    origin: stu.origin ?? null,
    graduate_school: stu.graduate_school ?? null,
    home_address: stu.home_address ?? null,
    intend_dept_code: to.dept_code ?? stu.dept_code ?? null,
    intend_stage: to.stage_code,
    intend_class_id: to.id,
    intend_class_name: to.class_name,
    remark: `成绩管理「${mode === 'repeat' ? '末班' : '升班'}」转入，等待班主任接收：${reason}`,
    apply_status: PUSH_STATUS_PENDING,
    push_time: now.toISOString().slice(0, 19).replace('T', ' '),
    receiver_id: to.head_teacher_id,
    receiver_name: to.head_teacher_name,
    student_id: studentId,
    student_no: stu.student_no ?? null,
    source_system: mode === 'repeat' ? 'grade-repeat' : 'transfer',
    origin_student_id: studentId,
    from_class_id: from.id,
    from_class_name: from.class_name,
    is_repeat_in: mode === 'repeat' ? 1 : 0,
    transfer_reason: reason,
    is_deleted: 0,
    create_by: userId,
    create_time: now,
  } as never);

  void examName;
  return { ok: true, toClassName: to.class_name, pushNo, pending: true };
}
