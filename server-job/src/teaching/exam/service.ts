/**
 * 考试适配器（Adapter）· 与出勤域同构，只换业务语义
 * ============================================================
 * 分派（stage → 仓储）+ 合并排序分页 + 学段权限隔离，三件事与出勤域一致。
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import * as repoClassJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';
import type { ExamDetail, ExamListQuery, ExamRow, ExamSaveBody, TeachingStage } from '../shared/dto';
import { TEACHING_STAGES } from '../shared/dto';
import { assertStageCode, visibleStagesBy, type StageCodeMap } from '../shared/stageAccess';
import { assertClassesInScope } from '../shared/dataScope';
import { listClassesOfStages, type ClassOption } from '../shared/classOptions';

type Repo = {
  list: (q: ExamListQuery, user?: any) => Promise<ExamRow[]>;
  detail: (id: string) => Promise<ExamDetail | null>;
  save: (b: ExamSaveBody, userId: string, userName: string) => Promise<{ id: string }>;
  remove: (id: string, userId: string) => Promise<void>;
};

const REPOS: Record<TeachingStage, Repo> = {
  jh: repoClassJh,
  class: repoClass,
  job: repoJob,
};

/**
 * 各学段考试页的权限码（= 合并前各学段考试页的权限码）
 *
 * ★ 2026-10-15：job 学段补 `job:examScore:view`（成绩管理码），双码任一即可。
 *   原因：**成绩管理页**（/teaching/score）要给「考试下拉」读考试列表，
 *   调的是本域的 `GET /api/teaching/exam/list`（前端统一封装 teaching/api/exam.ts）。
 *   但项目经理/班主任/教员/助教手里只有**成绩码** `job:examScore:view`，
 *   没有**考试管理码** `job:exam:view`（那个是校长专用）——
 *   于是他们一进成绩管理页就报「没有考试管理的访问权限」（实测踩到，
 *   报错却出现在「成绩管理」页，极易误判成成绩域的问题）。
 *   业务上「能看成绩 → 就必须能读到该学段的考试列表来选考试」。
 *   ⚠️ 两点都改才算修好：本文件（学段级校验）+ app.ts 的路由白名单
 *      （`requireAnyPage`）。只改一处会在另一处被同一条件拦下。
 */
const CODES: StageCodeMap = {
  jh: 'classjh:exam:view',
  class: 'class:exam:view',
  job: ['job:exam:view', 'job:examScore:view'],
};
const LABEL = '考试管理';

export function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, CODES, LABEL);
}
export function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, CODES, LABEL);
}

export async function listExams(
  q: ExamListQuery,
  user: any,
): Promise<{ total: number; page: number; size: number; list: ExamRow[] }> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有考试管理的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  return listExamsForStages(stages, q, user);
}

/**
 * ★ 2026-10-19：给「成绩管理页的考试下拉」用的内部实现 —— **不做考试域判权**
 *
 * 【为什么单独拆出来】
 *   成绩页（`/teaching/score/*`）要选考试，必须读考试列表；但班主任/教员只有
 *   成绩码（`class:grade:view`），没有考试码（`class:exam:view`）。
 *   直接调 `/api/teaching/exam/list` 会 403 —— 实测「大学部班主任点成绩管理报无权限」。
 *
 *   于是成绩域自己开一个只读的 `/exam-options`，用**成绩域的权限码**判权，
 *   再复用这里的查询逻辑。这样既不放开考试域的写操作，也不用给老师发考试权限。
 *   （与 P3 时代 `examScore.route.ts` 的 `/exam-options` 是同一个思路。）
 */
export async function listExamsForStages(
  stages: TeachingStage[],
  q: ExamListQuery,
  user?: any,
): Promise<{ total: number; page: number; size: number; list: ExamRow[] }> {
  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  const merged = parts.flat();
  merged.sort((a, b) => {
    if (a.examDate !== b.examDate) return a.examDate < b.examDate ? 1 : -1;
    return a.examName.localeCompare(b.examName, 'zh-Hans-CN');
  });

  const start = (q.page - 1) * q.size;
  return { total: merged.length, page: q.page, size: q.size, list: merged.slice(start, start + q.size) };
}

export async function getExamDetail(
  stage: TeachingStage,
  id: string,
  user: any,
): Promise<ExamDetail> {
  await assertStageView(user, stage);
  const d = await REPOS[stage].detail(id);
  if (d) await assertClassesInScope(stage, d.record.classIds || [], user, '该班级考试');
  if (!d) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');
  return d;
}

export async function saveExam(body: ExamSaveBody, user: any) {
  await assertStageView(user, body.stage);
  if (!body.examName?.trim()) throw new BizError(BizCode.PARAM_ERROR, '考试名称必填');
  if (!body.examDate) throw new BizError(BizCode.PARAM_ERROR, '考试日期必填');
  return REPOS[body.stage].save(body, user?.userId || 'system', user?.userName || '');
}

export async function removeExam(stage: TeachingStage, id: string, user: any) {
  await assertStageView(user, stage);
  await REPOS[stage].remove(id, user?.userId || 'system');
}

/** 班级下拉（共享实现） */
export async function listClassOptions(user: any): Promise<ClassOption[]> {
  return listClassesOfStages(await visibleStages(user));
}

export { TEACHING_STAGES };
