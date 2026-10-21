/**
 * 教学域统一数据结构（DTO）
 * ============================================================
 *
 * 【它解决什么问题】
 *   第 2 期把三套出勤合成一套接口。前端**只认这里的结构**，
 *   不再关心数据来自哪个库、哪张表、字段叫什么。
 *
 * 【三条硬约定】
 *   ① `stage`（jh/class/job）是唯一新增的必需参数与必返回字段；
 *   ② 字段名统一成小驼峰，日期统一 'YYYY-MM-DD'；
 *   ③ 出勤状态统一成 1~7 的「统一码」（见 conf.ts 的映射表），
 *      **后端进出一律转成统一码**，前端不认识任何学段的原始码。
 */

/** 学段 */
export type TeachingStage = 'jh' | 'class' | 'job';

export const TEACHING_STAGES: TeachingStage[] = ['jh', 'class', 'job'];

export const TEACHING_STAGE_NAME: Record<TeachingStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '实训',
};

export function isTeachingStage(x: unknown): x is TeachingStage {
  return x === 'jh' || x === 'class' || x === 'job';
}

/**
 * ★ 2026-10-19 批注：班级域新增「就业部」学段
 *
 * 【为什么不直接扩 TeachingStage】
 *   出勤/考试/成绩/宿舍/退费/审批等域都是按 TeachingStage 穷举仓储的，
 *   一扩就会要求这些域也实现「就业部」，纯属误伤。
 *   就业部目前只接「班级管理 + 学生档案」两个入口，所以只扩这两个域的联合类型。
 *
 * 【数据口径】复用 sms_job 的表，靠 dept_code=3 隔离（表里的 stage 列是阶段码，不能用来隔离）。
 */
export type ClassStage = TeachingStage | 'emp';

export const CLASS_STAGES: ClassStage[] = ['jh', 'class', 'job', 'emp'];

export const CLASS_STAGE_NAME: Record<ClassStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '实训',
  emp: '就业部',
};

export function isClassStage(x: unknown): x is ClassStage {
  return x === 'jh' || x === 'class' || x === 'job' || x === 'emp';
}

/**
 * ★ 统一出勤状态码（以实训那套 7 码为准 —— 它是三个学段的超集）
 *
 *   ⚠️ 这是全系统唯一权威口径。各学段的原始码必须经 conf.ts 的
 *      映射表翻译成这里的码，**绝不允许**把原始码漏到接口外。
 */
export enum UnifiedAttendanceStatus {
  PRESENT = 1, // 出勤
  ABSENT = 2, // 缺勤
  LATE = 3, // 迟到
  EARLY_LEAVE = 4, // 早退
  LEAVE = 5, // 请假
  PERSONAL_LEAVE = 6, // 事假
  SICK_LEAVE = 7, // 病假
}

export const UNIFIED_STATUS_NAME: Record<number, string> = {
  [UnifiedAttendanceStatus.PRESENT]: '出勤',
  [UnifiedAttendanceStatus.ABSENT]: '缺勤',
  [UnifiedAttendanceStatus.LATE]: '迟到',
  [UnifiedAttendanceStatus.EARLY_LEAVE]: '早退',
  [UnifiedAttendanceStatus.LEAVE]: '请假',
  [UnifiedAttendanceStatus.PERSONAL_LEAVE]: '事假',
  [UnifiedAttendanceStatus.SICK_LEAVE]: '病假',
};

/** 需要填写原因的状态（缺勤 / 请假类） */
export const NEED_REASON_STATUSES: number[] = [
  UnifiedAttendanceStatus.ABSENT,
  UnifiedAttendanceStatus.LEAVE,
  UnifiedAttendanceStatus.PERSONAL_LEAVE,
  UnifiedAttendanceStatus.SICK_LEAVE,
];

/** 列表行（出勤台账 —— 一班一天一行） */
export interface AttendanceRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  classId: string;
  className: string;
  /** YYYY-MM-DD */
  attendanceDate: string;
  /** 应到 */
  shouldCount: number;
  /** 实到 */
  actualCount: number;
  /** 未到 */
  absentCount: number;
  /** 出勤率（%），保留 2 位 */
  attendanceRate: number;
  teacherName: string | null;
  headTeacherName: string | null;
  /** 初高才有（上传的出勤表文件） */
  fileUrl: string | null;
  remark: string | null;
}

/** 详情行（按人） */
export interface AttendanceDetailRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  /** ★ 统一码 */
  status: number;
  statusName: string;
  reason: string | null;
  phone: string | null;
}

/** 详情返回：台账 + 明细 */
export interface AttendanceDetail {
  record: AttendanceRow;
  details: AttendanceDetailRow[];
}

/** 列表查询入参 */
export interface AttendanceListQuery {
  stage?: TeachingStage;
  classId?: string;
  startDate?: string;
  endDate?: string;
  page: number;
  size: number;
}

/** 保存入参 */
export interface AttendanceSaveBody {
  stage: TeachingStage;
  classId: string;
  attendanceDate: string;
  /** 大学专用：老师手填的应到人数 */
  shouldCount?: number;
  /** 大学专用：老师手填的实到人数 */
  actualCount?: number;
  /** 初高 / 实训：按人提交（状态用统一码） */
  rows?: Array<{ studentId: string; status: number; reason?: string | null }>;
  /** 初高可选：上传的出勤表文件地址 */
  fileUrl?: string | null;
  remark?: string | null;
}

/** 录入登记板的一行（按人） */
export interface AttendanceBoardRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  /** ★ 统一码；null = 当天还没登记 */
  status: number | null;
  reason: string | null;
  registered: boolean;
}

/** 录入登记板：某班某天的在班名单 + 已登记状态 */
export interface AttendanceBoard {
  stage: TeachingStage;
  stageName: string;
  classId: string;
  className: string;
  attendanceDate: string;
  shouldCount: number;
  rows: AttendanceBoardRow[];
}

/** 汇总统计 */
export interface AttendanceSummary {
  stage: TeachingStage;
  stageName: string;
  totalRecords: number;
  /** 平均出勤率（%） */
  avgRate: number;
  /** 班级数 */
  classCount: number;
  /** 未达标人次（出勤率 < targetRate） */
  unqualifiedCount: number;
  targetRate: number;
}

/* ============================================================
 * 考试域
 * ============================================================
 * 三套差异（实测）：
 *   · 实训 t_job_exam      ：exam_time(datetime) · class_ids 逗号多班 · content_types 逗号
 *   · 大学 t_class_exam    ：exam_date(date)    · class_id 单班   · 内容项在子表 t_class_exam_content
 *   · 初高 t_class_exam    ：exam_date(date)    · class_id 单班   · exam_content_types JSON + exam_status 审批
 *   ✅ 三套的 exam_type 枚举一致（1月考 2质素考核 3阶段考核 4结业考试 5其他）
 */

export const EXAM_TYPE_NAME: Record<number, string> = {
  1: '月考',
  2: '质素考核',
  3: '阶段考核',
  4: '结业考试',
  5: '其他',
};

export const EXAM_CONTENT_TYPE_NAME: Record<number, string> = {
  1: '笔试',
  2: '机试',
  3: '面试',
  4: '其他',
};

/** 考试状态（只有初高真正用；实训/大学恒为 2 已提交） */
export const EXAM_STATUS_NAME: Record<number, string> = { 1: '草稿', 2: '已提交' };

/** 内容项 */
export interface ExamContentItem {
  type: number;
  name: string;
  /** 满分；实训没有满分概念，为 null */
  fullScore: number | null;
}

/** 自定义字段 */
export interface ExamCustomField {
  name: string;
  type: string;
  sortNo: number;
}

/** 考试列表行（统一结构） */
export interface ExamRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  examName: string;
  examType: number;
  examTypeName: string;
  /** YYYY-MM-DD（实训只有 datetime，取日期部分） */
  examDate: string;
  /** 统一成数组：实训多班、另两个单班 */
  classIds: string[];
  classNames: string;
  contentTypes: number[];
  contentNames: string;
  /** 1 草稿 / 2 已提交 */
  status: number;
  statusName: string;
  creatorName: string | null;
  remark: string | null;
}

