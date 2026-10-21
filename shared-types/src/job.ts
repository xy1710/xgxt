/**
 * 就业模块类型定义（server-job / web-job 共用）
 *
 * ⚠️ 本文件的字段与《就业.xmind》脑图一一对应：
 *    - 信息档案 → 基础信息 / 宿舍分配 / 复盘信息 / 就业日志记录
 *    - 就业日志 → Dorm/EmploymentLog
 *    - 复盘填写 → Review
 *    - 消息通知 → NotificationMsg
 *    - 数据统计 → JobStatistics / KpiTarget
 */

import { BaseEntity, PageQuery } from './common';
import { StudentStatus } from './enums';

/* ============================================================
 * 枚举定义
 * ============================================================ */

/**
 * 就业模块关注的学生状态（脑图限定这四种）
 *
 * ⚠️ 其他模块的 11 种状态这里一概不管，避免页面出现一堆无关选项
 */
export const JOB_STUDENT_STATUS_LIST = [
  StudentStatus.WAIT_EMPLOY,  // 待就业
  StudentStatus.EMPLOYED,     // 已就业
  StudentStatus.SUSPENDED,    // 休学
  StudentStatus.QUIT,         // 退学
] as const;

/** 面试结论（复盘填写 - 面试结论） */
export enum InterviewConclusion {
  WAIT = 1,    // 待反馈
  OFFER = 2,   // 已发 offer
  PASS = 3,    // 通过（进入下一轮）
  FAIL = 4,    // 未通过
}

/** 复盘结论（复盘填写 - 复盘结论） */
export enum ReviewConclusion {
  KEEP = 1,     // 保持当前策略
  IMPROVE = 2,  // 需强化辅导
  ADJUST = 3,   // 调整求职方向
  SIGNED = 4,   // 已签约入职
}

/** 消息通知类型 */
export enum NotificationType {
  SYSTEM = 1,     // 系统通知
  INTERVIEW = 2,  // 面试提醒
  REVIEW = 3,     // 复盘提醒
  EMPLOYMENT = 4, // 就业通知
}

/** 阅读状态 */
export enum ReadStatus {
  UNREAD = 0, // 未读
  READ = 1,   // 已读
}

/* ============================================================
 * 枚举中文名映射（后端双返回，前端直接显示 xxxName）
 * ============================================================ */

export const INTERVIEW_CONCLUSION_NAME: Record<number, string> = {
  [InterviewConclusion.WAIT]: '待反馈',
  [InterviewConclusion.OFFER]: '已发 offer',
  [InterviewConclusion.PASS]: '通过',
  [InterviewConclusion.FAIL]: '未通过',
};

export const REVIEW_CONCLUSION_NAME: Record<number, string> = {
  [ReviewConclusion.KEEP]: '保持当前策略',
  [ReviewConclusion.IMPROVE]: '需强化辅导',
  [ReviewConclusion.ADJUST]: '调整求职方向',
  [ReviewConclusion.SIGNED]: '已签约入职',
};

export const NOTIFICATION_TYPE_NAME: Record<number, string> = {
  [NotificationType.SYSTEM]: '系统通知',
  [NotificationType.INTERVIEW]: '面试提醒',
  [NotificationType.REVIEW]: '复盘提醒',
  [NotificationType.EMPLOYMENT]: '就业通知',
};

export const READ_STATUS_NAME: Record<number, string> = {
  [ReadStatus.UNREAD]: '未读',
  [ReadStatus.READ]: '已读',
};

/* ============================================================
 * 宿舍
 * ============================================================ */

/** 就业基地宿舍实体（⚠️ 与实训基地宿舍是两套，见 docs/实训-就业合并方案） */
export interface Dorm extends BaseEntity {
  /** 宿舍号 D-S-301 */
  dormNo: string;
  /** 楼栋 A 栋 */
  building: string;
  /** 楼层 */
  floor: number;
  /** 宿舍类型：1 男寝 2 女寝（复用 DormType） */
  roomType: number;
  roomTypeName: string;
  /** 总床位 */
  bedTotal: number;
  /** 已住人数（实时统计） */
  bedUsed: number;
  remark?: string;
}

export interface DormSavePayload {
  dormNo: string;
  building: string;
  floor: number;
  roomType: number;
  bedTotal: number;
  remark?: string;
}

