/**
 * 侧栏菜单的统一计算（★ 2026-10-16 从 App.vue 抽出）
 * ============================================================
 *
 * 【为什么抽出来】
 *   「工作台 = 系统首页」上线后，首页的「快捷入口」要和左侧菜单用
 *   **同一套显隐口径**（门户模块分组 + legacy 页面权限 + 合并域权限码 +
 *   页面台账），否则两处各算各的，很快就会口径漂移。
 *   抽到这里后：App.vue（侧栏）和 views/Workbench.vue（快捷入口）共用一份。
 *
 * 【内容】全部自 App.vue 原样迁移，逻辑不变：
 *   · portalGroups   —— 门户模块分组（visibleModules 动态）
 *   · jobGroups      —— 教学管理分组（menu.ts 静态 + hasPage/合并域/台账过滤）
 *   · 工作台置顶项   —— ★ 本次新增：所有登录角色可见（系统首页）
 *
 * ⚠️ 必须在组件 setup 里调用 useSideMenu()（内部用了 pinia store，
 *    模块顶层调用会撞上「pinia 未安装」）。
 */

import { computed } from 'vue';
import { MENU } from '@/config/menu';
import type { MenuNode } from '@/config/menu';
/* ★ 第 1 期「入口合并」：把「初高 / 大学 / 实训」的重复菜单收成一个入口。
 *   · anyStageAccessible —— 聚合菜单的显隐：任一学段可访问即显示
 *   · stageVisible / STAGE_ACCESS —— 合并域按权限码判显隐（2026-10-12 修复） */
import {
  anyStageAccessible,
  stageVisible,
  STAGE_ACCESS,
  type StageDomain,
} from '@/teaching/access';
import type { ModuleDef } from 'shared-types/portal';
import { myPages, hasPage } from '@/store/permission';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';
import { pageModuleAllowed } from '@/store/modules';
/* ★ 2026-10-06 新增：板块 → 页面 台账（权限管理 → 页面管理）
 *   被取消勾选的页面 = 该板块没有这个页面 → 不渲染。 */
import { pageEnabled } from '@/store/pageConfig';

/** 门户模块图标（按模块 key） */
const MODULE_ICON: Record<string, string> = {
  consult: 'ChatLineRound',
  finance: 'Money',
  perm: 'Lock',
  // ★ 2026-10-05：legacy 模块（就业/教务/班级）由 config/menu.ts 渲染，
  //    这里一并登记图标，将来若改成统一由门户注册表渲染也不用再改。
  job: 'Briefcase',
  edu: 'School',
  class: 'UserFilled',
  'class-jh': 'Notebook',
};

export interface ViewChild {
  title: string;
  path?: string;
  key?: string;
  phase?: string;
  stage?: string;
  pageCode?: string;
}
export interface ViewGroup {
  title: string;
  icon?: string;
  stage?: string;
  module?: string;
  path?: string;
  /** ★ 2026-10-16：el-menu 高亮用的 index（默认用 title；工作台置顶项用 '/'） */
  index?: string;
  children?: ViewChild[];
}

/**
 * ★ 2026-10-16 工作台 = 系统首页：固定置顶的单层菜单项。
 *    每个角色登录后第一个页面就是它（用户指令），不做任何权限过滤 ——
 *    能登录就能看（守卫对 / 无 pageCode 要求）。
 */
export const WORKBENCH_GROUP: ViewGroup = {
  title: '工作台',
  icon: 'Odometer',
  path: '/',
  index: '/',
};

/**
 * 合并域菜单项的显隐（2026-10-12 新增，自 App.vue 原样迁移）
 * ---------------------------------------------------------------
 * 【★ 这条分支修的是「合并后菜单集体消失」】
 *
 * 【症状】校长登录后左侧只剩 8 项（工作台 / 班级交接 / 待接收学员 / 催费·缴费 /
 *        就业日志 / 复盘填写 / 数据统计 / 系统设置），
 *        学生档案、班级管理、出勤管理、考试管理、成绩管理、宿舍管理、
 *        退费、休学/退学审批这 8 个合并域全不见了。
 *
 * 【根因】菜单显隐原本是二选一：
 *        if (stages?.length) → anyStageAccessible(stages)  ← 合并域该走这条
 *        else                 → hasPage(path)             ← 实际走了这条（错）
 *
 * 【显隐口径 = 与合并前完全一致】
 *   「该域下任一学段有权限就显示」，与原 anyStageAccessible 语义相同。
 */
