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
 * ★ 2026-10-20 用户口径：「初中部和高中部分开，换成初中部、高中部、大学部」
 *   → 原「初高部」拆成「初中部」+「高中部」，下拉顺序按 初中 → 高中 → 大学。
 *
 * ⚠️ 编码策略（值不动，避免洗数据）：
 *    1 沿用旧「初高部」的值，只改名成「初中部」——存量 dept_code=1 的学生直接落到初中部；
 *    4 新增「高中部」——刻意不占 2，否则大学部 dept_code=2 的历史数据（学生/班级/费用标准/账单）
 *      全都要迁移，风险和收益不匹配；也不能占 3，3 已经给了就业部（见下）。
 *
 * ⚠️ 编号不连续是刻意的：部门编码只要求唯一，**下拉顺序由 DEPT_OPTIONS 决定**，
 *    不靠编号大小排序，所以「初中1 → 高中4 → 大学2」完全正常。
 */
export enum DeptCode {
  JUNIOR_SENIOR = 1,  // 初中部（成员名是历史命名，值不变以兼容存量数据）
  UNIVERSITY = 2,     // 大学部
  /** ★ 2026-10-19 批注新增：就业部（独立学段「就业」，班级/学生同表按部门隔离） */
  EMPLOYMENT = 3,     // 就业部
  /**
   * ★ 2026-10-20 新增：高中部
   *
   * ⚠️ 2026-10-20 合并 PR#8 时与「就业部」撞号：两边都想用 3。
   *    处理结果：就业部保留 3（已合入 main 的公共契约不动），高中部改用 4，
   *    避免同一份字典里一个数字对应两个部门。
   */
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
  /**
   * 押金
   *
   * ★ 2026-10-15 用户口径：正式学费改为「计算形式」的多选，
   *   其中「押金 200」在系统里原先没有对应类型，故新增。
   *   ⚠️ 这是公共契约的新增项（铁律③），涉及 enums.ts 的改动务必全员同步。
   */
  DEPOSIT = 6,       // 押金
  /** 校服（同上，2026-10-15 新增） */
  UNIFORM = 7,       // 校服
  /** 补费（★ 2026-10-20 新增：试学转正尾款 / 差额补收，金额由老师自定义） */
  SUPPLEMENT = 8,    // 补费
}

