/**
 * 市场咨询模块 · 实体类型
 *
 * ⚠️ 命名约定：
 *    - 列表项 → XxxListItem（字段从简，列表页用）
 *    - 详情   → Xxx（完整字段）
 *    - 查询   → XxxQuery
 *    - 提交   → XxxSavePayload / XxxActionPayload
 */

import { StudentStatus, Gender, DeptCode, FeeType, RoleCode } from './enums';
import {
  LeadChannel,
  ConsultState,
  ConsultRole,
  ConsultFeeStatus,
  ConsultRefundStatus,
} from './consult-enums';
import { BaseEntity, PageQuery } from './common';

/* ============================================================
 * 一、咨询学生档案
 * ============================================================ */

/** 跟进历史一条 */
export interface ConsultHistoryItem {
  id: string;
  /** 发生时间 YYYY-MM-DD HH:mm */
  at: string;
  /** 操作人姓名 */
  by: string;
  /** 操作人岗位 */
  byTitle?: string;
  /** 操作描述 */
  text: string;
}

/** 学生信息完整度 */
export interface InfoCompleteness {
  /** 基本信息已填数 */
  baseCount: number;
  /** 基本信息总数 */
  baseTotal: number;
  /** 档案已填数 */
  extraCount: number;
  /** 档案总数 */
  extraTotal: number;
  /** 提示文案 */
  label: string;
  /** 状态：待完善 / 部分完善 / 完整 */
  level: 'PENDING' | 'PARTIAL' | 'COMPLETE';
}

/** 学生列表项 */
export interface ConsultStudentListItem {
  consultStudentId: string;
  /** 学号（正式学生才有，试学阶段可能为空） */
  studentNo?: string;
  studentName: string;
  gender: Gender;
  genderName: string;
  phone?: string;
  /** 来源（渠道 + 备注，如「家访·青山社区」） */
  source: string;
  sourceChannel?: LeadChannel;
  sourceChannelName?: string;
  /** 跟进人（咨询老师 / 经理） */
  ownerName?: string;
  /** 咨询流转状态 */
  consultState: ConsultState;
  consultStateName: string;
  /** 学籍状态（同步给其他模块的那个） */
  studentStatus?: StudentStatus;
  studentStatusName?: string;
  className?: string;
  /** 意向课程 */
  intendCourse?: string;
  /** 收费情况摘要 */
  paidCount: number;
  pendingCount: number;
  /**
   * ★ 2026-10-16 分期欠费金额（分）
   *
   * 来源：该学生所有「未终止」分期计划的待缴余额之和。
   * > 0 表示还有尾款没缴清，列表上打「欠费」标记。
   */
  arrearAmount?: number;
  /** 是否欠费（arrearAmount > 0），前端列表筛选与标记用 */
  inArrear?: boolean;
  infoCompleteness: InfoCompleteness;
  createTime: string;
}

/** 学生详情（完整档案） */
export interface ConsultStudent extends BaseEntity {
  consultStudentId: string;
  studentNo?: string;
  studentName: string;
  gender: Gender;
  genderName: string;
  age?: number;
  phone?: string;
  deptCode?: DeptCode;
  deptName?: string;

  /* ---- 来源与归属 ---- */
  sourceChannel: LeadChannel;
  sourceChannelName: string;
  /** 来源备注，如「青山社区」 */
  sourceRemark?: string;
  /** 转介绍招生老师姓名（来源=转介绍时填） */
  referrerName?: string;
  /** 转介绍招生老师手机号 */
  referrerPhone?: string;
  ownerId?: string;
  ownerName?: string;
  ownerTitle?: string;
  /** 录入人（招生老师） */
  creatorName?: string;

  /* ---- 基本信息 ---- */
  intendCourse?: string;
  parentContact?: string;
  parentPhone?: string;

  /* ---- 档案信息 ---- */
  idCard?: string;
  school?: string;
  address?: string;
  targetCollege?: string;
  birthday?: string;
  payMode?: string;
  remark?: string;

  /* ---- 状态 ---- */
  consultState: ConsultState;
  consultStateName: string;
  studentStatus?: StudentStatus;
  studentStatusName?: string;
  classId?: string;
  className?: string;
  /** 试学开始日期 YYYY-MM-DD（退费算天数用） */
  trialStart?: string;
  /** 流失原因 */
  lossReason?: string;

  /** 信息完整度 */
  infoCompleteness: InfoCompleteness;

  /* ---- 详情扩展（仅详情接口返回）---- */

