/**
 * ★ 2026-10-16 分期付款服务
 *
 * 业务口径（用户 2026-10-16 确认）：
 *   · 一次「发起收费」= 一张分期计划（plan），下挂 N 个期次（item）
 *   · 应收总额 = 勾选费用项按财务标准算出；实缴不足的部分有两条去处：
 *       - 优惠（discount）：机构让利，账当场平掉
 *       - 待缴（pending）：还要继续收，挂在待缴余额里
 *   · 待缴 = 应收 - 优惠 - 已缴，归零才算缴清
 *   · 首付（第 1 期）到账即可分班，尾款没缴清的学生挂「欠费」标记
 *
 * ⚠️ 关键设计：每一期都独立向财务建一张单（金额 = 本期应收），
 *    不是「一张合计单分次核」—— 财务侧要能逐笔看到款到账。
 *
 * ⚠️ 金额一律「分」，本文件内不出现浮点运算。
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  FeeType,
  FEE_TYPE_NAME,
  SourceModule,
  DeptCode,
  DEPT_NAME,
  nameOf,
} from 'shared-types/consult';
import {
  InstallmentPlanStatus,
  INSTALLMENT_PLAN_STATUS_NAME,
  InstallmentItemStatus,
  INSTALLMENT_ITEM_STATUS_NAME,
} from 'shared-types/consult';
import type {
  ConsultInstallmentPlan,
  ConsultInstallmentItem,
  ConsultInstallmentCreatePayload,
  ConsultInstallmentPayPayload,
  ConsultStudentLedger,
} from 'shared-types/consult';
import { ConsultFeeStatus as CFS } from 'shared-types/consult';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { financeClient } from './finance.client';
import {
  FEE_ORDER_TABLE,
  nextOrderNo,
  tempStudentNo,
  centToYuan,
  parseOrderItemDetail,
  prorateItemDetail,
} from './fee-order.service';
import { findStudent, addHistory } from './student.service';

export const PLAN_TABLE = 't_consult_installment_plan';
export const ITEM_TABLE = 't_consult_installment_item';

/* ============================================================
 * 工具
 * ============================================================ */

const p2 = (n: number) => String(n).padStart(2, '0');

/** 本机日期 YYYY-MM-DD（不看时区，按服务端本地日历算逾期） */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** YYYY-MM-DD + n 天 → YYYY-MM-DD（本地日历，无时区偏移问题） */
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}

/**
 * 期次 N 的顺延周期（天）：优先取「上一期到期日 → 本期到期日」的自然间隔；
 * 第 1 期取「第 1 期 → 第 2 期」的间隔；间隔非法（≤0）时兜底 30 天。
 */
function stageIntervalDays(stageNo: number, dueDates: Map<number, string>): number {
  const cur = dueDates.get(stageNo);
  const other = stageNo > 1 ? dueDates.get(stageNo - 1) : dueDates.get(stageNo + 1);
  if (!cur || !other) return 30;
  const gap = Math.round(
    (new Date(cur).getTime() - new Date(other).getTime()) / 86400000,
  );
  return gap > 0 ? gap : 30;
}

/**
 * 归一成 YYYY-MM-DD
 *
 * ⚠️ MySQL 的 DATE 列经 knex 读出来是 JS Date 对象，
 *    直接 String() 会得到 "Fri Oct 16 2026 ..." 这种串，切前 10 位是错的。
 *    统一走这里格式化，逾期判定才准。
 */
function fmtDate(v: any): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/**
 * 给期次行补上关联收款单的单号
 *
 * ⚠️ 不用 leftJoin：两张表都有 id / create_time 等列，join 后会互相覆盖。
 */
async function attachOrderNo(rows: any[]): Promise<any[]> {
  const ids = [...new Set(rows.map((r) => r.fee_order_id).filter(Boolean))];
  if (!ids.length) return rows;

  // ★ 2026-10-16 顺带把凭证带出来：期次表要判断「这一期还没绑缴费凭证」，
  //   才好在上层留一个「补缴凭证」的入口。
  const orders = await db(FEE_ORDER_TABLE)
    .whereIn('id', ids)
    .select('id', 'order_no', 'voucher_url');
  const map = new Map<string, any>(orders.map((o: any) => [o.id, o]));

  for (const r of rows) {
    const o = r.fee_order_id ? map.get(r.fee_order_id) : undefined;
    r.order_no = o?.order_no;
    r.voucher_url = o?.voucher_url || undefined;
  }
  return rows;
}

