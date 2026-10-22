/**
 * 共享：阶段方案取数（★ 2026-10-16 新增）
 * ============================================================
 *
 * 【背景】
 *   原「阶段字典」是一张平铺表（一行 = 一个阶段）。改版后一个**方案**可以包含
 *   多个**阶段**（方案名称 + 所属部门 + 若干「阶段名称 / 学制月数」）。
 *
 *   班级管理 / 学生档案的「阶段」下拉随之改成「先选方案，再选阶段」，
 *   所以这两个域的 meta 里要把方案清单一起下发。
 *
 * 【数据源】
 *   sms_class_jh.t_class_stage_plan（方案）+ sms_class_jh.t_class_stage（阶段，plan_id 关联）
 *   ⚠️ 初高部 / 大学部**两个部门**的方案都在这个库里（历史如此，原阶段字典也是）。
 *      所以本函数与「当前学段」无关，直接返回两个部门的全部方案。
 */

import { db as classJhDb } from '../../class-jh/utils/db';
import { uniDb } from './uniTable';
import type { StagePlanOption } from './dto';

/* ★ 2026-10-21：改读「设置页真正在写」的新模型
 *   旧实现读的是 t_class_stage_plan + t_class_stage.plan_id，
 *   而 P8 已把阶段字典归一成 t_uni_stage_def、方案改版成
 *   t_class_stage_scheme(+_stage) —— 旧表早就不存在，导致方案下拉恒空、
 *   就业部/实训的阶段选项一个都出不来。
 */
const SCHEME_T = 't_class_stage_scheme';
const SCHEME_STAGE_T = 't_class_stage_scheme_stage';
const STAGE_DEF_T = 't_uni_stage_def';

/** 读全部阶段方案（含每个方案下的阶段，按 sort_no 排序） */
export async function loadStagePlanOptions(): Promise<StagePlanOption[]> {
  try {
    const plans = (await classJhDb(SCHEME_T)
      .where('is_deleted', false)
      .select('id', 'scheme_name', 'dept_code', 'sort_no')
      .orderBy('sort_no', 'asc')
      .orderBy('create_time', 'asc')) as Array<Record<string, any>>;
    if (!plans.length) return [];

    const stages = (await classJhDb(SCHEME_STAGE_T)
      .where('is_deleted', false)
      .select('scheme_id', 'stage_name', 'sort_no')
      .orderBy('sort_no', 'asc')) as Array<Record<string, any>>;

    /* 方案明细里只有阶段名（没有阶段码），用统一阶段字典按
       (部门, 阶段名) 反查编码 —— 查不到就跳过，避免给出空编码 */
    // ⚠️ 阶段字典已归一，在 sms_common，必须用统一库连接（初高库没有这张表）
    const defs = (await uniDb(STAGE_DEF_T)
      .where('is_deleted', false)
      .select('dept_code', 'stage_code', 'stage_name')) as Array<Record<string, any>>;
    const codeOf = new Map<string, number>();
    for (const d of defs) {
      codeOf.set([String(Number(d.dept_code)), String(d.stage_name ?? '')].join('|'), Number(d.stage_code));
    }

    const deptOfPlan = new Map<string, number>();
    for (const p of plans) deptOfPlan.set(String(p.id), Number(p.dept_code));

    const byPlan = new Map<string, Array<{ value: number; label: string }>>();
    for (const s of stages) {
      const schemeId = String(s.scheme_id ?? '');
      const name = String(s.stage_name ?? '');
      const dept = deptOfPlan.get(schemeId);
      if (!dept) continue;
      const code = codeOf.get([String(dept), name].join('|'));
      if (code === undefined || Number.isNaN(code)) continue;
      if (!byPlan.has(schemeId)) byPlan.set(schemeId, []);
      byPlan.get(schemeId)!.push({ value: code, label: name });
    }

    return plans.map((p) => ({
      id: String(p.id),
      name: String(p.scheme_name ?? ''),
      deptCode: Number(p.dept_code),
      phases: byPlan.get(String(p.id)) ?? [],
    }));
  } catch {
    // 表还没建好 / 库没起来：静默降级（前端回落到 phaseOptions）
    return [];
  }
}

/** 学段 → 部门编码（jh 1 / class 2；★ 实训与就业部共用 3） */
const STAGE_DEPT_CODE: Record<string, number> = { jh: 1, class: 2, job: 3, emp: 3 };

/**
 * ★ 2026-10-19 就业部接入阶段方案：把「本部门方案里的阶段」作为 meta.phaseOptions
 *
 * 【口径】方案表是唯一权威，四个部门一视同仁（就业部/实训共用 dept_code=3）。
 *   只有在本部门一套方案都没有时（表没建好 / 还没配）才回落到仓储常量，
 *   且只留本部门段位的编码（1xx / 2xx / 3xx）——
 *   ⚠️ 仓储常量是**全量字典**（jh 的清单里也有 201~204），直接并进来会出现
 *   「初高部能筛到大学部阶段」，所以必须按段位过滤，不能整份并。
 */
export function mergePhaseOptions(
  stage: string,
  baseOptions: Array<{ value: number; label: string }> | undefined,
  planOptions: StagePlanOption[],
): Array<{ value: number; label: string }> {
  const deptCode = STAGE_DEPT_CODE[stage];
  const fromPlans = planOptions.filter((p) => p.deptCode === deptCode).flatMap((p) => p.phases);
  if (fromPlans.length) return fromPlans;
  const base = deptCode === 1 ? 100 : deptCode === 2 ? 200 : 300;
  return (baseOptions ?? []).filter((p) => p.value >= base && p.value < base + 100);
}
