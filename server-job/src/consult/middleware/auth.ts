/**
 * ⚠️ 本文件改造自骨架的 middleware/auth.ts
 *
 * 改动点（与骨架的差异）：
 *   1. 【新增】真实登录：按 Authorization: Bearer <token> 还原用户身份
 *   2. 【★本轮新增】三方清单第三节：token 改为 JWT，里面带
 *       userId / roles / permissions / dataScope 4 个字段
 *   3. 【新增】checkRole / requireManager / requireAdmin：按岗位角色限制操作
 *   4. 【保留】DEV_MODE：无 token 时给假管理员，方便开发/测试直连接口
 *   5. 【保留】checkPermission：兼容骨架里已有的权限码调用方式
 *   6. 【保留】老 token（裸 accountId）兼容 —— 见 authMiddleware 里的注释
 *
 * ⚠️ 为什么现在改用 JWT？
 *    2026-10-02 三方清单要求：登录时调权限模块拿权限、写进 token，
 *    让「各业务模块（含实训 8004）从 token 里就能解出角色/权限」。
 *    裸 accountId 装不下这 4 个字段，必须换成自描述的结构。
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse, RoleCode, DataScope, ConsultRole, CONSULT_ROLE_NAME } from 'shared-types/consult';
import { db } from '../utils/db';
import { verifyToken, looksLikeJwt } from '../utils/jwt';
import type { JwtPayload } from '../utils/jwt';
// ★ 2026-10-06：本地账号表缺失时，按门户账号 × sms_perm 角色现推岗位
import { resolveConsultRoleFromPerm, portalAccountOf } from '../services/perm-roles';
// ★ 2026-10-07：接口级打通 —— 把「职位权限分配」的显式改动叠加到咨询模块的接口上。
//   本模块原本只按岗位角色（requireManager / requireAdmin）判权，不认权限树；
//   现在写接口会额外核对 market 模块对应的权限点。
import { resolveBusinessRoles } from '../../middleware/auth';
import {
  getOverrideSync,
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
} from '../../utils/roleActionOverlay';

/** 挂到 req 上的用户信息 */
export interface AuthUser {
  /* ---- ⭐ 三方清单要求的 4 个字段（各业务模块统一读这几个）---- */
  /** 用户 id（权限模块口径，如 U013） */
  userId: string;
  /** 角色编码数组（统一后的新编码，如 ['MKT_CONSULT']） */
  roles: string[];
  /** 权限点数组（如 ['consult:学生管理:view']） */
  permissions: string[];
  /** 数据范围：1 本人 / 2 本班 / 3 本部门 / 4 全部 */
  dataScope: DataScope;

