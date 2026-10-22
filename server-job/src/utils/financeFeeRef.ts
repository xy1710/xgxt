/**
 * 学生缴费记录 · 统一取数（★ 2026-10-06）
 *
 * ============================================================
 * 【为什么有它】用户需求：把「初高中数据 / 大学部 / 实训」三处信息详情里的
 *   缴费情况，统一与【财务管理 · 缴费管理】对齐，记录该学员实际缴纳的费用。
 * ============================================================
 *   改造前三个模块各看各的，同一笔钱三个样：
 *     · 初高（教学管理）  → sms_class_jh.t_class_fee（本地台账，从没跟财务同步过）
 *     · 大学部（班级管理）→ sms_common.t_class_fee_sync（财务推的只读副本）✅
 *     · 实训（就业管理）  → 调 `${FINANCE}/api/finance/payment/list`，
 *                          该路径在财务模块里根本不存在 → 永远降级「未接入」
 *
 * 【取数策略】用户 2026-10-06 拍板：**实时为主 + 副本兜底**
 *   1. 实时：直接按学号查财务 `sms_finance.t_finance_fee`（同实例跨库，
 *      合并成单体后三个模块共用一个 MySQL，不必再走 HTTP 绕一圈）
 *   2. 兜底：财务查不到 / 查询异常时，回落到该模块的只读副本，
 *      并在返回值里标 `degraded = true`，让前端能提示「以下为上次同步数据」
 *
 * 【展示口径】三处详情共用本文件的文案映射（状态 / 类型 / 部门），
 *   保证同一笔费用在初高、大学部、实训看到的字一模一样。
 *
 * ⚠️ 本文件只读，不写任何缴费数据；钱的写入一律在财务管理模块。
 */

import { db } from './db';
// ★ 统一表切读层：JH_FEE_TABLE / COMMON_FEE_TABLE 已归一（都映射到 t_uni_fee），
//   改用 tbl() 路由；FINANCE_FEE_TABLE（sms_finance）未归一，保持裸 db() 访问。
import { tbl } from '../teaching/shared/uniTable';

/** 财务管理 · 缴费单表（实时的权威源）—— sms_finance 未归一，保持裸访问 */
const FINANCE_FEE_TABLE = 'sms_finance.t_finance_fee';
/** 初高的缴费台账（兜底副本，由 finance/services/class-sync.ts 推送）—— 已归一 */
const JH_DB = 'sms_class_jh';
const JH_STAGE = 'jh' as const;
const JH_FEE_TABLE = 't_class_fee';
/** 班级管理（大学部）的缴费同步副本（需求三既有链路）—— 已归一 */
const COMMON_DB = 'sms_common';
const COMMON_STAGE = 'class' as const;
const COMMON_FEE_TABLE = 't_class_fee_sync';

/**
 * 部门 —— 与财务 DeptCode 数值一致。
 * ⚠️ 财务前端把这个 1 显示成「二三期」（历史叫法），本文件统一沿用，
 *    避免三个模块各叫各的（初高部 / 二三期）。
 */
export const DEPT_TEXT: Record<number, string> = {
  1: '二三期',
  2: '大学部',
};

/** 缴费类型文案（与财务 / 初高 / 班级三套枚举的数值契约一致） */
export const FEE_TYPE_TEXT: Record<number, string> = {
  1: '学费',
  2: '住宿费',
  3: '餐费',
  4: '保险费',
  5: '试学费',
};

/**
 * 缴费状态文案 —— **统一口径**（★ 2026-10-06）
 *
 * ⚠️ 这个映射是三处详情「显示一致」的关键：
 *    财务侧 2 = 待核对、3 = 已缴；初高/班级侧 2 = 已缴、3 = 已核对。
 *    数值契约一样，只是叫法不同。这里折中成一套人人都看得懂的文案，
 *    并保留财务的核对语义（2 还没核对 / 3 已核对入账）。
 */
export const FEE_STATUS_TEXT: Record<number, string> = {
  1: '待缴',
  2: '已缴（待核对）',
  3: '已缴（已核对）',
  5: '冻结',
};

/** 「钱已经收到」的状态：2/3 都算已缴，1/4 未收到，5 冻结按未收 */
export function isPaidStatus(status: number): boolean {
  return status === 2 || status === 3;
}