  /**
   * 主键（与 consultStudentId 同值）
   * ⚠️ 详情接口同时返回 id 和 consultStudentId，前端用哪个都行
   */
  id: string;
  /** 跟进历史（按时间正序） */
  history?: ConsultHistoryItem[];
  /**
   * 该生的缴费单
   *
   * ★ 2026-10-16 用户口径：只保留「总金额」一行，总金额下面列出它包含的费用项
   *    （一次勾选多项发起收费时，库里是一张单据一个费用类型，共享一张凭证）
   */
  fees?: ConsultStudentFeeGroup[];
  /** 该生的退费单（最多一条，没有则为 null） */
  refund?: ConsultRefundOrder | null;
  /** 可选班级列表（分班弹窗用） */
  classOptions?: string[];
  /** 全款到账状态（转正式后 4 笔是否齐） */
  fullFeeStatus?: {
    allArrived: boolean;
    /** 还没到账的费用类型 */
    missing: FeeType[];
  };
}

/** 学生查询参数 */
export interface ConsultStudentQuery extends PageQuery {
  studentName?: string;
  phone?: string;
  ownerName?: string;
  className?: string;
  sourceChannel?: LeadChannel;
  intendCourse?: string;
  consultState?: ConsultState;
  /** 部门筛选 */
  deptCode?: DeptCode;
  /** 全部字段模糊搜索 */
  keyword?: string;
}

/** 新增学生（市场/咨询首次录入） */
export interface ConsultStudentSavePayload {
  studentName: string;
  gender: Gender;
  /** 学生手机号（可留空，后续完善档案时补） */
  phone?: string;
  sourceChannel: LeadChannel;
  sourceRemark?: string;
  /** 转介绍招生老师姓名（来源=转介绍时填） */
  referrerName?: string;
  /** 转介绍招生老师手机号 */
  referrerPhone?: string;
  /** 意向课程（可留空） */
  intendCourse?: string;
  parentContact?: string;
  parentPhone?: string;
  deptCode?: DeptCode;
}

/** 完善档案信息 */
export interface ConsultStudentExtraPayload {
  consultStudentId: string;
  idCard?: string;
  school?: string;
  address?: string;
  targetCollege?: string;
  birthday?: string;
  payMode?: string;
  remark?: string;
  intendCourse?: string;
  parentContact?: string;
  parentPhone?: string;
}

/* ============================================================
 * 二、收款单（咨询发起 → 财务核对）
 * ============================================================ */

/**
 * 学生档案 →「缴费单」里的一行
 *
 * ★ 2026-10-16 用户口径：只保留【总金额】一行，总金额下面列出它包含的费用项。
 *   一次勾选多项发起收费时，库里是「一张单据一个费用类型」（共享一张凭证），
 *   平铺会出现 6 行、同一张凭证重复 6 次 —— 这里按同一次发起合并成一行。
 */
export interface ConsultStudentFeeGroup {
  /** 代表单 id（合并批次取第一张） */
  orderId: string;
  orderNo: string;
  /** 本行覆盖的全部单据 id（合并批次的每一张） */
  orderIds: string[];
  /**
   * ★ 2026-10-19 分期单标记：有值说明这一行属于某张分期计划（第 stageNo 期）。
   *    分期各期天然是同一个费用项，前端不做「重复收费」标注、也不给作废入口。
   */
  planId?: string;
  stageNo?: number;
  /** 展示用类型名，如「学费 等 6 项」 */
  feeTypeName: string;
  /** 总金额（分） */
  amount: number;
  amountYuan: string;
  status: ConsultFeeStatus;
  statusName: string;
  /** 整批共用的缴费凭证（取第一张有值的） */
  voucherUrl?: string;
  createTime: string;
  /** 总金额下面列出的费用项 */
  included: Array<{
    /** ★ 2026-10-19 带上类型码：前端要判断「同一费用项被重复发起」 */
    feeType?: number;
    feeTypeName: string;
    amountYuan: string;
    status: ConsultFeeStatus;
    statusName: string;
    /** 该子项对应的单据 id（按类型分别建立的老批次才有，合并单没有） */
    orderId?: string;
  }>;
  /**
   * ★ 2026-10-19 疑似重复收费：
   *    同一学生的同一费用项，在多张【未终结】的单据上同时存在
   *    （例如学费既挂在 SK20261015-001 待财务确认、又挂在 SK20261015-007 待上传凭证）。
   *    前端据此标红，提示老师作废多余的那一批。
   */
  duplicated?: boolean;
  /** 与其他单据重复的费用项名称（duplicated=true 时有值） */
  duplicatedTypes?: string[];
}

