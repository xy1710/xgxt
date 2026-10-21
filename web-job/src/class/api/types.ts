/**
 * 前端用到的接口数据类型
 *
 * 字段名与后端返回**逐字对齐**（后端把所有表字段统一转成 camelCase 后返回）。
 * 这些类型是照着真实响应核对出来的，不是照文档猜的。
 */

export interface PageData<T> {
  total: number;
  page: number;
  size: number;
  list: T[];
}

/* ---------------- 学生（班级信息管理） ---------------- */

export interface StudentRow {
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  classId: string | null;
  className: string | null;
  age: number | null;
  phone: string | null;
  parentPhone: string | null;
  dormNo: string | null;
  bedNo: number | null;
  /** 学生来源：consult 咨询同步 / manual 班主任新建 */
  sourceSystem: string | null;
  enrollDate: string | null;
  education: string | null;
  studentStatus: number;
  studentStatusName: string;
  repeatCount: number;
  stage: number | null;
  stageName: string;
  remark: string | null;
  qualityTags: string[];
}

export interface StudentDetail {
  student: StudentRow & { idCard?: string | null; enrollDate?: string | null };
  profile: {
    birthDate: string | null;
    origin: string | null;
    graduateSchool: string | null;
    homeAddress: string | null;
    idPhotoUrl: string | null;
    householdPhotoUrl: string | null;
  };
  market: {
    recruitTeacherId: string | null;
    recruitTeacherName: string | null;
    recruitPhone: string | null;
    consultTeacherId: string | null;
    consultTeacherName: string | null;
    consultPhone: string | null;
  };
  quality: {
    studyStatus: string | null;
    discipline: string | null;
    ability: string | null;
    comprehension: string | null;
    expression: string | null;
    social: string | null;
    note: string | null;
  };
  repeats: RepeatRow[];
  dorm: Record<string, unknown> | null;
  grades: Array<Record<string, unknown>>;
  classInfo: ClassRow | null;
  classTransfers: Array<Record<string, unknown>>;
  /** 学生换班记录（班级信息管理「换班」→ 待接收 → 接收后留痕） */
  studentTransfers: StudentTransferRow[];
}

/** 末班记录（含成绩管理「末班」触发时的成绩快照） */
export interface RepeatRow {
  id: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  repeatTime: string;
  repeatReason: string | null;
  fromClassId: string | null;
  fromClassName: string | null;
  toClassId: string | null;
  toClassName: string | null;
  repeatCount: number;
  /** 触发末班的那次考试名称 */
  examName: string | null;
  /** 末班时笔试成绩 */
  writtenScore: number | string | null;
  /** 末班时面试成绩 */
  interviewScore: number | string | null;
  /** 末班时综合成绩 */
  compScore: number | string | null;
}

/** 学生换班记录（由那个班级 → 那个班级 + 原因 + 时间） */
export interface StudentTransferRow {
  id: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  fromClassId: string | null;
  fromClassName: string | null;
  toClassId: string | null;
  toClassName: string | null;
  transferReason: string | null;
  consultNo: string | null;
  transferTime: string;
}

/* ---------------- 班级 ---------------- */

export interface ClassRow {
  id: string;
  className: string;
  deptCode: number;
  stage: number | null;
  headTeacherId: string | null;
  headTeacherName: string | null;
  teacherId: string | null;
  teacherName: string | null;
  assistantId: string | null;
  assistantName: string | null;
  // ★ 2026-10-04：项目经理 / 就业指导老师 + 统一班级号
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
  universityNo?: string | null;
  room: string | null;
  openDate: string | null;
  studentCount: number;
  classStatus: number;
  attendanceRate: number | null;
  classStatusName?: string;
  stageName?: string;
}

/* ---------------- 出勤 / 成绩 / 考试 ---------------- */

export interface AttendanceRow {
  id: string;
  classId: string;
  className: string;
  attendanceDate: string;
  shouldCount: number;
  presentCount: number;
  absentCount: number;
  attendanceRate: number | null;
  teacherName: string | null;
  headTeacherName: string | null;
}

