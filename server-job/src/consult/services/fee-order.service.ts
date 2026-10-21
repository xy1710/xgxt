/**
 * 收款单服务（咨询发起 → 财务核对）
 *
 * ⚠️ 核心联动逻辑：
 *    发起收费 → 调财务 /standard/get 拿金额（规则2）
 *             → 调财务 /fee/add 建单（带 sourceModule=1，规则3-①）
 *             → 把财务返回的 feeId 存到本地，用于后续回读核对状态
 *
 * ⚠️ 金额一律「分」，本文件内不出现浮点运算。
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  FeeType,
  FEE_TYPE_NAME,
  PayStatus,
  PAY_STATUS_NAME,
  DeptCode,
  SourceModule,
  FULL_FEE_TYPES,
  ConsultState,
  CONSULT_STATE_NAME,
  nameOf,
} from 'shared-types/consult';
import type {
  ConsultFeeOrder,
  ConsultFeeCreateResult,
  ConsultFeeStats,
  ConsultFeeStatus,
  ConsultSupplementPlan,
} from 'shared-types/consult';
import { ConsultFeeStatus as CFS, CONSULT_FEE_STATUS_NAME } from 'shared-types/consult';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { financeClient } from './finance.client';
import { formatTime, findStudent, addHistory } from './student.service';
import { changeState } from './state.service';
// ★ 2026-10-20 试学闭环：补费到账转正后，把班级学籍从「试学中」改成「正式在读」
import { classSync } from '../../utils/classSync';

export const FEE_ORDER_TABLE = 't_consult_fee_order';

/**
 * 补缴明细里「单类型状态」的中文名
 *
 * ⚠️ 与 ConsultFeeStatus 不同：
 *    ConsultFeeStatus 描述「一张单」的状态（含 NO_VOUCHER 待上传凭证），
 *    而补缴明细描述「一个费用类型」的缺口，所以多了 NOT_STARTED（还没发起过）。
 */
export const SUPPLEMENT_STATE_NAME: Record<string, string> = {
  ARRIVED: '已到账',
  PENDING: '待确认',
  REJECTED: '已驳回',
  NOT_STARTED: '未发起',
};

/* ============================================================
 * 单号生成
 * ============================================================ */

/**
 * 生成本模块收款单号：SK + YYYYMMDD + 3 位序号
 * 例：SK20261002-001
 *
 * ⚠️ 并发撞号由唯一索引兜底（uk_cfo_order_no），撞了就重试
 */
