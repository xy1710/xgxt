/**
 * 权限管理模块 · 菜单与页面契约
 *
 * ⚠️⚠️ 2026-10-03 新增：权限模块接入统一门户
 *
 * 背景（用户指令）：
 *   「这是权限模块，将权限模块加入学管里面，和咨询财务是同一级标题」
 *
 * ⚠️ 与财务模块的区别：
 *   财务模块的职位是「自己定义」的（FINANCE_ADMIN / ACCOUNTANT / CASHIER）。
 *   而权限模块【本身就是权限系统的数据源】—— 它维护 14 个职位、185 个权限点。
 *   如果这里再造一套职位，就会出现「权限模块自己说一套、它管理的职位表又是另一套」的矛盾。
 *
 *   所以本模块的页面可见性口径定为【按门户身份】：
 *      ① 系统管理员（kind = sys_admin）→ 全部 7 页
 *      ② 权限模块负责人（module_owner 且被授权 perm）→ 全部 7 页
 *         （权限模块本身就是「管理权限」的地方，负责人需要全部页面才能干活）
 *      ③ 其他任何情况 → 只给「权限总览」一页（只读兜底，不至于进来一片空白）
 *
 * ⚠️⚠️ 这是【单一事实来源】：
 *    - 后端下发 menuKeys 时按它算
 *    - 前端路由守卫按 meta.menuKey 校验
 *    两处都读这一份，就不会出现「菜单有但点进去被踢回」的老问题。
 */

/** 权限模块的 7 个页面 key（顺序即侧栏顺序） */
export const PERM_MENU_KEYS = [
  'overview',
  'dept',
  'role',
  'user',
  'assign',
  /* ★ 2026-10-06 新增：页面管理（板块 → 页面 台账，勾选即生效） */
  'page',
  'log',
  // ⚠️ 2026-10-06：'rule'（规则配置）已按用户指令删除，7 页 → 6 页。
  //    这里删掉后，后端 /api/perm/auth/profile 下发的 menuKeys 不再含 'rule'，
  //    perm 模块自己的「页面可见性」也随之收口（路由守卫 / 页面内按钮显隐共用本常量）。
] as const;

export type PermMenuKey = (typeof PERM_MENU_KEYS)[number];

/** 页面 key → 中文名 */
export const PERM_MENU_NAME: Record<string, string> = {
  overview: '权限总览',
  dept: '部门管理',
  role: '职位管理',
  user: '账号管理',
  assign: '职位权限分配',
  page: '页面管理',
  log: '操作日志',
};

/** 页面 key → 路由路径（hash 形式，与 web-perm 的 router 一致） */
export const PERM_MENU_PATH: Record<string, string> = {
  overview: '/overview',
  dept: '/dept',
  role: '/role',
  user: '/user',
  assign: '/assign',
  page: '/page',
  log: '/log',
};

/* ============================================================
 * 门户身份 → 可访问页面
 * ============================================================ */

/** 全部页面（系统管理员 / 权限模块负责人） */
const FULL: string[] = [...PERM_MENU_KEYS];

/** 只读兜底（其他被授权进本模块的账号） */
const READONLY: string[] = ['overview'];

/**
 * 按门户身份算可见页面
 *
 * @param user 中间件挂在 req 上的用户
 */
export function permMenusOf(user: {
  kind?: string;
  modules?: string[];
  roles?: string[];
} | null | undefined): string[] {
  if (!user) return READONLY;

  // ① 门户的系统管理员 → 全开
  if (user.kind === 'sys_admin') return FULL;

  // ② 被授权进 perm 模块的负责人 → 全开
  if ((user.modules || []).includes('perm')) return FULL;

  // ③ 服务身份（跨模块调用）→ 全开，供其他模块读权限数据
  if (user.kind === 'service' || (user.roles || []).includes('ROLE_SERVICE')) return FULL;

  // ④ 其他情况 → 只读兜底
  return READONLY;
}

/**
 * 权限模块的登录人档案
 *
 * 前端顶栏显示「我是谁」，路由守卫读 menuKeys。
 */
export interface PermProfile {
  /** 统一账号表主键 */
  accountId: string;
  /** 登录账号 */
  account: string;
  /** 姓名 */
  userName: string;
  /** 主身份：sys_admin / module_owner */
  kind: string;
  /** 是否系统管理员（页面内高危按钮的显隐依据） */
  isSysAdmin: boolean;
  /** 可访问的页面 key 列表 */
  menuKeys: string[];
}

/** 组装 profile（供 auth.route.ts 复用） */
export function buildPermProfile(user: any): PermProfile {
  const isSysAdmin = user?.kind === 'sys_admin' || (user?.permissions || []).includes('*');
  return {
    accountId: user?.userId || '',
    account: user?.account || '',
    userName: user?.userName || '',
    kind: user?.kind || 'module_owner',
    isSysAdmin,
    menuKeys: permMenusOf(user),
  };
}