  /* ---- 本模块扩展字段 ---- */
  /** 姓名 */
  userName: string;
  deptCode?: number;
  accountId: string;
  account: string;
  /** 本模块岗位角色（admin/manager/consult/finance） */
  role: ConsultRole;
  roleTitle: string;
  dept?: string;
  /** 是否经理（含 admin，便于审批逻辑判断） */
  isManager: boolean;
  /** 是否管理员 */
  isAdmin: boolean;
  /** ⭐ 是否用「本地兜底权限」签发（权限模块 8006 没连上时为 true） */
  permDegraded?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

// ============================================================
// ★ 2026-10-05 合并：DEV_MODE 关闭。
//   门户是唯一登录入口；不带 token 的请求必须被拒绝，
//   不能再给「假管理员」——否则未登录即可读写咨询业务数据。
// ============================================================
const DEV_MODE = false;

const DEV_USER: AuthUser = {
  userId: 'dev-admin',
  roles: [RoleCode.SYS_ADMIN],
  permissions: ['*'],
  dataScope: DataScope.ALL,

  userName: '开发调试账号',
  deptCode: 1,
  accountId: 'dev-admin',
  account: 'dev-admin',
  role: ConsultRole.ADMIN,
  roleTitle: '系统管理员',
  dept: '信息中心',
  isManager: true,
  isAdmin: true,
  permDegraded: false,
};

/**
 * ⭐ 由账号行构造 AuthUser（老路径：裸 accountId token 用）
 *
 * ⚠️ 本模块岗位角色 → 三方统一角色编码 的映射。
 *    这是「权限模块没连上」时的兜底口径，务必与统一编码表一致，
 *    否则别的模块拿到 token 仍然认不出来。
 */
const CONSULT_ROLE_TO_ROLE_CODE: Record<string, RoleCode> = {
  [ConsultRole.ADMIN]: RoleCode.SYS_ADMIN,
  [ConsultRole.MANAGER]: RoleCode.MKT_CONSULT,
  [ConsultRole.CONSULT]: RoleCode.MKT_CONSULT,
};

/** 由账号行造一份「本地兜底权限」的 payload（权限模块没连上时用） */
export function buildFallbackPayload(row: any): JwtPayload {
  const role = row.role as ConsultRole;
  const code = CONSULT_ROLE_TO_ROLE_CODE[role] || RoleCode.MKT_CONSULT;
  return {
    userId: row.id,
    roles: [code],
    permissions: role === ConsultRole.ADMIN ? ['*'] : [`consult:${role}:*`],
    dataScope: role === ConsultRole.CONSULT ? DataScope.SELF : DataScope.ALL,
    userName: row.user_name,
    accountId: row.id,
    account: row.account,
    consultRole: role,
    degraded: true,
  };
}

/**
 * ★ 2026-10-06：本地账号表查不到时，用「门户账号 × sms_perm 角色」合成一条等价账号行
 *
 * 返回的对象刻意与 `t_consult_account` 的行**同构**（account / user_name / role /
 * role_title / active），这样 `toAuthUserFromToken` 不用改一行就能正确识别岗位。
 * 认不出来（权限库没这个人）时返回 null → 仍按原有最保守口径走。
 */
async function synthesizeRowFromPerm(
  payload: JwtPayload,
): Promise<Record<string, unknown> | null> {
  const account = String(payload.account || '');
  if (!account) return null;
  try {
    const role = await resolveConsultRoleFromPerm(account);
    if (!role) return null;
    const portal = await portalAccountOf(account);
    return {
      // ⚠️ 故意不填 id：门户账号 id 与 t_consult_account.id 不是一个体系，
      //    填了会被下游当成「本模块账号主键」误用。accountId 仍取 token 里的值。
      account,
      user_name: portal?.userName || payload.userName || account,
      role,
      role_title: portal?.title || CONSULT_ROLE_NAME[role] || '',
      active: 1,
      // 标记来源，便于排查（不进 AuthUser，仅调试可见）
      __synthetic: true,
    };
  } catch {
    return null;
  }
}

/** 由账号行构造 AuthUser */
export function toAuthUser(row: any): AuthUser {  const role = row.role as ConsultRole;
  return {
    userId: row.id,
    roles: role === ConsultRole.ADMIN ? [RoleCode.SYS_ADMIN] : [],
    permissions: role === ConsultRole.ADMIN ? ['*'] : [`consult:${role}:*`],
    dataScope: ConsultRole.CONSULT === role ? DataScope.SELF : DataScope.ALL,

    userName: row.user_name,
    deptCode: 1,
    accountId: row.id,
    account: row.account,
    role,
    roleTitle: row.role_title || '',
    dept: row.dept || undefined,
    isManager: role === ConsultRole.MANAGER || role === ConsultRole.ADMIN,
    isAdmin: role === ConsultRole.ADMIN,
    permDegraded: false,
  };
}

/**
 * ⭐ 由 JWT payload 构造 AuthUser（新路径：三方清单口径）
 *
 * ⚠️ 关键：roles / permissions / dataScope【直接信 token 里的值】，
 *    因为那是权限模块发的，是「户口本」。本模块不再自己猜。
 *
 * ⚠️ 但仍要用 accountId 回查本模块账号表，确认「账号还有效、没被停用」——
 *    token 是 7 天有效期的，期间管理员可能已把这人停用了。
 */
function toAuthUserFromToken(payload: JwtPayload, row: any): AuthUser {
  const role = (row?.role ?? payload.consultRole ?? ConsultRole.CONSULT) as ConsultRole;
  return {
    // ---- ⭐ 4 个字段：一律以 token 为准 ----
    userId: payload.userId || row?.id || '',
    roles: payload.roles || [],
    permissions: payload.permissions || [],
    dataScope: (payload.dataScope ?? DataScope.ALL) as DataScope,

    // ---- 本模块字段：以库里最新数据为准 ----
    userName: row?.user_name || payload.userName || '',
    deptCode: 1,
    accountId: payload.accountId || row?.id || '',
    account: payload.account || row?.account || '',
    role,
    roleTitle: row?.role_title || '',
    dept: row?.dept || undefined,
    isManager: role === ConsultRole.MANAGER || role === ConsultRole.ADMIN,
    isAdmin: role === ConsultRole.ADMIN || (payload.permissions || []).includes('*'),
    permDegraded: !!payload.degraded,
  };
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization || '';

  // ---- 无 token / test token → 假用户（开发期）----
  if (!authHeader || authHeader === 'Bearer test') {
    if (DEV_MODE) {
      req.user = DEV_USER;
      next();
      return;
    }
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }

  const token = authHeader.slice(7).trim();

  // ============================================================
  // ⭐ 三方清单口径：token 是 JWT（三段式 xxx.yyy.zzz）
  // ============================================================
  if (looksLikeJwt(token)) {
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({
        code: BizCode.UNAUTHORIZED,
        message: '登录已过期，请重新登录',
        data: null,
      });
      return;
    }

    try {
      // ⚠️⚠️ 2026-10-02 门户改造后的关键分支：
      //
      //  token 可能来自两个地方，accountId 的含义完全不同：
      //    ① 本模块自己登录页签发的 → accountId 是 t_consult_account.id
      //    ② 统一门户签发的        → accountId 是 t_sys_account.id
      //
      //  所以【不能只按 id 查】。门户 token 要改用 account（登录名）回查本模块账号，
      //  否则查不到 → role 会静默降级成「咨询师」，
      //  管理员在咨询模块里就看不到审批中心了（一个非常隐蔽的权限 bug）。
      let row: any = null;

      if (payload.accountId) {
        row = await db('t_consult_account')
          .where({ id: payload.accountId, is_deleted: false })
          .first();
      }

      // 门户签发的 token：accountId 对不上本模块，退回用登录名匹配
      if (!row && payload.account) {
        row = await db('t_consult_account')
          .where({ account: payload.account, is_deleted: false })
          .first();
      }

      /**
       * ★★ 2026-10-06 关键兜底：本地账号表查不到 → 按【门户账号 × sms_perm 角色】现推岗位
       *
       * 背景：全量重建（seed:all）清空了业务库，`t_consult_account` 没有重新播种
       *   → 每个请求 row 都是空的 → 岗位静默降级成「咨询师」→
       *     · 「分配咨询老师」下拉无数据
       *     · 经理点「分配 / 审批」被 checkRole(MANAGER) 一律 403
       * 口径与班级模块 staffFromAccounts 一致：谁是经理/咨询师看 sms_perm 的角色码。
       */
      if (!row && payload.account) {
        row = await synthesizeRowFromPerm(payload);
      }

      if (row && !row.active) {
        res.status(401).json({
          code: BizCode.ACCOUNT_DISABLED,
          message: '该账号已停用，请联系系统管理员',
          data: null,
        });
        return;
      }

      req.user = toAuthUserFromToken(payload, row);
      next();
    } catch (err) {
      next(err);
    }
    return;
  }

