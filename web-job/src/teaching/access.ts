/**
 * 「教学管理」合并域的访问判定（单一来源）
 * ============================================================
 *
 * 【为什么单独抽出来】
 *   同一个判定要在**两个地方**用，必须口径完全一致，否则会出现
 *   「菜单看得见、点进去空白」或反之：
 *     · App.vue 左侧菜单  —— 决定「这个菜单项显不显示」
 *     · TeachingDomain.vue —— 决定「这个学段页签显不显示」
 *
 * 【判定口径 —— 与合并前的菜单过滤完全一致，只是把三重判定打包】
 *   ① hasPage(原路径)        —— 角色有没有这个页面的权限（后端 /api/job/auth/my-pages）
 *   ② pageEnabled(原路径)    —— 权限管理 → 页面管理 这个页面有没有被关掉
 *   ③ moduleOfPageCode() 所属模块是否被门户授权
 *      （防「权限库里挂了高权限角色、门户却没授权这个模块」的账号串门）
 *
 * ⚠️ 用的是**原页面路径与权限码**，所以用户可见范围 = 合并前，一点没变。
 */

import { hasPage, hasPerm } from '@/store/permission';
import { pageEnabled } from '@/store/pageConfig';
import { moduleAllowed, moduleOfPageCode } from '@/store/modules';
import { useAuthStore as usePortalStore } from '@/portal/stores/auth';

/** 某个学段页面当前账号能不能访问 */
export function stageAccessible(path: string, pageCode?: string): boolean {
  if (!path) return false;
  if (!hasPage(path)) return false;
  if (!pageEnabled(path)) return false;
  const portal = usePortalStore();
  // 门户身份未加载时不拦模块（否则非门户来源会把菜单整片打没，与合并前一致）
  if (!portal.account) return true;
  const m = moduleOfPageCode(pageCode);
  return !m || moduleAllowed(m);
}

/** 一组学段里**任意一个**可访问即返回 true（用于菜单项显隐） */
export function anyStageAccessible(
  stages: ReadonlyArray<{ path: string; pageCode?: string }>,
): boolean {
  return stages.some((s) => stageAccessible(s.path, s.pageCode));
}

/* ============================================================
 * 第 3 期 · 阶段 A：判权不再依赖「旧路由存活」
 * ============================================================
 *
 * 【★ 为什么加这一层 —— 合并后的统一页有个隐藏地雷】
 *
 *   统一页要显示「学段下拉」，得先知道用户能访问哪些学段。
 *   原来的写法是 `stageAccessible(STAGE_PATH[s], STAGE_PAGE_CODE[s])`，
 *   而 `STAGE_PATH` 指向的是**合并前的旧路由**（如 `/class-jh/classInfo`）。
 *
 *   问题：**旧路由一旦按合并纪律删掉，学段下拉会集体消失**，页面直接空一块。
 *   而且实测已经踩过一次坑 —— `TeachingClass.vue` 里 `STAGE_PATH.job` 写的是
 *   `/job/class`，但权限库里 `job:class:view` 登记的 path 是 `/class`，
 *   路径写错却因为「另一条路径碰巧没被拒绝」而一直没被发现。
 *
 * 【本函数的做法 —— 与后端同一套权限码，不碰路由】
 *   判权改用 `hasPerm(pageCode)`：权限码来自权限库 `t_perm_page.page_code`，
 *   **与后端各域 `requireAnyPage()` 用的是同一批码**，前后端口径天然一致。
 *
 *   但**不能只判 hasPerm**：万一某部署环境权限树没配全（老数据），
 *   会「有权限却看不到学段」—— 所以保留 `stageAccessible` 整条作为兜底，
 *   两者任一为真即通过。**行为与合并前完全一致，不会让任何人突然看不到页面。**
 */
export function stageAccessibleByCode(pageCode?: string, fallbackPath?: string): boolean {
  // ① 权限码（主判权，与后端同一套口径，且不依赖路由存活）
  if (pageCode && hasPerm(pageCode)) return true;
  // ② 旧 path 完整判定兜底（权限树没配全时用；旧路由真下线后可删这段）
  if (fallbackPath && stageAccessible(fallbackPath, pageCode)) return true;
  return false;
}