/** 作废收款单结果 */
export interface ConsultFeeCancelResult {
  /** 成功作废的单据数 */
  cancelled: number;
  /** 没能作废的单据及原因（已到账的要走退费，不能作废） */
  skipped: Array<{ orderNo: string; reason: string }>;
}

/** 收款单 */
export interface ConsultFeeOrder {
  /** 本模块单据 id */
  orderId: string;
  /** 财务侧缴费单 id（建单成功后回填，用于关联查询核对结果） */
  financeFeeId?: string;
  /** 展示用单号 */
  orderNo: string;

  consultStudentId: string;
  studentName: string;
  studentNo?: string;
  className?: string;

  /**
   * ★ 2026-10-09 学生当前咨询状态（list 接口实时补查，非单据快照）
   *    用途：已退费(10)/退费·待经理审批(8)/退费·待财务打款(9) 时前端隐藏「分班」
   */
  consultState?: number;
  consultStateName?: string;

  feeType: FeeType;
  feeTypeName: string;
  /** 金额，单位：分 */
  amount: number;
  /** 金额元（前端展示，后端算好省得前端再除） */
  amountYuan: string;

  /** 咨询侧状态 */
  status: ConsultFeeStatus;
  statusName: string;
  /** 财务侧的 payStatus（3=已核对） */
  financePayStatus?: number;
  financePayStatusName?: string;
  /** 财务打回原因 */
  rejectReason?: string;

  /** 凭证图片 URL（相对路径，如 /uploads/voucher/xxx.jpg） */
  voucherUrl?: string;
  /** 转账单号 / 流水号 */
  voucherNo?: string;
  /** 上传凭证的人 */
  voucherBy?: string;

  /** 缴费方式 */
  payMethod?: string;
  /** 发起人 */
  createdByName: string;
  createTime: string;
  /** 最近一次操作描述 */
  lastAction?: string;

  /* ---------- ★ 2026-10-15 一次缴清的多项费用合并为一行 ---------- */

  /**
   * 本次收款包含的费用项明细。
   * 单笔收款也带（长度 1），这样前端展示不用分两套逻辑。
   */
  included?: Array<{
    orderId: string;
    feeTypeName: string;
    amountYuan: string;
    statusName: string;
  }>;
  /** 本行覆盖的所有单据 id（上传凭证 / 重新提交要批量作用在这些单据上） */
  orderIds?: string[];
  /** true = 一次缴清的多项费用合并行（feeTypeName 形如「学费 等 6 项」） */
  merged?: boolean;
  /**
   * ★ 2026-10-15 合并缴费（一张合计单）时勾选的费用项原始明细。
   *    与 included 的区别：included 是「行」级别的展示数据（带状态），
   *    itemDetail 是单据自带的明细快照（金额，单位分）。
   *
   *    ★ 2026-10-16 新增 standardAmount / discount：
   *      standardAmount = 财务标准应缴（分）；discount = 应缴 - 实缴（分，>0 表示优惠）。
   *      用于「发起收费」时按 应缴/实缴/优惠 三个口径展示与回看。
   */
  itemDetail?: Array<{
    feeType: number;
    feeTypeName: string;
    /** 实缴（本次实际收取，分） */
    amount: number;
    /** 应缴（财务标准，分）；老数据没有这个字段时 = amount */
    standardAmount?: number;
    /** 优惠（应缴 - 实缴，分） */
    discount?: number;
  }>;
  /** ★ 2026-10-16 整单口径：应缴合计（分） */
  dueAmount?: number;
  /** ★ 2026-10-16 整单口径：优惠合计（分） */
  discountAmount?: number;

  /* ---------- ★ 2026-10-15 缴费完成后的操作人与时间 ---------- */

  /** 财务确认到账的操作人（缴费完成之后才有） */
  paidByName?: string;
  /** 财务确认到账的时间（缴费完成之后才有） */
  paidTime?: string;

  /* ---------- ★ 2026-10-16 分期付款 ---------- */

  /** 所属分期计划 id（一次性缴费为 undefined） */
  planId?: string;
  /** 分期计划号，如 FP20261016-001 */
  planNo?: string;
  /** 第几期，从 1 开始 */
  stageNo?: number;
  /** 「第 1 期 / 共 3 期」，一次性缴费为 undefined */
  stageText?: string;
  /** 分期时整单应收（分） */
  totalDueAmount?: number;
  totalDueAmountYuan?: string;
}