/** 考试详情 */
export interface ExamDetail {
  record: ExamRow;
  contents: ExamContentItem[];
  /**
   * 自定义字段
   * ⚠️ 语义差异：初高是「本场考试的字段」（t_class_exam_field.exam_id），
   *    大学是「全局字段定义」（该表无 exam_id，对所有考试生效）。
   */
  fields: ExamCustomField[];
}

export interface ExamListQuery {
  stage?: TeachingStage;
  classId?: string;
  examType?: number;
  startDate?: string;
  endDate?: string;
  keyword?: string;
  page: number;
  size: number;
}

export interface ExamSaveBody {
  stage: TeachingStage;
  /** 有值 = 修改，无值 = 新增 */
  id?: string;
  examName: string;
  examType: number;
  examDate: string;
  /** 统一用数组；初高/大学只取第一个（它们是单班模型） */
  classIds: string[];
  contents?: Array<{ type: number; name?: string; fullScore?: number | null }>;
  remark?: string | null;
}

/* ============================================================
 * 成绩域
 * ============================================================
 * 三套字段名各不相同（实测）：
 *   笔试：实训 paper_score    / 大学 written_score   / 初高 score_written
 *   机试：实训 machine_score  / 大学 machine_score   / 初高 score_machine
 *   面试：实训 interview_score/ 大学 interview_score / 初高 score_interview
 *   综合：实训 total_score    / 大学 comp_score      / 初高 score_total
 *   另有：实训 written_avg（笔试均分，独有）；大学 analysis；初高 custom_values
 * 统一成下面的 writtenScore / machineScore / interviewScore / otherScore /
 *        writtenAvg / totalScore。
 */

export const EXAM_RESULT_NAME: Record<number, string> = { 1: '通过', 2: '未通过' };

/** 成绩列表行 */
export interface ScoreRow {
  id: string;
  stage: TeachingStage;
  stageName: string;
  examId: string;
  examName: string;
  examDate: string | null;
  classId: string | null;
  className: string | null;
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  writtenScore: number | null;
  machineScore: number | null;
  interviewScore: number | null;
  otherScore: number | null;
  /** 笔试均分（只有实训按公式算，其它学段为 null） */
  writtenAvg: number | null;
  totalScore: number | null;
  examResult: number | null;
  examResultName: string;
  remark: string | null;
}

/** 录入表的一行（按人，来自花名册 + 已录成绩） */
export interface ScoreEntryRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  /** 已存在的成绩行 id；null = 还没录 */
  scoreId: string | null;
  writtenScore: number | null;
  machineScore: number | null;
  interviewScore: number | null;
  otherScore: number | null;
  writtenAvg: number | null;
  totalScore: number | null;
  examResult: number | null;
  remark: string | null;
}

/** 录入表：某场考试某班的「全班名单 + 已录分数」 */
export interface ScoreEntry {
  stage: TeachingStage;
  stageName: string;
  examId: string;
  examName: string;
  examDate: string | null;
  classId: string;
  className: string;
  /** 满分合计（初高按比例判定通过用） */
  fullTotal: number;
  /** 该学段是否算笔试均分（前端据此决定要不要显示那一列） */
  hasWrittenAvg: boolean;
  rows: ScoreEntryRow[];
}

export interface ScoreListQuery {
  stage?: TeachingStage;
  examId?: string;
  classId?: string;
  studentId?: string;
  keyword?: string;
  page: number;
  size: number;
}

export interface ScoreSaveBody {
  stage: TeachingStage;
  examId: string;
  rows: Array<{
    studentId: string;
    writtenScore?: number | null;
    machineScore?: number | null;
    interviewScore?: number | null;
    otherScore?: number | null;
    /**
     * 考试结果 1通过 2未通过
     * ⚠️ 只有 judgeMode='manual' 的学段（大学）由前端传；
     *    'auto'（初高）后端算、'action'（实训）由「标末班」动作设置。
     */
    examResult?: number | null;
    remark?: string | null;
  }>;
}

export interface ScoreSummaryItem {
  stage: TeachingStage;
  stageName: string;
  totalStudents: number;
  enteredCount: number;
  avgTotal: number;
  passCount: number;
  failCount: number;
  passRate: number;
}

/**
 * 单行改分（成绩列表「编辑」）
 *
 * ★ 只改「传了的字段」：没传 = 保持原值。
 *   —— 备注列是内联编辑的，只传 remark 时**不能**把分数重算一遍再写回去
 *      （浮点权重来回算会把 85 变成 84.999…）。
 */
export interface ScoreUpdateBody {
  stage: TeachingStage;
  /** 成绩行 id */
  id: string;
  writtenScore?: number | null;
  machineScore?: number | null;
  interviewScore?: number | null;
  otherScore?: number | null;
  /**
   * 考试结果 1 通过 / 2 未通过 / null 未判断
   *
   * ★ 2026-10-19：三个学段都允许老师手改（「编辑」弹窗里的结果下拉）。
   *   传了就以老师选的为准；没传则维持原判定逻辑：
   *     初高按满分比例重判 / 大学默认通过 / 实训保持未判断。
   */
  examResult?: number | null;
  remark?: string | null;
}

/**
 * 末班（成绩列表「末班」）
 *
 * 【规则】结果必须已是「未通过」才能末班；
 *   目标班级学段：初高 → 只能初高；大学 → 只能大学；实训 → 三学段任意。
 */
export interface ScoreRepeatBody {
  stage: TeachingStage;
  /** 成绩行 id */
  scoreId: string;
  /** 目标班级所属学段 */
  targetStage: TeachingStage;
  targetClassId: string;
  /** YYYY-MM-DD；不传默认今天 */
  repeatDate?: string;
  /** 末班原因（下拉选项，或「其他」手填） */
  repeatReason: string;
  /** 学员不足说明：拼进末班原因，并同步写成绩备注 */
  shortcoming?: string;
}

export interface ScoreRepeatResult {
  repeatCount: number;
  fromClassName: string | null;
  toClassName: string;
  toStageName: string;
  /** 目标班有无班主任可通知（本版不发站内信，仅回传便于前端提示） */
  notified: boolean;
}

/* ============================================================
 * 退费域（第 4 个合并的业务域）
 * ============================================================
 * ★★ 本域的合并决策（斌哥 2026-10-09 拍板）：
 *    **审批链统一采用「实训那一套」** ——
 *      班主任/项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款。
 *
 *    这意味着初高 / 大学原来那套 4~5 级链
 *      （待提交 → 经理 → 教务核算 → 财务出款 → 校长）
 *    被**简化**为 2 级 —— 这是**行为变更**，不是纯技术重构：
 *    原「教务核算」「财务」节点在新链里不再需要人工审批
 *    （财务改为"审批通过后执行出款"，与实训口径一致）。上线前必须通知到这些同事。
 *
 * 三套差异（实测）：
 *   · 实训 t_job_refund          ：单表 + 关联通用审批单 t_job_approval，状态直接是 ApprovalStatus
 *   · 大学 t_class_refund_apply  ：主表 + 费用项**子表** t_class_refund_item（可多选），自建状态机
 *   · 初高 t_class_refund        ：主表 + 审批日志表 t_class_refund_log，自建状态机
 *   ✅ 费用类型枚举三套一致（1学费 2住宿费 3餐费 4保险费 5试学费）
 *   ✅ 状态码初高 / 大学 1~7 **逐值一致**；大学多 8=已撤回（初高本次已补齐对齐）
 * ============================================================ */

/**
 * ★ 退费统一状态码 —— 就是实训那套 `ApprovalStatus`，全系统唯一口径。
 *
 * ⚠️ 各学段老表里存的是**它们自己的码**，必须经 conf.ts 的
 *    `toUnifiedRefundStatus` / `toRawRefundStatus` 翻译，
 *    **绝不允许**把学段原始码漏到接口外。
 */
export const REFUND_STATUS = {
  DRAFT: 1,
  PENDING_MANAGER: 2,
  PENDING_PRINCIPAL: 3,
  APPROVED: 4,
  REJECTED: 5,
  CANCELED: 6,
} as const;

