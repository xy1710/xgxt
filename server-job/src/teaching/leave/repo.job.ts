/**
 * 学籍异动仓储 · 实训（sms_job）· 表 `t_job_student_leave`
 * ============================================================
 *
 * 【它为什么是「蓝本」】
 *   审批链统一采用实训那一套，所以这个仓储是另外两个学段对齐的目标：
 *   · `biz_type` 1休学/2退学/3复学 —— **就是统一码**
 *   · `approval_status` = `ApprovalStatus` —— **恒等**（仍走映射函数保持三套同构）
 *   · 审批单在**本库** `t_job_approval`
 *   · ★ 副作用最全：改学生主档 + **跨库同步到 sms_class.t_class_student** + 复学班
 */

import { randomUUID } from 'crypto';
import { StudentStatus } from 'shared-types';
import { db } from '../../utils/db';
import type { LeaveListQuery, LeaveRow } from '../shared/dto';
import { LEAVE_BIZ_TYPE_NAME, LEAVE_STATUS_NAME } from '../shared/dto';
import {
  toRawLeaveBiz,
  toRawLeaveStatus,
  toUnifiedLeaveBiz,
  toUnifiedLeaveStatus,
} from '../shared/conf';
import { fmtDate, fmtDateTime, todayStr } from '../shared/format';
import { classNamesByIds } from '../shared/classOptions';
import type { LeaveAggregate, LeaveWriteInput, StudentOption, StudentSnapshot } from './types';
import { tbl, tblTrx, tblInsTrx } from '../shared/uniTable';
import { hydrateWithArchive } from '../shared/studentRef';
import { buildApplyNo } from '../shared/conf';

const T = 't_job_student_leave';
const S = 't_student_base';
const STAGE = 'job' as const;
/** ★ 老表所在库（切读路由层 tbl() 的第一个参数） */
const SRC = 'sms_job';
/** ★ 老表所在库（切读路由层 tbl() 需要「库名.表名」） */
const WT = 'sms_job.t_job_student_leave';

/** ★ 班级库（大学部）学生表 —— 跨库全限定名（与实训原实现同款做法） */
const CLASS_DB_STUDENT = 'sms_class.t_class_student';

/**
 * 行装饰（`classNames` = 复学班 id → 班级名，由调用方批量预取）
 *
 * ★ 复学班名：本表**有** `new_class_name` 快照列，优先用快照；
 *   快照为空（老单 / 建单时没查到班级名）时**按 id 反查兜底** ——
 *   与初高（只有 id、没有名字列）保持同一口径，列表不会一处有名一处是「—」。
 */
async function decorate(
  row: Record<string, any>,
  classNames: Record<string, string> = {},
): Promise<LeaveRow> {
  const biz = (await toUnifiedLeaveBiz(STAGE, row.biz_type)) ?? 0;
  const st = (await toUnifiedLeaveStatus(STAGE, row.approval_status)) ?? 0;
  const newClassId = row.new_class_id ? String(row.new_class_id) : null;

  return {
    stage: STAGE,
    stageName: '实训',
    id: String(row.id),
    bizType: biz,
    bizTypeName: LEAVE_BIZ_TYPE_NAME[biz] || '',
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    gender: row.gender || null,
    idCard: row.id_card || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: row.dept_name || null,
    headTeacherName: row.head_teacher_name || null,
    leaveDate: fmtDate(row.leave_date) || null,
    expectResumeDate: null, // 实训表无此列
    newClassId,
    newClassName: row.new_class_name || (newClassId ? classNames[newClassId] || null : null),
    leaveReason: String(row.leave_reason || ''),
    attendedHours: row.attended_hours != null ? Number(row.attended_hours) : null,
    relatedRefundNo: row.related_refund_no || null,
    approvalStatus: st,
    approvalStatusName: LEAVE_STATUS_NAME[st] || '',
    currentHandlerHint: null,
    createTime: fmtDateTime(row.create_time),
    canApprove: false,
    canCancel: false,
    canSubmit: false,
  };
}