/** 缴费状态 */
export enum PayStatus {
  UNPAID = 1,    // 待缴
  PAID = 2,      // 已缴
  VERIFIED = 3,  // 已核对
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

/**
 * 系统预置角色编码
 *
 * ⚠️ 全系统统一字典（2026-10-02 对齐权限模块 8006）
 *    编码本身就是值（不带 ROLE_ 前缀），与其他模块逐字一致。
 *    见 docs/三方操作清单-角色编码统一-20261002.md
 */
export enum RoleCode {
  SYS_ADMIN = 'SYS_ADMIN',         // 系统管理员
  RM_PRINCIPAL = 'RM_PRINCIPAL',   // 校长
  MKT_CONSULT = 'MKT_CONSULT',     // 咨询老师
  // ★ 2026-10-08 补登：权限库里有、主包原先缺的三个码。
  //   补上来是为了让「代码枚举」与「权限库 role_code」在字典层面就能对上，
  //   减少只能靠别名桥接的错位面。（别名桥接仍保留，见 roleAlias.ts）
  MKT_MANAGER = 'MKT_MANAGER',     // ★ 咨询经理（权限库 R02）
  FIN_STAFF = 'FIN_STAFF',         // ★ 财务（权限库 R09）
  PERM_ADMIN = 'PERM_ADMIN',       // ★ 权限管理员（权限库 R16，2026-10-08 新建）
  TEACH_HEAD = 'TEACH_HEAD',       // 班主任
  TEACH_TUTOR = 'TEACH_TUTOR',     // 教员
  TEACH_ASSIST = 'TEACH_ASSIST',   // 助教
  // ⚠️「教质经理 / 学术经理」已【停用】—— 合并为「学管主任」。
  //    保留这两个码只为能读**历史数据**（老审批单/通知里存的就是它们），
  //    不再分配给任何人；新代码一律用 TEACH_DEAN。
  TEACH_QTY = 'TEACH_QTY',         // 教质经理（已停用）
  ACAD_MANAGER = 'ACAD_MANAGER',   // 学术经理（已停用）
  TEACH_DEAN = 'TEACH_DEAN',       // ★ 学管主任（取代上面两个）
  // ★ 2026-10-04 斌哥拍板：班主任按【阶段】拆成两个角色
  //   · TEACH_HEAD      = 班主任  → 只带【大学部】（阶段 1~206），看不到实训
  //   · PROJECT_MANAGER = 项目经理 → 只带【实训/就业】（阶段 13），看不到大学部
  //   为什么要拆：升实训后带的班变了（实训基地 vs 教室），
  //   一个人同时看两个阶段的名单会乱；且项目经理不能自己建实训班
  //   （实训班只能由大学班「升实训」产生）。
  PROJECT_MANAGER = 'PROJECT_MANAGER', // ★ 项目经理（实训阶段班主任）
  // ⚠️ 财务角色已【删除】（2026-09-30）：本模块「审批通过就结束」，
  //    出款是财务模块（8005）自己的事 —— 本系统不再有财务这个角色。
  ACAD_STAFF = 'ACAD_STAFF',       // 教务老师
  JOB_STAFF = 'JOB_STAFF',         // 就业老师
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

/**
 * 学历档位（★ 2026-10-04 统一数据源）
 *
 * 【为什么抽出来】之前三个页面各写一份字面量数组，而且**内容不一致**：
 *   StudentProfileDialog / ClassList  → 含「小学」
 *   archive/BasicInfo                → 少了「小学」
 * 同一字段三个口径，迟早出"这个页面能选、那个页面选不到"的怪事。
 * 枚举放 shared-types，各页面 import 同一份，改一次全生效。
 *
 * 【为什么是数组不是 map】学历是文字不是数字枚举，DB 里存的就是字符串本身。
 */
export const EDUCATION_LEVELS = ['小学', '初中', '高中', '中专', '大专', '本科', '硕士'] as const;

/**
 * 角色中文名（★ 唯一数据源）
 *
 * ⚠️ 为什么要有它（2026-10-02 踩到）：
 *   前端「顶栏显示当前身份」的地方原来自己写了一份 `ROLE_LABEL`，
 *   而且 key 是**不带引号的对象键**（`ROLE_ADMIN: '系统管理员'`）——
 *   上一轮「角色编码统一」用 `grep "'ROLE_"` 扫裸字符串时**正好扫不到它**，
 *   于是漏改了。后果：顶栏不再显示「就业老师」，而是直接显示 `JOB_STAFF`。
 *   → 结论：这种"枚举 → 中文名"的映射**只能有一份**，且必须跟枚举放在一起。
 */
export const ROLE_CODE_NAME: Record<string, string> = {
  [RoleCode.SYS_ADMIN]: '系统管理员',
  [RoleCode.RM_PRINCIPAL]: '校长',
  [RoleCode.MKT_CONSULT]: '咨询老师',
  [RoleCode.TEACH_HEAD]: '班主任',
  [RoleCode.TEACH_TUTOR]: '教员',
  [RoleCode.TEACH_ASSIST]: '助教',
  [RoleCode.TEACH_QTY]: '教质经理（已停用）',
  [RoleCode.ACAD_MANAGER]: '学术经理（已停用）',
  [RoleCode.TEACH_DEAN]: '学管主任',
  [RoleCode.PROJECT_MANAGER]: '项目经理',
  [RoleCode.ACAD_STAFF]: '教务老师',
  [RoleCode.JOB_STAFF]: '就业老师',
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
  [PayStatus.PAID]: '已缴',
  [PayStatus.VERIFIED]: '已核对',
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

/** 考试内容类型中文映射 */
export const EXAM_CONTENT_TYPE_NAME: Record<number, string> = {
  [ExamContentType.WRITTEN]: '笔试',
  [ExamContentType.MACHINE]: '机试',
  [ExamContentType.INTERVIEW]: '面试',
  [ExamContentType.OTHER]: '其他',
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

/* ============================================================
 * 班级信息管理 + 出勤管理（就业管理 > 实训阶段）
 *
 * ⚠️ 注意：ClassStatus / CLASS_STATUS_NAME 上面已经有了，这里不重复定义，
 *    直接复用（1开放 2封班 3待结业 4已结业）。
 * ============================================================ */

/** 班级阶段 */
export enum ClassStage {
  FIRST = 1,
  SECOND = 2,
  THIRD = 3,
}

/**
 * 班级阶段显示名
 *
 * ⚠️ ★ 2026-10-04 补齐：原来只有一/二/三阶段，导致
 *   四~六阶段（大学部后期）和 **13 实训** 的 stageName 取不到 → 前端显示空白，
 *   看着像「没数据」。升实训后项目经理在列表上尤其明显（阶段列空白）。
 *   阶段编号两套：初高部 1~6 · 教务/就业 7~13 · 班级库 201~206
 */
export const CLASS_STAGE_NAME: Record<number, string> = {
  [ClassStage.FIRST]: '一阶段',
  [ClassStage.SECOND]: '二阶段',
  [ClassStage.THIRD]: '三阶段',
  4: '四阶段',
  5: '五阶段',
  6: '六阶段',
  7: '第一阶段',
  8: '第二阶段',
  9: '第三阶段',
  10: '第四阶段',
  11: '第五阶段',
  12: '第六阶段',
  13: '实训',
};

/** 入班方式 */
export enum JoinType {
  /** 新生入班 */
  NEW = 1,
  /** 换班转入 */
  TRANSFER_IN = 2,
  /** 末班转入（考试不合格重修） */
  REPEAT_IN = 3,
  /** 休学复学 */
  RESUME = 4,
}

export const JOIN_TYPE_NAME: Record<number, string> = {
  [JoinType.NEW]: '新生入班',
  [JoinType.TRANSFER_IN]: '换班转入',
  [JoinType.REPEAT_IN]: '末班转入',
  [JoinType.RESUME]: '休学复学',
};

/** 离班方式 */
export enum LeaveType {
  /** 换班转出 */
  TRANSFER_OUT = 1,
  /** 末班转出（考试不合格重修） */
  REPEAT_OUT = 2,
  /** 休学 */
  SUSPEND = 3,
  /** 退学 */
  QUIT = 4,
  /** 结业 */
  GRADUATE = 5,
}

export const LEAVE_TYPE_NAME: Record<number, string> = {
  [LeaveType.TRANSFER_OUT]: '换班转出',
  [LeaveType.REPEAT_OUT]: '末班转出',
  [LeaveType.SUSPEND]: '休学',
  [LeaveType.QUIT]: '退学',
  [LeaveType.GRADUATE]: '结业',
};

/** 花名册在班状态 */
export enum ClassStudentStatus {
  /** 在班 */
  IN = 1,
  /** 已离班 */
  LEFT = 2,
}

export const CLASS_STUDENT_STATUS_NAME: Record<number, string> = {
  [ClassStudentStatus.IN]: '在班',
  [ClassStudentStatus.LEFT]: '已离班',
};

/** 出勤状态 */
export enum AttendStatus {
  /** 出勤（算到校） */
  PRESENT = 1,
  /** 缺勤 */
  ABSENT = 2,
  /** 迟到（算到校） */
  LATE = 3,
  /** 早退（算到校） */
  EARLY_LEAVE = 4,
  /** 请假 */
  LEAVE = 5,
  /** 事假 */
  PERSONAL_LEAVE = 6,
  /** 病假 */
  SICK_LEAVE = 7,
}

export const ATTEND_STATUS_NAME: Record<number, string> = {
  [AttendStatus.PRESENT]: '出勤',
  [AttendStatus.ABSENT]: '缺勤',
  [AttendStatus.LATE]: '迟到',
  [AttendStatus.EARLY_LEAVE]: '早退',
  [AttendStatus.LEAVE]: '请假',
  [AttendStatus.PERSONAL_LEAVE]: '事假',
  [AttendStatus.SICK_LEAVE]: '病假',
};

/**
 * 哪些出勤状态算「到校」（分子）
 * 出勤 / 迟到 / 早退 = 人来了
 */
export const ATTEND_STATUS_PRESENT_SET: readonly number[] = [
  AttendStatus.PRESENT,
  AttendStatus.LATE,
  AttendStatus.EARLY_LEAVE,
];

/** 请假类状态（需要填原因） */
export const ATTEND_STATUS_LEAVE_SET: readonly number[] = [
  AttendStatus.LEAVE,
  AttendStatus.PERSONAL_LEAVE,
  AttendStatus.SICK_LEAVE,
];

/* ============================================================
 * 班级交接（就业管理-实训）
 * 一次交接 = 一个班换负责人（老师层面），学生不动
 * ⚠️ 与「学生换班」「末班」区分：那些是学生层面的转班
 * ============================================================ */

/** 交接原因类型 */
export enum TransferType {
  /** 调岗 */
  REASSIGN = 1,
  /** 离职 */
  RESIGN = 2,
  /** 排课调整 */
  SCHEDULE = 3,
  /** 组织调整 */
  ORG_CHANGE = 4,
  /** 其他 */
  OTHER = 5,
  /**
   * ★ 升学转班（第 4 期第 2 批新增，斌哥拍板）
   *
   * 【为什么必须单开一档，不能塞进 5=其他】
   *   1~5 这五档说的是**岗位交接**（老师换岗、离职、调课），
   *   而 `class/modules/approval/upgrade.route.ts` 往这张表写的是
   *   **学生升学转班**（学生从 202阶段 升到下一阶段，班级换了）。
   *   两件事共用 `transfer_type` 一列，但含义完全不同。
   *   塞进「其他」的代价：以后按字典做报表时，
   *   「升学转班」和真正的「其他」混在一起，**数据一旦被解读就是错的**，
   *   而且这种错很难发现（数字看着都对，只是含义偏了）。
   *   → 这就是七铁律第④条「语义冲突列必须分列」的典型场景。
   *
   * 【为什么是 6 而不是重新编号】
   *   1~5 已经有种子数据在用（6 行 transfer_type=1），重编号会打断存量数据。
   *   → 只在末尾追加，老码含义一个不动。
   */
  CLASS_UPGRADE = 6,
  /**
   * 学生换班（第 4 期第 6 批新增）
   *
   * 【★ 为什么咨询域要单开一档，而不是复用 CLASS_UPGRADE】
   *   咨询域 `class/modules/consult` 的「接收」会把**换班转入**的学员
   *   追加一条留痕到 `t_uni_class_transfer`（老表 `t_class_student_transfer`）。
   *   它和「升学转班」看起来都是换班，但问的问题不同：
   *     · 升学转班(6) = 学生从 202 阶段 升到下一阶段（跨学段，有学段变化）
   *     · 学生换班(7) = 同学段内换一个班（跨班，无学段变化）
   *   → 报表要分开统计时只能靠这一档区分，塞在一起就再也拆不开。
   *
   * 【★ 注意：这张表现在被三件事共用】
   *   ① 岗位交接（班级域）     → transfer_type=1 + post_transfer_type
   *   ② 升学转班（学生域）     → transfer_type=6
   *   ③ 学生换班（咨询域，本档）→ transfer_type=7
   *   三者都写同一张统一表，靠 `transfer_type` 区分事件性质
   *   （老表 `t_class_transfer` / `t_class_student_transfer` 是两张物理表）。
   */
  STUDENT_CLASS_CHANGE = 7,
}

export const TRANSFER_TYPE_NAME: Record<number, string> = {
  [TransferType.REASSIGN]: '调岗',
  [TransferType.RESIGN]: '离职',
  [TransferType.SCHEDULE]: '排课调整',
  [TransferType.ORG_CHANGE]: '组织调整',
  [TransferType.OTHER]: '其他',
  // ★ 第 4 期第 2 批新增：学生升学转班（枚举说明见上方 CLASS_UPGRADE）
  [TransferType.CLASS_UPGRADE]: '升学转班',
  // ★ 第 4 期第 6 批新增：咨询域「接收」写入的换班留痕（说明见上方STUDENT_CLASS_CHANGE）
  [TransferType.STUDENT_CLASS_CHANGE]: '学生换班',
};

/* ============================================================
 * 班级岗位交接 —— `post_transfer_type` 列（第 4 期第 4 批新增）
 * ============================================================
 *
 * 【★★ 为什么必须单独一列，不能塞进 `TransferType`】
 *   `t_uni_class_transfer` 被两件不同的事共用：
 *     ① 岗位交接 —— 老表存的是**岗位名** headTeacher/teacher/assistant
 *        → 问的是「换的是哪个岗位的人」
 *     ② 学生升学转班 —— 统一表存的是**事由** 1~6
 *        → 问的是「为什么换」
 *   同一个问题塞两件事，就是七铁律第④条说的「语义冲突列」。
 *   实测症状：`Incorrect integer value: 'headTeacher' for column
 *   sms_common.t_uni_class_transfer.transfer_type`。
 *
 * 【★ 斌哥 2026-10-11 拍板方案 B（拆列），不是方案 A（加 7/8/9 三档字典）】
 *   → `transfer_type` 回归「事由」语义（岗位交接统一填 1=调岗）
 *   → 新列 `post_transfer_type` 专门回答「换的是哪个岗位」
 *   → 统计「本月几次班主任交接」直接 `where post_transfer_type = 1`，
 *     不用 like、不用靠人工解释历史数据。
 *
 * 【★ 为什么不塞进备注/remark —— 那是方案 C，已被否】
 *   岗位变文本后统计只能 `like '%班主任%'`，数据质量取决于有没有人认真填备注，
 *   而且拆不回去。
 */
export enum ClassPostType {
  /** 班主任 */
  HEAD_TEACHER = 1,
  /** 教员 */
  TEACHER = 2,
  /** 助教 */
  ASSISTANT = 3,
}

export const CLASS_POST_TYPE_NAME: Record<number, string> = {
  [ClassPostType.HEAD_TEACHER]: '班主任',
  [ClassPostType.TEACHER]: '教员',
  [ClassPostType.ASSISTANT]: '助教',
};

/** 交接内容清单项（多选，勾了哪些就交哪些） */
export enum TransferItem {
  /** 学生名单 */
  STUDENTS = 1,
  /** 出勤记录 */
  ATTENDANCE = 2,
  /** 考试记录 */
  EXAMS = 3,
  /** 缴费情况 */
  FINANCE = 4,
  /** 宿舍情况 */
  DORM = 5,
  /** 其他 */
  OTHER = 9,
}

export const TRANSFER_ITEM_NAME: Record<number, string> = {
  [TransferItem.STUDENTS]: '学生名单',
  [TransferItem.ATTENDANCE]: '出勤记录',
  [TransferItem.EXAMS]: '考试记录',
  [TransferItem.FINANCE]: '缴费情况',
  [TransferItem.DORM]: '宿舍情况',
  [TransferItem.OTHER]: '其他',
};

/**
 * 通用：把枚举数字转成中文名
 * 用法：nameOf(STUDENT_STATUS_NAME, 5) → '正式在读'
 */
export function nameOf(map: Record<number, string>, value: number | undefined | null): string {
  if (value === undefined || value === null) return '';
  return map[value] ?? String(value);
}

/* ============================================================
 * 审批相关（2026-09-29 新增）
 * 退费 / 休学 / 退学 三个业务共用一套审批机制
 * ============================================================ */

/**
 * 审批业务类型
 *
 * ⚠️ 和 biz_type 字段的字符串值一一对应，别写错
 */
export enum ApprovalBizType {
  REFUND = 'refund',   // 退费
  SUSPEND = 'suspend', // 休学
  QUIT = 'quit',       // 退学
  DORM_CHANGE = 'dormChange', // 宿舍调换/退宿（2026-09-30 新增）
  RESUME = 'resume',   // 复学（2026-10-01 新增）
}

export const APPROVAL_BIZ_TYPE_NAME: Record<string, string> = {
  [ApprovalBizType.REFUND]: '退费',
  [ApprovalBizType.SUSPEND]: '休学',
  [ApprovalBizType.QUIT]: '退学',
  [ApprovalBizType.DORM_CHANGE]: '宿舍调换/退宿',
  [ApprovalBizType.RESUME]: '复学',
};

/* ============================================================
 * 宿舍管理（2026-09-30 新增）
 * ============================================================ */

/** 宿舍调换/退宿 业务类型 */
export enum DormChangeBizType {
  CHANGE = 1, // 调换宿舍
  CHECKOUT = 2, // 退宿
}

export const DORM_CHANGE_BIZ_TYPE_NAME: Record<number, string> = {
  [DormChangeBizType.CHANGE]: '调换宿舍',
  [DormChangeBizType.CHECKOUT]: '退宿',
};

/** 单号前缀 */
export const DORM_CHANGE_NO_PREFIX: Record<number, string> = {
  [DormChangeBizType.CHANGE]: 'DH',
  [DormChangeBizType.CHECKOUT]: 'TS',
};

/** 宿舍状态 */
export enum DormStatus {
  NORMAL = 1, // 正常
  DISABLED = 2, // 停用
}

export const DORM_STATUS_NAME: Record<number, string> = {
  [DormStatus.NORMAL]: '正常',
  [DormStatus.DISABLED]: '停用',
};

/** 床位状态 */
export enum DormBedStatus {
  FREE = 1, // 空闲
  USED = 2, // 已占用
  DISABLED = 3, // 停用
}

export const DORM_BED_STATUS_NAME: Record<number, string> = {
  [DormBedStatus.FREE]: '空闲',
  [DormBedStatus.USED]: '已占用',
  [DormBedStatus.DISABLED]: '停用',
};

/** 宿舍性别限制 —— 复用已有的 DormType（1男寝 2女寝），不再重复定义 */
export const DORM_GENDER_NAME: Record<number, string> = {
  [DormType.MALE_DORM]: '男生宿舍',
  [DormType.FEMALE_DORM]: '女生宿舍',
  0: '不限',
};

/* ============================================================
 * 催费管理（2026-09-30 新增）
 *
 * ⚠️ 类别和状态【这里已有定义】（见文件下方的 FeeCallCategory / FeeCallStatus），
 *    不再重复定义，避免 Duplicate identifier 编译错误。
 *    本模块直接复用：
 *      FeeCallCategory = 2住宿费 / 4保险费 / 3餐费（编码与 RefundType 对齐）
 *      FeeCallStatus   = 1待催缴 / 2催缴中 / 3已缴清
 * ============================================================ */

/**
 * 审批状态（通用）
 *
 * ⚠️ 和旧的 RefundStatus / SuspendStatus 不是一回事！
 *    旧的那两个是"按业务定制"的，各写各的；
 *    这个是"通用审批"的状态机，三个业务共用。
 *    新代码一律用这个，旧枚举保留仅为兼容。
 */
export enum ApprovalStatus {
  DRAFT = 1,             // 待提交（申请人还没提交，可随便改）
  PENDING_MANAGER = 2,   // 待学管审批
  PENDING_PRINCIPAL = 3, // 待校长审批
  APPROVED = 4,          // 已通过
  REJECTED = 5,          // 已驳回
  CANCELED = 6,          // 已撤销（申请人自己撤回）
}

export const APPROVAL_STATUS_NAME: Record<number, string> = {
  [ApprovalStatus.DRAFT]: '待提交',
  [ApprovalStatus.PENDING_MANAGER]: '待学管审批',
  [ApprovalStatus.PENDING_PRINCIPAL]: '待校长审批',
  [ApprovalStatus.APPROVED]: '已通过',
  [ApprovalStatus.REJECTED]: '已驳回',
  [ApprovalStatus.CANCELED]: '已撤销',
};

/** 审批动作 */
export enum ApprovalAction {
  SUBMIT = 1,  // 提交
  APPROVE = 2, // 同意
  REJECT = 3,  // 驳回
  CANCEL = 4,  // 撤回
}

export const APPROVAL_ACTION_NAME: Record<number, string> = {
  [ApprovalAction.SUBMIT]: '提交',
  [ApprovalAction.APPROVE]: '同意',
  [ApprovalAction.REJECT]: '驳回',
  [ApprovalAction.CANCEL]: '撤回',
};

/**
 * 休学/退学 业务类型
 *
 * ⚠️ 和 t_job_student_leave.biz_type 一一对应
 *    （同一张表，用这个字段区分是休学还是退学）
 */
export enum StudentLeaveBizType {
  SUSPEND = 1, // 休学
  QUIT = 2,    // 退学
  RESUME = 3,  // 复学（2026-10-01 新增）
}

export const STUDENT_LEAVE_BIZ_TYPE_NAME: Record<number, string> = {
  [StudentLeaveBizType.SUSPEND]: '休学',
  [StudentLeaveBizType.QUIT]: '退学',
  [StudentLeaveBizType.RESUME]: '复学',
};

/**
 * 单号前缀（按业务类型区分，方便肉眼认）
 *   休学 → XX
 *   退学 → TX
 */
export const STUDENT_LEAVE_NO_PREFIX: Record<number, string> = {
  [StudentLeaveBizType.SUSPEND]: 'XX',
  [StudentLeaveBizType.QUIT]: 'TX',
};

/** 退费类型（xmind：退费类型字段）*/
export enum RefundType {
  TUITION = 1,       // 学费
  ACCOMMODATION = 2, // 住宿费
  MEAL = 3,          // 餐费
  INSURANCE = 4,     // 保险费
  TRIAL_FEE = 5,     // 试学费
  /**
   * ★ 退学退费（2026-10-01 新增）
   *
   * 退学审批通过后系统自动生成**一张合并单**，同时含学费 + 住宿费 + 餐费。
   * 三项各自多少钱记在 t_job_refund 的 tuition_amount / accommodation_amount / meal_amount，
   * refund_amount = 三者之和。
   * 现有的"学费/住宿费/餐费"单选枚举框不住它，所以单列一个类型。
   */
  QUIT = 6,
  OTHER = 9,         // 其他
}

export const REFUND_TYPE_NAME: Record<number, string> = {
  [RefundType.TUITION]: '学费',
  [RefundType.ACCOMMODATION]: '住宿费',
  [RefundType.MEAL]: '餐费',
  [RefundType.INSURANCE]: '保险费',
  [RefundType.TRIAL_FEE]: '试学费',
  [RefundType.QUIT]: '退学退费',
  [RefundType.OTHER]: '其他',
};

/** 催费类别（斌哥截图：只有住宿费/保险费/餐费，没有学费）*/
export enum FeeCallCategory {
  ACCOMMODATION = 2, // 住宿费
  INSURANCE = 4,     // 保险费
  MEAL = 3,          // 餐费
}

export const FEE_CALL_CATEGORY_NAME: Record<number, string> = {
  [FeeCallCategory.ACCOMMODATION]: '住宿费',
  [FeeCallCategory.INSURANCE]: '保险费',
  [FeeCallCategory.MEAL]: '餐费',
};

/** 催缴状态 */
export enum FeeCallStatus {
  PENDING = 1,  // 待催缴
  CALLING = 2,  // 催缴中
  PAID = 3,     // 已缴清
}

export const FEE_CALL_STATUS_NAME: Record<number, string> = {
  [FeeCallStatus.PENDING]: '待催缴',
  [FeeCallStatus.CALLING]: '催缴中',
  [FeeCallStatus.PAID]: '已缴清',
};