export const REFUND_STATUS_NAME: Record<number, string> = {
  [REFUND_STATUS.DRAFT]: '待提交',
  [REFUND_STATUS.PENDING_MANAGER]: '待学管审批',
  [REFUND_STATUS.PENDING_PRINCIPAL]: '待校长审批',
  [REFUND_STATUS.APPROVED]: '已通过',
  [REFUND_STATUS.REJECTED]: '已驳回',
  [REFUND_STATUS.CANCELED]: '已撤销',
};

/** 进行中（未结束）的状态：筛「待我审批」用 */
export const REFUND_ACTIVE_STATUSES: number[] = [
  REFUND_STATUS.PENDING_MANAGER,
  REFUND_STATUS.PENDING_PRINCIPAL,
];

/** 退费费用类型（三套一致；实训另有 6 退学退费 / 9 其他） */
export const REFUND_FEE_TYPE_NAME: Record<number, string> = {
  1: '学费',
  2: '住宿费',
  3: '餐费',
  4: '保险费',
  5: '试学费',
  6: '退学退费',
  9: '其他',
};

/** 统一审批链（= 实训那套），供前端把"本模块走哪几步"显式告诉用户 */
export const REFUND_CHAIN_NODES: Array<{ step: number; name: string; roles: string }> = [
  { step: 1, name: '学管审批', roles: '学管主任 / 学管' },
  { step: 2, name: '校长审批', roles: '校长' },
];

/** 单项退费费用上限：10 万元（单位分，100000 元 × 100）。
 *  前端费用项输入框的 max 与 service.create 的兜底校验共用这一口径，改这里两处同步。 */
export const REFUND_ITEM_MAX_AMOUNT = 10000000;

/** 费用项（统一结构：初高/实训只会有 1 项，大学可多项） */
export interface RefundItem {
  feeType: number;
  feeTypeName: string;
  amount: number;
  amountText: string;
}

/** 退费列表行（统一结构） */
export interface RefundRow {
  stage: TeachingStage;
  stageName: string;
  id: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  deptName: string | null;
  /** 汇总费用类型名（多项时用「/」连接，如「学费/住宿费」） */
  feeTypeName: string;
  /** 费用项明细 */
  items: RefundItem[];
  refundAmount: number;
  refundAmountText: string;
  applyDate: string;
  refundReason: string;

  approvalStatus: number;
  approvalStatusName: string;
  /** 当前该谁处理（审批中时有值） */
  currentHandlerHint: string | null;

  /** 已通过后财务侧信息 */
  financeRemark: string | null;
  refundTime: string | null;

  createTime: string | null;

  /** ★ 按钮显隐（与后端同一口径，前端照抄即可） */
  canApprove: boolean;
  canCancel: boolean;
  canSubmit: boolean;
}

/** 审批轨迹一行 */
export interface RefundLogRow {
  step: number;
  nodeName: string;
  operatorName: string;
  actionName: string;
  comment: string | null;
  time: string | null;
}

export interface RefundDetail {
  record: RefundRow;
  logs: RefundLogRow[];
}

export interface RefundListQuery {
  stage?: TeachingStage;
  page: number;
  size: number;
  keyword?: string;
  classId?: string;
  /** 统一状态码 */
  status?: number;
  /** 只看"待我审批" */
  onlyMine?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface RefundSaveBody {
  stage: TeachingStage;
  studentId: string;
  /** 费用项（统一多选；初高 / 实训只取第一项落库） */
  items: Array<{ feeType: number; amount: number }>;
  /** 退费总额（元→分由前端换算；后端会校验 = 各项目之和） */
  refundAmount: number;
  applyDate?: string;
  refundReason: string;
  remark?: string | null;
  /** 建完直接提交 */
  submit?: boolean;
}

export interface RefundSummary {
  stage: TeachingStage;
  stageName: string;
  total: number;
  /** 审批中（待学管 + 待校长） */
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** 已通过的金额合计（分） */
  approvedAmount: number;
}

/* ============================================================
 * 学籍异动审批域（休学 / 退学 / 复学）—— 第 2 期第 5 个域
 * ============================================================
 * 与退费域**同源**：审批链统一采用实训那一套（`shared-types/APPROVAL_CHAINS`）：
 *   休学 1 步（学管）· 复学 1 步（学管）· 退学 2 步（学管 → 校长）
 *
 * 三套差异（实测）：
 *   · 实训 t_job_student_leave    ：单表 + 关联通用审批单；**有跨库同步 + 花名册 + 联动退费单**
 *   · 大学 t_class_suspend_apply  ：单表 + 审批日志表；审批人**分字段存**
 *                                  （manager_xxx 与 principal_xxx 两组列）；
 *                                  **没有「复学」**（ApplyType 只有 休学/退学/退费/升学）；撤回=软删单
 *   · 初高 t_class_flow           ：**通用流程引擎**（7 类流程共表）；本次只并 休学/退学/复学 三条
 *                                  （升班转班 / 换人 / 就业协议 / 末班 是初高独有，**不并入**）
 *
 * ✅ 统一业务类型 = 实训的 `StudentLeaveBizType`：1 休学 · 2 退学 · 3 复学
 * ============================================================ */

export const LEAVE_BIZ_TYPE = {
  SUSPEND: 1,
  QUIT: 2,
  RESUME: 3,
} as const;

export const LEAVE_BIZ_TYPE_NAME: Record<number, string> = {
  [LEAVE_BIZ_TYPE.SUSPEND]: '休学',
  [LEAVE_BIZ_TYPE.QUIT]: '退学',
  [LEAVE_BIZ_TYPE.RESUME]: '复学',
};

/** 统一状态（= `ApprovalStatus`，实训那套） */
export const LEAVE_STATUS = {
  DRAFT: 1,
  PENDING_MANAGER: 2,
  PENDING_PRINCIPAL: 3,
  APPROVED: 4,
  REJECTED: 5,
  CANCELED: 6,
} as const;

export const LEAVE_STATUS_NAME: Record<number, string> = {
  [LEAVE_STATUS.DRAFT]: '待提交',
  [LEAVE_STATUS.PENDING_MANAGER]: '待学管审批',
  [LEAVE_STATUS.PENDING_PRINCIPAL]: '待校长审批',
  [LEAVE_STATUS.APPROVED]: '已通过',
  [LEAVE_STATUS.REJECTED]: '已驳回',
  [LEAVE_STATUS.CANCELED]: '已撤销',
};

/** 进行中的状态 */
export const LEAVE_ACTIVE_STATUSES: number[] = [
  LEAVE_STATUS.PENDING_MANAGER,
  LEAVE_STATUS.PENDING_PRINCIPAL,
];

/**
 * ★ 各学段**支持**的审批类型
 *
 * 【2026-10-16 调整】大学**开放「复学」**（用户要求：大学生休学后也可以复学）。
 *   大学老表 `ApplyType` 原本只有 1休学 2退学 3退费 4升学，没有复学码 ——
 *   本次新增**原码 5 = 复学**（见 shared/conf.ts 的 DEFAULT_LEAVE_BIZ_MAP.class），
 *   并给 `t_class_suspend_apply` 补了 `new_class_id` / `new_class_name` 两列
 *   （migrations-class/20261016_012）。
 */
export const LEAVE_STAGE_BIZ: Record<TeachingStage, number[]> = {
  jh: [LEAVE_BIZ_TYPE.SUSPEND, LEAVE_BIZ_TYPE.QUIT, LEAVE_BIZ_TYPE.RESUME],
  class: [LEAVE_BIZ_TYPE.SUSPEND, LEAVE_BIZ_TYPE.QUIT, LEAVE_BIZ_TYPE.RESUME],
  job: [LEAVE_BIZ_TYPE.SUSPEND, LEAVE_BIZ_TYPE.QUIT, LEAVE_BIZ_TYPE.RESUME],
};

/**
 * ★ 部门（业务口径）—— 发起申请时那个下拉，**取代**原来的「学段」
 *
 * 【为什么要有这一层】
 *   用户口径里公司有 3 个部门：初高中 / 大学 / 就业；
 *   技术上也是 3 个学段（jh / class / job），其中「就业」就是 `sms_job` 那个库
 *   （启动日志里显示的「就业管理」）。
 *
 * 【★ 2026-10-21 用户要求：部门「实训」改为「就业」】
 *   原来这里是 4 项（初高中 / 大学 / 实训 / 就业），第 4 项「就业」是个
 *   `stage = null` 的占位（当时认为就业部没有异动库表，选它只提示"暂不办理"）。
 *   实际上实训与就业共用 `sms_job`、同一套仓储 —— 占位没有意义，还给用户一个
 *   选不了学生的空部门。现在收成 3 项：初高中 / 大学 / 就业，
 *   就业 = 原实训（stage 仍是 `job`），休学 / 退学 / 复学 三项功能一并可用。
 *
 * ⚠️ 前端**不要在页面里另抄一份**：本数组由 `/meta` 下发，改这里就够了
 *   （前端兜底值 `LEAVE_DEPARTMENTS_DEFAULT` 只在 meta 请求失败时用）。
 */
export const LEAVE_DEPARTMENTS: Array<{
  /** 部门码（jh/class/job 与学段同码） */
  code: string;
  /** 部门中文名（页面显示，与用户口径一致：初高中 / 大学 / 就业） */
  name: string;
  /** 对应学段；null = 该部门暂不办理学籍异动（当前没有这种部门，字段保留以备将来） */
  stage: TeachingStage | null;
}> = [
  { code: 'jh', name: '初高中', stage: 'jh' },
  { code: 'class', name: '大学', stage: 'class' },
  { code: 'job', name: '就业', stage: 'job' },
];

/** 审批链步数（供前端展示"本次走几步"） */
export const LEAVE_CHAIN_STEPS: Record<number, number> = {
  [LEAVE_BIZ_TYPE.SUSPEND]: 1,
  [LEAVE_BIZ_TYPE.QUIT]: 2,
  [LEAVE_BIZ_TYPE.RESUME]: 1,
};

/** 申请单行（统一结构） */
export interface LeaveRow {
  stage: TeachingStage;
  stageName: string;
  id: string;

