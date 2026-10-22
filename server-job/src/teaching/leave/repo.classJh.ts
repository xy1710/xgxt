/**
 * 学籍异动仓储 · 初高（sms_class_jh）· 表 `t_class_flow`
 * ============================================================
 *
 * 【与实训（蓝本）的差异 —— 实测】
 *   · **通用流程引擎**：一张表装 7 类流程
 *     （`FlowType`：1休学 2复学 3升班转班 4换人 5退学 6就业协议 7末班）
 *     → ★ 本次**只并 休学(1) / 退学(5) / 复学(2)** 三条；
 *       升班转班 / 换人 / 就业协议 / 末班 是初高独有功能，**不并入**（故所有查询都带 `flow_type IN (1,2,5)`）
 *   · **类型码与统一码不同**：复学=2、退学=5（统一码是 复学=3、退学=2）→ 必须过映射
 *   · **状态码也不同**：`flow_status` 用初高自己的 `SuspendStatus`（3=已同意、4=已驳回），
 *     且**原本没有「待校长」和「已撤回」** → 本次已在 shared-types 补齐 5/6
 *   · 学生状态写 `sms_class_jh.t_class_student`
 *
 * ⚠️ 写操作的 `conn` 是 **job 库的事务** → 表名用全限定名。
 */

import { randomUUID } from 'crypto';
import { StudentStatus } from 'shared-types';
import { db } from '../../class-jh/utils/db';
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
import { buildApplyNo } from '../shared/conf';
import { applyClassScope, applyClassScopeKeepNull } from '../shared/dataScope';
import { hydrateWithArchive } from '../shared/studentRef';

const T = 't_class_flow';
const S = 't_class_student';
const STAGE = 'jh' as const;
/** ★ 老表所在库（切读路由层 tbl() 的第一个参数） */
const SRC = 'sms_class_jh';


/** ★ 本域只关心这三类流程（其余 4 类是初高独有，不属于本次合并范围） */
const IN_SCOPE = [1, 2, 5];

/**
 * 行装饰（`classNames` = 复学班 id → 班级名，由调用方批量预取）
 *
 * ★★ 复学班名（2026-10-16 修）：初高老表 **只有 `resume_class_id`、没有名字列**
 *   → 原来 `newClassName` 硬写成 `null`，列表「复学班级」列永远是「—」，
 *     用户以为「我选了复学班但没存上」。其实 id 存得好好的，缺的是把 id 翻成名字。
 *   → 这里按 id 反查（不过滤 is_deleted，历史单里已软删的班也要显示名字）。
 */
async function decorate(
  row: Record<string, any>,
  classNames: Record<string, string> = {},
): Promise<LeaveRow> {
  const biz = (await toUnifiedLeaveBiz(STAGE, row.flow_type)) ?? 0;
  const st = (await toUnifiedLeaveStatus(STAGE, row.flow_status)) ?? 0;
  const resumeClassId = row.resume_class_id ? String(row.resume_class_id) : null;

  return {
    stage: STAGE,
    stageName: '初高部',
    id: String(row.id),
    bizType: biz,
    bizTypeName: LEAVE_BIZ_TYPE_NAME[biz] || '',
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    // ★ 2026-10-20：本表没有 gender / parent_phone 两列，
    //   值由 hydrateWithArchive 从学生档案补进来（补不到就保持 null）
    // ⚠️ 保持与大学/实训一致：原样透传档案值，不在这里做数值转换
    gender: row.gender ?? null,
    idCard: row.id_card_no || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: null,
    headTeacherName: null,
    leaveDate: fmtDate(row.suspend_start_date) || null,
    expectResumeDate: fmtDate(row.expect_resume_date) || null,
    newClassId: resumeClassId,
    newClassName: resumeClassId ? classNames[resumeClassId] || null : null,
    leaveReason: String(row.suspend_reason || row.apply_reason || ''),
    attendedHours: row.attended_hours != null ? Number(row.attended_hours) : null,
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
 * ★ 未办结的 `flow_status`（**初高原码**）：1 待提交 / 2 待经理 / 5 待校长
 *
 * 这三个码对应**统一码** 1 待提交 / 2 待学管 / 3 待校长（初高的「待校长」码是 5，
 * 不是 3 —— 见 shared/conf 的映射）。
 * 【为什么要含「待提交」】用户口径是「已有进行中的申请的学生不再出现在下拉里」，
 *   草稿也是一张没办完的单子；并且**下拉剔除必须与 hasPending 同口径**，
 *   否则会出现「下拉选得到、提交被拒」的错位。
 */
const PENDING_FLOW_STATUS = [1, 2, 5];

/** 有未办结异动单的学生 id（下拉剔除用；与 hasPending 同一口径） */
async function pendingStudentIds(): Promise<string[]> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .whereIn('flow_type', IN_SCOPE)
    .whereIn('flow_status', PENDING_FLOW_STATUS)
    .whereNotNull('student_id')
    .select('student_id')) as Array<Record<string, any>>;
  // ⚠️ 去重 + 剔空：ids 里混进 NULL 会让 `id NOT IN (..., NULL)` 恒不成立 → 名单整片空掉
  return [...new Set(rows.map((r) => String(r.student_id || '')).filter(Boolean))];
}