/**
 * ★ 未办结（= 统一码 1 待提交 / 2 待学管 / 3 待校长）
 *
 * 本表 `approval_status` 与统一码恒等，所以直接写 1/2/3。
 * 【为什么把「待提交」也算进去】用户口径是「已有进行中的申请的学生不再出现在下拉里」，
 *   草稿也是一张还没办完的单子；而且**下拉剔除的口径必须与 hasPending 完全一致**，
 *   否则会出现「下拉里选得到、提交却被拒」的错位（跟终态那一刀同一个道理）。
 *   ⚠️ 2026-10-16 统一：原来这里只有 [2,3]（漏了草稿），初高/大学都是 [1,2,3]。
 */
const PENDING_STATUSES = [1, 2, 3];

/** 有未办结异动单的学生 id（下拉剔除用；与 hasPending 同一口径） */
async function pendingStudentIds(): Promise<string[]> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .whereIn('approval_status', PENDING_STATUSES)
    .whereNotNull('student_id')
    .select('student_id')) as Array<Record<string, any>>;
  // ⚠️ 必须去重 + 剔空：`whereNotIn('id', ids)` 里一旦混进 NULL，
  //    `id NOT IN (..., NULL)` 恒不成立 → 学生列表整片变空（经典坑）
  return [...new Set(rows.map((r) => String(r.student_id || '')).filter(Boolean))];
}

/**
 * 学生下拉
 *
 * ★ `opts.onlySuspended` = 只挑「当前处于休学」的学生（`student_status = 6`）。
 *   复学申请必须从休学名单里挑人，否则会出现「给在读生办复学」这种脏数据。
 * ★ `opts.excludeStatuses` = 剔除这些状态的学生（service 传「终态」：
 *   退学 7 / 流失 11 / 已就业 10 —— 已经终结、不能再办任何学籍异动）。
 *   ⚠️ 用 `NOT IN (...) OR IS NULL`：老数据里 `student_status` 可能为 NULL，
 *      单写 `NOT IN` 会把这类行一起滤掉（NULL NOT IN => NULL => 不成立），
 *      那是「名单莫名少人」的经典成因。
 * ★ `opts.excludeWithPending` = **剔掉已有未办结申请的学生**（2026-10-16 用户要求）。
 *   以前只有 `create()` 里一道 `hasPending` 兜底，用户在下拉里仍能看到这些人，
 *   选完提交才被拒（「请勿重复提交」）—— 现在下拉直接不列，少一次白跑。
 *   ⚠️ 口径与 `hasPending` 必须是同一份 `PENDING_STATUSES`，改一处就够了。
 *   ⚠️ 「哪种类型要限/剔什么状态」是**业务规则**，判定在 service 一处；仓储只负责过滤。
 */
export async function studentOptions(
  keyword: string,
  limit: number,
  opts: { onlySuspended?: boolean; excludeStatuses?: number[]; excludeWithPending?: boolean } = {},
): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_job', S, STAGE).where('is_deleted', 0);
  if (opts.onlySuspended) q.andWhere('student_status', StudentStatus.SUSPENDED);
  if (opts.excludeStatuses?.length) {
    const ex = opts.excludeStatuses;
    q.andWhere((b) => b.whereNotIn('student_status', ex).orWhereNull('student_status'));
  }
  if (opts.excludeWithPending) {
    const ids = await pendingStudentIds();
    if (ids.length) q.whereNotIn('id', ids);
  }
  if (keyword) {
    q.andWhere((b) => {
      b.where('student_name', 'like', `%${keyword}%`).orWhere('student_no', 'like', `%${keyword}%`);
    });
  }
  const rows = (await q.limit(limit)) as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: String(r.id),
    no: String(r.student_no || ''),
    name: String(r.student_name || ''),
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name || null,
  }));
}

