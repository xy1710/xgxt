/**
 * 统一考试接口 · /api/teaching/exam/*
 *
 * 取代合并前的 4 + 3 + 5 = 12 个考试接口（同一件事三个名字：
 * /page vs /list、/update vs 没有、字段结构各不相同）。
 *
 * 老接口（/api/job/exam、/api/class/exam、/api/class-jh/exam）一个都没删。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok, page as pageResp } from '../../utils/response';
import * as svc from './service';
import type { TeachingStage } from '../shared/dto';
import { isTeachingStage } from '../shared/dto';

export const teachingExamRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}
function int(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function reqStage(v: unknown): TeachingStage {
  if (!isTeachingStage(v)) throw new BizError(BizCode.PARAM_ERROR, 'stage 必填（jh / class / job）');
  return v;
}
function optStage(v: unknown): TeachingStage | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isTeachingStage(v)) throw new BizError(BizCode.PARAM_ERROR, 'stage 只能是 jh / class / job');
  return v;
}
function dateStr(v: unknown, f: string): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BizError(BizCode.PARAM_ERROR, `${f} 格式应为 YYYY-MM-DD`);
  return s;
}

/** 1. 列表 */
teachingExamRouter.get(
  '/list',
  wrap(async (req, res) => {
    const q = {
      stage: optStage(req.query.stage),
      classId: str(req.query.classId),
      examType: req.query.examType ? Number(req.query.examType) : undefined,
      startDate: dateStr(req.query.startDate, 'startDate'),
      endDate: dateStr(req.query.endDate, 'endDate'),
      keyword: str(req.query.keyword),
      page: int(req.query.page, 1),
      size: Math.min(int(req.query.size, 20), 200),
    };
    const r = await svc.listExams(q, req.user);
    res.json(pageResp(r.list, r.total, { page: r.page, size: r.size }));
  }),
);

/** 2. 详情 */
teachingExamRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少考试ID');
    res.json(ok(await svc.getExamDetail(stage, id, req.user)));
  }),
);

/** 3. 保存（新增 / 修改） */
teachingExamRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const classIds: string[] = Array.isArray(b.classIds)
      ? b.classIds.map(String)
      : b.classId
        ? [String(b.classId)]
        : [];
    const r = await svc.saveExam(
      {
        stage,
        id: str(b.id),
        examName: String(b.examName ?? ''),
        examType: Number(b.examType ?? 1),
        /* ★ 前端选「其他」时传的自定义类型名 */
        examTypeName: b.examTypeName ? String(b.examTypeName) : null,
        examDate: String(b.examDate ?? ''),
        classIds,
        contents: Array.isArray(b.contents)
          ? b.contents.map((c: any) => ({
              type: Number(c.type),
              name: c.name,
              fullScore: c.fullScore === undefined ? null : Number(c.fullScore),
            }))
          : undefined,
        remark: b.remark ?? null,
      },
      req.user,
    );
    res.json(ok(r, b.id ? '考试已更新' : '考试已创建'));
  }),
);

/** 4. 删除 */
teachingExamRouter.delete(
  '/delete',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少考试ID');
    await svc.removeExam(stage, id, req.user);
    res.json(ok(null, '已删除'));
  }),
);

/** 5. 班级下拉 */
teachingExamRouter.get(
  '/classes',
  wrap(async (req, res) => {
    res.json(ok(await svc.listClassOptions(req.user), '查询成功'));
  }),
);