function mergedDomainMenuAllowed(domainKey?: string): boolean | null {
  // 没配 stageDomain（如催费·缴费，它保留了 stages）→ 交回原逻辑
  if (!domainKey) return null;
  const stages = Object.keys(
    (STAGE_ACCESS as Record<string, unknown>)[domainKey] ?? {},
  );
  if (!stages.length) return null; // 对照表里没有这个域 → 交回原逻辑
  return stages.some((s) => stageVisible(domainKey as StageDomain, s));
}

/**
 * legacy 分组（就业 / 教务 / 大学部班级 / 初高教学）的【模块门槛】
 * （自 App.vue 原样迁移，注释见 git 历史）
 */
function legacyMenuAllowed(pageCode?: string, hasPortalAccount = true): boolean {
  if (!pageCode) return true;
  if (!hasPortalAccount) return true;
  // ★ 2026-10-19：改用 pageModuleAllowed —— 待接收学员是初高/大学共用页，
  //   按 class: 前缀判模块会把初高班主任挡掉。
  return pageModuleAllowed(pageCode);
}

export function useSideMenu() {
  const portal = usePortalStore();

  /**
   * 门户模块分组（动态）—— 直接来自登录下发的 visibleModules
   * ⚠️ 不在这里硬编码标题/路径，避免与门户 MODULES 注册表两处维护、改一处漏一处。
   */
  const portalGroups = computed<ViewGroup[]>(() => {
    const mods: ModuleDef[] = portal.visibleModules || [];
    return (
      mods
      /* ★ 2026-10-06 修：「未开放的导航」—— 滤掉 legacy 空模块
       *   （详见 git 历史：legacy 模块 menus 为空，交给 jobGroups 渲染） */
      .filter((m) => !m.legacy && (m.menus?.length ?? 0) > 0)
      .map((m) => ({
        title: m.title,
        icon: MODULE_ICON[String(m.key)] || 'Grid',
        module: String(m.key),
        children: (m.menus || [])
          .map((mi) => ({
            title: mi.title,
            key: mi.key,
            path: `/${m.key}${mi.path}`,
          }))
          /* ★ 2026-10-06 页面台账（权限管理 → 页面管理）：
           *   该板块被取消勾选的页面 = 这个板块没有这个页面 → 不渲染。 */
          .filter((c) => pageEnabled(c.path)),
      }))
    );
  });

  /** 教学管理分组（静态，沿用原权限逻辑） */
  const jobGroups = computed<ViewGroup[]>(() => {
    return MENU.map((mod) => {
      if (!mod.children?.length) return mod as ViewGroup;
      const kids = mod.children.filter((c: MenuNode) => {
        /* ★ 第 1 期「入口合并」：聚合菜单项（带 stages）——
         *   显隐口径 = 「任一学段可访问就显示」。 */
        if (c.stages?.length) return anyStageAccessible(c.stages);
        // ★★ 2026-10-12：合并域（第 2 期清空了 stages）改按 STAGE_ACCESS 权限码判。
        const merged = mergedDomainMenuAllowed(c.stageDomain);
        if (merged !== null) return merged;
        if (!c.path) return true;
        if (!hasPage(c.path)) return false;
        // ★ 2026-10-06 页面台账：被「页面管理」取消勾选的页面 = 该板块没有这个页面
        if (!pageEnabled(c.path)) return false;
        // ★ 2026-10-05 两套班级模块隔离（大学部 class / 初高 class-jh）
        return legacyMenuAllowed(c.pageCode, !!portal.account);
      });
      return { ...mod, children: kids as ViewChild[] } as ViewGroup;
    }).filter((mod) => {
      if (mod.children) return mod.children.length > 0;
      return true;
    });
  });

  /** 统一菜单：★ 工作台置顶 + 门户模块 + 教学管理 */
  const visibleMenu = computed<ViewGroup[]>(() => [
    WORKBENCH_GROUP,
    ...portalGroups.value,
    ...jobGroups.value,
  ]);

  /** 默认展开所有分组 */
  const defaultOpeneds = computed(() =>
    visibleMenu.value.filter((m) => m.children?.length).map((m) => m.title),
  );

  return { visibleMenu, defaultOpeneds, portalGroups, jobGroups };
}
