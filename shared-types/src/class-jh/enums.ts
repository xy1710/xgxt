/**
 * 学管系统全局枚举
 *
 * ⚠️ 本文件的取值必须与《01-公共数据字典.md》完全一致
 * ⚠️ 修改本文件必须在群里公告，所有人重新 npm install + 编译
 * ⚠️ 维护人：王寒逸（登录/市场咨询）+ 林晓（权限）
 */

/** 性别 */
export enum Gender {
  MALE = 1,    // 男
  FEMALE = 2,  // 女
}

/** 部门 */
export enum DeptCode {
  JUNIOR_SENIOR = 1,  // 初高部
  UNIVERSITY = 2,     // 大学部
  /** ★ 2026-10-19 新增：就业部（独立学段「就业」） */
  EMPLOYMENT = 3,     // 就业部
  /** ★ 2026-10-20 新增：高中部（4；3 已被就业部占用） */
  SENIOR = 4,         // 高中部
}

/** 学生状态（全系统最重要的字段） */
export enum StudentStatus {
  WAIT_CONSULT = 1,   // 待咨询
  CONSULTING = 2,     // 咨询中
  TRIAL = 3,          // 试学中（算在校生）
  PRE_STUDY = 4,      // 预在读
  STUDYING = 5,       // 正式在读
  SUSPENDED = 6,      // 休学
  QUIT = 7,           // 退学
  TRAINING = 8,       // 实训中
  WAIT_EMPLOY = 9,    // 待就业
  EMPLOYED = 10,      // 已就业
  LOST = 11,          // 流失
}

/** 班级状态 */
export enum ClassStatus {
  OPEN = 1,       // 开放
  CLOSED = 2,     // 封班（只接受休学学生和末次班学生转入）
  GRADUATING = 3, // 待结业
  GRADUATED = 4,  // 已结业
}

/** 缴费类型 */
export enum FeeType {
  TUITION = 1,       // 学费
  ACCOMMODATION = 2, // 住宿费
  MEAL = 3,          // 餐费
  INSURANCE = 4,     // 保险费
  TRIAL_FEE = 5,     // 试学费
}

/** 缴费状态 */
export enum PayStatus {
  UNPAID = 1,    // 待缴
  PAID = 2,      // 已缴
  VERIFIED = 3,  // 已核对
  /**
   * 逾期（到期日已过、钱还没交）
   *
   * ★ 2026-10-20 补：库里的 `t_class_fee.pay_status` 列注释一直是
   *   「1待缴2已缴3已核对4逾期5冻结」，演示数据里也确实写着 4，
   *   但枚举里漏了 4 →
   *     ① nameOf 取不到名字，缴费状态列直接空白（用户反馈「有些人没有缴费状态」）；
   *     ② 「未结清」判断 UNPAID_STATUSES 也没算 4，逾期行不标「紧急」。
   */
  OVERDUE = 4,   // 逾期
  FROZEN = 5,    // 冻结
}

/** 退费状态（审批链，顺序不可变） */
export enum RefundStatus {
  DRAFT = 1,             // 待提交（班主任）
  PENDING_MANAGER = 2,   // 待经理审批
  PENDING_ACADEMIC = 3,  // 待教务核算
  PENDING_FINANCE = 4,   // 待财务出款
  PENDING_PRINCIPAL = 5, // 待校长审批（超阈值才有）
  REFUNDED = 6,          // 已退费
  REJECTED = 7,          // 已驳回
  /**
   * ★ 2026-10-09 新增：已撤回（申请人主动撤回）
   *
   * 【为什么加】「初高 / 大学 / 实训」三块合并时，退费审批链统一采用**实训那一套**，
   *   统一状态码用 `ApprovalStatus`（1 待提交 / 2 待学管 / 3 待校长 / 4 已通过 /
   *   5 已驳回 / 6 已撤销）。
   *   大学本来就有 WITHDRAWN = 8，**初高缺这个值** —— 缺了就没法把「统一 6 已撤销」
   *   翻回初高的原码，撤回动作落不了库。
   *
   * 【为什么值取 8】1~7 与大学**完全一致**（两套枚举本来就同值），大学 8 = WITHDRAWN
   *   → 初高补 8 后，两套枚举**逐值对齐**，统一码可以直接映射，不需要特例。
   *   仅改枚举常量，**表结构不受影响**（列是 int，老数据里不会出现 8）。
   */
  WITHDRAWN = 8,         // 已撤回（申请人主动撤回）
}

