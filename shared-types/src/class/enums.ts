/**
 * 学管系统全局枚举
 *
 * ⚠️ 本文件的取值必须与《01-公共数据字典.md》一致
 * ⚠️ 修改本文件必须在群里 @全员 公告，所有人重新 install + 编译
 *
 * ============================================================
 * v1.1 变更说明（2026-09-30，需全组公告）
 * ============================================================
 * 变更 1｜SuspendStatus（休学/退学状态）由 4 值扩为 5 值
 *   新增值：PENDING_PRINCIPAL = 3（待校长审批）
 *   ⚠️ 这是**破坏性变更**：原 3=已同意 / 4=已驳回 变为 4=已同意 / 5=已驳回
 *   依据：退学流程要求「班主任申请 → 学管（经理）初审 → 校长审批」，
 *        原字典 4.9 只有「待经理审批 → 已同意」，缺少校长环节。
 *   影响面：所有读写 suspendStatus 的模块（学管、教务、财务报表）必须同步升级。
 *
 * 变更 2｜新增枚举 UpgradeStatus（升学申请状态）
 *   依据：「初高中升学」需求，初高部班主任发起、本模块接收。
 *
 * 变更 3｜新增枚举 OuterSyncStatus（外部同步状态）
 *   依据：学生信息同步自市场咨询、催费同步自教务、缴费同步自财务、宿舍同步自教务。
 *
 * ============================================================
 * v1.2 变更说明（2026-10-01，需全组公告）
 * ============================================================
 * 变更 4｜StudentStatus 由 11 值收敛为 5 值（⚠️ 破坏性变更）
 *   保留：TRIAL(3)=试学、STUDYING(5)=正式在读、SUSPENDED(6)=休学、QUIT(7)=退学、TRAINING(8)=实训中
 *   移除：WAIT_CONSULT(1) 待咨询、CONSULTING(2) 咨询中、PRE_STUDY(4) 预在读、
 *        WAIT_EMPLOY(9) 待就业、EMPLOYED(10) 已就业、LOST(11) 流失
 *   依据：班级信息管理页面的学生状态就这四项（试学／正式在读／休学／退学），
 *        升实训后系统写入「实训中」。招生咨询阶段归市场咨询模块（8001），
 *        就业阶段归就业模块（8004），不属于本模块的学生状态域。
 *   ⚠️ 数值刻意保持原编号不变（3/5/6/7/8），避免历史数据被误读。
 *
 * 变更 5｜大学部学习阶段由「一~四阶段」扩为「一~六阶段」
 *   新增：205=五阶段、206=六阶段（StageName / STAGES_BY_DEPT 见 server-class/lib/dict.ts）
 *   依据：班级处于第六阶段时出现「升实训」，第六阶段为可升实训的判定基准。
 *
 * ============================================================
 * v1.3 变更说明（2026-10-01，需全组公告）
 * ============================================================
 * 变更 6｜取消初高部，部门只保留大学部；学习阶段只保留一~六阶段（⚠️ 破坏性变更）
 *   部门：DeptCode 仅保留 UNIVERSITY(2)，移除 JUNIOR_SENIOR(1)。
 *   阶段：StageName / STAGES_BY_DEPT 仅保留 201~206（一~六阶段），
 *        移除 101~107（预科 / 初中部 1~3 期 / 高中部 1~3 期）。
 *   依据：班级管理与信息管理页面「学习阶段」只列一~六阶段、「部门」只有大学部；
 *        原初高中部相关数据统一迁移到大学部口径。
 * 变更 7｜RefundStatus 新增 WITHDRAWN(8)=已撤回
 *   依据：班主任发起的退费申请，在进入审批前可以撤回（撤回后不可再审批）。
 */

/** 性别 */
export enum Gender {
  MALE = 1,   // 男
  FEMALE = 2, // 女
}

/** 部门（v1.3：取消初高部，只保留大学部） */
export enum DeptCode {
  UNIVERSITY = 2, // 大学部
}

/**
 * 学生状态（全系统最重要的字段）
 * ⚠️ v1.2 收敛为 5 值，见文件头「变更 4」
 * 数值刻意保持原编号（3/5/6/7/8）不变，避免历史数据被误读。
 */
export enum StudentStatus {
  TRIAL = 3,     // 试学
  STUDYING = 5,  // 正式在读
  SUSPENDED = 6, // 休学
  QUIT = 7,      // 退学
  TRAINING = 8,  // 实训中（班级升实训后由系统写入）
}

/** 班级管理范围内可选的学生状态（顺序即前端下拉/筛选顺序） */
export const CLASS_STUDENT_STATUS: readonly StudentStatus[] = [
  StudentStatus.TRIAL,
  StudentStatus.STUDYING,
  StudentStatus.SUSPENDED,
  StudentStatus.QUIT,
  StudentStatus.TRAINING,
];