/** 取一个学生的快照 */
export async function findStudent(id: string): Promise<StudentSnapshot | null> {
  const r = (await tbl(db, 'sms_job', S, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!r) return null;
  return {
    no: String(r.student_no || ''),
    name: String(r.student_name || ''),
    gender: r.gender || null,
    idCard: r.id_card || null,
    phone: r.phone || null,
    parentPhone: r.parent_phone || null,
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name || null,
    deptCode: r.dept_code != null ? Number(r.dept_code) : null,
    studentStatus: r.student_status != null ? Number(r.student_status) : null,
  };
}

/** 分页 */
export async function list(q: LeaveListQuery): Promise<{ rows: LeaveRow[]; total: number }> {
  const base = tbl(db, SRC, T, STAGE).where('is_deleted', 0);
  if (q.keyword) {
    base.andWhere((b) => {
      b.where('student_name', 'like', `%${q.keyword}%`).orWhere('student_no', 'like', `%${q.keyword}%`);
    });
  }
  if (q.classId) {
    /**
     * ★ 2026-10-20：班级筛选「单据快照 + 档案现状」两边命中。
     *   列表显示的班级已改为档案最新值，只按单据 class_id 筛会出现
     *   「显示 B 班、按 B 班筛不到」（学生换班场景）。
     */
    const inClass = (await tbl(db, SRC, S, STAGE)
      .where({ is_deleted: 0, class_id: q.classId })
      .select('id')) as Array<Record<string, any>>;
    const ids = [...new Set(inClass.map((r) => String(r.id || '')).filter(Boolean))];
    base.andWhere((b) => {
      b.where('class_id', q.classId);
      if (ids.length) b.orWhereIn('student_id', ids);
    });
  }
  if (q.startDate) base.andWhere('leave_date', '>=', q.startDate);
  if (q.endDate) base.andWhere('leave_date', '<=', q.endDate);
  if (q.bizType) base.andWhere('biz_type', await toRawLeaveBiz(STAGE, q.bizType));
  if (q.status) base.andWhere('approval_status', q.status);

  const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>;
  const rows = (await base
    .clone()
    .orderBy('create_time', 'desc')
    .limit(q.size)
    .offset((q.page - 1) * q.size)) as Array<Record<string, any>>;
  // ★ 2026-10-20：学生属性以档案最新值为准（快照列只留作审计）
  await hydrateWithArchive(STAGE, rows, { conn: db });
  // ★ 复学班名按页批量预取（快照为空时用它兜底）
  const names = await classNamesByIds(
    STAGE,
    rows.map((r) => r.new_class_id),
  );
  return { rows: await Promise.all(rows.map((r) => decorate(r, names))), total: Number(total) };
}

/**
 * ★ 批量取「学生当前状态」：`{ 学生id: student_status }`
 *
 * 列表要显示「学生现状」（区别于单据状态），但这是**实时值**、
 * 不是异动单上的快照列，所以在 service 分页之后按页批量补，
 * 一次 whereIn 拿完（不是每行查一次 —— 跨学段合并时可能有几百行）。
 *
 * ⚠️ 不过滤 `is_deleted`：软删的学生也要能看到状态，否则列表出现空白。
 */
export async function studentStatuses(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const rows = (await tbl(db, SRC, S, STAGE)
    .whereIn('id', ids)
    .select('id', 'student_status')) as Array<Record<string, any>>;
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.id)] = Number(r.student_status ?? 0);
  return out;
}

export async function detail(id: string): Promise<LeaveRow | null> {
  const row = (await tbl(db, SRC, T, STAGE).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情与列表同口径（档案最新值）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  // ★ 复学班名快照为空时按 id 反查兜底
  return decorate(row, await classNamesByIds(STAGE, [row.new_class_id]));
}

/** 汇总 */
export async function aggregate(): Promise<LeaveAggregate> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .select('biz_type', 'approval_status')
    .count({ c: '*' })
    .groupBy('biz_type', 'approval_status')) as Array<Record<string, any>>;

  const out: LeaveAggregate = {
    total: 0,
    suspendCount: 0,
    quitCount: 0,
    resumeCount: 0,
    pendingCount: 0,
    approvedCount: 0,
  };
  for (const r of rows) {
    const n = Number(r.c || 0);
    out.total += n;
    const biz = Number(r.biz_type);
    if (biz === 1) out.suspendCount += n;
    if (biz === 2) out.quitCount += n;
    if (biz === 3) out.resumeCount += n;
    const st = Number(r.approval_status);
    if (st === 2 || st === 3) out.pendingCount += n;
    if (st === 4) out.approvedCount += n;
  }
  return out;
}

