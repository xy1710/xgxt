/**
 * 缴费管理 · 业务逻辑
 * 负责人：周铭（财务管理）
 *
 * ⚠️ 把业务逻辑写在 service 里、路由里只做「取参 → 调 service → 返回」，
 *    这样逻辑才能被复用，也才能单独测试。
 */

import { randomUUID } from 'crypto';
import { Knex } from 'knex';
import {
  BizCode,
  FEE_TYPE_NAME,
  PAY_STATUS_NAME,
  DEPT_NAME,
  FeeType,
  PayStatus,
  StudentStatus,
  SourceModule,
  SOURCE_MODULE_NAME,
  FEE_SOURCE_MODULE,
  VOUCHER_REUSABLE_FEE_TYPES,
} from 'shared-types/finance';
import { db, knexRaw } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { nextBillNoForPay } from '../utils/orderNo';
import { getStandard, isVoucherReusable, expectedSourceOf } from './fee-standard.service';
import { findArchiveStudent } from './student-archive';

export const FEE_TABLE = 't_finance_fee';
export const BILL_TABLE = 't_finance_bill';

/** 分 → 元（字符串，保留两位小数） */
function centToYuan(cent: number): string {
  return ((Number(cent) || 0) / 100).toFixed(2);
}

/** 日期格式化 YYYY-MM-DD（knex 取出的 date 可能是 Date 对象） */
export function toDateStr(v: any): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间格式化 YYYY-MM-DD HH:mm:ss */
export function toTimeStr(v: any): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 缴费行 → 前端契约格式
 *
 * ⚠️ 关键约定：
 *    - 枚举双返回：feeType + feeTypeName
 *    - 金额保持「分」，不在后端换算，前端 ÷100 显示
 *    - 字段名用 shared-types 里定义的那些，不许自创
 */
export function toFeeListItem(r: any) {
  return {
    id: r.id,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    classId: r.class_id ?? undefined,
    className: r.class_name ?? undefined,
    deptCode: r.dept_code ?? undefined,
    deptName: r.dept_code ? DEPT_NAME[r.dept_code] : undefined,
    headTeacherName: r.head_teacher_name ?? undefined,
    feeType: r.fee_type,
    feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
    amount: Number(r.amount),
    sourceModule: r.source_module ?? undefined,
    sourceModuleName: r.source_module
      ? SOURCE_MODULE_NAME[r.source_module]
      : undefined,
    // 该费用类型是否允许「多人共用一张凭证」（餐费为 true）
    voucherReusable: VOUCHER_REUSABLE_FEE_TYPES.includes(Number(r.fee_type)),
    payStatus: r.pay_status,
    payStatusName: PAY_STATUS_NAME[r.pay_status] || '',
    payDate: toDateStr(r.pay_date),
    expireDate: toDateStr(r.expire_date),
    hasVoucher: !!r.voucher_url,
    voucherNo: r.voucher_no ?? undefined,
    /**
     * 默认值：一张凭证只覆盖本单（后续 list/detail 会用真实聚合结果覆盖）。
     * ⚠️ 之所以给默认值而不是留空，是为了让「没查到 / 只有一单」的情况
     *    前端也能直接按「共 1 笔 = 本单金额」渲染，不用写一堆判空。
     */
    voucherGroupCount: 1,
    voucherGroupAmount: Number(r.amount),
    /**
     * ★ 2026-10-19 用户口径：「一张凭证 = 交的总金额，总金额下面列小项」
     *    合计单（一次交多类费用）会把分项存在 item_detail，
     *    列表用它显示「含 N 项」，详情用它渲染子表。
     *    单项单没有明细 → 默认 1 项、金额即本单金额。
     */
    itemCount: parseItemDetail(r.item_detail).length || 1,
    /**
     * 可核对 = 待核对(status=2) + 有凭证 + 未核对 + 未被打回。
     *
     * ⚠️ 为什么可以用 pay_status===PAID 判定？
     *    因为「上传凭证」这个动作会同步把状态推到 PAID（见 addFee / attachVoucher），
     *    所以 status=PAID 就等价于「凭证已到、等财务核对」。
     *    若以后新增别的写凭证入口，务必同步维护这个不变量。
     */
    canVerify:
      r.pay_status === PayStatus.PAID &&
      !!r.voucher_url &&
      !r.is_verified &&
      !r.is_rejected,
  };
}

/**
 * 解析「合计单包含的费用项」
 *
 * ⚠️ 兼容三种存法（历史数据不统一，读的时候尽量宽容）：
 *    · null / ''            → []
 *    · JSON 字符串数组       → 解析
 *    · 已是数组（内存对象）  → 直接用
 * 单条结构：{ feeType, feeTypeName, amount, standardAmount, discount }（单位：分）
 */