export async function nextOrderNo(): Promise<string> {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = `SK${day}-`;

  const row = await db(FEE_ORDER_TABLE)
    .where('order_no', 'like', `${prefix}%`)
    .orderBy('order_no', 'desc')
    .first();

  let seq = 1;
  if (row?.order_no) {
    const last = Number(String(row.order_no).slice(prefix.length));
    if (!isNaN(last)) seq = last + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/* ============================================================
 * 临时学号
 * ============================================================ */

/**
 * 咨询阶段临时学号
 *
 * 业务背景：
 *   学生在咨询阶段只有「咨询学生ID」（cs-0001），正式学号（S20260001）
 *   要等转正式、由教务分配。但财务侧的缴费单 studentNo 是必填（用于对账快照），
 *   所以咨询侧建单时先生成一个临时学号占位。
 *
 * 规则：去掉 ID 前缀，取数字部分 → cs-0006 → ZX0006
 *
 * ⚠️ 转正式后教务会分配正式学号，届时以教务/财务侧为准，
 *    本临时号只用于咨询阶段的缴费单对账。
 */
export function tempStudentNo(consultStudentId: string): string {
  const digits = String(consultStudentId).replace(/\D/g, '');
  return digits ? `ZX${digits.padStart(4, '0')}` : `ZX${String(consultStudentId).slice(-6)}`;
}

/* ============================================================
 * 行 → 视图
 * ============================================================ */

/** 元转分（前端传元时用；本模块内部一律分） */
export function yuanToCent(y: number | string): number {
  return Math.round(Number(y) * 100);
}

/** 分转元字符串（显示用，两位小数） */
export function centToYuan(c: number): string {
  return (Number(c || 0) / 100).toFixed(2);
}

/**
 * ★ 2026-10-16 解析合并缴费单的明细 JSON（脏数据返回空数组，不影响主流程）
 *
 * 里面带 standardAmount / discount（应缴 / 优惠），前端据此展示「应缴 / 实缴 / 优惠」。
 */
export function parseOrderItemDetail(
  raw: any,
): Array<{ feeType: number; feeTypeName: string; amount: number; standardAmount?: number; discount?: number }> {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * ★ 2026-10-19 分期「某一期」的费用项分摊（用户口径：总金额就是子金额的总和）
 *
 * 背景：分期每一期都是独立一张缴费单，金额 = 本期实缴（如 3 期 × ¥11,000）。
 *   但单据的 item_detail 原来是直接抄整张计划的费用构成（学费 28,000 + 试学费 5,000），
 *   于是档案里出现「合计行 ¥11,000，下面子行却是 ¥28,000 / ¥5,000」——加不起来。
 *
 * 口径：合计行金额必须是子行金额之和。
 *   做法：按各项金额占比把本期金额摊到各费用项，用「最大余额法」把分的误差
 *   补给余数最大的那一项，保证 Σ子项 === 本期金额，且全程整数（无浮点误差）。
 */
export function prorateItemDetail(
  items: Array<{
    feeType: number;
    feeTypeName: string;
    amount: number;
    standardAmount?: number;
    discount?: number;
  }>,
  stageAmount: number,
): typeof items {
  const list = (items || []).filter((i) => Number(i?.amount) > 0);
  if (!list.length || !(stageAmount > 0)) return [];
  const total = list.reduce((s, i) => s + Number(i.amount), 0);
  if (total <= 0) return [];

  // 只有一项：本期金额全给它，避免出现「学费 100% 分摊」以外的噪音
  if (list.length === 1) {
    return [{ ...list[0], amount: stageAmount, standardAmount: stageAmount, discount: 0 }];
  }

  const raw = list.map((i) => (stageAmount * Number(i.amount)) / total);
  const base = raw.map((v) => Math.floor(v));
  let rest = stageAmount - base.reduce((s, v) => s + v, 0);

  if (rest > 0) {
    // 余数大的先补 1 分（同余数按原顺序，保证结果稳定可复现）
    const order = raw
      .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
    for (const o of order) {
      if (rest <= 0) break;
      base[o.idx] += 1;
      rest -= 1;
    }
  } else if (rest < 0) {
    // 兜底：浮点极端情况下多分了，从余数最小的项扣回来
    const order = raw
      .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
      .sort((a, b) => a.frac - b.frac || b.idx - a.idx);
    for (const o of order) {
      if (rest >= 0) break;
      if (base[o.idx] > 0) {
        base[o.idx] -= 1;
        rest += 1;
      }
    }
  }

  /**
   * 分摊出来的数就是本期这一项的实缴；
   * 应缴（standardAmount）同步成同一个数、优惠归 0，
   * 否则前端会显示「应缴 28,000 / 实缴 9,333」，又是一处对不上。
   */
  return list.map((i, idx) => ({
    ...i,
    amount: base[idx],
    standardAmount: base[idx],
    discount: 0,
  }));
}

/** 行 → 视图 */
export function toOrderView(row: any): ConsultFeeOrder {
  /**
   * ★ 2026-10-16 合并单的「应缴 / 优惠」整单口径：
   *    item_detail 里每项都记了 standardAmount（应缴）与 amount（实缴），
   *    求和后给前端回看用；老单据没有 standardAmount 时按 amount 兜底（优惠 = 0）。
   */
  const detail = parseOrderItemDetail(row.item_detail);
  const dueTotal = detail.reduce((s, i) => s + (i.standardAmount ?? i.amount), 0);

  /**
   * ★ 2026-10-16 用户口径：分期单不再显示「待上传凭证」。
   *
   *   分期是「先建计划、每期发起收款」的模式：单子一旦建出来就代表这一期已经
   *   发起收款并在等财务核对，再挂个「待上传凭证」会让老师以为还得自己去补，
   *   跟分期的操作动线（发起收款时当场传凭证）也不是一回事。
   *
   *   → 分期单的 status===NO_VOUCHER 统一按「待财务确认」展示；
   *     真缺凭证的单据，在列表「操作」列 / 分期计划弹窗里留了「补缴凭证」入口。
   *   ⚠️ 只改展示，不动库里的 status（补缴凭证后状态会自然变成 PENDING）。
   */
  const isInstallment = row.plan_id != null;
  const statusName =
    isInstallment && row.status === CFS.NO_VOUCHER
      ? nameOf(CONSULT_FEE_STATUS_NAME, CFS.PENDING)
      : nameOf(CONSULT_FEE_STATUS_NAME, row.status);

  return {
    orderId: row.id,
    financeFeeId: row.finance_fee_id || undefined,
    orderNo: row.order_no,
    consultStudentId: row.consult_student_id,
    studentName: row.student_name || '',
    studentNo: row.student_no || undefined,
    className: row.class_name || undefined,
    // ★ 2026-10-09 学生当前咨询状态（list 接口补查注入；已退费/退费中时前端隐藏「分班」）
    consultState: row.consult_state ?? undefined,
    consultStateName:
      row.consult_state !== undefined && row.consult_state !== null
        ? nameOf(CONSULT_STATE_NAME, row.consult_state)
        : undefined,
    feeType: row.fee_type,
    feeTypeName: nameOf(FEE_TYPE_NAME, row.fee_type),
    amount: row.amount,
    amountYuan: centToYuan(row.amount),
    status: row.status,
    statusName,
    financePayStatus: row.finance_pay_status ?? undefined,
    financePayStatusName: row.finance_pay_status
      ? nameOf(PAY_STATUS_NAME, row.finance_pay_status)
      : undefined,
    rejectReason: row.reject_reason || undefined,
    voucherUrl: row.voucher_url || undefined,
    voucherNo: row.voucher_no || undefined,
    voucherBy: row.voucher_by || undefined,
    payMethod: row.pay_method || undefined,
    createdByName: row.create_by_name || '',
    createTime: formatTime(row.create_time),
    lastAction: row.reject_reason
      ? `财务打回：${row.reject_reason}`
      : row.status === CFS.ARRIVED
        ? '财务已确认到账'
        : row.status === CFS.PENDING
          ? '凭证已上传，等待财务核对'
          : isInstallment
            ? '分期收款已发起，等待财务核对'
            : '已发起收费，等待上传缴费截图',

    // ★ 2026-10-16 应缴 / 优惠（仅合并缴费单有明细时才带）
    itemDetail: detail.length ? detail : undefined,
    dueAmount: detail.length ? dueTotal : undefined,
    discountAmount: detail.length ? dueTotal - Number(row.amount || 0) : undefined,

    /* ---------- ★ 2026-10-16 分期付款 ---------- */
    planId: row.plan_id || undefined,
    planNo: row.plan_no || undefined,
    stageNo: row.stage_no ?? undefined,
    stageText:
      row.stage_no != null && row.stage_count != null
        ? `第 ${row.stage_no} 期 / 共 ${row.stage_count} 期`
        : undefined,
    totalDueAmount: row.total_due_amount ?? undefined,
    totalDueAmountYuan:
      row.total_due_amount != null ? centToYuan(row.total_due_amount) : undefined,
  };
}

/**
 * ★ 2026-10-16 给收款单行补上分期信息（计划号 / 总期数）
 *
 * ⚠️ 为什么不用 leftJoin？
 *    t_consult_fee_order 与 t_consult_installment_plan 有十几个同名字段
 *    （id / status / student_name / item_detail / …），join 之后 select *
 *    会互相覆盖，收款单的 id 会被计划的 id 盖掉 —— 属于隐蔽的致命 bug。
 *    这里改成查完主表后按 plan_id 批量回查一次，安全且只多一次查询。
 */
export async function attachPlanInfo(rows: any[]): Promise<any[]> {
  const planIds = [...new Set(rows.map((r) => r.plan_id).filter(Boolean))];
  if (!planIds.length) return rows;

  const plans = await db('t_consult_installment_plan').whereIn('id', planIds);
  const map = new Map<string, any>(plans.map((pl: any) => [pl.id, pl]));

  for (const r of rows) {
    const pl = r.plan_id ? map.get(r.plan_id) : null;
    if (pl) {
      r.plan_no = pl.plan_no;
      r.stage_count = pl.stage_count;
    }
  }
  return rows;
}

/* ============================================================
 * ★ 2026-10-19 重复收费防护
 *
 * 背景（本地库里的真实数据）：
 *   同一学生在 10-15 12:14 已发起 6 张单（学费/住宿/押金/保险/餐费/校服），
 *   16:34 又在收款页发了一张 ¥32,400 的合计单 —— 同一批费用被收了两遍，
 *   学生档案里因此出现两组一模一样的「¥32,400」，老师问「怎么能缴费好几次」。
 *
 * 口径：
 *   · 同一费用项只要还有【未终结】单据（待上传凭证 / 待财务确认 / 已驳回），
 *     就不允许再发起 —— 否则账面重复计费，老师也分不清哪张有效。
 *   · 分期单由「分期计划 + 期次」自己管，不参与这里的防重。
 *   · 已到账的允许再发起（补收差额），但在返回文案里明确提示。
 * ============================================================ */

/** 仍占着这笔费用的状态：单子没走完，钱还没确认 */
const OPEN_STATUSES: number[] = [CFS.NO_VOUCHER, CFS.PENDING, CFS.REJECTED];

/** 一张收款单覆盖的费用类型：合并单读 item_detail，老数据读 fee_type */
export function typesOfOrder(row: any): FeeType[] {
  if (row?.item_detail) {
    try {
      const arr = JSON.parse(row.item_detail);
      if (Array.isArray(arr) && arr.length) {
        const list = arr
          .map((i: any) => Number(i?.feeType))
          .filter((n) => !isNaN(n) && n > 0) as FeeType[];
        if (list.length) return [...new Set(list)];
      }
    } catch {
      /* 脏数据退回 fee_type */
    }
  }
  return row?.fee_type == null ? [] : [Number(row.fee_type) as FeeType];
}

/** 冲突项（用于报错文案 / 提示） */
export interface FeeConflict {
  feeType: FeeType;
  feeTypeName: string;
  orderNo: string;
  status: number;
  statusName: string;
  amountYuan: string;
}

/** 该生「在途」的收费单里，命中本次要发起的费用项 */
export async function findInFlightConflicts(
  consultStudentId: string,
  feeTypes: FeeType[],
): Promise<FeeConflict[]> {
  if (!feeTypes.length) return [];
  const rows: any[] = await db(FEE_ORDER_TABLE).where({
    consult_student_id: consultStudentId,
    is_deleted: false,
  });

  const hits: FeeConflict[] = [];
  for (const r of rows) {
    if (r.plan_id) continue; // 分期单不参与主动收款防重
    if (!OPEN_STATUSES.includes(Number(r.status))) continue;
    const covered = typesOfOrder(r);
    for (const t of covered) {
      if (!feeTypes.includes(t)) continue;
      hits.push({
        feeType: t,
        feeTypeName: nameOf(FEE_TYPE_NAME, t),
        orderNo: r.order_no,
        status: Number(r.status),
        statusName: nameOf(CONSULT_FEE_STATUS_NAME, Number(r.status)),
        amountYuan: centToYuan(Number(r.amount || 0)),
      });
    }
  }
  return hits;
}

/**
 * 发起收费前的硬拦截：同一费用项已有未终结单据 → 直接拒绝
 *
 * ⚠️ 文案要写清「是哪张单、什么状态、该怎么办」，
 *    否则老师只会看到「参数错误」，然后换个入口再点一次，越点越乱。
 */
export async function assertNoInFlightDuplicate(
  consultStudentId: string,
  feeTypes: FeeType[],
): Promise<void> {
  const hits = await findInFlightConflicts(consultStudentId, feeTypes);
  if (!hits.length) return;

  // 同一类型只报第一条，避免 6 项冲突刷屏
  const seen = new Set<FeeType>();
  const lines: string[] = [];
  for (const h of hits) {
    if (seen.has(h.feeType)) continue;
    seen.add(h.feeType);
    lines.push(`${h.feeTypeName}（单号 ${h.orderNo}，${h.statusName} ¥${h.amountYuan}）`);
  }

  throw new BizError(
    BizCode.PARAM_ERROR,
    `该学生已有未完成的收费单，不能重复发起：${lines.join('；')}。` +
      `请先在原单上上传缴费凭证、等财务确认到账；如果那张单是误发起的，请先「作废」再重新收费。`,
  );
}

/** 该生已到账过的费用项（允许再收，但提示一句） */
export async function findArrivedTypes(
  consultStudentId: string,
  feeTypes: FeeType[],
): Promise<FeeConflict[]> {
  if (!feeTypes.length) return [];
  const rows: any[] = await db(FEE_ORDER_TABLE).where({
    consult_student_id: consultStudentId,
    is_deleted: false,
  });
  const hits: FeeConflict[] = [];
  for (const r of rows) {
    if (r.plan_id) continue;
    if (Number(r.status) !== CFS.ARRIVED) continue;
    for (const t of typesOfOrder(r)) {
      if (!feeTypes.includes(t)) continue;
      hits.push({
        feeType: t,
        feeTypeName: nameOf(FEE_TYPE_NAME, t),
        orderNo: r.order_no,
        status: CFS.ARRIVED,
        statusName: nameOf(CONSULT_FEE_STATUS_NAME, CFS.ARRIVED),
        amountYuan: centToYuan(Number(r.amount || 0)),
      });
    }
  }
  return hits;
}

/* ============================================================
 * ⭐ 作废收款单（重复发起 / 发起错了的撤销通道）
 * ============================================================ */

/**
 * 作废一至多张收款单（整批）
 *
 * ⚠️ 顺序很重要：先让财务作废（它可能拒绝：已核对入账的不能作废），
 *    成功后才软删本地单据 —— 否则会出现「本地看不到、财务还在待核对」的孤儿单。
 *
 * @param orderIds 本模块收款单 id（学生档案按批次合并显示时，传整批 id）
 */
export async function cancelFeeOrders(
  orderIds: string[],
  reason: string | undefined,
  operator: { name: string; title?: string },
): Promise<{ cancelled: number; skipped: Array<{ orderNo: string; reason: string }> }> {
  const result: { cancelled: number; skipped: Array<{ orderNo: string; reason: string }> } = {
    cancelled: 0,
    skipped: [],
  };
  const doneNos: string[] = [];
  let studentId: string | undefined;

  for (const id of orderIds) {
    const row: any = await db(FEE_ORDER_TABLE).where({ id, is_deleted: false }).first();
    if (!row) continue;
    studentId = studentId || row.consult_student_id;

    if (Number(row.status) === CFS.ARRIVED) {
      result.skipped.push({
        orderNo: row.order_no,
        reason: '已到账，不能作废；如需退款请走「退费」流程',
      });
      continue;
    }

    try {
      if (row.finance_fee_id) {
        await financeClient.cancelFee(row.finance_fee_id, reason || '上游重复发起，作废');
      }
    } catch (e: any) {
      result.skipped.push({
        orderNo: row.order_no,
        reason: e?.message || '财务侧作废失败',
      });
      continue;
    }

    await db(FEE_ORDER_TABLE).where({ id }).update({ is_deleted: true });
    result.cancelled += 1;
    doneNos.push(row.order_no);
  }

  if (result.cancelled && studentId) {
    await addHistory(
      studentId,
      operator.name,
      `作废收款单 ${doneNos.join('、')}（${reason?.trim() || '重复发起'}），已同步财务作废`,
      operator.title,
      'CHARGE',
    );
  }

  return result;
}

/* ============================================================
 * ⭐ 发起收费（核心联动）
 * ============================================================ */

/**
 * 发起一笔或多笔收费
 *
 * 流程（每一笔独立处理，单笔失败不影响其他笔）：
 *   1. 调财务 /standard/get 拿金额 + 来源校验信息
 *   2. 调财务 /fee/add 建单（amount 不传 → 财务按标准取）
 *   3. 本地落一条收款单记录（保存 financeFeeId）
 */
/* ============================================================
 * ★ 2026-10-15 合并缴费：一次缴清 = 一张合计单
 * ============================================================ */

/**
 * 把同一次勾选的多项费用，合并成【一张】收款单（金额 = 各项之和）。
 *
 * 用户口径：「缴费直接缴合计的，交一次就行」。
 *
 * 以前：勾选 6 项 → 建 6 张单（学费 28000 / 住宿 2700 / 押金 200 / …），
 *       老师明明只交了一笔 32400，系统里却是 6 笔各自带状态，
 *       财务侧也要核 6 次，老师看着像"交了 6 次钱"。
 *
 * 现在：只建 1 张单 —— amount = 合计，财务侧也只有 1 笔待核；
 *       勾选了哪些费用、各自多少钱，存进 item_detail（JSON）用于展示「包含哪些」。
 *
 * ⚠️ 适用范围：只用于【收款页主动发起】的多项收费。
 *    「转正式」的补缴走 createFees —— 那边要按类型算缺口（getSupplementPlan），
 *    合并会让它认不出哪些类型已缴。getSupplementPlan 已做兼容（会读 item_detail），
 *    但补缴本身仍按类型建单，保持缺口语义。
 *
 * @returns created 只有 1 条（失败也是 1 条，success=false）
 */
export async function createCombinedFees(
  consultStudentId: string,
  feeTypes: FeeType[],
  operator: { name: string; title?: string },
  payMethod?: string,
  amountByType?: Record<number, number>,
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    发起收费时必须带凭证，建单即落库（财务侧建单即「待核对」），
   *    不再有「先建单、再补传」的中间态。
   */
  voucherUrl?: string,
  voucherNo?: string,
): Promise<ConsultFeeCreateResult> {
  const stu = await findStudent(consultStudentId);
  if (!stu) {
    throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
  }

  if (!voucherUrl) {
    throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
  }

  const deptCode: DeptCode = stu.dept_code || DeptCode.JUNIOR_SENIOR;
  const studentNo = stu.student_no || tempStudentNo(consultStudentId);

  /**
   * ★ 2026-10-19 防重复收费（用户口径：同一笔费用只能有一张在途单）
   *   同一费用项已有「待上传凭证 / 待财务确认 / 已驳回」的单 → 直接拒绝。
   */
  await assertNoInFlightDuplicate(consultStudentId, feeTypes);
  /** 已到账过的类型：允许再收（补差），但要提示 */
  const arrivedBefore = await findArrivedTypes(consultStudentId, feeTypes);

  /** 主类型：含学费就用「学费」（正式学费 = 学费为主体），否则取第一个 */
  const primaryType = feeTypes.includes(FeeType.TUITION) ? FeeType.TUITION : feeTypes[0];

  /* ---------- ① 逐项取标准 / 校验来源（规则2 + 规则3-① 前置） ---------- */
  /**
   * ★ 2026-10-16 每项都记三个口径：
   *    amount（实缴）/ standardAmount（应缴）/ discount（优惠 = 应缴 - 实缴）
   */
  const items: Array<{
    feeType: FeeType;
    feeTypeName: string;
    amount: number;
    standardAmount: number;
    discount: number;
  }> = [];
  for (const feeType of feeTypes) {
    const feeTypeName = nameOf(FEE_TYPE_NAME, feeType);
    const std = await financeClient.getStandard(feeType, deptCode);

    if (std.sourceModule !== SourceModule.CONSULT) {
      throw new BizError(
        BizCode.SOURCE_MODULE_MISMATCH,
        `${feeTypeName} 应由「${std.sourceModuleName}」发起，咨询模块无权建单。`,
      );
    }

    /**
     * ★ 2026-10-16 应缴 / 实缴 / 优惠：
     *    standardAmount = 财务标准的应缴；amount = 本次实缴（老师可改，改了就是优惠/补收）。
     *    discount = 应缴 - 实缴（>0 优惠，<0 补收）。
     */
    const customAmount = amountByType?.[feeType];
    // ★ 2026-10-16 用户口径：实缴不能大于应缴（收费弹窗已限制，后端再兜一道）
    if (customAmount != null && customAmount > std.amount) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `${feeTypeName} 实缴 ¥${centToYuan(customAmount)} 不能大于应缴 ¥${centToYuan(std.amount)}`,
      );
    }
    const paid = customAmount != null ? customAmount : std.amount;
    items.push({
      feeType,
      feeTypeName,
      amount: paid,
      standardAmount: std.amount,
      discount: std.amount - paid,
    });
  }

  const total = items.reduce((s, i) => s + i.amount, 0);
  if (total <= 0) {
    throw new BizError(BizCode.PARAM_ERROR, '合计金额必须大于 0');
  }

  /** 整单口径：应缴合计 / 优惠合计（分） */
  const dueTotal = items.reduce((s, i) => s + (i.standardAmount ?? i.amount), 0);
  const discountTotal = dueTotal - total;

  const detailText = items.map((i) => `${i.feeTypeName}${centToYuan(i.amount)}`).join('/');
  const discountText =
    discountTotal > 0
      ? `（应缴 ¥${centToYuan(dueTotal)}，优惠 ¥${centToYuan(discountTotal)}）`
      : discountTotal < 0
        ? `（应缴 ¥${centToYuan(dueTotal)}，补收 ¥${centToYuan(-discountTotal)}）`
        : '';

  /* ---------- ② 财务侧建 1 笔（金额 = 合计） ---------- */
  const financeRes = await financeClient.addFee({
    studentId: consultStudentId,
    studentNo,
    studentName: stu.student_name,
    feeType: primaryType,
    deptCode,
    classId: stu.class_id || undefined,
    className: stu.class_name || undefined,
    sourceModule: SourceModule.CONSULT,
    payMethod,
    amount: total, // ★ 合并单必须显式传金额，否则财务会按单一类型的标准取值
    /**
     * ★ 2026-10-19 把分项一并发给财务
     *    用户口径：财务看到的也应该是「总金额 + 下面列包含什么」，
     *    而不是一个不知道由来的合计数。
     */
    itemDetail: items.map((i) => ({
      feeType: i.feeType,
      feeTypeName: i.feeTypeName,
      amount: i.amount,
      standardAmount: i.standardAmount,
      discount: i.discount,
    })),
    // ★ 2026-10-19 凭证随建单一起落库，财务侧建单即「待核对」
    voucherUrl,
    voucherNo,
    remark: `咨询模块发起（${operator.name}）· 合计含：${detailText}${discountText}`,
  });

  /* ---------- ③ 本地落 1 张单 ---------- */
  const orderId = randomUUID();
  const orderNo = await nextOrderNo();
  await db(FEE_ORDER_TABLE).insert({
    id: orderId,
    order_no: orderNo,
    finance_fee_id: financeRes.id,
    consult_student_id: consultStudentId,
    student_name: stu.student_name,
    student_no: studentNo,
    class_name: stu.class_name || null,
    dept_code: deptCode,
    fee_type: primaryType,
    amount: total,
    // ★ 2026-10-19 建单即带凭证 → 直接「待财务确认」
    status: CFS.PENDING,
    voucher_url: voucherUrl,
    voucher_no: voucherNo || null,
    voucher_by: operator.name,
    pay_method: payMethod || null,
    batch_no: Date.now(),
    item_detail: JSON.stringify(items),
    create_time: new Date(),
    create_by: operator.name,
    create_by_name: operator.name,
    is_deleted: false,
  });

  await addHistory(
    consultStudentId,
    operator.name,
    `发起收费：${items.map((i) => i.feeTypeName).join('/')} 实缴 ¥${centToYuan(total)}${discountText}，等待上传缴费截图并由财务确认到账`,
    operator.title,
    'CHARGE',
  );

  return {
    created: [
      {
        orderId,
        financeFeeId: financeRes.id,
        orderNo,
        feeType: primaryType,
        feeTypeName: items.length > 1 ? '正式学费' : nameOf(FEE_TYPE_NAME, primaryType),
        amount: total,
        success: true,
      },
    ],
    message:
      (items.length > 1
        ? `已发起收费（合计 ¥${centToYuan(total)}，含 ${items.length} 项），凭证已上传，等待财务确认`
        : '已发起收费，凭证已上传，等待财务确认') +
      (arrivedBefore.length
        ? `。注意：${arrivedBefore
            .map((a) => `${a.feeTypeName}此前已到账 ¥${a.amountYuan}`)
            .join('、')}，本次属于再次收费，请确认是补收差额`
        : ''),
  };
}

export async function createFees(
  consultStudentId: string,
  feeTypes: FeeType[],
  operator: { name: string; title?: string },
  payMethod?: string,
  /**
   * ★ 2026-10-15 金额自定义（单位：分），key = feeType
   *
   * 老师改过金额的费用类型（目前前端只对「试学费」开放）就用老师填的，
   * 其余类型照旧按财务费用标准取值（规则2 不变）。
   */
  amountByType?: Record<number, number>,
  /** ★ 2026-10-19 用户口径：只要缴费就要有凭证 —— 单类型也必须带 */
  voucherUrl?: string,
  voucherNo?: string,
): Promise<ConsultFeeCreateResult> {
  const stu = await findStudent(consultStudentId);
  if (!stu) {
    throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
  }

  if (!voucherUrl) {
    throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
  }

  /**
   * ★ 2026-10-19 兜底：一次缴费 = 一张单
   *
   * 用户口径：「只要一张凭证就是交的总金额，总金额下面列小列」。
   * 这个函数的老语义是「一个费用类型建一张单」，只剩单类型场景才用它；
   * 任何调用方误传多个类型，也在这里直接转成「一张合计单」，
   * 从根上杜绝「一次交钱 → 学生档案里出现多行」。
   */
  if (feeTypes.length > 1) {
    return createCombinedFees(
      consultStudentId,
      feeTypes,
      operator,
      payMethod,
      amountByType,
      voucherUrl,
      voucherNo,
    );
  }

  const deptCode: DeptCode = stu.dept_code || DeptCode.JUNIOR_SENIOR;
  // ⚠️ 咨询阶段学生还没有正式学号（转正式后由教务分配），
  //    但财务侧 studentNo 是必填（用于对账快照），所以这里生成「临时学号」：
  //    规则：ZX + 咨询学生ID 去掉前缀 → 如 cs-0006 → ZX0006
  //    转正式时教务会分配正式学号（S202600XX），届时以教务为准。
  const studentNo = stu.student_no || tempStudentNo(consultStudentId);
  const created: ConsultFeeCreateResult['created'] = [];
  // 同一次发起用同一个批次号，便于前端分组显示
  const batchNo = Date.now();

  /**
   * ★ 2026-10-19 防重复收费（与合并单同一口径）
   *
   * ⚠️ 这条路径也被「转正式 · 一次性缴清 / 分笔补缴」调用：
   *    如果学生已经有一张待确认的学费单，再点一次转正式就会重复建单，
   *    学生档案里就会出现两组相同金额 —— 必须在建单前拦住。
   */
  await assertNoInFlightDuplicate(consultStudentId, feeTypes);
  const arrivedBefore = await findArrivedTypes(consultStudentId, feeTypes);

  for (const feeType of feeTypes) {
    const feeTypeName = nameOf(FEE_TYPE_NAME, feeType);

    try {
      // ---- 1. 取费用标准（规则2）----
      // ⚠️ 默认不传 amount 给财务，让财务自己按标准取值，避免两边算不一致；
      //    ★ 2026-10-15 例外：本次老师自定义了金额（如试学费实收 3000）→ 明确传给财务
      const std = await financeClient.getStandard(feeType, deptCode);
      const customAmount = amountByType?.[feeType];
      // ★ 2026-10-16 用户口径：实缴不能大于应缴
      if (customAmount != null && customAmount > std.amount) {
        throw new BizError(
          BizCode.PARAM_ERROR,
          `${feeTypeName} 实缴 ¥${centToYuan(customAmount)} 不能大于应缴 ¥${centToYuan(std.amount)}`,
        );
      }
      const amount = customAmount != null ? customAmount : std.amount;

      // ---- 2. 校验来源（规则3-① 的前置检查，财务侧还会再校验一次）----
      if (std.sourceModule !== SourceModule.CONSULT) {
        throw new BizError(
          BizCode.SOURCE_MODULE_MISMATCH,
          `${feeTypeName} 应由「${std.sourceModuleName}」发起，咨询模块无权建单。`,
        );
      }

      // ---- 3. 调财务建单 ----
      const financeRes = await financeClient.addFee({
        studentId: consultStudentId,
        studentNo,
        studentName: stu.student_name,
        feeType,
        deptCode,
        classId: stu.class_id || undefined,
        className: stu.class_name || undefined,
        sourceModule: SourceModule.CONSULT,
        payMethod,
        // 只有自定义过才传，其余让财务按标准取值
        amount: customAmount != null ? customAmount : undefined,
        // ★ 2026-10-19 凭证随建单一起落库
        voucherUrl,
        voucherNo,
        remark: `咨询模块发起（${operator.name}）`,
      });

      // ---- 4. 本地落库 ----
      const orderId = randomUUID();
      const orderNo = await nextOrderNo();
      await db(FEE_ORDER_TABLE).insert({
        id: orderId,
        order_no: orderNo,
        finance_fee_id: financeRes.id,
        consult_student_id: consultStudentId,
        student_name: stu.student_name,
        student_no: studentNo,
        class_name: stu.class_name || null,
        dept_code: deptCode,
        fee_type: feeType,
        amount,
        // ★ 2026-10-19 建单即带凭证 → 直接「待财务确认」，不存在「待上传凭证」
        status: CFS.PENDING,
        voucher_url: voucherUrl,
        voucher_no: voucherNo || null,
        voucher_by: operator.name,
        pay_method: payMethod || null,
        batch_no: batchNo,
        /**
         * ★ 2026-10-16 单笔收款也记一份明细（只在老师改过金额时写）：
         *    这样「应缴 / 实缴 / 优惠」在单笔单据上同样能回看。
         *    没改过金额时保持 NULL（应缴 = 实缴，无优惠），省得存冗余数据。
         */
        item_detail:
          customAmount != null
            ? JSON.stringify([
                {
                  feeType,
                  feeTypeName,
                  amount,
                  standardAmount: std.amount,
                  discount: std.amount - amount,
                },
              ])
            : null,
        create_time: new Date(),
        create_by: operator.name,
        create_by_name: operator.name,
        is_deleted: false,
      });

      created.push({
        orderId,
        financeFeeId: financeRes.id,
        orderNo,
        feeType,
        feeTypeName,
        amount,
        success: true,
      });
    } catch (err: any) {
      // 单笔失败不影响其他笔
      created.push({
        orderId: '',
        orderNo: '',
        feeType,
        feeTypeName,
        amount: 0,
        success: false,
        reason: err?.message || '未知错误',
      });
    }
  }

  const okCount = created.filter((c) => c.success).length;
  const failCount = created.length - okCount;

  // 写跟进历史
  if (okCount > 0) {
    const total = created.filter((c) => c.success).reduce((a, b) => a + b.amount, 0);
    const names = created.filter((c) => c.success).map((c) => c.feeTypeName).join('/');
    await addHistory(
      consultStudentId,
      operator.name,
      `发起收费：${names} 共 ¥${centToYuan(total)}，凭证已随单上传，等待财务确认到账`,
      operator.title,
      'CHARGE',
    );
  }

  /**
   * ★ 2026-10-19 已到账过的类型再收一次 → 文案里点出来
   *    （不拦截，因为是合法的「补收差额」；但老师必须知道这不是首收）
   */
  const arrivedTip = arrivedBefore.length
    ? `。注意：${arrivedBefore
        .map((a) => `${a.feeTypeName}此前已到账 ¥${a.amountYuan}`)
        .join('、')}，本次属于再次收费，请确认是补收差额`
    : '';

  return {
    created,
    message:
      (failCount === 0
        ? `${okCount} 笔已发起成功，凭证已上传，等待财务确认`
        : `${okCount} 笔成功、${failCount} 笔失败：${created.filter((c) => !c.success).map((c) => `${c.feeTypeName}（${c.reason}）`).join('；')}`) +
      arrivedTip,
  };
}

/* ============================================================
 * ★ 2026-10-20 补费：试学转正补缴尾款 / 差额补收（金额自定义）
 *
 * 用户口径：「交了试学费的，后边在收款与缴费管理那儿操作里面
 *            添加一个补费功能，补费金额自定义。」
 *
 * 与 createFees 的差别（别硬套那条链）：
 *   · 补费不是「按费用标准收费」，金额老师手填 → 不走「实缴 ≤ 应缴」校验；
 *   · 只对「已缴过试学费」的学生开放（试学 → 转正补尾款）；
 *   · 落库类型固定 FeeType.SUPPLEMENT(8)，列表一眼能看出是补费单，
 *     不会污染「学费」的已缴判定（否则全款口径会算错）。
 * ============================================================ */
export async function createSupplementFee(
  consultStudentId: string,
  amount: number,
  operator: { name: string; title?: string },
  opts: {
    /** ★ 只要缴费就要有凭证 —— 与发起收费同一铁律 */
    voucherUrl: string;
    voucherNo?: string;
    payMethod?: string;
    /** 补费说明（如「试学转正补尾款」「补差价」），写进单据备注与跟进历史 */
    remark?: string;
  },
): Promise<{ orderId: string; orderNo: string; amount: number; message: string }> {
  const stu = await findStudent(consultStudentId);
  if (!stu) {
    throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BizError(BizCode.PARAM_ERROR, '补费金额必须大于 0');
  }
  if (!opts.voucherUrl) {
    throw new BizError(BizCode.PARAM_ERROR, '请先上传缴费凭证截图');
  }

  /* ---------- 门槛 1：必须已经缴过试学费 ---------- */
  //
  // 用户口径是「交了试学费的」才有补费入口。前端按钮按行显示（试学费单已到账），
  // 但接口不能只靠前端 —— 直接调接口绕过按钮的情况必须挡住。
  const trialPaid = await db(FEE_ORDER_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .where('fee_type', FeeType.TRIAL_FEE)
    .where('status', CFS.ARRIVED)
    .first();
  if (!trialPaid) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `「${stu.student_name}」还没有已到账的试学费，补费只对已缴试学费的学生开放（首笔请走「发起收费」）`,
    );
  }

  /**
   * ---------- 门槛 2：同学生同时只允许一笔「在途补费」 ----------
   *
   * 补费金额是手填的，重复点两次就会建两张单 → 到账后多收一笔钱，
   * 学生档案里也会出现两条补费。这里直接拦，让他等财务核对结果。
   */
  const inFlight = await db(FEE_ORDER_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .where('fee_type', FeeType.SUPPLEMENT)
    .where('status', CFS.PENDING)
    .first();
  if (inFlight) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `该学生已有一笔补费 ¥${centToYuan(Number(inFlight.amount))}（${inFlight.order_no}）正在等财务确认，请先等核对结果，不要重复发起`,
    );
  }

  const deptCode: DeptCode = stu.dept_code || DeptCode.JUNIOR_SENIOR;
  const studentNo = stu.student_no || tempStudentNo(consultStudentId);
  const feeTypeName = nameOf(FEE_TYPE_NAME, FeeType.SUPPLEMENT);
  const remark = (opts.remark || '').trim() || '试学转正补缴尾款';

  /* ---------- 1. 先让财务建单（金额直接传，不让财务按标准取） ---------- */
  const financeRes = await financeClient.addFee({
    studentId: consultStudentId,
    studentNo,
    studentName: stu.student_name,
    feeType: FeeType.SUPPLEMENT,
    deptCode,
    classId: stu.class_id || undefined,
    className: stu.class_name || undefined,
    sourceModule: SourceModule.CONSULT,
    payMethod: opts.payMethod,
    amount,
    voucherUrl: opts.voucherUrl,
    voucherNo: opts.voucherNo,
    remark: `咨询模块补费（${operator.name}）：${remark}`,
  });

  /* ---------- 2. 本地落库 ---------- */
  const orderId = randomUUID();
  const orderNo = await nextOrderNo();
  await db(FEE_ORDER_TABLE).insert({
    id: orderId,
    order_no: orderNo,
    finance_fee_id: financeRes.id,
    consult_student_id: consultStudentId,
    student_name: stu.student_name,
    student_no: studentNo,
    class_name: stu.class_name || null,
    dept_code: deptCode,
    fee_type: FeeType.SUPPLEMENT,
    amount,
    // 建单即带凭证 → 待财务确认（与发起收费同一口径）
    status: CFS.PENDING,
    voucher_url: opts.voucherUrl,
    voucher_no: opts.voucherNo || null,
    voucher_by: operator.name,
    pay_method: opts.payMethod || null,
    batch_no: Date.now(),
    item_detail: JSON.stringify([
      {
        feeType: FeeType.SUPPLEMENT,
        feeTypeName,
        amount,
        /** 补费没有「标准价」，应缴就是老师填的数，优惠恒为 0 */
        standardAmount: amount,
        discount: 0,
      },
    ]),
    create_time: new Date(),
    create_by: operator.name,
    create_by_name: operator.name,
    is_deleted: false,
  });

  /* ---------- 3. 跟进历史 ---------- */
  await addHistory(
    consultStudentId,
    operator.name,
    `发起补费 ¥${centToYuan(amount)}（${remark}），凭证已随单上传，等待财务确认到账`,
    operator.title,
    'SUPPLEMENT',
  );

  /**
   * ---------- 4. 状态推进：试学中 → 缴费中·待确认 ----------
   *
   * ⚠️ 三种状态分开处理，别一把梭：
   *   · TRIAL(5 试学中)       → FULL_FEE_PENDING(6)：试学结束补尾款，等钱到账转正式
   *   · TRIAL_FEE_PENDING(3)  → FULL_FEE_PENDING(6)：试学费还没确认就到补费（少见但合法）
   *   · TRIAL_WAIT_CLASS(4)   → 不动：他正等分班，改成「缴费中」会把「分配班级」入口弄没
   *   · FORMAL(7)             → 不动：正式在读的补收属于正常追加，不改变身份
   */
  const cur = stu.consult_state as ConsultState;
  if (cur === ConsultState.TRIAL || cur === ConsultState.TRIAL_FEE_PENDING) {
    try {
      await changeState(consultStudentId, ConsultState.FULL_FEE_PENDING, {
        byName: operator.name,
        byTitle: operator.title,
        action: 'FEE_SUPPLEMENT',
        historyText: `发起补费 ¥${centToYuan(amount)}（${remark}），待财务确认到账后转正式在读`,
      });
    } catch (e: any) {
      // 状态没推进不影响单据本身：钱和单已经落库，财务核对后到账逻辑还会兜一次
      console.warn('[createSupplementFee] 状态推进失败', e?.message);
    }
  }

  return {
    orderId,
    orderNo,
    amount,
    message: `补费 ¥${centToYuan(amount)} 已发起，凭证已上传，等待财务确认到账`,
  };
}

