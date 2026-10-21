/**
 * 权限管理板块 · 内部页面路由（唯一事实来源）
 *
 * ⚠️ 本板块的 7 个页面都挂在 `/perm/*` 前缀下（见 web-job/src/router/index.ts），
 *    但历史上这里散落着大量【不带 /perm 前缀】的跳转写法，例如：
 *      · 权限总览  go('/role') / go('/user') / go('/assign') / go('/dept') / go('/log')
 *      · 部门管理  gotoPage('/role') / gotoPage('/user') / router.push('/user')
 *      · 职位管理  router.push('/user')
 *    这些路径在路由表里根本不存在 —— 点下去一律落到「页面不存在」占位页，
 *    表现出来就是「这个链接点了没反应 / 跳到别的页」。
 *
 * 以后写本板块的跳转，一律用这张表，别再手写字符串。
 */
export const PERM_ROUTE = {
  overview: '/perm/overview',
  dept: '/perm/dept',
  role: '/perm/role',
  user: '/perm/user',
  assign: '/perm/assign',
  page: '/perm/page',
  log: '/perm/log',
} as const;

/** 跳到「账号管理」并把某个账号的编辑表单直接打开（去编辑用） */
export const permUserEditRoute = (userId: string) => ({
  path: PERM_ROUTE.user,
  query: { edit: userId },
});

export default PERM_ROUTE;