/* ============================================================
 * ★ 2026-10-16 分期付款
 *
 * 业务口径（用户 2026-10-16 确认）：
 *   · 一次「发起收费」= 一张分期计划（plan），下挂 N 个期次（item）
 *   · 应收总额 = 勾选费用项按财务标准算出；实缴不足的部分分两种性质：
 *       - 优惠（discount）：机构让利，账当场平掉
 *       - 待缴（pending）：还要继续收，挂在待缴余额里
 *   · 待缴 = 应收 - 优惠 - 已缴，归零才算缴清
 *   · 首付（第 1 期）到账即可分班，尾款没缴清的挂「欠费」标记
 *
 * ⚠️ 金额一律「分」。
 * ============================================================ */

/** 分期计划状态 */
export enum InstallmentPlanStatus {
  ONGOING = 1, // 进行中（还有期次没缴清）
  FINISHED = 2, // 已完成（全部缴清）
  TERMINATED = 3, // 已终止（退费/流失后不再收）
}

export const INSTALLMENT_PLAN_STATUS_NAME: Record<number, string> = {
  [InstallmentPlanStatus.ONGOING]: '进行中',
  [InstallmentPlanStatus.FINISHED]: '已完成',
  [InstallmentPlanStatus.TERMINATED]: '已终止',
};

/** 期次状态 */
export enum InstallmentItemStatus {
  WAIT = 0, // 待缴（还没发起收款）
  PENDING = 1, // 待确认（已发起/已传凭证，等财务核对）
  ARRIVED = 2, // 已到账
  OVERDUE = 3, // 已逾期（过了到期日还没到账）
}

export const INSTALLMENT_ITEM_STATUS_NAME: Record<number, string> = {
  [InstallmentItemStatus.WAIT]: '待缴',
  // ★ 2026-10-16 与收费单状态叫法保持一致：待确认 → 待财务确认
  [InstallmentItemStatus.PENDING]: '待财务确认',
  [InstallmentItemStatus.ARRIVED]: '已到账',
  [InstallmentItemStatus.OVERDUE]: '已逾期',
};

/** 一个期次 */
export interface ConsultInstallmentItem {
  itemId: string;
  planId: string;
  /** 第几期，从 1 开始 */
  stageNo: number;
  /** 本期应收（分） */
  dueAmount: number;
  dueAmountYuan: string;
  /** 到期日 YYYY-MM-DD */
  dueDate?: string;
  /** 本期已缴（分，到账才计入） */
  paidAmount: number;
  paidAmountYuan: string;
  status: InstallmentItemStatus;
  statusName: string;
  /** 是否已逾期（没到账且过了到期日；自动顺延后一般不会出现） */
  overdue: boolean;
  /** ★ 2026-10-16 自动顺延次数：到期未缴时到期日自动后移一个周期，每顺延一次 +1 */
  postponeCount?: number;
  /** 关联的缴费单 */
  feeOrderId?: string;
  orderNo?: string;
  /** ★ 2026-10-16 该期单据已绑定的缴费凭证（没有则需要在「分期操作」里补缴凭证） */
  voucherUrl?: string;
  payTime?: string;
  remark?: string;
}

/** 分期计划 */
export interface ConsultInstallmentPlan {
  planId: string;
  planNo: string;
  consultStudentId: string;
  studentName: string;
  studentNo?: string;
  deptCode?: number;
  deptName?: string;

  /** 应收总额（分） */
  totalAmount: number;
  /** 已缴（分，到账才计入） */
  paidAmount: number;
  /** 优惠（分） */
  discountAmount: number;
  /** 待缴（分）= 应收 - 优惠 - 已缴 */
  pendingAmount: number;

  totalAmountYuan: string;
  paidAmountYuan: string;
  discountAmountYuan: string;
  pendingAmountYuan: string;

  stageCount: number;
  paidStages: number;
  status: InstallmentPlanStatus;
  statusName: string;

  /** 费用项明细快照 */
  itemDetail?: Array<{
    feeType: number;
    feeTypeName: string;
    amount: number;
    standardAmount?: number;
    discount?: number;
  }>;

  remark?: string;
  createByName?: string;
  createTime?: string;

  /** 期次明细 */
  items: ConsultInstallmentItem[];
}

/** 创建分期计划的入参 */
export interface ConsultInstallmentCreatePayload {
  consultStudentId: string;
  /** 本次要收的费用类型 */
  feeTypes: FeeType[];
  /** 实缴自定义（分），key = feeType；与应收的差额记「优惠」 */
  amountByType?: Record<number, number>;
  /** 缴费方式 */
  payMethod?: string;
  /**
   * 期次划分，按 stageNo 升序。amount 单位：分。
   * ⚠️ 各期之和必须 = 应收 - 优惠（即实缴合计），否则会拦下来。
   */
  stages: Array<{
    stageNo: number;
    amount: number;
    /** 到期日 YYYY-MM-DD */
    dueDate?: string;
  }>;
  remark?: string;
  /** 是否在创建后立刻发起第 1 期收款（默认 true） */
  startFirstStage?: boolean;
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    创建分期时就要带上第 1 期的缴费凭证，随第 1 期单据一起落库，
   *    避免出现「计划建了、第 1 期却是待上传凭证」的中间态。
   */
  voucherUrl?: string;
  voucherNo?: string;
}