/* ============================================================
 * 凭证上传 / 重新提交
 * ============================================================ */

/**
 * 上传缴费凭证
 *
 * ⚠️ 这里会把凭证同步给财务侧 —— 调财务 /fee/add 时带 voucherUrl，
 *    但单已建过，所以走「更新」路径：
 *    实际做法是：本地先存，然后提示财务侧（财务的凭证更新接口在本期未开放，
 *    故此处仅本地记录 + 提示「请在财务模块核对页确认」）。
 *
 *    如果财务侧后续开放凭证更新接口，把 TODO 部分补上即可。
 */
export async function uploadVoucher(
  orderId: string,
  voucherUrl: string,
  voucherNo: string | undefined,
  operator: { name: string; title?: string },
): Promise<void> {
  const row = await db(FEE_ORDER_TABLE).where({ id: orderId, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.ORDER_NOT_FOUND, '收款单不存在');
  }

  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证，缴费单后边的凭证都得能查看」。
   *
   * 分两种情况：
   *  · 已到账 + 已有凭证 → 拒绝（账已核对完，不让事后换图）；
   *  · 已到账 + 没有凭证 → 允许补传（历史数据：分期/早期单据没强制凭证），
   *    但**只补图，不回退状态**，否则已到账会被打回「待财务确认」，账面反而乱。
   */
  const arrived = row.status === CFS.ARRIVED;
  if (arrived && row.voucher_url) {
    throw new BizError(BizCode.INVALID_STATUS, '该笔费用已确认到账，不能再修改凭证');
  }

  await db(FEE_ORDER_TABLE).where({ id: orderId }).update({
    voucher_url: voucherUrl,
    voucher_no: voucherNo || null,
    voucher_by: operator.name,
    // 未到账：上传凭证 → 「待财务确认」；已到账：只补图，状态不动
    status: arrived ? CFS.ARRIVED : CFS.PENDING,
    reject_reason: null,
    update_time: new Date(),
    update_by: operator.name,
  });

  await addHistory(
    row.consult_student_id,
    operator.name,
    arrived
      ? `补传缴费截图（${nameOf(FEE_TYPE_NAME, row.fee_type)} ¥${centToYuan(row.amount)}${voucherNo ? `，转账单号 ${voucherNo}` : ''}）：该笔此前已到账但缺少凭证，现补齐`
      : `上传缴费截图（${nameOf(FEE_TYPE_NAME, row.fee_type)} ¥${centToYuan(row.amount)}${voucherNo ? `，转账单号 ${voucherNo}` : ''}），等待财务核对`,
    operator.title,
    'UPLOAD_VOUCHER',
  );

  // ---- 回传凭证给财务（规则3-②的呼应）----
  // ⚠️ 必须回传成功才算上传完成，原因：
  //    财务侧会做「凭证唯一性」校验（非餐费一人一张，规则3-②），
  //    如果只是本地记录、财务拒绝了却不告诉用户，会出现
  //    「学生以为交了、财务那边根本没这张单」的对不上账。所以这里要：
  //      ① 回传失败 → 回滚本地凭证和状态 ② 把财务的原因原样抛给用户
  if (row.finance_fee_id) {
    try {
      await financeClient.attachVoucher({
        id: row.finance_fee_id,
        voucherUrl,
        voucherNo: voucherNo || undefined,
      });
      await addHistory(
        row.consult_student_id,
        operator.name,
        '缴费凭证已同步至财务模块，等待财务核对到账',
        operator.title,
        'VOUCHER_SYNCED',
      );
    } catch (err: any) {
      // 回滚本地：把凭证撤掉；未到账退「待上传凭证」，已到账保持「已到账」
      await db(FEE_ORDER_TABLE).where({ id: orderId }).update({
        voucher_url: null,
        voucher_no: null,
        voucher_by: null,
        status: arrived ? CFS.ARRIVED : CFS.NO_VOUCHER,
        update_time: new Date(),
        update_by: operator.name,
      });

      // 财务的原始原因对用户最有价值（例如「该凭证已被 XX 占用」），原样透出
      const reason = err?.message || '财务模块不可达，请稍后重试';
      await addHistory(
        row.consult_student_id,
        operator.name,
        `凭证上传失败（财务未接受）：${reason}`,
        operator.title,
        'VOUCHER_REJECTED',
      );
      throw new BizError(BizCode.DOWNSTREAM_ERROR, `凭证未通过财务校验：${reason}`);
    }
  }
}