/** 班级状态
 *  v1.3 收敛：可运营态只有「开放 / 封班」；
 *    · 开放：可接收新生（新建学员 / 咨询接收）
 *    · 封班：不再接收新生，**但可接收「末班」与「重修」学员**（见 classRule.ts）
 *    · 实训中：第六阶段班升实训后由系统置为此状态（不可手工选择）
 *  原「待结业(3) / 已结业(4)」已按需求取消（保留号段不使用，避免历史数据误解）。*/
export enum ClassStatus {
  OPEN = 1,       // 开放
  CLOSED = 2,     // 封班（不再收新生；可收末班 / 重修）
  TRAINING = 5,   // 实训中（系统态：第六阶段班升实训后自动置位）
}

/** 缴费类型 */
export enum FeeType {
  TUITION = 1,       // 学费
  ACCOMMODATION = 2, // 住宿费
  MEAL = 3,          // 餐费
  INSURANCE = 4,     // 保险费
  TRIAL_FEE = 5,     // 试学费（仅试学阶段，不并入学费）
}

/** 缴费状态 */
export enum PayStatus {
  UNPAID = 1,   // 待缴
  PAID = 2,     // 已缴
  VERIFIED = 3, // 已核对
  /** 逾期（到期日已过仍未缴清）—— 2026-10-20 与初高侧对齐，库注释本来就写着 4 逾期 */
  OVERDUE = 4,  // 逾期
  FROZEN = 5,   // 冻结（冻结期间不可进班/就餐）
}

/** 退费状态（审批链，全系统统一，顺序不许自定义） */
export enum RefundStatus {
  DRAFT = 1,             // 待提交（班主任）
  PENDING_MANAGER = 2,   // 待经理审批（学管）
  PENDING_ACADEMIC = 3,  // 待教务核算
  PENDING_FINANCE = 4,   // 待财务出款
  PENDING_PRINCIPAL = 5, // 待校长审批（超过阈值时才有这一步）
  REFUNDED = 6,          // 已退费
  REJECTED = 7,          // 已驳回（回到班主任）
  WITHDRAWN = 8,         // 已撤回（v1.3 新增：班主任在进入审批前主动撤回）
}

/**
 * 休学 / 退学状态
 * ⚠️ v1.1 由 4 值扩为 5 值，见文件头「变更 1」
 */
export enum SuspendStatus {
  DRAFT = 1,             // 待提交（班主任）
  PENDING_MANAGER = 2,   // 待经理审批（学管）
  PENDING_PRINCIPAL = 3, // 待校长审批（v1.1 新增，仅退学走这一步）
  APPROVED = 4,          // 已同意
  REJECTED = 5,          // 已驳回（驳回原因回传班主任）
  /**
   * ★ 2026-10-09 新增：已撤回
   *
   * 【为什么加】三块合并后学籍异动审批链**统一采用实训那套**，统一状态码里有
   *   「6 已撤销」。大学原来撤回是**软删除单据**（`is_deleted=1`），没有状态可表达；
   *   补上 6 之后，新单的撤回改用状态（不再删行，列表里能看到"已撤回"）。
   *
   * ⚠️ 1~5 保持不变 → **老数据全部兼容**（列是 int，老数据不会出现 6）。
   */
  WITHDRAWN = 6,         // 已撤回
}

/** 申请类型（审批中心的分类） */
export enum ApplyType {
  SUSPEND = 1, // 休学
  QUIT = 2,    // 退学
  REFUND = 3,  // 退费
  UPGRADE = 4, // 升学
}

/** 升学申请状态（v1.1 新增） */
export enum UpgradeStatus {
  PENDING = 1,   // 待接收
  RECEIVED = 2,  // 已接收（已落库）
  REJECTED = 3,  // 已驳回
}

/** 咨询推送单状态（v1.2 新增；咨询模块 → 班主任接收后补充信息建档） */
export enum ConsultStatus {
  PENDING = 1,  // 待接收
  RECEIVED = 2, // 已接收（已补充信息并建档）
  REJECTED = 3, // 已驳回（原因回传咨询模块）
}

/** 外部同步状态（v1.1 新增；四条对接接口共用） */
export enum OuterSyncStatus {
  PENDING = 1,  // 待同步
  SYNCED = 2,   // 已同步
  FAILED = 3,   // 同步失败
}

/** 考试类型 */
export enum ExamType {
  MONTHLY = 1,    // 月考
  QUALITY = 2,    // 质素考核
  STAGE = 3,      // 阶段考核
  GRADUATION = 4, // 结业考试
  OTHER = 5,      // 其他（考试管理里自定义）
}

/** 考试结果 */
export enum ExamResult {
  PASS = 1, // 通过（升班）
  FAIL = 2, // 未通过（末班，转班重修）
}

