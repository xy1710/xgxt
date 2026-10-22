/**
 * 共享：学段级访问校验
 * ============================================================
 *
 * 【为什么必须共享，而不是每个域各写一遍】
 *   ① 这是**安全边界**：口径不一致 = 出现越权漏洞（初高老师查到实训数据）
 *   ② 每个域都要用，各写一遍就又变成新的重复 —— 我们正在消灭的那种
 *
 * 【判定的两道】
 *   ① 该学段所属门户模块有没有授权给这个账号（与全站 moduleOfPageCode 口径一致）
 *   ② 该域该学段的页面权限码在不在
 *
 * 用法（每个域只需给出自己三个学段的权限码）：
 *   const CODE = { jh: 'classjh:exam:view', class: 'class:exam:view', job: 'job:exam:view' };
 *   await assertStageCode(user, stage, CODE, '考试管理');
 */

import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { getUserPagePermissions } from '../../utils/pagePermissionSource';
import type { TeachingStage } from './dto';
import { TEACHING_STAGE_NAME, TEACHING_STAGES } from './dto';

/** 各学段所属门户模块（全站唯一口径） */
export const STAGE_MODULE: Record<TeachingStage, string> = {
  jh: 'class-jh',
  class: 'class',
  job: 'job',
};

/** 账号被授权的门户模块；空 = 无模块信息、不拦（与全站口径一致，避免把菜单整片打没） */

/**
 * 学段 → 权限码
 *
 * ★ 2026-10-15：支持**多码任一**（`string | string[]`）——
 *   同一个学段在不同角色下可能对应不同的权限码，例如「学生档案」的 job 学段：
 *     · 就业老师持有 `job:empArchive:view`（就业信息档案）
 *     · 项目经理持有 `job:classStudent:view`（实训-班级学生）
 *   两者业务上都能进这个页面，所以该学段要写成数组、任一命中即可。
 *   （单码写法保持不变，兼容既有各域。）
 */
export type StageCodeMap = Record<TeachingStage, string | string[]>;

/**
 * 校验账号对「某学段的某页面」有没有访问权
 * @param label 业务名（用于报错文案，如「考试管理」）
 */
export async function assertStageCode(
  user: any,
  stage: TeachingStage,
  codes: StageCodeMap,
  label: string,
): Promise<void> {
  return assertStageCodeEx(user, stage, codes, label, (s) => TEACHING_STAGE_NAME[s], (s) => STAGE_MODULE[s]);
}

/**
 * ★ 泛化版：学生档案域有 **4 个学段**（多的那个是「教务/edu」），
 *   而 `TeachingStage` 只有 3 个值。所以把「学段名」和「所属模块」也做成入参，
 *   别的域继续用上面的 `assertStageCode`（行为完全一致，只是默认值不同）。
 */
export async function assertStageCodeEx<S extends string>(
  user: any,
  stage: S,
  codes: Record<S, string | string[]>,
  label: string,
  nameOf: (s: S) => string,
  moduleOf: (s: S) => string,
): Promise<void> {
  if (!user) throw new BizError(BizCode.UNAUTHORIZED, '请先登录', 401);
  if (user.permissions?.includes('*')) return;
  const mods = user?.modules;
  if (Array.isArray(mods) && mods.length > 0 && !mods.includes(moduleOf(stage))) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `「${nameOf(stage)}」模块未授权给当前账号`,
    );
  }
  const allowed = await getUserPagePermissions(user.roles || []);
  /* ★ 2026-10-15：该学段可以配多个等价权限码，**任一命中**即放行 */
  const need = codes[stage];
  const needList = Array.isArray(need) ? need : [need];
  if (!needList.some((c) => allowed.includes(c))) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `没有「${nameOf(stage)}·${label}」的访问权限`,
    );
  }
}

/** 泛化版：当前账号可见的学段列表 */
export async function visibleStagesEx<S extends string>(
  user: any,
  stages: S[],
  codes: Record<S, string | string[]>,
  label: string,
  nameOf: (s: S) => string,
  moduleOf: (s: S) => string,
): Promise<S[]> {
  const out: S[] = [];
  for (const s of stages) {
    try {
      await assertStageCodeEx(user, s, codes, label, nameOf, moduleOf);
      out.push(s);
    } catch {
      /* 没权限 → 跳过 */
    }
  }
  return out;
}

/** 当前账号**可见**的学段列表（逐个试，没权限就跳过） */
export async function visibleStagesBy(
  user: any,
  codes: StageCodeMap,
  label: string,
): Promise<TeachingStage[]> {
  const out: TeachingStage[] = [];
  for (const s of TEACHING_STAGES) {
    try {
      await assertStageCode(user, s, codes, label);
      out.push(s);
    } catch {
      /* 没权限 → 跳过 */
    }
  }
  return out;
}
