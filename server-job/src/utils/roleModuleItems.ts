/**
 * 角色的「权限库功能点」读取（**最底层**，无反向依赖）
 *
 * ============================================================
 * 【为什么单独一个文件】
 *   `rolePageDefaults.ts` 与 `pagePermissionSource.ts` **都要**用这份数据：
 *     · rolePageDefaults   → 推导「默认可见页面」（配置界面初始勾选）
 *     · pagePermissionSource → 运行时真闸 getUserPagePermissions
 *   而 rolePageDefaults **已经** import 了 pagePermissionSource
 *   （要拿 getRolePagePermissions）—— 若反过来在 pagePermissionSource 里
 *   import rolePageDefaults，就会形成**循环依赖**，运行时 `getRoleModuleItems`
 *   会是 undefined（ESM/CJS 循环引用的经典坑）。
 *
 *   所以把这份「只读权限库、不依赖任何别的东西」的能力下沉到本文件，
 *   两个上层文件都从这里取 → 依赖变成单向，彻底消除环。
 *
 * 【数据来源】
 *   `sms_perm.t_perm_role` JOIN `t_perm_role_perm`，按 role_code 聚合出
 *   `{ module_key: [item_name, ...] }`。这正是管理员在「职位权限分配」
 *   界面上勾选的原始记录 —— 也是自建角色唯一的授权来源。
 *
 * ⚠️ 降级原则：查库失败 → 返回空 Map（当作「没有任何功能点」），
 *    绝不能让权限表抖一下就把所有人的页面清空。
 * ============================================================
 */

import { db } from '../perm/utils/db';

/** 角色编码 → 权限库 module_key → 功能点名数组 */
export type ModuleItemsByRole = Map<string, Record<string, string[]>>;

const CACHE_TTL_MS = 15_000;

let cache: { at: number; map: ModuleItemsByRole } | null = null;

/** 清缓存（角色权限变更后调用） */
export function clearRoleModuleItemsCache(): void {
  cache = null;
}

/**
 * 读全部角色的功能点清单（带 15 秒内存缓存）。
 *
 * @param force 强制刷新（忽略缓存）
 */
export async function loadRoleModuleItems(force = false): Promise<ModuleItemsByRole> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }

  const map: ModuleItemsByRole = new Map();
  try {
    const rows = await db('t_perm_role as r')
      .join('t_perm_role_perm as rp', 'rp.role_id', 'r.id')
      .where('r.is_deleted', false)
      .andWhere('rp.is_deleted', false)
      .select('r.role_code as roleCode', 'rp.module_key as moduleKey', 'rp.item_name as itemName');

    for (const row of rows as any[]) {
      const code = String(row.roleCode || '');
      const mod = String(row.moduleKey || '');
      const item = String(row.itemName || '');
      if (!code || !mod || !item) continue;

      let items = map.get(code);
      if (!items) {
        items = {};
        map.set(code, items);
      }
      (items[mod] ||= []).push(item);
    }
  } catch {
    // 查库失败 → 空 Map（退化成「没有功能点」），绝不抛错
    cache = { at: Date.now(), map: new Map() };
    return cache.map;
  }

  cache = { at: Date.now(), map };
  return map;
}

/** 取单个角色的功能点清单 */
export async function getRoleModuleItems(
  roleCode: string,
): Promise<Record<string, string[]> | undefined> {
  const map = await loadRoleModuleItems();
  return map.get(roleCode);
}
