/**
 * 催费管理 接口调用（就业管理 > 实训阶段）
 *
 * ⚠️ 路径与后端 /api/job/fee-call 完全一致
 *
 * 【这个模块不收款】
 *   它只是"催办工单"：教务发起 → 班主任去催 → 标记结果。
 *   真正的收费在财务模块（8005），本模块不碰钱。
 *
 * 【页面共用说明】
 *   教务老师 → 发起 + 作废（看不到"处理"按钮）
 *   班主任   → 处理（看不到"发起"按钮），且只看自己班
 *   按钮显隐由后端返回的 canHandle 控制。
 */

import { http } from './request';
import type {
  PageData,
  FeeCallListItem,
  FeeCallDetail,
  FeeCallQuery,
  FeeCallPayload,
  FeeCallHandlePayload,
  FeeCallSummary,
  FeeCallStudentOption,
} from 'shared-types';

/** 列表 */
export function fetchFeeCallList(query: FeeCallQuery): Promise<PageData<FeeCallListItem>> {
  return http.get<PageData<FeeCallListItem>>('/api/job/fee-call/page', query);
}

/** 详情（含该生历史催费） */
export function fetchFeeCallDetail(id: string): Promise<FeeCallDetail> {
  return http.get<FeeCallDetail>('/api/job/fee-call/detail', { id });
}

/** 可选学生（教务发起时选人） */
export function fetchFeeCallStudentOptions(params?: {
  keyword?: string;
  limit?: number;
}): Promise<FeeCallStudentOption[]> {
  return http.get<FeeCallStudentOption[]>('/api/job/fee-call/student-options', params);
}

/** 新建催费单（教务老师） */
export function createFeeCall(payload: FeeCallPayload): Promise<{ id: string }> {
  return http.post<{ id: string }>('/api/job/fee-call/create', payload);
}

/** 处理（班主任催完了 / 学生交钱了） */
export function handleFeeCall(
  payload: FeeCallHandlePayload,
): Promise<{ callStatus: number }> {
  return http.post<{ callStatus: number }>('/api/job/fee-call/handle', payload);
}

/** 作废（发起人本人 / 管理员，逻辑删除） */
export function voidFeeCall(id: string): Promise<null> {
  return http.post<null>('/api/job/fee-call/void', { id });
}

/**
 * 登记缴费（上传缴费凭证）· 就业
 *
 * ★ 2026-10-21 用户要求：催费页里就业要和初高功能对齐 ——
 *   初高的行能登记缴费（缴费方式 / 实缴金额 / 缴费日期 / 备注 / 截图），
 *   就业催费单原来只有一个催缴状态，「钱怎么交的」完全没记录。
 *
 * 落库位置：`t_job_fee_call` 的 pay_method / paid_amount / pay_date / voucher_url / pay_remark；
 * 成功后 call_status 置 3（已缴清）并写 handle_time / handle_remark。
 * ⚠️ 本模块仍然不产生财务账目（只是催办工单），凭证只存在这张单上。
 */
export function submitFeeCallPayment(payload: {
  /** 催费单 id（页面行里的 feeId 带 `call:` 前缀，调用前剥掉） */
  id: string;
  /** 缴费方式 1微信支付 2支付宝 3现金 */
  payMethod: number;
  /** 实缴金额（分），允许与应缴不同 */
  paidAmount: number;
  /** 缴费日期 YYYY-MM-DD（不能晚于今天） */
  payDate: string;
  remark?: string;
  /** 缴费截图 dataURL；现金可不传 */
  dataUrl?: string;
}): Promise<{ id: string; voucherUrl: string | null; callStatus: number; payMethodName: string }> {
  return http.post('/api/job/fee-call/voucher', payload);
}

/** 统计 */
export function fetchFeeCallSummary(): Promise<FeeCallSummary> {
  return http.get<FeeCallSummary>('/api/job/fee-call/summary');
}