/** 被驳回后重新提交（把状态推回待确认） */
export async function resubmitOrder(
  orderId: string,
  operator: { name: string; title?: string },
): Promise<void> {
  const row = await db(FEE_ORDER_TABLE).where({ id: orderId, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.ORDER_NOT_FOUND, '收款单不存在');

  if (row.status !== CFS.REJECTED) {
    throw new BizError(BizCode.INVALID_STATUS, '只有被驳回的单据才能重新提交');
  }
  if (!row.voucher_url) {
    throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '请先上传缴费截图再重新提交');
  }

  await db(FEE_ORDER_TABLE).where({ id: orderId }).update({
    status: CFS.PENDING,
    update_time: new Date(),
    update_by: operator.name,
  });

  await addHistory(
    row.consult_student_id,
    operator.name,
    `重新提交被驳回的收款单（${nameOf(FEE_TYPE_NAME, row.fee_type)} ¥${centToYuan(row.amount)}）`,
    operator.title,
    'RESUBMIT',
  );
}

/* ============================================================
 * ⭐ 回读财务状态（同步核对结果）
 * ============================================================ */

/**
 * 从财务侧拉取最新核对状态，更新本地收款单
 *
 * ⚠️ 为什么要这一步？
 *    核对动作是财务做的，咨询侧只是"旁观者"。
 *    每次打开收款列表时主动同步一次，保证状态是最新的。
 *
 * @param orderIds 可选，只同步指定的单；不传则同步全部未到账的单
 */