/** 统一的学生缴费记录 DTO（三处详情共用） */
export interface StudentFeeRecord {
  /** 记录主键（财务侧为 t_finance_fee.id；兜底时为副本行 id） */
  feeId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  /** 部门 1 二三期(初高部) / 2 大学部 */
  deptCode: number | null;
  deptName: string;
  feeType: number;
  feeTypeName: string;
  /** 费用周期（财务侧 period，如 2026-09） */
  period: string | null;
  /** 应缴（分） */
  amount: number;
  /** 已缴（分） */
  paidAmount: number;
  amountYuan: string;
  paidAmountYuan: string;
  unpaidAmountYuan: string;
  payStatus: number;
  payStatusName: string;
  payDate: string | null;
  expireDate: string | null;
  payMethod: string | null;
  voucherUrl: string | null;
}

/** 兜底副本的来源标记 */
export type FeeMirrorFrom = 'class-jh' | 'class';

export interface StudentFeeResult {
  studentNo: string;
  /** 'finance' = 实时取自财务管理；'mirror' = 财务不可用，走只读副本 */
  source: 'finance' | 'mirror';
  /** 走副本时，数据来自哪个模块的副本表 */
  mirrorFrom?: FeeMirrorFrom;
  /** true = 本次未取到实时数据，页面应提示「可能不是最新」 */
  degraded: boolean;
  message?: string;
  records: StudentFeeRecord[];
}

