/**
 * 出勤适配器（Adapter）· 第 2 期的核心
 * ============================================================
 *
 * 【它做什么】
 *   对外：只暴露一套语义（list / detail / save / summary / export）。
 *   对内：按 `stage` 把请求**分派**给三个仓储，再把结果合成一个列表。
 *
 * 【像什么】
 *   像**万能转换头**：墙上三个国家的插座（三套表）原样不动，
 *   转换头对外只输出一种"电"（统一 DTO）。
 *
 * 【三件事必须在这里做完，不能下放到仓储】
 *   ① 分派：stage → 用哪个仓储
 *   ② 合并：不传 stage 时（前端选「全部」）把三段结果合起来排序分页
 *   ③ 隔离：**校验当前账号对目标学段有没有权限**（防止初高老师查到实训数据）
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import * as repoClassJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';
import type {
  AttendanceBoard,
  AttendanceDetail,
  AttendanceListQuery,
  AttendanceRow,
  AttendanceSaveBody,
  AttendanceSummary,
  TeachingStage,
} from '../shared/dto';
import { TEACHING_STAGE_NAME, TEACHING_STAGES } from '../shared/dto';
import { getScope } from '../shared/conf';
import { listClassesOfStages, type ClassOption } from '../shared/classOptions';
import { assertClassInScope } from '../shared/dataScope';
import {
  assertStageCode,
  visibleStagesBy,
  type StageCodeMap,
} from '../shared/stageAccess';

type Repo = {
  list: (q: AttendanceListQuery, user?: any) => Promise<AttendanceRow[]>;
  detail: (id: string) => Promise<AttendanceDetail | null>;
  board: (classId: string, date: string) => Promise<AttendanceBoard>;
  save: (
    body: AttendanceSaveBody,
    userId: string,
  ) => Promise<{ id: string; shouldCount: number; actualCount: number; attendanceRate: number }>;
};

const REPOS: Record<TeachingStage, Repo> = {
  jh: repoClassJh,
  class: repoClass,
  job: repoJob,
};

/** 各学段的页面查看权限码（= 合并前各学段出勤页的权限码，一个都没改） */
const STAGE_VIEW_CODE: StageCodeMap = {
  jh: 'classjh:attendance:view',
  class: 'class:attendance:view',
  job: 'job:attendance:view',
};
const LABEL = '出勤管理';

/**
 * ★ 学段级访问校验 —— 防止「初高老师查到实训数据」
 *   实现已提到 shared/stageAccess.ts（所有域共用同一口径，避免口径漂移导致越权）
 */
export function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, STAGE_VIEW_CODE, LABEL);
}

/** 当前账号**可见**的学段列表（无 stage 参数时用） */
export function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, STAGE_VIEW_CODE, LABEL);
}

/* ============================================================
 * 列表（合并 + 排序 + 分页）
 * ============================================================ */

export async function listAttendance(
  q: AttendanceListQuery,
  user: any,
): Promise<{ total: number; page: number; size: number; list: AttendanceRow[] }> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有出勤管理的访问权限');
  }
  if (q.stage) await assertStageView(user, q.stage);

  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  const merged = parts.flat();

  // 统一按日期倒序，同日按班级名
  merged.sort((a, b) => {
    if (a.attendanceDate !== b.attendanceDate) return a.attendanceDate < b.attendanceDate ? 1 : -1;
    return a.className.localeCompare(b.className, 'zh-Hans-CN');
  });

  const total = merged.length;
  const start = (q.page - 1) * q.size;
  return { total, page: q.page, size: q.size, list: merged.slice(start, start + q.size) };
}

/** 导出用：不分页的全量列表 */
export async function exportAttendance(q: AttendanceListQuery, user: any): Promise<AttendanceRow[]> {
  const r = await listAttendance({ ...q, page: 1, size: Number.MAX_SAFE_INTEGER }, user);
  return r.list;
}

/* ============================================================
 * 详情
 * ============================================================ */

export async function getDetail(stage: TeachingStage, id: string, user: any): Promise<AttendanceDetail> {
  await assertStageView(user, stage);
  const d = await REPOS[stage].detail(id);
  await assertClassInScope(stage, d?.record?.classId, user, "该班级出勤");
  if (!d) throw new BizError(BizCode.ATTENDANCE_NOT_FOUND, '出勤记录不存在');
  return d;
}

/* ============================================================
 * 录入登记板
 * ============================================================ */

export async function getBoard(
  stage: TeachingStage,
  classId: string,
  date: string,
  user: any,
): Promise<AttendanceBoard> {
  await assertStageView(user, stage);
  return REPOS[stage].board(classId, date);
}

/* ============================================================
 * 保存
 * ============================================================ */

export async function saveAttendance(body: AttendanceSaveBody, user: any) {
  await assertStageView(user, body.stage);
  return REPOS[body.stage].save(body, user?.userId || 'system');
}

/* ============================================================
 * 班级下拉（三个学段的班级表不同，这里统一成 {id,name}）
 * ============================================================ */

export async function listClassOptions(user: any): Promise<ClassOption[]> {
  return listClassesOfStages(await visibleStages(user), user);
}

/* ============================================================
 * 汇总统计（每个学段各算一份，口径取配置）
 * ============================================================ */

export async function attendanceSummary(
  q: { classId?: string; startDate?: string; endDate?: string; stage?: TeachingStage },
  user: any,
): Promise<AttendanceSummary[]> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (q.stage) await assertStageView(user, q.stage);
  const scopes = await getScope();

  const out: AttendanceSummary[] = [];
  for (const s of stages) {
    const rows = await REPOS[s].list({ ...q, stage: s, page: 1, size: Number.MAX_SAFE_INTEGER }, user);
    const targetRate = scopes[s].targetRate;
    const classes = new Set(rows.map((r) => r.classId));
    const avgRate = rows.length
      ? Number((rows.reduce((a, r) => a + r.attendanceRate, 0) / rows.length).toFixed(2))
      : 0;
    out.push({
      stage: s,
      stageName: TEACHING_STAGE_NAME[s],
      totalRecords: rows.length,
      avgRate,
      classCount: classes.size,
      unqualifiedCount: rows.filter((r) => r.attendanceRate < targetRate).length,
      targetRate,
    });
  }
  return out;
}
