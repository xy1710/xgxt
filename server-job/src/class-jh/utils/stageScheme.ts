/**
 * 阶段方案读写（t_class_stage_scheme + t_class_stage_scheme_stage）
 * ============================================================
 *
 * 【是什么】原「阶段字典」（一条记录 = 一个阶段）升级为「阶段方案」：
 *   一个方案 = 方案名称 + 所属部门 + N 个阶段（阶段名称 + 学制月数）。
 *   例：方案一（初高部）→ 一阶段 学制2月 / 二阶段 学制2月 / 三阶段 学制2月。
 *
 * 【谁在用】
 *   ① 教学管理 · 系统设置 · 阶段方案页（class-jh/setting.route.ts，增删改查）
 *   ② 统一班级页的表单（teaching/class/*，只读方案选项给「阶段方案 / 阶段」两个下拉）
 *   ③ 实训/大学部的班级表单同样复用 ② 的接口 —— 方案虽然存在初高库里，
 *      但按部门区分（1 初高部 / 2 大学部），三个学段各自只看到本部门的方案。
 *
 * 【删除保护】方案被班级引用时禁止删除：三张班级表（初高/大学/实训）都查一遍。
 *   跨库查询用裸 SQL + try/catch —— 某张表不存在（未部署该学段）时跳过，不误伤。
 */

import { randomUUID } from 'crypto';
import { BizCode, DEPT_NAME } from 'shared-types/class-jh';
import { BizError } from '../middleware/errorHandler';
import { db } from './db';

const SCHEME_TABLE = 't_class_stage_scheme';
const SCHEME_STAGE_TABLE = 't_class_stage_scheme_stage';

/** 方案被哪些班级表引用（跨库） */
const CLASS_TABLES = ['sms_class_jh.t_class_info', 'sms_class.t_class_info', 'sms_job.t_job_class'];

/* ============================================================
 * 类型
 * ============================================================ */

/** 方案下的阶段明细（回给前端） */
export interface SchemeStageItem {
  id: string;
  stageName: string;
  /** 学制月数 */
  studyMonths: number | null;
  sortNo: number;
}

/** 阶段方案（含阶段明细） */
export interface StageSchemeItem {
  id: string;
  schemeName: string;
  deptCode: number;
  deptName: string;
  stages: SchemeStageItem[];
}

/** 方案保存入参（新增 / 修改共用；修改时阶段明细整体覆盖） */
export interface StageSchemeSaveInput {
  schemeName: string;
  deptCode: number;
  stages: Array<{ stageName: string; studyMonths?: number | null }>;
}

/* ============================================================
 * 工具
 * ============================================================ */

function mapStage(r: Record<string, any>): SchemeStageItem {
  return {
    id: String(r.id),
    stageName: String(r.stage_name ?? ''),
    studyMonths: r.study_months === null || r.study_months === undefined ? null : Number(r.study_months),
    sortNo: Number(r.sort_no ?? 0),
  };
}

function mapScheme(r: Record<string, any>, stages: SchemeStageItem[]): StageSchemeItem {
  const deptCode = Number(r.dept_code);
  return {
    id: String(r.id),
    schemeName: String(r.scheme_name ?? ''),
    deptCode,
    deptName: DEPT_NAME[deptCode] ?? '',
    stages,
  };
}

/** 同部门下方案名是否重复（排除指定 id，供修改时用） */
async function nameDuplicated(schemeName: string, deptCode: number, excludeId?: string): Promise<boolean> {
  const q = db(SCHEME_TABLE).where({ scheme_name: schemeName, dept_code: deptCode, is_deleted: false });
  if (excludeId) q.andWhereNot('id', excludeId);
  const row = await q.first();
  return !!row;
}

/* ============================================================
 * 读
 * ============================================================ */

/** 方案列表（含阶段明细），可按部门筛选 */
export async function listSchemes(deptCode?: number): Promise<StageSchemeItem[]> {
  const q = db(SCHEME_TABLE).where('is_deleted', false);
  if (deptCode) q.andWhere('dept_code', deptCode);
  const schemes = await q.orderBy('dept_code', 'asc').orderBy('sort_no', 'asc').orderBy('create_time', 'asc');
  if (!schemes.length) return [];

  const stages = await db(SCHEME_STAGE_TABLE)
    .whereIn('scheme_id', schemes.map((s: any) => s.id))
    .where('is_deleted', false)
    .orderBy('sort_no', 'asc')
    .orderBy('create_time', 'asc');

  const byScheme = new Map<string, SchemeStageItem[]>();
  for (const s of stages) {
    const key = String(s.scheme_id);
    if (!byScheme.has(key)) byScheme.set(key, []);
    byScheme.get(key)!.push(mapStage(s));
  }

  return schemes.map((s: any) => mapScheme(s, byScheme.get(String(s.id)) ?? []));
}