export interface AbsentRow {
  id: string;
  attendanceId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  /** 缺勤原因（后端字段名就是 absentReason，不是 reason） */
  absentReason: string | null;
  /** 缺勤类型：后端暂不返回，保留给后续细分「事假 / 病假」用 */
  absentType?: number;
  absentTypeName?: string;
  /** 联系电话，随详情一起返回，便于班主任直接联系家长 */
  phone?: string | null;
  attendanceDate?: string;
  classId?: string;
  className?: string;
}

export interface GradeRow {
  id: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  examId: string;
  examName: string;
  writtenScore: number | null;
  machineScore: number | null;
  interviewScore: number | null;
  compScore: number | null;
  examResult: number | null;
  examResultName?: string;
  analysis: string | null;
  remark: string | null;
}

export interface ExamContent {
  id: string;
  examId: string;
  examContentType: number;
  examContentTypeName?: string;
  fullScore: number | null;
  contentName: string;
}

export interface ExamRow {
  id: string;
  examName: string;
  examType: number;
  examTypeName?: string;
  creatorId: string | null;
  creatorName: string | null;
  examDate: string | null;
  classId: string | null;
  className: string | null;
  attendeeCount: number;
  contents: ExamContent[];
}

export interface ExamFieldRow {
  id: string;
  fieldKey: string;
  fieldType: string;
  defaultValue: string | null;
  source: string;
}

/** 考试详情：含考试本身 + 内容项 + 该场考试全班成绩 */
export interface ExamDetail {
  exam: ExamRow;
  contents: ExamContent[];
  grades: GradeRow[];
}

/* ---------------- 催费 / 缴费 ---------------- */

export interface UrgeRow {
  id: string;
  sourceSystem: string;
  sourceBatchNo: string | null;
  syncStatus: number;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  phone: string | null;
  parentPhone: string | null;
  headTeacherId: string | null;
  headTeacherName: string | null;
  feeType: number;
  feeTypeName?: string;
  /** 单位：分 */
  amount: number;
  amountYuan: string;
  expireDate: string;
  payStatus: number;
  payStatusName?: string;
  urgeCount: number;
  lastUrgeTime: string | null;
  overdueDays: number;
  isOverdue: boolean;

  /* ★ 2026-10-21 登记缴费五列（与初高 t_class_fee 同口径，对齐催费页操作列） */
  /** 缴费方式 1微信支付 2支付宝 3现金；未登记为 null */
  payMethod?: number | null;
  /** 枚举双返回 */
  payMethodName?: string;
  /** 实缴金额（分） */
  paidAmount?: number | null;
  /** 缴费日期 YYYY-MM-DD */
  payDate?: string | null;
  /** 缴费凭证地址 */
  voucherUrl?: string | null;
  /** 缴费备注 */
  payRemark?: string | null;
}

export interface UrgeLogRow {
  id: string;
  urgeId: string;
  studentId: string;
  studentName: string;
  channel: string;
  channelName?: string;
  remark: string | null;
  urgeTime: string;
  operatorName: string | null;
}

export interface FeeRow {
  id: string;
  sourceSystem: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  feeType: number;
  feeTypeName?: string;
  amount: number;
  amountYuan: string;
  paidAmount: number | null;
  paidAmountYuan: string;
  unpaidAmountYuan: string;
  payStatus: number;
  payStatusName?: string;
  payDate: string | null;
  expireDate: string | null;
  payMethod: string | null;
  voucherUrl: string | null;
  /** ★ 2026-10-06：费用周期（源：财务，如 2026-09） */
  period?: string | null;
  /** ★ 2026-10-06：部门 1 二三期（初高部） / 2 大学部 */
  deptCode?: number | null;
  deptName?: string;
}

/* ---------------- 宿舍 ---------------- */

export interface DormRoomRow {
  id: string;
  sourceSystem: string;
  buildingId: string | null;
  buildingName: string | null;
  dormType: number;
  dormTypeName?: string;
  dormNo: string;
  bedCount: number;
  usedCount: number;
  leaderStudentId: string | null;
  leaderStudentName: string | null;
  isFull: boolean;
  /** 房间所属班级（由入住学员的班级推导，可能多班合并显示） */
  className?: string | null;
  /** 房间负责人（由入住学员所在班级的班主任推导） */
  teacherName?: string | null;
  /** 床位明细（宿舍号-床位号 + 入住人），供「分派宿舍」表格直接铺满 */
  beds?: DormRoomBed[];
}

