/**
 * 退费仓储 · 实训（sms_job）· 表 `t_job_refund`
 * ============================================================
 *
 * 【它为什么是「蓝本」】
 *   本域合并的决策是「**审批链统一采用实训那一套**」，所以这个仓储是
 *   另外两个学段要对齐的目标形态：
 *
 *   · 状态字段 `approval_status` **本身就是统一码**（= `ApprovalStatus`）
 *     → 状态映射是**恒等**的（仍走映射函数，保持三套代码同构）
 *   · 审批单在**本库** `t_job_approval`（全系统审批权威表）
 *   · 金额单位：分；`refund_amount` 是 bigint → mysql2 回来是 **string**，必须 Number()
 *   · 特有「退学退费」合并单：`tuition_amount / accommodation_amount / meal_amount`
 *     三项明细（其余单子这三列是 null）
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import type { RefundListQuery, RefundRow } from '../shared/dto';
import { REFUND_FEE_TYPE_NAME, REFUND_STATUS_NAME } from '../shared/dto';
import { toUnifiedRefundStatus } from '../shared/conf';
import { amountText, fmtDate, fmtDateTime, todayStr } from '../shared/format';
import type { RefundAggregate, RefundWriteInput, StudentOption } from './types';
import { tbl, tblTrx, tblInsTrx } from '../shared/uniTable';
import { applyClassScope, applyClassScopeKeepNull } from '../shared/dataScope';
import { hydrateWithArchive, ARCHIVE_TABLE } from '../shared/studentRef';

const T = 't_job_refund';
/** 写路径显式声明的库名（conn 来自 job 库事务，表也在 sms_job） */
const SRC = 'sms_job';
const S = 't_student_base';
const C = 't_job_class';
const STAGE = 'job' as const;

/** 数据库行 → 统一结构 */
async function decorate(row: Record<string, any>): Promise<RefundRow> {
  // ★ 费用项：退学合并单拆成三项；普通单只有一项
  const hasDetail =
    row.tuition_amount != null || row.accommodation_amount != null || row.meal_amount != null;

  const rawItems = hasDetail
    ? [
        { feeType: 1, amount: Number(row.tuition_amount ?? 0) },
        { feeType: 2, amount: Number(row.accommodation_amount ?? 0) },
        { feeType: 3, amount: Number(row.meal_amount ?? 0) },
      ].filter((x) => x.amount > 0)
    : [{ feeType: Number(row.refund_type), amount: Number(row.refund_amount ?? 0) }];

  const items = rawItems.map((x) => ({
    feeType: x.feeType,
    feeTypeName: REFUND_FEE_TYPE_NAME[x.feeType] || '',
    amount: x.amount,
    amountText: amountText(x.amount),
  }));

  const unified = (await toUnifiedRefundStatus(STAGE, row.approval_status)) ?? 0;

  return {
    stage: STAGE,
    stageName: '就业部',
    id: String(row.id),
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: row.dept_name || null,
    feeTypeName: items.map((i) => i.feeTypeName).join('/'),
    items,
    refundAmount: Number(row.refund_amount || 0),
    refundAmountText: amountText(row.refund_amount),
    applyDate: fmtDate(row.apply_date),
    refundReason: String(row.refund_reason || ''),
    approvalStatus: unified,
    approvalStatusName: REFUND_STATUS_NAME[unified] || '',
    currentHandlerHint: null, // 由 service 从审批单统一补
    financeRemark: row.finance_remark || null,
    refundTime: fmtDateTime(row.refund_time),
    createTime: fmtDateTime(row.create_time),
    canApprove: false,
    canCancel: false,
    canSubmit: false,
  };
}

/** 学生下拉（发起退费时选人） */
export async function studentOptions(keyword: string, limit: number, user?: any): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_job', S, STAGE).where('is_deleted', 0);
  /* ★ 数据范围：项目经理/班主任只能选自己带的班的学生 */
  if (user && !(await applyClassScope(q, 'class_id', STAGE, user))) return [];
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

/** 按 id 取一个学生（建单时做快照） */
export async function findStudent(id: string) {
  const r = (await tbl(db, 'sms_job', S, STAGE).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!r) return null;
  return {
    no: String(r.student_no || ''),
    name: String(r.student_name || ''),
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name || null,
    deptCode: r.dept_code != null ? Number(r.dept_code) : null,
  };
}

