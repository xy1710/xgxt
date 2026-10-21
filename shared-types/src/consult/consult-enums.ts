/**
 * 市场咨询模块 · 专属枚举
 *
 * ⚠️ 本文件是【咨询模块自己】的枚举，不要往 enums.ts 里塞！
 *    原因：enums.ts 是全系统公共契约（铁律③：改它必须全员公告+重新编译）。
 *    咨询模块的内部流转状态属于本模块实现细节，放这里不影响其他 10 位同学。
 *
 * ⚠️ 但下面这些字段的取值必须与《01-公共数据字典.md》保持一致：
 *    StudentStatus / FeeType / PayStatus / DeptCode / RoleCode 一律从 enums.ts 引，不在这里重定义。
 */

/* ============================================================
 * 1. 学生来源（市场线索渠道）
 * ============================================================ */

/** 线索来源渠道 */
export enum LeadChannel {
  HOME_VISIT = 1,   // 家访
  ONLINE = 2,       // 线上咨询
  REFERRAL = 3,     // 转介绍
  WALK_IN = 4,      // 到校咨询
  PHONE = 5,        // 电话咨询
  OTHER = 9,        // 其他
}

export const LEAD_CHANNEL_NAME: Record<number, string> = {
  [LeadChannel.HOME_VISIT]: '家访',
  [LeadChannel.ONLINE]: '线上咨询',
  [LeadChannel.REFERRAL]: '转介绍',
  [LeadChannel.WALK_IN]: '到校咨询',
  [LeadChannel.PHONE]: '电话咨询',
  [LeadChannel.OTHER]: '其他',
};

/* ============================================================
 * 2. 咨询流转状态（原型里的「当前状态」，比 StudentStatus 更细）
 *
 * ⚠️ 为什么要单独一套？
 *    全系统 StudentStatus 只有 11 档（待咨询/咨询中/试学中/…），
 *    但咨询部门内部要区分「试学费待确认」「试学中待分班」「退费待经理审批」等，
 *    这样才能让列表的状态筛选标签有意义。
 *
 * ⚠️ 映射规则（backend 里用 CONSULT_TO_STUDENT_STATUS 转换）：
 *    咨询状态变化时，要同步调财务 /freeze/sync 与后续学籍模块，
 *    保证「休学 → 自动冻结」这条规则（规则1）在任何入口都能生效。
 * ============================================================ */

export enum ConsultState {
  WAIT_ASSIGN = 1,        // 待分配（招生老师录入，等经理分配）
  WAIT_INTERVIEW = 2,     // 待面试（已分配跟进人）
  /**
   * 咨询中（缴费阶段）
   *
   * ★ 2026-10-15 用户口径：面试通过并确认报名后即进入本状态 ——
   *   「没缴费」或「已缴费但财务还没确认到账」都算「咨询中」。
   *   财务确认到账后 → TRIAL_WAIT_CLASS（待分班）。
   * ⚠️ 本档覆盖「已发起收费等确认」与「还没发起收费」两种情形，
   *   列表筛选用它，不再对外暴露「试学费·待确认」这种内部叫法。
   */
  TRIAL_FEE_PENDING = 3,  // 咨询中（缴费未到账）
  TRIAL_WAIT_CLASS = 4,   // 待分班（费用已到账，等分班）
  TRIAL = 5,              // 试学中（已分班）
  FULL_FEE_PENDING = 6,   // 缴费中·待确认（转正式，补缴款项待确认）
  FORMAL = 7,             // 正式在读（全款到账）
  REFUND_MGR = 8,         // 退费·待经理审批
  REFUND_FINANCE = 9,     // 退费·待财务打款
  REFUNDED = 10,          // 已退费
  /**
   * 未报名·待跟进
   *
   * ⚠️ 流程图「是否当场报名 → 否」的分支：「记录未报名原因 + 后续跟进计划」
   *    与「流失」是两回事 ——
   *      · 未报名：暂时没报，**支持二次来访重新发起流程**，计入跟进待办，**不计入流失率**
   *      · 流失：明确不来了，计入流失统计
   *    混在一起会让流失率虚高，也看不到「还能捞回来」的名单。
   */
  NOT_ENROLLED = 11,      // 未报名·待跟进（可二次来访）
  LOST = 12,              // 流失（明确不来，计入流失统计）
  REJECTED = 13,          // 未通过（面试笔试不收，不计统计、不计流失）
}

