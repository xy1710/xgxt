/**
 * 班级信息适配器（Adapter）
 * ============================================================
 *
 * 【与学生档案适配器的关键区别：不去重】
 *   学生档案要去重 —— 同一个人的影子表在多个库各有一条。
 *   班级**不去重** —— 「初高 G104」和「大学 G104」是**两个不同的班**，
 *   同名是常态，不是重复。按名字去重会把两个真实班级吃掉一个。
 *   → 所以本域只做「合并 + 分页」，不做去重。
 *
 * 【权限码 = 合并前各学段原页面的权限码，一个都没改】
 *   jh classjh:classInfo:view / class class:info:view / job job:class:view
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import * as repoClassJh from './repo.classJh';
import * as repoClass from './repo.class';
import * as repoJob from './repo.job';
import * as repoEmp from './repo.emp';
import type {
  ClassHandoverPayload,
  ClassStage,
  ClassHandoverRow,
  ClassListQuery,
  ClassRow,
  ClassSaveBody,
  ClassStageMeta,
  ClassSummary,
} from '../shared/dto';
import { CLASS_STAGES, CLASS_STAGE_NAME, isClassStage } from '../shared/dto';
import { assertStageCodeEx, visibleStagesEx } from '../shared/stageAccess';
import { loadStagePlanOptions, mergePhaseOptions } from '../shared/stagePlans';
import type { ClassDetail, ClassRepo } from './types';
import {
  HANDOVER_ROLES,
  insertHandover,
  listHandovers,
  pickNew,
  type RoleKey,
  type StaffSlot,
} from './handover.repo';
import { listSchemes, type StageSchemeItem } from '../../class-jh/utils/stageScheme';

const REPOS: Record<ClassStage, ClassRepo> = {
  jh: repoClassJh.repo,
  class: repoClass.repo,
  job: repoJob.repo,
  // ★ 2026-10-19 批注：就业部独立学段（复用 sms_job 表，按 dept_code=3 隔离）
  emp: repoEmp.repo,
};

/** 各学段班级页的权限码 */
const CODES: Record<ClassStage, string> = {
  jh: 'classjh:classInfo:view',
  class: 'class:info:view',
  job: 'job:class:view',
  // 就业部沿用就业/实训模块的班级查看权限
  emp: 'job:class:view',
};

const LABEL = '班级信息';

/** 学段所属门户模块（判权时用；就业部沿用 job 模块） */
const MODULE_OF = (s: ClassStage): string =>
  s === 'jh' ? 'class-jh' : s === 'class' ? 'class' : 'job';

export function assertStageView(user: any, stage: ClassStage): Promise<void> {
  return assertStageCodeEx(user, stage, CODES, LABEL, (s) => CLASS_STAGE_NAME[s], MODULE_OF);
}

export function visibleStages(user: any): Promise<ClassStage[]> {
  return visibleStagesEx(user, CLASS_STAGES, CODES, LABEL, (s) => CLASS_STAGE_NAME[s], MODULE_OF);
}

function pick(stage: ClassStage): ClassRepo {
  const r = REPOS[stage];
  if (!r) throw new BizError(BizCode.PARAM_ERROR, `stage 只能是 jh / class / job`);
  return r;
}

/** 校验 stage 合法 */
export function assertStage(v: unknown): ClassStage {
  if (!isClassStage(v)) {
    throw new BizError(BizCode.PARAM_ERROR, 'stage 只能是 jh / class / job / emp');
  }
  return v;
}

function optStage(v: unknown): ClassStage | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return assertStage(v);
}

/* ============================================================
 * 列表（合并 + 分页；统计与列表共用 mergedRows，保证「卡片 = 列表」）
 * ============================================================ */

async function mergedRows(
  q: ClassListQuery,
  user: any,
): Promise<{ rows: ClassRow[]; stages: ClassStage[] }> {
  const stages: ClassStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有班级信息的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  let rows = parts.flat();

  // 学段顺序固定（初高 → 大学 → 实训），再按创建时间倒序
  rows.sort((a, b) => {
    const sa = CLASS_STAGES.indexOf(a.stage);
    const sb = CLASS_STAGES.indexOf(b.stage);
    if (sa !== sb) return sa - sb;
    const ta = a.createTime || '';
    const tb = b.createTime || '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.className.localeCompare(b.className, 'zh-Hans-CN');
  });
  return { rows, stages };
}

/** 列表（分页） */
export async function listClasses(
  q: ClassListQuery,
  user: any,
): Promise<{ list: ClassRow[]; total: number; page: number; size: number; stages: ClassStage[] }> {
  const { rows, stages } = await mergedRows(q, user);
  const total = rows.length;
  const start = (q.page - 1) * q.size;
  return { list: rows.slice(start, start + q.size), total, page: q.page, size: q.size, stages };
}

