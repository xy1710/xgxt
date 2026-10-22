/**
 * 账单明细 · 业务逻辑
 * 负责人：周铭（财务管理）
 *
 * ⚠️ 这张表是「账本」：
 *    缴费核对通过 → 写一条缴费账单（bill_type=1，号 ZD 开头）
 *    退费出款完成 → 写一条退费账单（bill_type=2，号 ZT 开头）
 *
 *    它是财务模块的「唯一事实来源」——
 *    状态字段可能被别人改，但账单一旦写入就不再变（财务凭证的特性）。
 */

import { db } from '../utils/db';
import {
  FEE_TYPE_NAME,
  DEPT_NAME,
  BILL_TYPE_NAME,
  FeeType,
  PayStatus,
  RefundStatus,
  StudentStatus,
} from 'shared-types/finance';
import { toDateStr, FEE_TABLE, isTempStudentNo } from './fee.service';
import { REFUND_TABLE } from './refund.service';
import { FREEZE_TABLE } from './freeze.service';

export const BILL_TABLE = 't_finance_bill';

/** 账单行 → 前端契约格式 */
export function toBillListItem(r: any) {
  return {
    id: r.id,
    billNo: r.bill_no,
    billType: r.bill_type,
    billTypeName: BILL_TYPE_NAME[r.bill_type] || '',
    sourceId: r.source_id,
    sourceNo: r.source_no ?? undefined,
    studentId: r.student_id,
    // ★ 2026-10-22 未分班（只有 ZX 临时号）→ 学号留空，前端显示「—」
    studentNo: isTempStudentNo(r.student_no) ? '' : r.student_no,
    studentName: r.student_name,
    classId: r.class_id ?? undefined,
    className: r.class_name ?? undefined,
    deptCode: r.dept_code ?? undefined,
    deptName: r.dept_code ? DEPT_NAME[r.dept_code] : undefined,
    headTeacherName: r.head_teacher_name ?? undefined,
    feeType: r.fee_type,
    feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
    amount: Number(r.amount),
    billDate: toDateStr(r.bill_date) || '',
    operatorName: r.operator_name ?? undefined,
    voucherNo: r.voucher_no ?? undefined,
    remark: r.remark ?? undefined,
  };
}

