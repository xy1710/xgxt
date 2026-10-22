/**
 * 成绩适配器（Adapter）· 与出勤/考试域同构
 * ============================================================
 * ⚠️ 本域的权限码三套写法完全不同，不是简单加前缀：
 *     初高 classjh:score:view / 大学 class:grade:view / 实训 job:examScore:view
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import * as repoClassJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';
import type {
  ExamListQuery,
  ExamRow,
  ScoreEntry,
  ScoreListQuery,
  ScoreRepeatBody,
  ScoreRepeatResult,
  ScoreRow,
  ScoreSaveBody,
  ScoreSummaryItem,
  ScoreUpdateBody,
  TeachingStage,
} from '../shared/dto';
import { TEACHING_STAGE_NAME } from '../shared/dto';
import { assertStageCode, visibleStagesBy, type StageCodeMap } from '../shared/stageAccess';
import { getScoreFormula } from '../shared/conf';
import { listExamsForStages } from '../exam/service';
import { assertClassInScope, assertStudentsInScope } from '../shared/dataScope';
import { listClassesOfStages, type ClassOption } from '../shared/classOptions';

type Repo = {
  list: (q: ScoreListQuery, user?: any) => Promise<ScoreRow[]>;
  entry: (examId: string, classId: string) => Promise<ScoreEntry>;
  contentFull: (examId: string) => Promise<Record<string, number>>;
  save: (b: ScoreSaveBody, userId: string) => Promise<{ saved: number }>;
  updateOne: (b: ScoreUpdateBody, userId: string) => Promise<{ updated: number }>;
  repeat: (b: ScoreRepeatBody, userId: string) => Promise<ScoreRepeatResult>;
};

const REPOS: Record<TeachingStage, Repo> = {
  jh: repoClassJh,
  class: repoClass,
  job: repoJob,
};

/** 各学段成绩页的权限码（★ 三套写法都不同，别想当然） */
const CODES: StageCodeMap = {
  jh: 'classjh:score:view',
  class: 'class:grade:view',
  job: 'job:examScore:view',
};
const LABEL = '成绩管理';

export function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, CODES, LABEL);
}
export function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, CODES, LABEL);
}

export async function listScores(
  q: ScoreListQuery,
  user: any,
): Promise<{ total: number; page: number; size: number; list: ScoreRow[] }> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有成绩管理的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  const merged = parts.flat();
  merged.sort((a, b) => (a.studentNo ?? '').localeCompare(b.studentNo ?? '', 'zh-Hans-CN'));

  const start = (q.page - 1) * q.size;
  return { total: merged.length, page: q.page, size: q.size, list: merged.slice(start, start + q.size) };
}

export async function getEntry(
  stage: TeachingStage,
  examId: string,
  classId: string,
  user: any,
): Promise<ScoreEntry> {
  await assertStageView(user, stage);
  await assertClassInScope(stage, classId, user, '该班级成绩');
  const e = await REPOS[stage].entry(examId, classId);
  /* ★ 顺手带上「各分数项满分」，前端输入框上限就不必再调考试域接口
     （班主任没有 class:exam:view，调 /exam/detail 会 403） */
  const contentFullScore = await REPOS[stage].contentFull(examId).catch(() => ({}));
  return { ...e, contentFullScore };
}

export async function saveScores(body: ScoreSaveBody, user: any) {
  await assertStageView(user, body.stage);
  if (!body.examId) throw new BizError(BizCode.PARAM_ERROR, '缺少考试ID');
  if (!body.rows?.length) throw new BizError(BizCode.PARAM_ERROR, '成绩数据不能为空');
  await assertStudentsInScope(
    body.stage,
    body.rows.map((r) => r.studentId),
    user,
    '该班级成绩',
  );
  return REPOS[body.stage].save(body, user?.userId || 'system');
}

/* ============================================================
 * 编辑：单行改分
 * ============================================================ */
export async function updateScore(body: ScoreUpdateBody, user: any) {
  await assertStageView(user, body.stage);
  if (!body.id) throw new BizError(BizCode.PARAM_ERROR, '缺少成绩记录ID');
  if (
    body.writtenScore !== undefined && body.writtenScore !== null &&
    (Number(body.writtenScore) < 0 || Number(body.writtenScore) > 100)
  ) {
    throw new BizError(BizCode.PARAM_ERROR, '分数必须在 0 ~ 100 之间');
  }
  if (body.examResult !== undefined && body.examResult !== null && ![1, 2].includes(Number(body.examResult))) {
    throw new BizError(BizCode.PARAM_ERROR, '结果只能是 1 通过 / 2 未通过');
  }
  return REPOS[body.stage].updateOne(body, user?.userId || 'system');
}

