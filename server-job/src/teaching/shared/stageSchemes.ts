/**
 * 共享：阶段方案（方案 + 阶段明细）只读取数
 * ============================================================
 *
 * 【为什么单独一个文件】
 *   学生档案的「阶段」筛选要**实时**跟随「系统设置 · 阶段方案」里配的阶段，
 *   而设置页写的是 `t_class_stage_scheme`（方案）+ `t_class_stage_scheme_stage`
 *   （方案下的阶段明细，阶段名称是自由文本、没有数字码）。
 *
 *   注意与 `stagePlans.ts` 区别：那个读的是**老的阶段字典**
 *   （`t_class_stage_plan` + `t_class_stage`，阶段带 int 码），
 *   给班级/学生**表单**的「阶段码」下拉用。两套表并存，别混。
 *
 * 【数据在哪】
 *   两个部门的方案都在初高库 `sms_class_jh` 里（历史如此，老阶段字典也一样）。
 */

import { db as classJhDb } from '../../class-jh/utils/db';
import type { SchemeStageOption } from './dto';

const SCHEME_T = 't_class_stage_scheme';
const STAGE_T = 't_class_stage_scheme_stage';

/** 学生学段 → 部门编码（jh 1 / class 2 / emp 3） */
export const SCHEME_DEPT_OF_STAGE: Record<string, number> = {
  jh: 1,
  class: 2,
  emp: 3,
};

/**
 * 读阶段方案下的全部阶段（可按部门过滤）
 *
 * 排序：部门 → 方案 sort_no → 阶段 sort_no，保证下拉顺序稳定（与设置页一致）。
 * 表没建好 / 库没起来时返回空数组 —— 前端会落到「未设置」，不白屏。
 */
export async function loadSchemeStageOptions(deptCode?: number): Promise<SchemeStageOption[]> {
  try {
    const q = classJhDb(SCHEME_T).where('is_deleted', false);
    if (deptCode) q.andWhere('dept_code', deptCode);
    const schemes = (await q
      .select('id', 'scheme_name', 'dept_code', 'sort_no')
      .orderBy('dept_code', 'asc')
      .orderBy('sort_no', 'asc')
      .orderBy('create_time', 'asc')) as Array<Record<string, any>>;
    if (!schemes.length) return [];

    const schemeMap = new Map<string, Record<string, any>>();
    for (const s of schemes) schemeMap.set(String(s.id), s);

    const stages = (await classJhDb(STAGE_T)
      .whereIn(
        'scheme_id',
        schemes.map((s) => s.id),
      )
      .where('is_deleted', false)
      .select('id', 'scheme_id', 'stage_name', 'study_months', 'sort_no')
      .orderBy('sort_no', 'asc')
      .orderBy('create_time', 'asc')) as Array<Record<string, any>>;

    const out: SchemeStageOption[] = [];
    for (const st of stages) {
      const sc = schemeMap.get(String(st.scheme_id));
      if (!sc) continue;
      out.push({
        id: String(st.id),
        name: String(st.stage_name ?? ''),
        schemeId: String(sc.id),
        schemeName: String(sc.scheme_name ?? ''),
        deptCode: Number(sc.dept_code),
        studyMonths: st.study_months === null || st.study_months === undefined ? null : Number(st.study_months),
        sortNo: Number(st.sort_no ?? 0),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 某学段所属部门的方案阶段（学段 → 部门 → 方案阶段） */
export async function loadSchemeStagesForStage(stage: string): Promise<SchemeStageOption[]> {
  const dept = SCHEME_DEPT_OF_STAGE[stage];
  if (!dept) return [];
  return loadSchemeStageOptions(dept);
}
