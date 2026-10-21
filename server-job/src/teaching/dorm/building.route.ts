/**
 * 宿舍楼栋设置接口 · /api/teaching/building/*
 * ============================================================
 *
 * 【为什么单独挂一串路由，而不是塞进 /api/teaching/dorm】
 *   `/api/teaching/dorm` 的门槛是「三个宿舍页面权限任一」。
 *   但楼栋设置的入口在**教学管理 → 系统设置**（`classjh:setting:view`），
 *   一个只有系统设置权限、没有宿舍权限的用户，如果走 dorm 那串会被 403 挡在门外。
 *   → 单独挂，并把两个入口的权限码都列进 `requireAnyPage`，两边都进得去。
 *
 * 【三个接口够用】
 *   GET    /list          楼栋列表（设置页 + 宿舍下拉共用）
 *   POST   /save          新增 / 修改
 *   DELETE /delete?id=    删除（被宿舍引用时拒绝）
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok } from '../../utils/response';
import * as svc from './building.service';
import * as roomSvc from './service';

export const teachingBuildingRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

/** 1. 楼栋列表 */
teachingBuildingRouter.get(
  '/list',
  wrap(async (_req, res) => {
    res.json(ok(await svc.listBuildings(), '查询成功'));
  }),
);

/**
 * 2. 新增 / 修改（★ 保存成功后按「楼层数 × 每层房间数」自动生成宿舍房间）
 *
 * 【为什么生成放在这里，而不是塞进 building.service】
 *   building.service 被 repo.uni.ts 依赖（楼栋下拉要读它），
 *   而房间生成必须走 dorm 的 service/repo（房号规则、床位同步都在那边）。
 *   让 building.service 反向 import dorm service → 立刻成环。
 *   → 放在路由层串起来：路由谁都可以依赖，不构成环。
 *     依赖方向：building.route → dorm/service → repo.uni → building.service（单向）
 */
teachingBuildingRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const category = b.category === undefined || b.category === null || b.category === ''
      ? undefined
      : Number(b.category);
    const r = await svc.saveBuilding(
      {
        id: str(b.id),
        buildingName: String(b.buildingName ?? ''),
        category,
        sortNo: b.sortNo === undefined || b.sortNo === null || b.sortNo === ''
          ? undefined
          : Number(b.sortNo),
        floorCount: numOrUndef(b.floorCount),
        roomsPerFloor: numOrUndef(b.roomsPerFloor),
        bedPerRoom: numOrUndef(b.bedPerRoom),
        remark: str(b.remark),
      },
      req.user?.userId || '',
    );

    /**
     * ★ 生成房间的三个前提
     *   ① 楼层数 > 0 且 每层房间数 > 0（0 = 老楼栋未配置，房间是手工加的，不动它）
     *   ② 类别已选（男寝/女寝）—— 生成出来的房间 dorm_gender 就取这个值，
     *      没选就没法归类，此时不生成，楼栋本身照样保存成功。
     * 幂等：已存在的房间会 skipped，软删过的会复活，所以改配置再保存是安全的。
     */
    let rooms: Awaited<ReturnType<typeof roomSvc.generateRoomsForBuilding>> | null = null;
    const name = String(b.buildingName ?? '').trim();
    const floorCount = numOrUndef(b.floorCount) ?? 0;
    const roomsPerFloor = numOrUndef(b.roomsPerFloor) ?? 0;
    if (name && floorCount > 0 && roomsPerFloor > 0 && (category === 1 || category === 2)) {
      rooms = await roomSvc.generateRoomsForBuilding(
        {
          buildingName: name,
          dormType: category,
          floorCount,
          roomsPerFloor,
          bedPerRoom: numOrUndef(b.bedPerRoom),
        },
        req.user,
      );
    }

    let msg = b.id ? '楼栋已更新' : '楼栋已创建';
    if (rooms) {
      const parts: string[] = [];
      if (rooms.created) parts.push(`新建 ${rooms.created} 间`);
      if (rooms.revived) parts.push(`恢复 ${rooms.revived} 间`);
      if (rooms.skipped) parts.push(`${rooms.skipped} 间已存在，未重复生成`);
      msg = `${msg}，已自动生成宿舍：${parts.join('，') || '无变化'}`;
    }
    res.json(ok({ ...r, rooms }, msg));
  }),
);

/** 数字（空值一律 undefined，避免把 null 写进 int 列） */
function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 3. 删除 */
teachingBuildingRouter.delete(
  '/delete',
  wrap(async (req, res) => {
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少楼栋ID');
    await svc.removeBuilding(id, req.user?.userId || '');
    res.json(ok(null, '已删除'));
  }),
);