export const CONSULT_STATE_NAME: Record<number, string> = {
  [ConsultState.WAIT_ASSIGN]: '待分配',
  [ConsultState.WAIT_INTERVIEW]: '待面试',
  [ConsultState.TRIAL_FEE_PENDING]: '咨询中',
  [ConsultState.TRIAL_WAIT_CLASS]: '待分班',
  [ConsultState.TRIAL]: '试学中',
  [ConsultState.FULL_FEE_PENDING]: '缴费中·待确认',
  [ConsultState.FORMAL]: '正式在读',
  [ConsultState.REFUND_MGR]: '退费·待经理审批',
  [ConsultState.REFUND_FINANCE]: '退费·待财务打款',
  [ConsultState.REFUNDED]: '已退费',
  [ConsultState.NOT_ENROLLED]: '未报名·待跟进',
  [ConsultState.LOST]: '流失',
  [ConsultState.REJECTED]: '未通过',
};

/** 前端状态筛选标签顺序（与原型 STATE_ORDER 一致，去掉「全部」） */
export const CONSULT_STATE_ORDER: ConsultState[] = [
  ConsultState.WAIT_ASSIGN,
  ConsultState.WAIT_INTERVIEW,
  ConsultState.TRIAL_FEE_PENDING,
  ConsultState.TRIAL_WAIT_CLASS,
  ConsultState.TRIAL,
  ConsultState.FULL_FEE_PENDING,
  ConsultState.FORMAL,
  ConsultState.REFUND_MGR,
  ConsultState.REFUND_FINANCE,
  ConsultState.REFUNDED,
  ConsultState.NOT_ENROLLED,
  ConsultState.LOST,
  ConsultState.REJECTED,
];

/**
 * 计入「流失统计」的状态
 *
 * ⚠️ 刻意排除 NOT_ENROLLED（未报名·待跟进）与 REJECTED（未通过）：
 *    · 未报名：还能二次来访捞回来，算流失会虚高
 *    · 未通过：流程图明确「不做统计、不计入流失」
 */
export const LOSS_STATES: ConsultState[] = [ConsultState.LOST];

/** 「可二次来访重新发起流程」的状态（未报名） */
export const REVISITABLE_STATES: ConsultState[] = [ConsultState.NOT_ENROLLED];

/**
 * 咨询状态 → 全系统学生学籍状态（StudentStatus）
 *
 * ⚠️ 用途：变更咨询状态时，把这个值作为 studentStatus 传给
 *    POST /api/finance/freeze/sync，让财务侧的「休学自动冻结」规则生效。
 */
export const CONSULT_TO_STUDENT_STATUS: Record<number, number> = {
  [ConsultState.WAIT_ASSIGN]: 1,        // 待咨询
  [ConsultState.WAIT_INTERVIEW]: 1,     // 待咨询
  [ConsultState.TRIAL_FEE_PENDING]: 3,  // 试学中（算在校生）
  [ConsultState.TRIAL_WAIT_CLASS]: 3,   // 试学中
  [ConsultState.TRIAL]: 3,              // 试学中
  [ConsultState.FULL_FEE_PENDING]: 4,   // 预在读
  [ConsultState.FORMAL]: 5,             // 正式在读
  [ConsultState.REFUND_MGR]: 3,         // 试学中（退费流程中仍在试学）
  [ConsultState.REFUND_FINANCE]: 3,     // 试学中
  [ConsultState.REFUNDED]: 7,           // 退学
  [ConsultState.NOT_ENROLLED]: 11,      // 流失（未报名，学籍上等同未入读）
  [ConsultState.LOST]: 11,              // 流失
  [ConsultState.REJECTED]: 11,          // 流失（未通过，不做统计但学籍上等同流失）
};

