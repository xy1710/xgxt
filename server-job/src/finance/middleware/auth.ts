/**
 * 鉴权中间件（财务管理模块）
 *
 * ⚠️⚠️ 2026-10-02 改造：从「DEV_MODE 假用户」升级为「真实验签门户 token」
 *
 * 改造前：DEV_MODE = true，任何请求都给一个 ADMIN 假用户 —— 等于没有鉴权。
 * 改造后：校验统一门户签发的 JWT（HS256，同一个 JWT_SECRET），
 *         并确认这个账号的 modules 里确实有 'finance'。
 *
 * ⚠️ 为什么本地验签、不回调门户 /profile：
 *    token 是无状态凭证，本地验签就能拿到 userId/roles/modules，
 *    多一次网络回调只会让门户成为单点故障（门户挂了财务全挂）。
 *    代价是「改了账号权限要等 token 过期才生效」—— 演示环境可接受
 *    （JWT_EXPIRES_IN=7d，且门户改权限后重新登录即可）。
 *
 * 用法（app.ts）：
 *   app.use('/api/finance/fee', authMiddleware, feeRouter);
 *
 * 请求必须带：Header: Authorization: Bearer <token>
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse, RoleCode, DataScope, ModuleKey } from 'shared-types/finance';
import { verifyToken, looksLikeJwt } from '../utils/jwt';
import { resolveBusinessRoles } from '../../middleware/auth';
// ★ 2026-10-07：接口级打通 —— 把「职位权限分配」的显式改动叠加到 FIN_ROLE_OPERATIONS 上
import {
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
} from '../../utils/roleActionOverlay';

/** 把用户信息挂到 req 上，方便路由里用 */
export interface AuthUser {
  userId: string;
  userName: string;
  account: string;
  roles: string[];
  deptCode?: number;
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
  roles: [RoleCode.ADMIN],
  deptCode: 1,
  dataScope: DataScope.ALL,
  permissions: ['*'],
  modules: [ModuleKey.CONSULT, ModuleKey.FINANCE],
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

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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

  /* ---- 4. ⭐ 跨模块授权校验：这个账号能进财务模块吗 ---- */
  const modules = payload.modules || [];

  /**
   * ⚠️ 服务身份特例（kind === 'service'）
   *
   * 其他模块（咨询 8001 / 教务 8002 …）通过 HTTP 调财务接口时，
   * 用的是「服务身份」JWT（见 server-consult/services/service-token.ts）——
   * 它不是某个自然人，roles 里是 ROLE_SERVICE。
   *
   * 对这种调用：
   *   · 不按人头的 modules 严格卡（服务声明了要访问哪些模块，
   *     但更稳的判据是它有 '*'
   *   · 仍然要求带合法的 JWT 签名（挡住外网裸奔）
   */
  const isService = payload.kind === 'service' || (payload.roles || []).includes('ROLE_SERVICE');
  if (!isService && !modules.includes(ModuleKey.FINANCE)) {
    const body: ApiResponse<null> = {
      code: BizCode.NO_MENU_PERMISSION,
      message: '该账号未被授权访问财务管理模块',
      data: null,
    };
    // ⚠️ 403 而不是 401：已登录但无权，跳登录页会让人懵
    res.status(403).json(body);
    return;
  }

  /* ---- 5. 组装 req.user ---- */
  req.user = {
    userId: payload.userId,
    userName: payload.userName || payload.account || '',
    account: payload.account || '',
    roles: payload.roles || [],
    dataScope: (payload.dataScope as DataScope) ?? DataScope.DEPT,
    permissions: payload.permissions || [],
    modules,
    kind: payload.kind || 'module_owner',
  };

  next();
}

/* ============================================================
 * 角色 / 权限校验
 * ============================================================ */

/* ============================================================
 * ★★ 2026-10-06 修复：财务模块的「角色 → 操作权限」兜底
 *
 * 【原来错在哪】
 *   门户签发的 token 里 `permissions` 只有【模块级】粒度
 *   （module_owner 拿到的是 ['module:finance']），一条 `finance:*` 都没有。
 *   而本模块的 checkPermission('finance:fee:add') 要求功能点级权限 →
 *   **除了 admin（permissions=['*']），任何人都点不动「新增收费单」**：
 *   财务负责人 zhoum / 财务专员 liukj 打开财务页面，所有写操作 403。
 *
 * 【修法】与本模块同源的「权限管理模块」一样 —— 本模块自己按登录名
 *   回查业务角色（sms_perm），再用下面的角色兜底表补出操作权限点。
 *   只在「token 权限不够」时才查一次，读接口零额外开销。
 *
 * ⚠️ 角色码来自 sms_perm.t_perm_role.role_code（FIN_STAFF = 财务）。
 * ============================================================ */