/** 休学/退学状态 */
export enum SuspendStatus {
  DRAFT = 1,            // 待提交
  PENDING_MANAGER = 2,  // 待经理审批
  APPROVED = 3,         // 已同意
  REJECTED = 4,         // 已驳回
  /**
   * ★ 2026-10-09 新增两个值：三块合并后，学籍异动审批链**统一采用实训那套**
   *   （休学/复学 1 步；退学 2 步：学管 → 校长）。
   *
   * 【为什么必须加】
   *   初高原来只有 4 个状态，**没有「待校长审批」**（它的退学只走经理一步）；
   *   也**没有「已撤回」**。统一链要用这两个状态，缺了就没法把统一码翻回初高的码。
   *
   * 【为什么值取 5 / 6】
   *   1~4 保持不变（**老数据全部兼容**，列是 int，老数据不会出现 5/6）。
   *   ⚠️ 注意大学的 `SuspendStatus` 里 5 = 已驳回 —— 两边值不同是**正常的**，
   *      它们是两个独立的枚举，靠 `t_teaching_conf.leave.statusMap` 各自的映射表翻译。
   */
  PENDING_PRINCIPAL = 5, // 待校长审批（新增；退学走这一步）
  WITHDRAWN = 6,         // 已撤回（新增）
}

/** 考试类型 */
export enum ExamType {
  MONTHLY = 1,    // 月考
  QUALITY = 2,    // 质素考核
  STAGE = 3,      // 阶段考核
  GRADUATION = 4, // 结业考试
  OTHER = 5,      // 其他
}

/** 考试结果 */
export enum ExamResult {
  PASS = 1,    // 通过（升班）
  FAIL = 2,    // 未通过（末班）
}

/** 权限动作 */
export enum PermAction {
  VIEW = 1,    // 查看
  ADD = 2,     // 新增
  EDIT = 3,    // 编辑
  DELETE = 4,  // 删除
  APPROVE = 5, // 审批
  EXPORT = 6,  // 导出
}

/** 数据范围 */
export enum DataScope {
  SELF = 1,   // 本人
  CLASS = 2,  // 本班级
  DEPT = 3,   // 本部门
  ALL = 4,    // 全部
}

/** 宿舍类型 */
export enum DormType {
  MALE_DORM = 1,   // 男宿舍
  FEMALE_DORM = 2, // 女宿舍
}

/** 申请状态（宿舍通用） */
export enum ApplyStatus {
  PENDING = 1,  // 待审核
  APPROVED = 2, // 已同意
  REJECTED = 3, // 已驳回
}

/** 考试内容类型 */
export enum ExamContentType {
  WRITTEN = 1, // 笔试
  MACHINE = 2, // 机试
  INTERVIEW = 3, // 面试
  OTHER = 4,   // 其他
}

/* ============================================================
 * 教学管理（初高）模块新增枚举 ★（见 ARCH §4.1 / §11 待登记清单）
 * 取值必须与《01-公共数据字典》及 ARCH §4.1 完全一致
 * ============================================================ */

/** 学习阶段（按部门区分，取值不重叠） */
export enum StageCode {
  PREPARATORY = 101,       // 预科
  JUNIOR_1 = 102,          // 初中部1期
  JUNIOR_2 = 103,          // 初中部2期
  JUNIOR_3 = 104,          // 初中部3期
  SENIOR_1 = 105,          // 高中部1期
  SENIOR_2 = 106,          // 高中部2期
  SENIOR_3 = 107,          // 高中部3期
  UNIV_1 = 201,            // 一阶段
  UNIV_2 = 202,            // 二阶段
  UNIV_3 = 203,            // 三阶段
  UNIV_4 = 204,            // 四阶段
}

/**
 * 末班阶段规则 ★
 *
 * 业务规则：学习阶段**除「1期」外都可以末班**——
 *   即 初中部1期（102）/ 高中部1期（105）不可末班，其余阶段均可。
 *
 * 前后端共用此判定，避免两处规则写得不一致。
 */
export function canRepeatByStage(stage?: number | null): boolean {
  return stage !== StageCode.JUNIOR_1 && stage !== StageCode.SENIOR_1;
}

