/**
 * 门户 / 各模块 登录态汇总（合并版）
 *
 * ⚠️ 2026-10-05 深度单体合并后，登录态有「两层」：
 *   ① 门户层（portal store）：账号、可见模块（visibleModules）
 *      —— 决定「能看到哪几个模块的菜单」。
 *   ② 各模块自己的 store（consult / finance / perm / job）：
 *      —— 各模块页面内部要用（角色判断、按钮显隐、页面内 menuKeys）。
 *
 * 合并前每个模块是独立前端，各自的路由守卫会调自己的 loadProfile()。
 * 现在只有一个路由入口，所以由这里统一编排：按「门户可见模块」按需加载，
 * 不加载没权限的模块（否则会打出 401/403，触发错误提示甚至被踢回登录页）。
 */

import { ref } from 'vue';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';
import { useAuthStore as useConsultStore } from '@/consult/stores/auth';
import { useAuthStore as useFinanceStore } from '@/finance/stores/auth';
import { useUserStore as usePermStore } from '@/perm/stores/user';
import { resetPermissions } from '@/store/permission';

/** 各模块 store 是否已按需加载完成 */
export const moduleStoresReady = ref(false);

function moduleKeys(): Set<string> {
  const portal = usePortalStore();
  return new Set((portal.visibleModules || []).map((m) => String(m.key)));
}

/** 拉门户身份（账号 + 可见模块）。失败不抛出，由上层决定如何降级。 */
export async function ensurePortalProfile(): Promise<void> {
  const portal = usePortalStore();
  if (portal.account) return;
  try {
    await portal.loadProfile();
  } catch {
    /* 无门户身份：可能是 job/edu/class 的账号（按后端角色解析），不阻断 */
  }
}

/**
 * 按门户可见模块，按需加载对应模块的 store。
 * 只加载「有权限的模块」，避免对无权限模块发请求而触发 401/403 跳登录。
 */
export async function ensureModuleStores(): Promise<void> {
  if (moduleStoresReady.value) return;
  const keys = moduleKeys();

  if (keys.has('consult')) {
    const s = useConsultStore();
    if (!s.account) {
      try { await s.loadProfile(); } catch { /* 失败保持未加载 */ }
    }
  }
  if (keys.has('finance')) {
    const s = useFinanceStore();
    if (!s.profile) {
      try { await s.loadProfile(); } catch { /* 失败保持未加载 */ }
    }
  }
  if (keys.has('perm')) {
    const s = usePermStore();
    if (!s.profile) {
      try { await s.fetchProfile(); } catch { /* 失败保持未加载 */ }
    }
  }
  moduleStoresReady.value = true;
}

/** 当前账号能否访问某模块（按门户下发的 visibleModules） */
export function moduleAllowed(moduleKey: string): boolean {
  return moduleKeys().has(moduleKey);
}

/**
 * ★ 页面权限码 → 所属门户模块（单一来源）
 *
 * 【为什么需要】
 *   legacy 四个模块（就业/教务/大学部班级/初高教学）的页面清单不在门户注册表里，
 *   而是「角色 → 页面权限」（后端 config/pagePermissions.ts）在运行时算出来的。
 *   于是出现一个夹缝：**在权限库里挂了高权限角色、但门户只授权了别的模块**的账号，
 *   照样能拿到这些页面码 → 菜单多出整组板块、直连 URL 也能进。
 *
 *   典型反例（2026-10-06 用户报障）：权限管理员 `linx` 门户 modules=['perm']，
 *   但在 sms_perm 里挂的是「系统管理员」角色 → my-pages 下发全部 40 个页面
 *   → 左侧冒出「就业管理 / 教务管理 / 班级管理 / 教学管理（初高）」四组菜单。
 *
 * 【口径】门户 modules 是【模块级】权威；角色页面权限是【模块内】细粒度。
 *   两者必须叠加：先过模块门槛，再看页面权限。
 *
 * 返回 '' = 该页面码不属于任何门户模块（不参与模块门槛）。
 */
export function moduleOfPageCode(pageCode?: string): string {
  if (!pageCode) return '';
  if (pageCode.startsWith('classjh:')) return 'class-jh';
  if (pageCode.startsWith('class:')) return 'class';
  if (pageCode.startsWith('job:')) return 'job';
  if (pageCode.startsWith('edu:')) return 'edu';
  return '';
}

/**
 * ★ 2026-10-19：**跨模块共用**的页面码
 *
 * 待接收学员（`class:consult:view`）改成「初高中 + 大学」共用：
 *   初高班主任也要接收咨询推来的学员，而他的门户 modules 只有 `class-jh`，
 *   按 `class:` 前缀判定会被模块门槛挡在门外（菜单不显示 + 直连 URL 被踢走）。
 *
 * ⚠️ 只登记**确实两段共用**的页面；别把整组 class:* 都放开 ——
 *    那等于给初高账号开了大学部班级管理的后门。
 */
const SHARED_PAGE_MODULES: Record<string, string[]> = {
  'class:consult:view': ['class', 'class-jh'],
};

/**
 * 页面级「模块门槛」判定（菜单 + 路由守卫统一用这个）
 *
 * 普通页面 = 按前缀映射到唯一模块；共用页面 = 命中其中任一模块即放行。
 */
export function pageModuleAllowed(pageCode?: string): boolean {
  if (!pageCode) return true;
  const shared = SHARED_PAGE_MODULES[pageCode];
  if (shared) return shared.some((m) => moduleAllowed(m));
  const m = moduleOfPageCode(pageCode);
  return !m || moduleAllowed(m);
}

/** 当前账号能否访问某模块的某页面（menuKey 为空则不校验页面级） */
export function menuAllowed(moduleKey: string, menuKey?: string): boolean {
  const portal = usePortalStore();
  const m = (portal.visibleModules || []).find((x) => String(x.key) === moduleKey);
  if (!m) return false;
  if (!menuKey) return true;
  return (m.menus || []).some((mi) => mi.key === menuKey);
}

/**
 * 门户建议落地路径（第一个**新**模块的第一页）；没有则返回空串
 *
 * ★ 2026-10-05 合并：跳过 legacy 模块（就业/教务/班级）。
 *   它们的路由不带模块前缀、页面清单由角色权限算，所以这里不能拼路径；
 *   返回空串后，路由守卫会兜底到 myPages 里的第一个页面（见 router/index.ts step 3）。
 */
export function portalLandingPath(): string {
  const portal = usePortalStore();
  const m = (portal.visibleModules || []).find((x) => !x.legacy);
  if (!m) return '';
  const first = (m.menus || [])[0];
  if (!first) return '';
  return `/${m.key}${first.path}`;
}

/** 退出登录：清门户 + 各模块的残留缓存 */
export function portalLogout(): void {
  try { usePortalStore().logout(); } catch { /* ignore */ }
  try { useConsultStore().logout(); } catch { /* ignore */ }
  try { useFinanceStore().logout(); } catch { /* ignore */ }
  try { usePermStore().reset(); } catch { /* ignore */ }
  // 就业/教务/班级的页面权限也一并重置，否则换账号登录会看到上一个账号的菜单
  try { resetPermissions(); } catch { /* ignore */ }
  moduleStoresReady.value = false;
  localStorage.removeItem('sms_token');
  localStorage.removeItem('portal_modules');
  localStorage.removeItem('sms_menu_keys');
  localStorage.removeItem('finance_profile');
  localStorage.removeItem('finance_menu_keys');
}
