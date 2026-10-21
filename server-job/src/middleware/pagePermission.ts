/**
 * 页面权限守卫中间件（就业管理 > 实训阶段）
 *
 * ============================================================
 * 职责：判断「这个用户能不能访问某个页面」
 * ============================================================
 *
 * 【两种用法】
 *
 * ① 前端启动时拉一次「我能看哪些页面」→ 用来过滤左侧菜单
 *      GET /api/job/auth/my-pages
 *
 * ② 高危接口挂 requirePage('xxx') → 无权限返回 403
 *      router.post('/delete/:id', requirePage('job:class:view'), handler)
 *
 * 【与 checkPermission 的区别】
 *   - checkPermission：按钮级操作权（如 'job:class:delete'）
 *   - requirePage    ：页面级访问权（如 'job:class:view'）
 *   本模块先用页面级，够用；将来要细化到按钮再加。
 *
 * 【数据来源】
 *   现在是本地假数据（pagePermissionSource.ts）；
 *   将来权限管理（8006）就绪后，只改数据源文件，本文件不动。
 *
 * 【⚠️ 为什么不在这里查数据库】
 *   因为权限配置的"权威数据"属于权限模块（8006）。
 *   本模块只做"消费方"——拿到权限码列表，判断放不放行。
 *   如果自己建表存权限，8006 上线后必然要迁移、要合并，白干。
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse } from 'shared-types';
import { getUserPagePermissions, getUserOperationPermissions } from '../utils/pagePermissionSource';
import { getRemovedActionCodesForRoles, preloadRoleActionOverrides } from '../utils/roleActionOverlay';
import { PAGE_PERMISSIONS, moduleOfPageCode, SHARED_PAGE_MODULES } from '../config/pagePermissions';

/**
 * ★ 2026-10-06 模块级门槛（与页面级权限【叠加】判定）
 *
 * 【为什么要在这一层再拦一道】
 *   本文件的页面清单口径是「角色 → 页面权限」，而「这个账号能进哪些模块」
 *   是门户 `t_sys_account.modules` 的事。只判页面级会漏掉一类账号：
 *   在权限库里挂了「系统管理员」角色（页面全开）、但门户上只授权了 perm 的
 *   权限管理员 linx —— 它能拿到全部 40 个页面码，于是：
 *     · 左侧菜单多出「就业管理 / 教务管理 / 班级管理 / 教学管理（初高）」
 *     · 直连 URL 能进这些页面
 *     · 直接调接口也能拿到数据（本守卫是"真正的闸"）
 *
 * 【口径】先过模块门槛，再看页面权限；两道都过才放行。
 *
 * ⚠️ 向后兼容：`modules` 为空/缺失 = 老 token（没有模块信息）→ **不拦**。
 *    绝不能当成「没有权限」—— 那会让所有老令牌请求全线 403。
 */
function moduleGate(user: any): (pageCode: string) => boolean {
  const mods: unknown = user?.modules;
  if (!Array.isArray(mods) || mods.length === 0) return () => true;
  const set = new Set(mods.map((m) => String(m)));
  return (pageCode: string) => {
    // ★ 2026-10-19：跨模块共用的页面码（待接收学员：初高中 + 大学都要用）
    //   ⚠️ 与前端 `web-job/src/store/modules.ts` 的 SHARED_PAGE_MODULES 必须一致：
    //      后端决定 my-pages 下发什么，前端决定菜单/路由放不放行，两边漏一处就半残。
    const shared = SHARED_PAGE_MODULES[pageCode];
    if (shared) return shared.some((m) => set.has(m));
    const m = moduleOfPageCode(pageCode);
    // 不属于任何门户模块的页面码（如 consult/finance/perm 自己的页面）不参与门槛
    return !m || set.has(m);
  };
}

/**
 * 页面权限守卫
 *
 * 用法：
 *   router.get('/xxx', requirePage('job:class:view'), handler);
 */
export function requirePage(pageCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        code: BizCode.UNAUTHORIZED,
        message: '请先登录',
        data: null,
      });
      return;
    }

    // 管理员 / 通配权限直接放行
    if (user.permissions.includes('*')) {
      next();
      return;
    }

    // ★ 模块门槛优先：这个页面所属的模块没授权给我，就不必再查页面权限了
    if (!moduleGate(user)(pageCode)) {
      res.status(403).json({
        code: BizCode.NO_OPERATION_PERMISSION,
        message: '该模块未授权给当前账号，请联系系统管理员',
        data: null,
      });
      return;
    }

    // 查这个用户能看哪些页面
    // ★ 2026-10-08：先预热「权限树 → 操作码」覆盖缓存。
    //   原因：job 板块的转就业等接口用 resolveActionWithOverlay 判权，
    //   而它依赖内存缓存；不预热的话缓存可能为 null → 自建角色被误拒。
    await preloadRoleActionOverrides();
    const allowed = await getUserPagePermissions(user.roles);

    if (allowed.includes(pageCode)) {
      next();
      return;
    }

    // ⚠️ 已登录但无权限 → 403（不是 401）
    const body: ApiResponse<null> = {
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有访问该页面的权限',
      data: null,
    };
    res.status(403).json(body);
  };
}

