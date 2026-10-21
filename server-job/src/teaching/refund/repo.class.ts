/**
 * 退费仓储 · 大学部（sms_class）· 表 `t_class_refund_apply` + 子表 `t_class_refund_item`
 * ============================================================
 *
 * 【与实训（蓝本）的差异 —— 实测】
 *   · **主表 + 费用项子表**：一次可退多种费用（学费 / 住宿费 / 餐费 …）
 *     → 统一成 items 数组（这正好是统一结构最自然的来源）
 *   · 状态字段 `refund_status` 是大学自己那套 4~5 级链的码（1~8，与初高逐值一致）
 *     → 经映射表翻译成统一码
 *   · `apply_no` 有申请单号（初高/实训没有）→ 需生成
 *   · 创建即「待经理审批」（**没有草稿态**）—— 统一后改为**先建草稿**，
 *     再由 submit 推进（与实训一致；用户点"提交"才进流程）
 *   · `is_need_principal`（按金额阈值决定是否走校长）→ 新链下**不再使用**
 *   · 金额 bigint（分）→ mysql2 回来是 string
 *   · 有 `applicant_id / applicant_name`（发起人）
 *
 * ⚠️ 写操作的 `conn` 是 **job 库的事务**，所以表名用全限定名 `sms_class.xxx`。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import type { RefundListQuery, RefundRow } from '../shared/dto';
import { REFUND_FEE_TYPE_NAME, REFUND_STATUS_NAME } from '../shared/dto';
import { toRawRefundStatus, toUnifiedRefundStatus } from '../shared/conf';
import { amountText, fmtDate, fmtDateTime, todayStr } from '../shared/format';
import type { RefundAggregate, RefundWriteInput, StudentOption } from './types';
import { tbl } from '../shared/uniTable';
import { hydrateWithArchive, ARCHIVE_TABLE } from '../shared/studentRef';

const T = 't_class_refund_apply';
const ITEM = 't_class_refund_item';
const S = 't_class_student';
const STAGE = 'class' as const;

/** ⚠️ 全限定表名（conn 来自 job 库事务） */
const WT = 'sms_class.t_class_refund_apply';
const WITEM = 'sms_class.t_class_refund_item';

/** 申请单号：TF + yyyymmdd + 5 位随机（够用且天然避重） */
function buildApplyNo(): string {
  const d = todayStr().replace(/-/g, '');
  const rnd = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `TF${d}${rnd}`;
}

/** 数据库行 → 统一结构（items 由调用方批量取好传入） */
async function decorate(
  row: Record<string, any>,
  itemRows: Array<Record<string, any>>,
): Promise<RefundRow> {
  const items = itemRows.map((x) => ({
    feeType: Number(x.fee_type),
    feeTypeName: REFUND_FEE_TYPE_NAME[Number(x.fee_type)] || '',
    amount: Number(x.amount || 0),
    amountText: amountText(x.amount),
  }));
  // 兜底：子表为空（老数据或异常）→ 用主表总额当一项"其他"
  if (!items.length) {
    items.push({
      feeType: 9,
      feeTypeName: REFUND_FEE_TYPE_NAME[9],
      amount: Number(row.refund_amount || 0),
      amountText: amountText(row.refund_amount),
    });
  }

  const unified = (await toUnifiedRefundStatus(STAGE, row.refund_status)) ?? 0;

  return {
    stage: STAGE,
    stageName: '大学部',
    id: String(row.id),
    studentId: String(row.student_id || ''),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    classId: row.class_id ? String(row.class_id) : null,
    className: row.class_name || null,
    deptName: null,
    feeTypeName: items.map((i) => i.feeTypeName).join('/'),
    items,
    refundAmount: Number(row.refund_amount || 0),
    refundAmountText: amountText(row.refund_amount),
    applyDate: fmtDate(row.apply_time),
    refundReason: String(row.refund_reason || ''),
    approvalStatus: unified,
    approvalStatusName: REFUND_STATUS_NAME[unified] || '',
    currentHandlerHint: null,
    financeRemark: row.finance_remark || null,
    /**
     * ★ 2026-10-21：大学部补上出款时间（迁移 migrations-class/20261021_001）。
     *   原来这一列不存在 → 列表「结束日期」只能显示「—」，与初高/就业不对齐。
     */
    refundTime: fmtDateTime(row.pay_out_time),
    createTime: fmtDateTime(row.create_time),
    canApprove: false,
    canCancel: false,
    canSubmit: false,
  };
}

/** 批量取子表并在内存里按 refund_id 分组 */
async function loadItems(ids: string[]): Promise<Record<string, Array<Record<string, any>>>> {
  const map: Record<string, Array<Record<string, any>>> = {};
  if (!ids.length) return map;
  const rows = (await db(ITEM).whereIn('refund_id', ids).where('is_deleted', 0)) as Array<
    Record<string, any>
  >;
  for (const r of rows) {
    const k = String(r.refund_id);
    (map[k] = map[k] || []).push(r);
  }
  return map;
}