/**
 * ★ 2026-10-09 财务同步节流：
 *    fee/list 每次刷新都会触发全量同步，而同步内部是「自调用 HTTP」（单体里
 *    打回自己 8004），并发刷新时嵌套放大连接占用 —— 是「请求超时」的主要来源。
 *    加 10 秒节流：刚同步过就跳过（指定 orderIds 的强制同步不受节流限制）。
 */
const SYNC_THROTTLE_MS = 10_000;
let lastFeeSyncAt = 0;

export async function syncFromFinance(orderIds?: string[]): Promise<{ updated: number }> {
  if (!orderIds?.length && Date.now() - lastFeeSyncAt < SYNC_THROTTLE_MS) {
    return { updated: 0 };
  }
  lastFeeSyncAt = Date.now();

  let query = db(FEE_ORDER_TABLE).where({ is_deleted: false });
  if (orderIds?.length) {
    query = query.whereIn('id', orderIds);
  } else {
    // 只要还没到账的（已到账/已驳回的不用再查）
    query = query.whereIn('status', [CFS.NO_VOUCHER, CFS.PENDING]);
  }
  const rows = await query;

  let updated = 0;
  for (const row of rows) {
    if (!row.finance_fee_id) continue;
    try {
      const detail: any = await financeClient.getFeeDetail(row.finance_fee_id);
      const payStatus = detail?.payStatus;

      let nextStatus: ConsultFeeStatus | null = null;
      let rejectReason: string | null = null;

      if (payStatus === PayStatus.VERIFIED) {
        nextStatus = CFS.ARRIVED;
      } else if (detail?.rejectReason || detail?.status === 'REJECTED') {
        // 财务打回
        nextStatus = CFS.REJECTED;
        rejectReason = detail.rejectReason || '财务打回，凭证有误';
      } else if (payStatus === PayStatus.PAID) {
        nextStatus = CFS.PENDING;
      }

      if (nextStatus !== null && nextStatus !== row.status) {
        await db(FEE_ORDER_TABLE).where({ id: row.id }).update({
          status: nextStatus,
          finance_pay_status: payStatus,
          reject_reason: rejectReason,
          update_time: new Date(),
          update_by: 'system-sync',
        });

        // 状态变化时补历史
        if (nextStatus === CFS.ARRIVED) {
          await addHistory(
            row.consult_student_id,
            '财务模块',
            `${nameOf(FEE_TYPE_NAME, row.fee_type)} ¥${centToYuan(row.amount)} 财务已确认到账`,
            '系统',
            'FEE_ARRIVED',
          );
          // ★ 2026-10-08 到账不只是改收款单 —— 学生的咨询状态也要跟着流转，
          //   否则会停在「试学费·待确认」不动（用户实测：财务确认到账后状态没变）
          await advanceStudentStateOnArrival(row);
        } else if (nextStatus === CFS.REJECTED) {
          await addHistory(
            row.consult_student_id,
            '财务模块',
            `${nameOf(FEE_TYPE_NAME, row.fee_type)} ¥${centToYuan(row.amount)} 被财务打回：${rejectReason}`,
            '系统',
            'FEE_REJECTED',
          );
        }
        updated++;
      } else if (payStatus !== row.finance_pay_status) {
        // 状态没变但 payStatus 变了（如 待缴→已缴），也更新一下
        await db(FEE_ORDER_TABLE).where({ id: row.id }).update({
          finance_pay_status: payStatus,
        });
      }
    } catch (err: any) {
      // 财务侧查不到这张单（可能被删了）不报错，跳过
      console.warn('[syncFromFinance] 跳过', row.order_no, err?.message);
    }
  }

  // ★ 2026-10-08 补偿：在「推进逻辑上线之前」就已到账的单，
  //   不会再进上面的循环（它们的收款单状态已是 ARRIVED），靠这里补推学生状态。
  try {
    await syncArrivedStudentStates();
  } catch (err: any) {
    console.warn('[syncFromFinance] 到账状态补偿失败', err?.message);
  }

  return { updated };
}