/** 缴某一期的入参 */
export interface ConsultInstallmentPayPayload {
  planId: string;
  /** 第几期 */
  stageNo: number;
  /** 缴费方式 */
  payMethod?: string;
  /** 本期实收（分），不传则按本期应收 */
  amount?: number;
  /**
   * ★ 2026-10-16 用户口径：发起收款必须当场传凭证（无论一次性还是分期），
   *    传了就绑定到本期单据并直接置「待确认（待财务确认）」。
   */
  voucherUrl?: string;
  voucherNo?: string;
}

/** 学生缴费账本（应收 / 已收 / 待缴） */
export interface ConsultStudentLedger {
  consultStudentId: string;
  studentName: string;
  /** 应收总额（分） */
  totalAmount: number;
  /** 已缴（分） */
  paidAmount: number;
  /** 优惠（分） */
  discountAmount: number;
  /** 待缴（分） */
  pendingAmount: number;
  totalAmountYuan: string;
  paidAmountYuan: string;
  discountAmountYuan: string;
  pendingAmountYuan: string;
  /** 是否欠费（待缴 > 0） */
  inArrear: boolean;
  /** 分期计划列表（可能为空数组，表示还没发起过收费） */
  plans: ConsultInstallmentPlan[];
}

/** 收款单查询 */
export interface ConsultFeeOrderQuery extends PageQuery {
  studentName?: string;
  ownerName?: string;
  className?: string;
  feeType?: FeeType;
  status?: ConsultFeeStatus;
  keyword?: string;
}

/** 发起收费（可一次发起多笔，如转正式的全款 4 笔） */
export interface ConsultFeeCreatePayload {
  consultStudentId: string;
  /** 费用类型列表，金额由财务费用标准决定，前端不传金额 */
  feeTypes: FeeType[];
  /** 缴费方式 */
  payMethod?: string;
  /**
   * ★ 2026-10-15 金额自定义（单位：分），key = feeType
   *
   * 传了就用传入值，没传仍按财务「费用标准」取值 —— 规则2 保持不变，
   * 只是给老师开一个「本次实际收了多少就填多少」的口子。
   *
   * 目前前端只开放「试学费」可改（试学金额常因优惠/减免而变），
   * 正式学费六项仍按标准取，不传本字段。
   */
  amountByType?: Record<number, number>;
  /**
   * ★ 2026-10-19 用户口径：「只要缴费就要有凭证」。
   *    发起收费必须带缴费凭证，建单时直接落库（财务侧即为待核对）。
   */
  voucherUrl?: string;
  voucherNo?: string;
}

/**
 * 转正式缴费模式
 *
 * ⚠️ 对应流程图「是否一次性付清学费」这个决策点：
 *    · FULL        是 —— 一次性缴清全款 4 笔，全部到账后转正式
 *    · INSTALLMENT 否 —— 分笔补缴，咨询老师勾选本次要缴的类型，逐笔走财务
 */
export enum FormalPayMode {
  FULL = 'FULL',
  INSTALLMENT = 'INSTALLMENT',
}

export const FORMAL_PAY_MODE_NAME: Record<string, string> = {
  [FormalPayMode.FULL]: '一次性缴清',
  [FormalPayMode.INSTALLMENT]: '分笔补缴',
};

/** 转正式请求（流程图：是否一次性付清学费） */
export interface ConsultToFormalPayload {
  consultStudentId: string;
  /**
   * 缴费模式
   * ⚠️ 不传默认 FULL（保持向后兼容）
   */
  payMode?: FormalPayMode;
  /**
   * 分笔补缴时本次要缴的费用类型
   * ⚠️ 只有 payMode = INSTALLMENT 时才读这个字段；
   *    不传则默认全款 4 笔（等价于一次性）
   */
  feeTypes?: FeeType[];
}

/**
 * 补缴明细（流程图：「咨询老师统计补缴金额和类型」）
 *
 * ⚠️ 这就是流程图里那个「统计」动作的产物：
 *    前端拿到它，才能显示「还差多少、差哪几项」，让老师勾选本次缴哪几笔。
 */
