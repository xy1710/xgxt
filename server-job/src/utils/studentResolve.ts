/**
 * 「手填姓名 → 尽量关联到学生」共用工具
 * ============================================================
 *
 * 【背景】
 *   原来是「必须从学生下拉里选」，日志/复盘靠 student_id 挂到学生身上，
 *   同时把 student_no / student_name / class_name **冗余快照**进业务表
 *   （留痕：学生毕业被删了，历史记录也还在）。
 *
 *   2026-10-16 起，就业日志 / 复盘填写的姓名都改成**可直接手填**
 *   → student_id 不再一定有值，于是需要一层「按姓名试着匹配」的逻辑。
 *
 * 【匹配规则（宁可不关联，也不要挂错人）】
 *   ① 明确传了 studentId 且学生存在      → 直接用（编辑回填 / 老数据走这条）
 *   ② 否则按姓名在 t_student_base **精确**查：
 *        · 唯一命中   → 关联
 *        · 0 条 / 多条 → 返回 null（重名不猜）
 *   返回 null 表示「只记姓名，不关联学生」，调用方把 student_id 存 NULL。
 */

import { db } from './db';
// ★ P8 后 t_student_base 老表已 DROP，必须走 tbl() 切读到 t_uni_student
import { tbl, uniDb } from '../teaching/shared/uniTable';

const STUDENT = 't_student_base';
const DB = 'sms_job';
const STAGE = 'job' as const;

/**
 * ★ 2026-10-21：实训(job) 与就业部(emp) 共用 t_uni_student，只查 job 的话
 *   就业部学员永远匹配不到（就业日志会退化成"只记姓名、不关联学生"）。
 *   这里统一按 edu_stage in ('job','emp') 查。
 */
function students() {
  return uniDb('t_uni_student').where({ is_deleted: false }).whereIn('edu_stage', ['job', 'emp']);
}

export async function resolveStudentByName(
  studentId?: string,
  studentName?: string,
): Promise<Record<string, any> | null> {
  if (studentId) {
    const byId = await students().where({ id: studentId }).first();
    if (byId) return byId;
  }
  const name = (studentName || '').trim();
  if (!name) return null;
  const hits = (await students().where({ student_name: name }).limit(2)) as Array<Record<string, any>>;
  return hits.length === 1 ? hits[0] : null;
}