/** 出勤状态 ★ */
export enum AttendanceStatus {
  PRESENT = 1,   // 出勤
  LATE = 2,      // 迟到
  SICK_LEAVE = 3, // 病假
  PERSONAL_LEAVE = 4, // 事假
  ABSENT = 5,    // 缺勤
}

/** 考试状态 ★ */
export enum ExamStatus {
  DRAFT = 1,     // 草稿
  SUBMITTED = 2, // 已提交
}

/** 就业协议状态 ★（本模块存档 + 只读展示） */
export enum AgreementStatus {
  UNSIGNED = 1,      // 未签订
  INTENT_PENDING = 2, // 意向待签
  SIGNED = 3,        // 已签订
}

/** 流程类型 ★ */
export enum FlowType {
  SUSPEND = 1,      // 休学
  RESUME = 2,       // 复学
  TRANSFER = 3,     // 升班转班
  HANDOVER = 4,     // 换人
  QUIT = 5,         // 退学
  AGREEMENT = 6,    // 就业协议
  REPEAT = 7,       // 末班
}

/** 交接岗位 ★ */
export enum HandoverRole {
  HEAD_TEACHER = 1, // 班主任
  TEACHER = 2,      // 教员
}

/** 催费触达渠道 ★ */
export enum ShareChannel {
  INNER_MESSAGE = 1, // 站内消息
  WECHAT = 2,        // 微信
  SMS = 3,           // 短信
}

/** 系统预置角色编码（不可修改） */
export enum RoleCode {
  ADMIN = 'ROLE_ADMIN',               // 系统管理员
  PRINCIPAL = 'ROLE_PRINCIPAL',       // 校长
  RECRUIT = 'ROLE_RECRUIT',           // 招生老师
  CONSULT = 'ROLE_CONSULT',           // 咨询老师
  HEAD_TEACHER = 'ROLE_HEAD_TEACHER', // 班主任
  TEACHER = 'ROLE_TEACHER',           // 教员
  ASSISTANT = 'ROLE_ASSISTANT',       // 助教
  QUALITY_MGR = 'ROLE_QUALITY_MGR',   // 教质经理
  ACADEMIC_MGR = 'ROLE_ACADEMIC_MGR', // 学术经理
  EDU_ADMIN = 'ROLE_EDU_ADMIN',       // 教务老师
  FINANCE = 'ROLE_FINANCE',           // 财务
  EMPLOYMENT = 'ROLE_EMPLOYMENT',     // 就业老师
}

/* ============================================================
 * 枚举中文名映射表
 *
 * ⚠️ 为什么要这玩意？
 * 后端返回 xxx: 1 和 xxxName: "男"，前端直接显示 xxxName。
 * 后端用下面的函数把数字转成中文，前端不用维护一份映射表。
 * ============================================================ */

export const GENDER_NAME: Record<number, string> = {
  [Gender.MALE]: '男',
  [Gender.FEMALE]: '女',
};

export const DEPT_NAME: Record<number, string> = {
  [DeptCode.JUNIOR_SENIOR]: '初高部',
  [DeptCode.UNIVERSITY]: '大学部',
  [DeptCode.EMPLOYMENT]: '就业部',
  [DeptCode.SENIOR]: '高中部',
};

export const STUDENT_STATUS_NAME: Record<number, string> = {
  [StudentStatus.WAIT_CONSULT]: '待咨询',
  [StudentStatus.CONSULTING]: '咨询中',
  [StudentStatus.TRIAL]: '试学中',
  [StudentStatus.PRE_STUDY]: '预在读',
  [StudentStatus.STUDYING]: '正式在读',
  [StudentStatus.SUSPENDED]: '休学',
  [StudentStatus.QUIT]: '退学',
  [StudentStatus.TRAINING]: '实训中',
  [StudentStatus.WAIT_EMPLOY]: '待就业',
  [StudentStatus.EMPLOYED]: '已就业',
  [StudentStatus.LOST]: '流失',
};

export const CLASS_STATUS_NAME: Record<number, string> = {
  [ClassStatus.OPEN]: '开放',
  [ClassStatus.CLOSED]: '封班',
  [ClassStatus.GRADUATING]: '待结业',
  [ClassStatus.GRADUATED]: '已结业',
};

/**
 * 班级是否接受普通转入。
 * ⚠️ 只有「1 开放」接受普通转入；封班(2)/待结业(3)/已结业(4) 一律拒绝。
 *    封班班级仅接受【休学复学】与【末班】转入，由调用方用 allowClosed 单独放行。
 */
