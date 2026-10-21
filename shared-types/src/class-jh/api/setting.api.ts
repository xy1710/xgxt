/**
 * 接口契约：系统设置 / 阶段字典 / 操作日志 / 工作台
 *
 * 路径前缀：/api/class/setting、/api/class/stage、/api/class/opLog、/api/class/dashboard
 */

import { ApiResponse, PageResponse } from '../common';
import { ClassSetting, StageDict, StageScheme, OpLog, DashboardStat } from '../class';

/* ---------------- 系统设置 ---------------- */

/** 设置详情响应 */
export type SettingDetailResponse = ApiResponse<ClassSetting[]>;

/** 设置修改入参（KV 覆盖） */
export type SettingUpdatePayload = Record<string, string | number | boolean>;

/** 设置修改响应 */
export type SettingUpdateResponse = ApiResponse<null>;

/* ---------------- 阶段字典 ---------------- */

/** 阶段列表查询参数 */
export interface StageListQuery {
  deptCode?: number;
}

/** 阶段列表响应 */
export type StageDictListResponse = ApiResponse<StageDict[]>;

/** 阶段新增入参 */
export interface StageSavePayload {
  stageCode: number;
  stageName: string;
  deptCode: number;
  studyMonths?: number;
  sortNo?: number;
}

/** 阶段新增响应 */
export type StageAddResponse = ApiResponse<{ id: string }>;

/** 阶段删除响应 */
export type StageDeleteResponse = ApiResponse<null>;

/* ---------------- 阶段方案（★ 2026-10-16：阶段字典升级为方案 + 多阶段） ---------------- */

/** 阶段方案列表查询参数 */
export interface StageSchemeListQuery {
  deptCode?: number;
}

/** 阶段方案列表响应（含阶段明细） */
export type StageSchemeListResponse = ApiResponse<StageScheme[]>;

/** 阶段方案 · 阶段明细入参 */
export interface StageSchemeStagePayload {
  stageName: string;
  /** 学制月数 */
  studyMonths: number;
}

/** 阶段方案新增 / 修改入参（修改时阶段明细整体覆盖） */
export interface StageSchemeSavePayload {
  schemeName: string;
  deptCode: number;
  stages: StageSchemeStagePayload[];
}

/** 阶段方案新增响应 */
export type StageSchemeAddResponse = ApiResponse<{ id: string }>;

/** 阶段方案删除响应 */
export type StageSchemeDeleteResponse = ApiResponse<null>;

/* ---------------- 操作日志 ---------------- */

/** 操作日志列表查询参数 */
export interface OpLogListQuery {
  page?: number;
  size?: number;
  bizType?: string;
  studentId?: string;
  startDate?: string;
  endDate?: string;
}

/** 操作日志列表响应 */
export type OpLogListResponse = PageResponse<OpLog>;

/* ---------------- 工作台 ---------------- */

/** 工作台统计响应 */
export type DashboardStatResponse = ApiResponse<DashboardStat>;