/** 统计（口径与列表完全一致：同一套筛选） */
export async function summaryClasses(
  q: ClassListQuery,
  user: any,
): Promise<ClassSummary[]> {
  const stages: ClassStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) return [];
  if (q.stage) await assertStageView(user, q.stage);

  // 逐学段统计（每个仓储自己算，口径与它自己的 list 一致）
  return Promise.all(stages.map((s) => REPOS[s].summary(q, user)));
}

/** 详情 */
export async function getClassDetail(
  stage: ClassStage,
  id: string,
  user: any,
): Promise<ClassDetail | null> {
  await assertStageView(user, stage);
  return pick(stage).detail(id, user);
}

/** 保存 */
export async function saveClass(body: ClassSaveBody, user: any): Promise<{ id: string }> {
  await assertStageView(user, body.stage);
  return pick(body.stage).save(body, user?.userId || '');
}

/** 删除 */
export async function removeClass(stage: ClassStage, id: string, user: any): Promise<void> {
  await assertStageView(user, stage);
  await pick(stage).remove(id, user?.userId || '');
}

/** 花名册 */
export async function listClassRoster(stage: ClassStage, id: string, user: any) {
  await assertStageView(user, stage);
  return pick(stage).roster(id, user);
}

/** 改状态 */
export async function changeClassStatus(
  stage: ClassStage,
  id: string,
  to: number,
  user: any,
): Promise<void> {
  await assertStageView(user, stage);
  await pick(stage).changeStatus(id, to, user?.userId || '');
}

/**
 * 元信息：**只返回当前账号可见学段的**特性
 *
 * 前端据此隐藏不适用的输入框：
 *   hasClassCode=false → 不显示「班级编号」
 *   hasCloseDate=false → 不显示「结业日期」
 *   classroomLabel     → 用仓储给的 label，别自己猜（大学叫"教室"、实训叫"教室地点"）
 */
export async function listClassMeta(user: any): Promise<ClassStageMeta[]> {
  const stages = await visibleStages(user);
  const [list, planOptions] = await Promise.all([
    Promise.all(stages.map((s) => REPOS[s].meta())),
    // ★ 2026-10-16 阶段方案：两个部门的方案都在 sms_class_jh 里，与学段无关
    loadStagePlanOptions(),
  ]);
  return list.map((m) => ({
    ...m,
    // ★ 2026-10-19：本部门方案里的阶段并进筛选下拉（就业部/实训 dept_code=3 共用一套）
    phaseOptions: mergePhaseOptions(m.stage, m.phaseOptions, planOptions),
    planOptions,
  }));
}

/**
 * ★ 2026-10-16：阶段方案选项（班级表单的「阶段方案 / 阶段」两个下拉）
 *
 * 方案数据存在初高库（sms_class_jh）的 t_class_stage_scheme，
 * 但按部门区分（1 初高部 / 2 大学部）—— 三个学段的班级表单都取这一份，
 * 前端按表单里选中的「部门」过滤，选完方案后「阶段」下拉 = 该方案的阶段明细。
 */
export async function listSchemeOptions(user: any): Promise<StageSchemeItem[]> {
  const stages = await visibleStages(user);
  if (!stages.length) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有班级信息的访问权限');
  }
  return listSchemes();
}

/**
 * 班级下拉（供出勤/考试/成绩/学生等域复用）
 *
 * ⚠️ 已被 `shared/classOptions.ts` 承担（那是对**学生表**去重取班名），
 *    这里是**权威班级表**取数 —— 两者用途不同，别混用：
 *    classOptions = 给筛选下拉用（要含已解散的班）
 *    本函数 = 给"选班建班/转班"用（只给有效班）
 */
export async function listClassOptions(user: any) {
  const stages = await visibleStages(user);
  const out: Array<{
    stage: ClassStage;
    stageName: string;
    classId: string;
    className: string;
    classStatus: number;
    classStatusName: string;
  }> = [];
  for (const s of stages) {
    const rows = await REPOS[s].list({ stage: s, page: 1, size: 200 }, user);
    for (const r of rows) {
      // 已结业的班不作为「可转入」选项
      if (r.classStatus === 4) continue;
      out.push({
        stage: r.stage,
        stageName: r.stageName,
        classId: r.classId,
        className: r.className,
        classStatus: r.classStatus,
        classStatusName: r.classStatusName,
      });
    }
  }
  return out;
}

/** 班级编号生成（只有实训有；其它学段前端应隐藏该入口） */
export async function genClassCodeFor(stage: ClassStage): Promise<string | null> {
  if (stage === 'job') return repoJob.genClassCode();
  if (stage === 'emp') return repoEmp.genClassCode();
  return null;
}