/* ============================================================
 * 3. 咨询模块内部岗位角色
 *
 * ⚠️ 与 enums.ts 的 RoleCode 对应关系：
 *    ADMIN   → ROLE_ADMIN     系统管理员
 *    MANAGER → 咨询经理（专属角色，全系统 RoleCode 里没有，用字符串标识）
 *    CONSULT → ROLE_CONSULT   咨询师
 *
 * ⚠️⚠️ 2026-10-02 调整：删除「财务专员（FINANCE）」角色
 *   原因：财务动作（确认到账 / 退费打款）不再由咨询模块内的角色承担，
 *        统一由【财务管理模块（05，端口 8005）】的账号执行。
 *        咨询模块只负责「发起」，财务模块负责「核对 / 出款」。
 *   影响：
 *     - 登录页不再展示财务专员演示账号
 *     - 账号管理页不再提供该角色选项
 *     - POST /api/consult/refund/pay（手工打款演示入口）改为仅管理员可用
 * ============================================================ */

/** 咨询模块可见的岗位（登录用） */
export enum ConsultRole {
  ADMIN = 'admin',       // 系统管理员
  MANAGER = 'manager',   // 咨询经理
  CONSULT = 'consult',   // 咨询师
}

export const CONSULT_ROLE_NAME: Record<string, string> = {
  [ConsultRole.ADMIN]: '系统管理员',
  [ConsultRole.MANAGER]: '咨询经理',
  [ConsultRole.CONSULT]: '咨询师',
};

/** 各岗位职责说明（账号管理页与登录页展示） */
export const CONSULT_ROLE_DESC: Record<string, string> = {
  [ConsultRole.ADMIN]: '账号管理：创建并分配各岗位登录账号、重置密码、停用离职账号',
  [ConsultRole.MANAGER]: '咨询师全部能力 + 审批权：分配咨询老师、审批退费明细（本人发起可自审自批）',
  [ConsultRole.CONSULT]: '接待 / 面试 / 收费 / 上传缴费截图 / 分班 / 转正式 / 发起试学流失退费申请',
};

/* ============================================================
 * 4. 咨询侧费用单状态
 *
 * ⚠️ 与财务 PayStatus 的对应关系（2026-10-04 起财务侧改了叫法，这里同步）：
 *    待确认(1)  → 财务侧 PayStatus.PAID(2)     财务侧显示「待核对」
 *    已到账(2)  → 财务侧 PayStatus.VERIFIED(3) 财务侧显示「已缴」
 *    已驳回(3)  → 财务侧 PayStatus.PAID(2)     被打回，等重新提交
 *
 * 💡 叫法对照（同一组状态值，两边视角不同）：
 *    值 2：咨询叫「待财务确认」 = 财务叫「待核对」（都是「凭证已交、等财务核」）
 *    值 3：咨询叫「已到账」     = 财务叫「已缴」（都是「财务核对通过、钱入账」）
 *
 * ⚠️ 咨询侧不自己改状态！一律以财务 /fee/list 返回的 payStatus 为准，
 *    只有「待上传凭证」是本模块自有的（财务侧还没有这张单）。
 * ============================================================ */

export enum ConsultFeeStatus {
  NO_VOUCHER = 0,   // 待上传凭证（本模块自有：已发起收费但还没传截图）
  PENDING = 1,      // 待确认（已传凭证，等财务核对）
  ARRIVED = 2,      // 已到账（财务核对通过）
  REJECTED = 3,     // 已驳回（财务打回，需重传）
}

export const CONSULT_FEE_STATUS_NAME: Record<number, string> = {
  [ConsultFeeStatus.NO_VOUCHER]: '待上传凭证',
  // ★ 2026-10-16 用户口径：对外叫法统一成「待财务确认」（原「待确认」太含糊）
  [ConsultFeeStatus.PENDING]: '待财务确认',
  [ConsultFeeStatus.ARRIVED]: '已到账',
  [ConsultFeeStatus.REJECTED]: '已驳回',
};

/* ============================================================
 * 5. 退费状态（咨询侧审批链，比财务 RefundStatus 短一截）
 *
 * ⚠️ 差异说明（重要，联调时注意）：
 *    财务模块 RefundStatus：1待提交→2待经理→3待教务核算→4待财务出款→6已退费→7已驳回
 *    咨询模块 ConsultRefundStatus：1待经理审批→2待财务打款→3已打款→4已驳回
 *
 *    两者是【上下游】关系，不是同一套：
 *    咨询侧「待财务打款(=2)」= 财务侧「待财务出款(=4)」上游。
 *    咨询审批通过后用 CONSULT_TO_FINANCE_REFUND_STATUS 映射后推给财务。
 * ============================================================ */

