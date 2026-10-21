/**
 * 角色 → 页面 的【默认可见集合】推导（单一事实来源）
 *
 * ============================================================
 * 【这个文件回答一个问题】
 *   「在管理员还没在『页面管理 → 角色模式』里动过手之前，
 *     某个角色本来能看到哪些页面？」
 *
 * 【为什么必须与运行时口径完全一致】
 *   界面上勾选框的初始状态 = 这里推导出来的默认值。
 *   如果推导错了，界面就会「打着勾但实际看不到」或者反过来 ——
 *   管理员据此改出来的配置一定是错的。
 *   所以这里刻意复用**运行时真正在用的那三处权威源**，不另立一套：
 *     · legacy 四板块（job/edu/class/class-jh）
 *         → `pagePermissionSource.ts` 的 ROLE_PAGE_PERMISSIONS
 *     · 市场咨询（consult）
 *         → `shared-types/consult/perm-link.ts`
 *           的 MARKET_/APPROVE_PERM_ITEM_TO_MENU + CONSULT_ALWAYS_MENUS
 *     · 财务管理（finance）
 *         → `shared-types/finance/perm-link.ts`
 *           的 FIN_PERM_ITEM_TO_MENU + FINANCE_ALWAYS_MENUS
 *     · 权限管理（perm）
 *         → **默认不限制**（全开）。理由见文件尾「perm 板块为什么全开」。
 *
 * 【怎么算】
 *   角色在权限库里的「功能点」是 (module_key, item_name) 的集合，
 *   本文件按 role_id → t_perm_role_perm 一次性取全量，
 *   再复用「功能点 → menuKey」的换算法，得到该角色在各板块的可见页面。
 * ============================================================
 */

import { PAGE_REGISTRY, pageCodesOf } from '../perm/config/pageRegistry';
import { consultMenusFromPerm, financeMenusFromPerm } from 'shared-types/consult';
import { getRolePagePermissions } from './pagePermissionSource';
import { extraPageCodesFromModuleItems, isBuiltinRoleCode } from './permPointToPages';
import {
  loadRoleModuleItems,
  clearRoleModuleItemsCache,
  type ModuleItemsByRole,
} from './roleModuleItems';

export type { ModuleItemsByRole };

/** `moduleKey||pagePath` 形式的可见集合 */
export type RolePagePathSet = Set<string>;

const CACHE_TTL_MS = 15_000;

let defaultCache: { at: number; map: Map<string, RolePagePathSet> } | null = null;

/** 清缓存（角色权限或角色页面改完后调用） */
export function clearRoleDefaultCache(): void {
  // 功能点数据已下沉到 roleModuleItems.ts，一并清掉
  clearRoleModuleItemsCache();
  defaultCache = null;
}

/* ============================================================
 * 1. 角色的「功能点」清单
 *    ★ 2026-10-08：实现已下沉到 utils/roleModuleItems.ts
 *      （原因见该文件头：消除与 pagePermissionSource 的循环依赖）
 * ============================================================ */

/**
 * 某个角色在【全部 7 个板块】下的默认可见页面。
 *
 * @param roleCode   角色编码（如 TEACH_HEAD）
 * @param legacyCodes 该角色的页面权限码（pagePermissionSource 的既有口径）
 * @param moduleItems 该角色的功能点清单（权限库 module_key → 功能点名）
 */