export function parseItemDetail(raw: any): Array<{
  feeType: number;
  feeTypeName: string;
  amount: number;
  amountYuan: string;
  standardAmount: number;
  standardAmountYuan: string;
  discount: number;
  discountYuan: string;
}> {
  if (!raw) return [];
  let arr: any[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return [];
    }
  }
  return arr
    .filter((i) => i && Number(i.feeType) > 0)
    .map((i) => {
      const amount = Number(i.amount) || 0;
      const std = i.standardAmount != null ? Number(i.standardAmount) : amount;
      const discount = i.discount != null ? Number(i.discount) : std - amount;
      return {
        feeType: Number(i.feeType),
        feeTypeName: i.feeTypeName || FEE_TYPE_NAME[Number(i.feeType)] || '',
        amount,
        amountYuan: centToYuan(amount),
        standardAmount: std,
        standardAmountYuan: centToYuan(std),
        discount,
        discountYuan: centToYuan(discount),
      };
    });
}

/** 缴费行 → 详情格式（在列表项基础上追加详情字段） */
export function toFeeDetail(r: any) {
  const items = parseItemDetail(r.item_detail);
  return {
    ...toFeeListItem(r),
    /**
     * 合计单的费用项（总金额下面列的那个小列）。
     * 单项单没有 item_detail → 用本单自身兜一个，前端可以无脑渲染。
     */
    items: items.length
      ? items
      : [
          {
            feeType: Number(r.fee_type),
            feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
            amount: Number(r.amount),
            amountYuan: centToYuan(Number(r.amount)),
            standardAmount: Number(r.amount),
            standardAmountYuan: centToYuan(Number(r.amount)),
            discount: 0,
            discountYuan: centToYuan(0),
          },
        ],
    voucherUrl: r.voucher_url ?? undefined,
    voucherTime: toTimeStr(r.voucher_time),
    voucherBy: r.voucher_by ?? undefined,
    isVerified: !!r.is_verified,
    verifiedByName: r.verified_by_name ?? undefined,
    verifiedTime: toTimeStr(r.verified_time),
    isRejected: !!r.is_rejected,
    rejectReason: r.reject_reason ?? undefined,
    isInBill: !!r.is_in_bill,
    period: r.period ?? undefined,
    remark: r.remark ?? undefined,
    createTime: toTimeStr(r.create_time) || '',
  };
}

/**
 * 构造列表查询条件（列表和导出共用）
 *
 * ⚠️⚠️ 财务侧【硬约束】共两条：
 *    ① 只查「已上传凭证」的缴费单
 *    ② 排除「冻结」状态的单据（2026-10-15 用户指令）
 *
 * 为什么（2026-10-04 用户指令）：
 *    缴费管理是财务的【核对工作台】，不是全量缴费台账。
 *    财务的职责链是：学生交钱 → 上游传凭证 → 财务核对凭证 → 入账。
 *    所以「还没传凭证」的单子（待缴）对财务毫无意义 ——
 *    它们是上游（咨询/教务）该跟学生催缴的事，财务侧不该看到。
 *
 * 这个约束写死在 buildFeeQuery 里（而不是交给前端传参），
 * 是故意的：这样列表、统计、导出三条路径自动一致，
 * 也不存在「前端漏传参数就漏数据」的可能。
 */
export function buildFeeQuery(q: any): Knex.QueryBuilder {
  const query = db(FEE_TABLE).where('is_deleted', false);

  // ---- 硬约束1：必须有凭证 ----
  query.whereNotNull('voucher_url').andWhereNot('voucher_url', '');

  /**
   * ---- 硬约束2：冻结中的单据不出现在缴费管理 ----
   *
   * ⭐ 2026-10-15 用户指令：「冻结的不会出现在缴费管理中」。
   *    冻结单据（学生休学自动冻结的餐费/住宿费）属于学籍冻结范畴，
   *    不是财务的核对对象，留在核对台只会干扰财务视线。
   *
   * ⚠️ 写在这里而不是前端过滤：这样列表 / 统计 / 导出三条路径自动一致。
   */
  query.whereNot('pay_status', PayStatus.FROZEN);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  /**
   * 班级名筛选（精确）。
   *
   * ⚠️ 为什么同时支持 classId 和 className？
   *    - classId 是理想口径，但历史上（尤其是咨询模块建单的试学单）
   *      很多记录【只写了班级名、没写 class_id】，只按 classId 查会漏数据。
   *    - 所以下拉选出来的班级名直接按 class_name 精确匹配，命中率最高。
   */
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.feeType) query.andWhere('fee_type', q.feeType);
  if (q.sourceModule) query.andWhere('source_module', q.sourceModule);
  if (q.payStatus) query.andWhere('pay_status', q.payStatus);
  if (q.startDate) query.andWhere('pay_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('pay_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/**
 * 构造「全量缴费台账」查询条件（**不含**有凭证硬约束）
 *
 * 💡 什么时候用它：
 *    需要看整个缴费盘子（含没交钱的单子）时，比如数据统计、对账。
 *    缴费管理列表【不要】用它，那是财务核对台，只该看有凭证的。
 *
 * ⚠️ 目前没有调用方，先留着做语义分界；要用时再显式选，
 *    避免以后有人随手改 buildFeeQuery 把财务的核对台口径弄坏。
 */
export function buildFeeLedgerQuery(q: any): Knex.QueryBuilder {
  const query = db(FEE_TABLE).where('is_deleted', false);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.className) query.andWhere('class_name', q.className);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.feeType) query.andWhere('fee_type', q.feeType);
  if (q.sourceModule) query.andWhere('source_module', q.sourceModule);
  if (q.payStatus) query.andWhere('pay_status', q.payStatus);
  if (q.startDate) query.andWhere('pay_date', '>=', q.startDate);
  if (q.endDate) query.andWhere('pay_date', '<=', q.endDate);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/* ============================================================
 * 下拉字典 & 统计（2026-10-03 用户指令新增）
 * ============================================================ */