/** 学生下拉 */
export async function studentOptions(keyword: string, limit: number): Promise<StudentOption[]> {
  const q = tbl(db, 'sms_class', S, STAGE).where('is_deleted', 0);
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
  const r = (await tbl(db, 'sms_class', S, STAGE).where({ id, is_deleted: 0 }).first()) as
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
export async function list(q: RefundListQuery): Promise<{ rows: RefundRow[]; total: number }> {
  const base = db(T).where('is_deleted', 0);
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
  if (q.startDate) base.andWhere('apply_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) base.andWhere('apply_time', '<=', `${q.endDate} 23:59:59`);

  if (q.status) {
    if (q.status === 3) base.whereIn('refund_status', [3, 4, 5]);
    else base.andWhere('refund_status', await toRawRefundStatus(STAGE, q.status));
  }

  const [{ total }] = (await base.clone().count({ total: '*' })) as Array<{ total: number }>;
  const rows = (await base
    .clone()
    .orderBy('create_time', 'desc')
    .limit(q.size)
    .offset((q.page - 1) * q.size)) as Array<Record<string, any>>;

  // ★ 2026-10-20：学生属性以档案最新值为准（快照列只留作审计）
  await hydrateWithArchive(STAGE, rows, { conn: db });
  const itemMap = await loadItems(rows.map((r) => String(r.id)));
  return {
    rows: await Promise.all(rows.map((r) => decorate(r, itemMap[String(r.id)] || []))),
    total: Number(total),
  };
}

/** 单条 */
export async function detail(id: string): Promise<RefundRow | null> {
  const row = (await db(T).where({ id, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  // ★ 2026-10-20：详情与列表同口径（档案最新值）
  await hydrateWithArchive(STAGE, [row], { conn: db });
  const rows = (await db(ITEM).where({ refund_id: id, is_deleted: 0 })) as Array<
    Record<string, any>
  >;
  return decorate(row, rows);
}

/** 汇总 */
export async function aggregate(): Promise<RefundAggregate> {
  const rows = (await db(T)
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
    const uni = (await toUnifiedRefundStatus(STAGE, Number(r.refund_status))) ?? 0;
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
 * 写入：新建（主表 + 子表）
 *
 * ⚠️ 初始状态落**统一码 1（待提交）**。大学的 `RefundStatus.DRAFT` 也是 1，
 *    所以老代码读它不会串。提交时才推进到 2（待学管）。
 */
export async function insert(
  conn: any,
  input: RefundWriteInput,
  items: Array<{ feeType: number; amount: number }>,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const t = `${todayStr()} ${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes(),
  ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  await conn(WT).insert({
    id,
    create_time: now,
    create_by: input.initiatorId,
    is_deleted: false,

    apply_no: buildApplyNo(),
    student_id: input.studentId,
    student_no: input.studentNo || null,
    student_name: input.studentName || null,
    class_id: input.classId,
    class_name: input.className,
    dept_code: input.deptCode,

    refund_amount: input.refundAmount,
    refund_reason: input.refundReason,
    refund_status: 1, // 待提交（统一码；大学 DRAFT 也是 1）
    is_need_principal: 0, // 新链每笔都走校长，不再用阈值
    applicant_id: input.initiatorId,
    applicant_name: input.initiatorName,
    apply_time: t,
  });

  for (const it of items) {
    await conn(WITEM).insert({
      id: randomUUID(),
      create_time: now,
      create_by: input.initiatorId,
      is_deleted: false,
      refund_id: id,
      fee_type: it.feeType,
      amount: it.amount,
    });
  }
  return id;
}

/** 写入：改状态（统一码 → 大学原码） */
export async function setStatus(
  conn: any,
  id: string,
  unifiedStatus: number,
  patch: Record<string, any> = {},
): Promise<void> {
  const raw = await toRawRefundStatus(STAGE, unifiedStatus);
  await conn(WT)
    .where({ id })
    .update({
      refund_status: raw,
      update_time: new Date(),
      ...patch,
    });
}

/**
 * 写入：财务确认出款
 *
 * ★ 2026-10-21：原来这里是**空实现**（大学表没有出款列，只能把备注塞进审批备注），
 *   导致「登记出款」对大学部等于什么都没记 —— 与初高/就业不对齐。
 *   迁移 `migrations-class/20261021_001` 加了 `pay_out_time` / `finance_remark` 两列，
 *   这里按就业那套写法落库（没传时间就取当前时间）。
 */
export async function setFinance(
  conn: any,
  id: string,
  financeRemark: string | null,
  refundTime: string | null,
): Promise<void> {
  await conn(WT)
    .where({ id })
    .update({
      finance_remark: financeRemark,
      pay_out_time: refundTime ? new Date(refundTime) : new Date(),
      update_time: new Date(),
    });
}

/** 该学生是否有进行中的退费单 */
export async function hasPending(studentId: string): Promise<boolean> {
  const row = await db(T)
    .where({ student_id: studentId, is_deleted: 0 })
    .whereIn('refund_status', [2, 3, 4, 5])
    .first();
  return !!row;
}