/**
 * 八个合并域的「学段 → 权限码 / 旧路由」对照表
 *
 * ⚠️ 权限码必须与**后端各域 service.ts 的 CODES** 完全一致 ——
 *    改这里之前先跑 `node scripts/_p3-check-permcodes.cjs` 核对。
 *
 * ★★ 第 3 期 D2（2026-10-09）：已合并的 19 条旧路由**物理删除**了，
 *   对应的 `path` 一并清空（写成 `path: null`）——
 *   留着它们的话，`stageAccessibleByCode` 的兜底分支会去查一个不存在的路由，
 *   结果永远是 false，等于白跑一趟；更糟的是会让人以为「还在兜底其实早没了」。
 *
 *   **保留 path 的 4 条**：就业·信息档案 / 就业基地宿舍 / 教务·学生档案 / 教务·宿舍
 *   —— 这些域本期**没有合并**，页面和路由都还在，是当前唯一可用的兜底。
 */
export const STAGE_ACCESS = {
  student: {
    jh: { code: 'classjh:student:view', path: null },
    class: { code: 'class:student:view', path: null },
    job: { code: 'job:empArchive:view', path: '/archive/basic-info' },
    // ★ 2026-10-19：就业部（独立学段，沿用就业模块的档案权限）
    emp: { code: 'job:empArchive:view', path: null },
    edu: { code: 'edu:student:view', path: '/edu/student' },
  },
  class: {
    jh: { code: 'classjh:classInfo:view', path: null },
    class: { code: 'class:info:view', path: null },
    job: { code: 'job:class:view', path: null },
    // ★ 2026-10-19：就业部（独立学段，沿用就业模块的班级权限）
    emp: { code: 'job:class:view', path: null },
  },
  attendance: {
    jh: { code: 'classjh:attendance:view', path: null },
    class: { code: 'class:attendance:view', path: null },
    job: { code: 'job:attendance:view', path: null },
  },
  exam: {
    jh: { code: 'classjh:exam:view', path: null },
    class: { code: 'class:exam:view', path: null },
    job: { code: 'job:exam:view', path: null },
  },
  score: {
    jh: { code: 'classjh:score:view', path: null },
    class: { code: 'class:grade:view', path: null },
    job: { code: 'job:examScore:view', path: null },
  },
  refund: {
    jh: { code: 'classjh:refund:view', path: null },
    class: { code: 'class:refund:view', path: null },
    job: { code: 'job:refund:view', path: null },
  },
  leave: {
    jh: { code: 'classjh:approval:view', path: null },
    class: { code: 'class:suspend:view', path: null },
    job: { code: 'job:suspendApproval:view', path: null },
  },
  fee: {
    // ★ 2026-10-19 域重组后 fee 也改 unified（不再靠 stages 判菜单显隐），
    //   这四个码 = 原四学段页签的 pageCode：任一可见即显示「催费」菜单项
    // ★ 2026-10-20：教务缴费总记录（edu 那页）已整页删除，edu 码只为老路由 /edu/fee 回退保留；
    //   正常使用下只有持有 jh 码的账号能看到催费页内容（TeachingFeeHub 的 showUrge 判 jh）。
    jh: { code: 'classjh:fee:view', path: null },
    class: { code: 'class:urge:view', path: null },
    job: { code: 'job:feeCall:view', path: null },
    edu: { code: 'edu:fee:view', path: null },
  },
  dorm: {
    jh: { code: 'classjh:dorm:view', path: null },
    class: { code: 'class:dorm:view', path: null },
    job: { code: 'job:dorm:view', path: null },
  },
} as const;

export type StageDomain = keyof typeof STAGE_ACCESS;

/**
 * 判断某学段在某业务域下是否可见（**只按权限码判**）
 *
 * @param domain 业务域，如 'class' / 'dorm'
 * @param stage  学段，如 'jh' / 'class' / 'job' / 'edu'
 */
export function stageVisible(domain: StageDomain, stage: string): boolean {
  const m = (STAGE_ACCESS[domain] as Record<string, { code: string; path: string | null }>)[stage];
  if (!m) return false;
  // path 为 null = 该学段的旧路由已下线，没有兜底，只能靠权限码
  return stageAccessibleByCode(m.code, m.path ?? undefined);
}

/**
 * 生成「当前用户可见的学段下拉项」
 *
 * @param domain 业务域
 * @param order  学段展示顺序（固定，别让权限影响顺序）
 * @param labels 学段 → 中文名
 */
export function visibleStageOptions<T extends string>(
  domain: StageDomain,
  order: readonly T[],
  labels: Record<T, string>,
): Array<{ value: T; label: string }> {
  return order.filter((s) => stageVisible(domain, s)).map((s) => ({ value: s, label: labels[s] }));
}
