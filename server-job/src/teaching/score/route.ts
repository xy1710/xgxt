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

const nullishNum = (v: unknown): number | null =>
  v === undefined || v === null || v === '' ? null : Number(v);

/**
 * 6. 单行改分（列表「编辑」）
 *
 * ★ 只把**请求里出现过的字段**放进 body —— 没传的字段仓储不会动。
 *   备注列是内联编辑的，只改备注时不能顺带把分数重算一遍。
 */
teachingScoreRouter.post(
  '/update',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const id = str(b.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少成绩记录ID');

    const body: ScoreUpdateBody = { stage, id };
    if (b.writtenScore !== undefined) body.writtenScore = nullishNum(b.writtenScore);
    if (b.machineScore !== undefined) body.machineScore = nullishNum(b.machineScore);
    if (b.interviewScore !== undefined) body.interviewScore = nullishNum(b.interviewScore);
    if (b.otherScore !== undefined) body.otherScore = nullishNum(b.otherScore);
    if (b.examResult !== undefined) body.examResult = nullishNum(b.examResult);
    if (b.remark !== undefined) body.remark = b.remark === null ? null : String(b.remark);

    res.json(ok(await svc.updateScore(body, req.user), '已保存'));
  }),
);

/**
 * 7. 末班（列表「末班」）
 *
 * 前置条件：该生这场考试的结果是「未通过」。
 * 目标班级学段规则在 service 里（初高→初高、大学→大学、实训→任意）。
 */
teachingScoreRouter.post(
  '/repeat',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    if (!isTeachingStage(b.targetStage)) {
      throw new BizError(BizCode.PARAM_ERROR, 'targetStage 必填（jh / class / job）');
    }
    const body: ScoreRepeatBody = {
      stage,
      scoreId: String(b.scoreId ?? ''),
      targetStage: b.targetStage,
      targetClassId: String(b.targetClassId ?? ''),
      repeatDate: str(b.repeatDate),
      repeatReason: String(b.repeatReason ?? ''),
      shortcoming: str(b.shortcoming),
    };
    const r = await svc.repeatScore(body, req.user);
    res.json(
      ok(r, `已末班：${r.fromClassName || '无班级'} → ${r.toClassName}（累计第 ${r.repeatCount} 次）`),
    );
  }),
);