/**
 * ★ 2026-10-08 补偿同步：遍历所有「已到账」的收款单，
 *    若学生状态还停在对应前置状态（说明之前漏推了），补推一次。
 *    幂等：推进本身有前置状态守卫，推过一次后不再重复。
 */
async function syncArrivedStudentStates(): Promise<void> {
  const rows = await db(FEE_ORDER_TABLE).where({ is_deleted: false, status: CFS.ARRIVED });
  for (const row of rows) {
    try {
      await advanceStudentStateOnArrival(row);
    } catch (err: any) {
      console.warn('[syncArrivedStudentStates] 跳过', row.order_no, err?.message);
    }
  }
}

/**
 * ★ 2026-10-08 费用到账 → 推进学生的咨询流转状态
 *
 * ⚠️ 用户实测问题：财务确认到账、凭证也传了，学生的「当前状态」
 *    还停在「试学费·待确认」不动 —— 根因就是 syncFromFinance 只更新了
 *    收款单状态，没有推进学生。
 *
 * 流转规则（只在学生处于对应前置状态时才动，幂等可重试）：
 *    · 试学费到账  → TRIAL_FEE_PENDING（咨询中）→ TRIAL_WAIT_CLASS（待分班）
 *    · 学费（全款）到账 → 当前所有全款费用单都到账后 → TRIAL_WAIT_CLASS（待分班）
 *      ★ 2026-10-20 用户口径「交完试学费或学费就分配班级」：
 *        学费到账同样先进「待分班」，分完班才落「正式在读」，不再直接跳 FORMAL。
 *      （转正式会一次发 4 笔 FULL_FEE_TYPES，必须等全到，不能到一笔就转）
 */
