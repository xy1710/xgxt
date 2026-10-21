/**
 * 宿舍楼栋设置接口 · /api/teaching/building/*
 * ============================================================
 *
 * 【一份字典、两个入口】
 *   ① 教学管理 → 系统设置 →「楼栋设置」页签（增删改）
 *   ② 教学管理 → 宿舍管理 → 楼栋筛选 / 新增房间的楼栋下拉（只读）
 *
 *   两边调用的都是这里的三个函数、打的都是同一张 `t_dorm_building`，
 *   所以在设置页新增「4号楼」，宿舍管理那边刷新就多一项，**不需要改任何代码**。
 *
 * 【为什么要单独一个文件，不塞进 teaching/api/dorm.ts】
 *   dorm.ts 是「宿舍管理页」的私有接口层（房间/床位/换宿单）。
 *   楼栋设置会被「系统设置页」引用 —— 让系统设置页去 import 宿舍页的接口文件，
 *   是一条不该存在的跨模块依赖（宿舍页改名/重构会连带打挂设置页）。
 */

import { http } from '@/api/request';

export interface DormBuildingRow {
  id: string;
  buildingName: string;
  /** 1 男寝 / 2 女寝 / null 未分类 */
  category: number | null;
  sortNo: number;
  /** 楼层数（0 = 未配置） */
  floorCount: number;
  /** 每层房间数（0 = 未配置） */
  roomsPerFloor: number;
  /** 每间床位数 */
  bedPerRoom: number;
  /**
   * ★ 宿舍数：该楼栋名下**当前在用**的房间数，后端实时 count，不存字段
   *   → 宿舍管理里删一间，这个数立刻少 1，不用任何同步动作。
   */
  roomCount: number;
  remark: string | null;
}

export interface DormBuildingSavePayload {
  id?: string;
  buildingName: string;
  category: number;
  sortNo?: number;
  /** 楼层数 1 ~ 9（房号第 1 位只能是一位数字） */
  floorCount?: number;
  /** 每层房间数 1 ~ 99 */
  roomsPerFloor?: number;
  /** 每间床位数 1 ~ 50 */
  bedPerRoom?: number;
  remark?: string;
}

/** 保存楼栋后「自动生成房间」的结果（后端返回，用于提示建了几间） */
export interface DormBuildingRoomGenResult {
  created: number;
  revived: number;
  skipped: number;
  total: number;
}

/**
 * ★ 楼层数 / 每层房间数 / 每间床位数 三项统一封顶 50（2026-10-19 定的口径）
 *
 * 【房号怎么编】楼层 + 两位序号，长度跟着楼层位数走：
 *   ≤ 9 层 → 3 位（1 楼第 8 间 = 108）
 *   ≥ 10 层 → 4 位（10 楼第 8 间 = 1008、50 楼第 12 间 = 5012）
 * 改这里必须同步后端 dto 的 DORM_FLOOR_MAX / DORM_ROOMS_PER_FLOOR_MAX。
 */
export const DORM_FLOOR_MAX = 50;
export const DORM_ROOMS_PER_FLOOR_MAX = 50;
export const DORM_BED_PER_ROOM_MAX = 50;
export const DORM_BED_PER_ROOM_DEFAULT = 4;

const BASE = '/api/teaching/building';

/** 1. 楼栋列表（设置页 + 宿舍下拉共用） */
export async function listDormBuildings(): Promise<DormBuildingRow[]> {
  const r = await http.get(`${BASE}/list`);
  return (r as unknown as DormBuildingRow[]) || [];
}

/** 2. 新增 / 修改楼栋（填了楼层数 + 每层房间数，后端会自动生成房间） */
export function saveDormBuilding(
  body: DormBuildingSavePayload,
): Promise<{ id: string; rooms?: DormBuildingRoomGenResult | null }> {
  return http.post(`${BASE}/save`, body) as Promise<{
    id: string;
    rooms?: DormBuildingRoomGenResult | null;
  }>;
}

/** 3. 删除楼栋（名下还有宿舍时后端会拒绝） */
export function deleteDormBuilding(id: string): Promise<unknown> {
  return http.delete(`${BASE}/delete`, { id });
}
