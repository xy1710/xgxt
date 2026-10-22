/**
 * 统一成绩接口 · /api/teaching/score/*
 *
 * 取代合并前的 初高 /api/class-jh/examScore、大学 /api/class/grade、实训 /api/job/exam-score
 * 共 10 余个接口。老接口一个都没删。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok, page as pageResp } from '../../utils/response';
import * as svc from './service';
import { getScoreFormula } from '../shared/conf';
import type { ScoreRepeatBody, ScoreUpdateBody, TeachingStage } from '../shared/dto';
import { isTeachingStage } from '../shared/dto';

export const teachingScoreRouter = Router();

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
const numOrNull = (v: unknown): number | null =>
  v === undefined || v === null || v === '' ? null : Number(v);

/** 1. 列表 */
teachingScoreRouter.get(
  '/list',
  wrap(async (req, res) => {
    const q = {
      stage: optStage(req.query.stage),
      examId: str(req.query.examId),
      classId: str(req.query.classId),
      studentId: str(req.query.studentId),
      keyword: str(req.query.keyword),
      page: int(req.query.page, 1),
      size: Math.min(int(req.query.size, 20), 500),
    };
    const r = await svc.listScores(q, req.user);
    res.json(pageResp(r.list, r.total, { page: r.page, size: r.size }));
  }),
);

/** 2. 录入表（某场考试某班的全班名单 + 已录分数） */
teachingScoreRouter.get(
  '/entry',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const examId = str(req.query.examId);
    if (!examId) throw new BizError(BizCode.PARAM_ERROR, '缺少考试ID');
    res.json(ok(await svc.getEntry(stage, examId, str(req.query.classId) || '', req.user)));
  }),
);

/** 3. 保存（批量；后端按各学段公式算 笔试均分 / 综合成绩 / 判定结果） */
teachingScoreRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const rows = Array.isArray(b.rows)
      ? b.rows.map((r: any) => ({
          studentId: String(r.studentId),
          writtenScore: numOrNull(r.writtenScore),
          machineScore: numOrNull(r.machineScore),
          interviewScore: numOrNull(r.interviewScore),
          otherScore: numOrNull(r.otherScore),
          // 只有 judgeMode='manual' 的学段（大学）会传；其它学段传了也会被忽略
          examResult: r.examResult === undefined || r.examResult === null ? null : Number(r.examResult),
          remark: r.remark ?? null,
        }))
      : [];
    const r = await svc.saveScores({ stage, examId: String(b.examId ?? ''), rows }, req.user);
    res.json(ok(r, `已保存 ${r.saved} 条成绩`));
  }),
);

/** 4. 汇总 */
teachingScoreRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const list = await svc.scoreSummary(
      {
        stage: optStage(req.query.stage),
        examId: str(req.query.examId),
        classId: str(req.query.classId),
      },
      req.user,
    );
    res.json(ok(list, '统计成功'));
  }),
);

/**
 * 5. 口径：各学段的成绩公式（只读，便于前端展示"本学段怎么算"）
 *    ★ 让配置"看得见"，避免口径藏在代码里没人知道
 */
teachingScoreRouter.get(
  '/formula',
  wrap(async (_req, res) => {
    res.json(ok(await getScoreFormula(), '查询成功'));
  }),
);

/**
 * 6. 考试下拉（只读）
 *    ★ 2026-10-19：班主任只有成绩码、没有考试码，直接调 `/api/teaching/exam/list`
 *      会被 403（实测「点成绩管理就弹无权限」）。本接口用**成绩域**的权限码判权，
 *      只返回考试列表供选择，不放开考试域的写操作。
 */
teachingScoreRouter.get(
  '/classes',
  wrap(async (req, res) => {
    res.json(ok(await svc.listEntryClasses(req.user)));
  }),
);

teachingScoreRouter.get(
  '/exam-options',
  wrap(async (req, res) => {
    res.json(ok(await svc.listExamOptions(optStage(req.query.stage), str(req.query.keyword), req.user)));
  }),
);
