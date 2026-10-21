/**
 * 权限管理 · 页面管理（板块 → 页面 台账）契约
 *
 * ============================================================
 * 【这个功能解决什么】
 *   一个板块（门户模块）里到底有哪几个页面，原来【写死在代码里】：
 *     · 新模块（咨询/财务/权限）→ `shared-types/src/portal/portal.ts` 的 MODULES.menus
 *     · legacy 模块（就业/教务/大学部班级/初高教学）→ `web-job/src/config/menu.ts`
 *   想「先不给某个板块上某个页面」只能改代码 + 重新构建。
 *   本台账把它变成**数据**：`sms_perm.t_perm_page` 一行一个页面，
 *   `enabled = 1` 表示该板块有这个页面；打勾/去勾即改这一列。
 *
 * 【口径】
 *   · 板块 key 用门户的模块 key（consult / finance / perm / job / edu / class / class-jh）
 *   · 页面身份用【路由 path】（全系统唯一：/class 与 /class/roster 是两套模块的不同页面）
 *   · 全局生效 —— 不是为了某个职位，而是「这个板块有没有这个页面」。
 *     所以它和「职位权限分配」是两个层次：
 *       页面管理     → 板块有哪些页面（板块级）
 *       职位权限分配 → 某职位能用哪些功能点（职位级）
 *     两者叠加：页面不存在 → 谁都没有；页面存在 → 再看职位权限。
 *
 * 【生效链路】
 *   前端 store/pageConfig 拉本台账 → 左侧菜单过滤 + 路由守卫拦截。
 *   ⚠️ locked = true 的页面（「页面管理」自身）不允许去勾，否则会把自己锁在门外。
 * ============================================================
 */

/** 台账里的一行 = 一个页面 */
export interface PermPageItem {
  /** 页面 key：新模块 = menuKey（如 assign）；legacy 模块 = 权限码中段（如 classTransfer） */
  pageKey: string;
  /** 页面标题（菜单显示名） */
  pageTitle: string;
  /** 路由 path（本台账的自然主键，与板块组合唯一） */
  pagePath: string;
  /** legacy 模块的页面权限码（如 job:classTransfer:view）；新模块为空 */
  pageCode?: string;
  /**
   * ★ 2026-10-20 合并板块：一页挂多个权限码（每个学段一个）
   *
   * 「出勤管理」这类页面由初高 / 大学 / 实训多套页面合并成一页，
   * 合并后只剩一个 path，但权限判定仍按学段走 → 一页要挂多个码。
   * 判定口径 = **任一命中即可见**。与 `pageCode` 同时存在时以本字段为准。
   */
  pageCodes?: string[];
  /** 排序号（板块内顺序 = 侧栏顺序） */
  pageSort: number;
  /** ★ 该板块是否拥有这个页面（打勾 = true） */
  enabled: boolean;
  /** 锁定：不允许取消勾选（「页面管理」自身，防止自锁） */
  locked: boolean;
  /** 一句话说明（鼠标悬停/列表副标题用） */
  remark?: string;
}

/** 一个板块（一个左侧条目） */
export interface PermPageBoard {
  /** 板块 key（门户模块 key） */
  moduleKey: string;
  /** 板块名（如「权限管理」） */
  moduleName: string;
  /** 板块图标（emoji） */
  moduleIcon: string;
  /** 板块说明 */
  moduleDesc: string;
  /** 是否 legacy 模块（页面清单原本在 config/menu.ts） */
  legacy: boolean;
  /** 页面总数 */
  total: number;
  /** 已启用页面数 */
  enabledCount: number;
  /** 页面明细 */
  pages: PermPageItem[];
}

/** GET /api/perm/page/list 的返回 */
export interface PermPageListResult {
  /** 全部板块（顺序 = 板块顺序） */
  boards: PermPageBoard[];
  /** 页面总数 */
  total: number;
  /** 已启用页面数 */
  enabledTotal: number;
}

/**
 * PUT /api/perm/page/save 的入参
 *
 * ⚠️ 保存语义是【按板块全量覆盖】：提交该板块**当前打勾**的页面 path 数组，
 *    后端先把该板块全部置为未启用，再把提交的这批置为启用。
 *    这样才不会出现「取消勾选后菜单还在」的幽灵页面。
 */
export interface PermPageSavePayload {
  /** 板块 key */
  moduleKey: string;
  /** 该板块当前勾选的页面 path 列表（全量） */
  enabledPaths: string[];
}