/** 方案详情（含阶段明细） */
export async function getScheme(id: string): Promise<StageSchemeItem | null> {
  const r = await db(SCHEME_TABLE).where({ id, is_deleted: false }).first();
  if (!r) return null;
  const stages = await db(SCHEME_STAGE_TABLE)
    .where({ scheme_id: id, is_deleted: false })
    .orderBy('sort_no', 'asc')
    .orderBy('create_time', 'asc');
  return mapScheme(r, stages.map(mapStage));
}

/* ============================================================
 * 写
 * ============================================================ */

/** 阶段明细入库（先逻辑删旧的，再插新的 —— 修改时整体覆盖） */
async function replaceStages(schemeId: string, stages: StageSchemeSaveInput['stages'], userId: string): Promise<void> {
  const now = new Date();
  await db(SCHEME_STAGE_TABLE).where({ scheme_id: schemeId, is_deleted: false }).update({
    is_deleted: true,
    update_time: now,
    update_by: userId || 'system',
  });

  const rows = stages.map((s, i) => ({
    id: randomUUID(),
    scheme_id: schemeId,
    stage_name: s.stageName,
    study_months: s.studyMonths ?? null,
    sort_no: i,
    is_deleted: false,
    create_time: now,
    create_by: userId || 'system',
  }));
  if (rows.length) await db(SCHEME_STAGE_TABLE).insert(rows);
}

/** 新增方案（含阶段明细） */
export async function createScheme(input: StageSchemeSaveInput, userId: string): Promise<{ id: string }> {
  if (await nameDuplicated(input.schemeName, input.deptCode)) {
    throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '该部门下已有同名方案');
  }

  const id = randomUUID();
  const now = new Date();
  await db(SCHEME_TABLE).insert({
    id,
    scheme_name: input.schemeName,
    dept_code: input.deptCode,
    sort_no: 0,
    is_deleted: false,
    create_time: now,
    create_by: userId || 'system',
  });
  await replaceStages(id, input.stages, userId);
  return { id };
}

/** 修改方案（阶段明细整体覆盖） */
export async function updateScheme(id: string, input: StageSchemeSaveInput, userId: string): Promise<{ id: string }> {
  const existed = await db(SCHEME_TABLE).where({ id, is_deleted: false }).first();
  if (!existed) throw new BizError(BizCode.SETTING_NOT_FOUND, '方案不存在');
  if (await nameDuplicated(input.schemeName, input.deptCode, id)) {
    throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '该部门下已有同名方案');
  }

  await db(SCHEME_TABLE).where({ id }).update({
    scheme_name: input.schemeName,
    dept_code: input.deptCode,
    update_time: new Date(),
    update_by: userId || 'system',
  });
  await replaceStages(id, input.stages, userId);
  return { id };
}

/** 方案是否仍被班级引用（初高 / 大学 / 实训三张班级表都查） */
export async function schemeUsedByClass(id: string): Promise<boolean> {
  for (const table of CLASS_TABLES) {
    try {
      const rows = await db.raw(
        `SELECT id FROM ${table} WHERE scheme_id = ? AND is_deleted = 0 LIMIT 1`,
        [id],
      );
      const first = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : undefined;
      if (first) return true;
    } catch {
      // 表不存在（该学段未部署）或权限不足 → 跳过，不影响删除判定
    }
  }
  return false;
}

/** 删除方案（逻辑删除；仍被班级引用时拒绝） */
export async function removeScheme(id: string, userId: string): Promise<void> {
  const existed = await db(SCHEME_TABLE).where({ id, is_deleted: false }).first();
  if (!existed) throw new BizError(BizCode.SETTING_NOT_FOUND, '方案不存在');

  if (await schemeUsedByClass(id)) {
    throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '该方案已被班级使用，禁止删除');
  }

  const now = new Date();
  await db(SCHEME_TABLE).where({ id }).update({
    is_deleted: true,
    update_time: now,
    update_by: userId || 'system',
  });
  await db(SCHEME_STAGE_TABLE).where({ scheme_id: id, is_deleted: false }).update({
    is_deleted: true,
    update_time: now,
    update_by: userId || 'system',
  });
}
