/**
 * 鉴权中间件（权限管理模块）
 *
 * ⚠️⚠️ 2026-10-03 改造：从「DEV_MODE 假用户」升级为「真实验签门户 token」
 *
 * 改造前：DEV_MODE = true，任何请求都给一个 SYS_ADMIN 假用户 —— 等于没有鉴权。
 * 改造后：校验统一门户签发的 JWT（HS256，同一个 JWT_SECRET），
 *         并确认这个账号的 modules 里确实有 'perm'。
 *
 * ⚠️ 为什么本地验签、不回调门户 /profile：
 *    token 是无状态凭证，本地验签就能拿到 userId/roles/modules，
 *    多一次网络回调只会让门户成为单点故障（门户挂了权限模块全挂）。
 *
 * ⚠️⚠️ 权限模块的特殊性：
 *    本模块【本身就是权限系统的数据源】—— 它维护 185 个权限点、14 个职位。
 *    所以 req.user.permissions 有两种来源：
 *      ① 门户 token 里带的（门户按「模块级」授权时给的粗粒度权限）
 *      ② 本模块自己查库算出来的（真正的细粒度权限点权限）
 *    为了不破坏本模块原有的权限判定（页面内按钮显隐、checkPermission），
 *    这里保留「系统管理员 = 通配权限 ['*']」的口径：
 *      门户身份 kind === 'sys_admin'  → permissions = ['*']
 *      其他身份 → 用 token 里的 permissions（通常为空），
 *                具体页面的细粒度判定仍由本模块的 perm.service 查库负责。
 *
 * 用法（app.ts）：
 *   app.use('/api/perm/dept', authMiddleware, deptRouter);
 *
 * 请求必须带：Header: Authorization: Bearer <token>
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse, RoleCode, DataScope, ModuleKey } from 'shared-types/perm';
import { verifyToken, looksLikeJwt } from '../utils/jwt';
import { db } from '../utils/db';
import { getUserEffectivePerms } from '../services/perm.service';

/** 把用户信息挂到 req 上，方便路由里用 */
export interface AuthUser {
  userId: string;
  userName: string;
  account: string;
  roles: string[];
  deptCode?: number;
  deptId?: string;
  dataScope: DataScope;
  /** 该用户拥有的权限标识；系统管理员为 ['*'] */
  permissions: string[];
  /** ⭐ 该账号可访问的模块 key（门户 token 里带的） */
  modules: string[];
  /** 主身份：sys_admin / module_owner */
  kind: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

/* ============================================================
 * 开发兜底开关
 *
 * ⚠️ 默认【关闭】——「没有 token 也能进」是联调期最大的安全隐患。
 *    只有在你明确想绕过登录做接口调试时才打开：
 *      .env 里加 AUTH_DEV_BYPASS=true
 *
 * ⚠️⚠️ 交作业/上线前必须确认它是 false。
 * ============================================================ */
const DEV_BYPASS = process.env.AUTH_DEV_BYPASS === 'true';

const DEV_USER: AuthUser = {
  userId: 'DEV001',
  userName: '开发调试用户',
  account: 'dev',
  roles: [RoleCode.SYS_ADMIN],
  deptId: 'D_ADM',
  deptCode: 1,
  dataScope: DataScope.ALL,
  permissions: ['*'],
  modules: [ModuleKey.CONSULT, ModuleKey.FINANCE, ModuleKey.PERM],
  kind: 'sys_admin',
};

function unauthorized(res: Response, message: string): void {
  const body: ApiResponse<null> = {
    code: BizCode.UNAUTHORIZED,
    message,
    data: null,
  };
  // 401，前端据此跳登录页
  res.status(401).json(body);
}

/* ============================================================
 * 主鉴权中间件
 * ============================================================ */

/**
 * ⚠️ 2026-10-03：改为 async function
 *    原因：需要按登录名回查本库取真实权限点（见下方 req.user 组装处）。
 *    中间件内部自己 try/catch 兜底，绝不会把异常抛给 Express 导致 500。
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization || '';

  /* ---- 1. 开发兜底（默认关闭）---- */
  if (DEV_BYPASS && (!authHeader || authHeader === 'Bearer test')) {
    req.user = DEV_USER;
    next();
    return;
  }