export interface EmpDormQuery extends PageQuery {
  dormNo?: string;
  building?: string;
  roomType?: number;
  /** 只查还有空床位的 */
  onlyAvailable?: boolean;
}

/** 宿舍成员（住宿学生） */
export interface DormMember {
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  className?: string;
  phone?: string;
  studentStatus: number;
  studentStatusName: string;
}

/* ============================================================
 * 就业日志
 * ============================================================ */

/**
 * 就业日志实体
 *
 * 脑图字段对照：
 *   姓名 studentName / 有效简历投递 resumeCount / 面试邀约 interviewInvite
 *   面试场次 interviewCount / 面试时间 interviewTime / 面试公司 company
 *   面试情况 interviewSituation
 * 信息档案 - 就业日志记录 还用到：岗位 position / 薪资 salary
 */
export interface EmploymentLog extends BaseEntity {
  studentId: string;
  studentName: string;
  studentNo: string;
  className?: string;
  /** 日志日期 YYYY-MM-DD */
  logDate: string;
  /** 有效简历投递数 */
  resumeCount: number;
  /** 面试邀约数 */
  interviewInvite: number;
  /** 面试场次 */
  interviewCount: number;
  /** 面试时间 YYYY-MM-DD HH:mm */
  interviewTime?: string;
  /** 面试公司 */
  company?: string;
  /** 岗位 */
  position?: string;
  /** 薪资（元/月） */
  salary?: number;
  /** 面试情况 */
  interviewSituation?: string;
}

export interface EmploymentLogSavePayload {
  id?: string;
  /**
   * ★ 2026-10-16：姓名改为可直接手填，本字段变为可选。
   *   后端会用 studentName 去学生库精确匹配：唯一命中就自动关联（带出学号/班级），
   *   匹配不到则只存姓名、不关联学生。
   */
  studentId?: string;
  /** 姓名（手填）。后端会尝试用它匹配学生 */
  studentName: string;
  logDate: string;
  resumeCount: number;
  interviewInvite: number;
  interviewCount: number;
  interviewTime?: string;
  company?: string;
  position?: string;
  salary?: number;
  interviewSituation?: string;
}

export interface EmploymentLogQuery extends PageQuery {
  studentName?: string;
  company?: string;
  /** YYYY-MM-DD */
  startDate?: string;
  /** YYYY-MM-DD */
  endDate?: string;
  studentId?: string;
  /** ★ 2026-10-16：按班级筛选（后端经 student_id 子查询，兼容学生被调班的历史数据） */
  classId?: string;
}

/**
 * ★ 2026-10-16：就业日志 / 复盘 筛选用「班级下拉」选项（只读）
 *
 * 走各自业务路由下的 /classes（沿用 job:employmentLog:view / job:review:view），
 * **不要**改用 /api/job/class/options —— 就业老师没有「班级管理」页面权限，会 403。
 */
export interface JobClassOption {
  id: string;
  className: string;
}

/* ============================================================
 * 复盘
 * ============================================================ */

/**
 * 复盘实体
 *
 * 脑图字段对照：
 *   复盘填写 - 界面：姓名 / 工资 salary / 岗位 position
 *                    面试结论 interviewConclusion / 复盘结论 reviewConclusion
 *   复盘填写 - 操作：上传录音 audioData
 *   信息档案 - 复盘信息：复盘时间 reviewTime / 岗位 position
 *                       时间 interviewTime / 结论 reviewConclusion
 */
export interface Review extends BaseEntity {
  studentId: string;
  studentName: string;
  studentNo: string;
  className?: string;
  /** 复盘时间 YYYY-MM-DD HH:mm */
  reviewTime: string;
  /** 面试时间（脑图中的「时间」）YYYY-MM-DD HH:mm */
  interviewTime?: string;
  /** 岗位 */
  position?: string;
  /** 工资（元/月） */
  salary?: number;
  /** 面试结论 */
  interviewConclusion?: number;
  interviewConclusionName?: string;
  /** 复盘结论 */
  reviewConclusion?: number;
  reviewConclusionName?: string;
  /** 录音文件名 */
  audioName?: string;
  /** 录音内容（base64 dataURL，由前端上传） */
  audioData?: string;
  /** 复盘详情 */
  detail?: string;
}