/** 「分派宿舍」表里每个床位的展示数据 */
export interface DormRoomBed {
  bedNo: number;
  label: string;
  occupied: boolean;
  studentId: string | null;
  studentNo: string | null;
  studentName: string | null;
  className: string | null;
}

export interface DormLiveRow {
  id: string;
  sourceSystem: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  dormId: string | null;
  dormNo: string | null;
  checkInDate: string | null;
}

export interface DormChangeRow {
  id: string;
  studentId: string;
  studentName: string;
  fromDormNo: string | null;
  toDormNo: string | null;
  changeReason: string | null;
  changeTime: string;
  operatorName: string | null;
}

export interface DormApplyRow {
  id: string;
  applyNo: string;
  applyCategory: number;
  applyCategoryName?: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  fromDormNo: string | null;
  toDormNo: string | null;
  applyReason: string;
  applyStatus: number;
  applyStatusName?: string;
  applicantName: string | null;
  applyTime: string;
  approveOpinion: string | null;
}

/* ---------------- 班级阶段推进 / 升实训交接 ---------------- */

export interface StageAdvanceResult {
  classId: string;
  fromStage: number;
  toStage: number;
  fromStageName: string;
  toStageName: string;
  studentCount: number;
}

export interface StageLogRow {
  id: string;
  classId: string;
  className: string;
  fromStage: number;
  fromStageName: string;
  toStage: number;
  toStageName: string;
  studentCount: number;
  operateTime: string;
  operatorName: string;
  reason: string | null;
}

export interface TrainingUpgradeResult {
  classId: string;
  handoffNo: string;
  studentCount: number;
}

export interface TrainingRow {
  id: string;
  handoffNo: string;
  classId: string;
  className: string;
  stage: number | null;
  stageName: string | null;
  headTeacherName: string | null;
  teacherName: string | null;
  studentCount: number;
  toModule: string | null;
  handoffStatus: number | null;
  handoffTime: string | null;
  operatorName: string | null;
  remark: string | null;
}

/* ---------------- 宿舍床位 ---------------- */

export interface BedItem {
  bedNo: number;
  label: string;
  occupied: boolean;
  studentId: string | null;
  studentNo: string | null;
  studentName: string | null;
  classId: string | null;
  className: string | null;
  phone: string | null;
}

export interface UnassignedItem {
  studentId: string;
  studentNo: string;
  studentName: string;
  className: string | null;
}

export interface BedListResult {
  dormId: string;
  dormNo: string;
  buildingName: string;
  bedCount: number;
  usedCount: number;
  beds: BedItem[];
  unassigned: UnassignedItem[];
}

/* ---------------- 咨询（待接收学员） ---------------- */

export interface ConsultItem {
  id: string;
  consultNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  phone: string;
  parentPhone: string;
  age: number | null;
  education: string | null;
  origin: string | null;
  graduateSchool: string | null;
  homeAddress: string | null;
  intendDeptCode: number | null;
  intendDeptName: string | null;
  /** ★ 2026-10-19：意向阶段已删除（后端不再下发），阶段一律取目标班级的 */
  intendClassId: string | null;
  intendClassName: string | null;
  remark: string | null;
  applyStatus: number;
  applyStatusName: string;
  pushTime: string | null;
  receiverId: string | null;
  receiverName: string | null;
  receiveTime: string | null;
  rejectReason: string | null;
  studentId: string | null;
  studentNo: string | null;
  sourceSystem: string | null;
  /** 目标班是否属于初高（1 初高部）—— 接收弹窗据此隐藏大学部才有的字段 */
  targetIsJh?: boolean;
  /** 当前登录人能否接收 / 驳回（后端按「目标班是不是我带的班」算好） */
  canReceive?: boolean;
  /** 是否末班 / 重修转入（成绩管理「末班」推来） */
  isRepeatIn?: boolean;
  /** 是否换班转入（班级信息管理「换班」推来） */
  isTransfer?: boolean;
  /** 来源类型文案：咨询新生 / 末班重修 / 换班转入 */
  sourceKind?: string;
  originStudentId?: string | null;
  fromClassId?: string | null;
  fromClassName?: string | null;
  /** 换班原因（source_system=transfer 时） */
  transferReason?: string | null;
}

