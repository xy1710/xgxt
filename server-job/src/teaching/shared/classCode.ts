/**
 * 班级编号全局唯一校验（★ 2026-10-22 用户口径）
 * ============================================================
 *
 * 【为什么必须跨三个部门查】
 *   学号 = LZ + 班级编号 + 序号。如果初高有个班叫 Q17、大学也有个班叫 Q17，
 *   两个班各自都会生成 LZQ17001 —— 学号就重了。
 *   学号在系统里被当成「跨学段唯一标识」用（学生档案「全部」按学号去重、
 *   缴费记录按学号归集），重号会把两个人当成一个人、把缴费串到一起。
 *
 *   → 保存班级时把初高部 / 大学部 / 就业部（含实训）三张表一起查，
 *     编号被任何一张表占用都直接拦下。
 */

import { tbl, uniDb } from './uniTable';
import { db as jhDb } from '../../class-jh/utils/db';
import { db as classDb } from '../../class/db';
import { db as jobDb } from '../../utils/db';

export type ClassCodeStage = 'jh' | 'class' | 'job' | 'emp';

/** 三张班级表（实训与就业部共用 t_job_class，只查一次） */
const SOURCES: Array<{ stage: 'jh' | 'class' | 'emp'; conn: any; schema: string; table: string; label: string }> = [
  { stage: 'jh', conn: jhDb, schema: 'sms_class_jh', table: 't_class_info', label: '初高部的班级' },
  { stage: 'class', conn: classDb, schema: 'sms_class', table: 't_class_info', label: '大学部的班级' },
  { stage: 'emp', conn: jobDb, schema: 'sms_job', table: 't_job_class', label: '就业部/实训的班级' },
];

/**
 * 班级编号是否可用；被占用时抛错（错误文案带上占用方的部门，便于定位）
 *
 * @param exclude 编辑场景：传自己的学段 + id，跳过自己那条
 */
/**
 * 班级编号是否可用；被占用时抛错（错误文案带上占用方的部门，便于定位）
 *
 * @param exclude 编辑场景：传自己的学段 + id，跳过自己那条
 *
 * ★ 2026-10-22 修：实训(job) 与就业部(emp) 的行在 t_uni_class 里是两种 edu_stage，
 *   原来就业部来源按 edu_stage='emp' 查 → 实训班（edu_stage='job'）**永远查不到**，
 *   重复编号一路放行（用例实测：重号班级连建两个都 200）。
 *   → 就业部来源改为 edu_stage in ('job','emp') 一起查。
 */
export async function assertClassCodeAvailable(
  code: string,
  exclude?: { stage: ClassCodeStage; id?: string },
): Promise<void> {
  const val = String(code ?? '').trim();
  if (!val) return; // 空编号不参与唯一性（历史班级允许为空）

  for (const s of SOURCES) {
    /* ★ 就业部来源必须用 uniDb 直查：tbl(conn,'sms_job','t_job_class',stage) 会自动注入
       edu_stage=stage 的过滤 —— 'emp' 查不到 job 行、'job' 查不到 emp 行，
       怎么写都会漏一半（重号班级连建两个都放行，用例实测过）。
       就业部口径 = dept_code=3 的全部行（edu_stage job / emp 都算）。 */
    const q = s.stage === 'emp'
      ? uniDb('t_uni_class').whereIn('edu_stage', ['job', 'emp'])
      : tbl(s.conn, s.schema, s.table, s.stage);
    q.where({ class_code: val, is_deleted: false });
    // 实训 / 就业部同一张表：只要学段命中其中之一就不排除自己
    const sameTable =
      exclude && exclude.id && (s.stage === exclude.stage || (s.stage === 'emp' && (exclude.stage === 'job' || exclude.stage === 'emp')));
    if (sameTable) q.andWhereNot('id', exclude!.id);
    const hit = (await q.first()) as Record<string, any> | undefined;
    if (hit) {
      throw new Error(`班级编号「${val}」已被${s.label}占用，请换一个（学号按「LZ+班级编号+序号」生成，重号会导致学号重复）`);
    }
  }
}