/**
 * 新建申请单（`input.bizType` 是统一码 → 本库恒等，仍走翻译保持同构）
 *
 * ⚠️ 只落「待提交」，**审批单由 service 在同一事务里建**。
 */
export async function insert(conn: any, input: LeaveWriteInput): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const rawBiz = await toRawLeaveBiz(STAGE, input.bizType);

  await tblInsTrx(conn, SRC, T, STAGE, {
    id,
    create_time: now,
    create_by: input.initiatorId,
    is_deleted: false,

    // ★ 第4期第2批：统一表 uk_approval(apply_no, edu_stage) 要求单号唯一。
    //   ⚠️ 但实训老表 `t_job_student_leave` 实测**没有 apply_no 这一列**，
    //   直接写会 `Unknown column 'apply_no' in 'field list'`（老表模式直接挂）。
    //   → 靠 `stripUniOnlyCols` 兜底：它按**目标表真实列清单**剔，不在清单里才剔。
    //   切读时这一列会真写进 t_uni_approval，老表模式下自动被剥掉。
    apply_no: buildApplyNo(),
    biz_type: rawBiz,
    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    gender: input.gender,
    id_card: input.idCard,
    phone: input.phone,
    parent_phone: input.parentPhone,

    class_id: input.classId,
    class_name: input.className,
    dept_name: input.deptName,
    dept_code: input.deptCode,

    head_teacher_id: input.headTeacherId,
    head_teacher_name: input.headTeacherName,

    attended_hours: input.attendedHours,
    leave_date: input.leaveDate || todayStr(),
    leave_reason: input.leaveReason,
    remark: null,

    new_class_id: input.newClassId,
    new_class_name: input.newClassName,

    approval_status: 1, // 待提交（统一码 = 本库码）
  });
  return id;
}

/** 改状态（`unifiedStatus` 是统一码 → 本库恒等；仍走映射函数保持三套同构） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  const raw = await toRawLeaveStatus(STAGE, unifiedStatus);
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({ approval_status: raw, update_time: new Date(), ...patch });
}

/** 写入复学班（审批通过时学管选定） */
export async function setResumeClass(
  conn: any,
  id: string,
  classId: string,
  className: string,
): Promise<void> {
  await tblTrx(conn, SRC, T, STAGE).where({ id }).update({ new_class_id: classId, new_class_name: className });
}

/**
 * ★ 审批通过后的动作（各学段各不相同）
 *   休学 → SUSPENDED · 退学 → QUIT · 复学 → TRAINING（并回到复学班）
 *   + **跨库同步**到 sms_class.t_class_student（按学号匹配）
 */
export async function afterApproved(conn: any, id: string, operatorId: string): Promise<void> {
  const row = (await tblTrx(conn, SRC, T, STAGE).where({ id }).first()) as Record<string, any> | undefined;
  if (!row) return;
  await applyStudentStatus(conn, row, operatorId);
}

/** 把学生状态写回主档 + 跨库同步（供 afterApproved 复用） */
async function applyStudentStatus(conn: any, row: Record<string, any>, operatorId: string): Promise<void> {
  const biz = Number(row.biz_type);
  const newStatus =
    biz === 3 ? StudentStatus.TRAINING : biz === 1 ? StudentStatus.SUSPENDED : StudentStatus.QUIT;

  const patch: Record<string, any> = {
    student_status: newStatus,
    update_time: new Date(),
    update_by: operatorId,
  };
  if (biz === 3) {
    patch.class_id = row.new_class_id;
    patch.class_name = row.new_class_name;
  }
  await tblTrx(conn, SRC, S, STAGE).where({ id: row.student_id }).update(patch);

  // ★ 跨库同步（同一事务，要么都成要么都滚）
  if (row.student_no) {
    await conn(CLASS_DB_STUDENT)
      .where({ student_no: row.student_no, is_deleted: false })
      .update({ student_status: newStatus, update_time: new Date(), update_by: operatorId });
  }
}

/** 该学生是否有进行中的申请 */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await tbl(db, SRC, T, STAGE)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('approval_status', PENDING_STATUSES)
    .first();
  return !!row;
}