  // ============================================================
  // 兼容老 token：前端 localStorage 里可能还存着裸 accountId
  // ============================================================
  try {
    const row = await db('t_consult_account')
      .where({ id: token, is_deleted: false })
      .first();

    if (!row) {
      res.status(401).json({
        code: BizCode.UNAUTHORIZED,
        message: '登录已过期，请重新登录',
        data: null,
      });
      return;
    }

    if (!row.active) {
      res.status(401).json({
        code: BizCode.ACCOUNT_DISABLED,
        message: '该账号已停用，请联系系统管理员',
        data: null,
      });
      return;
    }

    req.user = toAuthUser(row);
    next();
  } catch (err) {
    next(err);
  }
}

/* ============================================================
 * 权限校验
 * ============================================================ */

/** 权限失败响应（⚠️ 已登录但无权限 → 403，不是 401） */
function deny(res: Response, message: string): void {
  const body: ApiResponse<null> = {
    code: BizCode.NO_OPERATION_PERMISSION,
    message,
    data: null,
  };
  res.status(403).json(body);
}

const ROLE_LABEL: Record<string, string> = {
  admin: '系统管理员',
  manager: '咨询经理',
  consult: '咨询师',
};

/**
 * 限定岗位角色
 *
 * 用法：router.post('/assign', checkRole(ConsultRole.MANAGER), handler)
 */
export function checkRole(...roles: ConsultRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
      return;
    }
    if (user.isAdmin || roles.includes(user.role)) {
      next();
      return;
    }
    deny(res, `该操作仅限「${roles.map((r) => ROLE_LABEL[r] || r).join('、')}」执行`);
  };
}

/** 必须是经理（含管理员） */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }
  if (user.isManager) {
    next();
    return;
  }
  deny(res, '该操作仅限「咨询经理」执行');
}

/** 必须是管理员 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }
  if (user.isAdmin) {
    next();
    return;
  }
  deny(res, '该操作仅限「系统管理员」执行');
}

/**
 * 兼容骨架的权限码校验
 *
 * ⚠️ 本模块的权限模型是「按岗位角色」，不是细粒度权限码。
 *    保留这个函数是为了不破坏骨架约定的调用写法（旧代码继续能跑）。
 */