/**
 * 班级字典 —— 「所有拥有的班级」
 *
 * 数据来源：缴费单表 + 学生表（左右合并）。
 *
 * ⚠️ 为什么不能只从「缴费单」取？
 *    缴费单里只有「有人缴过费」的班级；某个班一个人都没缴费时，
 *    下拉里就看不到它 —— 用户反馈的「看不到所有拥有的班级」正是这个原因。
 *    所以这里把 t_student_base 也并进来（学生表才是「拥有」的权威口径）。
 *
 * 💡 部门从 dept_code 直读（权威）；dept_code 缺失时才用班级名兜底推断：
 *      「大学部XX班」→ 大学部，其余 → 二三期。
 *    这样即使某个班没写 dept_code，也不会被错分到二三期而漏掉。
 *
 * @param deptCode 可选：只要某个部门的班级
 */
export async function listFeeClasses(deptCode?: number) {
  /**
   * 班级字典的两个来源：
   *   ① t_finance_fee —— 只统计【有凭证】的单，口径与缴费管理列表严格一致，
   *      这样下拉里「班级名 (N)」的 N 就是选完这个班后列表会出现的条数，不会有落差。
   *   ② t_student_base —— 学生表是「拥有班级」的权威口径。
   *      它只用来补「有名额但还没有任何已传凭证单据」的班级（保证下拉不缺点），
   *      不参与 count（避免把学生数混进单据数里，让 N 失去意义）。
   *
   * ⚠️ 表不存在也不能拖垮下拉（catch 兜底为空）。
   */
  const [feeRows, stuRows] = await Promise.all([
    db(FEE_TABLE)
      .where('is_deleted', false)
      .whereNotNull('voucher_url')
      .andWhereNot('voucher_url', '')
      .whereNotNull('class_name')
      .whereNot('class_name', '')
      .select('class_name', 'class_id', 'dept_code'),
    db('t_student_base')
      .where('is_deleted', false)
      .whereNotNull('class_name')
      .whereNot('class_name', '')
      .select('class_name', 'class_id', 'dept_code')
      .catch(() => [] as any[]),
  ]);

  const map = new Map<string, { className: string; classId?: string; deptCode: number; count: number }>();

  /** 累加「有凭证单据数」（只有费用表的数据走这里） */
  const absorbFee = (r: any) => {
    const name = String(r.class_name || '').trim();
    if (!name) return;
    const hit = map.get(name);
    if (hit) {
      hit.count += 1;
      if (!hit.classId && r.class_id) hit.classId = r.class_id;
      if (hit.deptCode == null && r.dept_code != null) hit.deptCode = Number(r.dept_code);
      return;
    }
    map.set(name, {
      className: name,
      classId: r.class_id ?? undefined,
      deptCode: r.dept_code != null ? Number(r.dept_code) : inferDeptCode(name),
      count: 1,
    });
  };

  /** 只补班级、不计数的来源（学生表走这里） */
  const absorbStu = (r: any) => {
    const name = String(r.class_name || '').trim();
    if (!name) return;
    const hit = map.get(name);
    if (hit) {
      if (!hit.classId && r.class_id) hit.classId = r.class_id;
      if (hit.deptCode == null && r.dept_code != null) hit.deptCode = Number(r.dept_code);
      return;
    }
    map.set(name, {
      className: name,
      classId: r.class_id ?? undefined,
      deptCode: r.dept_code != null ? Number(r.dept_code) : inferDeptCode(name),
      count: 0,
    });
  };

  feeRows.forEach(absorbFee);
  stuRows.forEach(absorbStu);

  let list = [...map.values()].map((c) => ({
    className: c.className,
    classId: c.classId,
    deptCode: c.deptCode,
    deptName: DEPT_NAME[c.deptCode] || '',
    count: c.count,
  }));

  if (deptCode != null) list = list.filter((c) => c.deptCode === deptCode);

  // 排序：先部门（1 二三期 → 2 大学部），再按班级名，保证下拉顺序稳定
  list.sort((a, b) =>
    a.deptCode !== b.deptCode
      ? a.deptCode - b.deptCode
      : a.className.localeCompare(b.className, 'zh-Hans-CN'),
  );

  return list;
}

