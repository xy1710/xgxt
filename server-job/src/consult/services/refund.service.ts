/**
 * 退费服务（试学阶段流失）
 *
 * ⚠️ 退费规则（业务方定的，代码强制）：
 *    试学费 − 试学期间实际消耗 = 实退
 *    每日消耗：住宿费 ¥15/天、餐费 ¥28/天、保险费 ¥5/天
 *    另加：学生领用的个人物品（校服/被褥/工具包/教材/军训服/门禁卡）
 *
 * ⚠️ 审批链：
 *    咨询老师发起 → 咨询经理审批 → 上报财务 → 财务打款 → 学生状态变「已退费」
 *    经理自己发起则自审自批，直接进「待财务打款」
 *    经理驳回 → 学生退回试学中，可修改后重新提交
 *
 * ⚠️ 金额单位一律「分」
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  ConsultState,
  ConsultRefundStatus as CRS,
  CONSULT_REFUND_STATUS_NAME,
  TRIAL_DAILY_RATE_CENT,
  FeeType,
  nameOf,
} from 'shared-types/consult';
import type {
  ConsultRefundOrder,
  RefundDeductItem,
  ConsultRefundCalcResult,
  ConsultRefundStats,
} from 'shared-types/consult';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import {
  findStudent,
  addHistory,
  formatTime,
  formatDate,
  diffDays,
  today,
  getItemPrice,
  getConsumeItems,
  getConfigNumber,
} from './student.service';
import { getArrivedTrialIncome, centToYuan, tempStudentNo } from './fee-order.service';
import { terminateStudentPlans } from './installment.service';
import { changeState } from './state.service';
import { financeClient } from './finance.client';

export const REFUND_TABLE = 't_consult_refund';

/* ============================================================
 * 单号与视图
 * ============================================================ */

