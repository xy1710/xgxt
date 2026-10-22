/**
 * 教学域 · 角色数据范围（统一页共用）
 * ============================================================
 *
 * 【为什么需要它】
 *   教学页合并成 `/teaching/*` 之后，原来各老页面的 `applyStageScope()` 没跟过来
 *   → 只要账号有该学段的页面权限，就能看到**该学段全部班级**。
 *   实测症状：项目经理登录看到「就业」阶段的班（那是就业老师交棒后的数据）。
 *
 * 【口径（沿用 2026-10-04 拍板的「责任人交棒模型」）】
 *   同一个班（编号不变）随阶段换责任人：
 *     大学 1~6 阶段 → 班主任 / 教员 / 助教（三岗任一）
 *     实训阶段      → 项目经理（且班级未结业）
 *     转就业后      → 就业指导老师（employment_teacher）
 *
 *   · 项目经理   → 只看 project_manager = 我 且 未结业 的班（实训）
 *   · 就业老师   → 只看 employment_teacher = 我 的班（就业）
 *   · 班主任三人组 → 大学/初高只看自己带的班；实训/就业侧一个都看不到
 *   · 学管 / 校长 / 管理员 / 教务 → 不限（null）
 *
 * 【返回值约定】`null` = 不限；`[]` = 一个班都看不到（务必按「查不到」处理）
 */

import { BizCode, ClassStatus, RoleCode, hasRole } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { db as classDb } from '../../class/db';
import { db as classJhDb } from '../../class-jh/utils/db';
import { db as jobDb } from '../../utils/db';
import type { TeachingStage } from './dto';
import { tbl } from './uniTable';

type Side = 'training' | 'university' | 'all';

/** 角色属于哪一侧（与 utils/stageScope.ts 同口径） */
export function sideOfRoles(roles: string[] | undefined): Side {
  const r = roles || [];
  if (!r.length) return 'all';
  if (r.includes('SUPER_TEST')) return 'all';
  if (hasRole(r, RoleCode.PROJECT_MANAGER) || hasRole(r, RoleCode.JOB_STAFF)) return 'training';
  if (
    hasRole(r, RoleCode.TEACH_HEAD) ||
    hasRole(r, RoleCode.TEACH_TUTOR) ||
    hasRole(r, RoleCode.TEACH_ASSIST)
  ) {
    return 'university';
  }
  return 'all';
}

function isTeachingStaff(roles: string[]): boolean {
  return (
    hasRole(roles, RoleCode.TEACH_HEAD) ||
    hasRole(roles, RoleCode.TEACH_TUTOR) ||
    hasRole(roles, RoleCode.TEACH_ASSIST)
  );
}

/**
 * 当前账号在某学段可见的班级 ID
 * @returns null = 不限；[] = 无权（调用方应直接返回空结果）
 */
export async function visibleClassIds(
  stage: TeachingStage | 'emp',
  user: any,
): Promise<string[] | null> {
  const roles: string[] = user?.roles || [];
  const side = sideOfRoles(roles);
  if (side === 'all') return null;

  /* 责任人列历史上有两种写入口径：门户账号 UUID 与权限库 U_xxx —— 两个都比，避免一边比不中 */
  const ids = [
    ...new Set([user?.userId, user?.businessUserId].map((x) => String(x || '')).filter(Boolean)),
  ];
  if (!ids.length) return [];

  /* ★ 2026-10-21：就业部（emp）独立学段，按「就业老师」隔离
   *
   *   原来 emp 直接落到下面的「初高/大学」分支 →
   *     `if (side === 'training') return []` → 就业老师永远拿到空数组
   *     （任何叠了 applyClassScope 的就业部查询都会一行不剩）。
   *
   *   口径：就业部只有就业老师参与（项目经理管实训，不看就业部）；
   *        就业老师也只看「employment_teacher 是我」的班。
   */
  if (stage === 'emp') {
    if (!hasRole(roles, RoleCode.JOB_STAFF)) return [];
    try {
      const rows = (await tbl(jobDb, 'sms_job', 't_job_class', 'emp')
        .where('is_deleted', 0)
        .whereIn('employment_teacher_id', ids)
        .select('id')) as Array<{ id: string }>;
      return rows.map((r) => String(r.id));
    } catch {
      return [];
    }
  }

  if (stage === 'job') {
    // 班主任三人组 → 实训/就业侧一个都看不到（交棒后彻底隔离）
    if (side === 'university') return [];
    const isPM = hasRole(roles, RoleCode.PROJECT_MANAGER);
    const isJob = hasRole(roles, RoleCode.JOB_STAFF);
    if (!isPM && !isJob) return [];
    try {
      const rows = (await tbl(jobDb, 'sms_job', 't_job_class', 'job')
        .where('is_deleted', 0)
        .andWhere((q: any) => {
          if (isPM) {
            // 实训：我负责且未结业（结业 = 已交棒给就业老师）
            q.where((w: any) =>
              w.whereIn('project_manager_id', ids).andWhereNot('class_status', ClassStatus.GRADUATED),
            );
          }
          if (isJob) {
            // 就业：已结业（交棒）且 employment_teacher 是我
            q.orWhere((w: any) =>
              w.whereIn('employment_teacher_id', ids).andWhere('class_status', ClassStatus.GRADUATED),
            );
          }
        })
        .select('id')) as Array<{ id: string }>;
      return rows.map((r) => String(r.id));
    } catch {
      return [];
    }
  }

  // 初高 / 大学：只看自己带的班；实训侧角色（PM/就业）不看
  if (side === 'training') return [];
  if (!isTeachingStaff(roles)) return null;

  const conn = stage === 'jh' ? classJhDb : classDb;
  const dbName = stage === 'jh' ? 'sms_class_jh' : 'sms_class';
  try {
    const rows = (await tbl(conn, dbName, 't_class_info', stage)
      .where('is_deleted', 0)
      .andWhere((q: any) => {
        q.whereIn('head_teacher_id', ids)
          .orWhereIn('teacher_id', ids)
          .orWhereIn('assistant_id', ids);
      })
      .select('id')) as Array<{ id: string }>;
    return rows.map((r) => String(r.id));
  } catch {
    return [];
  }
}