/* ============================================================
 * 末班
 * ============================================================
 * 【目标班级学段规则】（2026-10-19 需求）
 *   初高 → 只能初高班；大学 → 只能大学班；实训 → 三学段任意班。
 *   放在 service 里而不是各仓储里，是因为这是**业务规则**，
 *   将来放宽（例如初高也能退到更低阶段）只改这一处。
 */
const REPEAT_TARGETS: Record<TeachingStage, TeachingStage[]> = {
  jh: ['jh'],
  class: ['class'],
  job: ['jh', 'class', 'job'],
};

export async function repeatScore(body: ScoreRepeatBody, user: any): Promise<ScoreRepeatResult> {
  await assertStageView(user, body.stage);
  if (!body.scoreId) throw new BizError(BizCode.PARAM_ERROR, '缺少成绩记录ID');
  if (!body.targetClassId) throw new BizError(BizCode.PARAM_ERROR, '请选择交接到的班级');
  if (!String(body.repeatReason ?? '').trim()) throw new BizError(BizCode.PARAM_ERROR, '请选择末班原因');

  const targets = REPEAT_TARGETS[body.stage];
  if (!targets.includes(body.targetStage)) {
    // 统一 BizCode 里没有「业务规则不满足」这一档（只有初高那套有 40010），
    // 用 400 参数错误 + 明确文案，前端直接展示 message。
    throw new BizError(
      BizCode.PARAM_ERROR,
      `${TEACHING_STAGE_NAME[body.stage]}学生只能末班到${targets
        .map((s) => TEACHING_STAGE_NAME[s])
        .join(' / ')}班级`,
    );
  }
  // 跨学段要同时对目标学段有权限（否则等于越权往别的学段搬人）
  if (body.targetStage !== body.stage) await assertStageView(user, body.targetStage);

  return REPOS[body.stage].repeat(body, user?.userId || 'system');
}

export async function scoreSummary(
  q: { stage?: TeachingStage; examId?: string; classId?: string },
  user: any,
): Promise<ScoreSummaryItem[]> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (q.stage) await assertStageView(user, q.stage);
  const formulas = await getScoreFormula();

  const out: ScoreSummaryItem[] = [];
  for (const s of stages) {
    const rows = await REPOS[s].list({ ...q, stage: s, page: 1, size: Number.MAX_SAFE_INTEGER }, user);
    const entered = rows.filter((r) => r.totalScore !== null && r.totalScore !== undefined);
    const totalSum = entered.reduce((a, r) => a + Number(r.totalScore ?? 0), 0);
    const pass = rows.filter((r) => r.examResult === 1).length;
    const fail = rows.filter((r) => r.examResult === 2).length;
    out.push({
      stage: s,
      stageName: TEACHING_STAGE_NAME[s],
      totalStudents: rows.length,
      enteredCount: entered.length,
      avgTotal: entered.length ? Number((totalSum / entered.length).toFixed(2)) : 0,
      passCount: pass,
      failCount: fail,
      passRate: entered.length ? Number(((pass / entered.length) * 100).toFixed(2)) : 0,
    });
  }
  // formulas 仅用于确保配置可读（后续可按学段展示"口径说明"）
  void formulas;
  return out;
}

/**
 * ★ 2026-10-19：成绩页的「考试下拉」专用只读接口
 *
 * 【解决什么】
 *   大学部班主任只有成绩码 `class:grade:view`，没有考试码 `class:exam:view`，
 *   页面调 `/api/teaching/exam/list` 会被 403（实测：点成绩管理就弹「没有操作权限」）。
 *
 * 【口径】
 *   · 判权用**成绩域**的 CODES（jh: classjh:score:view / class: class:grade:view / job: job:examScore:view）
 *   · 数据复用考试域的查询（只读、不外放考试域写操作）
 */
/**
 * 成绩录入用的「班级下拉」
 *
 * ★ 复用 /api/teaching/exam/classes 会 403 —— 那个接口按**考试域**权限码判权，
 *   班主任只有 class:grade:view、没有 class:exam:view，拿到的班级是 0 个。
 *   这里用成绩域权限码判权，口径与 /exam-options 一致。
 */
export async function listEntryClasses(user: any): Promise<ClassOption[]> {
  return listClassesOfStages(await visibleStages(user), user);
}

export async function listExamOptions(
  stage: TeachingStage | undefined,
  keyword: string | undefined,
  user: any,
): Promise<ExamRow[]> {
  const stages: TeachingStage[] = stage ? [stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有成绩管理的访问权限');
  if (stage) await assertStageView(user, stage);

  const r = await listExamsForStages(
    stages,
    {
      keyword,
      page: 1,
      size: 200,
    } as unknown as ExamListQuery,
    user,
  );
  return r.list;
}