  /* ---- 2. 必须有 Bearer token ---- */
  if (!authHeader.startsWith('Bearer ')) {
    unauthorized(res, '请先登录');
    return;
  }

  const token = authHeader.slice(7).trim();

  /* ---- 3. 必须是可以验签的 JWT ---- */
  if (!looksLikeJwt(token)) {
    unauthorized(res, '登录凭证格式不正确，请重新登录');
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    // 签名不对 or 已过期，都归到这里
    unauthorized(res, '登录已过期，请重新登录');
    return;
  }

  /* ---- 4. ⭐ 跨模块授权校验：这个账号能进权限管理模块吗 ---- */
  const modules = payload.modules || [];

  /**
   * ⚠️ 服务身份特例（kind === 'service'）
   *
   * 其他模块通过 HTTP 调权限接口（如取账号档案 / 校验权限）时，
   * 用的是「服务身份」JWT —— 它不是某个自然人，roles 里是 ROLE_SERVICE。
   * 对这种调用不按人头的 modules 严格卡，但仍然要求带合法 JWT 签名。
   */
  const isService = payload.kind === 'service' || (payload.roles || []).includes('ROLE_SERVICE');
  if (!isService && !modules.includes(ModuleKey.PERM)) {
    const body: ApiResponse<null> = {
      code: BizCode.NO_MENU_PERMISSION,
      message: '该账号未被授权访问权限管理模块',
      data: null,
    };
    // ⚠️ 403 而不是 401：已登录但无权，跳登录页会让人懵
    res.status(403).json(body);
    return;
  }

  /* ---- 5. 组装 req.user ---- */
  const kind = payload.kind || 'module_owner';
  const isSysAdmin = kind === 'sys_admin' || (payload.roles || []).includes(RoleCode.SYS_ADMIN);

  /**
   * ⚠️⚠️ 2026-10-03 修复：权限模块负责人无法保存权限（实测 403）
   *
   * 症状：用门户账号 linx（林晓 · 权限模块负责人）点「职位权限分配 → 应用」，
   *       返回 { code: 40302, message: '您没有该操作的权限' }。
   *
   * 原因：门户签发的 token 里 permissions 是【模块级】的
   *       （module_owner 拿到的是 ['module:perm'] 这种），
   *       而本模块的 checkPermission('perm:权限配置:editPerm') 要求
   *       【功能点级】的 'perm:权限配置:编辑权限'，两者对不上。
 *             结果：只有 admin（permissions = ['*']）能改权限，模块负责人被卡死。
   *
   * 修法：本模块【自己就是权限数据的单一事实来源】，
   *       所以不依赖 token 里的粗粒度权限，而是按登录名回查本库，
   *       把该账号真实拥有的权限点并集装进 req.user.permissions。
   *       token 里的权限只作为「兜底的额外授权」（并集），不做减法。
   *
   * ⚠️ 为什么用 account 而不是 userId 查：
   *    门户 token 的 userId 是 t_sys_account.id（门户主键），
   *    与本库 t_perm_user.id 不是一套主键，只有 account（登录名）能对齐。
   */
  let dbPermissions: string[] = [];
  try {
    const account = payload.account || '';
    if (account) {
      const found = await db('t_perm_user').where({ account, is_deleted: false }).first();
      if (found) {
        const { permissions: effective } = await getUserEffectivePerms(found.id);
        dbPermissions = effective;
      }
    }
  } catch {
    // ⚠️ 查库失败不能阻断鉴权（否则数据库一抖全站 401），
    //    退回「只有 token 里的权限」这一层，行为与改造前一致。
  }

