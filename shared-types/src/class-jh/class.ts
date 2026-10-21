/**
 * 教学管理（初高）模块实体类型（见 ARCH §4.4）
 *
 * ⚠️ 每个 interface 均继承 BaseEntity（id/createTime/createBy/updateTime/updateBy/isDeleted）。
 *    「双返回」字段命名规则：xxx 为枚举值，xxxName 为其中文名，前端直接显示 xxxName。
 *    金额字段统一 xxxAmount，单位「分」（整数）。
 */

import {
  ClassStatus,
  Gender,
  HandoverRole,
  ShareChannel,
  ExamStatus,
  ExamResult,
  ApplyStatus,
  DormType,
  FeeType,
  PayStatus,
  RefundStatus,
  AttendanceStatus,
  FlowType,
  AgreementStatus,
  SuspendStatus,
} from './enums';
import { BaseEntity } from './common';

/* ============================================================
 * 一、班级管理
 * ============================================================ */

/** 班级主档 */
export interface ClassInfo extends BaseEntity {
  classId: string;
  className: string;
  /** 学习阶段 101~107 / 201~204 */
  stage: number;
  /** 双返回 */
  stageName: string;
  headTeacherId: string;
  headTeacherName: string;
  teacherId: string;
  teacherName: string;
  assistantId?: string;
  assistantName?: string;
  /** 教室 ★ */
  classroom?: string;
  /** 开班日期 ★ YYYY-MM-DD */
  openDate?: string;
  deptCode: number;
  classStatus: ClassStatus;
  /** 双返回 */
  classStatusName: string;
  /** 班级人数（动态回写） */
  studentCount?: number;
  /** 今日出勤率（回流） */
  todayAttendanceRate?: number;
  remark?: string;
}

/** 师资交接记录 */
export interface ClassHandover extends BaseEntity {
  handoverId: string;
  classId: string;
  className: string;
  handoverRole: HandoverRole;
  /** 双返回 */
  handoverRoleName: string;
  fromUserId?: string;
  fromUserName?: string;
  toUserId: string;
  toUserName: string;
  handoverReason?: string;
  handoverContent: string;
  /** YYYY-MM-DD HH:mm:ss */
  handoverTime: string;
  arrangeUserId?: string;
  arrangeUserName?: string;
}

/** 学期（P1） */
export interface ClassTerm extends BaseEntity {
  termId: string;
  classId: string;
  className?: string;
  termName: string;
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD */
  endDate?: string;
  remark?: string;
}

/* ============================================================
 * 二、出勤管理
 * ============================================================ */

/** 出勤台账（按班按日） */
export interface AttendanceRecord extends BaseEntity {
  attendanceId: string;
  classId: string;
  className: string;
  /** YYYY-MM-DD */
  attendanceDate: string;
  attendanceRate?: number;
  /** 应到人数 ★ */
  shouldCount?: number;
  /** 已到人数 ★ */
  actualCount?: number;
  /** 当月未达标数 ★ */
  monthUnqualifiedCount?: number;
  teacherId?: string;
  teacherName?: string;
  headTeacherId?: string;
  headTeacherName?: string;
  /** 出勤表文件地址 ★ */
  fileUrl?: string;
  remark?: string;
}

/** 出勤明细 */
export interface AttendanceDetail extends BaseEntity {
  detailId: string;
  attendanceId: string;
  classId: string;
  /** YYYY-MM-DD */
  attendanceDate: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  phone?: string;
  parentPhone?: string;
  attendanceStatus: AttendanceStatus;
  /** 双返回 */
  attendanceStatusName: string;
  /** 缺勤/异常原因 ★ */
  absentReason?: string;
}

/* ============================================================
 * 三、考试管理
 * ============================================================ */

/** 考试 */
export interface Exam extends BaseEntity {
  examId: string;
  /** 考试名称 ★ */
  examName: string;
  /** 1 月考/2 质素考核/3 阶段考核/4 结业考试/5 其他 */
  examType: number;
  /** 双返回 */
  examTypeName: string;
  /** YYYY-MM-DD */
  examDate: string;
  classId: string;
  className: string;
  /** 内容项数组 [1,2,3,4] ★ */
  examContentTypes: number[];
  /** 各内容项默认满分 ★ */
  contentFullScore?: Record<string, number>;
  examStatus: ExamStatus;
  /** 双返回 */
  examStatusName: string;
  /** 评分老师（质素考核）★ */
  scoreTeacherIds?: string[];
  /** 评委（阶段考核）★ */
  judgeIds?: string[];
  /** 创建人姓名（按账号）★ */
  createByName?: string;
  remark?: string;
}