/**
 * 班级名 → 部门编码（dept_code 缺失时的兜底）
 *
 * 约定：班级名以「大学部」开头 → 大学部(2)，其余 → 初高部(1)。
 */
export function inferDeptCode(cls: string): number {
  return cls.startsWith('大学部') ? 2 : 1;
}

/**
 * 按筛选条件聚合缴费状态统计（全量口径，不是当前页）
 *
 * ⚠️ 前端原来只能在「当前页」上数张数，页数一多就不准。
 *    这里用 SQL 一次聚合，工具栏上的数字才是真数。
 *
 * ⭐ 2026-10-04 口径调整（配合「财务只看有凭证单据」的硬约束）：
 *    既然 buildFeeQuery 已经只取有凭证的单子，原来的「待缴费」「待传凭证」
 *    两个计数器恒为 0（没凭证的单子根本不进结果集），留着只会让人困惑。
 *    所以换成财务核对台真正关心的三个数：
 *      · waitVerify 待核对 —— 有凭证、还没核对（财务的待办量）
 *      · verified   已缴   —— 已核对入账
 *      · rejected   已打回 —— 打回过、等上游重传凭证
 *
 * 💡 实现注意：
 *    1. 别名直接写在 raw SQL 里（`... END) as waitVerify`），
 *       因为本工程的 knex 类型里 `db.raw(...)` 没有 `.as()` 方法。
 *    2. 不要用 count({别名: raw}) —— knex 会把值当列名包 backtick，
 *       塞 raw 进去会踩 `Cannot read properties of undefined (reading 'raw')`。
 *    3. ⚠️ 必须用 knexRaw.raw，不能用 db.raw ！
 *       db.raw 只是 utils/db.ts 里做的一层「裸转发」（`db.raw = _knex.raw`），
 *       丢了 this 绑定。而 knex 的 raw 是依赖 this.context 的 getter，
 *       脱离实例调用必然抛 `Cannot read properties of undefined (reading 'raw')`。
 *       （该问题已在 utils/db.ts 用 .bind() 修掉，但这里沿用 knexRaw 更直白。）
 */
export async function statsFee(q: any) {
  const sum = (alias: string, cond: string, bindings: any[] = []) =>
    knexRaw.raw(`SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) as ${alias}`, bindings);

  const [row] = await buildFeeQuery(q)
    .clone()
    .select(
      knexRaw.raw('COUNT(*) as total'),
      // 待核对：有凭证 且 未核对 且 未打回
      sum(
        'waitVerify',
        'is_verified = 0 AND is_rejected = 0',
      ),
      // 已缴：核对通过
      sum('verified', 'is_verified = 1'),
      // 已打回：等上游重传凭证
      sum('rejected', 'is_rejected = 1'),
      sum('frozen', 'pay_status = ?', [PayStatus.FROZEN]),
    );

  const n = (v: any) => Number(v) || 0;
  return {
    total: n(row?.total),
    waitVerify: n(row?.waitVerify),
    verified: n(row?.verified),
    rejected: n(row?.rejected),
    frozen: n(row?.frozen),
  };
}

/**
 * 【核心】财务核对通过
 *
 * 做三件事（在一个事务里，要么全成功要么全回滚）：
 *   1. 校验：必须是「已缴 + 有凭证 + 未核对」的单子
 *   2. 生成缴费账单号，写入 t_finance_bill（账单明细）
 *   3. 回写缴费单：pay_status=已核对、is_verified=true、is_in_bill=true
 *
 * 💡 为什么第二步不能省？
 *    「核对」在业务上的含义就是「钱真的到账了，记进账本」，
 *    账本就是 t_finance_bill。只改状态不记账 = 账实不符。
 *
 * @returns 生成的账单号
 */