/**
 * 分期计划号：FP + YYYYMMDD + 3 位序号
 * 例：FP20261016-001
 */
export async function nextPlanNo(): Promise<string> {
  const d = new Date();
  const day = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const prefix = `FP${day}-`;

  const row = await db(PLAN_TABLE)
    .where('plan_no', 'like', `${prefix}%`)
    .orderBy('plan_no', 'desc')
    .first();

  let seq = 1;
  if (row?.plan_no) {
    const last = Number(String(row.plan_no).slice(prefix.length));
    if (!isNaN(last)) seq = last + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/* ============================================================
 * 行 → 视图
 * ============================================================ */

function toItemView(row: any): ConsultInstallmentItem {
  const status = Number(row.status ?? InstallmentItemStatus.WAIT);
  const dueDate = fmtDate(row.due_date);
  const overdue = status !== InstallmentItemStatus.ARRIVED && !!dueDate && dueDate < today();

  return {
    itemId: row.id,
    planId: row.plan_id,
    stageNo: Number(row.stage_no),
    dueAmount: Number(row.due_amount || 0),
    dueAmountYuan: centToYuan(row.due_amount),
    dueDate,
    paidAmount: Number(row.paid_amount || 0),
    paidAmountYuan: centToYuan(row.paid_amount),
    status,
    statusName: nameOf(INSTALLMENT_ITEM_STATUS_NAME, status),
    overdue,
    postponeCount: Number(row.postpone_count || 0) || undefined,
    feeOrderId: row.fee_order_id || undefined,
    orderNo: row.order_no || undefined,
    voucherUrl: row.voucher_url || undefined,
    payTime: row.pay_time ? new Date(row.pay_time).toLocaleString('zh-CN', { hour12: false }) : undefined,
    remark: row.remark || undefined,
  };
}

function toPlanView(row: any, items: ConsultInstallmentItem[]): ConsultInstallmentPlan {
  const status = Number(row.status ?? InstallmentPlanStatus.ONGOING);
  return {
    planId: row.id,
    planNo: row.plan_no,
    consultStudentId: row.consult_student_id,
    studentName: row.student_name || '',
    studentNo: row.student_no || undefined,
    deptCode: row.dept_code ?? undefined,
    deptName: row.dept_code != null ? nameOf(DEPT_NAME, Number(row.dept_code)) : undefined,

    totalAmount: Number(row.total_amount || 0),
    paidAmount: Number(row.paid_amount || 0),
    discountAmount: Number(row.discount_amount || 0),
    pendingAmount: Number(row.pending_amount || 0),

    totalAmountYuan: centToYuan(row.total_amount),
    paidAmountYuan: centToYuan(row.paid_amount),
    discountAmountYuan: centToYuan(row.discount_amount),
    pendingAmountYuan: centToYuan(row.pending_amount),

    stageCount: Number(row.stage_count || 0),
    paidStages: Number(row.paid_stages || 0),
    status,
    statusName: nameOf(INSTALLMENT_PLAN_STATUS_NAME, status),

    itemDetail: parseOrderItemDetail(row.item_detail),
    remark: row.remark || undefined,
    createByName: row.create_by_name || undefined,
    createTime: row.create_time
      ? new Date(row.create_time).toLocaleString('zh-CN', { hour12: false })
      : undefined,

    items,
  };
}

async function loadPlan(planId: string): Promise<ConsultInstallmentPlan> {
  const plan = await db(PLAN_TABLE).where({ id: planId, is_deleted: false }).first();
  if (!plan) throw new BizError(BizCode.INSTALLMENT_NOT_FOUND, '分期计划不存在');
  const rows = await attachOrderNo(
    await db(ITEM_TABLE).where({ plan_id: planId, is_deleted: false }).orderBy('stage_no', 'asc'),
  );
  return toPlanView(plan, rows.map(toItemView));
}

/* ============================================================
 * 创建分期计划
 * ============================================================ */

/**
 * 创建分期计划
 *
 * 流程：
 *   ① 按财务标准算出应收，按 amountByType 算出实缴，差额记优惠
 *   ② 校验期次（≥2 期、各期之和 = 实缴合计）
 *   ③ 落 plan + item
 *   ④ 默认立刻发起第 1 期收款（startFirstStage = false 时可只建计划不发起）
 */
export async function createInstallmentPlan(
  payload: ConsultInstallmentCreatePayload,
  operator: { name: string; title?: string },
): Promise<ConsultInstallmentPlan> {
  const stu = await findStudent(payload.consultStudentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  const deptCode: DeptCode = stu.dept_code || DeptCode.JUNIOR_SENIOR;
  const studentNo = stu.student_no || tempStudentNo(payload.consultStudentId);

  /* ---------- ① 应收 / 实缴 / 优惠 ---------- */
  const items: Array<{
    feeType: FeeType;
    feeTypeName: string;
    amount: number;
    standardAmount: number;
    discount: number;
  }> = [];

  for (const feeType of payload.feeTypes) {
    const std = await financeClient.getStandard(feeType, deptCode);
    if (std.sourceModule !== SourceModule.CONSULT) {
      throw new BizError(
        BizCode.SOURCE_MODULE_MISMATCH,
        `${std.feeTypeName || feeType} 应由「${std.sourceModuleName}」发起，咨询模块无权建单。`,
      );
    }
    const custom = payload.amountByType?.[feeType];
    const paid = custom != null ? custom : std.amount;
    items.push({
      feeType,
      feeTypeName: nameOf(FEE_TYPE_NAME, feeType),
      amount: paid,
      standardAmount: std.amount,
      discount: std.amount - paid,
    });
  }

  if (!items.length) throw new BizError(BizCode.PARAM_ERROR, '请至少勾选一项费用');

  const dueTotal = items.reduce((s, i) => s + i.standardAmount, 0);
  const actualTotal = items.reduce((s, i) => s + i.amount, 0);
  if (actualTotal <= 0) throw new BizError(BizCode.PARAM_ERROR, '实缴金额必须大于 0');
  const discountTotal = dueTotal - actualTotal;

  /* ---------- ② 校验期次 ---------- */
  const stages = [...(payload.stages || [])].sort((a, b) => a.stageNo - b.stageNo);
  if (stages.length < 2) {
    throw new BizError(BizCode.PARAM_ERROR, '分期至少需要 2 期');
  }
  if (stages.some((s) => !Number.isFinite(s.amount) || s.amount <= 0)) {
    throw new BizError(BizCode.PARAM_ERROR, '每期金额必须大于 0');
  }
  const stageSum = stages.reduce((s, i) => s + i.amount, 0);
  if (stageSum !== actualTotal) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `各期合计 ¥${centToYuan(stageSum)} 与实缴金额 ¥${centToYuan(actualTotal)} 不一致，请调整`,
    );
  }

  /* ---------- ③ 落 plan + item ---------- */
  const planId = randomUUID();
  const planNo = await nextPlanNo();
  const now = new Date();

  await db(PLAN_TABLE).insert({
    id: planId,
    create_time: now,
    create_by: operator.name,
    create_by_name: operator.name,
    update_time: now,
    is_deleted: false,
    plan_no: planNo,
    consult_student_id: payload.consultStudentId,
    student_name: stu.student_name,
    student_no: studentNo,
    dept_code: deptCode,
    total_amount: dueTotal,
    paid_amount: 0,
    discount_amount: discountTotal,
    pending_amount: actualTotal, // 待缴 = 应收 - 优惠 - 已缴(0)
    stage_count: stages.length,
    paid_stages: 0,
    status: InstallmentPlanStatus.ONGOING,
    item_detail: JSON.stringify(items),
    remark: payload.remark || null,
  });

  for (const s of stages) {
    await db(ITEM_TABLE).insert({
      id: randomUUID(),
      create_time: now,
      is_deleted: false,
      plan_id: planId,
      stage_no: s.stageNo,
      due_amount: s.amount,
      due_date: s.dueDate || null,
      paid_amount: 0,
      status: InstallmentItemStatus.WAIT,
    });
  }

  const primaryType = items[0].feeType;
  const detailText = items.map((i) => `${i.feeTypeName}${centToYuan(i.amount)}`).join('/');
  const discountText =
    discountTotal > 0
      ? `，优惠 ¥${centToYuan(discountTotal)}`
      : discountTotal < 0
        ? `，补收 ¥${centToYuan(-discountTotal)}`
        : '';

  await addHistory(
    payload.consultStudentId,
    operator.name,
    `发起分期缴费：${detailText}，应收 ¥${centToYuan(dueTotal)}${discountText}；分 ${stages.length} 期，本期（第 1 期）应收 ¥${centToYuan(stages[0].amount)}`,
    operator.title,
    'CHARGE',
  );

  /* ---------- ④ 立刻发起第 1 期 ---------- */
  if (payload.startFirstStage !== false) {
    await payStage(
      {
        planId,
        stageNo: stages[0].stageNo,
        payMethod: payload.payMethod,
        // ★ 2026-10-19 第 1 期的凭证随计划一起传下来（缴费必须有凭证）
        voucherUrl: payload.voucherUrl,
        voucherNo: payload.voucherNo,
      },
      operator,
    );
  }

  return loadPlan(planId);
}

/* ============================================================
 * 缴某一期
 * ============================================================ */

/**
 * 缴某一期：向财务建一张本期金额的收款单
 *
 * ⚠️ 幂等保护：已到账的期次不能再缴；在途（待确认）的期次也不重复建单，
 *    避免同一期产生两张财务单。
 */
export async function payStage(
  payload: ConsultInstallmentPayPayload,
  operator: { name: string; title?: string },
): Promise<ConsultInstallmentPlan> {
  const plan = await db(PLAN_TABLE).where({ id: payload.planId, is_deleted: false }).first();
  if (!plan) throw new BizError(BizCode.INSTALLMENT_NOT_FOUND, '分期计划不存在');
  if (Number(plan.status) === InstallmentPlanStatus.TERMINATED) {
    throw new BizError(BizCode.INVALID_STATUS, '该分期计划已终止，不能再收款');
  }

  const item = await db(ITEM_TABLE)
    .where({ plan_id: payload.planId, stage_no: payload.stageNo, is_deleted: false })
    .first();
  if (!item) throw new BizError(BizCode.INSTALLMENT_NOT_FOUND, `第 ${payload.stageNo} 期不存在`);

  if (Number(item.status) === InstallmentItemStatus.ARRIVED) {
    throw new BizError(BizCode.INVALID_STATUS, `第 ${payload.stageNo} 期已到账，无需重复缴`);
  }
  if (item.fee_order_id) {
    // 在途单据：查一下当前状态，还没到账就不重复建单
    const exist = await db(FEE_ORDER_TABLE).where({ id: item.fee_order_id }).first();
    if (exist && Number(exist.status) !== CFS.REJECTED) {
      throw new BizError(
        BizCode.INVALID_STATUS,
        `第 ${payload.stageNo} 期已有在途收款单 ${exist.order_no}，请等待财务确认`,
      );
    }
  }

  const stu = await findStudent(plan.consult_student_id);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  const amount = payload.amount != null ? payload.amount : Number(item.due_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BizError(BizCode.PARAM_ERROR, '本期金额必须大于 0');
  }

  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    分期也必须有凭证才能发起，不允许先建单再补。
   */
  if (!payload.voucherUrl) {
    throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
  }

  const planDetail = parseOrderItemDetail(plan.item_detail);
  const primaryType = planDetail[0]?.feeType ?? FeeType.TUITION;
  const stageText = `第 ${payload.stageNo} 期 / 共 ${plan.stage_count} 期`;

  /**
   * ★ 2026-10-19 用户口径「总金额就是子金额的总和」：
   *   本期单据的 item_detail 不能直接抄整张计划的费用构成
   *   （那会显示成合计 ¥11,000、子行 学费 28,000 + 试学费 5,000，加不起来）。
   *   → 按计划各项占比把【本期金额】分摊到各费用项，Σ子项 === 本期金额。
   */
  const stageDetail = prorateItemDetail(planDetail, amount);

  const financeRes = await financeClient.addFee({
    studentId: plan.consult_student_id,
    studentNo: plan.student_no || stu.student_no || tempStudentNo(plan.consult_student_id),
    studentName: plan.student_name || stu.student_name,
    feeType: primaryType,
    deptCode: plan.dept_code || stu.dept_code || DeptCode.JUNIOR_SENIOR,
    classId: stu.class_id || undefined,
    className: stu.class_name || undefined,
    sourceModule: SourceModule.CONSULT,
    payMethod: payload.payMethod,
    amount, // ★ 分期必须显式传本期金额
    /**
     * ★ 2026-10-19 凭证随建单一起落库（财务侧建单即「待核对」），
     *    不再走「先建单、再回传凭证」的两步，避免中间态。
     */
    voucherUrl: payload.voucherUrl,
    voucherNo: payload.voucherNo,
    remark: `咨询模块发起（${operator.name}）· 分期计划 ${plan.plan_no} ${stageText}`,
  });

  const orderId = randomUUID();
  const orderNo = await nextOrderNo();

  await db(FEE_ORDER_TABLE).insert({
    id: orderId,
    order_no: orderNo,
    finance_fee_id: financeRes.id,
    consult_student_id: plan.consult_student_id,
    student_name: plan.student_name || stu.student_name,
    student_no: plan.student_no || undefined,
    class_name: stu.class_name || null,
    dept_code: plan.dept_code || stu.dept_code,
    fee_type: primaryType,
    amount,
    // ★ 2026-10-19 建单即带凭证 → 直接「待财务确认」
    status: CFS.PENDING,
    voucher_url: payload.voucherUrl || null,
    voucher_no: payload.voucherNo || null,
    voucher_by: payload.voucherUrl ? operator.name : null,
    pay_method: payload.payMethod || null,
    batch_no: Date.now(),
    plan_id: plan.id,
    stage_no: payload.stageNo,
    total_due_amount: Number(plan.total_amount || 0),
    /**
     * ★ 2026-10-19 本期单据的费用项明细 = 本期金额按计划占比分摊后的结果。
     *    前端「合计行 + 子行」的展示据此保证：Σ子行 === 合计行 === 本期实缴。
     */
    item_detail: JSON.stringify(stageDetail),
    create_time: new Date(),
    create_by: operator.name,
    create_by_name: operator.name,
    is_deleted: false,
  });

  await db(ITEM_TABLE).where({ id: item.id }).update({
    fee_order_id: orderId,
    status: InstallmentItemStatus.PENDING,
    update_time: new Date(),
  });

  /**
   * ★ 2026-10-19 凭证已在建单时随单落库（财务侧同样带凭证），
   *    这里不再二次 uploadVoucher —— 少一次跨服务往返，也不会有中间态。
   */

  await addHistory(
    plan.consult_student_id,
    operator.name,
    `发起分期收款：${plan.plan_no} ${stageText} ¥${centToYuan(amount)}，凭证已随单上传，等待财务确认到账`,
    operator.title,
    'CHARGE',
  );

  return loadPlan(plan.id);
}

/* ============================================================
 * 进度回算
 * ============================================================ */

/**
 * 按缴费单状态回算计划进度
 *
 * 映射：
 *   缴费单 ARRIVED(已到账) → 期次 ARRIVED，计入已缴
 *   缴费单 NO_VOUCHER / PENDING → 期次 PENDING（在途）
 *   缴费单 REJECTED(已驳回) → 期次 WAIT（要重传）
 *   未到账 + 过了到期日 → ★ 2026-10-16 自动顺延一期：
 *       到期日按计划周期后移（直至不早于今天），postpone_count +1，
 *       记一条跟进历史；不再把期次标成「已逾期」。
 *
 * 计划：待缴 = 应收 - 优惠 - 已缴；归零 → FINISHED
 */
export async function syncPlanProgress(planId: string): Promise<void> {
  const plan = await db(PLAN_TABLE).where({ id: planId, is_deleted: false }).first();
  if (!plan) return;

  const items = await db(ITEM_TABLE)
    .where({ plan_id: planId, is_deleted: false })
    .orderBy('stage_no', 'asc');

  /* 顺延周期按各期到期日的自然间隔推算 */
  const dueDates = new Map<number, string>();
  for (const i of items as any[]) {
    const d = fmtDate(i.due_date);
    if (d) dueDates.set(Number(i.stage_no), d);
  }

  const orderIds = items.map((i: any) => i.fee_order_id).filter(Boolean);
  const orders: any[] = orderIds.length
    ? await db(FEE_ORDER_TABLE).whereIn('id', orderIds)
    : [];
  const orderMap = new Map<string, any>(orders.map((o: any) => [o.id, o]));

  const now = new Date();
  let paid = 0;
  let paidStages = 0;

  for (const it of items) {
    const order = it.fee_order_id ? orderMap.get(it.fee_order_id) : null;
    let status: number = InstallmentItemStatus.WAIT;
    let paidAmount = 0;
    let payTime: Date | null = null;

    if (order) {
      const os = Number(order.status);
      if (os === CFS.ARRIVED) {
        status = InstallmentItemStatus.ARRIVED;
        paidAmount = Number(order.amount || 0);
        payTime = order.update_time || order.create_time;
      } else if (os === CFS.REJECTED) {
        status = InstallmentItemStatus.WAIT; // 打回，等重传
      } else {
        status = InstallmentItemStatus.PENDING;
      }
    }

    /* ---------- ★ 自动顺延一期（2026-10-16 用户口径） ----------
     * 到了到期日还没缴 → 到期日自动后移一个周期（直到不早于今天），
     * 每顺延一次 postpone_count +1 并记一条跟进历史。
     * 已到账的期次不参与；在途（待确认）的也会顺延——款没确认到账前不催。 */
    const postponeBefore = Number(it.postpone_count || 0);
    let postponeAfter = postponeBefore;
    let newDueDate: string | null = null;
    let dueDate = fmtDate(it.due_date);

    if (status !== InstallmentItemStatus.ARRIVED && dueDate && dueDate < today()) {
      const step = stageIntervalDays(Number(it.stage_no), dueDates);
      let shifted = dueDate;
      while (shifted < today()) {
        shifted = addDays(shifted, step);
        postponeAfter++;
      }
      newDueDate = shifted;
      dueDate = shifted;
      // 状态回到 WAIT / PENDING 本身，不标 OVERDUE
    }

    if (status === InstallmentItemStatus.ARRIVED) paidStages++;

    await db(ITEM_TABLE)
      .where({ id: it.id })
      .update({
        status,
        paid_amount: paidAmount,
        pay_time: payTime,
        ...(newDueDate ? { due_date: newDueDate } : {}),
        postpone_count: postponeAfter,
        update_time: now,
      });

    /* 每次实际发生顺延才记历史，避免重复刷屏 */
    if (newDueDate && postponeAfter > postponeBefore) {
      await addHistory(
        plan.consult_student_id,
        '系统',
        `分期 ${plan.plan_no} 第 ${it.stage_no} 期到期未缴，已自动顺延一期，到期日调整为 ${newDueDate}`,
        '系统',
        'CHARGE',
      );
    }

    paid += paidAmount;
  }

  const total = Number(plan.total_amount || 0);
  const discount = Number(plan.discount_amount || 0);
  const pending = Math.max(0, total - discount - paid);
  const finished = pending <= 0 && paidStages === items.length;

  await db(PLAN_TABLE).where({ id: planId }).update({
    paid_amount: paid,
    pending_amount: pending,
    paid_stages: paidStages,
    status:
      Number(plan.status) === InstallmentPlanStatus.TERMINATED
        ? InstallmentPlanStatus.TERMINATED
        : finished
          ? InstallmentPlanStatus.FINISHED
          : InstallmentPlanStatus.ONGOING,
    update_time: now,
  });

  await syncStudentArrear(plan.consult_student_id);
}

/**
 * 同步学生欠费金额 = 该学生所有「未终止」分期计划的待缴余额之和
 *
 * 用于学生列表的「欠费」标记与筛选。
 */
export async function syncStudentArrear(consultStudentId: string): Promise<void> {
  const rows = await db(PLAN_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .whereNot('status', InstallmentPlanStatus.TERMINATED);

  const arrear = rows.reduce((s: number, r: any) => s + Number(r.pending_amount || 0), 0);

  await db('t_consult_student')
    .where({ id: consultStudentId })
    .update({ arrear_amount: arrear, update_time: new Date() });
}

/** 全量回算某个学生的所有计划（到账同步后调用） */
export async function syncStudentPlans(consultStudentId: string): Promise<void> {
  const rows = await db(PLAN_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .whereNot('status', InstallmentPlanStatus.TERMINATED);

  for (const r of rows) {
    await syncPlanProgress(r.id);
  }
}

/** 全量回算所有在途计划（定时/手动触发） */
export async function syncAllPlans(): Promise<{ updated: number }> {
  const rows = await db(PLAN_TABLE)
    .where({ is_deleted: false })
    .where('status', InstallmentPlanStatus.ONGOING);

  for (const r of rows) {
    await syncPlanProgress(r.id);
  }
  return { updated: rows.length };
}

/**
 * 终止某学生的所有在途分期计划（退费打款完成 / 学生流失后调用）
 *
 * ⚠️ 已到账的钱不退，只是不再继续收尾款，待缴清零。
 */
export async function terminateStudentPlans(consultStudentId: string, reason?: string): Promise<void> {
  await db(PLAN_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .where('status', InstallmentPlanStatus.ONGOING)
    .update({
      status: InstallmentPlanStatus.TERMINATED,
      pending_amount: 0,
      remark: reason ? `已终止：${reason}` : '已终止',
      update_time: new Date(),
    });

  await syncStudentArrear(consultStudentId);
}

/* ============================================================
 * 查询
 * ============================================================ */

/** 计划列表（支持按学生 / 状态筛选） */
export async function listPlans(q: {
  consultStudentId?: string;
  status?: number;
  keyword?: string;
  page?: number;
  size?: number;
  /** ★ 2026-10-16 数据范围：咨询师只看到自己名下学生的分期计划 */
  scopedStudentIds?: string[] | null;
}): Promise<{ list: ConsultInstallmentPlan[]; total: number }> {
  const page = Number(q.page || 1);
  const size = Number(q.size || 20);

  let query = db(PLAN_TABLE).where({ is_deleted: false });
  if (Array.isArray(q.scopedStudentIds)) {
    query = query.whereIn(
      'consult_student_id',
      q.scopedStudentIds.length ? q.scopedStudentIds : ['__none__'],
    );
  }
  if (q.consultStudentId) query = query.where({ consult_student_id: q.consultStudentId });
  if (q.status != null) query = query.where({ status: q.status });
  if (q.keyword) {
    const kw = `%${q.keyword}%`;
    query = query.where(function (this: any) {
      this.where('student_name', 'like', kw).orWhere('plan_no', 'like', kw);
    });
  }

  const countRow = await query.clone().count({ c: '*' }).first();
  const total = Number(countRow?.c || 0);

  const rows = await query
    .orderBy('create_time', 'desc')
    .limit(size)
    .offset((page - 1) * size);

  const list: ConsultInstallmentPlan[] = [];
  for (const r of rows) {
    const items = await attachOrderNo(
      await db(ITEM_TABLE).where({ plan_id: r.id, is_deleted: false }).orderBy('stage_no', 'asc'),
    );
    list.push(toPlanView(r, items.map(toItemView)));
  }

  return { list, total };
}

/** 计划详情（先回算一次进度 / 自动顺延，保证用户打开看到的到期日是最新的） */
export async function planDetail(planId: string): Promise<ConsultInstallmentPlan> {
  await syncPlanProgress(planId);
  return loadPlan(planId);
}

/**
 * 学生缴费账本：应收 / 已收 / 优惠 / 待缴
 *
 * 无分期计划（一次性缴清）的学生也返回账本，
 * 只是 plans 为空、金额按已到账收款单汇总。
 */
export async function getStudentLedger(consultStudentId: string): Promise<ConsultStudentLedger> {
  const stu = await findStudent(consultStudentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  await syncStudentPlans(consultStudentId);

  const { list: plans } = await listPlans({ consultStudentId, size: 100 });

  const totalAmount = plans.reduce((s, p) => s + p.totalAmount, 0);
  const paidAmount = plans.reduce((s, p) => s + p.paidAmount, 0);
  const discountAmount = plans.reduce((s, p) => s + p.discountAmount, 0);
  const pendingAmount = plans.reduce((s, p) => s + p.pendingAmount, 0);

  return {
    consultStudentId,
    studentName: stu.student_name,
    totalAmount,
    paidAmount,
    discountAmount,
    pendingAmount,
    totalAmountYuan: centToYuan(totalAmount),
    paidAmountYuan: centToYuan(paidAmount),
    discountAmountYuan: centToYuan(discountAmount),
    pendingAmountYuan: centToYuan(pendingAmount),
    inArrear: pendingAmount > 0,
    plans,
  };
}