/** 考试成绩（老师各记一条；学生最终分取平均，展示计算） */
export interface ExamScore extends BaseEntity {
  scoreId: string;
  examId: string;
  examType?: number;
  /** YYYY-MM-DD */
  examDate?: string;
  classId?: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  /** 各内容项得分 ★ */
  scoreWritten?: number;
  scoreMachine?: number;
  scoreInterview?: number;
  scoreOther?: number;
  /** 总分 */
  scoreTotal?: number;
  /** 评分老师（一位一条）★ */
  scoreTeacherId?: string;
  scoreTeacherName?: string;
  examResult?: ExamResult;
  /** 双返回 */
  examResultName?: string;
  /** 结业考试是否通过（经理决定）★ */
  isPassed?: boolean;
  /** 自定义字段值 ★ */
  customValues?: Record<string, any>;
  remark?: string;
}

/** 考试自定义字段 */
export interface ExamField extends BaseEntity {
  fieldId: string;
  examId: string;
  /** 字段名 ★ */
  fieldName: string;
  /** 1 纯文字/2 数字 ★ */
  fieldType: number;
  sortNo?: number;
}

/* ============================================================
 * 四、宿舍管理（镜像表 + 分派/调宿/退宿）
 * ============================================================ */

/** 楼栋（镜像） */
export interface DormBuilding extends BaseEntity {
  buildingId: string;
  /** 楼栋 ★ */
  buildingName: string;
  /** 所属校区 ★ */
  campusName?: string;
  /** 楼层数 ★ */
  floorCount?: number;
  /** 房间数（派生） */
  roomCount?: number;
  /** 已入住（派生） */
  occupiedCount?: number;
  /** 床位总数（派生） */
  bedTotal?: number;
  /** 楼管 */
  managerName?: string;
  managerPhone?: string;
  /** 对接部门 ★ */
  deptName?: string;
  /** 使用中/停用 ★ */
  buildingStatus?: string;
  /** 数据来源 ★ */
  dataSource?: string;
}

/** 房间 */
export interface DormRoom extends BaseEntity {
  roomId: string;
  roomNo: string;
  buildingId: string;
  buildingName: string;
  /** 楼层 ★ */
  floorNo?: number;
  dormType: DormType;
  /** 双返回 */
  dormTypeName: string;
  /** 床位数 ★ */
  bedCount: number;
  /** 已入住（动态）★ */
  occupiedCount?: number;
  /** 入住率 ★ */
  occupancyRate?: number;
  classId?: string;
  className?: string;
  /** 负责人 ★ */
  ownerName?: string;
  /** 数据来源 ★ */
  dataSource?: string;
  /** 使用中/空置/维修/停用 ★ */
  roomStatus?: string;
}

/** 床位 */
export interface DormBed extends BaseEntity {
  bedId: string;
  roomId: string;
  roomNo: string;
  buildingId: string;
  /** 床位号 ★ */
  bedNo: string;
  dormType?: DormType;
  /** 空闲/已占用/维修 ★ */
  bedStatus?: string;
  /** 当前占用学生 */
  studentId?: string;
}

/** 宿舍入住 */
export interface DormResident extends BaseEntity {
  residentId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  gender?: Gender;
  buildingId: string;
  /** 楼栋号（如 A栋 / B栋）★ */
  buildingName?: string;
  roomId: string;
  roomNo: string;
  bedId: string;
  /** 床位号 ★ */
  bedNo: string;
  /** 入住时间 ★ YYYY-MM-DD */
  checkInDate: string;
  /** 房间负责人 ★ */
  ownerName?: string;
  /** 是否在住 */
  isActive: boolean;
}

/** 调宿申请 */
export interface DormApply extends BaseEntity {
  applyId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  fromRoomId: string;
  fromRoomNo: string;
  fromBedId: string;
  /** 原房间楼栋名（派生，便于展示） */
  fromBuildingName?: string;
  /** 原床位号，如「1号床」（派生，便于展示；避免前端只看得到床位ID） */
  fromBedNo?: string;
  toRoomId: string;
  toRoomNo: string;
  toBedId: string;
  /** 目标房间楼栋名（派生，便于展示） */
  toBuildingName?: string;
  /** 目标床位号，如「1号床」（派生，便于展示） */
  toBedNo?: string;
  /** 换宿原因 ★ */
  applyReason: string;
  applyUserId?: string;
  applyUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  applyTime?: string;
  applyStatus: ApplyStatus;
  /** 双返回 */
  applyStatusName: string;
  approveUserId?: string;
  approveUserName?: string;
  approveTime?: string;
  /** 物品完好确认 ★ */
  isItemIntact?: boolean;
  rejectReason?: string;
}