/** 日期统一成 YYYY-MM-DD（库里的 date 可能是 Date / 字符串） */
function dateOnly(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 分 → 元（两位小数字符串） */
function yuan(fen: number): string {
  return (Number(fen || 0) / 100).toFixed(2);
}

/** 组装统一 DTO（入参字段名各不相同，这里做一次归一） */
function toRecord(src: {
  feeId: string;
  studentNo?: string | null;
  studentName?: string | null;
  classId?: string | null;
  className?: string | null;
  deptCode?: number | null;
  feeType?: number | null;
  period?: string | null;
  amount?: number | null;
  paidAmount?: number | null;
  payStatus?: number | null;
  payDate?: any;
  expireDate?: any;
  payMethod?: string | null;
  voucherUrl?: string | null;
}): StudentFeeRecord {
  const feeType = Number(src.feeType ?? 0);
  const amount = Number(src.amount ?? 0);
  const payStatus = Number(src.payStatus ?? 1);
  // 2/3 都表示钱已收到；其余按未收到算（与 finance/services/class-sync.ts 同口径）
  const paidAmount = src.paidAmount == null
    ? (isPaidStatus(payStatus) ? amount : 0)
    : Number(src.paidAmount);
  const deptCode = src.deptCode == null ? null : Number(src.deptCode);

  return {
    feeId: String(src.feeId),
    studentNo: src.studentNo ?? '',
    studentName: src.studentName ?? '',
    classId: src.classId ?? null,
    className: src.className ?? null,
    deptCode,
    deptName: deptCode == null ? '—' : DEPT_TEXT[deptCode] ?? `部门${deptCode}`,
    feeType,
    feeTypeName: FEE_TYPE_TEXT[feeType] ?? `类型${feeType}`,
    period: src.period ?? null,
    amount,
    paidAmount,
    amountYuan: yuan(amount),
    paidAmountYuan: yuan(paidAmount),
    unpaidAmountYuan: yuan(Math.max(amount - paidAmount, 0)),
    payStatus,
    payStatusName: FEE_STATUS_TEXT[payStatus] ?? `状态${payStatus}`,
    payDate: dateOnly(src.payDate),
    expireDate: dateOnly(src.expireDate),
    payMethod: src.payMethod ?? null,
    voucherUrl: src.voucherUrl ?? null,
  };
}

/**
 * 按学号取某学员的缴费记录（实时优先）
 *
 * @param studentNo 学号（跨模块认人**只用学号**，各库学生主键是不同 uuid）
 * @param options.mirror 兜底副本走哪张表：
 *        'class-jh' = 初高台账 / 'class' = 大学部共享副本 / 'none' = 不兜底
 */
export async function fetchStudentFeeRecords(
  studentNo: string,
  options: { mirror?: FeeMirrorFrom | 'none' } = {},
): Promise<StudentFeeResult> {
  const no = String(studentNo || '').trim();
  const mirror = options.mirror ?? 'class';

  if (!no) {
    return { studentNo: '', source: 'finance', degraded: false, records: [] };
  }

  // ---------- 1) 实时：财务管理 ----------
  /** 财务库这一轮查通了吗（查到 0 条也算通）——用来区分「财务不可用」和「财务确实没记录」 */
  let liveOk = false;
  try {
    const rows = (await db(FINANCE_FEE_TABLE)
      .where({ student_no: no, is_deleted: false })
      .orderBy('pay_date', 'desc')
      .orderBy('create_time', 'desc')) as Array<Record<string, any>>;

    liveOk = true;

    if (rows.length) {
      return {
        studentNo: no,
        source: 'finance',
        degraded: false,
        records: rows.map((r) =>
          toRecord({
            feeId: r.id,
            studentNo: r.student_no,
            studentName: r.student_name,
            classId: r.class_id,
            className: r.class_name,
            deptCode: r.dept_code,
            feeType: r.fee_type,
            period: r.period,
            amount: r.amount,
            // 财务表没有 paid_amount 列，金额是否收到由 pay_status 表达
            paidAmount: null,
            payStatus: r.pay_status,
            payDate: r.pay_date,
            expireDate: r.expire_date,
            payMethod: null,
            voucherUrl: r.voucher_url,
          }),
        ),
      };
    }
    // 查到 0 条：继续往下走副本兜底（财务库可能还没建/没导数据）
  } catch {
    // 财务库不可达（未建库 / 无权限 / 连接异常）→ 兜底
  }

  // ---------- 2) 兜底：只读副本 ----------
  if (mirror === 'none') {
    return {
      studentNo: no,
      source: 'mirror',
      degraded: true,
      message: '财务管理暂不可用，且本模块未配置兜底副本',
      records: [],
    };
  }

  try {
    if (mirror === 'class-jh') {
      const base = tbl(db, JH_DB, JH_FEE_TABLE, JH_STAGE).where({ student_no: no, is_deleted: false });
      // 优先用财务推过来的行；一条都没有才退回本地台账（避免与种子数据重复展示）
      const synced = (await base
        .clone()
        .where({ source_system: 'finance' })
        .orderBy('pay_date', 'desc')) as Array<Record<string, any>>;
      const rows = synced.length
        ? synced
        : ((await base.clone().orderBy('pay_date', 'desc')) as Array<Record<string, any>>);

      return {
        studentNo: no,
        source: 'mirror',
        mirrorFrom: 'class-jh',
        degraded: true,
        message: '财务管理暂不可用，以下为教学管理（初高）最近一次同步的缴费记录',
        records: rows.map((r) =>
          toRecord({
            feeId: r.id,
            studentNo: r.student_no,
            studentName: r.student_name,
            classId: r.class_id,
            className: r.class_name,
            deptCode: r.dept_code,
            feeType: r.fee_type,
            period: r.period,
            amount: r.fee_amount,
            paidAmount: null,
            payStatus: r.pay_status,
            payDate: r.pay_date,
            expireDate: r.expire_date,
            payMethod: null,
            voucherUrl: r.voucher_url,
          }),
        ),
      };
    }

    // 大学部 / 实训：共享副本 sms_common.t_class_fee_sync
    const rows = (await tbl(db, COMMON_DB, COMMON_FEE_TABLE, COMMON_STAGE)
      .where({ student_no: no, is_deleted: false })
      .orderBy('pay_date', 'desc')) as Array<Record<string, any>>;

    return {
      studentNo: no,
      source: 'mirror',
      mirrorFrom: 'class',
      degraded: rows.length > 0,
      message: rows.length
        ? liveOk
          ? '财务管理暂无该学员的缴费记录，以下为班级管理台账中的历史记录'
          : '财务管理暂不可用，以下为最近一次同步的缴费记录'
        : undefined,
      records: rows.map((r) =>
        toRecord({
          feeId: r.id,
          studentNo: r.student_no,
          studentName: r.student_name,
          classId: r.class_id,
          className: r.class_name,
          deptCode: r.dept_code,
          feeType: r.fee_type,
          period: r.period,
          amount: r.amount,
          paidAmount: r.paid_amount,
          payStatus: r.pay_status,
          payDate: r.pay_date,
          expireDate: r.expire_date,
          payMethod: r.pay_method,
          voucherUrl: r.voucher_url,
        }),
      ),
    };
  } catch {
    return {
      studentNo: no,
      source: 'mirror',
      degraded: !liveOk,
      message: liveOk ? undefined : '财务管理与本地副本均暂不可用',
      records: [],
    };
  }
}

/** 汇总（应缴 / 已缴 / 待缴），三处详情顶部 KPI 共用同一算法 */
export function summarizeFees(records: StudentFeeRecord[]) {
  let amount = 0;
  let paid = 0;
  for (const r of records) {
    amount += r.amount;
    paid += r.paidAmount;
  }
  return {
    totalAmount: amount,
    totalPaid: paid,
    totalUnpaid: Math.max(amount - paid, 0),
    totalAmountYuan: yuan(amount),
    totalPaidYuan: yuan(paid),
    totalUnpaidYuan: yuan(Math.max(amount - paid, 0)),
  };
}
