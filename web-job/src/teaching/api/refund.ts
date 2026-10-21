/**
 * 统一退费接口（第 2 期 · 第 4 个域）· 前端封装
 * ============================================================
 * ★ 审批链统一采用「实训那一套」：
 *    班主任/项目经理发起 → 学管审批 → 校长审批 → 通过后通知财务出款。
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

/**
 * 部门（界面口径，取代原来的「学段」）
 *
 * ★ 2026-10-21 用户要求：部门「实训」改为「就业」。
 *   退费的三个库（初高 / 大学 / 就业）本来就都有表与仓储，
 *   `job` 这条就是「就业部」（`sms_job`），只是显示名以前写的是「实训」。
 *   与 `api/leave.ts` 的 LEAVE_DEPARTMENTS 同一份口径：初高中 / 大学 / 就业。
 * ★ 界面上不再出现「学段」这个词（那是内部技术词）；页面统一用 deptNameOf() 翻译。
 */
export interface RefundDepartment {
  /** 部门码（与学段同码：jh / class / job） */
  code: string;
  /** 部门中文名 */
  name: string;
  /** 对应学段；null = 该部门暂无退费业务（当前没有这种部门） */
  stage: TeachingStage | null;
}

export const REFUND_DEPARTMENTS: RefundDepartment[] = [
  { code: 'jh', name: '初高中', stage: 'jh' },
  { code: 'class', name: '大学', stage: 'class' },
  { code: 'job', name: '就业', stage: 'job' },
];

/** 统一状态码（= 实训那套 ApprovalStatus） */
export const REFUND_STATUS = {
  DRAFT: 1,
  PENDING_MANAGER: 2,
  PENDING_PRINCIPAL: 3,
  APPROVED: 4,
  REJECTED: 5,
  CANCELED: 6,
} as const;

export const REFUND_STATUS_NAME: Record<number, string> = {
  1: '待提交',
  2: '待学管审批',
  3: '待校长审批',
  4: '已通过',
  5: '已驳回',
  6: '已撤销',
};

/** 状态标签颜色 */
export const REFUND_STATUS_TAG: Record<number, string> = {
  1: 'info',
  2: 'warning',
  3: 'warning',
  4: 'success',
  5: 'danger',
  6: 'info',
};

/** 费用类型（三套一致；实训另有 6 退学退费 / 9 其他） */
export const REFUND_FEE_TYPE_NAME: Record<number, string> = {
  1: '学费',
  2: '住宿费',
  3: '餐费',
  4: '保险费',
  5: '试学费',
  6: '退学退费',
  9: '其他',
};

/** 可选费用项（新建时下拉用） */
export const FEE_TYPE_OPTIONS = [
  { value: 1, label: '学费' },
  { value: 2, label: '住宿费' },
  { value: 3, label: '餐费' },
  { value: 4, label: '保险费' },
  { value: 5, label: '试学费' },
  { value: 9, label: '其他' },
];

/** 单项退费费用上限：10 万元（元）。费用项输入框 max 与 doCreate 兜底共用；
 *  后端同口径见 server-job dto.ts 的 REFUND_ITEM_MAX_AMOUNT（分），两边同步改 */
export const REFUND_ITEM_MAX_YUAN = 100000;

export interface RefundItem {
  feeType: number;
  feeTypeName: string;
  amount: number;
  amountText: string;
}

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
  feeTypeName: string;
  items: RefundItem[];
  refundAmount: number;
  refundAmountText: string;
  applyDate: string;
  refundReason: string;
  approvalStatus: number;
  approvalStatusName: string;
  currentHandlerHint: string | null;
  financeRemark: string | null;
  refundTime: string | null;
  createTime: string | null;
  canApprove: boolean;
  canCancel: boolean;
  canSubmit: boolean;
}

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

export interface RefundSummary {
  stage: TeachingStage;
  stageName: string;
  total: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  approvedAmount: number;
}

export interface StudentOption {
  id: string;
  no: string;
  name: string;
  classId: string | null;
  className: string | null;
}

export function listRefunds(p: {
  stage?: TeachingStage;
  page?: number;
  size?: number;
  keyword?: string;
  classId?: string;
  status?: number;
  onlyMine?: boolean;
  startDate?: string;
  endDate?: string;
}) {
  return http.get<{ total: number; page: number; size: number; list: RefundRow[] }>(
    '/api/teaching/refund/list',
    p,
  );
}

export function getRefundDetail(id: string) {
  return http.get<RefundDetail>('/api/teaching/refund/detail', { id });
}

export function listStudentOptions(stage: TeachingStage, keyword?: string) {
  return http.get<StudentOption[]>('/api/teaching/refund/student-options', { stage, keyword });
}

export function listClasses() {
  return http.get<Array<{ stage: TeachingStage; stageName: string; id: string; name: string }>>(
    '/api/teaching/refund/classes',
  );
}

export function getRefundSummary() {
  return http.get<RefundSummary[]>('/api/teaching/refund/summary');
}

export function getRefundChain() {
  return http.get<{
    nodes: Array<{ step: number; name: string; roles: string }>;
    remark: string;
  }>('/api/teaching/refund/chain');
}

export function createRefund(body: {
  stage: TeachingStage;
  studentId: string;
  items: Array<{ feeType: number; amount: number }>;
  refundAmount: number;
  applyDate?: string;
  refundReason: string;
  remark?: string | null;
  submit?: boolean;
}) {
  return http.post<{ id: string }>('/api/teaching/refund/create', body);
}

export function submitRefund(stage: TeachingStage, id: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/refund/submit',
    { stage, id },
  );
}

export function approveRefund(stage: TeachingStage, id: string, comment?: string) {
  return http.post<{
    finished: boolean;
    approvalStatus: number;
    approvalStatusName: string;
    pushed: boolean;
  }>('/api/teaching/refund/approve', { stage, id, comment });
}

export function rejectRefund(stage: TeachingStage, id: string, reason: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/refund/reject',
    { stage, id, reason },
  );
}

export function cancelRefund(stage: TeachingStage, id: string, reason?: string) {
  return http.post<{ approvalStatus: number; approvalStatusName: string }>(
    '/api/teaching/refund/cancel',
    { stage, id, reason },
  );
}

export function financeConfirm(
  stage: TeachingStage,
  id: string,
  body: { financeRemark?: string; refundTime?: string } = {},
) {
  return http.post<null>('/api/teaching/refund/finance-confirm', { stage, id, ...body });
}
