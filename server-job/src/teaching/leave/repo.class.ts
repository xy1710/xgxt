/**
 * 学籍异动仓储 · 大学部（sms_class）· 表 `t_class_suspend_apply`
 * ============================================================
 *
 * 【与实训（蓝本）的差异 —— 实测】
 *   · ★ 复学：老表 ApplyType 只有 1休学 2退学 3退费 4升学；
 *     2026-10-16 起**新增原码 5 = 复学**（统一码 3，见 shared/conf.ts），
 *     并给本表补了 `new_class_id` / `new_class_name` 两列（migrations-class/20261016_012）
 *   · 状态字段 `apply_status` 用大学自己的 `SuspendStatus`：
 *     1待提交 2待经理 3待校长 4已同意 5已驳回 —— **与统一码一一对应（恒等）**
 *     撤回原来是**软删单据**（`is_deleted=1`），本次补了 `WITHDRAWN=6` 改为记状态
 *   · 审批人**分字段存**（`manager_approver_*` / `principal_approver_*`）—— 统一后
 *     审批轨迹以 `t_job_approval` 为准，这两组列保留兼容老代码
 *   · 有 `apply_no` 申请单号（初高/实训没有）→ 需生成
 *
 * ⚠️ 写操作的 `conn` 是 **job 库的事务** → 表名用全限定名。
 */

import { randomUUID } from 'crypto';
import { StudentStatus } from 'shared-types';
import { db } from '../../class/db';
import type { LeaveListQuery, LeaveRow } from '../shared/dto';
import { LEAVE_BIZ_TYPE_NAME, LEAVE_STATUS_NAME } from '../shared/dto';
import {
  toRawLeaveBiz,
  toRawLeaveStatus,
  toUnifiedLeaveBiz,
  toUnifiedLeaveStatus,
} from '../shared/conf';
import { fmtDate, fmtDateTime, todayStr } from '../shared/format';
import type { LeaveAggregate, LeaveWriteInput, StudentOption, StudentSnapshot } from './types';
import { tbl, tblTrx, tblInsTrx } from '../shared/uniTable';
import { hydrateWithArchive } from '../shared/studentRef';
import { buildApplyNo } from '../shared/conf';
import { applyClassScope, applyClassScopeKeepNull } from '../shared/dataScope';

const T = 't_class_suspend_apply';
const S = 't_class_student';
const STAGE = 'class' as const;
/** ★ 老表所在库（切读路由层 tbl() 的第一个参数） */
const SRC = 'sms_class';


/** ★ 大学：休学(1) / 退学(2) / 复学(5)（5 = 2026-10-16 新增原码，统一码 3） */
const IN_SCOPE = [1, 2, 5];

async function decorate(row: Record<string, any>): Promise<LeaveRow> {
  const biz = (await toUnifiedLeaveBiz(STAGE, row.apply_type)) ?? 0;
  const st = (await toUnifiedLeaveStatus(STAGE, row.apply_status)) ?? 0;

  return {
    stage: STAGE,
    stageName: '大学部',
    id: String(row.id),
    bizType: biz,
    bizTypeName: LEAVE_BIZ_TYPE_NAME[biz] || '',
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    gender: null,
    idCard: row.id_card || null,
    phone: null,
    parentPhone: row.parent_phone || null,
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: null,
    headTeacherName: row.applicant_name || null,
    leaveDate: fmtDate(row.effect_date) || null,
    expectResumeDate: fmtDate(row.expect_resume_date) || null,
    newClassId: row.new_class_id ? String(row.new_class_id) : null,
    newClassName: row.new_class_name || null,
    leaveReason: String(row.apply_reason || ''),
    attendedHours: null,
    relatedRefundNo: null,
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
 * 本表 `apply_status` 与统一码一一对应（恒等），所以直接写 1/2/3。
 * 【为什么要含「待提交」】用户口径是「已有进行中的申请的学生不再出现在下拉里」，
 *   草稿也是一张没办完的单子；且**下拉剔除必须与 hasPending 同口径**，
 *   否则会出现「下拉选得到、提交被拒」的错位。
 */
const PENDING_APPLY_STATUS = [1, 2, 3];

/** 有未办结异动单的学生 id（下拉剔除用；与 hasPending 同一口径） */
async function pendingStudentIds(): Promise<string[]> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .whereIn('apply_type', IN_SCOPE)
    .whereIn('apply_status', PENDING_APPLY_STATUS)
    .whereNotNull('student_id')
    .select('student_id')) as Array<Record<string, any>>;
  // ⚠️ 去重 + 剔空：ids 里混进 NULL 会让 `id NOT IN (..., NULL)` 恒不成立 → 名单整片空掉
  return [...new Set(rows.map((r) => String(r.student_id || '')).filter(Boolean))];
}