/**
 * 页面权限守卫（**多码任一**）
 *
 * ★ 2026-10-02 新增。
 *
 * 【为什么需要】
 *   `/api/job/class-info`（学员档案接口）现在被**两个页面**共用：
 *     · 「班级信息管理」→ 权限码 `job:class:view`（班主任/教员/助教/教务…）
 *     · 「信息档案」    → 权限码 `job:empArchive:view`（就业老师）
 *   如果只挂其中一个码，另一个页面的用户就调不了接口。
 *   所以这里允许"命中任意一个码即放行"。
 *
 * @param pageCodes 任意一个命中就放行
 */
export function requireAnyPage(pageCodes: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        code: BizCode.UNAUTHORIZED,
        message: '请先登录',
        data: null,
      });
      return;
    }

    // 管理员 / 通配权限直接放行
    if (user.permissions.includes('*')) {
      next();
      return;
    }

    // ★ 模块门槛 + 页面权限，两道都过才放行（见文件头 moduleGate 说明）
    const gate = moduleGate(user);
    // ★ 2026-10-08：预热权限树覆盖缓存（同 requirePage，见上）
    await preloadRoleActionOverrides();
    const allowed = await getUserPagePermissions(user.roles);

    if (pageCodes.some((c) => gate(c) && allowed.includes(c))) {
      next();
      return;
    }

    // 区分两种拒绝原因，便于排查
    if (!pageCodes.some((c) => gate(c))) {
      res.status(403).json({
        code: BizCode.NO_OPERATION_PERMISSION,
        message: '该模块未授权给当前账号，请联系系统管理员',
        data: null,
      });
      return;
    }

    const body: ApiResponse<null> = {
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有访问该页面的权限',
      data: null,
    };
    res.status(403).json(body);
  };
}

/**
 * 取「当前用户能访问的页面列表」
 *
 * 前端在启动时调一次，用来：
 *   - 过滤左侧菜单（没权限的不显示）
 *   - 路由守卫（直接输入 URL 也进不去）
 */
export async function getMyPages(req: Request, res: Response): Promise<void> {
  const user = req.user;

  if (!user) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }

  // 管理员：全部页面（且读得到权限清单，方便前端展示）
  const isWildcard = user.permissions.includes('*');
  // ★ 2026-10-06 模块门槛：下发的页面/操作码只保留「门户已授权模块」的部分。
  //   这样前端菜单与路由守卫拿到的清单本身就是收口的，
  //   不需要它自己再拼一遍前缀映射（口径统一在 moduleOfPageCode）。
  const gate = moduleGate(user);
  // ★ 2026-10-08：预热权限树覆盖缓存（my-pages 也要给前端正确的 removedCodes，
  //   见下方 getRemovedActionCodesForRoles）
  await preloadRoleActionOverrides();
  const codes = (
    isWildcard
      ? PAGE_PERMISSIONS.map((p) => p.code)
      : await getUserPagePermissions(user.roles)
  ).filter(gate);

  // ★ 2026-10-04：把【按钮级】操作码也下发给前端
  //   Roster 等页面的按钮挂 can('class:student:edit') 这类操作码，
  //   以前 permissions 只含页面码 → can() 恒 false → 按钮对所有人消失。
  const operationCodes = (await getUserOperationPermissions(user.roles)).filter(gate);

  // ★★ 2026-10-04 修（万能测试号）：通配用户**必须把 '*' 本身一起下发**。
  //   上面第 144 行拿 `permissions.includes('*')` 判放行，但那只用来决定
  //   「给哪些页面码」，**没把 '*' 放进返回值** → 前端 store 的 hasPerm() 拿不到它
  //   → `myPermissions.includes('*')` 恒 false → 按钮级操作码全部判不过
  //   → 表象就是「页面能进，但一个按钮都点不了」（万能测试号原本就这毛病）。
  //   前端 hasPerm 的实现是 `includes('*') || includes(code)`，所以必须显式下发。
  const allCodes = isWildcard
    ? ['*', ...codes, ...operationCodes]
    : Array.from(new Set([...codes, ...operationCodes]));

  // ★ 2026-10-07 按钮级收口：把「被权限树显式撤销」的操作码下发给前端，
  //   前端 job/edu 按钮据此在「角色默认」基础上叠加隐藏（与后端总闸同语义）。
  const removedCodes = getRemovedActionCodesForRoles(user.roles);

  // 把权限码转成具体的页面定义（前端好直接用）
  const pages = PAGE_PERMISSIONS.filter((p) => codes.includes(p.code));

  res.json({
    code: 200,
    message: '操作成功',
    data: {
      /** ★ 2026-10-04：当前用户 ID（前端按「岗位责任人是不是我」判断按钮显隐） */
      userId: user.userId,
      roles: user.roles,
      /** 可访问的权限码（页面码 + 操作码） */
      permissions: allCodes,
      /** ★ 2026-10-07 被权限树显式撤销的操作码（前端按钮据此隐藏） */
      removedCodes,
      /** 可访问的页面（含路径，前端守卫直接用） */
      pages,
      /** 全部页面（管理端配置界面用；普通用户也可以看到清单，只是不能改） */
      allPages: PAGE_PERMISSIONS,
    },
  });
}
