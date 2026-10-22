/**
 * 共享：统一班级下拉
 * ============================================================
 *
 * 【为什么提到 shared】
 *   出勤域先做了「班级下拉」，考试域、成绩域、退费域……**每个域都要**。
 *   如果不提出来，每个域各写一遍 → 又变成新的重复（我们正在消灭的那种）。
 *
 * 【它做的事】
 *   三个学段的班级表不同（初高/大学都叫 t_class_info 但在不同库，
 *   实训叫 t_job_class），这里统一成 {stage, stageName, id, name}。
 */

import { db as classJhDb } from '../../class-jh/utils/db';
import { db as classDb } from '../../class/db';
import { db as jobDb } from '../../utils/db';
import { tbl } from './uniTable';
import { visibleClassIds } from './dataScope';
import type { TeachingStage } from './dto';
import { TEACHING_STAGE_NAME } from './dto';

export interface ClassOption {
  stage: TeachingStage;
  stageName: string;
  id: string;
  name: string;
  /**
   * ★ 2026-10-16：带上班级的「部门」和「阶段」，供学生档案在选了班级后
   *   自动带出「部门 / 阶段」（跟随学生所在班级）。
   */
  deptCode?: number;
  phaseCode?: number;
}

/** 三张班级表都有 dept_code / stage 两列，统一取出来 */
const pick = (r: any) => ({
  id: String(r.id),
  name: String(r.name ?? ''),
  deptCode: r.dept_code === null || r.dept_code === undefined ? undefined : Number(r.dept_code),
  phaseCode: r.stage === null || r.stage === undefined ? undefined : Number(r.stage),
});

/**
 * ★ 各学段的班级表位置 —— **只在这里定义一份**
 *
 * 原来这段映射写在 `listClassesByStage` 里（if/else 三分支）；后来又要
 * 「按 id 反查班级名」，如果再抄一份，两处迟早分叉
 * （本项目反复踩过「同一条规则写两份、只改一份」的坑）。
 */
const CLASS_TABLE: Record<
  TeachingStage,
  { conn: typeof classJhDb; dbName: string; table: string }
> = {
  jh: { conn: classJhDb, dbName: 'sms_class_jh', table: 't_class_info' },
  class: { conn: classDb, dbName: 'sms_class', table: 't_class_info' },
  job: { conn: jobDb, dbName: 'sms_job', table: 't_job_class' },
};

/**
 * 取某学段的班级列表
 *
 * ★ 第 4 期步骤 2：改走 `tbl()` 路由（开关开=读统一表）
 * ★ 2026-10-19：可选传 `user` → 按角色数据范围过滤（项目经理只看自己的实训班等）。
 *    不传 = 不过滤（内部工具/历史调用保持原行为）。
 */
export async function listClassesByStage(
  stage: TeachingStage | 'emp',
): Promise<Array<{ id: string; name: string; deptCode?: number; phaseCode?: number }>> {
  if (stage === 'jh') {
    const rows = (await tbl(classJhDb, 'sms_class_jh', 't_class_info', stage)
      .where('is_deleted', 0)
      .select('id', 'class_name as name', 'dept_code', 'stage')) as Array<{ id: string; name: string }>;
    return rows.map(pick);
  }
  if (stage === 'class') {
    const rows = (await tbl(classDb, 'sms_class', 't_class_info', stage)
      .where('is_deleted', 0)
      .select('id', 'class_name as name', 'dept_code', 'stage')) as Array<{ id: string; name: string }>;
    return rows.map(pick);
  }
  // ★ 实训与就业部共用 t_job_class、dept 都是 3
  const qb = tbl(jobDb, 'sms_job', 't_job_class', stage).where('is_deleted', 0);

  /* ★ 2026-10-22：去掉 stage_key='job' 过滤 —— tbl(...,'job') 已按 edu_stage='job'
     圈定实训范围；再叠 stage_key 会把「stage_key 为 NULL 的行」（夹具/历史数据）
     静默排除（exam/dorm 套件的班级下拉用例实测被抓）。 */
  if (stage === 'emp') {
    // ★ 2026-10-21：学生档案删掉「就业」学段后，就业部成了 sms_job 的唯一入口，
    //   班级下拉必须列**整个部门**（dept_code=3）——
    //   现存 SX2601 的 stage_key 是 'job'，按 stage_key='emp' 过滤会一个班都列不出来。
    qb.andWhere('dept_code', 3);
  }
  const rows = (await qb.select('id', 'class_name as name', 'dept_code', 'stage')) as Array<{
    id: string;
    name: string;
  }>;
  return rows.map(pick);
}

/**
 * ★ 按班级 id **批量**反查班级名：`{ 班级id: 班级名 }`（2026-10-16 新增）
 *
 * 【为什么必须有】
 *   初高老表 `t_class_flow` 只存 `resume_class_id`，**没有班级名字列**
 *   （实训表有 `new_class_name` 快照）。于是初高复学单在列表「复学班级」列
 *   恒为「—」—— 数据其实**存进库了**，只是没人把 id 翻成名字。
 *   用户视角就是「我明明选了复学班级，列表里却没体现」。
 *
 * 【⚠️ 不过滤 `is_deleted` —— 与班级下拉口径相反，别「统一」掉】
 *   这里是**历史单据的展示**：班级后来被软删，名字仍要显示出来；
 *   显示「—」会让人以为当初没存进去。下拉则必须只列可用的班。
 *
 * 【为什么要批量】列表按页渲染（最多 200 行），逐行查会打 N 次库。
 */
export async function classNamesByIds(
  stage: TeachingStage,
  ids: Array<string | null | undefined>,
): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x && x !== ''))];
  if (!uniq.length) return {};
  const c = CLASS_TABLE[stage];
  const rows = (await tbl(c.conn, c.dbName, c.table, stage)
    .whereIn('id', uniq)
    .select('id', 'class_name')) as Array<Record<string, any>>;
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.id)] = String(r.class_name ?? '');
  return out;
}

/** 取多个学段的班级，打上学段标签 */
export async function listClassesOfStages(stages: TeachingStage[], user?: any): Promise<ClassOption[]> {
  const out: ClassOption[] = [];
  for (const s of stages) {
    /* ★ 班级下拉也要按数据范围过滤（班主任只看到自己带的班）。
       远端把 listClassesByStage 改成不带 user，这里统一在合并处过滤一次。 */
    const allow = user ? await visibleClassIds(s, user) : null;
    for (const c of await listClassesByStage(s)) {
      if (allow && !allow.includes(c.id)) continue;
      out.push({ stage: s, stageName: TEACHING_STAGE_NAME[s], id: c.id, name: c.name });
    }
  }
  return out;
}

/** 按 id 反查班级名（同一时刻只在给定学段里找） */
export async function classNameOf(stage: TeachingStage, classId: string): Promise<string> {
  const list = await listClassesByStage(stage);
  return list.find((c) => c.id === classId)?.name ?? '';
}
