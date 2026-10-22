/**
 * 学生换班（末班 / 升班）· 独立路由
 * ============================================================
 * 【为什么单独挂一个前缀，不放在 /api/teaching/class 下】
 *   换班的入口在**成绩管理**页（权限码 class:grade:view / classjh:score:view /
 *   job:examScore:view），而 /api/teaching/class 整域挂的是**班级信息查看**权限
 *   （class:info:view / classjh:classInfo:view / job:class:view）。
 *   只有成绩权限的班主任点「末班 / 升班」会直接 403。
 *   → 这里给换班单开一个前缀，把两组权限码都放行，谁的入口谁都能用。
 *
 * 【写权限说明】
 *   本系统教学域是「页面即权限」（有 view 码即视为能操作该页面），
 *   写操作没有独立的 EDIT 码；这里沿用该约定，但仍保留
 *   denyReadOnlyAdmin / denyApprovalOnlyWrite 两道闸（见 app.ts 挂载处）。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok } from '../../utils/response';
import { assertStage } from './service';
import { transferStudent, transferTargets } from './transfer';

export const teachingTransferRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

/** 1. 可选目标班级（按进度过滤：末班=进度≤当前，升班=进度>当前） */
teachingTransferRouter.get(
  '/targets',
  wrap(async (req, res) => {
    const stage = assertStage(req.query.stage);
    const fromClassId = str(req.query.fromClassId);
    if (!fromClassId) throw new BizError(BizCode.PARAM_ERROR, '缺少班级ID');
    const mode = req.query.mode === 'promote' ? 'promote' : 'repeat';
    res.json(ok(await transferTargets(stage, fromClassId, mode), '查询成功'));
  }),
);

/** 2. 执行换班 */
teachingTransferRouter.post(
  '/do',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = assertStage(b.stage);
    const studentId = str(b.studentId);
    const fromClassId = str(b.fromClassId);
    const toClassId = str(b.toClassId);
    if (!studentId || !fromClassId || !toClassId) {
      throw new BizError(BizCode.PARAM_ERROR, '缺少学生或班级参数');
    }
    const out = await transferStudent(
      {
        stage,
        studentId,
        fromClassId,
        toClassId,
        mode: b.mode === 'promote' ? 'promote' : 'repeat',
        reason: b.reason ? String(b.reason) : null,
        examId: str(b.examId) ?? null,
      },
      req.user,
    );
    res.json(ok(out, `已转入「${out.toClassName}」`));
  }),
);