export interface ReviewSavePayload {
  id?: string;
  /**
   * ★ 2026-10-16：姓名改为可直接手填，本字段变为可选。
   *   后端会用 studentName 去学生库精确匹配：唯一命中就自动关联（带出学号/班级），
   *   匹配不到则只存姓名、不关联学生。
   */
  studentId?: string;
  /** 姓名（手填）。后端会尝试用它匹配学生 */
  studentName: string;
  reviewTime: string;
  interviewTime?: string;
  position?: string;
  salary?: number;
  interviewConclusion?: number;
  reviewConclusion?: number;
  audioName?: string;
  audioData?: string;
  detail?: string;
}

export interface ReviewQuery extends PageQuery {
  studentName?: string;
  position?: string;
  reviewConclusion?: number;
  interviewConclusion?: number;
  startDate?: string;
  endDate?: string;
  studentId?: string;
  /** ★ 2026-10-16：按班级筛选（后端经 student_id 子查询，兼容学生被调班的历史数据） */
  classId?: string;
}

/* ============================================================
 * 消息通知
 * ============================================================ */

export interface NotificationMsg extends BaseEntity {
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 类型 */
  type: number;
  typeName: string;
  /** 接收人（就业老师姓名，空表示全员） */
  receiver?: string;
  /** 阅读状态 */
  readStatus: number;
  readStatusName: string;
}

export interface NotificationSavePayload {
  title: string;
  content: string;
  type: number;
  receiver?: string;
}

export interface NotificationQuery extends PageQuery {
  title?: string;
  type?: number;
  readStatus?: number;
}

/* ============================================================
 * 数据统计
 * ============================================================ */

/** 就业核心指标（脑图：就业人数 / 获得offer / 就业率 / 平均投简历数 / kpi） */
export interface JobOverview {
  /** 就业人数（学生状态 = 已就业） */
  employedCount: number;
  /** 待就业人数 */
  waitingCount: number;
  /** 参与就业管理的学生总数（待就业 + 已就业） */
  jobManagedCount: number;
  /** 获得 offer 数（面试结论 = 已发 offer 的复盘记录数） */
  offerCount: number;
  /** 获得 offer 的去重学生数 */
  offerStudentCount: number;
  /** 就业率 = 就业人数 / 参与就业管理人数 */
  employmentRate: number;
  /** 平均投递简历数 = 总投递数 / 有投递记录的学生数 */
  avgResumeCount: number;
  /** 累计投递简历总数 */
  totalResumeCount: number;
  /** 累计面试场次 */
  totalInterviewCount: number;
  /** KPI 达成情况 */
  kpi: KpiProgress;
}

/** KPI 目标表 */
export interface KpiTarget {
  id: string;
  /** 目标就业率（百分比，如 85 表示 85%） */
  targetRate: number;
  /** 目标 offer 数 */
  targetOffer: number;
  /** 目标人均投递简历数 */
  targetResume: number;
  updateTime?: string;
}

/** KPI 达成进度 */
export interface KpiProgress {
  target: KpiTarget;
  /** 实际就业率 */
  actualRate: number;
  /** 实际 offer 数 */
  actualOffer: number;
  /** 实际人均投递数 */
  actualResume: number;
  /** 就业率达成率 % */
  rateCompletion: number;
  /** offer 达成率 % */
  offerCompletion: number;
  /** 投递达成率 % */
  resumeCompletion: number;
  /** 综合完成率 %（三项平均） */
  overallCompletion: number;
}

/** 部门/维度分布项（图表用） */
export interface DistributionItem {
  name: string;
  value: number;
}

/** 月度趋势项（图表用） */
export interface TrendItem {
  /** YYYY-MM */
  month: string;
  /** 当月新增就业人数 */
  employed: number;
  /** 当月投递简历数 */
  resume: number;
  /** 当月面试场次 */
  interview: number;
}

/** 单个学生的就业档案聚合（信息档案 - 就业日志记录 汇总用） */
export interface StudentJobProfile {
  studentId: string;
  studentName: string;
  studentNo: string;
  className?: string;
  /** 该学生累计有效投递 */
  totalResume: number;
  /** 该学生累计面试邀约 */
  totalInvite: number;
  /** 该学生累计面试场次 */
  totalInterview: number;
  /** 最近一次岗位 */
  latestPosition?: string;
  /** 最近一次薪资 */
  latestSalary?: number;
  /** 最近一次复盘结论 */
  latestReviewConclusionName?: string;
}
