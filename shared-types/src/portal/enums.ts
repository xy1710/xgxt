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

/**
 * 部门
 *
 * ★ 2026-10-20：「初高部」拆成「初中部」+「高中部」，1 沿用旧值改名、4 新增高中部（3 已给就业部）
 *   （与 consult/enums.ts 保持一致，五份副本必须同步）
 */
export enum DeptCode {
  JUNIOR_SENIOR = 1,  // 初中部（历史命名，值不变）
  UNIVERSITY = 2,     // 大学部
  /** ★ 2026-10-19：就业部（独立学段，与 enums.ts 保持一致） */
  EMPLOYMENT = 3,     // 就业部
  SENIOR = 4,         // 高中部
}

/** 部门下拉顺序（初中部 → 高中部 → 大学部） */
export const DEPT_OPTIONS: number[] = [
  DeptCode.JUNIOR_SENIOR,
  DeptCode.SENIOR,
  DeptCode.UNIVERSITY,
];

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
  /** 押金（★ 2026-10-15 新增，与公共字典 enums.ts 同步） */
  DEPOSIT = 6,       // 押金
  /** 校服（★ 2026-10-15 新增，与公共字典 enums.ts 同步） */
  UNIFORM = 7,       // 校服
  /** 补费（★ 2026-10-20 新增：试学转正尾款 / 差额补收，金额由老师自定义） */
  SUPPLEMENT = 8,    // 补费
}

/** 缴费状态 */
export enum PayStatus {
  UNPAID = 1,    // 待缴
  PAID = 2,      // 待核对（已上传凭证，等财务核对）
  VERIFIED = 3,  // 已缴（财务核对通过、已入账）
  FROZEN = 5,    // 冻结
}

/**
 * 缴费单来源模块
 *
 * 费用单不是财务自己造出来的，而是由上游模块发起：
 *   - 咨询模块：学生报名 → 产生试学费 / 正式学费
 *   - 教务模块：学生入班 → 产生餐费 / 住宿费 / 保险费
 *   - 财务自建：补录、调整等场景
 *
 * ⚠️ 来源决定了「谁负责上传凭证」和「凭证能不能复用」，见 FEE_SOURCE_MODULE。
 */
export enum SourceModule {
  CONSULT = 1,  // 咨询模块
  EDU = 2,      // 教务模块
  FINANCE = 3,  // 财务自建
}

/**
 * 费用类型 → 应有的来源模块
 *
 * 这是「规则」的单一事实来源：后端按它校验，前端按它显示，
 * 其他模块也可以引它来判断某类费用该由谁发起。
 */
export const FEE_SOURCE_MODULE: Record<number, SourceModule> = {
  [FeeType.TUITION]: SourceModule.CONSULT,        // 正式学费 ← 咨询
  [FeeType.TRIAL_FEE]: SourceModule.CONSULT,      // 试学费   ← 咨询
  [FeeType.ACCOMMODATION]: SourceModule.CONSULT,  // 住宿费   ← 咨询（★ 2026-10-15 改：正式学费六项都由咨询发起）
  [FeeType.MEAL]: SourceModule.CONSULT,           // 餐费     ← 咨询（同上）
  [FeeType.INSURANCE]: SourceModule.CONSULT,      // 保险费   ← 咨询（同上）
  [FeeType.DEPOSIT]: SourceModule.CONSULT,        // 押金     ← 咨询（★ 2026-10-15 新增类型）
  [FeeType.UNIFORM]: SourceModule.CONSULT,        // 校服     ← 咨询（同上）
};

/**
 * 允许「多人共用同一张凭证」的费用类型
 *
 * 业务背景：餐费常由宿舍/小组统一代缴，一笔转账截图要能挂到多个学生的餐费单上。
 * 其他费用（学费、住宿费、保险、试学费）**一人一张凭证**，防止一票多报。
 *
 * ⚠️ 判断依据是「凭证唯一性」，实现见 fee.service.ts 的 checkVoucherUnique。
 *    餐费的共用额度不做数量限制，但每条单据金额独立、可分别核对。
 */
export const VOUCHER_REUSABLE_FEE_TYPES: number[] = [FeeType.MEAL];

/** 退费状态（审批链，顺序不可变） */
export enum RefundStatus {
  DRAFT = 1,             // 待提交（班主任）
  PENDING_MANAGER = 2,   // 待经理审批
  PENDING_ACADEMIC = 3,  // 待教务核算
  PENDING_FINANCE = 4,   // 待财务出款
  PENDING_PRINCIPAL = 5, // 待校长审批（超阈值才有）
  REFUNDED = 6,          // 已退费
  REJECTED = 7,          // 已驳回
}

/** 休学/退学状态 */
export enum SuspendStatus {
  DRAFT = 1,            // 待提交
  PENDING_MANAGER = 2,  // 待经理审批
  APPROVED = 3,         // 已同意
  REJECTED = 4,         // 已驳回
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
  MALE_DORM = 1,   // 男寝
  FEMALE_DORM = 2, // 女寝
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

/** 系统预置职位编码（不可修改） */
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
  [DeptCode.JUNIOR_SENIOR]: '初中部',
  [DeptCode.SENIOR]: '高中部',
  [DeptCode.UNIVERSITY]: '大学部',
  [DeptCode.EMPLOYMENT]: '就业部',
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

export const FEE_TYPE_NAME: Record<number, string> = {
  [FeeType.TUITION]: '学费',
  [FeeType.ACCOMMODATION]: '住宿费',
  [FeeType.MEAL]: '餐费',
  [FeeType.INSURANCE]: '保险费',
  [FeeType.TRIAL_FEE]: '试学费',
  [FeeType.SUPPLEMENT]: '补费',
  [FeeType.DEPOSIT]: '押金',
  [FeeType.UNIFORM]: '校服',
};

export const PAY_STATUS_NAME: Record<number, string> = {
  [PayStatus.UNPAID]: '待缴',
  [PayStatus.PAID]: '待核对',
  [PayStatus.VERIFIED]: '已缴',
  [PayStatus.FROZEN]: '冻结',
};

export const SOURCE_MODULE_NAME: Record<number, string> = {
  [SourceModule.CONSULT]: '咨询模块',
  [SourceModule.EDU]: '教务模块',
  [SourceModule.FINANCE]: '财务自建',
};

export const REFUND_STATUS_NAME: Record<number, string> = {
  [RefundStatus.DRAFT]: '待提交',
  [RefundStatus.PENDING_MANAGER]: '待经理审批',
  [RefundStatus.PENDING_ACADEMIC]: '待教务核算',
  [RefundStatus.PENDING_FINANCE]: '待财务出款',
  [RefundStatus.PENDING_PRINCIPAL]: '待校长审批',
  [RefundStatus.REFUNDED]: '已退费',
  [RefundStatus.REJECTED]: '已驳回',
};

export const SUSPEND_STATUS_NAME: Record<number, string> = {
  [SuspendStatus.DRAFT]: '待提交',
  [SuspendStatus.PENDING_MANAGER]: '待经理审批',
  [SuspendStatus.APPROVED]: '已同意',
  [SuspendStatus.REJECTED]: '已驳回',
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
  [DormType.MALE_DORM]: '男寝',
  [DormType.FEMALE_DORM]: '女寝',
};

/**
 * 通用：把枚举数字转成中文名
 * 用法：nameOf(STUDENT_STATUS_NAME, 5) → '正式在读'
 */
export function nameOf(map: Record<number, string>, value: number | undefined | null): string {
  if (value === undefined || value === null) return '';
  return map[value] ?? String(value);
}