/** 构造列表查询条件 */
export function buildBillQuery(q: any) {
  const query = db(BILL_TABLE).where('is_deleted', false);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.billType) query.andWhere('bill_type', q.billType);
  if (q.feeType) query.andWhere('fee_type', q.feeType);
  if (q.operatorName) query.andWhere('operator_name', 'like', `%${q.operatorName}%`);
  if (q.startDate) query.andWhere('bill_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('bill_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`)
        .orWhere('bill_no', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/* ============================================================
 * 账单明细 · 按学员归集（原型「账单明细 / 缴费明细」口径）
 *
 * ⚠️ 与上面的「流水列表」是两种视角：
 *    流水列表 = 一行一笔账单（对账用）
 *    按学员   = 一行一个学员（看某个学员一共交了哪些费，看凭证用）
 *
 * ⭐ 原型规则（学管财务管理原型-20260923/index.html:RENDER['bill-pay']）：
 *    1) 列表按学员归集，显示 学号/姓名/班级/手机号
 *       + 四类列（学费/餐费/住宿费/保险费）各自的【金额 + 笔数 + 最近日期】
 *    2) 点「详情」→ 展开四类分组（默认全部折叠）
 *    3) 点某个分组 → 展开该组【每一笔】缴费记录：类型 + 金额 + 日期 + 凭证号 + 「查看凭证」
 * ============================================================ */

/** 五类分组的定义（key 与前端 BillFeeGroupKey 对齐） */
const BILL_GROUPS: { key: string; name: string; types: number[] }[] = [
  // ⚠️ 试学费(5) 并入学费组：原型里「正式学费」「试学学费」都挂在「学费缴费记录」下
  //
  // ★ 2026-10-22 用户口径：学费组包含三类 —— 正式学费(1)、补费(8)、试学费(5)
  //    补费(SUPPLEMENT) 原先是试学转正尾款/差额补收，金额老师自定义；
  //    它属于学费性质，必须进「学费缴费记录」，否则账单会「计入总额但不进四列」，
  //    导致四项之和 ≠ 总额，对账时对不上。
  {
    key: 'tuition',
    name: '学费缴费记录',
    types: [FeeType.TUITION, FeeType.SUPPLEMENT, FeeType.TRIAL_FEE],
  },
  { key: 'meal', name: '餐费缴费记录', types: [FeeType.MEAL] },
  { key: 'dorm', name: '住宿费缴费记录', types: [FeeType.ACCOMMODATION] },
  { key: 'insurance', name: '保险费缴费记录', types: [FeeType.INSURANCE] },
  // ★ 2026-10-22 用户口径：押金(6) + 校服(7) 单独成组，统一叫「杂费」
  //    这两类不并入学费（不是学费性质），也不再无处可归。
  { key: 'other', name: '杂费缴费记录', types: [FeeType.DEPOSIT, FeeType.UNIFORM] },
];

/** 空分组（没有记录时也要返回，保证前端四列不缺格） */
function emptyGroup(name: string) {
  return { name, count: 0, amount: 0, latestDate: undefined as string | undefined, records: [] as any[] };
}

/**
 * 构造「按学员归集」的筛选条件。
 *
 * 💡 只取 bill_type = 1（缴费账单）。退费是另一条线（账单明细/退费明细），
 *    不混进「每个学生缴了哪些费」这本账里。
 */
function buildBillStudentQuery(q: any) {
  const query = db(BILL_TABLE).where('is_deleted', false).where('bill_type', 1);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.startDate) query.andWhere('bill_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('bill_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`)
        .orWhere('bill_no', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/** 某一类费用下的单笔缴费记录 */
export interface BillFeeRecordOut {
  billNo: string;
  feeTypeName: string;
  amount: number;
  date: string;
  voucherNo?: string;
  voucherUrl?: string;
  voucherBy?: string;
  voucherAt?: string;
  sourceNo?: string;
  operatorName?: string;
}

/**
 * 账单明细 · 按学员归集（分页）
 *
 * ⚠️ 分页必须按【学员】分页，不能按账单分页后再归集，
 *    否则会出现「同一个学生被拆到两页」的错乱。
 *    做法：先查出符合条件的全部账单 → 按 student_id 归集 → 对学员数组切片。
 *
 * ⚠️⚠️ 凭证图片在【缴费单表】上，不在账单表上！
 *    账单表只有 voucher_no（凭证编号）。要显示凭证原件，
 *    必须用 bill.source_id 回查 t_finance_fee.voucher_url。
 *    所以这里一次性把关联的缴费单查出来做成 map，避免 N+1 查询。
 *
 * 💡 数据量评估：这是财务账本，单个机构一学年的缴费账单在千级，
 *    一次全查 + 内存归集完全够用，且比 SQL 多表聚合更好维护。
 *    真到万级以上再改成 SQL GROUP BY + 明细二次查询。
 */
export async function listBillStudents(q: any): Promise<{ rows: any[]; total: number }> {
  const bills: any[] = await buildBillStudentQuery(q).select('*').orderBy('bill_date', 'desc');

  // ---- 一次性把关联的缴费单查出来（拿 voucher_url / 上传人 / 上传时间）----
  const sourceIds: string[] = [...new Set(bills.map((b: any) => b.source_id).filter(Boolean))] as string[];
  const feeMap = new Map<string, any>();
  if (sourceIds.length) {
    const fees = await db(FEE_TABLE)
      .whereIn('id', sourceIds)
      .select('id', 'voucher_url', 'voucher_no', 'voucher_by', 'voucher_time');
    for (const f of fees as any[]) feeMap.set(f.id, f);
  }

  const map = new Map<string, any>();

  for (const b of bills) {
    const sid = b.student_id;
    let row = map.get(sid);
    if (!row) {
      row = {
        studentId: sid,
        studentNo: b.student_no,
        studentName: b.student_name,
        classId: b.class_id ?? undefined,
        className: b.class_name ?? undefined,
        deptCode: b.dept_code ?? undefined,
        deptName: b.dept_code ? DEPT_NAME[b.dept_code] : undefined,
        totalAmount: 0,
        totalCount: 0,
      };
      for (const g of BILL_GROUPS) row[g.key] = emptyGroup(g.name);
      map.set(sid, row);
    }

    // 学生信息取「最新一条」的非空值补齐（老数据可能有的字段空、有的不空）
    if (!row.className && b.class_name) row.className = b.class_name;
    if (!row.classId && b.class_id) row.classId = b.class_id;
    if (row.deptCode == null && b.dept_code != null) row.deptCode = Number(b.dept_code);
    if (!row.deptName && b.dept_code) row.deptName = DEPT_NAME[b.dept_code];

    // 归到对应分组
    const g = BILL_GROUPS.find((x) => x.types.includes(Number(b.fee_type)));
    const groupRow = g ? row[g.key] : null;
    const amount = Number(b.amount) || 0;
    const date = toDateStr(b.bill_date) || '';

    if (groupRow) {
      groupRow.count += 1;
      groupRow.amount += amount;
      if (date && (!groupRow.latestDate || date > groupRow.latestDate)) groupRow.latestDate = date;

      const fee: any = feeMap.get(b.source_id) || {};
      groupRow.records.push({
        billNo: b.bill_no,
        feeTypeName: FEE_TYPE_NAME[b.fee_type] || '',
        amount,
        date,
        voucherNo: b.voucher_no ?? fee.voucher_no ?? undefined,
        voucherUrl: fee.voucher_url ?? undefined,
        voucherBy: fee.voucher_by ?? undefined,
        voucherAt: fee.voucher_time ? toDateStr(fee.voucher_time) : undefined,
        sourceNo: b.source_no ?? undefined,
        operatorName: b.operator_name ?? undefined,
      } as BillFeeRecordOut);
    }

    row.totalAmount += amount;
    row.totalCount += 1;
  }

  // 组内明细按日期倒序（最新在前），与原型的「最近缴费」语义一致
  const list = [...map.values()].map((r) => {
    for (const g of BILL_GROUPS) {
      r[g.key].records.sort((a: any, b: any) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }
    return r;
  });

  // 学员排序：按最近有缴费的日期倒序（近期有往来的排前面），再按学号稳定
  const latestOf = (r: any) =>
    BILL_GROUPS.map((g) => r[g.key].latestDate || '').reduce((a, b) => (a > b ? a : b), '');
  list.sort((a, b) => {
    const la = latestOf(a);
    const lb = latestOf(b);
    if (la !== lb) return la < lb ? 1 : -1;
    return String(a.studentNo).localeCompare(String(b.studentNo));
  });

  const total = list.length;
  const start = (q.page - 1) * q.size;
  const rows = list.slice(start, start + q.size);

  return { rows, total };
}

/**
 * ★ 2026-10-21 学生档案 · 缴费记录（只读）
 *
 * 【为什么按学号查，不按学生 ID】
 *   学生在学段间流动（初高 → 大学 → 就业部）时每段的 student_id 都不一样，
 *   但学号不变。按 id 查会漏掉「上一段缴的钱」，按学号才是「这个人的全部缴费」。
 *
 * 【为什么复用 BILL_GROUPS】
 *   与财务「账单明细 · 按学员归集」用同一套分组（学费含试学费 / 餐费 / 住宿费 /
 *   保险费），两个页面看到的金额与笔数才对得上，不会各算一套。
 *
 * 💡 只取 bill_type=1（缴费）。退费是另一本账，不混进「缴了多少」。
 */
export async function listPaymentsByStudentNo(studentNo: string) {
  const no = String(studentNo || '').trim();
  const emptyGroups = () =>
    BILL_GROUPS.map((g) => ({
      key: g.key,
      name: g.name,
      count: 0,
      amount: 0,
      latestDate: null as string | null,
      records: [] as any[],
    }));
  const empty = (note: string | null) => ({
    groups: emptyGroups(),
    totalCount: 0,
    totalAmount: 0,
    latestDate: null as string | null,
    note,
  });

  if (!no) return empty('该生没有学号，无法关联财务账单');

  const bills: any[] = await db(BILL_TABLE)
    .where({ is_deleted: false, bill_type: 1, student_no: no })
    .orderBy('bill_date', 'desc')
    .orderBy('bill_no', 'desc');

  if (!bills.length) return empty('财务账单明细里还没有该学号的缴费记录');

  const groups = emptyGroups();
  const byKey = new Map(groups.map((g) => [g.key, g]));
  let totalAmount = 0;
  let latestDate: string | null = null;

  for (const b of bills) {
    const type = Number(b.fee_type);
    const g = BILL_GROUPS.find((x) => x.types.includes(type));
    if (!g) continue; // 押金等未归类的类型不进四类汇总（与财务账单明细同口径）

    const row = byKey.get(g.key)!;
    const amount = Number(b.amount) || 0;
    const date = toDateStr(b.bill_date) || '';
    row.count += 1;
    row.amount += amount;
    if (date && (!row.latestDate || date > row.latestDate)) row.latestDate = date;
    row.records.push({
      billNo: b.bill_no,
      feeTypeName: FEE_TYPE_NAME[type] || '',
      amount,
      date,
      voucherNo: b.voucher_no ?? null,
      operatorName: b.operator_name ?? null,
      remark: b.remark ?? null,
    });
    totalAmount += amount;
    if (date && (!latestDate || date > latestDate)) latestDate = date;
  }

  return {
    groups,
    totalCount: bills.length,
    totalAmount,
    latestDate,
    note: null as string | null,
  };
}

/**
 * 按学员归集的可见班级字典（部门 Tab 用）
 *
 * 💡 与缴费管理的 listFeeClasses 同思路：从账单表里把出现过的班级去重。
 *    账单表没有的班级（还没核对入账的）不该出现在这里 ——
 *    因为列表本来就看的是账单，下拉与列表必须同源，否则选了也查不到。
 */
export async function listBillClasses(deptCode?: number) {
  const query = db(BILL_TABLE)
    .where('is_deleted', false)
    .where('bill_type', 1)
    .whereNotNull('class_name')
    .whereNot('class_name', '');
  if (deptCode) query.andWhere('dept_code', deptCode);

  const rows = await query.select('class_name', 'class_id', 'dept_code');

  const map = new Map<string, { className: string; classId?: string; deptCode: number; count: number }>();
  for (const r of rows) {
    const name = String(r.class_name || '').trim();
    if (!name) continue;
    const hit = map.get(name);
    if (hit) {
      hit.count += 1;
      if (!hit.classId && r.class_id) hit.classId = r.class_id;
      continue;
    }
    map.set(name, {
      className: name,
      classId: r.class_id ?? undefined,
      deptCode: r.dept_code != null ? Number(r.dept_code) : 1,
      count: 1,
    });
  }

  return [...map.values()]
    .map((c) => ({
      className: c.className,
      classId: c.classId,
      deptCode: c.deptCode,
      deptName: DEPT_NAME[c.deptCode] || '',
      count: c.count,
    }))
    .sort((a, b) => a.className.localeCompare(b.className));
}

/**
 * 账单汇总统计
 *
 * ⚠️ 注意金额是「分」，两个 SELECT 分别按类型求和。
 *    SUM() 在没有记录时返回 NULL，要兜底成 0（不然前端显示 NaN）。
 */
export async function billSummary(q: any): Promise<{
  payTotalAmount: number;
  payCount: number;
  refundTotalAmount: number;
  refundCount: number;
}> {
  // ⚠️ 这里【必须】每次重新构造查询，不能复用同一个 builder 再 .clone()
  //    实测：对 `db(TABLE).where(...)` 得到的 builder 再 .clone()，
  //    在 knex 3.x 下会丢掉 from（生成 `select count(*) where ...`，报 ER_BAD_FIELD_ERROR）。
  //
  // 类型注解原因：knex 对 .count({c}).sum({s}) 链式调用的返回类型推断不出 c 字段，
  //    显式标 any 避免 tsc 报 TS2339（运行时字段是存在的）。
  const payRow: any = await buildBillQuery(q)
    .where('bill_type', 1)
    .count({ c: '*' })
    .sum({ s: 'amount' })
    .first();

  const refundRow: any = await buildBillQuery(q)
    .where('bill_type', 2)
    .count({ c: '*' })
    .sum({ s: 'amount' })
    .first();

  return {
    payTotalAmount: Number(payRow?.s) || 0,
    payCount: Number(payRow?.c) || 0,
    refundTotalAmount: Number(refundRow?.s) || 0,
    refundCount: Number(refundRow?.c) || 0,
  };
}

/**
 * 财务概览（首页大屏）
 *
 * ⚠️ 每个数字都要能从业务上解释清楚「它是什么意思」，别堆无意义的统计。
 */
export async function financeOverview(): Promise<{
  studentCount: number;
  suspendedCount: number;
  verifiedFeeCount: number;
  pendingFeeCount: number;
  pendingRefundCount: number;
  frozenCount: number;
  billPayAmount: number;
  billRefundAmount: number;
}> {
  // 缴费单统计（都排除已删除）
  // ⚠️ 同样不能复用 builder + clone()，每次重新 db(FEE_TABLE) 构造
  const [{ c: verifiedFeeCount }] = await db(FEE_TABLE)
    .where('is_deleted', false)
    .where('is_verified', true)
    .count({ c: '*' });

  // 待核对 = 有凭证 + 未核对 + 未打回
  //
  // ⚠️ 2026-10-04 修正：原来还多加了 `.where('pay_status', PayStatus.PAID)`，
  //    但「有没有凭证」才是待核对的判定依据 —— 上游传凭证时如果
  //    pay_status 没跟着从「待缴」改成「待核对」（attach-voucher 只在该字段
  //    为 UNPAID 时才升级，历史数据里存在漏掉的），这条就会被漏数。
  //    实测就有 6 条这样的单子（王思远 5 + 陈雨桐 1）：财务看得到、能核对，
  //    但概览页的「待核对」数字里没有它们 —— 账实不符。
  //    现在与列表页 canVerify 口径完全对齐。
  const [{ c: pendingFeeCount }] = await db(FEE_TABLE)
    .where('is_deleted', false)
    .whereNotNull('voucher_url')
    .andWhereNot('voucher_url', '')
    .where('is_verified', false)
    .where('is_rejected', false)
    .count({ c: '*' });

  // 退费待出款
  const [{ c: pendingRefundCount }] = await db(REFUND_TABLE)
    .where({ is_deleted: false, refund_status: RefundStatus.PENDING_FINANCE })
    .count({ c: '*' });

  // 冻结中人数（按人去重）
  const frozenRows = await db(FREEZE_TABLE)
    .where({ is_deleted: false, is_frozen: true })
    .distinct('student_id');
  const frozenCount = frozenRows.length;

  // 账单金额
  const billPay = await db(BILL_TABLE)
    .where({ is_deleted: false, bill_type: 1 })
    .sum({ s: 'amount' })
    .first();
  const billRefund = await db(BILL_TABLE)
    .where({ is_deleted: false, bill_type: 2 })
    .sum({ s: 'amount' })
    .first();

  // ---- 学生总数 / 休学人数 ----
  // ⚠️ 学生信息归教务/咨询模块，这里尝试读 t_student_base；
  //    如果还没接通（表不存在或为空），返回 0 并让前端显示「—」，
  //    绝不能因为跨模块取不到数就把整个概览接口搞崩。
  let studentCount = 0;
  let suspendedCount = 0;
  try {
    const [{ c }] = await db('t_student_base').where('is_deleted', false).count({ c: '*' });
    studentCount = Number(c) || 0;
    const [{ c: sc }] = await db('t_student_base')
      .where({ is_deleted: false, student_status: StudentStatus.SUSPENDED })
      .count({ c: '*' });
    suspendedCount = Number(sc) || 0;
  } catch {
    studentCount = 0;
    suspendedCount = 0;
  }

  // 学生表为空时，用「缴费记录里出现过的去重学生数」兜底，至少不是 0
  if (studentCount === 0) {
    const rows = await db(FEE_TABLE).where('is_deleted', false).distinct('student_id');
    studentCount = rows.length;
    const sRows = await db(FREEZE_TABLE)
      .where({ is_deleted: false, is_frozen: true })
      .where('student_status', StudentStatus.SUSPENDED)
      .distinct('student_id');
    suspendedCount = sRows.length;
  }

  return {
    studentCount,
    suspendedCount,
    verifiedFeeCount: Number(verifiedFeeCount) || 0,
    pendingFeeCount: Number(pendingFeeCount) || 0,
    pendingRefundCount: Number(pendingRefundCount) || 0,
    frozenCount,
    billPayAmount: Number(billPay?.s) || 0,
    billRefundAmount: Number(billRefund?.s) || 0,
  };
}