  bizType: number;
  bizTypeName: string;

  studentId: string;
  studentNo: string;
  studentName: string;
  gender: string | null;
  idCard: string | null;
  phone: string | null;
  parentPhone: string | null;

  classId: string | null;
  className: string | null;
  deptName: string | null;
  headTeacherName: string | null;

  /** 异动（休学/退学）日期 */
  leaveDate: string | null;
  /** 预计复学日期 */
  expectResumeDate: string | null;
  /** 复学落到哪个班（新建时可空，审批通过时必填） */
  newClassId: string | null;
  newClassName: string | null;

  leaveReason: string;
  /** 已上课时（退费计算用；只有实训/初高有） */
  attendedHours: number | null;
  /** 关联的退费单号（退学联动） */
  relatedRefundNo: string | null;

  /**
   * ★ 学生**当前**状态（实时读学生表，不是建单时的快照）
   *
   * 【为什么列表要带它】
   *   单据状态 ≠ 学生现状。比如「休学单已通过」，但如果这个人之后又办过复学，
   *   他现在是「正式在读」，不会出现在「复学」的候选名单里。
   *   列表上不显示这一列时，用户会看到「一堆已通过的休学单 → 复学时却没人可选」，
   *   直接判定成 bug（2026-10-15 用户就是这么报上来的）。
   *   ⚠️ 由 service 在分页**之后**批量补（见 attachStudentStatus），
   *      仓储的 decorate 不负责它（那是快照字段，语义不同）。
   */
  studentStatus?: number | null;
  /** 学生当前状态中文名（'休学' / '正式在读' …） */
  studentStatusName?: string;

  approvalStatus: number;
  approvalStatusName: string;
  currentHandlerHint: string | null;

  createTime: string | null;

