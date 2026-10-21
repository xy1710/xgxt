/**
 * 学管系统全局枚举
 *
 * ⚠️ 本文件的取值必须与《01-公共数据字典.md》完全一致
 * ⚠️ 修改本文件必须在群里公告，所有人重新 npm install + 编译
 * ⚠️ 维护人：王寒逸（登录/市场咨询）+ 林晓（权限）
 *
 * ────────────────────────────────────────────────────────────
 * 【2026-09-29 变更公告 · 权限管理模块 林晓】
 * RoleCode 由「ROLE_ 前缀的 12 个职位」改为「与权限体系原型一致的 14 个职位」。
 * 原因：权限管理模块的 PRD 与高保真原型定义了 14 个职位（含咨询经理 / 项目经理 /
 * 实训班主任等管理职位），与旧字典的 12 个职位无法一一对应。
 * 影响：登录模块（王寒逸）签发的 token 里 roles[] 取值为新编码。
 * 详见交付文档《字典变更公告》。
 * ────────────────────────────────────────────────────────────
 * 【2026-10-02 变更公告 ① · 权限管理模块 林晓】
 * RoleCode 新增 1 个成员：`TEACH_DEAN`（学管主任），14 → 15 个职位。
 * 依据《三方操作清单 · 职位编码统一》1.1：实训条线把「教质经理 + 学术经理」
 * 合并为「学管主任」，权限库原先没有这个编码。
 * 详见交付文档《docs/10-职位编码统一与实训权限点落地-20261002.md》。
 * ────────────────────────────────────────────────────────────
 * 【2026-10-02 变更公告 ② · 权限管理模块 林晓】
 * RoleCode **移除** 1 个成员：`TRAIN_HEAD`（实训班主任），15 → 14 个职位。
 * 依据《三方操作清单 · 职位编码统一》1.4 第 1 条（结论由「停用」升级为「去掉」）：
 * 该编码是 2026-09-29 建库时造的「自建职位」示例，不是学校里真实存在的岗位，
 * 且与 `TEACH_HEAD`（班主任）完全同权 —— 留着只会让同一批人出现两个编码。
 * ⚠️ **破坏性变更**：其他模块若还在 import / 判断 `RoleCode.TRAIN_HEAD`，
 *    或还在用 `isPresetRoleCode('TRAIN_HEAD')`，编译会直接报错，请一并删掉。
 * 影响：各模块需重新 npm install + 编译。
 * 详见交付文档《docs/11-去掉实训班主任职位-20261002.md》。
 * ────────────────────────────────────────────────────────────
 */

/* ============================================================
 * 一、全系统通用枚举（多模块共用）
 * ============================================================ */

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
  /** 补费（★ 2026-10-20 新增） */
  SUPPLEMENT = 8,    // 补费
}

