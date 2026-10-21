/**
 * 系统设置 / 阶段字典 / 阶段方案 / 操作日志 接口调用
 */

import { http } from './request';
import type {
  PageData,
  ClassSetting,
  StageDict,
  StageListQuery,
  StageSavePayload,
  StageScheme,
  StageSchemeListQuery,
  StageSchemeSavePayload,
  OpLog,
  OpLogListQuery,
} from 'shared-types/class-jh';

/* ---------------- 系统设置 ---------------- */

/** 设置详情（KV，缺失补默认） */
export function fetchSettingDetail(): Promise<ClassSetting[]> {
  return http.get<ClassSetting[]>('/api/class-jh/setting/detail');
}

/** 设置修改（KV 覆盖） */
export function updateSetting(payload: Record<string, string | number | boolean>): Promise<null> {
  return http.put<null>('/api/class-jh/setting/update', payload);
}

/* ---------------- 阶段字典 ---------------- */

/** 阶段列表 */
export function fetchStageList(query?: StageListQuery): Promise<StageDict[]> {
  return http.get<StageDict[]>('/api/class-jh/stage/list', query);
}

/** 阶段新增 */
export function addStage(payload: StageSavePayload): Promise<{ id: string }> {
  return http.post<{ id: string }>('/api/class-jh/stage/add', payload);
}

/** 阶段删除 */
export function deleteStage(id: string): Promise<null> {
  return http.delete<null>(`/api/class-jh/stage/delete/${id}`);
}

/* ---------------- 阶段方案（★ 2026-10-16：阶段字典升级为「方案 + 多阶段」） ---------------- */

/** 阶段方案列表（含阶段明细） */
export function fetchStageSchemeList(query?: StageSchemeListQuery): Promise<StageScheme[]> {
  return http.get<StageScheme[]>('/api/class-jh/stage-scheme/list', query);
}

/** 阶段方案新增 */
export function addStageScheme(payload: StageSchemeSavePayload): Promise<{ id: string }> {
  return http.post<{ id: string }>('/api/class-jh/stage-scheme/add', payload);
}

/** 阶段方案修改（阶段明细整体覆盖） */
export function updateStageScheme(id: string, payload: StageSchemeSavePayload): Promise<{ id: string }> {
  return http.put<{ id: string }>(`/api/class-jh/stage-scheme/update/${id}`, payload);
}

/** 阶段方案删除（被班级使用时后端会拒绝） */
export function deleteStageScheme(id: string): Promise<null> {
  return http.delete<null>(`/api/class-jh/stage-scheme/delete/${id}`);
}

/* ---------------- 操作日志 ---------------- */

/** 操作日志列表 */
export function fetchOpLogList(query: OpLogListQuery): Promise<PageData<OpLog>> {
  return http.get<PageData<OpLog>>('/api/class-jh/opLog/list', query);
}
