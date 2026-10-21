import { get, post } from './request';
import type { ConsultItem, ConsultReceivePayload, ConsultRejectPayload, PageData } from './types';

/** 咨询接口（前缀 /api/class/consult）：待接收学员 */

export function consultList(params: { page?: number; size?: number; applyStatus?: number; keyword?: string }) {
  return get<PageData<ConsultItem>>('/api/class/consult/list', params as Record<string, unknown>);
}

export function consultDetail(id: string) {
  return get<ConsultItem>('/api/class/consult/detail', { id });
}

/** 接收：把咨询学员归入班级（可一并补学号 / 阶段 / 宿舍床位等），返回新建后的 studentId */
export function consultReceive(payload: ConsultReceivePayload) {
  return post<{ studentId: string; studentNo: string }>('/api/class/consult/receive', payload);
}

/**
 * ★ 2026-10-20 接收弹窗的「学生状态」默认值
 *
 * 学生该落「试学中(3)」还是「正式在读(5)」由缴费情况决定（钱在咨询库），
 * 打开弹窗前问一次，避免初高一进来就默认「正式在读」。
 */
export function consultReceivePlan(id: string) {
  return get<{
    studentStatus?: number | null;
    studentStatusName?: string | null;
    fullSettled?: boolean | null;
    consultStateName?: string | null;
  }>('/api/class/consult/receive-plan', { id });
}

/** 驳回：rejectReason 必填 */
export function consultReject(payload: ConsultRejectPayload) {
  return post<{ id: string }>('/api/class/consult/reject', payload);
}

/** 推送（演示用，前端可不接界面） */
export function consultPush(payload: { items: unknown[] }) {
  return post<{ pushed: number }>('/api/class/consult/push', payload);
}