export function classStatusAllowsIntake(classStatus: number | undefined | null): boolean {
  return Number(classStatus) === ClassStatus.OPEN;
}

export const FEE_TYPE_NAME: Record<number, string> = {
  [FeeType.TUITION]: '学费',
  [FeeType.ACCOMMODATION]: '住宿费',
  [FeeType.MEAL]: '餐费',
  [FeeType.INSURANCE]: '保险费',
  [FeeType.TRIAL_FEE]: '试学费',
};

/**
 * 缴费方式（★ 2026-10-20 催费页「登记缴费」）
 *
 * ⚠️ 别和 `FeeType`（缴费类型：学费/住宿费/餐费…）搞混：
 *   FeeType 是「交的是什么钱」，PayMethod 是「怎么交的」。
 *   用户口语把它叫「缴费类型」，但选项是 微信支付/支付宝/现金 —— 本质是支付方式，
 *   所以库里单开一列 `t_class_fee.pay_method`，绝不复用 `fee_type`（否则财务对账口径会乱）。
 */
export enum PayMethod {
  WECHAT = 1, // 微信支付
  ALIPAY = 2, // 支付宝
  CASH = 3,   // 现金
}

export const PAY_METHOD_NAME: Record<number, string> = {
  [PayMethod.WECHAT]: '微信支付',
  [PayMethod.ALIPAY]: '支付宝',
  [PayMethod.CASH]: '现金',
};

export const PAY_STATUS_NAME: Record<number, string> = {
  [PayStatus.UNPAID]: '待缴',
  [PayStatus.PAID]: '已缴',
  [PayStatus.VERIFIED]: '已核对',
  [PayStatus.OVERDUE]: '逾期',
  [PayStatus.FROZEN]: '冻结',
};

export const REFUND_STATUS_NAME: Record<number, string> = {
  [RefundStatus.DRAFT]: '待提交',
  [RefundStatus.PENDING_MANAGER]: '待经理审批',
  [RefundStatus.PENDING_ACADEMIC]: '待教务核算',
  [RefundStatus.PENDING_FINANCE]: '待财务出款',
  [RefundStatus.PENDING_PRINCIPAL]: '待校长审批',
  [RefundStatus.REFUNDED]: '已退费',
  [RefundStatus.REJECTED]: '已驳回',
  // ★ 2026-10-09：与大学对齐（三块合并后统一审批链需要）
  [RefundStatus.WITHDRAWN]: '已撤回',
};

export const SUSPEND_STATUS_NAME: Record<number, string> = {
  [SuspendStatus.DRAFT]: '待提交',
  [SuspendStatus.PENDING_MANAGER]: '待经理审批',
  [SuspendStatus.APPROVED]: '已同意',
  [SuspendStatus.REJECTED]: '已驳回',
  // ★ 2026-10-09：三块合并后学籍异动审批链统一（退学走校长、支持撤回）
  [SuspendStatus.PENDING_PRINCIPAL]: '待校长审批',
  [SuspendStatus.WITHDRAWN]: '已撤回',
};

export const EXAM_TYPE_NAME: Record<number, string> = {
  [ExamType.MONTHLY]: '月考',
  [ExamType.QUALITY]: '质素考核',
  [ExamType.STAGE]: '阶段考核',
  [ExamType.GRADUATION]: '结业考试',
  [ExamType.OTHER]: '其他',
};

export const EXAM_RESULT_NAME: Record<number, string> = {
  [ExamResult.PASS]: '通过',
  [ExamResult.FAIL]: '未通过',
};

export const APPLY_STATUS_NAME: Record<number, string> = {
  [ApplyStatus.PENDING]: '待审核',
  [ApplyStatus.APPROVED]: '已同意',
  [ApplyStatus.REJECTED]: '已驳回',
};

export const DORM_TYPE_NAME: Record<number, string> = {
  [DormType.MALE_DORM]: '男宿舍',
  [DormType.FEMALE_DORM]: '女宿舍',
};

/* ---------- 教学管理（初高）模块新增中文名映射 ★ ---------- */

