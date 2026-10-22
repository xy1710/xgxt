/**
 * 退费仓储 · 初高（sms_class_jh）· 表 `t_class_refund`
 * ============================================================
 *
 * 【与实训（蓝本）的差异 —— 实测】
 *   · 状态字段叫 `refund_status`，是**初高自己那套 4~5 级链**的码：
 *       1 待提交 · 2 待经理 · 3 待教务核算 · 4 待财务出款 · 5 待校长 · 6 已退费 · 7 已驳回 · 8 已撤回
 *     → 必须经 conf.ts 的映射表翻译成统一码（**读写各翻一次**）
 *   · 费用类型只有**单选** `fee_type`（无子表）→ 统一成 items 数组（永远 1 项）
 *   · 金额是 int（分）
 *   · 有 `threshold_amount`（超阈值才走校长）—— 新链下**不再使用**（每笔都走校长）
 *   · 老流程里要求学生必须是「退学」状态才能申请退费（见原 route）——
 *     ★ 合并后**放宽**：不再强制（学段间口径统一，实训那边本来就不要求）
 *
 * ⚠️ 写操作的 `conn` 是 **job 库的事务**（service 为「业务单 + 审批单」开的事务），
 *    所以表名必须写**全限定名** `sms_class_jh.t_class_refund`。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
import type { RefundListQuery, RefundRow } from '../shared/dto';
import { REFUND_FEE_TYPE_NAME, REFUND_STATUS_NAME } from '../shared/dto';
import { toRawRefundStatus, toUnifiedRefundStatus } from '../shared/conf';
import { amountText, fmtDate, fmtDateTime, todayStr } from '../shared/format';
import type { RefundAggregate, RefundWriteInput, StudentOption } from './types';
import { tbl, tblInsTrx, tblTrx } from '../shared/uniTable';
import { applyClassScope, applyClassScopeKeepNull } from '../shared/dataScope';
import { hydrateWithArchive } from '../shared/studentRef';

const T = 't_class_refund';
const S = 't_class_student';
const DB = 'sms_class_jh' as const;
const STAGE = 'jh' as const;

async function decorate(row: Record<string, any>): Promise<RefundRow> {
  const feeType = Number(row.fee_type);
  const amount = Number(row.refund_amount || 0);
  const items = [
    {
      feeType,
      feeTypeName: REFUND_FEE_TYPE_NAME[feeType] || '',
      amount,
      amountText: amountText(amount),
    },
  ];
  const unified = (await toUnifiedRefundStatus(STAGE, row.refund_status)) ?? 0;

  return {
    stage: STAGE,
    stageName: '初高部',
    id: String(row.id),
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: null, // 初高表只有 dept_code，无名称
    feeTypeName: items.map((i) => i.feeTypeName).join('/'),
    items,
    refundAmount: amount,
    refundAmountText: amountText(amount),
    applyDate: fmtDate(row.apply_date),
    refundReason: String(row.refund_reason || ''),
    approvalStatus: unified,
    approvalStatusName: REFUND_STATUS_NAME[unified] || '',
    currentHandlerHint: null,
    // 初高没有独立的财务备注/出款时间列名对齐 → 复用 pay_out_time
    financeRemark: null,
    refundTime: fmtDateTime(row.pay_out_time),
    createTime: fmtDateTime(row.create_time),
    canApprove: false,
    canCancel: false,
    canSubmit: false,
  };
}

/** 学生下拉 */
export async function studentOptions(keyword: string, limit: number, user?: any): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_class_jh', S, STAGE).where('is_deleted', 0);
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
  const r = (await tbl(db, 'sms_class_jh', S, STAGE).where({ id, is_deleted: 0 }).first()) as
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
  const base = tbl(db, DB, T, STAGE).where('is_deleted', 0);
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
    const inClass = (await db(S)
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

  // ★ 状态过滤：前端给统一码 → 翻成初高原码再比
  if (q.status) {
    const raw = await toRawRefundStatus(STAGE, q.status);
    // 统一「3 待校长」在老数据里可能是 3 / 4 / 5（归并关系）→ 三个都要捞
    if (q.status === 3) base.whereIn('refund_status', [3, 4, 5]);
    else base.andWhere('refund_status', raw);
  }

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
  const row = (await tbl(db, DB, T, STAGE).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情与列表同口径（档案最新值）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  return decorate(row);
}

/** 汇总 */
export async function aggregate(): Promise<RefundAggregate> {
  const rows = (await tbl(db, DB, T, STAGE)
    .where('is_deleted', 0)
    .select('refund_status')
    .count({ c: '*' })
    .sum({ amt: 'refund_amount' })
    .groupBy('refund_status')) as Array<Record<string, any>>;

  const out: RefundAggregate = {
    total: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    approvedAmount: 0,
  };
  for (const r of rows) {
    const n = Number(r.c || 0);
    out.total += n;
    const raw = Number(r.refund_status);
    // ★ 用统一码归并判断（老码 2/3/4/5 都算"审批中"）
    const uni = (await toUnifiedRefundStatus(STAGE, raw)) ?? 0;
    if (uni === 2 || uni === 3) out.pendingCount += n;
    if (uni === 4) {
      out.approvedCount += n;
      out.approvedAmount += Number(r.amt || 0);
    }
    if (uni === 5) out.rejectedCount += n;
  }
  return out;
}

/**
 * 写入：新建业务单
 *
 * ⚠️ `refund_status` 落的是**统一码 1（待提交）** ——
 *    恰好初高的 `DRAFT` 也是 1，所以老代码读它也不会出问题。
 *    后续状态推进一律经 `setStatus` 翻译。
 */
export async function insert(conn: any, input: RefundWriteInput): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  // ★ conn 是 job 库事务 → 必须用 tblInsTrx（切读时落到 t_uni_refund 并补 edu_stage）
  await tblInsTrx(conn, DB, T, STAGE, {
    id,
    create_time: now,
    create_by: input.initiatorId,
    is_deleted: false,

    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    class_id: input.classId,
    class_name: input.className,
    dept_code: input.deptCode ?? 1,

    fee_type: input.feeType,
    refund_amount: input.refundAmount,
    refund_reason: input.refundReason,
    head_teacher_opinion: input.remark || null,
    apply_date: input.applyDate || todayStr(),

    is_fee_used_up: false,
    refund_status: 1, // 待提交（统一码；初高 DRAFT 也是 1）
    current_handler_name: '班主任',

    apply_user_id: input.initiatorId,
    apply_user_name: input.initiatorName,
    threshold_amount: 0, // 新链不再用阈值（每笔都走校长）
  });
  return id;
}

/** 写入：改状态（统一码 → 初高原码） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  const raw = await toRawRefundStatus(STAGE, unifiedStatus);
  await tblTrx(conn, DB, T, STAGE)
    .where({ id })
    .update({
      refund_status: raw,
      update_time: new Date(),
      ...patch,
    });
}

/** 写入：财务确认出款（初高没有 finance_remark 列，只记出款时间 + 单号） */
export async function setFinance(
  conn: any,
  id: string,
  _financeRemark: string | null,
  refundTime: string | null,
): Promise<void> {
  const now = new Date();
  await tblTrx(conn, DB, T, STAGE)
    .where({ id })
    .update({
      pay_out_time: refundTime ? new Date(refundTime) : now,
      pay_out_voucher_no: `PO${now.getTime()}`,
      update_time: now,
    });
}

/** 该学生是否有进行中的退费单 */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await tbl(db, DB, T, STAGE)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('refund_status', [2, 3, 4, 5]) // 老码里所有"审批中"
    .first();
  return !!row;
}
