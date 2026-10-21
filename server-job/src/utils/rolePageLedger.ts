/**
 * 角色 → 页面 台账（**运行时**判定层）
 *
 * ============================================================
 * 【它在权限体系里的位置】
 *   系统里「谁能看到哪个页面」一共三层，逐层收口：
 *     ① 板块有没有这个页面   → sms_perm.t_perm_page（页面管理 · 板块模式）
 *     ② 这个角色能不能看     → sms_perm.t_perm_role_page（页面管理 · 角色模式）★ 本文件
 *     ③ 这个角色有没有权限点 → t_perm_role_perm / pagePermissionSource.ts
 *   任一层关掉都不可见。
 *
 * 【默认口径 —— 这是本文件最重要的一条】
 *   **台账里有行 → 以台账为准；没行 → 什么都不做（沿用现行默认）。**
 *     · denied 里的 pagePath  → 该角色看不到（即使他本来有权限点）
 *     · allowed 里的 pagePath → 该角色看得到（即使他本来没有权限点 → 增量授权）
 *     · 既不在 allowed 也不在 denied → 不干预，交给第 ③ 层
 *   所以「一个角色一行都没有」= 完全保持改造前的行为，**对存量账号零影响**。
 *
 * ⚠️ 为什么用 `moduleKey||pagePath` 而不是 pagePath：
 *     /class（实训班级）与 /class/roster（大学部花名册）前缀相近但属不同板块；
 *     带上 moduleKey 让键与「页面管理」台账、与 t_perm_page 的口径完全一致。
 *
 * ⚠️ 缓存 15 秒 + 保存时主动清（perm 侧改完立刻生效）：
 *    本文件在 legacy 四个板块的**每个请求**上都会被 requirePage 调用，
 *    不缓存的话每个请求多一次 DB 查询。
 * ============================================================
 */

import { db } from '../perm/utils/db';
import { PAGE_REGISTRY, ALL_REGISTRY_PATHS, pageCodesOf } from '../perm/config/pageRegistry';

/** 一个角色的台账覆盖情况 */
export interface RolePageOverride {
  /** 该角色在台账里有没有行（界面上的「已配置 / 沿用默认」） */
  configured: boolean;
  /** 台账里 enabled=1 的 `moduleKey||pagePath` */
  allowed: Set<string>;
  /** 台账里 enabled=0 的 `moduleKey||pagePath` */
  denied: Set<string>;
}

const EMPTY_OVERRIDE: RolePageOverride = {
  configured: false,
  allowed: new Set(),
  denied: new Set(),
};

/** 台账键 */
export function rolePageKey(moduleKey: string, pagePath: string): string {
  return `${moduleKey}||${pagePath}`;
}

/* ============================================================
 * 1. 路径 ↔ 页面权限码（legacy 四个板块用）
 *
 * ⚠️ 只有 legacy 板块的页面有 pageCode；consult / finance / perm 的页面
 *    没有权限码（它们的可见性由 menuKey / 门户身份决定），所以这里查不到，
 *    `codeOfPath()` 返回 undefined —— 调用方遇到 undefined 直接跳过即可。
 * ============================================================ */

const CODES_BY_PATH = new Map<string, string[]>();

for (const board of PAGE_REGISTRY) {
  for (const p of board.pages) {
    const codes = pageCodesOf(p);
    if (codes.length) CODES_BY_PATH.set(p.path, codes);
  }
}

/**
 * 页面 path → 该页面的**全部**权限码（没有则空数组）
 *
 * ★ 2026-10-20 合并板块：一个 path 现在可能挂多个学段码
 *   （/teaching/attendance → classjh / class / job 三个）。
 *   台账按 path 开关，落到权限码上必须**整组一起**增删，
 *   否则会出现「页面关了但某个学段的码还在，换个角色又能进」的漏网。
 */
export function codesOfPath(pagePath: string): string[] {
  return CODES_BY_PATH.get(pagePath) || [];
}

/** 页面 path → 该页面的权限码（取第一个；没有则 undefined，仅供需要单值的旧调用点使用） */
export function codeOfPath(pagePath: string): string | undefined {
  return codesOfPath(pagePath)[0];
}

/** 全部登记过的页面 path（= 台账管辖范围，前端菜单过滤用） */
export const LEDGER_ALL_PATHS: string[] = ALL_REGISTRY_PATHS;

/* ============================================================
 * 2. 读取（带 15 秒内存缓存）
 * ============================================================ */

const CACHE_TTL_MS = 15_000;