export async function verifyFee(
  id: string,
  operator: { userId: string; userName: string },
  remark?: string,
  trx?: Knex.Transaction,
): Promise<string> {
  const run = async (t: Knex.Transaction): Promise<string> => {
    const row = await t(FEE_TABLE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被删除');
    }

    // ---- 状态校验（给出人话提示，不要只报「参数错误」）----
    if (row.is_verified) {
      throw new BizError(BizCode.PARAM_ERROR, '该缴费单已核对过，请勿重复核对');
    }
    if (row.pay_status === PayStatus.UNPAID) {
      throw new BizError(BizCode.PARAM_ERROR, '该缴费单尚未缴费，无法核对');
    }
    if (!row.voucher_url) {
      throw new BizError(BizCode.PARAM_ERROR, '该缴费单未上传缴费凭证，无法核对');
    }

    // ---- 生成账单号 ----
    const billNo = await nextBillNoForPay();
    const now = new Date();
    const payDate = toDateStr(row.pay_date) || toDateStr(now)!;

    // ---- 写账单明细 ----
    await t(BILL_TABLE).insert({
      id: randomUUID(),
      create_time: now,
      create_by: operator.userId,
      is_deleted: false,
      bill_no: billNo,
      bill_type: 1, // 缴费账单
      source_id: row.id,
      source_no: row.voucher_no ?? null,
      student_id: row.student_id,
      student_no: row.student_no,
      student_name: row.student_name,
      class_id: row.class_id ?? null,
      class_name: row.class_name ?? null,
      dept_code: row.dept_code ?? null,
      head_teacher_name: row.head_teacher_name ?? null,
      fee_type: row.fee_type,
      amount: row.amount,
      bill_date: payDate,
      operator_id: operator.userId,
      operator_name: operator.userName,
      voucher_no: row.voucher_no ?? null,
      pay_method: null,
      remark: remark ?? `缴费核对入账（${FEE_TYPE_NAME[row.fee_type] || ''}）`,
    });

    // ---- 回写缴费单 ----
    await t(FEE_TABLE).where({ id }).update({
      pay_status: PayStatus.VERIFIED,
      is_verified: true,
      verified_by: operator.userId,
      verified_by_name: operator.userName,
      verified_time: now,
      is_rejected: false,
      reject_reason: null,
      is_in_bill: true,
      update_time: now,
      update_by: operator.userId,
    });

    return billNo;
  };

  // 支持外部传入事务（批量核对时共用一个事务）
  return trx ? run(trx) : db.transaction(run);
}

/** 财务打回（凭证有问题，退回班主任重新上传） */
export async function rejectFee(
  id: string,
  rejectReason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被删除');
  }
  if (row.is_verified) {
    throw new BizError(BizCode.PARAM_ERROR, '该缴费单已核对入账，无法打回');
  }
  if (!rejectReason || !rejectReason.trim()) {
    throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '打回原因必填');
  }

  await db(FEE_TABLE).where({ id }).update({
    // 打回后退回「已缴」，等班主任重新上传凭证
    pay_status: PayStatus.PAID,
    is_rejected: true,
    reject_reason: rejectReason.trim(),
    is_verified: false,
    update_time: new Date(),
    update_by: operator.userId,
  });
}

/**
 * 批量核对
 *
 * ⚠️ 用「一个事务包住全部」还是「每条一个事务」？
 *    这里选【每条一个事务】：某一条失败不影响其他条，
 *    最后返回成功条数，体验上比「一条不合法就全不干」更好。
 */
export async function batchVerifyFee(
  ids: string[],
  operator: { userId: string; userName: string },
): Promise<{ successCount: number; billNos: string[]; failed: { id: string; reason: string }[] }> {
  const billNos: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of ids) {
    try {
      const billNo = await verifyFee(id, operator);
      billNos.push(billNo);
    } catch (e: any) {
      failed.push({ id, reason: e?.message || '核对失败' });
    }
  }

  return { successCount: billNos.length, billNos, failed };
}

/**
 * 同步学生状态到缴费单（跨模块调用时用）
 *
 * 场景：学生休学 → 未缴/已缴但未核对的餐费、住宿费 → 置为「冻结」
 *      学生复学 → 冻结中的 → 恢复为原状态（这里统一恢复为「待缴」）
 */
export async function freezeFeeByStudent(
  studentId: string,
  frozen: boolean,
  operator: { userId: string; userName: string },
): Promise<number> {
  const now = new Date();

  if (frozen) {
    const affected = await db(FEE_TABLE)
      .where({ student_id: studentId, is_deleted: false })
      .whereIn('fee_type', [FeeType.ACCOMMODATION, FeeType.MEAL])
      .whereIn('pay_status', [PayStatus.UNPAID, PayStatus.PAID])
      .update({
        pay_status: PayStatus.FROZEN,
        update_time: now,
        update_by: operator.userId,
      });
    return Number(affected) || 0;
  }

  const affected = await db(FEE_TABLE)
    .where({ student_id: studentId, is_deleted: false, pay_status: PayStatus.FROZEN })
    .whereIn('fee_type', [FeeType.ACCOMMODATION, FeeType.MEAL])
    .update({
      pay_status: PayStatus.UNPAID,
      update_time: now,
      update_by: operator.userId,
    });
  return Number(affected) || 0;
}

/** 学生是否存在（跨模块拉数据失败时的兜底：允许手工传学生快照） */
export async function studentExists(studentId: string): Promise<boolean> {
  try {
    const row = await db('t_student_base').where({ id: studentId, is_deleted: false }).first('id');
    return !!row;
  } catch {
    // t_student_base 是示例表，没有也不该阻塞财务模块
    return true;
  }
}

/* ============================================================
 * 规则校验（用户定的规则2、3）
 * ============================================================ */