/**
 * 学生下拉
 *
 * ★ `opts.onlySuspended` = 只挑「当前处于休学」的学生（`student_status = 6`）。
 *   复学申请必须从休学名单里挑人，否则会出现「给在读生办复学」这种脏数据。
 * ★ `opts.excludeStatuses` = 剔除这些状态的学生（service 传「终态」：
 *   退学 7 / 流失 11 / 已就业 10 —— 已经终结、不能再办任何学籍异动）。
 *   ⚠️ `NOT IN (...) OR IS NULL`：老数据里 `student_status` 可能为 NULL，
 *      单写 `NOT IN` 会把这类行一起滤掉（NULL NOT IN => NULL => 不成立）。
 * ★ `opts.excludeWithPending` = **剔掉已有未办结申请的学生**（2026-10-16 用户要求）：
 *   以前只有 `create()` 的 `hasPending` 兜底，下拉里仍能看到这些人，选完提交才被拒。
 *   ⚠️ 口径与 `hasPending` 共用 `PENDING_FLOW_STATUS`，改一处就够。
 *   ⚠️ 「哪种类型要限/剔什么状态」是**业务规则**，判定在 service 一处；仓储只负责过滤。
 */
export async function studentOptions(
  keyword: string,
  limit: number,
  opts: { onlySuspended?: boolean; excludeStatuses?: number[]; excludeWithPending?: boolean } = {},
  user?: any,
): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_class_jh', S, STAGE).where('is_deleted', 0);
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
  const r = (await tbl(db, 'sms_class_jh', S, STAGE).where({ id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!r) return null;
  return {
    no: String(r.student_no || ''),
    name: String(r.student_name || ''),
    gender: r.gender || null,
    idCard: r.id_card_no || null,
    phone: r.phone || null,
    parentPhone: null,
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name || null,
    deptCode: r.dept_code != null ? Number(r.dept_code) : null,
    studentStatus: r.student_status != null ? Number(r.student_status) : null,
  };
}

/** 分页（★ 始终限定在三类流程内） */
export async function list(q: LeaveListQuery, user?: any): Promise<{ rows: LeaveRow[]; total: number }> {
  const base = tbl(db, SRC, T, STAGE).where('is_deleted', 0).whereIn('flow_type', IN_SCOPE);
  if (q.keyword) {
    base.andWhere((b) => {
      b.where('student_name', 'like', `%${q.keyword}%`).orWhere('student_no', 'like', `%${q.keyword}%`);
    });
  }
  if (q.classId) {
    /**
     * ★ 2026-10-20：班级筛选要「单据快照 + 档案现状」两边命中。
     *
     * 列表显示的学生班级已经改成**档案最新值**（见下方 hydrateWithArchive），
     * 如果筛选还只看单据上的 class_id，就会出现：
     *   学生从 A 班换到 B 班 → 单据 class_id 仍是 A，
     *   列表上明明显示「B 班」，按 B 班筛却一条都出不来。
     * 这种「看得见、筛不到」比不显示更让人困惑，所以这里一起兜住。
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
  if (q.startDate) base.andWhere('suspend_start_date', '>=', q.startDate);
  if (q.endDate) base.andWhere('suspend_start_date', '<=', q.endDate);
  if (q.bizType) base.andWhere('flow_type', await toRawLeaveBiz(STAGE, q.bizType));
  if (q.status) {
    // 统一「3 待校长」在初高的码是 5；「4 已通过」是 3 —— 用映射翻
    const raw = await toRawLeaveStatus(STAGE, q.status);
    base.andWhere('flow_status', raw);
  }

  /* ★ 数据范围：只看我负责的班的单据 */
  if (user) await applyClassScopeKeepNull(base, 'class_id', STAGE, user);

  const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>;
  const rows = (await base
    .clone()
    .orderBy('create_time', 'desc')
    .limit(q.size)
    .offset((q.page - 1) * q.size)) as Array<Record<string, any>>;
  /**
   * ★ 2026-10-20 用户口径「学生档案有的字段按档案走」：
   *   单据里的 student_name / class_name / id_card_no 是**开单时的快照**，
   *   学生换班或改名后就会和档案脱节（实测初高缴费已有 4 条班级漂移）。
   *   这里在装饰成 DTO 之前，用档案最新值覆盖掉快照列 ——
   *   快照本身仍留在库里做财务追溯，只是不再拿来显示。
   */
  await hydrateWithArchive(STAGE, rows, { conn: db });
  // ★ 复学班名按页批量预取（一次 whereIn，不是每行查一次）
  const names = await classNamesByIds(
    STAGE,
    rows.map((r) => r.resume_class_id),
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
  const row = (await tbl(db, SRC, T, STAGE).where({ id, is_deleted: 0 }).whereIn('flow_type', IN_SCOPE).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情同样以档案最新值为准（与列表口径一致，避免「列表新名、详情旧名」）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  // ★ 复学班名同样要反查（详情页也要显示）
  return decorate(row, await classNamesByIds(STAGE, [row.resume_class_id]));
}

/** 汇总 */
export async function aggregate(): Promise<LeaveAggregate> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .whereIn('flow_type', IN_SCOPE)
    .select('flow_type', 'flow_status')
    .count({ c: '*' })
    .groupBy('flow_type', 'flow_status')) as Array<Record<string, any>>;

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
    const biz = (await toUnifiedLeaveBiz(STAGE, Number(r.flow_type))) ?? 0;
    if (biz === 1) out.suspendCount += n;
    if (biz === 2) out.quitCount += n;
    if (biz === 3) out.resumeCount += n;
    const st = (await toUnifiedLeaveStatus(STAGE, Number(r.flow_status))) ?? 0;
    if (st === 2 || st === 3) out.pendingCount += n;
    if (st === 4) out.approvedCount += n;
  }
  return out;
}

/** 新建（`flow_type` 翻成本库原码：休学1 / 复学2 / 退学5） */
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
    //   初高老表 `t_class_flow` 根本没有 apply_no 这一列（切读前不生成也不撞车），
    //   统一表 apply_no 是 NOT NULL DEFAULT '' → 不写就落空串 → 同学段第二行就撞。
    apply_no: buildApplyNo(),
    flow_type: rawBiz,
    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    class_id: input.classId,
    class_name: input.className,

    apply_user_id: input.initiatorId,
    apply_user_name: input.initiatorName,
    apply_time: now,
    apply_reason: input.leaveReason,

    flow_status: 1, // 待提交（统一码；初高 DRAFT 也是 1）
    suspend_status: 1,
    current_node_name: '待提交',

    suspend_start_date: input.leaveDate || todayStr(),
    expect_resume_date: input.expectResumeDate,
    suspend_reason: input.leaveReason,
    id_card_no: input.idCard,
    phone: input.phone,
    attended_hours: input.attendedHours,
    resume_class_id: input.newClassId,
  });
  return id;
}