async function advanceStudentStateOnArrival(row: any): Promise<void> {
  const stu = await findStudent(row.consult_student_id);
  if (!stu) return;

  /* ---------- ★ 2026-10-16 分期：先回算计划进度 ---------- */
  //
  // ⚠️ 用动态 import：installment.service 反过来也 import 了本文件
  //    （nextOrderNo / tempStudentNo / centToYuan / parseOrderItemDetail），
  //    静态 import 会形成循环依赖，运行时可能拿到未初始化的绑定。
  try {
    const { syncStudentPlans } = await import('./installment.service');
    await syncStudentPlans(row.consult_student_id);
  } catch (err: any) {
    console.warn('[advanceStudentStateOnArrival] 分期进度回算失败', err?.message);
  }

  const cur = stu.consult_state as ConsultState;
  let target: ConsultState | null = null;
  let gate = '';

  /**
   * ★ 2026-10-20 试学闭环：转「正式在读」后，把班级学籍一并改成「正式在读(5)」
   *
   * 用户口径：试学结束由班主任发起补费，补缴到账就转正式。
   * 钱和咨询状态在本模块，学籍在班级模块，只改一边会出现
   * 「咨询侧已是正式在读，班主任花名册还挂试学中」的割裂状态。
   *
   * ⚠️ 认人键 = 咨询侧学号（班级建档时写入 source_id）。
   * ⚠️ 失败只记日志：钱已经到账、状态已经推进，不能因为班级模块抖一下就把整笔到账回滚。
   */
  const syncClassOnFormal = async (next: ConsultState): Promise<void> => {
    if (next !== ConsultState.FORMAL) return;
    try {
      const consultNo = String(stu.student_no || stu.id);
      const r = await classSync.studentStatusSync(consultNo, 5 /* StudentStatus.STUDYING */);
      if (!r.ok) {
        console.warn(`[advanceStudentStateOnArrival] 班级学籍同步失败：${r.message}`);
      }
    } catch (e: any) {
      console.warn('[advanceStudentStateOnArrival] 班级学籍同步异常', e?.message);
    }
  };

  /* ---------- ★ 2026-10-16 分期口径：首付到账即可推进 ---------- */
  //
  // 用户口径（2026-10-16）：分期的学生首付到账就能分班进试学/正式，
  // 尾款挂在待缴余额里继续收，学生带「欠费」标记。
  // 所以这里【不能】沿用「全款单全部到账才转正式」的判断。
  const plans: any[] = await db('t_consult_installment_plan')
    .where({ consult_student_id: row.consult_student_id, is_deleted: false })
    .whereNot('status', 3); // 3 = TERMINATED

  if (plans.length) {
    const detail = parseOrderItemDetail(plans[0].item_detail);
    // 计划里全是试学费 → 走试学口径；含学费等全款项 → 走正式口径
    const isTrialOnly =
      detail.length > 0 && detail.every((d) => Number(d.feeType) === FeeType.TRIAL_FEE);

    const pendingYuan = centToYuan(
      plans.reduce((s: number, pl: any) => s + Number(pl.pending_amount || 0), 0),
    );

    if (isTrialOnly) {
      if (cur === ConsultState.TRIAL_FEE_PENDING) {
        target = ConsultState.TRIAL_WAIT_CLASS;
        gate = '分期首付已到账';
      }
    } else if (
      cur === ConsultState.TRIAL_FEE_PENDING ||
      cur === ConsultState.FULL_FEE_PENDING ||
      cur === ConsultState.TRIAL_WAIT_CLASS ||
      cur === ConsultState.TRIAL
    ) {
      // ★ 2026-10-20 同口径：还没分班 → 先「待分班」，分完班再落正式
      if (!stu.class_id) {
        target = ConsultState.TRIAL_WAIT_CLASS;
        gate = '分期首付已到账，待分配班级';
      } else {
        target = ConsultState.FORMAL;
        gate = '分期首付已到账';
      }
    }

    if (target && target !== cur) {
      await changeState(row.consult_student_id, target, {
        byName: '财务模块',
        byTitle: '系统',
        action: 'FEE_ARRIVED_STATE',
        historyText: `${gate}，学生状态流转为「${nameOf(CONSULT_STATE_NAME, target)}」（由收款单 ${row.order_no} 触发）${
          Number(plans[0].pending_amount) > 0 ? `，待缴 ¥${pendingYuan} 继续收取` : ''
        }`,
      });
      // 分期首付到账也算转正 → 学籍一起走
      await syncClassOnFormal(target);
    }
    return; // 分期走自己的口径，不再走下面「全部到账」的判断
  }

  if (row.fee_type === FeeType.TRIAL_FEE) {
    if (cur === ConsultState.TRIAL_FEE_PENDING) {
      target = ConsultState.TRIAL_WAIT_CLASS;
      gate = '试学费已到账';
    }
  } else if (Number(row.fee_type) === FeeType.SUPPLEMENT) {
    /**
     * ★ 2026-10-20 补费到账 → 试学转正
     *
     * 用户口径：试学结束由班主任（或咨询老师）发起补费，补缴到账就转正式。
     * 补费单不属于 FULL_FEE_TYPES，所以不能走下面「全款全部到齐」的判断
     * （那样会永远不成立，钱到了状态不动）。
     *
     * 落点与学费到账同口径：没分班先「待分班」，有班直接「正式在读」。
     */
    if (
      cur === ConsultState.TRIAL_FEE_PENDING ||
      cur === ConsultState.FULL_FEE_PENDING ||
      cur === ConsultState.TRIAL_WAIT_CLASS ||
      cur === ConsultState.TRIAL
    ) {
      if (!stu.class_id) {
        target = ConsultState.TRIAL_WAIT_CLASS;
        gate = '补费已到账，待分配班级';
      } else {
        target = ConsultState.FORMAL;
        gate = '补费已到账';
      }
    }
  } else if (FULL_FEE_TYPES.includes(row.fee_type)) {
    if (
      // ★ 2026-10-20 用户口径「交完试学费或学费就分配班级」：
      //   学生可能不交试学费、直接一次性交正式学费（此时还在「咨询中」），
      //   原来漏了这一档，钱到了状态却不动。现在一并纳入。
      cur === ConsultState.TRIAL_FEE_PENDING ||
      cur === ConsultState.FULL_FEE_PENDING ||
      cur === ConsultState.TRIAL_WAIT_CLASS ||
      cur === ConsultState.TRIAL
    ) {
      // 全款口径：该学生所有全款费用单全部到账才往下走
      const rows = await db(FEE_ORDER_TABLE)
        .where({ consult_student_id: row.consult_student_id, is_deleted: false })
        .whereIn('fee_type', FULL_FEE_TYPES)
        .whereNotIn('status', [CFS.ARRIVED]);
      const unpaidLeft = rows.filter((r: any) => r.id !== row.id).length;
      if (unpaidLeft === 0) {
        /* ★ 2026-10-20 交完学费先分班，再转正式
         *
         *   用户口径：「交完试学费或学费就分配班级」——学费到账后学生同样要
         *   走「待分班」，分完班才落「正式在读」。原来直接跳 FORMAL，
         *   会出现「正式在读但没班」的脏状态（分配班级按钮还得靠兜底显示）。
         */
        if (!stu.class_id) {
          target = ConsultState.TRIAL_WAIT_CLASS;
          gate = '全款费用已全部到账，待分配班级';
        } else {
          target = ConsultState.FORMAL;
          gate = '全款费用已全部到账';
        }
      }
    }
  }

  if (!target || target === cur) return;

  await changeState(row.consult_student_id, target, {
    byName: '财务模块',
    byTitle: '系统',
    action: 'FEE_ARRIVED_STATE',
    historyText: `${gate}，学生状态流转为「${nameOf(CONSULT_STATE_NAME, target)}」（由收款单 ${row.order_no} 触发）`,
  });

  // ★ 2026-10-20 试学闭环：补费到账转正式 → 班级学籍同步为「正式在读」
  await syncClassOnFormal(target);
}

/* ============================================================
 * 查询
 * ============================================================ */

/**
 * 构造列表查询
 *
 * @param scopedStudentIds ★ 2026-10-16 数据范围（咨询师只看自己名下学生的收款单）；
 *                          传 null / 不传 = 不限；传空数组 = 一条都看不到。
 */
