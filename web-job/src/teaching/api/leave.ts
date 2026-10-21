/**
 * 统一学籍异动审批接口（第 2 期 · 第 5 个域）· 前端封装
 * ============================================================
 * ★ 审批链统一采用「实训那一套」：
 *    休学 1 步（学管）· 复学 1 步（学管）· 退学 2 步（学管 → 校长）
 * ★ 业务类型：1 休学 · 2 退学 · 3 复学
 * ★ 2026-10-16 起三学段（初高/大学/实训）都支持复学（见 `/meta` 的 stageBizTypes）；
 *   复学（bizType=3）时 `newClassId`（复学班）必填、学生下拉只列休学中的学生
 */

import { http } from '@/api/request';
import type { TeachingStage } from './attendance';

export type { TeachingStage };

export const STAGE_NAME: Record<TeachingStage, string> = {
  jh: '初高部',
  class: '大学部',
  // ★ 2026-10-21 用户要求：部门口径里「实训」改叫「就业」（同一个 sms_job 库）
  job: '就业',
};

/** 统一业务类型 */
export const LEAVE_BIZ_NAME: Record<number, string> = {
  1: '休学',
  2: '退学',
  3: '复学',
};

/** 统一状态码（= 实训那套 ApprovalStatus） */
export const LEAVE_STATUS = {
  DRAFT: 1,
  PENDING_MANAGER: 2,
  PENDING_PRINCIPAL: 3,
  APPROVED: 4,
  REJECTED: 5,
  CANCELED: 6,
} as const;

export const LEAVE_STATUS_NAME: Record<number, string> = {
  1: '待提交',
  2: '待学管审批',
  3: '待校长审批',
  4: '已通过',
  5: '已驳回',
  6: '已撤销',
};

export const LEAVE_STATUS_TAG: Record<number, string> = {
  1: 'info',
  2: 'warning',
  3: 'warning',
  4: 'success',
  5: 'danger',
  6: 'info',
};

/** 各类型走几步（用于页面提示"本次走几步"） */
export const LEAVE_CHAIN_STEPS: Record<number, number> = { 1: 1, 2: 2, 3: 1 };

/** 各学段支持的类型（默认值；实际以后端 /meta 为准） */
export const LEAVE_STAGE_BIZ_DEFAULT: Record<TeachingStage, number[]> = {
  jh: [1, 2, 3],
  class: [1, 2],
  job: [1, 2, 3],
};

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
  leaveDate: string | null;
  expectResumeDate: string | null;
  newClassId: string | null;
  newClassName: string | null;
  leaveReason: string;
  attendedHours: number | null;
  relatedRefundNo: string | null;
  /** ★ 学生**当前**状态（实时读，与单据状态是两回事：休学单已通过 ≠ 学生现在在休学） */
  studentStatus?: number | null;
  studentStatusName?: string;
  approvalStatus: number;
  approvalStatusName: string;
  currentHandlerHint: string | null;
  createTime: string | null;
  canApprove: boolean;
  canCancel: boolean;
  canSubmit: boolean;
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

export interface StudentOption {
  id: string;
  no: string;
  name: string;
  classId: string | null;
  className: string | null;
}

/**
 * 部门（发起申请时的下拉，取代原来的「学段」）
 *
 * ★ 权威来源是后端 `/meta.departments`，下面这份只是**兜底默认值**
 *   （meta 请求失败时页面不至于空白）。改这里也要同步后端
 *   `server-job/src/teaching/shared/dto.ts` 的 `LEAVE_DEPARTMENTS`。
 *
 * ★ 2026-10-21 用户要求：部门「实训」改为「就业」。
 *   原来这里是 4 项（初高中 / 大学 / 实训 / 就业），其中「就业」是个
 *   `stage = null` 的占位（当时认为就业部没有异动库表）—— 但实训与就业本来
 *   就共用 `sms_job` 一个库、同一套仓储，占位反而让用户选到「暂不办理」的空部门。
 *   现在收成 3 项：初高中 / 大学 / 就业，就业 = 原实训（stage 仍是 job）。
 */
export interface LeaveDepartment {
  /** 部门码（jh/class/job 与学段同码） */
  code: string;
  /** 部门中文名 */
  name: string;
  /** 对应学段；null = 该部门暂不办理学籍异动（当前没有这种部门） */
  stage: TeachingStage | null;
}