export function deriveDefaultPathsFor(
  roleCode: string,
  legacyCodes: string[],
  moduleItems: Record<string, string[]> | undefined,
): RolePagePathSet {
  const out: RolePagePathSet = new Set();

  const hasItem = (mod: string): boolean => (moduleItems?.[mod]?.length ?? 0) > 0;

  /* ---- ① 市场咨询：market + approve 两个权限库模块一起换算 ----
   *
   * ⚠️ 这里比`consultMenusFromPerm` 多了一道前置判断：**该角色在 market /
   *    approve 两个模块里至少要有 1 个功能点**，才认它属于咨询板块。
   *
   * 【为什么要加这道判断】
   *    `consultMenusFromPerm` 里有个 `CONSULT_ALWAYS_MENUS = ['student']`
   *    ——「学生管理」是咨询模块的首页，一旦账号被授权 consult 模块就必然可见。
   *    于是直接套用它的话，**14 个角色里每一个**都会在咨询板块下冒出
   *    「学生管理 1/5」，连班主任、教员、项目经理都有 ——
   *    在角色配置界面上这纯属噪音，会让人以为「班主任也归市场咨询管」。
   *    加这道判断后：只有真正在咨询/审批功能点上有授权的角色才出现在这里，
   *    与「谁在咨询板块里干活」这个业务事实一致。
   *
   *    对运行时的可见性没有影响 —— 因为「页面管理 → 角色模式」是**叠加层**，
   *    没被配置过的角色依旧按原口径走，这里只决定界面初始勾选与板块归属。
   */
  const consultMenus = new Set(
    hasItem('market') || hasItem('approve')
      ? consultMenusFromPerm({ found: true, moduleItems } as any)
      : [],
  );

  /* ---- ② 财务管理：同理，必须先有 fin 模块的功能点 ---- */
  const financeMenus = new Set(
    hasItem('fin') ? financeMenusFromPerm({ found: true, moduleItems } as any) : [],
  );

  const legacySet = new Set(legacyCodes);

  /**
   * ★★ 2026-10-08：自建角色打通层（方案 B）
   *
   * 【为什么】
   *   `legacyCodes` 来自 `getRolePagePermissions(roleCode)` → 代码静态表
   *   `ROLE_PAGE_PERMISSIONS`。它是按**14 个内置角色码**登记的，
   *   运行时新建的角色（如 `XMJL_000`「项目经理2」）在里面查不到 →
   *   legacy 四板块推导出 0 页 → 现象：「权限管理里勾满了，页面还是进不去」。
   *
   * 【怎么补】
   *   权限库的功能点 `(module_key, item_name)` 本身**是**一份权威授权记录
   *   —— 管理员就是在界面上按它勾的。把它按 `permPointToPages.ts` 的
   *   显式映射换算成 legacy 页面码，**并入**默认集即可。
   *
   * 【★★ 关键约束：只在「静态表查不到该角色」时才启用】
   *   与 `pagePermissionSource.getUserPagePermissions()` 保持**完全一致**的口径。
   *   实测（2026-10-08）证明：若对所有角色都并入，会**误伤内置角色** ——
   *   教务会凭空多出 `job:class:view`（业务明确「教务不看就业管理」），
   *   班主任/学管也会多出 `class:exam:view` 等**刻意不给**的页。
   *   因为权限库功能点是**模块粗粒度**授权，不等于页面级口径；
   *   内置 14 角色的页面口径是逐页校准过的，不能被覆盖。
   *
   *   所以：`legacyCodes.length > 0` → 内置角色 → 不启用（零回归）
   *         `legacyCodes.length === 0` → 自建角色 → 用功能点推导
   *
   *   ⚠️ 还要叠加 `!isBuiltinRoleCode` 判断 ——
   *      `MKT_MANAGER` 虽在 RoleCode 枚举里，但静态表从没给它配过 legacy 页，
   *      只靠 `length === 0` 会把它误判成自建角色。
   *
   * 【与运行时的一致性】
   *   本文件（配置界面初始勾选）与运行时真闸必须同口径，
   *   否则会出现「界面打着勾、实际进不去」——这正是本文件头强调的原则。
   */
  if (!isBuiltinRoleCode(roleCode) && legacyCodes.length === 0) {
    extraPageCodesFromModuleItems(moduleItems).forEach((c) => legacySet.add(c));
  }

  for (const board of PAGE_REGISTRY) {
    for (const p of board.pages) {
      let visible = false;
      switch (board.moduleKey) {
        case 'workbench':
          /**
           * ★ 2026-10-20 新增：工作台 = 全站首页，**每个角色都默认可见**。
           *
           * 【为什么必须显式写这一条】
           *   工作台没有页面权限码（它不靠 pageCode 判可见，谁登录谁就能看），
           *   如果不特殊处理就会掉进 default 分支 →
           *   `pageCodesOf(p)` 为空 → 推导成 false →
           *   职位模式界面显示「工作台 0/1」，看着像这个职位连首页都被禁了。
           *   而它其实 locked（不可取消），保存时会被强制保留，
           *   于是界面显示与真实权限**对不上**。这里显式给 true 抹平。
           */
          visible = true;
          break;
        case 'consult':
          visible = consultMenus.has(p.key);
          break;
        case 'finance':
          visible = financeMenus.has(p.key);
          break;
        case 'perm':
          /**
           * ⚠️ perm 板块默认【只给系统管理员与校长】。
           *
           * 【口径依据】
           *   权限管理模块的页面可见性本来是按**门户身份**判的
           *   （见 shared-types/src/perm/perm-auth.ts 的 permMenusOf：
           *    「系统管理员 / 被授权 perm 模块的负责人 / 服务身份 → 全 7 页」），
           *    业务角色并不参与。所以角色级台账在这里没有唯一的「天然默认值」，
           *    只能在两种合理取值里选一个：
           *      a) 全开  → 界面上「14 个角色全都 7/7」，看起来像谁都能进权限管理；
           *      b) 只给最强的两个角色 → 与系统实际相符（本系统里真正持有 perm
           *         模块、能进权限管理板块的账号，角色就是 SYS_ADMIN 与 RM_PRINCIPAL）。
           *    取 (b)：更贴近事实，界面上也不至于满屏都是「7/7」。
           *
           *    ⚠️ 其他角色如需进权限管理，在这里勾选即可（勾上就是显式授权）。
           */
          visible = roleCode === 'SYS_ADMIN' || roleCode === 'RM_PRINCIPAL';
          break;
        default:
          /* ③ legacy 板块：看该角色的页面权限码里有没有这一页
           *
           * ★ 2026-10-20 合并板块改口径：一页现在可能挂多个学段码
           *   （如 /teaching/attendance 同时挂 classjh / class / job 三个码）。
           *   旧写法 `legacySet.has(p.pageCode)` 只认第一个码 →
           *   「大学部班主任有 class:attendance:view」也会被判成不可见，
           *   于是配置界面把默认勾选漏掉、管理员得手工补勾，改完还对不上。
           *   现口径 = **任一码命中即可见**，与前端 STAGE_ACCESS 的
           *   anyStageAccessible 完全一致。
           */
          visible = pageCodesOf(p).some((c) => legacySet.has(c));
          break;
      }
      if (visible) out.add(`${board.moduleKey}||${p.path}`);
    }
  }

  return out;
}