export interface ConsultSupplementPlan {
  consultStudentId: string;
  /** 全款应缴总额（分） */
  totalAmount: number;
  /** 全款应缴明细 */
  items: Array<{
    feeType: FeeType;
    feeTypeName: string;
    /** 财务费用标准金额（分） */
    amount: number;
    /** 该类型当前状态 */
    state: 'ARRIVED' | 'PENDING' | 'REJECTED' | 'NOT_STARTED';
    /** 状态中文名（已到账 / 待确认 / 已驳回 / 未发起） */
    stateName: string;
  }>;
  /** 还差哪些类型没到账（= 未发起 或 已驳回，可以再次发起） */
  missing: FeeType[];
  missingAmount: number;
  /** 已到账金额（分） */
  arrivedAmount: number;
  /**
   * 在途金额（分）
   *
   * 已发起、等财务确认的单（含「待上传凭证」）合计。
   * ⚠️ 这部分【不算缺口】，不能再次发起；前端应显示「另有 X 元在途」，
   *    否则老师会以为系统漏了而重复建单。
   */
  inFlightAmount?: number;
  /** 是否全款到账（每一类都已到账才算，在途不算） */
  allArrived: boolean;
  /** 是否为分笔补缴中（已到账 0 < X < 全款） */
  isPartial: boolean;
}

/** 转正式结果 */
export interface ConsultToFormalResult extends ConsultFeeCreateResult {
  /** 本次实际发起的缴费模式 */
  payMode: FormalPayMode;
  /** 发起后的补缴缺口快照，前端直接刷新提示用 */
  planAfter: ConsultSupplementPlan;
  /**
   * ⚠️ 本次因「来源归属」未发起的类型（规则3-①）
   *
   * 全款 4 类里只有学费/试学费归咨询发起，住宿费/餐费/保险费归教务。
   * 这些不会报错，但必须【显式告诉老师】「这几项不归我发」，
   * 否则老师看到只发起了 1 笔会以为系统有 bug。
   */
  skipped?: Array<{ feeType: FeeType; feeTypeName: string; owner: string }>;
}

/** 一次发起多笔的返回 */
export interface ConsultFeeCreateResult {
  created: Array<{
    orderId: string;
    financeFeeId?: string;
    orderNo: string;
    feeType: FeeType;
    feeTypeName: string;
    amount: number;
    /** 建单是否成功；失败时 reason 有值 */
    success: boolean;
    reason?: string;
  }>;
  /** 整体提示，如「4 笔全部发起成功」 */
  message: string;
}

/** 上传缴费凭证 */
export interface ConsultVoucherUploadPayload {
  orderId: string;
  /** 凭证图片 URL（前端先传到 /api/consult/upload 拿到 URL） */
  voucherUrl: string;
  /** 转账单号 */
  voucherNo?: string;
}

/** 收款统计卡 */
export interface ConsultFeeStats {
  pendingCount: number;
  pendingAmount: number;
  arrivedCount: number;
  arrivedAmount: number;
  rejectedCount: number;
  voucherCount: number;
}

/* ============================================================
 * 三、退费单（试学阶段流失）
 * ============================================================ */

/** 一条扣减明细 */
export interface RefundDeductItem {
  /** 扣减项名称 */
  item: string;
  /** 计算方式说明，如「¥15/天 × 5 天」 */
  calc: string;
  /** 金额，单位：分 */
  amount: number;
}

/** 退费单 */
export interface ConsultRefundOrder {
  refundId: string;
  /** 退费单号 TK20261002-101 */
  refundNo: string;
  /** 财务侧退费单 id（上报后回填） */
  financeRefundId?: string;

  consultStudentId: string;
  studentName: string;
  studentNo?: string;
  className?: string;

  /* ---- 发起人与审批链 ---- */
  applyByName: string;
  applyByTitle: string;
  applyAt: string;
  /** 是否经理自审自批 */
  selfApprove: boolean;
  approveByName?: string;
  approveAt?: string;
  /** 经理驳回原因 */
  rejectReason?: string;

  /* ---- 试学消耗核算 ---- */
  trialStart?: string;
  trialEnd?: string;
  /** 试学天数 */
  trialDays: number;
  /** 已到账试学费，单位：分 */
  incomeAmount: number;
  /** 扣减明细 */
  deductItems: RefundDeductItem[];
  /** 扣减合计，单位：分 */
  deductTotal: number;
  /** 应退金额 = 已到账试学费 − 扣减合计，单位：分 */
  refundAmount: number;

  /* ---- 状态 ---- */
  status: ConsultRefundStatus;
  statusName: string;