/**
 * 【规则3-①】校验来源模块是否和费用类型匹配
 *
 * 规则：咨询模块 → 试学费 / 正式学费；教务模块 → 餐费 / 住宿费 / 保险费
 *
 * 不传 sourceModule 时按映射表自动推断（默认信任上游），
 * 传了但和费用类型对不上就拒绝 —— 防止上游标错来源导致对账错乱。
 */
export function resolveSourceModule(
  feeType: number,
  given?: number,
): number {
  const expected = expectedSourceOf(feeType);
  if (!expected) return given ?? SourceModule.FINANCE;

  if (given == null) return expected;   // 没传 → 按规则推断

  if (Number(given) !== expected) {
    throw new BizError(
      BizCode.SOURCE_MODULE_MISMATCH,
      `${FEE_TYPE_NAME[feeType] || '该费用'}应由「${SOURCE_MODULE_NAME[expected]}」发起，` +
        `不能标成「${SOURCE_MODULE_NAME[given] || '未知来源'}」`,
    );
  }
  return Number(given);
}

/**
 * 【规则3-②】校验凭证能否使用
 *
 * 规则：餐费可以多人共用一张凭证；其他费用（学费/住宿费/保险费/试学费）一人一张。
 *
 * 实现：非可复用类型下，查同一 voucher_url 是否已被别的单据占用，
 *      占用就报错并告诉对方「被谁的什么费用占用了」，方便上游直接定位。
 *
 * ★ 2026-10-15 用户口径补充（重要）：
 *    正式学费改成「一次勾选六项」（学费/住宿费/押金/保险/餐费/校服）后，
 *    家长通常【一笔转账】，自然也只有【一张截图】，
 *    但这张图要挂到同一个学生的 6 张单据上 —— 若按「一人一张」拦，第二张起必失败。
 *
 *    所以规则细化为：「同一学生自己的多张单据允许共用一张凭证」，
 *    「跨学生」（同一张图贴给张三又贴给李四）仍然严格禁止 ——
 *    这才是「一人一张凭证」真正要防的事（防止多个学生共用一张费用截图一票多报）。
 *
 * @param excludeId 编辑场景下要排除自己
 * @param studentNo 当前单据所属学生的学号；传了则允许同一学生跨单据共用
 */
export async function assertVoucherAvailable(
  feeType: number,
  voucherUrl: string | undefined | null,
  excludeId?: string,
  studentNo?: string,
  studentId?: string,
): Promise<void> {
  if (!voucherUrl) return;                    // 没传凭证，不用校验
  if (isVoucherReusable(feeType)) return;     // 餐费：允许共用

  const q = db(FEE_TABLE)
    .where({ voucher_url: voucherUrl, is_deleted: false });
  if (excludeId) q.whereNot('id', excludeId);

  const occupied = await q.first();
  if (!occupied) return;

  // ★ 同一学生的多张单据共用一张转账截图：允许（2026-10-15 规则细化）
  //   学号可能为空（咨询阶段学生还没正式学号），所以再用 student_id 兜一次底
  if (studentNo && occupied.student_no && occupied.student_no === studentNo) {
    return;
  }
  if (studentId && occupied.student_id && occupied.student_id === studentId) {
    return;
  }

  throw new BizError(
    BizCode.VOUCHER_DUPLICATED,
    `该凭证已被「${occupied.student_name}」的${FEE_TYPE_NAME[occupied.fee_type] || '费用'}占用` +
      `（单据 ${occupied.id.slice(0, 8)}）。` +
      `${FEE_TYPE_NAME[feeType] || '该费用'}不允许不同学生共用一张凭证，请更换凭证或联系被占用的学生处理。`,
  );
}

/**
 * 查询同一张凭证还被哪些单据共用（餐费场景下展示用）
 */
export async function findVoucherSharers(
  voucherUrl: string | undefined,
  excludeId?: string,
) {
  if (!voucherUrl) return [];
  const q = db(FEE_TABLE).where({ voucher_url: voucherUrl, is_deleted: false });
  if (excludeId) q.whereNot('id', excludeId);
  const rows = await q.select('id', 'student_name', 'student_no', 'fee_type');
  return rows.map((r: any) => ({
    id: r.id,
    studentName: r.student_name,
    studentNo: r.student_no,
    feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
  }));
}

/* ============================================================
 * ★ 2026-10-19 凭证覆盖范围（一次转账 = 多张单据）
 * ============================================================ */

/**
 * 批量统计「每张凭证覆盖了几笔单据、合计多少钱」
 *
 * 业务背景（用户反馈「缴费凭证和实缴金额对不上」）：
 *   一次缴清多项费用时，家长只转一笔钱、只给一张截图，截图要挂到
 *   学费/住宿费/押金/保险费/餐费/校服多张单据上。
 *   每张单据的 amount 只是其中一项，凭证截图却是合计 ——
 *   财务单看一行，就会觉得「凭证金额 ≠ 本单金额，数据错了」。
 *
 * 所以列表里一次性把这批凭证的「笔数 + 合计」查出来，
 * 前端就能在凭证列显示「共 N 笔 · 合计 ¥X」，把一对多关系讲明白。
 *
 * @param voucherUrls 本页出现过的凭证地址（去重后传入，避免 N+1）
 * @returns Map<凭证地址, { count: 单据笔数, amount: 合计金额（分） }>
 *
 * ⚠️ 口径说明：统计包含冻结单与已核对单 —— 它们同样是「这张凭证覆盖的钱」，
 *    排除掉反而会让合计对不上截图。is_deleted 仍然排除（已删单不算）。
 */
