/**
 * 角色 → 页面 的【最终可见集合】（默认被台账覆盖之后的结果）
 *
 * ============================================================
 * 【它在整个链路里的位置】
 *   rolePageDefaults.ts  → 算出「默认能看到什么」（代码里的既有口径）
 *   rolePageLedger.ts    → 读出「管理员改成了什么」（t_perm_role_page）
 *   本文件               → 合成两者，回答**唯一一个对外的问题**：
 *                          「这个用户（这些角色）到底能看哪些页面？」
 *
 * 【合成公式】
 *   某个角色最终可见 = （默认 ∪ 台账里打勾的） − 台账里去勾的
 *
 *   为什么是「默认 ∪ 打勾」而不是「只有打勾」：
 *     台账是**增量覆盖**而不是全量快照 —— 一个没被管理员碰过的页面
 *     （比如以后新加的页面）在台账里没有行，这时应当沿用默认，
 *     而不是因为「没打勾」就把它藏起来。
 *
 * 【多角色口径：并集】
 *   用户身兼多角色时，任一角色可见即可见（与「职位权限分配」一致）。
 *   A 角色禁用 /x、B 角色允许 /x → 用户能看到 /x；两个角色都禁用才不可见。
 *
 * ⚠️ 降级原则：查不到台账 → 返回 null，调用方【不做任何过滤】。
 *    权限表抖一下绝不能让全站页面消失。
 * ============================================================
 */

import { loadRolePageOverrides, LEDGER_ALL_PATHS } from './rolePageLedger';
import { deriveDefaultPaths } from './rolePageDefaults';
import { PAGE_REGISTRY } from '../perm/config/pageRegistry';

/** 全部登记页面 path 的集合（用于把脏数据挡在外面） */
const VALID_PATHS = new Set<string>(LEDGER_ALL_PATHS);

/** `moduleKey||pagePath` 键 */
function key(moduleKey: string, pagePath: string): string {
  return `${moduleKey}||${pagePath}`;
}

/** 由一个 `板块key||path` 键取出纯 path */
function pathOf(k: string): string {
  const i = k.indexOf('||');
  return i < 0 ? k : k.slice(i + 2);
}

/* ============================================================
 * 1. 单个角色
 * ============================================================ */

/**
 * 某个角色最终可见的页面（`moduleKey||pagePath` 集合）
 *
 * @param roleCode 角色编码
 */
export async function effectiveKeysOfRole(roleCode: string): Promise<Set<string>> {
  const [defaults, overrides] = await Promise.all([
    deriveDefaultPaths(roleCode),
    loadRolePageOverrides(),
  ]);

  const out = new Set<string>(defaults);
  const ov = overrides.get(roleCode);
  if (ov?.configured) {
    ov.allowed.forEach((k) => out.add(k));
    ov.denied.forEach((k) => out.delete(k));
  }
  return out;
}

/* ============================================================
 * 2. 一个用户（可能身兼多角色）
 * ============================================================ */

/**
 * 这批角色最终可见的页面 **path** 集合
 *
 * @returns
 *   · `null`  —— 这些角色**一个都没被配置过**：调用方应当不做任何过滤
 *                （保持改造前的行为，对存量账号零影响）
 *   · `Set`   —— 已经有人配置过：以这个集合为准（白名单）
 */
export async function effectivePathsForRoles(
  roleCodes: string[],
): Promise<Set<string> | null> {
  if (!roleCodes?.length) return null;

  const overrides = await loadRolePageOverrides();
  const anyConfigured = roleCodes.some((c) => overrides.get(c)?.configured);
  if (!anyConfigured) return null;

  const out = new Set<string>();
  for (const code of roleCodes) {
    const keys = await effectiveKeysOfRole(code);
    keys.forEach((k) => {
      const p = pathOf(k);
      if (VALID_PATHS.has(p)) out.add(p);
    });
  }
  return out;
}

/* ============================================================
 * 3. 配置界面用：一次算完所有角色（避免逐个角色查库）
 * ============================================================ */

/**
 * 批量算「每个角色最终可见的 pagePath 集合」
 *
 * @param roles   角色列表（需要 id / roleCode）
 * @param rows    台账全部行（调用方已经查过一次，避免重复 IO）
 */
export function effectivePathsByRoleId(
  roles: Array<{ id: string; roleCode: string }>,
  rows: Array<{ roleId: string; moduleKey: string; pagePath: string; enabled: boolean }>,
  defaults: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const byRole = new Map<string, Array<{ key: string; enabled: boolean }>>();
  for (const r of rows) {
    if (!byRole.has(r.roleId)) byRole.set(r.roleId, []);
    byRole.get(r.roleId)!.push({ key: key(r.moduleKey, r.pagePath), enabled: !!r.enabled });
  }

  const out = new Map<string, Set<string>>();
  for (const role of roles) {
    const set = new Set<string>(defaults.get(role.roleCode) || []);
    for (const row of byRole.get(role.id) || []) {
      if (row.enabled) set.add(row.key);
      else set.delete(row.key);
    }
    out.set(role.id, set);
  }
  return out;
}

/** 导出给调用方构造键用（与 pageRegistry 的页面一一对应） */
export { key as rolePageKeyOf, pathOf as pagePathOf };

/** 板块 → 页面总数（配置界面统计用） */
export const BOARD_TOTALS: Record<string, number> = Object.fromEntries(
  PAGE_REGISTRY.map((b) => [b.moduleKey, b.pages.length]),
);