/** 分页查询 */
export async function list(q: RefundListQuery, user?: any): Promise<{ rows: RefundRow[]; total: number }> {
  // ★ 切读接入：t_job_refund → t_uni_refund（超集，列名同名保留）
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
    const inClass = (await tbl(db, ARCHIVE_TABLE[STAGE].dbName, S, STAGE)
      .where({ is_deleted: 0, class_id: q.classId })
      .select('id')) as Array<Record<string, any>>;
    const ids = [...new Set(inClass.map((r) => String(r.id || '')).filter(Boolean))];
    base.andWhere((b) => {
      b.where('class_id', q.classId);
      if (ids.length) b.orWhereIn('student_id', ids);
    });
  }
  if (q.startDate) base.andWhere('apply_date', '>=', q.startDate);
  if (q.endDate) base.andWhere('apply_date', '<=', q.endDate);
  // ⚠️ 状态过滤：前端给的是**统一码**，实训恒等，直接比
  if (q.status) base.andWhere('approval_status', q.status);

  /* ★ 数据范围：只看我负责的班的退费单 */
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

/** 单条 */
export async function detail(id: string): Promise<RefundRow | null> {
  const row = (await tbl(db, SRC, T, STAGE).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情与列表同口径（档案最新值）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  return decorate(row);
}

/** 汇总 */
export async function aggregate(): Promise<RefundAggregate> {
  const rows = (await tbl(db, SRC, T, STAGE)
    .where('is_deleted', 0)
    .select('approval_status')
    .count({ c: '*' })
    .sum({ amt: 'refund_amount' })
    .groupBy('approval_status')) as Array<Record<string, any>>;

  const out: RefundAggregate = {
    total: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    approvedAmount: 0,
  };
  for (const r of rows) {
    const st = Number(r.approval_status);
    const n = Number(r.c || 0);
    out.total += n;
    if (st === 2 || st === 3) out.pendingCount += n;
    if (st === 4) {
      out.approvedCount += n;
      out.approvedAmount += Number(r.amt || 0);
    }
    if (st === 5) out.rejectedCount += n;
  }
  return out;
}

/**
 * 写入：新建业务单
 *
 * ⚠️ `conn` 可能是 **job 库的事务**（service 层为「业务单 + 审批单」开的事务）。
 *    本表就在 sms_job，但切读层统一走 `sms_job.t_job_refund` 全限定名 ——
 *    与 `conn('t_job_refund')` 在当前连接下等价，切读时才会落到 sms_common 的 `t_uni_refund`。
 */
export async function insert(conn: any, input: RefundWriteInput): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await tblInsTrx(conn, SRC, T, STAGE, {
    id,
    create_time: now,
    create_by: input.initiatorId,
    is_deleted: false,

    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    class_id: input.classId,
    class_name: input.className,
    dept_name: input.deptName,
    dept_code: input.deptCode,

    head_teacher_id: input.headTeacherId,
    head_teacher_name: input.headTeacherName,

    refund_type: input.feeType,
    refund_type_name: REFUND_FEE_TYPE_NAME[input.feeType] || null,
    refund_amount: input.refundAmount,
    apply_date: input.applyDate || todayStr(),
    refund_reason: input.refundReason,

    approval_status: 1, // 1 待提交（统一码）
    remark: input.remark || null,
  });
  return id;
}

/** 写入：改状态（rawStatus 用**统一码**，实训恒等） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({ approval_status: unifiedStatus, update_time: new Date(), ...patch });
}

/** 写入：财务确认出款 */
export async function setFinance(
  conn: any,
  id: string,
  financeRemark: string | null,
  refundTime: string | null,
): Promise<void> {
  await tblTrx(conn, SRC, T, STAGE)
    .where({ id })
    .update({
      finance_remark: financeRemark,
      refund_time: refundTime ? new Date(refundTime) : new Date(),
      update_time: new Date(),
    });
}

/** 校验：该学生是否有进行中的退费单（大学那条"禁止重复"规则的统一版） */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await tbl(db, SRC, T, STAGE)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('approval_status', [2, 3])
    .first();
  return !!row;
}