/* ============================================================
 * 班级交接（2026-10-19 批注）
 *   一次交接 = 一个班把 5 个岗位（班主任/教员/助教/项目经理/就业老师）
 *   的现任换成新人；提交即生效，并留一条记录给班级详情看。
 *   初高没有后两个岗位 → 那两个岗位传什么都忽略。
 * ============================================================ */

/** 读某班的交接记录 */
export async function listClassHandovers(
  stage: ClassStage,
  classId: string,
  user: any,
): Promise<ClassHandoverRow[]> {
  await assertStageView(user, stage);
  return listHandovers(stage, classId);
}

const EMPTY_SLOT: StaffSlot = { id: null, name: null };

/**
 * 执行交接
 *
 * 【口径】
 *   · 前端只需传「要换的人」；没传的岗位视为不变（不是清空 —— 清空负责人只能用编辑班级）
 *   · 至少要换一个岗位，否则报错（防止点两下写出一条什么都没变的记录）
 *   · 交接日期为空 → 默认今天
 *   · 先改班级负责人，再写记录：改失败就不留记录
 */
export async function handoverClass(
  payload: ClassHandoverPayload,
  user: any,
): Promise<ClassHandoverRow> {
  const stage = assertStage(payload.stage);
  await assertStageView(user, stage);

  const classId = String(payload.classId ?? '').trim();
  if (!classId) throw new BizError(BizCode.PARAM_ERROR, '缺少班级ID');

  const detail = await pick(stage).detail(classId, user);
  if (!detail) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在或无权访问');
  const base = detail.base;

  // 初高的表没有项目经理/就业老师 → 这两个岗位不参与比较与保存
  const keys: RoleKey[] =
    stage === 'jh' ? ['headTeacher', 'teacher', 'assistant'] : [...HANDOVER_ROLES];

  const old: Record<RoleKey, StaffSlot> = {
    headTeacher: { id: base.headTeacherId, name: base.headTeacherName },
    teacher: { id: base.teacherId, name: base.teacherName },
    assistant: { id: base.assistantId, name: base.assistantName },
    projectManager: { id: base.projectManagerId, name: base.projectManagerName },
    employmentTeacher: { id: base.employmentTeacherId, name: base.employmentTeacherName },
  };

  const next: Record<RoleKey, StaffSlot> = { ...old };
  let changed = 0;
  for (const key of keys) {
    const picked = pickNew(payload, key);
    if (!picked.id && !picked.name) continue; // 没选 = 该岗位不变
    // 只传了 ID 没传姓名（其它调用方）→ 退回保留原名，避免详情里只剩裸 ID
    const name = picked.name || (picked.id === old[key].id ? old[key].name : null);
    next[key] = { id: picked.id, name };
    if (picked.id !== old[key].id || name !== old[key].name) changed += 1;
  }
  if (!changed) {
    throw new BizError(BizCode.PARAM_ERROR, '请至少更换一个岗位的负责人再提交交接');
  }

  const handoverDate =
    String(payload.handoverDate ?? '').trim().slice(0, 10) ||
    new Date().toISOString().slice(0, 10);
  const reason = String(payload.reason ?? '').trim().slice(0, 255) || null;
  const userId = user?.userId || '';
  const userName = user?.userName || '';

  // ① 改班级负责人（走各学段原有仓储；classStatus 不传 → 不触发状态机）
  const saveBody: ClassSaveBody = {
    stage,
    id: classId,
    className: base.className,
    deptCode: base.deptCode ?? undefined,
    phaseCode: base.phaseCode ?? undefined,
    headTeacherId: next.headTeacher.id,
    headTeacherName: next.headTeacher.name,
    teacherId: next.teacher.id,
    teacherName: next.teacher.name,
    assistantId: next.assistant.id,
    assistantName: next.assistant.name,
  };
  if (stage !== 'jh') {
    saveBody.projectManagerId = next.projectManager.id;
    saveBody.projectManagerName = next.projectManager.name;
    saveBody.employmentTeacherId = next.employmentTeacher.id;
    saveBody.employmentTeacherName = next.employmentTeacher.name;
  }
  await pick(stage).save(saveBody, userId);

  // ② 留痕（初高缺的两个岗位记空，前端也不展示）
  return insertHandover({
    stage,
    classId,
    className: base.className,
    deptCode: base.deptCode,
    old,
    next: {
      headTeacher: next.headTeacher,
      teacher: next.teacher,
      assistant: next.assistant,
      projectManager: stage === 'jh' ? EMPTY_SLOT : next.projectManager,
      employmentTeacher: stage === 'jh' ? EMPTY_SLOT : next.employmentTeacher,
    },
    handoverDate,
    reason,
    operatorId: userId || null,
    operatorName: userName || null,
  });
}