export enum ConsultRefundStatus {
  PENDING_MANAGER = 1,   // 待经理审批
  PENDING_FINANCE = 2,   // 待财务打款（经理已批，已上报财务）
  PAID = 3,              // 已打款
  REJECTED = 4,          // 已驳回
}

export const CONSULT_REFUND_STATUS_NAME: Record<number, string> = {
  [ConsultRefundStatus.PENDING_MANAGER]: '待经理审批',
  [ConsultRefundStatus.PENDING_FINANCE]: '待财务打款',
  [ConsultRefundStatus.PAID]: '已打款',
  [ConsultRefundStatus.REJECTED]: '已驳回',
};

/** 咨询退费状态 → 财务退费状态（上报财务时用） */
export const CONSULT_TO_FINANCE_REFUND_STATUS: Record<number, number> = {
  [ConsultRefundStatus.PENDING_MANAGER]: 1,   // 财务侧：待提交（还没上报）
  [ConsultRefundStatus.PENDING_FINANCE]: 4,   // 财务侧：待财务出款 ← 经理批准后上报
  [ConsultRefundStatus.PAID]: 6,              // 财务侧：已退费
  [ConsultRefundStatus.REJECTED]: 7,          // 财务侧：已驳回
};

/* ============================================================
 * 6. 试学期间消耗单价与物品领用（规则：退费扣减）
 *
 * ⚠️ 单价是【默认值】，实际以 t_consult_config 表里的配置为准。
 *    放在这里是为了让前端能直接引，不用等接口返回。
 * ============================================================ */

/** 试学期间每日消耗单价（单位：分/天） */
export const TRIAL_DAILY_RATE_CENT = {
  /** 住宿费 15 元/天 */
  accommodation: 1500,
  /** 餐费 28 元/天 */
  meal: 2800,
  /** 保险费 5 元/天（150 元/月折算） */
  insurance: 500,
} as const;

/** 试学期间消耗单价的展示名（顺序固定） */
export const TRIAL_RATE_ITEMS = [
  { key: 'accommodation', label: '住宿费', amount: 1500, calc: '¥15/天' },
  { key: 'meal', label: '餐费', amount: 2800, calc: '¥28/天' },
  { key: 'insurance', label: '保险费（试学期短期险）', amount: 500, calc: '¥5/天' },
] as const;

/**
 * 默认可领用物品清单（实际以 t_consult_consume_item 表为准）
 * 退费时勾选后计入扣减
 * ★ 2026-10-16 用户指令：取消「工具包」「宿舍门禁卡」
 */
export const DEFAULT_CONSUME_ITEMS = [
  { name: '校服', price: 12000 },
  { name: '被褥三件套', price: 15000 },
  { name: '教材资料', price: 6000 },
  { name: '军训服', price: 9000 },
] as const;

/* ============================================================
 * 7. 学生信息字段定义（信息完整度计算用）
 * ============================================================ */

/** 基本信息字段（市场/咨询首次接触学生时必须录入） */
export const BASE_FIELDS = [
  '姓名',
  '性别',
  '手机号',
  '来源',
  '意向课程',
  '家长联系人',
  '家长电话',
] as const;

/** 档案字段（后续完善，可交给班主任完善） */
export const EXTRA_FIELDS = [
  '身份证号',
  '就读/毕业学校',
  '家庭住址',
  '报考院校',
  '出生日期',
  '缴费方式',
  '备注',
] as const;

/**
 * 缴费方式（发起收费 / 确认到账时用）
 *
 * ★ 2026-10-15 用户口径：统一为这 5 项，页面上用下拉选择，不再手输。
 */
export const PAY_METHODS = [
  '微信支付',
  '支付宝支付',
  '银行卡转账',
  '现金',
  '其他',
] as const;

/** 流失原因选项 */
export const LOSS_REASONS = [
  '距离太远，通勤不便',
  '费用超出家庭预算',
  '选择了其他机构',
  '家长意向不明确',
  '其他原因',
] as const;
