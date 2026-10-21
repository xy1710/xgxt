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

const STUDENT = 't_student_base';

export async function resolveStudentByName(
  studentId?: string,
  studentName?: string,
): Promise<Record<string, any> | null> {
  if (studentId) {
    const byId = await db(STUDENT).where({ id: studentId, is_deleted: false }).first();
    if (byId) return byId;
  }
  const name = (studentName || '').trim();
  if (!name) return null;
  const hits = await db(STUDENT).where({ student_name: name, is_deleted: false }).limit(2);
  return hits.length === 1 ? hits[0] : null;
}