/**
 * 给查询叠数据范围（repo 层一行接入）
 * @returns false = 该账号在这个学段没有任何班，调用方应直接返回空
 */
export async function applyClassScope(
  qb: any,
  column: string,
  stage: TeachingStage | 'emp',
  user: any,
): Promise<boolean> {
  const ids = await visibleClassIds(stage, user);
  if (ids === null) return true;
  if (!ids.length) return false;
  qb.whereIn(column, ids);
  return true;
}

/** 某个班是否在当前账号的数据范围内（写操作/详情用） */
export async function assertClassInScope(
  stage: TeachingStage | 'emp',
  classId: string | null | undefined,
  user: any,
  what = '该班级',
): Promise<void> {
  if (!classId) return;
  const ids = await visibleClassIds(stage, user);
  if (ids === null) return;
  if (!ids.includes(String(classId))) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, `没有${what}的访问权限`);
  }
}

/**
 * 一批学生是否都在当前账号的数据范围内（成绩批量保存用）
 *
 * 成绩保存体里只有 studentId、没有 classId，所以按学生反查所在班级再判定。
 */
export async function assertStudentsInScope(
  stage: TeachingStage | 'emp',
  studentIds: string[],
  user: any,
  what = '该班级',
): Promise<void> {
  const ids = await visibleClassIds(stage, user);
  if (ids === null) return;
  const uniq = [...new Set(studentIds.filter(Boolean))];
  if (!uniq.length) return;
  if (!ids.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, `没有${what}的访问权限`);

  const conn = stage === 'job' ? jobDb : stage === 'jh' ? classJhDb : classDb;
  const dbName = stage === 'job' ? 'sms_job' : stage === 'jh' ? 'sms_class_jh' : 'sms_class';
  const table = stage === 'job' ? 't_student_base' : 't_class_student';
  const rows = (await tbl(conn, dbName, table, stage)
    .whereIn('id', uniq)
    .select('class_id')) as Array<{ class_id: string }>;

  const allow = new Set(ids);
  /* 未分班（class_id 为空）的学生不隔离：还没有归属，谁都可能被分配给他 */
  if (rows.some((r) => r.class_id && !allow.has(String(r.class_id)))) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, `没有${what}的访问权限`);
  }
}

/** 多条班级是否都在范围内（跨班考试这类：要求全部命中，否则整条不可见） */
export async function assertClassesInScope(
  stage: TeachingStage | 'emp',
  classIds: Array<string | null | undefined>,
  user: any,
  what = '该班级',
): Promise<void> {
  const ids = await visibleClassIds(stage, user);
  if (ids === null) return;
  const uniq = [...new Set(classIds.filter(Boolean).map(String))];
  if (!uniq.length) return;
  const allow = new Set(ids);
  if (uniq.some((id) => !allow.has(id))) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, `没有${what}的访问权限`);
  }
}

/**
 * 同 applyClassScope，但**保留「班级为空」的历史单据**（不隔离）
 *
 * 【为什么】
 *   请假/退费单据在早期版本里允许不填班级（或由导入产生），这些行 class_id 为空，
 *   无法判定归属。一刀切 `whereIn(class_id, ids)` 会让它们从所有人视野里消失
 *   （包括本该看到它们的学管/校长）。
 *   → 口径：「有班级的严格按范围；没有班级的历史单据不隔离」。
 */
export async function applyClassScopeKeepNull(
  qb: any,
  column: string,
  stage: TeachingStage | 'emp',
  user: any,
): Promise<boolean> {
  const ids = await visibleClassIds(stage, user);
  if (ids === null) return true;
  if (!ids.length) {
    // 一个班都没有：只保留「无班级」的历史单据
    qb.whereNull(column);
    return true;
  }
  qb.andWhere((b: any) => b.whereIn(column, ids).orWhereNull(column));
  return true;
}