/** 改状态（统一码 → 初高的 `flow_status` 原码） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  const raw = await toRawLeaveStatus(STAGE, unifiedStatus);
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({
      flow_status: raw,
      // 初高还有一个冗余字段跟着走（它自己的老代码在用）
      suspend_status: raw,
      current_node_name: nodeNameOf(unifiedStatus),
      update_time: new Date(),
      ...patch,
    });
}

function nodeNameOf(unified: number): string {
  if (unified === 2) return '待经理审批';
  if (unified === 3) return '待校长审批';
  if (unified === 4) return '已同意';
  if (unified === 5) return '已驳回';
  if (unified === 6) return '已撤回';
  return '待提交';
}

/** 写入复学班 */
export async function setResumeClass(
  conn: any,
  id: string,
  classId: string,
  _className: string,
): Promise<void> {
  await tblTrx(conn, SRC, T, STAGE).where({ id }).update({ resume_class_id: classId });
}

/**
 * ★ 审批通过后：改 `t_class_student.student_status`
 *   休学 → 6（休学）· 退学 → 7（退学）· 复学 → 5（正式在读），并回到复学班
 *
 * 【★ 2026-10-15 修：复学的目标状态原来错写成 8（实训中）】
 *   统一三学段时这里**照抄了实训那一套**（实训的复学 = 回到实训 → 8 实训中），
 *   但初高的复学是「回到正式在读」→ 5，与初高老流程 `class-jh/routes/flow.route.ts`
 *   的 `FlowType.RESUME → StudentStatus.STUDYING` 口径一致。
 *
 *   为什么这个错必须修：`student_status` 是全系统的主状态字段，
 *   出勤的「应到名单」、宿舍在住校验、各类统计都按它过滤 ——
 *   初高学生一复学就被标成「实训中」，那些地方会跟着错，而且页面不报错、极难发现。
 *   实测（2026-10-15）：走真实流程复学后学生状态 = 8，确认就是这个映射写的。
 */
export async function afterApproved(conn: any, id: string, operatorId: string): Promise<void> {
  const row = (await tblTrx(conn, SRC, T, STAGE).where({ id }).first()) as Record<string, any> | undefined;
  if (!row) return;
  const biz = (await toUnifiedLeaveBiz(STAGE, Number(row.flow_type))) ?? 0;
  const newStatus =
    biz === 3 ? StudentStatus.STUDYING : biz === 1 ? StudentStatus.SUSPENDED : StudentStatus.QUIT;

  const patch: Record<string, any> = {
    student_status: newStatus,
    update_time: new Date(),
    update_by: operatorId,
  };
  if (biz === 3 && row.resume_class_id) patch.class_id = row.resume_class_id;
  await tblTrx(conn, SRC, S, STAGE).where({ id: row.student_id }).update(patch);
}

/** 该学生是否有进行中的申请（初高学生表有 pending_flow_type 一列，但以本表为准更可靠） */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await tbl(db, SRC, T, STAGE)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('flow_type', IN_SCOPE)
    .whereIn('flow_status', PENDING_FLOW_STATUS) // 待提交 / 待经理 / 待校长(新)
    .first();
  return !!row;
}