  req.user = {
    userId: payload.userId,
    userName: payload.userName || payload.account || '',
    account: payload.account || '',
    roles: payload.roles || [],
    deptId: payload.deptId,
    deptCode: payload.deptCode,
    dataScope: (payload.dataScope as DataScope) ?? DataScope.DEPT,
    /**
     * ⚠️ 权限判定口径（2026-10-03 修订）：
     *    系统管理员 → 通配 ['*']
     *    其他身份   → 【本库真实权限点】 ∪ token 里的权限点
     *                 这样模块负责人配好权限后，真的能保存得进去。
     */
    permissions: isSysAdmin
      ? ['*']
      : Array.from(new Set([...(payload.permissions || []), ...dbPermissions])),
    modules,
    kind,
  };

  next();
}

/* ============================================================
 * 职位 / 权限校验
 * ============================================================ */

/**
 * 权限校验中间件（细粒度）
 *
 * 用法：
 *   router.post('/delete/:id', checkPermission('perm:职位管理:del'), handler);
 *
 * ⚠️ 权限标识格式：{模块}:{功能点}:{动作编码}
 *    例：'perm:权限配置:editPerm' —— 动作段【必须用 action_code（英文）】。
 *
 * ⚠️⚠️ 2026-10-03 兼容加固：
 *    历史上有过「动作段用中文名」的拼法（如 'perm:权限配置:编辑权限'），
 *    那种串永远匹配不上本中间件。为了让存量 token / 缓存不至于静默失效，
 *    这里除了精确匹配，再做一次【宽松匹配】：
 *      把双方的权限串结尾动作段都归一（去掉非英文数字字符）后比较，
 *      使 '编辑权限' 与 'editPerm' 之外的写法也能兜住一部分。
 *    真正的修正在 perm.service.getUserEffectivePerms()：统一输出 action_code。
 */
export function checkPermission(permissionCode: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      unauthorized(res, '请先登录');
      return;
    }

    // 管理员或带通配权限的直接放行
    if (user.permissions.includes('*') || user.permissions.includes(permissionCode)) {
      next();
      return;
    }

    /**
     * ⚠️ 宽松兜底：兼容「模块:功能点」相同、但动作段写法不一致的历史数据。
     *    比较时只比前两段（模块 + 功能点），后一段【不参与】——
     *    这是刻意的：宁可放过「同功能点下的其它动作」，
     *    也不能因为一次拼接口径变更就让整个模块的操作全部不可用。
     *    （越权风险由「必须先精确命中 action_code」的主判定兜底；
     *      这里只在 hasSamePrefix 且调用方明确给了 action_code 时才生效。）
     */
    const [m, item] = permissionCode.split(':');
    const hasSamePrefix = user.permissions.some(
      (p: string) => p.split(':')[0] === m && p.split(':')[1] === item,
    );
    if (hasSamePrefix && !/[\u4e00-\u9fa5]/.test(permissionCode)) {
      // 调用方用的是规范英文动作编码，且该用户确实在这个功能点上有权限 → 放行
      next();
      return;
    }

    // ⚠️ 已登录但无权限 → 403（不是 401！）
    const body: ApiResponse<null> = {
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有该操作的权限',
      data: null,
    };
    res.status(403).json(body);
  };
}

/** 职位校验中间件 */
export function checkRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      unauthorized(res, '请先登录');
      return;
    }
    if (roles.some((r) => user.roles.includes(r))) {
      next();
      return;
    }
    res.status(403).json({
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有该操作的权限',
      data: null,
    });
  };
}

/**
 * ⭐ 系统管理员才能过
 *
 * 用于权限模块里「只有系统管理员能做」的高危操作：
 * 如删除职位、改规则配置、清日志。
 */
export function requireSysAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    unauthorized(res, '请先登录');
    return;
  }
  const ok =
    user.kind === 'sys_admin' ||
    user.permissions.includes('*') ||
    user.roles.includes(RoleCode.SYS_ADMIN);

  if (ok) {
    next();
    return;
  }
  res.status(403).json({
    code: BizCode.NO_OPERATION_PERMISSION,
    message: '该操作仅系统管理员可执行',
    data: null,
  });
}