  /** 按钮显隐（与后端同一口径） */
  canApprove: boolean;
  canCancel: boolean;
  canSubmit: boolean;
}

export interface LeaveListQuery {
  stage?: TeachingStage;
  page: number;
  size: number;
  keyword?: string;
  classId?: string;
  /** 统一业务类型 1/2/3 */
  bizType?: number;
  /** 统一状态码 */
  status?: number;
  onlyMine?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface LeaveSaveBody {
  stage: TeachingStage;
  studentId: string;
  /** 统一业务类型 */
  bizType: number;
  leaveDate?: string;
  expectResumeDate?: string;
  /** 复学：拟转入班级（可先空，审批通过时必须给） */
  newClassId?: string;
  leaveReason: string;
  remark?: string | null;
  submit?: boolean;
}

export interface LeaveLogRow {
  step: number;
  nodeName: string;
  operatorName: string;
  actionName: string;
  comment: string | null;
  time: string | null;
}

export interface LeaveDetail {
  record: LeaveRow;
  logs: LeaveLogRow[];
}

export interface LeaveSummary {
  stage: TeachingStage;
  stageName: string;
  total: number;
  suspendCount: number;
  quitCount: number;
  resumeCount: number;
  pendingCount: number;
  approvedCount: number;
}

/* ============================================================
 * 学生档案（student）—— 统一 DTO
 * ============================================================
 *
 * 【四个来源（学段）—— 注意比别的域多一个「教务」】
 *   jh    → sms_class_jh.t_class_student   （初高：49 字段）
 *   class → sms_class.t_class_student      （大学：57 字段）
 *   job   → sms_job.t_student_base         （就业：41 字段）
 *   edu   → sms_edu.t_student_base         （教务：32 字段，精简版）
 *
 * 【三处命名冲突（本域最大的坑，必须显式翻译）】
 *   ① 身份证：初高叫 `id_card_no`，其余叫 `id_card`     → 统一 `idCard`
 *   ② 籍贯：  大学叫 `origin`，其余叫 `native_place`     → 统一 `nativePlace`
 *   ③ 阶段码：DB 的 `stage` 列含义是「学段内阶段码」（初高 101~204 /
 *      大学 201~206 / 实训 1~6,7~13），**不是**本层的「学段」概念
 *      → 统一叫 `phaseCode`，避免与 `stage` 混淆
 *
 * 【与「求职简历」「综合素质」等学段特有字段的关系】
 *   它们是**各学段独有**的（就业有简历、大学有综合素质 7 维、初高有校园网），
 *   放进 `instructor` 专用区块原样透传，不强行拉平 —— 强行拉平就是"造字段"。
 */

/** 学生档案的四个学段来源 */
export type StudentStage = 'jh' | 'class' | 'job' | 'emp' | 'edu';

export const STUDENT_STAGES: StudentStage[] = ['jh', 'class', 'job', 'emp', 'edu'];

export const STUDENT_STAGE_NAME: Record<StudentStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '就业',
  /** ★ 2026-10-19 批注：就业部（与就业共用 sms_job，按 dept_code=3 隔离） */
  emp: '就业部',
  edu: '教务',
};

export function isStudentStage(x: unknown): x is StudentStage {
  return x === 'jh' || x === 'class' || x === 'job' || x === 'emp' || x === 'edu';
}

/**
 * ★ 学生档案「全部」视图的学段优先级（同学号去重时保留谁）
 *
 *   同一个人可能同时存在于多个库（影子表）：
 *   例如「大学 → 实训」升上来的人，class 库和 job 库各有一条。
 *   规则：以**阶段更靠后**的那条为准 —— job > class > jh > edu。
 *   （edu 放最后：它是教务的同步副本，最陈旧。）
 */
export const STUDENT_DEDUP_PRIORITY: StudentStage[] = ['emp', 'job', 'class', 'jh', 'edu'];

/** 学生档案 · 列表行（统一结构，四个学段共用） */
export interface StudentRow {
  stage: StudentStage;
  stageName: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  age: number | null;
  deptCode: number | null;
  deptName: string;
  classId: string | null;
  className: string | null;
  /** 学段内阶段码（DB 的 stage 列；各学段取值域不同） */
  phaseCode: number | null;
  phaseName: string;
  headTeacherId: string | null;
  headTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  assistantId: string | null;
  assistantName: string | null;
  studentStatus: number;
  studentStatusName: string;
  phone: string | null;
  /** 家长姓名（2026-10-15 学生档案改版新增） */
  parentName: string | null;
  parentPhone: string | null;
  education: string | null;
  enrollDate: string | null;
  dormId: string | null;
  dormNo: string | null;
  bedNo: string | null;
  bedLabel: string | null;
  attendanceRate: number | null;
  repeatCount: number;
  /** 身份证号（初高列名 id_card_no，其余 id_card） */
  idCard: string | null;
  /** 籍贯（大学列名 origin，其余 native_place） */
  nativePlace: string | null;
  graduateSchool: string | null;
  homeAddress: string | null;
  recruitTeacherName: string | null;
  recruitTeacherPhone: string | null;
  consultTeacherName: string | null;
  consultTeacherPhone: string | null;
  remark: string | null;
  createTime: string | null;
}

export interface StudentListQuery {
  stage?: StudentStage;
  classId?: string;
  deptCode?: number;
  studentStatus?: number;
  /** 学段内阶段码筛选 */
  phaseCode?: number;
  keyword?: string;
  /** 只看还没分配宿舍的（宿舍分配页用） */
  unassigned?: boolean;
  page: number;
  size: number;
}

/** 基础信息区块（四学段都有，只是部分字段可能为空） */
export interface StudentProfileSection {
  birthDate: string | null;
  nativePlace: string | null;
  idCard: string | null;
  graduateSchool: string | null;
  homeAddress: string | null;
  idPhotoUrl: string | null;
  householdPhotoUrl: string | null;
}

/** 市场信息区块（招生 / 咨询老师） */
export interface StudentMarketSection {
  recruitTeacherName: string | null;
  recruitTeacherPhone: string | null;
  consultTeacherName: string | null;
  consultTeacherPhone: string | null;
}

/** 宿舍区块 */
export interface StudentDormSection {
  dormId: string | null;
  dormNo: string | null;
  bedNo: string | null;
  bedLabel: string | null;
  building: string | null;
}

/**
 * 升云记录（2026-10-20 批注：初高部 → 大学部「开放」班级）
 *
 * 学生详情「基础信息」页签里展示：原班级 / 原班主任 / 升入班级 / 操作人 / 时间。
 * ⚠️ 按**学号**关联：升云后大学那条是新学生 id，只有学号两边一致（批注要求学号不变）。
 */
export interface StudentUpgradeRow {
  id: string;
  studentNo: string;
  studentName: string;
  /** 原班级（初高部） */
  fromClassName: string | null;
  /** 原班主任 */
  fromHeadTeacherName: string | null;
  /** 升入班级（大学部） */
  toClassName: string | null;
  toHeadTeacherName: string | null;
  operatorId: string | null;
  /** 操作人 */
  operatorName: string | null;
  upgradeTime: string | null;
  remark: string | null;
}

export interface StudentDetail {
  base: StudentRow;
  profile: StudentProfileSection;
  market: StudentMarketSection;
  dorm: StudentDormSection | null;
  /** 大学独有：综合素质 7 维（原样透传） */
  quality: Record<string, unknown> | null;
  /** 初高独有：校园网账号密码（原样透传） */
  net: Record<string, unknown> | null;
  /** 就业独有：简历（原样透传） */
  resume: Record<string, unknown> | null;
  /** 学籍异动 / 流转记录（各学段来源不同，统一成同构行） */
  flows: Array<Record<string, unknown>>;
  /** 末班 / 留级记录 */
  repeats: Array<Record<string, unknown>>;
  /** 升云记录（初高部 → 大学部，2026-10-20）—— 由 service 层按学号补齐，仓储不返回 */
  upgrades?: StudentUpgradeRow[];
  /** 其余学段特有字段（原样透传，前端不渲染、留作排查） */
  extra: Record<string, unknown> | null;
}

export interface StudentSaveBody {
  stage: StudentStage;
  /** 有值 = 修改，无值 = 新增 */
  id?: string;
  /** 新增可不传（后端按学段规则生成） */
  studentNo?: string;
  studentName: string;
  gender: number;
  birthDate?: string | null;
  age?: number | null;
  nativePlace?: string | null;
  deptCode?: number | null;
  classId?: string | null;
  className?: string | null;
  phaseCode?: number | null;
  studentStatus?: number;
  education?: string | null;
  graduateSchool?: string | null;
  enrollDate?: string | null;
  phone?: string | null;
  /** 家长姓名（2026-10-15 学生档案改版新增） */
  parentName?: string | null;
  parentPhone?: string | null;
  homeAddress?: string | null;
  idCard?: string | null;
  recruitTeacherName?: string | null;
  recruitTeacherPhone?: string | null;
  consultTeacherName?: string | null;
  consultTeacherPhone?: string | null;
  dormId?: string | null;
  dormNo?: string | null;
  bedNo?: string | null;
  /** 校园网账号（初高表有列；留空时系统自动生成） */
  netAccount?: string | null;
  netInitPassword?: string | null;
  remark?: string | null;
  /** 学段特有字段（综合素质 / 校园网 / 简历…）原样透传 */
  extra?: Record<string, unknown> | null;
  /** 教务学段：改状态时是否联动冻结缴费记录（默认 true，保持原行为） */
  syncFreeze?: boolean;
}

/** 保存结果（教务学段会带回冻结/解冻条数） */
export interface StudentSaveResult {
  id: string;
  /** 教务：本次自动冻结的缴费记录条数 */
  frozenCount?: number;
  /** 教务：本次自动解冻的条数 */
  unfrozenCount?: number;
}

/**
 * 学生档案详情「扩展区块」数据（2026-10-15 详情页分签改版）
 *
 * 【为什么单独一个接口】成绩 / 调宿记录分别来自成绩域、宿舍域，
 * 每次打开详情才按需拉取，不塞进 /detail（老接口保持轻、老页面不受影响）。
 */
export interface StudentExtras {
  /** 该生全部考试成绩（examType/examDate/examTypeName 由适配器按考试表回填） */
  scores: Array<ScoreRow & { examType?: number | null; examTypeName?: string | null }>;
  /** 该生调宿 / 退宿申请单（含审批状态） */
  dormChanges: DormChangeRow[];
  /** 所在宿舍的宿舍长 / 负责人（宿舍管理同步） */
  dormOwnerName: string | null;
  /** 所在宿舍的班级（宿舍管理同步，只有初高有） */
  dormClassName: string | null;
}

/**
 * ★ 2026-10-16 阶段方案（一个方案含多个阶段）
 *
 *   原「阶段字典」改版成「阶段方案」后，班级 / 学生表单里的「阶段」下拉
 *   不再从写死的常量里取，而是：**先选方案 → 再选该方案下的阶段**。
 *   数据源：sms_class_jh 的 t_class_stage_plan + t_class_stage
 *   （初高部 / 大学部两个部门的方案都存在那里）。
 */
export interface StagePlanOption {
  /** 方案 ID */
  id: string;
  /** 方案名称，如 初高部阶段方案 */
  name: string;
  /** 所属部门 1 初高部 / 2 大学部 */
  deptCode: number;
  /** 该方案下的阶段（value = 阶段编码，label = 阶段名称） */
  phases: Array<{ value: number; label: string }>;
}

/** 元信息：某学段支持哪些筛选项 / 能不能写 / 有哪些特有区块 */
export interface StudentStageMeta {
  stage: StudentStage;
  stageName: string;
  /** 该学段支持的学段内阶段码可选项 */
  phaseOptions: Array<{ value: number; label: string }>;
  /** ★ 2026-10-16 阶段方案（前端「阶段方案」下拉的数据源） */
  planOptions?: StagePlanOption[];
  /** 该学段特有区块的键（前端据此决定显示哪些页签） */
  sections: string[];
  /** 是否支持「只看未分配宿舍」筛选 */
  supportUnassigned: boolean;
}

/* ============================================================
 * 班级信息（class）—— 统一 DTO
 * ============================================================
 *
 * 【三个来源（学段）】
 *   jh    → sms_class_jh.t_class_info   （初高：21 字段）
 *   class → sms_class.t_class_info      （大学：25 字段）
 *   job   → sms_job.t_job_class         （实训/就业：29 字段，最全）
 *
 * 【四处命名/结构冲突（本域必须显式翻译）】
 *   ① 教室：  大学列名是 `room`，初高/实训是 `classroom`    → 统一 `classroom`
 *   ② 班级编号：**只有实训有 `class_code`**（且必填 + 唯一）
 *      大学/初高两表**根本没这一列** → 统一 `classCode` 为 null，前端隐藏输入框
 *   ③ 出勤率：初高是 `today_attendance_rate`（**今日**出勤率），
 *      大学/实训是 `attendance_rate`（**累计**出勤率）→ 统一 `attendanceRate`，
 *      并用 `attendanceRateKind` 标明是「今日」还是「累计」，否则数字没法比
 *   ④ 结业日期 `close_date` **只有实训有**
 *
 * 【✅ 好消息：班级状态码三套完全一致】（实测 t_job_class / 两个 t_class_info）
 *   1 开放 · 2 封班 · 3 待结业 · 4 已结业  → 直接用 `ClassStatus`，不需要映射表
 *
 * 【⚠️ 状态机三套不同 —— 这是本域最需要小心的地方】
 *   初高（classInfo.route.ts）有显式流转表：
 *     开放 → 开放/封班/待结业；封班 → 封班/开放/待结业；
 *     待结业 → 待结业/已结业；已结业 → （终态）
 *   实训只有「封班/解封」两个动作，且**"开放"已废弃**（能进实训的班只会是封班）；
 *   大学原实现没有独立的状态流转接口。
 *   → 统一成同一张流转表（取初高那套，最完整），
 *     实训的「解封」= 封班→开放，在统一流转表里天然合法。
 */

/** 班级状态（三套一致，无需映射） */
export const CLASS_STATUS = {
  OPEN: 1,
  CLOSED: 2,
  GRADUATING: 3,
  GRADUATED: 4,
} as const;

export const CLASS_STATUS_NAME: Record<number, string> = {
  [CLASS_STATUS.OPEN]: '开放',
  [CLASS_STATUS.CLOSED]: '封班',
  [CLASS_STATUS.GRADUATING]: '待结业',
  [CLASS_STATUS.GRADUATED]: '已结业',
};

/**
 * ★ 统一班级状态流转表
 *   已结业是终态，不可回退 —— 撤销结业属于「结业撤销」专用动作，不走这里。
 *
 * 2026-10-19 批注：「待结业」这个状态删除（页面下拉不再出现），
 *   封班之后直接进「已结业」。为兼容历史数据，3→已结业 的流转仍保留，
 *   但**不再作为任何状态的下一跳目标**（新数据不可能变成 3）。
 */
export const CLASS_STATUS_TRANSITIONS: Record<number, number[]> = {
  [CLASS_STATUS.OPEN]: [CLASS_STATUS.OPEN, CLASS_STATUS.CLOSED],
  [CLASS_STATUS.CLOSED]: [CLASS_STATUS.CLOSED, CLASS_STATUS.OPEN, CLASS_STATUS.GRADUATED],
  [CLASS_STATUS.GRADUATING]: [CLASS_STATUS.GRADUATING, CLASS_STATUS.GRADUATED],
  [CLASS_STATUS.GRADUATED]: [CLASS_STATUS.GRADUATED],
};

/** 是否允许把班级从 from 改成 to */
export function canTransitClassStatus(from: number, to: number): boolean {
  const allowed = CLASS_STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

/** 部门（数据字典固定：1 初高部 2 大学部 3 就业部）—— 三套都有 dept_code */
export const CLASS_DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部', 3: '就业部' };

/** 出勤率口径 —— ★ 必须显式告诉前端，否则「今日 92%」和「累计 88%」会被误读成同一种 */
export type AttendanceRateKind = 'today' | 'total' | null;

/** 班级列表行（统一结构，三学段共用） */
export interface ClassRow {
  stage: ClassStage;
  stageName: string;
  classId: string;
  className: string;
  /** ★ 只有实训有；大学/初高恒为 null（那两张表没这一列，不是漏映射） */
  classCode: string | null;
  deptCode: number | null;
  deptName: string;
  /** 学段内阶段码（初高 101~204 / 大学 201~206 / 实训 1~3），各学段取值域不同 */
  phaseCode: number | null;
  phaseName: string;

  /**
   * ★ 2026-10-16 新增：阶段方案（表单里「阶段方案 + 阶段」两个下拉的落库值）
   *   老班级没有方案时为 null，回显退回 phaseName（阶段码名称）。
   */
  schemeId: string | null;
  schemeStageId: string | null;
  /** 方案里的阶段名称（冗余存一份，列表/详情直接回显） */
  schemeStageName: string | null;

  headTeacherId: string | null;
  headTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  assistantId: string | null;
  assistantName: string | null;

  /** ★ 实训独有的两个岗位（交棒模型：实训带班 → 就业带岗） */
  projectManagerId: string | null;
  projectManagerName: string | null;
  employmentTeacherId: string | null;
  employmentTeacherName: string | null;
  /** 实训独有：大学学号 */
  universityNo: string | null;

  /** 统一 classroom（大学原列名 room） */
  classroom: string | null;
  openDate: string | null;
  /** ★ 只有实训有 */
  closeDate: string | null;

  /**
   * ★ 班级人数 —— **永远实时统计，绝不信表里的冗余值**
   *   （三张表的 student_count 都是「动态回写」字段，脏了没人重算）
   */
  studentCount: number;

  /** 1 开放 / 2 封班 / 3 待结业 / 4 已结业（三套一致） */
  classStatus: number;
  classStatusName: string;
  /** 由 classStatus + 流转表推出：这个班现在还能改状态吗 */
  canChangeStatus: boolean;

  attendanceRate: number | null;
  /** ★ 这个数字是「今日」还是「累计」 */
  attendanceRateKind: AttendanceRateKind;

  remark: string | null;
  createTime: string | null;
}

export interface ClassListQuery {
  stage?: ClassStage;
  deptCode?: number;
  classStatus?: number;
  phaseCode?: number;
  /** 关键字：班级名 / 编号 / 班主任 */
  keyword?: string;
  /** 只看封班 / 开放等，配合 classStatus 用；这里额外支持「不筛」 */
  page: number;
  size: number;
}

export interface ClassSaveBody {
  stage: ClassStage;
  /** 有值 = 修改，无值 = 新增 */
  id?: string;
  className: string;
  /** ★ 只有实训必填；另两个学段忽略此字段 */
  classCode?: string | null;
  deptCode?: number | null;
  phaseCode?: number | null;
  /** ★ 2026-10-16：阶段方案（可选；不选方案的老流程照样能用） */
  schemeId?: string | null;
  schemeStageId?: string | null;
  schemeStageName?: string | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  teacherId?: string | null;
  teacherName?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
  universityNo?: string | null;
  classroom?: string | null;
  openDate?: string | null;
  closeDate?: string | null;
  classStatus?: number;
  remark?: string | null;
}

/** 统计卡片（口径与列表完全一致） */
export interface ClassSummary {
  stage: ClassStage;
  stageName: string;
  total: number;
  openCount: number;
  closedCount: number;
  /** 2026-10-19 起「待结业」已下线，恒为 0（保留字段兼容前端旧代码） */
  graduatingCount: number;
  graduatedCount: number;
  /** 在班学生总数 */
  studentCount: number;
}

/* ============================================================
 * 班级交接（2026-10-19 批注）
 *   一次交接 = 一个班 5 个岗位同时换人：
 *   班主任 / 教员 / 助教 / 项目经理 / 就业老师
 *   初高没有后两个岗位（页面也不显示）。
 * ============================================================ */

/** 交接里的一个岗位（原/新） */
export interface ClassHandoverRole {
  oldId: string | null;
  oldName: string | null;
  newId: string | null;
  newName: string | null;
}

/** 一条交接记录（详情抽屉里按时间倒序展示） */
export interface ClassHandoverRow {
  id: string;
  stage: ClassStage;
  stageName: string;
  classId: string;
  className: string;
  deptCode: number | null;
  headTeacher: ClassHandoverRole;
  teacher: ClassHandoverRole;
  assistant: ClassHandoverRole;
  /** 初高恒为空 */
  projectManager: ClassHandoverRole;
  /** 初高恒为空 */
  employmentTeacher: ClassHandoverRole;
  handoverDate: string | null;
  reason: string | null;
  operatorId: string | null;
  operatorName: string | null;
  createTime: string | null;
}

/** 提交交接的入参：只带「要换的新人」，没带的岗位视为不变 */
export interface ClassHandoverPayload {
  stage: ClassStage;
  classId: string;
  handoverDate?: string | null;
  reason?: string | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  teacherId?: string | null;
  teacherName?: string | null;
  assistantId?: string | null;
  assistantName?: string | null;
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
}

/** 花名册一行（统一结构；各学段「班级↔学生」的关联方式不同，见各仓储注释） */
export interface ClassRosterRow {
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  gender: number;
  genderName: string;
  /** 实训花名册有入班方式；另两个学段为 null */
  joinType: number | null;
  joinTypeName: string;
  joinDate: string | null;
  /** 在班状态：1 在班 2 已离班（只有实训花名册有此概念） */
  inClassStatus: number | null;
  inClassStatusName: string;
}

/** 元信息：某学段支持哪些特性（前端据此隐藏不适用输入框） */
export interface ClassStageMeta {
  stage: ClassStage;
  stageName: string;
  /** 该学段是否有班级编号（只有实训有） */
  hasClassCode: boolean;
  /** 该学段是否有结业日期（只有实训有） */
  hasCloseDate: boolean;
  /** 该学段是否支持「封班/解封」按钮 */
  hasSealAction: boolean;
  /** 教室列名（给前端 label 用，避免它自己猜） */
  classroomLabel: string;
  /** 学段内阶段码可选项 */
  phaseOptions: Array<{ value: number; label: string }>;
  /** ★ 2026-10-16 阶段方案（前端「阶段方案」下拉的数据源） */
  planOptions?: StagePlanOption[];
}

/** 统计卡片 */
export interface StudentSummary {
  stage: StudentStage;
  stageName: string;
  total: number;
  studying: number;
  trial: number;
  suspended: number;
  quit: number;
  /** 未分配宿舍数 */
  unassigned: number;
}

/* ============================================================
 * 宿舍域统一 DTO（第 2 期 · 最后一个业务域）
 * ============================================================
 *
 * 【★ 本域三个必须显式翻译的坑（不翻译必错）】
 *
 * 坑 A 房间号格式三套不同
 *   初高 room_no        = `3-201`   （自己带楼栋前缀）
 *   大学 dorm_no        = `A栋-301` （同步来的，带「栋」字）
 *   实训 room_no        = `301`     （纯房号，不带楼栋）
 *   → 统一 DTO **原值直传不做拼接**，但「楼栋」必须单独成列，
 *     否则用户看到的房间号风格会乱跳。
 *
 * 坑 B 床位状态是 varchar，另有 int 和「没有表」两种
 *   初高 t_class_bed.bed_status      = varchar '空闲'/'已占用'/'维修'
 *   实训 t_job_dorm_bed.bed_status    = int 1/2/3
 *   大学                              = 没有床位表，靠 live_sync 反推
 *   → 归一成 int DORM_BED_STATUS，**映射必须写死双向，不能靠名字模糊匹配**。
 *
 * 坑 C 性别限制的 0 含义不同
 *   实训 dorm_gender：0 不限 / 1 男 / 2 女
 *   初高/大学 dorm_type：只有 1 男 / 2 女，**没有 0**
 *   → 统一用实训口径（含 0=不限）。初高/大学读出来天然是 1 或 2，**不做转换**。
 */

/** 宿舍（房间）统一状态 —— 1 使用中 / 2 空置 / 3 维修 / 4 停用 */
export enum UnifiedDormStatus {
  IN_USE = 1,
  EMPTY = 2,
  REPAIR = 3,
  DISABLED = 4,
}

export const DORM_STATUS_NAME: Record<number, string> = {
  [UnifiedDormStatus.IN_USE]: '使用中',
  [UnifiedDormStatus.EMPTY]: '空置',
  [UnifiedDormStatus.REPAIR]: '维修',
  [UnifiedDormStatus.DISABLED]: '停用',
};

/**
 * ★ 初高房间状态 varchar → 统一码（坑 B 同源问题，必须写死）
 *   注意「维修」映射到 REPAIR(3)，而实训的 3 是「床位停用」，
 *   两者语义相近（都不能住人），但**别混用**，房间和床位是两套枚举。
 */
export const JH_ROOM_STATUS_TEXT: Record<string, number> = {
  使用中: UnifiedDormStatus.IN_USE,
  空置: UnifiedDormStatus.EMPTY,
  维修: UnifiedDormStatus.REPAIR,
  停用: UnifiedDormStatus.DISABLED,
};

/** ★ 初高床位状态 varchar → 统一码 */
export const JH_BED_STATUS_TEXT: Record<string, number> = {
  空闲: 1,
  已占用: 2,
  维修: 3,
  停用: 3,
};

export const DORM_BED_STATUS_NAME: Record<number, string> = {
  1: '空闲',
  2: '已占用',
  3: '停用',
};

/** 宿舍性别限制：0 不限 / 1 男 / 2 女（实训口径更全，另两学段只有 1/2） */
export const DORM_GENDER_NAME: Record<number, string> = {
  0: '不限',
  1: '男生宿舍',
  2: '女生宿舍',
};

/**
 * ★「类别」的**展示口径**：1 男寝 / 2 女寝（2026-10-18）
 *
 * 【为什么不能直接用上面的 DORM_GENDER_NAME】
 *   DORM_GENDER_NAME 是**底层枚举全集**，且被老路由（dorm.route.ts /
 *   classInfo.route.ts）复用着，改它会连带改掉老页面的文案。
 *   而宿舍管理列表现在统一显示「男寝 / 女寝」（见前端 DORM_CATEGORY_NAME）。
 *
 * 【为什么搜索必须用它】
 *   关键字匹配取的是「列表上显示出来的值」（见 service.searchTextOf）。
 *   若这里用「男生宿舍」，用户看着列表上的「男寝」去搜「男寝」就会搜不到 ——
 *   「屏幕上看得见、搜索框里搜不出来」正是这次要根治的问题。
 *   → 0「不限」不在新口径内 → 返回 undefined，由调用方回退到 dormTypeName。
 */
export const DORM_CATEGORY_NAME: Record<number, string> = {
  1: '男寝',
  2: '女寝',
};

/* ============================================================
 * ★ 楼栋「楼层 / 每层房间数 / 每间床位数」的硬边界（2026-10-19）
 *
 * 【口径（2026-10-19 改：三项统一封顶 50）】
 *   楼层数 / 每层房间数 / 每间床位数 **一律 ≤ 50**，由产品口径定，不是格式决定。
 *   楼层 ≤ 50 之后，房号不再是固定 3 位 —— 见下面 `dormRoomNo()`：
 *     ≤ 9 层  → 3 位（1 楼第 8 间 = 108）
 *     ≥ 10 层 → 4 位（10 楼第 8 间 = 1008、50 楼第 12 间 = 5012）
 *   → 房号长度跟着楼层位数走，现有的 3 位房号一个都不用改。
 *
 * 【★ 为什么放在 dto 而不是某个 service 里】
 *   building.service（楼栋设置）和 dorm/service（房间生成）**两边都要用同一套边界**，
 *   而它们之间已经有 repo.uni → building.service 的依赖链，互相 import 会成环。
 *   → 放在 dto（谁都不依赖它），两边各自 import，天然无环且口径只有一份。
 * ============================================================ */

/** 楼层数上限 */
export const DORM_FLOOR_MAX = 50;
/** 每层房间数上限 */
export const DORM_ROOMS_PER_FLOOR_MAX = 50;
/** 每间床位数上限（与「新增房间」的床位数口径一致） */
export const DORM_BED_PER_ROOM_MAX = 50;
/** 每间床位数默认值 */
export const DORM_BED_PER_ROOM_DEFAULT = 4;
/**
 * ★ 单次生成房间数上限
 *   生成是「逐间 insert + 逐床 insert」，填错一次就是几千次写库。
 *   300 间（≈1200 次写）已是宽松值，正常楼栋配置远达不到。
 */
export const DORM_GEN_ROOM_MAX = 300;

/**
 * ★★ 房号编排：楼层 + 两位序号（2026-10-19 支持 10 层以上）
 *
 * 【规则】`楼层` 拼 `两位序号`：
 *   1 楼第 8 间 → `1` + `08` = 108（3 位）
 *   10 楼第 8 间 → `10` + `08` = 1008（4 位）
 *   50 楼第 12 间 → `50` + `12` = 5012（4 位）
 *   → 楼层是一位数就是 3 位房号、两位数就是 4 位房号，**自适应、无需配置**。
 *
 * 【为什么序号固定两位】楼层数放宽到 50 之后，房号长度不再固定。
 *   序号仍补零到两位，是为了「同层内房号等长」（101/102…112 而不是 101/102…1012），
 *   列表排序和人工核对都不会乱。
 */
export function dormRoomNo(floor: number, seq: number): string {
  return `${Math.floor(floor)}${String(Math.floor(seq)).padStart(2, '0')}`;
}

/** 房号合法格式：3 位（≤9 层）或 4 位（≥10 层）纯数字 */
export const DORM_ROOM_NO_ANY_RE = /^\d{3,4}$/;

/** 调宿 / 退宿 业务类型（复用 shared-types 的 DormChangeBizType 口径） */
export const DORM_CHANGE_NAME: Record<number, string> = {
  1: '调换宿舍',
  2: '退宿',
};

/** 宿舍列表查询条件 */
export interface DormListQuery {
  stage: TeachingStage;
  /** 楼栋名（精确） */
  building?: string;
  /** 性别限制 0不限/1男/2女 */
  dormType?: number;
  /** 统一房间状态 */
  roomStatus?: number;
  /**
   * ★ 关键字：匹配**列表上能看到的所有内容**（2026-10-18 改）
   *
   * 旧口径只在 SQL 里 like 了 room_no / building / dorm_no / facility 四个字段，
   * 于是「搜备注里的‘向阳’」「搜‘男寝’」「搜‘停用’」都搜不到 ——
   * 用户看到列表上有这个字，却搜不出来，是最典型的一类投诉。
   *
   * 现在改成在**服务层内存匹配**：等三学段合并成 DormRow 之后再过滤，
   * 这样 dormType→「男寝」、roomStatus→「停用」这类「int 码要翻译成文字才能搜」
   * 的字段也能一起命中，且**三学段口径完全一致**（不用每个 repo 各写一遍 like）。
   *
   * 匹配范围 = 列表全部列：类别 / 楼栋 / 宿舍号 / 已住·床位 / 入住率 / 状态 / 备注
   */
  keyword?: string;
  /**
   * ★ 入住率（整数百分比，精确匹配，如 50 表示 50%）
   *
   * 入住率是**算出来的**（已住/床位），表里没有这一列 → 只能内存过滤，不能进 SQL。
   * 可选项由 /occupancy-rates 实时从当前数据里取，不写死 0/25/50/75/100。
   */
  occupancyRate?: number;
  /** 只看有空床位的 */
  onlyVacant?: boolean;
  page: number;
  size: number;
}

/** 宿舍（房间）列表行 */
export interface DormRow {
  stage: TeachingStage;
  stageName: string;
  dormId: string;
  buildingName: string;
  roomNo: string;
  floorNo: number | null;
  /** 0 不限 / 1 男 / 2 女 */
  dormType: number;
  dormTypeName: string;
  bedCount: number;
  /** 已住人数 —— **实时统计**，不信冗余列 */
  occupiedCount: number;
  /** 入住率（0~100，保留 1 位小数；bedCount=0 时为 0） */
  occupancyRate: number;
  /** 统一房间状态 */
  roomStatus: number;
  roomStatusName: string;
  /** 负责人 / 宿舍长 */
  ownerName: string | null;
  /** 所属班级（只有初高有） */
  className: string | null;
  remark: string | null;
}

/** 床位行（含在住学生） */
export interface DormBedRow {
  bedId: string;
  bedNo: string;
  /** 「1上」「1下」—— 复用 shared-types 的 bedNoText 规则 */
  bedLabel: string;
  /** 1 空闲 / 2 已占用 / 3 停用 */
  bedStatus: number;
  bedStatusName: string;
  studentId: string | null;
  studentNo: string | null;
  studentName: string | null;
  gender: number | null;
  checkInDate: string | null;
  className: string | null;
}

/** 在住学生行 */
export interface DormResidentRow {
  /** 所属学段（合并视图里同一房间号可能来自不同学段，前端要靠它区分） */
  stage: TeachingStage;
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  dormId: string;
  roomNo: string;
  bedId: string;
  bedNo: string;
  bedLabel: string;
  checkInDate: string | null;
  classId: string | null;
  className: string | null;
}

/** 房间新增/编辑入参 */
export interface DormSaveBody {
  stage: TeachingStage;
  id?: string;
  buildingName: string;
  roomNo: string;
  floorNo?: number;
  dormType?: number;
  bedCount?: number;
  ownerName?: string | null;
  classId?: string | null;
  className?: string | null;
  roomStatus?: number;
  remark?: string | null;
}

/** 分派床位入参 */
export interface DormAssignBody {
  stage: TeachingStage;
  dormId: string;
  bedId: string;
  studentId: string;
  checkInDate?: string;
}

/** 调宿/退宿申请行 */
export interface DormChangeRow {
  stage: TeachingStage;
  stageName: string;
  changeId: string;
  /** 1 调换宿舍 / 2 退宿 */
  bizType: number;
  bizTypeName: string;
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  gender: number | null;
  phone: string | null;
  classId: string | null;
  className: string | null;
  headTeacherName: string | null;
  oldDormId: string | null;
  oldDormNo: string | null;
  oldBedNo: string | null;
  newDormId: string | null;
  newDormNo: string | null;
  newBedNo: string | null;
  changeDate: string;
  changeReason: string;
  /** 统一审批状态 1待提交/2待学管/3待校长/4已通过/5已驳回/6已撤销 */
  approvalStatus: number;
  approvalStatusName: string;
  /** 当前用户能否审批 */
  canApprove: boolean;
  /** 当前用户能否撤销 */
  canCancel: boolean;
  createTime: string | null;
}

/** 发起调宿/退宿入参 */
export interface DormChangeCreateBody {
  stage: TeachingStage;
  bizType: number;
  studentId: string;
  oldDormId?: string | null;
  oldBedId?: string | null;
  newDormId?: string | null;
  newBedId?: string | null;
  changeDate: string;
  changeReason: string;
}

/** 元信息：某学段宿舍页支持哪些特性 */
export interface DormStageMeta {
  stage: TeachingStage;
  stageName: string;
  /** ★ 该学段能否新建/编辑房间（大学=false，它的数据是教务同步来的） */
  hasCreate: boolean;
  /** 是否有楼层字段（只有初高有） */
  hasFloor: boolean;
  /** 是否有负责人/宿舍长（初大有，实训无） */
  hasOwner: boolean;
  /** 是否有所属班级（只有初高有） */
  hasClass: boolean;
  /** 是否有备注（只有实训有） */
  hasRemark: boolean;
  /** 是否有独立床位表（大学没有，靠同步表反推） */
  hasBedTable: boolean;
  /** 房间状态是否原生就是 int（false = varchar 要翻译） */
  roomStatusIsInt: boolean;
}

/** 统计卡片 */
export interface DormSummary {
  stage: TeachingStage;
  stageName: string;
  roomCount: number;
  bedCount: number;
  occupiedCount: number;
  /** 整体入住率（0~100，1 位小数） */
  occupancyRate: number;
  /** 空床位数 */
  vacantBeds: number;
}