export const LEAVE_DEPARTMENTS_DEFAULT: LeaveDepartment[] = [
  { code: 'jh', name: '初高中', stage: 'jh' },
  { code: 'class', name: '大学', stage: 'class' },
  { code: 'job', name: '就业', stage: 'job' },
];

/**
 * 异动日期可选窗口的**兜底值**（今天 ± N 天）
 * ★ 权威值由后端 `/meta.leaveDateWindowDays` 下发（与后端 create 的校验同源），
 *   改窗口天数请改后端 `LEAVE_DATE_WINDOW_DAYS`。
 */
export const LEAVE_DATE_WINDOW_DAYS_DEFAULT = 10;

export interface LeaveMeta {
  bizTypes: Array<{ value: number; label: string; steps: number }>;
  statuses: Array<{ value: number; label: string }>;
  stageBizTypes: Record<string, number[]>;
  /** ★ 部门下拉（初高中 / 大学 / 实训 / 就业） */
  departments?: LeaveDepartment[];
  /** ★ 异动日期可选窗口：今天 ± N 天 */
  leaveDateWindowDays?: number;
}

export function listLeaves(p: {
  stage?: TeachingStage;
  page?: number;
  size?: number;
  keyword?: string;
  classId?: string;
  bizType?: number;
  status?: number;
  onlyMine?: boolean;
  startDate?: string;
  endDate?: string;
}) {
  return http.get<{ total: number; page: number; size: number; list: LeaveRow[] }>(
    '/api/teaching/leave/list',
    p,
  );
}

export function getLeaveDetail(id: string) {
  return http.get<LeaveDetail>('/api/teaching/leave/detail', { id });
}

/**
 * 学生下拉
 *
 * ★ 传 `bizType = 3`（复学）时，后端**只返回当前处于休学的学生** ——
 *   复学是「把休学的人接回来」，下拉里就不该出现在读/退学的人。
 * ★ 无论哪种类型，以下两类人都**不会返回**：
 *   ① 终态学生（退学 7 / 流失 11 / 已就业 10）—— 已经终结，不能再办任何学籍异动；
 *   ② **已有未办结申请**的学生（待提交 / 待学管 / 待校长）—— 避免重复申请。
 *   （2026-10-16 起；② 与后端 create 的 hasPending 共用同一份「未办结状态」常量。）
 */
export function listStudentOptions(stage: TeachingStage, keyword?: string, bizType?: number) {
  return http.get<StudentOption[]>('/api/teaching/leave/student-options', {
    stage,
    keyword,
    bizType,
  });
}

export function listClasses() {
  return http.get<Array<{ stage: TeachingStage; stageName: string; id: string; name: string }>>(
    '/api/teaching/leave/classes',
  );
}

export function getLeaveSummary() {
  return http.get<LeaveSummary[]>('/api/teaching/leave/summary');
}

export function getLeaveMeta() {
  return http.get<LeaveMeta>('/api/teaching/leave/meta');
}

/** ★ 复学：建单时 `newClassId`（复学班）必填；终审仍可改 */
export function createLeave(body: {
  stage: TeachingStage;
  studentId: string;
  bizType: number;
  leaveDate?: string;
  expectResumeDate?: string;
  newClassId?: string;
  leaveReason: string;
  remark?: string | null;
  submit?: boolean;
}) {
  return http.post<{ id: string }>('/api/teaching/leave/create', body);
}

export function submitLeave(stage: TeachingStage, id: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/leave/submit',
    { stage, id },
  );
}

/** ★ 复学在终审通过时要带 `newClassId`（复学班） */
export function approveLeave(
  stage: TeachingStage,
  id: string,
  body: { comment?: string; newClassId?: string } = {},
) {
  return http.post<{ finished: boolean; approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/leave/approve',
    { stage, id, ...body },
  );
}

export function rejectLeave(stage: TeachingStage, id: string, reason: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/leave/reject',
    { stage, id, reason },
  );
}

export function cancelLeave(stage: TeachingStage, id: string, reason?: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/leave/cancel',
    { stage, id, reason },
  );
}