/** 学习阶段中文名 101~107、201~204 */
export const STAGE_NAME: Record<number, string> = {
  [StageCode.PREPARATORY]: '预科',
  [StageCode.JUNIOR_1]: '初中部1期',
  [StageCode.JUNIOR_2]: '初中部2期',
  [StageCode.JUNIOR_3]: '初中部3期',
  [StageCode.SENIOR_1]: '高中部1期',
  [StageCode.SENIOR_2]: '高中部2期',
  [StageCode.SENIOR_3]: '高中部3期',
  [StageCode.UNIV_1]: '一阶段',
  [StageCode.UNIV_2]: '二阶段',
  [StageCode.UNIV_3]: '三阶段',
  [StageCode.UNIV_4]: '四阶段',
};

/** 出勤状态中文名 */
export const ATTENDANCE_STATUS_NAME: Record<number, string> = {
  [AttendanceStatus.PRESENT]: '出勤',
  [AttendanceStatus.LATE]: '迟到',
  [AttendanceStatus.SICK_LEAVE]: '病假',
  [AttendanceStatus.PERSONAL_LEAVE]: '事假',
  [AttendanceStatus.ABSENT]: '缺勤',
};

/** 考试状态中文名 */
export const EXAM_STATUS_NAME: Record<number, string> = {
  [ExamStatus.DRAFT]: '草稿',
  [ExamStatus.SUBMITTED]: '已提交',
};

/** 就业协议状态中文名 */
export const AGREEMENT_STATUS_NAME: Record<number, string> = {
  [AgreementStatus.UNSIGNED]: '未签订',
  [AgreementStatus.INTENT_PENDING]: '意向待签',
  [AgreementStatus.SIGNED]: '已签订',
};

/** 流程类型中文名 */
export const FLOW_TYPE_NAME: Record<number, string> = {
  [FlowType.SUSPEND]: '休学',
  [FlowType.RESUME]: '复学',
  [FlowType.TRANSFER]: '升班转班',
  [FlowType.HANDOVER]: '换人',
  [FlowType.QUIT]: '退学',
  [FlowType.AGREEMENT]: '就业协议',
  [FlowType.REPEAT]: '末班',
};

/** 交接岗位中文名 */
export const HANDOVER_ROLE_NAME: Record<number, string> = {
  [HandoverRole.HEAD_TEACHER]: '班主任',
  [HandoverRole.TEACHER]: '教员',
};

/** 催费触达渠道中文名（含历史渠道：老记录里的「站内消息」仍要能显示） */
export const SHARE_CHANNEL_NAME: Record<number, string> = {
  [ShareChannel.INNER_MESSAGE]: '站内消息',
  [ShareChannel.WECHAT]: '微信',
  [ShareChannel.SMS]: '短信',
};

/**
 * 催费推送「触达渠道」下拉的可选项（★ 2026-10-20 用户要求）
 *
 * 只保留 微信 / 短信 两个真实能触达家长的渠道；
 * 「站内消息」（码 1）从下拉里下线，但 SHARE_CHANNEL_NAME 里留着它 ——
 * 否则历史催费记录里的渠道名会显示成空白。
 *
 * ⚠️ 前端下拉、后端校验、自检脚本三处共用这一份口径，别各写一遍。
 */
export const SHARE_CHANNEL_PUSH_OPTIONS: Array<{ value: ShareChannel; label: string }> = [
  { value: ShareChannel.SMS, label: SHARE_CHANNEL_NAME[ShareChannel.SMS] },
  { value: ShareChannel.WECHAT, label: SHARE_CHANNEL_NAME[ShareChannel.WECHAT] },
];

/** 催费推送允许的渠道码（后端校验用，与下拉同源） */
export const SHARE_CHANNEL_PUSH_CODES: number[] = SHARE_CHANNEL_PUSH_OPTIONS.map((o) => o.value);

/** 考试内容类型中文名 */
export const EXAM_CONTENT_TYPE_NAME: Record<number, string> = {
  [ExamContentType.WRITTEN]: '笔试',
  [ExamContentType.MACHINE]: '机试',
  [ExamContentType.INTERVIEW]: '面试',
  [ExamContentType.OTHER]: '其他',
};

/**
 * 通用：把枚举数字转成中文名
 * 用法：nameOf(STUDENT_STATUS_NAME, 5) → '正式在读'
 */
export function nameOf(map: Record<number, string>, value: number | undefined | null): string {
  if (value === undefined || value === null) return '';
  return map[value] ?? String(value);
}