/* ============================================================
 * ★ 2026-10-07 新增：**职位 → 页面** 台账（页面管理左栏的「板块 → 职位」）
 *
 * 【与上面「板块 → 页面」的区别】
 *   板块 → 页面（t_perm_page）      ：这个板块**有没有**这个页面（全局）
 *   职位 → 页面（t_perm_role_page）：这个职位**能不能看到**这个页面（职位级）
 *   两者是叠加关系（AND），再叠加一层「职位有没有这个页面的权限点」。
 *
 * 【三层叠加的总口径】
 *   ① 板块有这个页面（页面管理 · 板块模式）
 *   ② 这个职位被允许看这个页面（页面管理 · 职位模式）★ 本组类型
 *   ③ 这个职位真的持有该页面的权限点（职位权限分配）
 *   三者都满足才可见。任一层关掉 → 不可见。
 *
 * 【为什么要有「已配置 / 未配置」】
 *   职位 × 页面 = 14 × 56 = 784 组合，绝大多数职位在本系统里
 *   本来就有既定的可见范围（写死在 pagePermissionSource.ts 与
 *   perm-link.ts 的换算表里）。所以台账【只存与默认不同的显式选择】：
 *     · 某个职位一行都没有 → 完全沿用现行默认（零行为变化）
 *     · 某个职位一旦保存过 → 以台账为准（全量覆盖），并可「恢复默认」清掉
 *   这样既不给存量账号带来任何副作用，又能让管理员真正改得动。
 * ============================================================ */

/** 左栏「板块」下的一个职位条目 */
export interface PermRoleSummary {
  /** 职位 id（如 R03） */
  roleId: string;
  /** 职位编码（如 TEACH_HEAD） */
  roleCode: string;
  /** 职位名（如 班主任） */
  roleName: string;
  /** 所属部门名 */
  deptName: string;
  /** 职位类型（业务职位 / 管理职位 / 职能职位 / 系统职位） */
  roleType: string;
  /** 职位是否启用 */
  enabled: boolean;
  /** ★ 该职位是否已有显式配置（false = 沿用默认） */
  configured: boolean;
  /** 该职位在本板块下可见的页面数 */
  enabledCount: number;
  /** 本板块页面总数 */
  total: number;
}

/** 左栏的一个板块（含它下面的职位） */
export interface PermRoleTreeBoard {
  moduleKey: string;
  moduleName: string;
  moduleIcon: string;
  moduleDesc: string;
  legacy: boolean;
  /** 板块页面总数 */
  total: number;
  /** 所属职位（顺序 = 职位顺序） */
  roles: PermRoleSummary[];
}

/** GET /api/perm/page/role-tree 的返回 */
export interface PermRoleTreeResult {
  boards: PermRoleTreeBoard[];
  /** 不属于任何板块的职位（兜底显示，正常为空） */
  orphanRoles: PermRoleSummary[];
  /** 参与的职位总数 */
  roleTotal: number;
}

/** 职位模式下的一行页面 */
export interface PermRolePageItem extends PermPageItem {
  /** ★ 是否与「默认推导值」不同（界面上标记「已改」） */
  overridden: boolean;
}

/** 职位模式下的一个板块卡片 */
export interface PermRolePageBoard {
  moduleKey: string;
  moduleName: string;
  moduleIcon: string;
  legacy: boolean;
  total: number;
  enabledCount: number;
  pages: PermRolePageItem[];
}

/** GET /api/perm/page/role-pages?roleId=xxx 的返回 */
export interface PermRolePagesResult {
  roleId: string;
  roleCode: string;
  roleName: string;
  deptName: string;
  /** ★ 该职位是否已有显式配置（false = 当前显示的是默认推导值） */
  configured: boolean;
  /** 显式配置的行数（configured=false 时为 0） */
  overrideCount: number;
  boards: PermRolePageBoard[];
  total: number;
  enabledTotal: number;
}

/**
 * PUT /api/perm/page/role-save 的入参
 *
 * ⚠️ 保存语义 = 【该职位全量覆盖】：
 *    提交该职位在全部板块下的最终勾选结果，后端整表替换该职位的行。
 *    这样才不会出现「取消勾选后页面还在」的幽灵配置。
 */
export interface PermRolePageSavePayload {
  roleId: string;
  items: Array<{
    moduleKey: string;
    pagePath: string;
    enabled: boolean;
  }>;
}

/** PUT /api/perm/page/role-save 的返回 */
export interface PermRolePageSaveResult {
  roleId: string;
  configured: boolean;
  enabledTotal: number;
  total: number;
  /** 相对默认值改动的页面数 */
  changed: number;
}