export async function voucherGroupMap(
  voucherUrls: Array<string | null | undefined>,
): Promise<Map<string, { count: number; amount: number }>> {
  const urls = [...new Set(voucherUrls.filter(Boolean) as string[])];
  const map = new Map<string, { count: number; amount: number }>();
  if (!urls.length) return map;

  const rows = await db(FEE_TABLE)
    .where({ is_deleted: false })
    .whereIn('voucher_url', urls)
    .select('voucher_url')
    .select(knexRaw.raw('COUNT(*) as cnt'), knexRaw.raw('COALESCE(SUM(amount), 0) as total'))
    .groupBy('voucher_url');

  for (const r of rows as any[]) {
    map.set(String(r.voucher_url), {
      count: Number(r.cnt) || 0,
      amount: Number(r.total) || 0,
    });
  }
  return map;
}

/** 单张凭证的覆盖范围（详情页用；没有凭证时返回 0/0） */
export async function voucherGroupOf(
  voucherUrl: string | null | undefined,
): Promise<{ count: number; amount: number }> {
  const map = await voucherGroupMap([voucherUrl]);
  return map.get(String(voucherUrl)) || { count: 0, amount: 0 };
}

/**
 * 新增缴费单
 *
 * 会执行两条规则校验（用户定的规则2、3）：
 *   ① amount 不传 → 自动从「费用标准」取（规则2）
 *   ② sourceModule 校验（规则3-①）
 *   ③ voucherUrl 唯一性校验（规则3-②）
 */
/* ============================================================
 * ★ 2026-10-19 作废缴费单（上游发起错了 / 重复发起时撤销）
 * ============================================================ */

/**
 * 作废一张还没入账的缴费单（软删）
 *
 * 背景：
 *   上游模块（咨询）没有作废能力时，老师发现「多发起了一笔」只能再发起一次去覆盖，
 *   结果同一学生同一费用项堆出好几张单 —— 账面看起来像交了好几次钱。
 *   这里补上撤销通道：未核对入账的单可以作废，已入账的必须走退费。
 *
 * ⚠️ 只软删（is_deleted=1），保留流水痕迹；调用方（咨询）负责把本地单据一起作废。
 */
export async function cancelFee(
  id: string,
  reason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '缴费单不存在或已被作废');
  }
  if (row.is_verified || row.is_in_bill) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      '该缴费单已核对入账，不能作废；如需撤销请走「退费」流程',
    );
  }

  const note = reason?.trim() ? reason.trim() : '上游重复发起';
  await db(FEE_TABLE).where({ id }).update({
    is_deleted: true,
    update_time: new Date(),
    update_by: operator.userId,
    remark: [row.remark, `作废：${note}（${operator.userName}）`].filter(Boolean).join(' | '),
  });
}