export function checkPermission(permissionCode: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
      return;
    }
    if (user.permissions.includes('*') || user.permissions.includes(permissionCode)) {
      next();
      return;
    }
    deny(res, '您没有该操作的权限');
  };
}

/* ============================================================
 * ★ 2026-10-07 接口级打通：咨询模块的「权限点 → 接口」守卫
 *
 * 【背景】
 *   咨询模块 28 个写接口只按**岗位角色**判权（requireManager / requireAdmin），
 *   而「职位权限分配」维护的是 **market 模块的功能点 × 动作**（如 学生档案·新增）。
 *   两者粒度不同 → 管理员在权限树里取消了某动作，接口照样通。
 *
 * 【做法】
 *   权限树 market 模块的 7 个功能点已全部映射到 `consult:{资源}:{动作}` 操作码
 *   （见 src/utils/roleActionOverlay.ts 的映射表），这里按操作码反查：
 *     · 该动作被【显式撤销】 → 403
 *     · 被【显式授权】       → 放行
 *     · 岗位角色门禁（requireManager 等）**不变**，两道闸串联，都过才放行
 *
 * ⚠️ 与 class / class-jh / finance 一样是「差异存储」语义：
 *    管理员没动过的动作 → 行为与从前**完全一致**（不会突然多拦）。
 *
 * 用法：requireMarketAction('学生档案', 'add')
 * ============================================================ */

/** 门户级角色码 —— 只有这些说明 token 里没有业务角色，需要回查权限库 */
const PORTAL_ONLY_ROLES = new Set(['SYS_STAFF', 'ROLE_SERVICE']);

/** 取该用户的业务角色码（role_code，如 MKT_CONSULT），带请求内缓存 */
async function consultBusinessRoles(user: any): Promise<string[]> {
  if (user && Array.isArray(user.__bizRoles)) return user.__bizRoles;
  const roles: string[] = Array.isArray(user?.roles) ? user.roles : [];
  const portalOnly = roles.length === 0 || roles.every((r) => PORTAL_ONLY_ROLES.has(r));
  let out = roles;
  if (portalOnly && user?.account) {
    try {
      const real = await resolveBusinessRoles(String(user.account));
      if (real.length) out = real;
    } catch {
      /* 查不到就用 token 里的 */
    }
  }
  if (user) user.__bizRoles = out;
  return out;
}

/* ============================================================
 * ★ 2026-10-07 咨询模块的【写接口总闸】
 *
 *   上面那个 `requireMarketAction` 需要逐个路由挂（28 处，改动面大）。
 *   这里改成**按路径集中映射**：在 app.ts 的 6 个 consult 挂载点里插一道中间件即可，
 *   新增接口只要在下面这张表里补一行。
 *
 *   ⚠️ 只拦【写方法】（POST/PUT/PATCH/DELETE）；GET 一律放行。
 *   ⚠️ **未登记的路径 → 不干预**（沿用原有的岗位角色判权），所以这张表是白名单式增量。
 *   ⚠️ 同样是「差异存储」语义：管理员没动过的动作，行为与从前完全一致。
 * ============================================================ */

/**
 * 写接口 → 权限树撤销时要检查的【操作码】候选（**任一**未被撤销即放行）
 *
 * ⚠️⚠️ 这里必须写**操作码**（`consult:{资源}:{动作}`），不能写权限树的
 *     (中文功能点, 动作) —— 那样拼出来是 `consult:学生档案:add`，
 *     与 roleActionOverlay 映射表里登记的 `consult:student:add` 对不上，
 *     会静默失效（表现：权限取消了但接口照样通，极难排查）。
 *
 *     对照关系（src/utils/roleActionOverlay.ts 的 PERM_POINT_TO_ACTION_CODES）：
 *       market||学生档案·add        → consult:student:add
 *       market||学生档案·edit       → consult:student:edit
 *       market||预到校名单·assignConsult → consult:preArrival:assign
 *       market||预到校名单·markAbsent    → consult:preArrival:absent
 *       market||咨询测试·entryInterview  → consult:test:interview
 *       market||跟进记录·add         → consult:follow:add
 *       market||缴费·entryTrialFee   → consult:fee:trial
 *       market||缴费·entryFormalFee  → consult:fee:formal
 *       market||退费·submitApply     → consult:refund:apply
 *       market||退费·approve         → consult:refund:approve
 */