export function buildOrderQuery(q: any, scopedStudentIds?: string[] | null) {
  const query = db(FEE_ORDER_TABLE).where('is_deleted', false);

  if (Array.isArray(scopedStudentIds)) {
    query.whereIn('consult_student_id', scopedStudentIds.length ? scopedStudentIds : ['__none__']);
  }

  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.className) query.andWhere('class_name', 'like', `%${q.className}%`);
  if (q.feeType) query.andWhere('fee_type', q.feeType);
  if (q.status !== undefined && q.status !== null && q.status !== '') {
    query.andWhere('status', q.status);
  }
  if (q.ownerName) {
    // 按跟进人筛选：先查学生 id
    query.whereIn(
      'consult_student_id',
      db('t_consult_student').select('id').where('owner_name', 'like', `%${q.ownerName}%`).where('is_deleted', false),
    );
  }
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_name', 'like', `%${q.keyword}%`)
        .orWhere('order_no', 'like', `%${q.keyword}%`)
        .orWhere('student_no', 'like', `%${q.keyword}%`)
        .orWhere('class_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/** 统计（列表页 4 张卡） */
export async function getFeeStats(
  q: any = {},
  scopedStudentIds?: string[] | null,
): Promise<ConsultFeeStats> {
  const rows: any[] = await buildOrderQuery(q, scopedStudentIds).select(
    'status',
    'amount',
    'voucher_url',
  );

  const stat = (st: number) => rows.filter((r) => r.status === st);
  const sum = (list: any[]) => list.reduce((a, b) => a + Number(b.amount || 0), 0);

  return {
    pendingCount: stat(CFS.PENDING).length,
    pendingAmount: sum(stat(CFS.PENDING)),
    arrivedCount: stat(CFS.ARRIVED).length,
    arrivedAmount: sum(stat(CFS.ARRIVED)),
    rejectedCount: stat(CFS.REJECTED).length,
    voucherCount: rows.filter((r) => !!r.voucher_url).length,
  };
}

/** 查某学生的费用统计（学生列表页显示「已到账 N · 待确认 M」） */
export async function getStudentFeeStatMap(
  studentIds: string[],
): Promise<Record<string, { paid: number; pending: number }>> {
  if (!studentIds.length) return {};
  const rows: any[] = await db(FEE_ORDER_TABLE)
    .where('is_deleted', false)
    .whereIn('consult_student_id', studentIds)
    .select('consult_student_id', 'status');

  const map: Record<string, { paid: number; pending: number }> = {};
  for (const r of rows) {
    const key = r.consult_student_id;
    if (!map[key]) map[key] = { paid: 0, pending: 0 };
    if (r.status === CFS.ARRIVED) map[key].paid++;
    else if (r.status === CFS.NO_VOUCHER || r.status === CFS.PENDING) map[key].pending++;
  }
  return map;
}

/** 取某学生「已到账」的试学费合计（退费算钱用） */
export async function getArrivedTrialIncome(consultStudentId: string): Promise<number> {
  const row: any = await db(FEE_ORDER_TABLE)
    .where({
      consult_student_id: consultStudentId,
      fee_type: FeeType.TRIAL_FEE,
      status: CFS.ARRIVED,
      is_deleted: false,
    })
    .sum({ total: 'amount' })
    .first();
  return Number(row?.total || 0);
}

/** 检查某学生是否所有全款费用都已到账（转正式判定用） */
export async function checkFullFeeArrived(
  consultStudentId: string,
  fullFeeTypes: FeeType[],
): Promise<{ allArrived: boolean; missing: FeeType[] }> {
  const rows: any[] = await db(FEE_ORDER_TABLE)
    .where({
      consult_student_id: consultStudentId,
      status: CFS.ARRIVED,
      is_deleted: false,
    })
    .whereIn('fee_type', fullFeeTypes)
    .select('fee_type');

  const arrivedTypes = new Set(rows.map((r) => r.fee_type));
  const missing = fullFeeTypes.filter((t) => !arrivedTypes.has(t));
  return { allArrived: missing.length === 0, missing };
}

/**
 * 全款（学费 / 住宿 / 餐费 / 保险）是否已缴清
 *
 * ★ 2026-10-20：班主任接收建档时，学籍落「试学中」还是「正式在读」要看钱交到哪一步。
 *   - 只交试学费            → 试学中
 *   - 学费等全款已到账      → 正式在读（不用再点「转正式」）
 *   - 分期（计划含非试学费项）→ 按「首付到账即可」口径，视为已缴清
 *     （与 `advanceStudentStateOnArrival` 的到账流转判断保持一致）
 *
 * ⚠️ 不能直接用 `checkFullFeeArrived` —— 它要求 4 类费用全齐，
 *    只交了学费（住宿/餐费还没收）的学生会永远返回 false。
 */
export async function isFullFeeSettled(consultStudentId: string): Promise<boolean> {
  const plan: any = await db('t_consult_installment_plan')
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .whereNot('status', 3) // 3 = TERMINATED
    .first();
  if (plan) {
    const detail = parseOrderItemDetail(plan.item_detail);
    if (detail.some((d: any) => Number(d.feeType) !== FeeType.TRIAL_FEE)) return true;
  }

  const rows: any[] = await db(FEE_ORDER_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .whereIn('fee_type', FULL_FEE_TYPES);
  if (!rows.length) return false;
  return rows.every((r) => Number(r.status) === CFS.ARRIVED);
}

/* ============================================================
 * ⭐ 补缴明细统计（流程图：「咨询老师统计补缴金额和类型」）
 *
 * 背景（对应流程图「是否一次性付清学费 → 否」这条分支）：
 *   学生试学后决定转正式，但不是所有费用都一次交清。
 *   咨询老师需要先知道「还差多少、差哪几项、各项现在什么状态」，
 *   才能勾选本次要缴哪几笔，逐笔走财务。
 *
 * 数据来源：
 *   · 应缴金额 —— 调财务费用标准（规则2，不自己算）
 *   · 已缴状态 —— 以财务侧 payStatus 为准（syncFromFinance 已回写过）
 *
 * ⚠️ 为什么每个类型只看「最新一笔」？
 *    同一类型可能被驳回后重发，历史单会留痕。
 *    判断缺口应以最新一张单的状态为准，否则「已驳回的旧单」会误算成未发起。
 * ============================================================ */
export async function getSupplementPlan(
  consultStudentId: string,
  fullFeeTypes: FeeType[] = FULL_FEE_TYPES,
): Promise<ConsultSupplementPlan> {
  const stu = await findStudent(consultStudentId);
  if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

  const deptCode: DeptCode = stu.dept_code || DeptCode.JUNIOR_SENIOR;

  // ---- 1. 取全部应缴类型的最新一张单 ----
  //
  // ⚠️ 这里【不能】过滤 status = NO_VOUCHER（待上传凭证）。
  //    曾经的写法是 .whereNot({ status: CFS.NO_VOUCHER })，本意是「还没传凭证的草稿不算已发起」，
  //    但建单接口 createFees 建出来的单初始状态就是 NO_VOUCHER（财务侧还没有这张单，
  //    要等老师传了截图才会变成 PENDING）。
  //    结果：刚发起过的单在缺口计算里被当成「没发起」→ 同一类型可以被重复建单。
  //    正确做法是【所有在途单都算已发起】，用状态决定它属于「已到账 / 待确认 / 待上传凭证 / 已驳回」。
  const rows: any[] = await db(FEE_ORDER_TABLE)
    .where({ consult_student_id: consultStudentId, is_deleted: false })
    .orderBy('create_time', 'desc');

  const latestMap = new Map<number, any>();
  for (const r of rows) {
    if (!fullFeeTypes.includes(Number(r.fee_type))) continue;
    if (!latestMap.has(r.fee_type)) latestMap.set(r.fee_type, r);
  }

  /**
   * ★ 2026-10-15 合并缴费单（一张单覆盖多项费用）也要参与缺口计算。
   *
   *   合并单的 fee_type 只记「主类型」（如学费），但它的 item_detail 里
   *   还挂着住宿费 / 餐费 / 保险等。只看 fee_type 的话，这些类型会被判成
   *   「未发起」→ 转正式时要求老师再缴一遍，属于重复收费。
   *
   *   所以这里把 item_detail 解析出来，按里面的类型登记状态。
   */
  const comboMap = new Map<
    number,
    { status: number; amount: number; createTime: Date | string }
  >();
  for (const r of rows) {
    if (!r.item_detail) continue;
    let detail: Array<{ feeType: number; amount: number }> = [];
    try {
      detail = JSON.parse(r.item_detail);
    } catch {
      continue; // 脏数据：解析不了就当没有，不影响主流程
    }
    for (const it of detail) {
      if (!it?.feeType || !fullFeeTypes.includes(Number(it.feeType))) continue;
      const prev = comboMap.get(Number(it.feeType));
      // 同类型被多张合并单覆盖时，取最新的那张
      if (!prev) {
        comboMap.set(Number(it.feeType), {
          status: Number(r.status),
          amount: Number(it.amount || 0),
          createTime: r.create_time,
        });
      }
    }
  }

  /** 状态"好坏"排序：到账 > 在途 > 驳回 > 未发起 */
  const STATE_RANK: Record<string, number> = {
    NOT_STARTED: 0,
    REJECTED: 1,
    PENDING: 2,
    ARRIVED: 3,
  };

  function stateOf(status?: number): ConsultSupplementPlan['items'][number]['state'] {
    if (status === undefined || status === null) return 'NOT_STARTED';
    if (status === CFS.ARRIVED) return 'ARRIVED';
    if (status === CFS.PENDING || status === CFS.NO_VOUCHER) return 'PENDING';
    if (status === CFS.REJECTED) return 'REJECTED';
    return 'NOT_STARTED';
  }

  // ---- 2. 逐类型取财务标准金额 ----
  const items: ConsultSupplementPlan['items'] = [];
  let totalAmount = 0;
  let arrivedAmount = 0;

  for (const feeType of fullFeeTypes) {
    const feeTypeName = nameOf(FEE_TYPE_NAME, feeType);
    const latest = latestMap.get(feeType);

    // ⚠️ 金额一律取财务标准（规则2）；取不到就用该单已落库的金额兜底
    let amount = latest?.amount ?? 0;
    try {
      const std = await financeClient.getStandard(feeType, deptCode);
      amount = std.amount;
    } catch {
      // 财务不可达时用本地快照，不阻断「统计缺口」这个读操作
    }

    let state: ConsultSupplementPlan['items'][number]['state'] = 'NOT_STARTED';
    if (latest) {
      if (latest.status === CFS.ARRIVED) state = 'ARRIVED';
      // ⚠️ NO_VOUCHER 归到 PENDING：
      //    单已建到财务侧、只是还没传截图，语义上就是「在途/待确认」，
      //    不能当成 NOT_STARTED，否则会被判成缺口而重复建单。
      else if (latest.status === CFS.NO_VOUCHER) state = 'PENDING';
      else if (latest.status === CFS.PENDING) state = 'PENDING';
      else if (latest.status === CFS.REJECTED) state = 'REJECTED';
    }

    // ★ 合并单里也缴了这一类型 → 取两个来源里"更好"的那个状态
    const combo = comboMap.get(Number(feeType));
    if (combo) {
      const comboState = stateOf(combo.status);
      if (STATE_RANK[comboState] > STATE_RANK[state]) {
        state = comboState;
        // 金额用明细里实际收的（合并单可能手改过）
        if (combo.amount > 0) amount = combo.amount;
      }
    }

    totalAmount += amount;
    if (state === 'ARRIVED') arrivedAmount += amount;

    items.push({
      feeType,
      feeTypeName,
      amount,
      state,
      stateName: SUPPLEMENT_STATE_NAME[state],
    });
  }

  /*
   * ⚠️ 什么算「缺口」（可以再次发起）？
   *    · NOT_STARTED → 从没发起过            → 是缺口
   *    · REJECTED    → 被财务打回，需重新提交 → 是缺口
   *    · PENDING     → 在途（含待上传凭证）   → 【不是】缺口，禁止重复建单
   *    · ARRIVED     → 已到账                 → 不是缺口
   */
  const arrivedCount = items.filter((i) => i.state === 'ARRIVED').length;
  const inFlight = items.filter((i) => i.state === 'PENDING');
  const missing = items
    .filter((i) => i.state === 'NOT_STARTED' || i.state === 'REJECTED')
    .map((i) => i.feeType);
  const missingAmount = items
    .filter((i) => i.state === 'NOT_STARTED' || i.state === 'REJECTED')
    .reduce((a, b) => a + b.amount, 0);
  /** 在途金额（已发起、等财务确认），前端可提示「另有 X 元在途」 */
  const inFlightAmount = inFlight.reduce((a, b) => a + b.amount, 0);

  return {
    consultStudentId,
    totalAmount,
    items,
    missing,
    missingAmount,
    arrivedAmount,
    inFlightAmount,
    // 「全款到齐」= 每一类都已到账（在途不算，否则会在还没到账时就禁止补缴）
    allArrived: arrivedCount === items.length,
    isPartial: arrivedAmount > 0 && (missing.length > 0 || inFlight.length > 0),
  };
}