/** 缴费状态 */
export enum PayStatus {
  UNPAID = 1,    // 待缴
  PAID = 2,      // 待核对（已上传凭证，等财务核对）
  VERIFIED = 3,  // 已缴（财务核对通过、已入账）
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

/**
 * 数据范围（行级权限）
 * ⚠️ 字典 4.13。以「数据权限（行级）」功能点的动作形式挂在职位上。
 */
export enum DataScope {
  SELF = 1,   // 本人
  CLASS = 2,  // 本班级
  DEPT = 3,   // 本部门
  ALL = 4,    // 全部数据
}

/* ============================================================
 * 二、权限管理模块专有枚举
 * ============================================================ */

/**
 * 权限动作基类（字典 4.12 permAction）
 *
 * ⚠️ 重要设计说明（权限模块 林晓，2026-09-29）：
 *   原型里的权限动作是「细粒度中文动作」—— 例如「导入」「分配咨询老师」
 *   「录入笔试结果」「确认出款」等，远超字典 4.12 的 6 个。
 *   处理方式：**两级动作模型**
 *     · actionCode —— 细粒度动作编码（业务实际用的，存字符串）
 *     · baseAction —— 归入字典 4.12 的 6 个基类之一（供跨模块统一判定）
 *   这样既不破坏字典语义，又能表达真实的业务动作。
 */
export enum PermBaseAction {
  VIEW = 1,    // 查看（含各种「查看XX」「导出」以外的读取类动作）
  ADD = 2,     // 新增（含导入、上传、录入）
  EDIT = 3,    // 编辑（含各类修改、标记、分派、调整）
  DELETE = 4,  // 删除（含冻结、停用等失效类动作）
  APPROVE = 5, // 审批（含同意、驳回、提交、核算、出款、核对）
  EXPORT = 6,  // 导出
}

/**
 * 【向后兼容别名】字典 4.12 里这个枚举原名就叫 `PermAction`。
 *
 * ⚠️ 取值完全没变（VIEW=1 … EXPORT=6），所以保留别名后，
 *    其他模块 `import { PermAction } from 'shared-types'` 的代码**不用改也不会坏**。
 *    新代码请写 `PermBaseAction` —— 新名字更准确：它是「动作的基类」，
 *    而系统里真实的动作有 157 个（见 PermActionItem）。
 *
 * @deprecated 请使用 PermBaseAction
 */
export { PermBaseAction as PermAction };

/** 职位类型（原型 14 职位的四类划分） */
export enum RoleType {
  BUSINESS = '业务职位',
  MANAGE = '管理职位',
  FUNCTION = '职能职位',
  SYSTEM = '系统职位',
}

/** 职位状态 */
export enum RoleStatus {
  ENABLED = '启用',
  DISABLED = '停用',
}

/** 账号状态 */
export enum UserStatus {
  NORMAL = '正常',
  DISABLED = '已停用',
  LOCKED = '已锁定',
}

/** 部门层级 */
export enum DeptLevel {
  SCHOOL = 1,  // 校级
  DEPT = 2,    // 部门
  STAGE = 3,   // 学段（教学部下设）
}

/** 操作日志结果 */
export enum LogResult {
  SUCCESS = '成功',
  FAIL = '失败',
}

/** 规则配置分组 */
export enum RuleGroup {
  PWD = 'pwd',           // 密码策略
  LOGIN = 'login',       // 登录安全
  APPROVAL = 'approval', // 审批流程
}

/** 权限树模块 key（与 t_perm_menu.module_key 一致） */
export enum PermModuleKey {
  MARKET = 'market',
  TEACH = 'teach',
  TRAIN = 'train',
  JOB = 'job',
  ACAD = 'acad',
  FIN = 'fin',
  APPROVE = 'approve',
  PERM = 'perm',
}

/**
 * 系统预置职位编码（14 个，全部 isSys = true，不可删除，只能编辑权限或停用）
 *
 * ⚠️ 2026-10-02 起**不再有「自建职位示例」**：原 R14「实训班主任 TRAIN_HEAD」
 *    （建库时唯一 is_sys = false 的职位）已按《三方操作清单》1.4 结论删除。
 *    职位主键出现 `R01…R13、R15` 的断号属正常 —— 删掉的 R14 编码不再复用。
 * ⚠️ 因此「删除职位」在预置数据下没有可删对象（14 个全是预置）。
 *    演示删除功能时请现场新建一个自建职位，或临时把某个职位改成 is_sys = false。
 * ⚠️ 自定义职位编码规则：大写字母/数字/下划线，正则 ^[A-Z][A-Z0-9_]*$
 *
 * ────────────────────────────────────────────────────────────
 * 【2026-10-02 变更 · 权限管理模块 林晓】
 * 依据《三方操作清单 · 职位编码统一》第一节 1.1 + 《实训模块权限点申请单》第二节：
 * 新增 `TEACH_DEAN`（学管主任）。实训条线 2026-09-30 已把「教质经理 + 学术经理」
 * 合并为「学管主任」，权限库里没有这个职位 → 这批人一个权限都没有。
 * ⚠️ TEACH_QTY / ACAD_MANAGER 两个旧编码**保留**（只读历史数据用），
 *    与 TEACH_DEAN 的映射关系待双方最终拍板。
 *
 * 依据同清单第一节 1.4 第 1 条：**移除** `TRAIN_HEAD`（实训班主任，原 R14）。
 * ────────────────────────────────────────────────────────────
 */
export enum RoleCode {
  MKT_CONSULT = 'MKT_CONSULT',     // 咨询老师
  MKT_MANAGER = 'MKT_MANAGER',     // 咨询经理
  TEACH_HEAD = 'TEACH_HEAD',       // 班主任
  TEACH_TUTOR = 'TEACH_TUTOR',     // 教员
  TEACH_ASSIST = 'TEACH_ASSIST',   // 助教
  TEACH_QTY = 'TEACH_QTY',         // 教质经理（保留，只读历史数据）
  ACAD_MANAGER = 'ACAD_MANAGER',   // 学术经理（保留，只读历史数据）
  TEACH_DEAN = 'TEACH_DEAN',       // 学管主任（2026-10-02 新增）
  ACAD_STAFF = 'ACAD_STAFF',       // 教务老师
  FIN_STAFF = 'FIN_STAFF',         // 财务
  JOB_STAFF = 'JOB_STAFF',         // 就业老师
  RM_PROJECT = 'RM_PROJECT',       // 项目经理
  RM_PRINCIPAL = 'RM_PRINCIPAL',   // 校长
  SYS_ADMIN = 'SYS_ADMIN',         // 系统管理员
}

/* ============================================================
 * 三、枚举中文名映射表
 *
 * ⚠️ 为什么要这玩意？
 * 后端返回 xxx: 1 和 xxxName: "男"，前端直接显示 xxxName。
 * 后端用下面的映射把数字转成中文，前端不用维护一份映射表。
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
};

export const PAY_STATUS_NAME: Record<number, string> = {
  [PayStatus.UNPAID]: '待缴',
  [PayStatus.PAID]: '待核对',
  [PayStatus.VERIFIED]: '已缴',
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

export const DATA_SCOPE_NAME: Record<number, string> = {
  [DataScope.SELF]: '本人',
  [DataScope.CLASS]: '本班级',
  [DataScope.DEPT]: '本部门',
  [DataScope.ALL]: '全部数据',
};

export const DEPT_LEVEL_NAME: Record<number, string> = {
  [DeptLevel.SCHOOL]: '校级',
  [DeptLevel.DEPT]: '部门',
  [DeptLevel.STAGE]: '学段',
};

export const PERM_BASE_ACTION_NAME: Record<number, string> = {
  [PermBaseAction.VIEW]: '查看',
  [PermBaseAction.ADD]: '新增',
  [PermBaseAction.EDIT]: '编辑',
  [PermBaseAction.DELETE]: '删除',
  [PermBaseAction.APPROVE]: '审批',
  [PermBaseAction.EXPORT]: '导出',
};

/** 职位编码 → 中文职位名（预置职位，后端双返回用） */
export const ROLE_CODE_NAME: Record<string, string> = {
  [RoleCode.MKT_CONSULT]: '咨询老师',
  [RoleCode.MKT_MANAGER]: '咨询经理',
  [RoleCode.TEACH_HEAD]: '班主任',
  [RoleCode.TEACH_TUTOR]: '教员',
  [RoleCode.TEACH_ASSIST]: '助教',
  [RoleCode.TEACH_QTY]: '教质经理',
  [RoleCode.ACAD_MANAGER]: '学术经理',
  [RoleCode.TEACH_DEAN]: '学管主任',
  [RoleCode.ACAD_STAFF]: '教务老师',
  [RoleCode.FIN_STAFF]: '财务',
  [RoleCode.JOB_STAFF]: '就业老师',
  [RoleCode.RM_PROJECT]: '项目经理',
  [RoleCode.RM_PRINCIPAL]: '校长',
  [RoleCode.SYS_ADMIN]: '系统管理员',
};

/** 判断是否为系统预置职位编码（预置不可删除） */
export function isPresetRoleCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_CODE_NAME, code);
}

/**
 * 通用：把枚举值转成中文名
 * 用法：nameOf(STUDENT_STATUS_NAME, 5) → '正式在读'
 */
export function nameOf(
  map: Record<string | number, string>,
  value: string | number | undefined | null,
): string {
  if (value === undefined || value === null) return '';
  return map[value] ?? String(value);
}