/** 生成退费单号：TK + YYYYMMDD + 3 位序号 */
export async function nextRefundNo(): Promise<string> {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = `TK${day}-`;

  const row = await db(REFUND_TABLE)
    .where('refund_no', 'like', `${prefix}%`)
    .orderBy('refund_no', 'desc')
    .first();

  let seq = 1;
  if (row?.refund_no) {
    const last = Number(String(row.refund_no).slice(prefix.length));
    if (!isNaN(last)) seq = last + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/** 解析扣减明细 JSON */
function parseDeduct(raw: any): RefundDeductItem[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** 行 → 视图 */
export function toRefundView(row: any): ConsultRefundOrder {
  return {
    refundId: row.id,
    refundNo: row.refund_no,
    financeRefundId: row.finance_refund_id || undefined,
    consultStudentId: row.consult_student_id,
    studentName: row.student_name || '',
    studentNo: row.student_no || undefined,
    className: row.class_name || undefined,

    applyByName: row.apply_by_name || '',
    applyByTitle: row.apply_by_title || '',
    applyAt: formatTime(row.apply_at),
    selfApprove: !!row.self_approve,
    approveByName: row.approve_by_name || undefined,
    approveAt: row.approve_at ? formatTime(row.approve_at) : undefined,
    rejectReason: row.reject_reason || undefined,

    trialStart: row.trial_start ? formatDate(row.trial_start) : undefined,
    trialEnd: row.trial_end ? formatDate(row.trial_end) : undefined,
    trialDays: row.trial_days,
    incomeAmount: row.income_amount,
    deductItems: parseDeduct(row.deduct_detail),
    deductTotal: row.deduct_total,
    refundAmount: row.refund_amount,

    status: row.status,
    statusName: nameOf(CONSULT_REFUND_STATUS_NAME, row.status),

    payByName: row.pay_by_name || undefined,
    payAt: row.pay_at ? formatTime(row.pay_at) : undefined,
    payMethod: row.pay_method || undefined,
    payRef: row.pay_ref || undefined,
    payTo: row.pay_to || undefined,

    remark: row.remark || undefined,
    createTime: formatTime(row.create_time),
  };
}

/* ============================================================
 * ⭐ 退费试算（前端弹窗实时算）
 * ============================================================ */

/**
 * 试算退费金额（不落库）
 *
 * ⚠️ 前端在弹窗里改天数、勾物品时反复调这个接口，
 *    保证「用户看到的数字」和「提交后后端算的数字」完全一致。
 */
export async function calcRefund(
  consultStudentId: string,
  trialStart: string,
  trialEnd: string,
  trialDaysOverride?: number,
  itemNames: string[] = [],
  /** ★ 2026-10-08 勾选的每日消耗项 key（accommodation/meal/insurance）；不传默认全选 */
  dailyItems?: string[],
): Promise<ConsultRefundCalcResult> {
  const stu = await findStudent(consultStudentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  // ---- 天数：优先用前端传的，没传就按日期算 ----
  const days = trialDaysOverride && trialDaysOverride > 0
    ? trialDaysOverride
    : diffDays(trialStart, trialEnd);

  // ---- 已到账试学费 ----
  const income = await getArrivedTrialIncome(consultStudentId);

  // ---- 每日消耗（从配置读，配置缺失用 shared-types 的默认值）----
  const rateAcc = await getConfigNumber('trial_rate_accommodation', TRIAL_DAILY_RATE_CENT.accommodation);
  const rateMeal = await getConfigNumber('trial_rate_meal', TRIAL_DAILY_RATE_CENT.meal);
  const rateIns = await getConfigNumber('trial_rate_insurance', TRIAL_DAILY_RATE_CENT.insurance);

  // ★ 每日消耗也按多选参与计算：前端勾了哪项才算哪项，明细逐条列出
  const DAILY_DEFS = [
    { key: 'accommodation', name: '住宿费', rate: rateAcc },
    { key: 'meal', name: '餐费', rate: rateMeal },
    { key: 'insurance', name: '保险费（试学期短期险）', rate: rateIns },
  ];
  const activeDaily = Array.isArray(dailyItems)
    ? DAILY_DEFS.filter((d) => dailyItems.includes(d.key))
    : DAILY_DEFS;

  const deductItems: RefundDeductItem[] = activeDaily.map((d) => ({
    item: d.name,
    calc: `¥${d.rate / 100}/天 × ${days} 天`,
    amount: d.rate * days,
  }));

  // ---- 物品领用 ----
  for (const name of itemNames) {
    const price = await getItemPrice(name);
    if (price === null) continue;   // 字典里没有的跳过
    deductItems.push({
      item: `物品领用 · ${name}`,
      calc: '领用 1 件',
      amount: price,
    });
  }

  const deductTotal = deductItems.reduce((a, b) => a + b.amount, 0);
  // ⚠️ 实退不能为负：扣减超过已缴时，最多退 0（差额由业务人工处理，不在这里倒欠）
  const refundAmount = Math.max(0, income - deductTotal);

  return {
    trialDays: days,
    incomeAmount: income,
    deductItems,
    deductTotal,
    refundAmount,
    itemOptions: await getConsumeItems(),
  };
}

/* ============================================================
 * ⭐ 发起退费申请
 * ============================================================ */

/**
 * 发起退费
 *
 * @param operator 发起人（含岗位，用于判断是否经理自审自批）
 */
export async function applyRefund(
  consultStudentId: string,
  payload: {
    trialStart: string;
    trialEnd: string;
    trialDays?: number;
    itemNames?: string[];
    /** ★ 2026-10-08 勾选的每日消耗项 key（accommodation/meal/insurance） */
    dailyItems?: string[];
    remark?: string;
  },
  operator: { name: string; title?: string; isManager: boolean },
): Promise<{ refundId: string; refundNo: string }> {
  const stu = await findStudent(consultStudentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  // ---- 只有试学相关状态能发起退费 ----
  const allowed: number[] = [
    ConsultState.TRIAL_WAIT_CLASS,
    ConsultState.TRIAL,
    ConsultState.TRIAL_FEE_PENDING,
  ];
  if (!allowed.includes(stu.consult_state)) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      `当前状态不允许发起退费（仅「咨询中 / 待分班 / 试学中」可发起）。如需直接退学请联系教务模块处理。`,
    );
  }

  // ---- 不允许重复发起 ----
  const exists = await db(REFUND_TABLE)
    .where({
      consult_student_id: consultStudentId,
      is_deleted: false,
      status: CRS.PENDING_MANAGER,
    })
    .first();
  if (exists) {
    throw new BizError(
      BizCode.REFUND_ALREADY_EXISTS,
      `该学生已有在途退费单（${exists.refund_no}）处于「待经理审批」，请勿重复发起。`,
    );
  }

  // ---- 试算 ----
  const calc = await calcRefund(
    consultStudentId,
    payload.trialStart,
    payload.trialEnd,
    payload.trialDays,
    payload.itemNames || [],
    payload.dailyItems,
  );

  if (calc.incomeAmount <= 0) {
    throw new BizError(
      BizCode.TRIAL_FEE_NOT_ARRIVED,
      '该学生的试学费尚未确认到账，无法办理退费。请先在「收款与缴费」页上传缴费截图并等财务确认。',
    );
  }

  // ---- 经理自审自批：直接进「待财务打款」 ----
  const selfApprove = operator.isManager;
  const status = selfApprove ? CRS.PENDING_FINANCE : CRS.PENDING_MANAGER;

  const refundId = randomUUID();
  const refundNo = await nextRefundNo();

  await db(REFUND_TABLE).insert({
    id: refundId,
    refund_no: refundNo,
    consult_student_id: consultStudentId,
    student_name: stu.student_name,
    student_no: stu.student_no || tempStudentNo(consultStudentId),
    class_name: stu.class_name || null,

    apply_by_id: null,
    apply_by_name: operator.name,
    apply_by_title: operator.title || '咨询师',
    apply_at: new Date(),
    self_approve: selfApprove,
    approve_by_name: selfApprove ? `${operator.name}（自审自批）` : null,
    approve_at: selfApprove ? new Date() : null,

    trial_start: payload.trialStart,
    trial_end: payload.trialEnd,
    trial_days: calc.trialDays,
    income_amount: calc.incomeAmount,
    deduct_detail: JSON.stringify(calc.deductItems),
    deduct_total: calc.deductTotal,
    refund_amount: calc.refundAmount,

    status,
    remark: payload.remark || null,

    create_time: new Date(),
    create_by: operator.name,
    create_by_name: operator.name,
    is_deleted: false,
  });

  // ---- 变更学生状态 + 写历史 ----
  const nextState = selfApprove ? ConsultState.REFUND_FINANCE : ConsultState.REFUND_MGR;
  await changeState(consultStudentId, nextState, {
    byName: operator.name,
    byTitle: operator.title,
    action: 'REFUND_APPLY',
    historyText: selfApprove
      ? `经理发起退费申请并自审自批：试学 ${calc.trialDays} 天消耗 ¥${centToYuan(calc.deductTotal)}，应退 ¥${centToYuan(calc.refundAmount)}，直接上报财务打款（${refundNo}）`
      : `学生申请退学（试学阶段流失），发起退费申请：试学 ${calc.trialDays} 天消耗 ¥${centToYuan(calc.deductTotal)}，应退 ¥${centToYuan(calc.refundAmount)}，等待咨询经理审批（${refundNo}）`,
  });

  // ---- 自审自批的，立刻上报财务 ----
  if (selfApprove) {
    await reportToFinance(refundId, { name: operator.name, title: operator.title });
  }

  return { refundId, refundNo };
}

/* ============================================================
 * 审批（经理）
 * ============================================================ */

/** 经理审批通过 */
export async function approveRefund(
  refundId: string,
  operator: { name: string; title?: string },
): Promise<void> {
  const row = await db(REFUND_TABLE).where({ id: refundId, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

  if (row.status !== CRS.PENDING_MANAGER) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      `只有「待经理审批」的退费单可以审批，当前状态是「${nameOf(CONSULT_REFUND_STATUS_NAME, row.status)}」`,
    );
  }

  // ---- 更新审批信息，状态 → 待财务打款 ----
  await db(REFUND_TABLE).where({ id: refundId }).update({
    status: CRS.PENDING_FINANCE,
    approve_by_name: operator.name,
    approve_at: new Date(),
    update_time: new Date(),
    update_by: operator.name,
  });

  // ---- 学生状态 → 退费·待财务打款 ----
  await changeState(row.consult_student_id, ConsultState.REFUND_FINANCE, {
    byName: operator.name,
    byTitle: operator.title,
    action: 'REFUND_APPROVE',
    historyText: `审批通过退费明细（应退 ¥${centToYuan(row.refund_amount)}），上报财务打款`,
  });

  // ---- ⭐ 上报财务 ----
  await reportToFinance(refundId, operator);
}

/** 经理驳回 */
export async function rejectRefund(
  refundId: string,
  rejectReason: string,
  operator: { name: string; title?: string },
): Promise<void> {
  const row = await db(REFUND_TABLE).where({ id: refundId, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

  if (row.status !== CRS.PENDING_MANAGER) {
    throw new BizError(BizCode.INVALID_STATUS, '只有「待经理审批」的退费单可以驳回');
  }

  await db(REFUND_TABLE).where({ id: refundId }).update({
    status: CRS.REJECTED,
    reject_reason: rejectReason,
    reject_by_name: operator.name,
    update_time: new Date(),
    update_by: operator.name,
  });

  // ⚠️ 按业务规则：经理驳回的，学生退回试学中，可修改后重新提交
  await changeState(row.consult_student_id, ConsultState.TRIAL, {
    byName: operator.name,
    byTitle: operator.title,
    action: 'REFUND_REJECT',
    historyText: `驳回退费申请：${rejectReason}。学生退回「试学中」，可修改后重新提交`,
  });
}

/* ============================================================
 * ⭐ 上报财务
 * ============================================================ */

/**
 * 把退费单推给财务模块
 *
 * ⚠️ 财务侧有独立的退费申请接口（/refund/apply），
 *    调成功后把 finance_refund_id 回填到本地，便于后续回读打款结果。
 *
 * ⚠️ 失败不阻断：上报失败时保留「待财务打款」状态，
 *    并在历史里记一条警告，人工可在财务侧补录。
 */
async function reportToFinance(
  refundId: string,
  operator: { name: string; title?: string },
): Promise<void> {
  const row = await db(REFUND_TABLE).where({ id: refundId }).first();
  if (!row) return;

  try {
    /**
     * ⚠️ 2026-10-15 修复：入参原先缺 `refundItems` / `refundReason`，
     *    财务的 applySchema 里这两个是**必填**，zod 校验直接 400：
     *      「参数「refundItems」类型不正确」
     *    → 咨询退费单永远进不了财务（用户反馈的正是这个现象）。
     *
     * ⚠️ 同时补 deptCode：财务退费列表按「部门」分 Tab，
     *    不传部门的话这张单在财务的部门筛选下根本看不到。
     */
    const stu = await findStudent(row.consult_student_id).catch(() => null);
    const deptCode = stu?.dept_code != null ? Number(stu.dept_code) : undefined;

    const res = await financeClient.applyRefund({
      studentId: row.consult_student_id,
      studentNo: row.student_no || undefined,
      studentName: row.student_name || undefined,
      className: row.class_name || undefined,
      deptCode,
      /** 咨询退费只针对「试学费」（试学阶段流失），退费项目固定为 TRIAL_FEE */
      refundItems: [FeeType.TRIAL_FEE],
      refundAmount: row.refund_amount,
      refundReason: row.remark || '试学阶段流失退费',
      sourceType: 1, // 1 = 咨询来源
      remark: `咨询模块退费单 ${row.refund_no}（试学 ${row.trial_days} 天，扣减 ¥${centToYuan(row.deduct_total)}）`,
    });

    await db(REFUND_TABLE).where({ id: refundId }).update({
      finance_refund_id: res.id,
      // ⚠️ 财务返回的字段是 `orderNo`（TF 单号），不是 refundNo ——
      //    原先读 refundNo 拿到 undefined，finance_refund_no 永远是空
      finance_refund_no: res.orderNo || null,
      update_time: new Date(),
    });

    await addHistory(
      row.consult_student_id,
      operator.name,
      `退费单已上报财务（财务单号 ${res.orderNo || res.id}），等待财务出款 ¥${centToYuan(row.refund_amount)}`,
      operator.title,
      'REFUND_REPORT',
    );
  } catch (err: any) {
    await addHistory(
      row.consult_student_id,
      '系统',
      `⚠️ 退费单上报财务失败：${err?.message || '未知错误'}。单据已保存在本地，请在财务模块手工补录。`,
      '系统',
      'REFUND_REPORT_FAILED',
    );
    console.error('[退费上报财务失败]', row.refund_no, err?.message);
  }
}

/* ============================================================
 * ⭐ 财务打款回写（自动 + 手工）
 * ============================================================ */

/**
 * 从财务侧回读退费状态
 *
 * ⚠️ 财务出款后，本模块要把状态更新为「已打款」，
 *    学生状态流转为「已退费」，并回写打款流水号。
 */
/**
 * ★ 2026-10-09 财务同步节流（同 syncFromFinance）：
 *    退费列表每次刷新都全量回读财务，自调用 HTTP 并发放大导致请求超时。
 *    10 秒内不重复跑；指定 refundIds 的强制同步不受节流限制。
 */
const REFUND_SYNC_THROTTLE_MS = 10_000;
let lastRefundSyncAt = 0;

export async function syncRefundFromFinance(refundIds?: string[]): Promise<{ updated: number }> {
  if (!refundIds?.length && Date.now() - lastRefundSyncAt < REFUND_SYNC_THROTTLE_MS) {
    return { updated: 0 };
  }
  lastRefundSyncAt = Date.now();

  let query = db(REFUND_TABLE).where({ is_deleted: false, status: CRS.PENDING_FINANCE });
  if (refundIds?.length) {
    query = db(REFUND_TABLE).where({ is_deleted: false }).whereIn('id', refundIds);
  }
  const rows: any[] = await query;

  let updated = 0;
  for (const row of rows) {
    if (!row.finance_refund_id) continue;
    try {
      const detail: any = await financeClient.getRefundDetail(row.finance_refund_id);
      // 财务 RefundStatus: 6=已退费 7=已驳回 4=待财务出款
      const rs = detail?.refundStatus;

      if (rs === 6) {
        // ---- 已打款 ----
        await db(REFUND_TABLE).where({ id: row.id }).update({
          status: CRS.PAID,
          pay_by_name: detail.financePayBy || detail.payBy || '财务专员',
          pay_at: detail.financePayTime ? new Date(detail.financePayTime) : new Date(),
          pay_method: detail.payMethod || '银行转账',
          pay_ref: detail.billNo || detail.financePayNo || null,
          pay_to: detail.payTo || null,
          update_time: new Date(),
          update_by: 'system-sync',
        });

        // ★ 2026-10-15 用户口径：财务退款之后学生状态流转为「流失」，
        //    流失原因 = 发起退款时填写的流失原因（退费单 remark = 「流失原因 · 备注」）
        await changeState(row.consult_student_id, ConsultState.LOST, {
          byName: '财务模块',
          byTitle: '系统',
          action: 'REFUND_PAID',
          historyText: `退费打款 ¥${centToYuan(row.refund_amount)} 已完成，学生状态流转为「流失」`,
          extraFields: { loss_reason: row.remark || '退费流失' },
        });

        /* ★ 2026-10-16 分期：人已流失，未收的尾款不再收，终止在途分期计划 */
        await terminateStudentPlans(row.consult_student_id, '学生已退费流失');

        updated++;
      } else if (rs === 7) {
        // ---- 财务驳回 ----
        await db(REFUND_TABLE).where({ id: row.id }).update({
          status: CRS.REJECTED,
          reject_reason: detail.rejectReason || '财务驳回',
          update_time: new Date(),
          update_by: 'system-sync',
        });
        await addHistory(
          row.consult_student_id,
          '财务模块',
          `退费单被财务驳回：${detail.rejectReason || '未说明原因'}`,
          '系统',
          'REFUND_FINANCE_REJECT',
        );
        updated++;
      }
    } catch (err: any) {
      console.warn('[syncRefundFromFinance] 跳过', row.refund_no, err?.message);
    }
  }

  return { updated };
}

/**
 * 手工确认打款（联调演示用）
 *
 * ⚠️ 真实场景应由财务侧出款后自动回写。
 *    这里保留手工入口，方便在财务模块未启动时也能演示完整流程。
 */
export async function manualPay(
  refundId: string,
  payload: {
    payMethod?: string;
    payRef?: string;
    payTo?: string;
  },
  operator: { name: string; title?: string },
): Promise<{ payRef: string }> {
  const row = await db(REFUND_TABLE).where({ id: refundId, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

  if (row.status !== CRS.PENDING_FINANCE) {
    throw new BizError(BizCode.INVALID_STATUS, '只有「待财务打款」的退费单可以执行打款');
  }

  const payRef = payload.payRef || String(Date.now());

  await db(REFUND_TABLE).where({ id: refundId }).update({
    status: CRS.PAID,
    pay_by_name: operator.name,
    pay_at: new Date(),
    pay_method: payload.payMethod || '银行转账',
    pay_ref: payRef,
    pay_to: payload.payTo || null,
    update_time: new Date(),
    update_by: operator.name,
  });

  // ★ 2026-10-15 用户口径：财务退款之后学生状态流转为「流失」，
  //    流失原因 = 发起退款时填写的流失原因（退费单 remark = 「流失原因 · 备注」）
  await changeState(row.consult_student_id, ConsultState.LOST, {
    byName: operator.name,
    byTitle: operator.title,
    action: 'REFUND_PAID',
    historyText: `退费打款 ¥${centToYuan(row.refund_amount)}（${payload.payMethod || '银行转账'} · 流水号 ${payRef}），学生状态流转为「流失」`,
    extraFields: { loss_reason: row.remark || '退费流失' },
  });

  /* ★ 2026-10-16 分期：人已流失，未收的尾款不再收，终止在途分期计划 */
  await terminateStudentPlans(row.consult_student_id, '学生已退费流失');

  return { payRef };
}

/* ============================================================
 * 查询
 * ============================================================ */

/** 构造列表查询 */
export function buildRefundQuery(q: any, scopeOwner?: string) {
  const query = db(REFUND_TABLE).where('is_deleted', false);

  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.refundNo) query.andWhere('refund_no', 'like', `%${q.refundNo}%`);
  if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
  if (q.status) query.andWhere('status', q.status);
  if (q.ownerName) query.andWhere('apply_by_name', 'like', `%${q.ownerName}%`);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_name', 'like', `%${q.keyword}%`)
        .orWhere('refund_no', 'like', `%${q.keyword}%`)
        .orWhere('apply_by_name', 'like', `%${q.keyword}%`)
        .orWhere('class_name', 'like', `%${q.keyword}%`);
    });
  }
  // 咨询师只看自己的
  if (scopeOwner) {
    query.andWhere((qb: any) => {
      qb.where('apply_by_name', scopeOwner)
        .orWhereIn(
          'consult_student_id',
          db('t_consult_student').select('id').where('owner_name', scopeOwner).where('is_deleted', false),
        );
    });
  }
  return query;
}

/** 退费统计 */
export async function getRefundStats(q: any = {}, scopeOwner?: string): Promise<ConsultRefundStats> {
  const rows: any[] = await buildRefundQuery(q, scopeOwner).select('status', 'refund_amount');
  const stat = (st: number) => rows.filter((r) => r.status === st);

  return {
    pendingManagerCount: stat(CRS.PENDING_MANAGER).length,
    pendingFinanceCount: stat(CRS.PENDING_FINANCE).length,
    paidCount: stat(CRS.PAID).length,
    rejectedCount: stat(CRS.REJECTED).length,
    paidAmount: stat(CRS.PAID).reduce((a, b) => a + Number(b.refund_amount || 0), 0),
  };
}