  /* ---- 打款信息（财务侧回写） ---- */
  payByName?: string;
  payAt?: string;
  payMethod?: string;
  /** 打款流水号 */
  payRef?: string;
  /** 收款人信息，如「吕秀英 尾号 6673」 */
  payTo?: string;

  remark?: string;
  createTime: string;
}

/** 退费查询 */
export interface ConsultRefundQuery extends PageQuery {
  studentName?: string;
  refundNo?: string;
  ownerName?: string;
  className?: string;
  status?: ConsultRefundStatus;
  keyword?: string;
}

/** 申请退费（含试学天数与物品领用勾选） */
export interface ConsultRefundApplyPayload {
  consultStudentId: string;
  /** 试学开始日期 YYYY-MM-DD */
  trialStart: string;
  /** 试学结束日期 YYYY-MM-DD */
  trialEnd: string;
  /** 试学天数（前端可改，不传后端按日期算） */
  trialDays?: number;
  /** 勾选的物品领用名称列表（从字典表取，后端按名称查单价） */
  itemNames: string[];
  /** ★ 2026-10-08 勾选的每日消耗项 key（accommodation/meal/insurance），不传默认全选 */
  dailyItems?: string[];
  remark?: string;
}

/** 预计算退费金额（前端试算用，不落库） */
export interface ConsultRefundCalcPayload {
  consultStudentId: string;
  trialStart: string;
  trialEnd: string;
  trialDays?: number;
  itemNames?: string[];
  /** ★ 2026-10-08 勾选的每日消耗项 key（accommodation/meal/insurance），不传默认全选 */
  dailyItems?: string[];
}

/** 退费试算结果 */
export interface ConsultRefundCalcResult {
  trialDays: number;
  incomeAmount: number;
  deductItems: RefundDeductItem[];
  deductTotal: number;
  refundAmount: number;
  /** 可领用物品字典 */
  itemOptions: Array<{ name: string; price: number }>;
}

/** 退费统计卡 */
export interface ConsultRefundStats {
  pendingManagerCount: number;
  pendingFinanceCount: number;
  paidCount: number;
  rejectedCount: number;
  paidAmount: number;
}

/* ============================================================
 * 四、账号管理
 * ============================================================ */

/** 账号 */
export interface ConsultAccount {
  accountId: string;
  /** 登录账号 */
  account: string;
  /** 密码（仅列表页展示用，实际生产不该返回，演示环境保留） */
  password?: string;
  /** 姓名 */
  userName: string;
  /** 岗位名称 */
  roleTitle: string;
  /** 岗位代码 */
  role: ConsultRole;
  /** 对应全系统角色码 */
  roleCode?: RoleCode;
  dept?: string;
  phone?: string;
  /** 是否启用 */
  active: boolean;
  createdByName?: string;
  createTime: string;
  lastLogin?: string;
}

/** 账号查询 */
export interface ConsultAccountQuery extends PageQuery {
  userName?: string;
  account?: string;
  role?: ConsultRole;
  active?: boolean;
  keyword?: string;
}

/** 新建账号 */
export interface ConsultAccountSavePayload {
  account: string;
  password: string;
  userName: string;
  role: ConsultRole;
  dept?: string;
  phone?: string;
}

/** 账号统计 */
export interface ConsultAccountStats {
  total: number;
  active: number;
  inactive: number;
  /** 系统管理员数 */
  adminCount: number;
  managerCount: number;
  consultCount: number;
}

/* ============================================================
 * 五、登录
 * ============================================================ */

/** 登录请求 */
export interface ConsultLoginPayload {
  account: string;
  password: string;
}

/** 登录结果 */
export interface ConsultLoginResult {
  /**
   * 登录令牌（JWT · HS256）
   *
   * ⚠️ 三方清单第三节：payload 里必须能解出这 4 个字段 ——
   *    userId / roles / permissions / dataScope
   *    各业务模块（含实训 8004）从 token 里读它们，不再自己猜角色。
   */
  token: string;
  account: ConsultAccount;
  /** 该角色可见的菜单 key 列表 */
  menuKeys: string[];
  /**
   * 是否走了「本地兜底权限」
   *
   * ⚠️ true = 权限模块 8006 没连上（或该账号在权限库里没有档案），
   *    本次 token 里的 roles/permissions 是用本模块岗位角色换算出来的。
   *    前端应提示用户，避免「以为权限生效了」。
   */
  permDegraded?: boolean;
  /** 降级原因（permDegraded 为 true 时有值，供前端提示） */
  permTip?: string;
}

/* ============================================================
 * 六、审批中心
 * ============================================================ */