let cache: { at: number; map: Map<string, RolePageOverride> } | null = null;

/** 清缓存（权限管理保存角色页面后调用，让判定立刻生效） */
export function clearRolePageCache(): void {
  cache = null;
}

/**
 * 读全部「角色 → 页面」台账，按 **role_code** 聚合。
 *
 * ⚠️ 用 role_code 而不是 role_id 作 key：
 *    运行时的 `req.user.roles` 是一串 role_code（如 ['TEACH_HEAD']），
 *    role_id 是权限库内部主键，两者靠 t_perm_role 关联。
 */
export async function loadRolePageOverrides(force = false): Promise<Map<string, RolePageOverride>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;

  const map = new Map<string, RolePageOverride>();
  try {
    const rows = await db('t_perm_role_page as rp')
      .leftJoin('t_perm_role as r', 'r.id', 'rp.role_id')
      .where('rp.is_deleted', false)
      .select(
        'r.role_code as roleCode',
        'rp.module_key as moduleKey',
        'rp.page_path as pagePath',
        'rp.enabled as enabled',
      );

    for (const row of rows as any[]) {
      const code = String(row.roleCode || '');
      if (!code) continue;
      let ov = map.get(code);
      if (!ov) {
        ov = { configured: true, allowed: new Set(), denied: new Set() };
        map.set(code, ov);
      }
      const key = rolePageKey(String(row.moduleKey), String(row.pagePath));
      if (row.enabled) ov.allowed.add(key);
      else ov.denied.add(key);
    }
  } catch {
    /**
     * ⚠️ 查库失败必须【当作没有台账】放行，而不是当作「全部禁止」。
     *    这是本文件最关键的降级原则：权限表抖一下不能让全站页面消失。
     *    （与 store/pageConfig.ts 的「拉不到台账 = 不做任何过滤」同一口径）
     */
    cache = { at: Date.now(), map: new Map() };
    return cache.map;
  }

  cache = { at: Date.now(), map };
  return map;
}

/** 取单个角色的台账覆盖 */
export async function getRolePageOverride(roleCode: string): Promise<RolePageOverride> {
  const map = await loadRolePageOverrides();
  return map.get(roleCode) || EMPTY_OVERRIDE;
}

/* ============================================================
 * 3. 应用到「页面权限码」（legacy 四板块）
 * ============================================================ */

/**
 * 把某个角色的台账应用到它的页面权限码上。
 *
 *   对 legacy 四板块（job / edu / class / class-jh）：
 *     · 被 denied 的页面 → 移除它的权限码
 *     · 被 allowed 的页面 → 补上它的权限码（增量授权）
 *   consult / finance / perm 的页面没有权限码，这里天然跳过
 *   （它们的可见性由页面 path 层直接过滤，见 loadMyVisiblePaths）。
 *
 * @param roleCode 角色编码
 * @param codes    该角色原本的页面权限码（来自 pagePermissionSource）
 */
export async function applyLedgerToCodes(roleCode: string, codes: string[]): Promise<string[]> {
  const ov = await getRolePageOverride(roleCode);
  if (!ov.configured) return codes;

  const set = new Set(codes);
  let touched = false;

  for (const key of ov.denied) {
    const path = key.split('||')[1];
    for (const code of codesOfPath(path)) {
      if (set.delete(code)) touched = true;
    }
  }
  for (const key of ov.allowed) {
    const path = key.split('||')[1];
    for (const code of codesOfPath(path)) {
      if (!set.has(code)) {
        set.add(code);
        touched = true;
      }
    }
  }

  return touched ? Array.from(set) : codes;
}

/** 批量版本（用户可能身兼多角色，逐个角色算再取并集） */
export async function applyLedgerToCodesForRoles(
  roleCodes: string[],
  codesOf: (roleCode: string) => string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const role of roleCodes) {
    const codes = await applyLedgerToCodes(role, codesOf(role) || []);
    codes.forEach((c) => out.add(c));
  }
  return Array.from(out);
}

/* ============================================================
 * 4. 应用到「页面 path 列表」（全部板块）
 * ============================================================
 *   ⚠️ 这一节【不在本文件】——「对某个角色来说，最终可见的 path 有哪些」
 *      需要同时用到「台账」（本文件）与「默认推导」（rolePageDefaults.ts），
 *      为了不让两个文件互相 import 成环，统一放在 `rolePageEffective.ts`。
 *      本文件只负责「读台账」与「按码增删」两件最基础的事。
 * ============================================================ */