const CONSULT_WRITE_PERM: Record<string, string[]> = {
  /* ---- 学生 ---- */
  '/api/consult/student/add': ['consult:student:add'],
  '/api/consult/student/update-extra': ['consult:student:edit'],
  '/api/consult/student/assign-class': ['consult:student:edit'],
  '/api/consult/student/loss': ['consult:student:edit'],
  '/api/consult/student/enroll-to-class': ['consult:student:edit'],
  /* ---- 预到校名单 ---- */
  '/api/consult/student/assign': ['consult:preArrival:assign'],
  '/api/consult/student/claim': ['consult:preArrival:assign'],
  '/api/consult/student/not-enrolled': ['consult:preArrival:absent'],
  /* ---- 咨询测试 ---- */
  '/api/consult/student/interview': ['consult:test:interview'],
  '/api/consult/student/interview-result': ['consult:test:interview'],
  /* ---- 跟进记录 ---- */
  '/api/consult/student/revisit': ['consult:follow:add'],
  /* ---- 缴费 ---- */
  '/api/consult/student/to-formal': ['consult:fee:formal'],
  '/api/consult/fee/create': ['consult:fee:trial', 'consult:fee:formal'],
  '/api/consult/fee/upload-voucher': ['consult:fee:trial', 'consult:fee:formal'],
  '/api/consult/fee/resubmit': ['consult:fee:trial', 'consult:fee:formal'],
  /* ---- 退费 ---- */
  '/api/consult/refund/apply': ['consult:refund:apply'],
  '/api/consult/refund/approve': ['consult:refund:approve'],
  '/api/consult/refund/reject': ['consult:refund:approve'],
  '/api/consult/refund/pay': ['consult:refund:apply'],
};

/** 咨询模块写接口总闸；用法见 app.ts —— 挂在 consultAuth 之后、业务 router 之前
 *
 * ⚠️ 会在响应头留下 `X-Consult-Perm-Gate`（skip / miss / allow / deny / error），
 *    排查「为什么没拦住」时直接看这个头即可。
 */
export async function consultPermGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }

  // 只读方法 / 通配权限 → 直接过
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    res.setHeader('X-Consult-Perm-Gate', 'skip-readonly');
    next();
    return;
  }
  if (user.permissions.includes('*')) {
    res.setHeader('X-Consult-Perm-Gate', 'skip-wildcard');
    next();
    return;
  }

  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  const candidates = CONSULT_WRITE_PERM[pathname];
  if (!candidates) {
    res.setHeader('X-Consult-Perm-Gate', 'miss');
    next(); // 未登记 → 不干预
    return;
  }

  try {
    const roles = await consultBusinessRoles(user);
    await preloadRoleActionOverrides();
    const ok = candidates.some((code) =>
      resolveActionWithOverlay(roles, code, () => true),
    );
    const hitCount = roles.filter((r) => !!getOverrideSync(r)).length;
    res.setHeader(
      'X-Consult-Perm-Gate',
      ok
        ? `allow(roles=${roles.join('|') || '空'};ov=${hitCount}/${roles.length})`
        : `deny(roles=${roles.join('|') || '空'})`,
    );
      if (!ok) {
        deny(res, `该操作已被取消：权限点「${candidates.join('」或「')}」未授权给您的角色`);
        return;
      }
  } catch {
    res.setHeader('X-Consult-Perm-Gate', 'error');
    /* 降级：权限库抖动 → 放行 */
  }
  next();
}

/**
 * 咨询模块的权限点守卫（单路由版）—— 直接传**操作码**
 *
 * @param actionCode 如 `consult:student:add`（取值必须与 roleActionOverlay
 *                   映射表里登记的完全一致，见 CONSULT_WRITE_PERM 上方注释）
 *
 * ⚠️ 日常优先用 `consultPermGate`（按路径集中映射，只需在 app.ts 挂一次）。
 */
export function requireActionCode(actionCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
      return;
    }
    // 通配权限（系统管理员）不受权限树收窄影响
    if (user.permissions.includes('*')) {
      next();
      return;
    }

    try {
      const roles = await consultBusinessRoles(user);
      await preloadRoleActionOverrides();
      /** 静态默认放行 —— 岗位门禁由外层 requireManager / requireAdmin 负责 */
      const ok = resolveActionWithOverlay(roles, actionCode, () => true);
      if (!ok) {
        deny(res, `该操作已被取消：权限点「${actionCode}」未授权给您的角色`);
        return;
      }
    } catch {
      /* 降级：权限库抖动 → 放行，绝不误伤正常业务 */
    }
    next();
  };
}
