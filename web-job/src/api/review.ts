/**
 * 复盘接口（复盘填写 / 信息档案 - 复盘信息）
 */

import { http } from './request';
import type { PageData, Review, ReviewQuery, ReviewSavePayload, JobClassOption } from 'shared-types';

/** 列表（支持按姓名、班级、岗位、面试结论、复盘结论、日期区间筛选） */
export function fetchReviewList(query: Partial<ReviewQuery>): Promise<PageData<any>> {
  return http.get<PageData<any>>('/api/job/review/list', query);
}

/**
 * 班级下拉选项（只读）
 *
 * ⚠️ 不要改用 /api/job/class/options —— 就业老师没有「班级管理」页面权限，调用会 403
 *    （前端会弹「您没有该操作的权限」）。这里走业务路由自己的 /classes。
 */
export function fetchReviewClassOptions(): Promise<JobClassOption[]> {
  return http.get<JobClassOption[]>('/api/job/review/classes');
}

/** 详情（含录音内容） */
export function fetchReviewDetail(id: string): Promise<any> {
  return http.get<any>('/api/job/review/detail', { id });
}

/**
 * 新增
 *
 * ★ 2026-10-02：返回体多了 `suggestEmploy` ——
 *   当「复盘结论 = 已签约入职」且该生还在**待就业**时，后端回 true，
 *   前端据此弹一句「要不要把 TA 标记为已就业？」（老师点确认才改，不会悄悄改）
 */
export function addReview(payload: ReviewSavePayload): Promise<{ id: string; suggestEmploy?: boolean }> {
  return http.post<{ id: string; suggestEmploy?: boolean }>('/api/job/review/add', payload);
}

/** 修改（返回体同样带 suggestEmploy，含义同上） */
export function updateReview(
  payload: ReviewSavePayload & { id: string },
): Promise<{ suggestEmploy?: boolean } | null> {
  return http.put<{ suggestEmploy?: boolean } | null>('/api/job/review/update', payload);
}

/** 删除 */
export function deleteReview(id: string): Promise<null> {
  return http.delete<null>(`/api/job/review/delete/${id}`);
}

/** 删除录音 */
export function removeReviewAudio(id: string): Promise<null> {
  return http.put<null>(`/api/job/review/remove-audio/${id}`, {});
}