export async function addFee(
  body: any,
  operator: { userId: string; userName: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();

  /**
   * ★ 2026-10-20：学生属性以学生档案为准（档案里能查到这个人时）
   *
   * 用户口径：「学生档案有的字段按学生档案的数据走」。
   * 上游（咨询/教务）传过来的学号/姓名/班级可能是建单那一刻的快照，
   * 学生后来换班或改名就会脱节。只要档案里能对上（先按 id、再按学号），
   * 落库一律用档案当前值，不信任调用方传的那几个字段。
   *
   * ⚠️ 档案里查不到时**保持原样**：报名前的咨询收费单，学生还没进学籍档案，
   *    这是正常业务状态，不能因此拒绝建单。
   */
  const archived = await findArchiveStudent(body.studentId, body.studentNo);
  if (archived) {
    if (archived.no) body.studentNo = archived.no;
    if (archived.name) body.studentName = archived.name;
    if (archived.classId) body.classId = archived.classId;
    if (archived.className) body.className = archived.className;
    if (archived.deptCode != null) body.deptCode = archived.deptCode;
  }

  /* ---------- 规则2：金额没传就取财务标准 ---------- */
  let amount: number = body.amount;
  if (amount == null) {
    if (body.deptCode == null) {
      throw new BizError(
        BizCode.REQUIRED_FIELD_MISSING,
        '未传金额时，必须提供 deptCode 才能按费用标准取值',
      );
    }
    const std = await getStandard(body.feeType, body.deptCode);
    amount = std.amount;
  }

  /* ---------- 规则3-①：来源模块校验 ---------- */
  const sourceModule = resolveSourceModule(body.feeType, body.sourceModule);

  /* ---------- 规则3-②：凭证唯一性校验 ---------- */
  // ★ 传 body.studentNo：同一学生的多张单据可共用一张转账截图（2026-10-15）
  await assertVoucherAvailable(body.feeType, body.voucherUrl, undefined, body.studentNo);

  /**
   * ⚠️ 状态与凭证一致性（2026-10-04 用户指令）
   *
   * 缴费管理的口径是「有凭证的单 = 财务待核对的单」。
   * 如果建单时就带了凭证，但状态还是「待缴」，就会出现
   * 「财务看得到这张单、却点不了核对」的中间态（历史踩过的坑，见 attachVoucher）。
   *
   * 所以这里统一推断：带了凭证 → 至少是「待核对(PAID)」，等财务核对后升级为「已缴(VERIFIED)」。
   * 只有「没带凭证」时才落回调用方传的 payStatus（默认待缴）。
   */
  const resolvedPayStatus: number = body.voucherUrl
    ? PayStatus.PAID
    : (body.payStatus ?? PayStatus.UNPAID);

  await db(FEE_TABLE).insert({
    id,
    create_time: now,
    create_by: operator.userId,
    is_deleted: false,
    student_id: body.studentId,
    student_no: body.studentNo,
    student_name: body.studentName,
    class_id: body.classId ?? null,
    class_name: body.className ?? null,
    dept_code: body.deptCode ?? null,
    head_teacher_id: body.headTeacherId ?? null,
    head_teacher_name: body.headTeacherName ?? null,
    fee_type: body.feeType,
    amount,
    source_module: sourceModule,
    pay_status: resolvedPayStatus,
    pay_date: body.payDate ?? (body.voucherUrl ? now : null),
    expire_date: body.expireDate ?? null,
    period: body.period ?? null,
    voucher_url: body.voucherUrl ?? null,
    voucher_no: body.voucherNo ?? null,
    voucher_by: body.voucherUrl ? operator.userId : null,
    voucher_time: body.voucherUrl ? now : null,
    is_verified: false,
    is_rejected: false,
    is_in_bill: false,
    remark: body.remark ?? null,
    /**
     * ★ 2026-10-19 合计单的分项明细
     *    上游（咨询）一次交多类费用时，只建一张「合计单」，
     *    金额 = 各项之和，各项明细存在这里，供财务看到「这笔钱包含什么」。
     *    单项单不传 → NULL。
     */
    item_detail:
      body.itemDetail == null
        ? null
        : typeof body.itemDetail === 'string'
          ? body.itemDetail
          : JSON.stringify(body.itemDetail),
  });

  return id;
}

/** 学生状态枚举的「休学」值（语义化，避免代码里裸写 6） */
export const SUSPENDED_STATUS = StudentStatus.SUSPENDED;

/* ============================================================
 * 上游模块回传凭证（规则3-②）
 * ============================================================ */

/**
 * 给已存在的缴费单补传凭证
 *
 * 业务背景：
 *   上游模块（咨询/教务）建单时往往还没拿到缴费截图，学生是「先建单 → 再交钱 → 再上传」。
 *   所以上游上传截图后，需要把凭证回传到财务侧，财务才能核对。
 *
 * ⚠️ 会重新执行凭证唯一性校验（规则3-②）：
 *    非餐费类型下，同一张凭证不能挂在多条单据上。
 *
 * @returns 是否成功更新
 */
export async function attachVoucher(
  feeId: string,
  voucherUrl: string,
  voucherNo: string | undefined,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FEE_TABLE).where({ id: feeId, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.FEE_NOT_FOUND, `缴费单 ${feeId} 不存在`);
  }

  // 已核对/已入账单：已有凭证时不允许再改（账已核对，防止事后换图）；
  // 但缺凭证的历史单允许补传，否则「缴费单后边的凭证都得能查看」永远补不齐。
  if (row.is_verified && row.voucher_url) {
    throw new BizError(
      BizCode.INVALID_STATUS,
      '该缴费单已核对通过，如需修改凭证请先在财务侧「打回」',
    );
  }

  // 规则3-②：重新校验凭证唯一性（换凭证时排除自己）
  // ★ 传 student_no + student_id：同一学生的多张单据可共用一张转账截图（2026-10-15）
  await assertVoucherAvailable(row.fee_type, voucherUrl, feeId, row.student_no, row.student_id);

  await db(FEE_TABLE).where({ id: feeId }).update({
    voucher_url: voucherUrl,
    voucher_no: voucherNo ?? null,
    voucher_by: operator.userId,
    voucher_time: new Date(),
    is_rejected: false,
    reject_reason: null,
    // 传了凭证 → 状态推到「待核对(PAID)」，等财务核对后才是「已缴(VERIFIED)」
    // ⚠️ 只把「待缴」这类未收款状态往上推，不动已核对/已入账的单
    pay_status: row.pay_status === PayStatus.UNPAID ? PayStatus.PAID : row.pay_status,
  });
}