const FIN_ROLE_OPERATIONS: Record<string, string[]> = {
  // 财务（负责人 / 专员）：缴费全流程 + 退费出款 + 冻结 + 费用标准
  FIN_STAFF: [
    'finance:fee:add', 'finance:fee:verify', 'finance:fee:delete',
    'finance:refund:apply', 'finance:refund:pay',
    'finance:freeze:manage', 'finance:standard:manage',
    // 财务侧的学员档案维护（routes/student.route.ts 用的就是这三个码）
    'consult:student:add', 'consult:student:edit', 'consult:student:delete',
  ],
  // 系统管理员：通配（仍受门户只读总闸约束）
  SYS_ADMIN: ['*'],
};

/** 门户级角色码 —— 只有这些说明 token 里没有业务角色，需要回查 */
const PORTAL_ONLY_ROLES = new Set(['SYS_ADMIN', 'SYS_STAFF', 'ROLE_SERVICE']);

/**
 * 确保 req.user.roles 是【业务角色】
 *
 * token 里的 roles 只有 SYS_ADMIN / SYS_STAFF，业务角色（FIN_STAFF…）
 * 的唯一权威源是权限管理模块 —— 按 account 现查一次并缓存到本请求上。
 */
async function ensureBusinessRoles(user: any): Promise<string[]> {
  if (user.__rolesResolved) return user.roles || [];
  user.__rolesResolved = true;
  const roles: string[] = user.roles || [];
  const portalOnly = roles.length === 0 || roles.every((r) => PORTAL_ONLY_ROLES.has(r));
  if (portalOnly && user.account) {
    const real = await resolveBusinessRoles(user.account);
    if (real.length) user.roles = real;
  }
  return user.roles || [];
}

/**
 * 权限校验中间件（细粒度）
 *
 * 用法：
 *   router.post('/delete/:id', checkPermission('finance:fee:delete'), handler);
 */
export function checkPermission(permissionCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    // ★ 角色兜底：token 权限是模块级粗粒度，按业务角色补齐功能点权限
    //   ★ 2026-10-07：再叠加「职位权限分配」里的**显式改动**
    //     （撤销 → 403；新增 → 放行）。未被改动过的码行为与从前**完全一致**。
    try {
      const roles = await ensureBusinessRoles(user);
      await preloadRoleActionOverrides();
      const allowed = resolveActionWithOverlay(roles, permissionCode, (role) => {
        const own = FIN_ROLE_OPERATIONS[role] || [];
        return own.includes('*') || own.includes(permissionCode);
      });
      if (allowed) {
        next();
        return;
      }
    } catch {
      // 查库失败按「无权限」处理，绝不静默放行写操作
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

/** 角色校验中间件 */
export function checkRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      unauthorized(res, '请先登录');
      return;
    }
    // ★ 同 checkPermission：token 里只有门户角色，先补成业务角色再比
    try {
      const real = await ensureBusinessRoles(user);
      if (roles.some((r) => real.includes(r))) {
        next();
        return;
      }
    } catch {
      /* 落到 403 */
    }
    res.status(403).json({
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有该操作的权限',
      data: null,
    });
  };
}

/**
 * ⭐ 系统管理员（或财务模块负责人）才能过
 *
 * 用于财务模块里「只有负责人能做」的操作，如维护费用标准。
 */
export async function requireFinanceAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user;
  if (!user) {
    unauthorized(res, '请先登录');
    return;
  }
  let roles: string[] = user.roles || [];
  try {
    roles = await ensureBusinessRoles(user);
  } catch {
    /* 用 token 里的角色兜底 */
  }
  // 统一门户的系统管理员，或财务角色（FIN_STAFF = sms_perm 里「财务」这个角色的码）
  const ok =
    user.kind === 'sys_admin' ||
    user.permissions.includes('*') ||
    roles.includes('FIN_STAFF') ||
    roles.includes(RoleCode.FINANCE) ||
    roles.includes(RoleCode.ADMIN);

  if (ok) {
    next();
    return;
  }
  res.status(403).json({
    code: BizCode.NO_OPERATION_PERMISSION,
    message: '该操作仅财务负责人可执行',
    data: null,
  });
}