/** 待分配学生（审批：分配咨询老师） */
export interface PendingAssignItem {
  consultStudentId: string;
  studentName: string;
  phone?: string;
  source: string;
  sourceChannelName?: string;
  createTime: string;
  creatorName?: string;
}

/** 待我审批的退费申请 */
export interface PendingRefundItem {
  refundId: string;
  refundNo: string;
  consultStudentId: string;
  studentName: string;
  className?: string;
  applyByName: string;
  trialDays: number;
  deductTotal: number;
  refundAmount: number;
  status: ConsultRefundStatus;
  statusName: string;
  applyAt: string;
}

/** 审批中心汇总 */
export interface ApproveCenterData {
  pendingAssignList: PendingAssignItem[];
  pendingRefundList: PendingRefundItem[];
}

/** 分配咨询老师 */
export interface AssignOwnerPayload {
  consultStudentId: string;
  /** 咨询老师姓名；传「王经理（本人接待）」表示经理本人接待 */
  ownerName: string;
}

/** 面试结果提交 */
export interface InterviewResultPayload {
  consultStudentId: string;
  /** true=通过（进入收费环节） false=不通过（不收，不做统计） */
  pass: boolean;
  /** 不通过时的备注 */
  remark?: string;
}

/** 分配班级 */
export interface AssignClassPayload {
  consultStudentId: string;
  className: string;
}

/** 记录流失 */
export interface RecordLossPayload {
  consultStudentId: string;
  lossReason: string;
}

/* ============================================================
 * 七、流失记录
 * ============================================================ */

/** 流失记录项 */
export interface LossRecordItem {
  consultStudentId: string;
  studentName: string;
  ownerName?: string;
  lossReason: string;
  createTime: string;
}

/** 流失统计 */
export interface LossStats {
  /** 流失率百分比数值，如 15.4 */
  lossRate: number;
  lossCount: number;
  totalCount: number;
}

/**
 * 未报名·待跟进记录项（流程图「是否当场报名 → 否」）
 *
 * ⚠️ 与「流失」的区别：
 * - 未报名：当天没报，但可能二次来访，**不计入流失率**
 * - 流失：试学后转正式失败 / 明确不来，**计入流失率**
 *
 * 该状态下 `isRevisitable === true`，可调 `POST /student/revisit` 重新回到待面试。
 */
export interface NotEnrolledItem {
  consultStudentId: string;
  studentName: string;
  ownerName?: string;
  /** 未报名原因 */
  reason: string;
  /** 后续跟进计划（选填） */
  followUpPlan?: string;
  createTime: string;
}

/** 未报名列表查询（支持按姓名/负责老师/关键词过滤） */
export interface NotEnrolledQuery {
  studentName?: string;
  ownerName?: string;
  keyword?: string;
  /** 页码，从 1 开始 */
  page?: number;
  /** 每页条数 */
  size?: number;
}

/* ============================================================
 * 八、与财务模块协同（跨模块取数结果）
 * ============================================================ */

/**
 * 财务费用标准（本模块从财务 /standard/get 拿到后的内部视图）
 *
 * ⚠️ 用途：建费用单前先调财务拿金额，避免自己写死 ¥12800
 */
export interface FinanceStandardView {
  feeType: FeeType;
  feeTypeName: string;
  deptCode: DeptCode;
  deptName: string;
  /** 金额，单位：分 */
  amount: number;
  /** 该费用类型的凭证能否多人共用（餐费 true） */
  voucherReusable: boolean;
  /** 该费用类型应由哪个模块发起（1 咨询 / 2 教务 / 3 财务） */
  sourceModule: number;
  sourceModuleName: string;
}

/** 费用标准批量查询（一次拿全款 4 笔，省 4 次往返） */
export interface FinanceStandardBatchResult {
  list: FinanceStandardView[];
  /** 取数失败的项 */
  failed: Array<{ feeType: FeeType; feeTypeName: string; reason: string }>;
}

/**
 * 全款费用类型（转正式时应缴的全部）
 *
 * ⚠️ 注意：这 4 类里只有 学费/试学费 归咨询模块发起，
 *    住宿费/餐费/保险费 归教务模块（见 FEE_SOURCE_MODULE）。
 *    所以咨询侧「分笔补缴」实际上只能补学费 ——
 *    住宿费/餐费/保险要等教务模块发起，咨询侧负责跟踪缺口（见 ConsultSupplementPlan）。
 */
export const FULL_FEE_TYPES: FeeType[] = [
  FeeType.TUITION,
  FeeType.ACCOMMODATION,
  FeeType.MEAL,
  FeeType.INSURANCE,
];