/** 考试内容类型 */
export enum ExamContentType {
  WRITTEN = 1,   // 笔试
  MACHINE = 2,   // 机试
  INTERVIEW = 3, // 面试
  OTHER = 4,     // 其他（考试管理里自定义）
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
  SELF = 1,  // 本人
  CLASS = 2, // 本班级（班主任 / 教员 / 助教）
  DEPT = 3,  // 本部门（经理看本部门）
  ALL = 4,   // 全部（校长 / 管理员 / 学管）
}

/** 宿舍类型 */
export enum DormType {
  MALE_DORM = 1,   // 男寝
  FEMALE_DORM = 2, // 女寝
}

/**
 * ★ 床位序号 → 「1-上 / 1-下」文本（奇上偶下）
 *
 * 【规则】全项目统一：1→1上 · 2→1下 · 3→2上 · 4→2下
 *   与教务 `BED_OPTIONS` 的 '1-下','1-上','2-下','2-上' 顺序对齐。
 *
 * 【为什么放 shared-types】
 *   同一个「床位怎么显示」的规则，后端 dorm.route 和前端 Roster/Dorm 都要用。
 *   两边各写一份必然分叉（历史上就分叉成「301-1」和「1-上」两种），
 *   所以单一数据源放这里，两边 import。
 *
 * 【注意】只用于**显示**，不要拿它去改库存数据 ——
 *   `t_class_student.bed_no` 等字段存的是纯数字，8003 那边也在用。
 */
export function bedNoText(bedNo: number | string | null | undefined): string {
  const raw = String(bedNo ?? '').trim();
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return raw;   // 已经是「1-上」这类文本，原样返回
  const n = Number(raw);
  if (n <= 0) return raw;
  return `${Math.ceil(n / 2)}-${n % 2 === 1 ? '上' : '下'}`;
}

/**
 * 房间号 + 床位序号 → 完整标签（如 '301-1-上'）
 *
 * 床位号为空时只返回房间号；房间号为空时只返回床位文本。
 */
export function bedLabel(
  dormNo: string | number | null | undefined,
  bedNo: number | string | null | undefined,
): string {
  const room = String(dormNo ?? '').trim();
  const bed = bedNoText(bedNo);
  if (!room) return bed;
  if (!bed) return room;
  return `${room}-${bed}`;
}

/** 申请状态（宿舍通用） */
export enum ApplyStatus {
  PENDING = 1,  // 待审核
  APPROVED = 2, // 已同意（需先确认宿舍物品完好）
  REJECTED = 3, // 已驳回（必填驳回原因）
}

/** 通知类型（v1.1 新增；站内消息中心） */
export enum NotifyType {
  APPROVED = 1, // 审批通过
  REJECTED = 2, // 审批驳回
  TODO = 3,     // 待办提醒（有单子待你审批）
}

/** 系统预置角色编码（编码固定不可改） */
export enum RoleCode {
  // ★ 2026-10-04 并入主系统：**值**已统一为「无前缀」编码（与主包一致），
  //   枚举名保持不变 → 班级代码里 48 处 RoleCode.xxx 零改动。
  //   ⚠️ 两个「学管」角色合并成一个（主包的 TEACH_DEAN），招生老师并入咨询老师。
  ADMIN = 'SYS_ADMIN',                // 系统管理员
  PRINCIPAL = 'RM_PRINCIPAL',         // 校长
  RECRUIT = 'MKT_CONSULT',            // 招生老师（并入咨询老师）
  CONSULT = 'MKT_CONSULT',            // 咨询老师
  HEAD_TEACHER = 'TEACH_HEAD',        // 班主任
  TEACHER = 'TEACH_TUTOR',            // 教员
  ASSISTANT = 'TEACH_ASSIST',         // 助教
  QUALITY_MGR = 'TEACH_DEAN',         // 教质经理（并入「学管主任」）
  ACADEMIC_MGR = 'TEACH_DEAN',        // 学术经理（并入「学管主任」）
  // ★ 2026-10-04 斌哥拍板：班主任按阶段拆分
  //   HEAD_TEACHER  = 班主任（只带大学部，阶段 1~206）
  //   PROJECT_MANAGER = 项目经理（只带实训/就业，阶段 13）
  PROJECT_MANAGER = 'PROJECT_MANAGER', // 项目经理（实训阶段班主任）
  EDU_ADMIN = 'ACAD_STAFF',           // 教务老师
  FINANCE = 'ROLE_FINANCE',           // 财务（主系统已删该角色，保留仅为兼容旧数据）
  EMPLOYMENT = 'JOB_STAFF',           // 就业老师
}

/** 自定义角色编码前缀：ROLE_CUSTOM_ + 4 位序号 */
export const CUSTOM_ROLE_PREFIX = 'ROLE_CUSTOM_';