/** 单个角色的默认可见集合（带缓存） */
export async function deriveDefaultPaths(roleCode: string): Promise<RolePagePathSet> {
  if (defaultCache && Date.now() - defaultCache.at < CACHE_TTL_MS) {
    const hit = defaultCache.map.get(roleCode);
    if (hit) return hit;
  }

  const [items, legacyCodes] = await Promise.all([
    loadRoleModuleItems(),
    getRolePagePermissions(roleCode),
  ]);
  const set = deriveDefaultPathsFor(roleCode, legacyCodes, items.get(roleCode));

  const map = defaultCache?.map || new Map<string, RolePagePathSet>();
  map.set(roleCode, set);
  defaultCache = { at: Date.now(), map };
  return set;
}

/** 批量：一次性把多个角色的默认集合都算出来（配置界面用，避免 N 次查询） */
export async function deriveDefaultPathsBatch(
  roleCodes: string[],
): Promise<Map<string, RolePagePathSet>> {
  const items = await loadRoleModuleItems();
  const out = new Map<string, RolePagePathSet>();
  for (const code of roleCodes) {
    const legacyCodes = await getRolePagePermissions(code);
    out.set(code, deriveDefaultPathsFor(code, legacyCodes, items.get(code)));
  }
  return out;
}

/**
 * ★ 2026-10-08：取某个角色的「权限库功能点」清单（供运行时判定复用）
 *
 * 用途：`pagePermissionSource.getUserPagePermissions()` 需要在
 *       legacy 静态码之外，**再并入**功能点映射出的页面码，
 *       让自建角色（如 XMJL_000）在运行时也能拿到页面。
 *
 * ⚠️ 这里再导出一次只是为了**保持既有 import 路径不变**；
 *    实现在 roleModuleItems.ts（原因见该文件头：避免循环依赖）。
 */
export { getRoleModuleItems } from './roleModuleItems';

