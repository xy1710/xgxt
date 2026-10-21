/**
 * 就业日志接口（就业日志 / 信息档案 - 就业日志记录）
 */

import { http } from './request';
import type {
  PageData,
  EmploymentLog,
  EmploymentLogQuery,
  EmploymentLogSavePayload,
  JobClassOption,
} from 'shared-types';

/** 列表（支持按姓名、班级、公司、日期区间筛选） */
export function fetchLogList(query: Partial<EmploymentLogQuery>): Promise<PageData<any>> {
  return http.get<PageData<any>>('/api/job/employment-log/list', query);
}

/**
 * 班级下拉选项（只读）
 *
 * ⚠️ 不要改用 /api/job/class/options —— 就业老师没有「班级管理」页面权限，调用会 403
 *    （前端会弹「您没有该操作的权限」）。这里走业务路由自己的 /classes。
 */
export function fetchLogClassOptions(): Promise<JobClassOption[]> {
  return http.get<JobClassOption[]>('/api/job/employment-log/classes');
}

/** 详情 */
export function fetchLogDetail(id: string): Promise<any> {
  return http.get<any>('/api/job/employment-log/detail', { id });
}

/** 新增 */
export function addLog(payload: EmploymentLogSavePayload): Promise<{ id: string }> {
  return http.post<{ id: string }>('/api/job/employment-log/add', payload);
}

/** 修改 */
export function updateLog(payload: EmploymentLogSavePayload & { id: string }): Promise<null> {
  return http.put<null>('/api/job/employment-log/update', payload);
}

/** 删除 */
export function deleteLog(id: string): Promise<null> {
  return http.delete<null>(`/api/job/employment-log/delete/${id}`);
}