/** 退宿申请 */
export interface CheckoutApply extends BaseEntity {
  checkoutId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  roomId: string;
  roomNo: string;
  bedId: string;
  bedNo: string;
  checkoutReason?: string;
  applyUserId?: string;
  applyUserName?: string;
  applyTime?: string;
  applyStatus: ApplyStatus;
  /** 双返回 */
  applyStatusName: string;
  approveUserId?: string;
  approveUserName?: string;
  approveTime?: string;
  rejectReason?: string;
}

/* ============================================================
 * 五、费用 / 催费 / 退费
 * ============================================================ */

/** 缴费台账（镜像） */
export interface FeeRecord extends BaseEntity {
  feeId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  deptCode?: number;
  /** ★ 2026-10-20 用户要求：学生手机号（来自 t_class_student.phone，左连取） */
  phone?: string | null;
  /** ★ 2026-10-20 用户要求：家长手机号（催费主要打这个；t_class_student.parent_phone） */
  parentPhone?: string | null;
  feeType: FeeType;
  /** 双返回 */
  feeTypeName: string;
  /** 金额（分） */
  feeAmount: number;
  payStatus: PayStatus;
  /** 双返回 */
  payStatusName: string;
  /** YYYY-MM-DD */
  payDate?: string;
  /** YYYY-MM-DD */
  expireDate?: string;
  /** 剩余天数（派生） */
  remainDays?: number;
  /** 是否紧急（派生，按配置阈值） */
  isUrgent?: boolean;
  voucherUrl?: string;
  /** 缴费方式 1微信支付 2支付宝 3现金（★ 2026-10-20 登记缴费；未登记为 null） */
  payMethod?: number | null;
  /** 双返回 */
  payMethodName?: string | null;
  /** 实缴金额（分）；与 feeAmount（应缴）分开存，允许部分缴 */
  paidAmount?: number | null;
  /** 缴费备注（转账单号/说明） */
  payRemark?: string | null;
  /**
   * 是否已转交财务（★ 2026-10-20）
   *
   * 判据：source_system='finance' 且有 source_id —— 说明这张单已经有对应的财务缴费单。
   * 批量转交时「只选未上传过」就是按这个标记过滤。
   */
  transferred?: boolean;
}

/** 催费记录 */
export interface FeeNotify extends BaseEntity {
  notifyId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  feeType?: FeeType;
  /** 双返回 */
  feeTypeName?: string;
  feeAmount?: number;
  expireDate?: string;
  shareChannel: ShareChannel;
  /** 双返回 */
  shareChannelName: string;
  notifyUserId?: string;
  notifyUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  notifyTime: string;
  /** 发送内容（表列沿用了 remark 这个旧名） */
  remark?: string;
}

/** 退费申请 */
export interface RefundApply extends BaseEntity {
  refundId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  classId?: string;
  className?: string;
  deptCode?: number;
  /** 退费类型 1~4 */
  feeType: FeeType;
  /** 双返回 */
  feeTypeName: string;
  /** 退费金额（分） */
  refundAmount: number;
  /** 退费原因 ★ */
  refundReason: string;
  /** 班主任意见 ★ */
  headTeacherOpinion?: string;
  /** YYYY-MM-DD */
  applyDate: string;
  /** 费用是否用完 ★ */
  isFeeUsedUp?: boolean;
  refundStatus: RefundStatus;
  /** 双返回 */
  refundStatusName: string;
  /** 当前处理人（推导）★ */
  currentHandlerName?: string;
  applyUserId?: string;
  applyUserName?: string;
  approveUserId?: string;
  approveUserName?: string;
  approveTime?: string;
  rejectReason?: string;
  /** 申请时阈值快照（分） */
  thresholdAmount?: number;
  /** 财务出款时间 ★ */
  payOutTime?: string;
  /** 出款凭证号 ★ */
  payOutVoucherNo?: string;
}

/** 退费审批日志 */
export interface RefundLog extends BaseEntity {
  logId: string;
  refundId: string;
  /** 该节点状态（2/3/4/5） */
  nodeStatus: number;
  approveUserId?: string;
  approveUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  approveTime: string;
  /** 1 同意/2 驳回 */
  approveResult: number;
  rejectReason?: string;
  remark?: string;
}

/* ============================================================
 * 六、流程 / 末班 / 设置 / 日志
 * ============================================================ */