/**
 * 学生下拉
 *
 * ★ `opts.onlySuspended` = 只挑「当前处于休学」的学生（`student_status = 6`）。
 *   ★ 2026-10-16 起大学开放复学（`LEAVE_STAGE_BIZ.class` 含 RESUME），
 *      复学（bizType=3）时 service 会传 `onlySuspended=true` —— 与初高/实训同口径。
 * ★ `opts.excludeStatuses` = 剔除这些状态的学生（service 传「终态」：
 *   退学 7 / 流失 11 / 已就业 10 —— 已经终结、不能再办任何学籍异动）。
 *   ⚠️ `NOT IN (...) OR IS NULL`：老数据里 `student_status` 可能为 NULL，
 *      单写 `NOT IN` 会把这类行一起滤掉（NULL NOT IN => NULL => 不成立）。
 * ★ `opts.excludeWithPending` = **剔掉已有未办结申请的学生**（2026-10-16 用户要求）：
 *   以前只有 `create()` 的 `hasPending` 兜底，下拉里仍能看到这些人，选完提交才被拒。
 *   ⚠️ 口径与 `hasPending` 共用 `PENDING_APPLY_STATUS`，改一处就够。
 */
export async function studentOptions(
  keyword: string,
  limit: number,
  opts: { onlySuspended?: boolean; excludeStatuses?: number[]; excludeWithPending?: boolean } = {},
  user?: any,
): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_class', S, STAGE).where('is_deleted', 0);
  /* ★ 数据范围：项目经理/班主任只能选自己带的班的学生 */
  if (user && !(await applyClassScope(q, 'class_id', STAGE, user))) return [];
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
  const r = (await tbl(db, 'sms_class', S, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
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

/** 分页（★ 始终限定在 休学/退学） */
export async function list(q: LeaveListQuery, user?: any): Promise<{ rows: LeaveRow[]; total: number }> {
  const base = tbl(db, SRC, T, STAGE).where('is_deleted', 0).whereIn('apply_type', IN_SCOPE);
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
  if (q.startDate) base.andWhere('apply_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) base.andWhere('apply_time', '<=', `${q.endDate} 23:59:59`);
  if (q.bizType) base.andWhere('apply_type', await toRawLeaveBiz(STAGE, q.bizType));
  if (q.status) base.andWhere('apply_status', await toRawLeaveStatus(STAGE, q.status));

  /* ★ 数据范围：只看我负责的班的单据 */
  if (user) await applyClassScopeKeepNull(base, 'class_id', STAGE, user);

  const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>;
  const rows = (await base
    .clone()
    .orderBy('create_time', 'desc')
    .limit(q.size)
    .offset((q.page - 1) * q.size)) as Array<Record<string, any>>;
  // ★ 2026-10-20：学生属性以档案最新值为准（快照列只留作审计）
  await hydrateWithArchive(STAGE, rows, { conn: db });
  return { rows: await Promise.all(rows.map(decorate)), total: Number(total) };
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
  const row = (await tbl(db, SRC, T, STAGE).where({ id, is_deleted: 0 }).whereIn('apply_type', IN_SCOPE).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情与列表同口径（档案最新值）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  return decorate(row);
}

/** 汇总 */
export async function aggregate(): Promise<LeaveAggregate> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .whereIn('apply_type', IN_SCOPE)
    .select('apply_type', 'apply_status')
    .count({ c: '*' })
    .groupBy('apply_type', 'apply_status')) as Array<Record<string, any>>;

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
    const biz = (await toUnifiedLeaveBiz(STAGE, Number(r.apply_type))) ?? 0;
    if (biz === 1) out.suspendCount += n;
    if (biz === 2) out.quitCount += n;
    if (biz === 3) out.resumeCount += n;
    const st = Number(r.apply_status);
    if (st === 2 || st === 3) out.pendingCount += n;
    if (st === 4) out.approvedCount += n;
  }
  return out;
}

/** 新建（`apply_status` 初值 = 1 待提交；大学 DRAFT 也是 1） */
export async function insert(conn: any, input: LeaveWriteInput): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const rawBiz = await toRawLeaveBiz(STAGE, input.bizType);
  const t = `${todayStr()} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  await tblInsTrx(conn, SRC, T, STAGE, {
    id,
    create_time: now,
    create_by: input.initiatorId,
    is_deleted: false,

    apply_no: buildApplyNo(),
    apply_type: rawBiz,
    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    class_id: input.classId,
    class_name: input.className,
    dept_code: input.deptCode,

    id_card: input.idCard,
    parent_phone: input.parentPhone,
    apply_reason: input.leaveReason,
    effect_date: input.leaveDate || todayStr(),
    expect_resume_date: input.expectResumeDate,

    // ★ 复学单：发起申请时必填的复学班（休学/退学单为 NULL）
    new_class_id: input.newClassId,
    new_class_name: input.newClassName,

    apply_status: 1, // 待提交
    applicant_id: input.initiatorId,
    applicant_name: input.initiatorName,
    apply_time: t,
  });
  return id;
}

/** 改状态（统一码 → 大学原码，恒等） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  const raw = await toRawLeaveStatus(STAGE, unifiedStatus);
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({ apply_status: raw, update_time: new Date(), ...patch });
}

/**
 * ★ 写入复学班（审批通过那一刻由 service 调；学管审批时可改班）
 *   名字快照一起落库 —— 与实训同款（列表展示不用再反查班级名）
 */
export async function setResumeClass(
  conn: any,
  id: string,
  classId: string,
  className: string,
): Promise<void> {
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({ new_class_id: classId, new_class_name: className });
}

/**
 * ★ 审批通过后：改 `t_class_student.student_status`
 *   休学 → 6（休学）· 退学 → 7（退学）· 复学 → 5（正式在读），并回到复学班
 *
 * 【复学目标状态 = 5 正式在读，不是 8 实训中】
 *   大学与初高同理（见 repo.classJh 的 2026-10-15 修复注释）：
 *   `student_status` 是全系统主状态字段，出勤「应到名单」、统计都按它过滤；
 *   大学学生一复学就被标成「实训中」会全线跟着错、页面还不报错。
 */
export async function afterApproved(conn: any, id: string, operatorId: string): Promise<void> {
  const row = (await tblTrx(conn, SRC, T, STAGE).where({ id }).first()) as Record<string, any> | undefined;
  if (!row) return;
  const biz = (await toUnifiedLeaveBiz(STAGE, Number(row.apply_type))) ?? 0;
  const newStatus =
    biz === 3 ? StudentStatus.STUDYING : biz === 1 ? StudentStatus.SUSPENDED : StudentStatus.QUIT;

  const patch: Record<string, any> = {
    student_status: newStatus,
    update_time: new Date(),
    update_by: operatorId,
  };
  // ★ 复学：回到复学班（service 在调本函数前已把复学班写进单据）
  if (biz === 3 && row.new_class_id) patch.class_id = row.new_class_id;
  await tblTrx(conn, SRC, S, STAGE).where({ id: row.student_id }).update(patch);
}

/** 该学生是否有进行中的申请 */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await tbl(db, SRC, T, STAGE)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('apply_type', IN_SCOPE)
    .whereIn('apply_status', PENDING_APPLY_STATUS)
    .first();
  return !!row;
}
