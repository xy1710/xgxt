/**
 * 班级宿舍分派接口 · /api/teaching/dorm/allocate/*
 * ============================================================
 *
 * 挂在「教学管理 → 宿舍管理」下，与 /api/teaching/dorm/* 同一套权限码
 * （classjh:dorm:view / class:dorm:view / job:dorm:view）——
 * 教务老师本来就有初高宿舍权限，不需要再加新权限码。
 *
 * 三个接口：
 *   GET  /classes    班级列表（班主任 + 男/女生人数 + 状态 + 已分派宿舍）
 *   GET  /buildings  楼栋下拉（按类别：1 男寝 / 2 女寝）
 *   GET  /rooms      某楼栋下的宿舍（含剩余床位、是否住满、已分派给谁）
 *   POST /save       保存某班的男寝 / 女寝分派（覆盖式）
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok } from '../../utils/response';
import * as svc from './allocate.service';

export const teachingDormAllocateRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

/** 类别只认 1 男寝 / 2 女寝 */
function reqCategory(v: unknown): number {
  const n = Number(v);
  if (n !== 1 && n !== 2) {
    throw new BizError(BizCode.PARAM_ERROR, '类别只能是 1 男寝 / 2 女寝');
  }
  return n;
}

/** 班级列表 */
teachingDormAllocateRouter.get(
  '/classes',
  wrap(async (req, res) => {
    const list = await svc.listAllocateClasses(str(req.query.keyword));
    res.json(ok(list, '查询成功'));
  }),
);

/** 楼栋下拉（只出该类别下真实存在的楼栋） */
teachingDormAllocateRouter.get(
  '/buildings',
  wrap(async (req, res) => {
    const category = reqCategory(req.query.category);
    res.json(ok(await svc.listAllocateBuildings(category), '查询成功'));
  }),
);

/** 某楼栋下的宿舍（不传楼栋 = 该类别全部宿舍；含空闲床位明细） */
teachingDormAllocateRouter.get(
  '/rooms',
  wrap(async (req, res) => {
    const category = reqCategory(req.query.category);
    res.json(ok(await svc.listAllocateRooms(category, str(req.query.building)), '查询成功'));
  }),
);

/**
 * 学生搜索（调宿 / 退宿弹窗）
 *
 * - className：先按班级过滤（与班级下拉联动）
 * - keyword：姓名 / 学号前后模糊
 * 返回里带当前宿舍位置（building / room / bedLabel），供弹窗回显。
 */
teachingDormAllocateRouter.get(
  '/students',
  wrap(async (req, res) => {
    res.json(
      ok(
        await svc.searchStudents({
          className: str(req.query.className),
          keyword: str(req.query.keyword),
          limit: Number(req.query.limit) || 50,
        }),
        '查询成功',
      ),
    );
  }),
);

/** 保存分派（覆盖式） */
teachingDormAllocateRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const r = await svc.saveAllocate({
      className: b.className,
      headTeacherName: b.headTeacherName,
      maleRoomIds: b.maleRoomIds,
      femaleRoomIds: b.femaleRoomIds,
      userId: (req as any).user?.businessUserId || (req as any).user?.userId || 'system',
    });
    res.json(ok(r, `已保存：男寝 ${r.male} 间、女寝 ${r.female} 间`));
  }),
);