/** 统一流程申请（休学/复学/转班/换人/退学/就业协议/末班） */
export interface FlowApply extends BaseEntity {
  /** 流程 ID（后端返回的流程标识，等同 id） */
  flowId: string;
  flowType: FlowType;
  /** 双返回 */
  flowTypeName: string;
  studentId?: string;
  studentNo?: string;
  studentName?: string;
  classId?: string;
  className?: string;
  applyUserId?: string;
  applyUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  applyTime?: string;
  applyReason?: string;
  flowStatus: number;
  /** 双返回 */
  flowStatusName: string;
  /** 当前节点 ★ */
  currentNodeName?: string;
  approveUserId?: string;
  approveUserName?: string;
  approveTime?: string;
  rejectReason?: string;
  /** 休/退状态（冗余） */
  suspendStatus?: SuspendStatus;
  /** 计划休学开始日 ★ YYYY-MM-DD */
  suspendStartDate?: string;
  /** 预计复学时间 ★ YYYY-MM-DD */
  expectResumeDate?: string;
  /** 休/退原因 ★ */
  suspendReason?: string;
  idCardNo?: string;
  phone?: string;
  attendedHours?: number;
  /** 复学班级/日期 ★ */
  resumeClassId?: string;
  resumeDate?: string;
  /** 是否恢复餐宿费 ★ */
  isMealDormRestored?: boolean;
  /** 转班原/新班级 ★ */
  fromClassId?: string;
  toClassId?: string;
  fromStage?: number;
  toStage?: number;
  transferReason?: string;
  /** 1 班主任/2 教员 ★ */
  handoverRole?: HandoverRole;
  fromUserId?: string;
  toUserId?: string;
  handoverReason?: string;
  handoverContent?: string;
  handoverTime?: string;
  arrangeUserId?: string;
  /** 就业协议存档 ★ */
  agreementStatus?: AgreementStatus;
  signDate?: string;
  agreementFileUrl?: string;
}

/** 流程审批日志 */
export interface FlowLog extends BaseEntity {
  logId: string;
  flowId: string;
  nodeName?: string;
  approveUserId?: string;
  approveUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  approveTime: string;
  /** 1 同意/2 驳回 */
  approveResult: number;
  rejectReason?: string;
  remark?: string;
}

/** 末班记录 */
export interface RepeatRecord extends BaseEntity {
  repeatId: string;
  studentId: string;
  studentNo: string;
  studentName: string;
  fromClassId?: string;
  fromClassName?: string;
  fromStage?: number;
  toClassId: string;
  toClassName: string;
  toStage?: number;
  /** 末班原因 ★ */
  repeatReason: string;
  /** 末班时间 ★ YYYY-MM-DD HH:mm:ss */
  repeatTime: string;
  /** 累计次数（不设上限） */
  repeatCount: number;
  /** 被通知班主任 ★ */
  notifyUserId?: string;
  isNotified?: boolean;
}

/** 系统设置 KV */
export interface ClassSetting extends BaseEntity {
  settingKey: string;
  settingName?: string;
  settingValue?: string;
  remark?: string;
}

/** 学习阶段字典（P2） */
export interface StageDict extends BaseEntity {
  stageCode: number;
  stageName: string;
  deptCode: number;
  /** 学制月数 */
  studyMonths?: number;
  sortNo?: number;
}

/**
 * 阶段方案 · 阶段明细（★ 2026-10-16）
 *
 * 方案里的一个阶段：阶段名称 + 学制月数。
 * 例：方案一 → 一阶段 2月 / 二阶段 2月 / 三阶段 2月。
 */
export interface StageSchemeStage {
  id: string;
  stageName: string;
  /** 学制月数 */
  studyMonths?: number | null;
  /** 方案内顺序 */
  sortNo?: number;
}

/**
 * 阶段方案（★ 2026-10-16：原「阶段字典」升级）
 *
 * 一个方案 = 方案名称 + 所属部门 + N 个阶段明细；
 * 班级新增/编辑时先选方案、再选阶段（阶段选项 = 该方案的阶段明细）。
 */
export interface StageScheme {
  id: string;
  schemeName: string;
  /** 所属部门 1初高部 2大学部 */
  deptCode: number;
  deptName?: string;
  /** 方案下的阶段（按 sortNo 升序） */
  stages: StageSchemeStage[];
}

/** 操作日志 */
export interface OpLog extends BaseEntity {
  logId: string;
  module?: string;
  /** 休学/退学/末班/交接/调宿/退费 */
  bizType: string;
  bizId?: string;
  studentId?: string;
  classId?: string;
  opUserId?: string;
  opUserName?: string;
  /** YYYY-MM-DD HH:mm:ss */
  opTime: string;
  opDesc?: string;
  beforeValue?: Record<string, any>;
  afterValue?: Record<string, any>;
}

/** 工作台待办项 */
export interface DashboardTodo {
  type: string;
  title: string;
  count: number;
  path?: string;
}

/** 工作台统计 */
export interface DashboardStat {
  /** 在读学生数 */
  readingStudentCount: number;
  /** 今日出勤率 */
  todayAttendanceRate: number;
  /** 目标出勤率（配置） */
  attendanceTargetRate: number;
  /** 紧急催费数 */
  urgentFeeCount: number;
  /** 待办总数 */
  pendingTodoCount: number;
  /** 待办清单 */
  todos: DashboardTodo[];
}