export interface ConsultReceivePayload {
  id: string;
  classId?: string | null;
  studentNo?: string | null;
  age?: number | null;
  phone?: string | null;
  parentPhone?: string | null;
  education?: string | null;
  enrollDate?: string | null;
  studentStatus?: number | null;
  dormId?: string | null;
  dormNo?: string | null;
  bedNo?: number | null;
  remark?: string | null;
  /** 末班 / 重修转入：为 true 时封班班级也可接收，且不新建学生档案 */
  repeatIn?: boolean;
}

export interface ConsultRejectPayload {
  id: string;
  rejectReason: string;
}

/* ---------------- 审批 ---------------- */

export interface ApprovalLogRow {
  id: string;
  applyType: number;
  applyTypeName?: string;
  applyNo: string;
  bizId: string;
  action: string;
  actionName?: string;
  fromStatus: number | null;
  toStatus: number | null;
  operatorId: string;
  operatorName: string;
  operatorRole: string;
  opinion: string | null;
  operateTime: string;
}

export interface SuspendRow {
  id: string;
  applyNo: string;
  applyType: number;
  applyTypeName?: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  idCard: string | null;
  parentPhone: string | null;
  applyReason: string;
  effectDate: string | null;
  expectResumeDate: string | null;
  occurredAmount: number | null;
  refundableAmount: number | null;
  occurredAmountYuan?: string | null;
  refundableAmountYuan?: string | null;
  applyStatus: number;
  applyStatusName?: string;
  currentHandlerName?: string;
  applicantId: string;
  applicantName: string;
  applyTime: string;
  managerApproverName: string | null;
  managerApproveTime: string | null;
  managerOpinion: string | null;
  principalApproverName: string | null;
  principalApproveTime: string | null;
  principalOpinion: string | null;
  rejectReason: string | null;
}

export interface SuspendDetail {
  apply: SuspendRow;
  logs: ApprovalLogRow[];
  nextHandlerRole: string;
  nextHandlerName: string;
  canApprove: boolean;
}

export interface RefundItem {
  feeType: number;
  feeTypeName: string;
  amount: number;
  amountYuan: string;
}

export interface RefundRow {
  id: string;
  applyNo: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  refundAmount: number;
  refundAmountYuan: string;
  refundReason: string;
  refundStatus: number;
  refundStatusName?: string;
  isNeedPrincipal: boolean;
  currentHandlerRole: string | null;
  currentHandlerName?: string;
  applicantId: string;
  applicantName: string;
  applyTime: string;
  rejectReason: string | null;
  refundItems: RefundItem[];
}

export interface UpgradeRow {
  id: string;
  applyNo: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  who?: string;
  fromDeptCode: number;
  fromDeptName?: string;
  fromStage: number;
  fromStageName?: string;
  fromClassId: string | null;
  fromClassName: string | null;
  toDeptCode: number;
  toDeptName?: string;
  toStage: number;
  toStageName?: string;
  toClassId: string | null;
  toClassName: string | null;
  examScore: number | null;
  gradeSnapshot: unknown;
  applyStatus: number;
  applyStatusName?: string;
  applicantName: string | null;
  applyTime: string;
  receiveTime: string | null;
  receiverName: string | null;
  rejectReason: string | null;
  sourceSystem: string | null;
}

export interface TodoRow {
  id: string;
  applyType: number;
  applyTypeName: string;
  bizId: string;
  applyNo: string;
  studentName: string;
  studentNo: string;
  className: string | null;
  currentStatus: number;
  currentStatusName: string;
  applyTime: string;
  applicantName: string | null;
  linkPath: string | null;
}

/* ---------------- 通知 ---------------- */

export interface NotifyRow {
  id: string;
  notifyType: number;
  notifyTypeName?: string;
  applyType: number | null;
  applyTypeName?: string;
  bizId: string | null;
  applyNo: string | null;
  title: string;
  content: string;
  receiverId: string;
  receiverName: string | null;
  isRead: number;
  readTime: string | null;
  linkPath: string | null;
  createTime: string;
}
