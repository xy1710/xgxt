/**
 * 鉴权中间件 · 教学管理（初高）
 *
 * ⚠️ 每个模块都必须挂这个中间件，不许自己写一套！
 *    用法（在 server-job/src/app.ts 里）：
 *      app.use('/api/class-jh/student', classJhAuth, classJhStudentRouter);
 *
 * 请求必须带：Header: Authorization: Bearer xxxxx
 *
 * ============================================================
 * ★ 2026-10-05 并入统一门户版时改写（三处，都是联调必需）
 * ============================================================
 *
 * ① **AuthUser 类型统一用主包那份**（见 `../../middleware/auth`）
 *    原来本模块自己定义了一份，`req.user` 是同一个对象却有两套类型，
 *    编译期会报「不能互相赋值」。主包那份已经包含了本模块要用的全部字段
 *    （userId / userName / roles / deptCode / dataScope / permissions / classIds）。
 *    所以本文件【不再 re-declare `declare global namespace Express`】，
 *    全局声明由主包 `src/middleware/auth.ts` 统一负责。
 *
 * ② **角色码归一化**（新旧两套码并存）
 *    本模块是老编码 `ROLE_HEAD_TEACHER`，门户/主工程是新编码 `TEACH_HEAD`。
 *    token 里带的是【新码】，不翻译的话下面所有角色判定都会落空
 *    （表象是"某人某个按钮点不动"，极难定位）。
 *    这里统一把新码翻成本模块认的老码，翻译表见 ROLE_ALIAS。
 *
 * ③ **checkPermission 支持角色兜底**
 *    本模块 66 个接口用的是自己的权限点 `class:<资源>:<动作>`，
 *    而门户权限模块里并没有注册这些权限点 → 真实登录的 token
 *    里 `permissions` 是空的，64 个写操作会全部 403。
 *    处理方式与主工程「页面级权限暂用本地清单」的既定口径一致：
 *    先认 token 里的权限点，认不到就**按角色判**（POLICIES 表）。
 */

import { Request, Response, NextFunction } from 'express';
import { BizCode, ApiResponse, DataScope, RoleCode } from 'shared-types/class-jh';
import { config } from '../config';
import { verifyToken } from '../utils/jwt';
// ★ 2026-10-05：业务角色的唯一权威源在权限管理模块 —— 复用主包的解析函数，
//   不要在本模块各写一套（门户 token 的 roles 只有门户级编码，见下方 ②'）。
import { resolveBusinessRoles, type AuthUser } from '../../middleware/auth';
// ★ 2026-10-07：接口级打通 —— 把「职位权限分配」的显式改动叠加到本模块的 POLICIES 上。
//   ⚠️ 叠加层按 **role_code（新码）** 索引，而本模块的 user.roles 是归一化后的老码
//      → 判定时用 user.businessRoles（原始新码），见 can() 内注释。
import {
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
} from '../../utils/roleActionOverlay';

// ============================================================
// ① 角色码归一化：门户新码 → 本模块老码
// ============================================================

/**
 * 新码（门户/主工程 RoleCode）→ 老码（本模块 RoleCode）
 *
 * ⚠️ 只做「一对一」的等价翻译，不做「扩权」：
 *    比如 TEACH_DEAN（学管主任，已取代教质/学术经理）= 老码 QUALITY_MGR，
 *    这是主工程当时的既定合并口径（见 shared-types/src/enums.ts 的注释）。
 */
const ROLE_ALIAS: Record<string, string> = {
  // —— 管理线 ——
  SYS_ADMIN: RoleCode.ADMIN,
  RM_PRINCIPAL: RoleCode.PRINCIPAL,
  TEACH_DEAN: RoleCode.QUALITY_MGR, // 学管主任（取代教质/学术经理）
  TEACH_QTY: RoleCode.QUALITY_MGR, // 教质经理（历史码）
  ACAD_MANAGER: RoleCode.ACADEMIC_MGR, // 学术经理（历史码）
  // —— 教学线 ——
  TEACH_HEAD: RoleCode.HEAD_TEACHER,
  TEACH_TUTOR: RoleCode.TEACHER,
  TEACH_ASSIST: RoleCode.ASSISTANT,
  // —— 协作线 ——
  ACAD_STAFF: RoleCode.EDU_ADMIN,
  JOB_STAFF: RoleCode.EMPLOYMENT,
  MKT_CONSULT: RoleCode.CONSULT,
  MKT_RECRUIT: RoleCode.RECRUIT,
};

/** 把 token 里的角色码归一化成本模块认的编码（已是老码的原样保留） */
export function normalizeRoles(roles: string[] | undefined): string[] {
  if (!Array.isArray(roles)) return [];
  const out = new Set<string>();
  for (const r of roles) {
    if (!r) continue;
    out.add(ROLE_ALIAS[r] || r);
  }
  return [...out];
}

// ============================================================
// ② 权限判定：先认 token 权限点，再按角色兜底
// ============================================================

interface Policy {
  allow: RegExp[];
  deny?: RegExp[];
}

/** 教学管理（初高）各角色的操作权限表 */
const POLICIES: Record<string, Policy> = {
  /**
   * 系统管理员 —— ⚠️ **只读**（只能看/导出，不能增删改）
   *
   *   这是全系统的既定口径：`/api/job` 那一段挂了"只读总闸"
   *   （见 src/app.ts：method 非 GET/HEAD/OPTIONS 且角色只有 SYS_ADMIN → 403）。
   *   但那个闸是按路径挂的，**管不到 /api/class-jh**；
   *   所以本模块自己在这里对齐同一口径 ——
   *   否则 admin 会在初高模块里获得别处没有的写权限，等于悄悄开了一个后门。
   *
   *   真正的写操作走业务角色（班主任 / 学管主任 / 校长…）。
   */
  [RoleCode.ADMIN]: { allow: [/(view|export)$/] },

  // 校长 —— 全权
  [RoleCode.PRINCIPAL]: { allow: [/./] },

  /**
   * 学管主任 —— ★ 2026-10-06 起改为【只读 + 仅审批】
   *
   *   业务口径：学管主任是**审批角色**（休学/复学/换人/退学/就业协议、
   *   调宿申请、退费、结业考试的审批人），除审批外只能查看。
   *
   *   原先是 `{ allow: [/./] }` 全放行 —— 因为 `ROLE_ALIAS` 把
   *   `TEACH_DEAN`（学管主任）归一化成 `QUALITY_MGR`，于是本模块
   *   **66 个接口**（含全部增删改）对他全开。
   *
   *   现在只留：
   *     · `class:*:view|export` —— 各页面的查看与导出
   *     · `class:*:approve`     —— 审批动作（approve / 驳回走的是 approve 码）
   *   写操作（add / edit / delete / promote / 发起流程）全部收回。
   *
   *   ⚠️ 同一条策略也服务历史角色码 `TEACH_QTY`（教质经理，见上面的 ROLE_ALIAS）
   *      —— 它本就是「学管」这一脉的历史写法，口径一致，无需区别对待。
   *   ⚠️ 更外层还有一道按路径生效的总闸
   *      （`src/middleware/approvalOnly.ts`），两处一起才稳。
   */
  [RoleCode.QUALITY_MGR]: {
    allow: [/^class:[a-zA-Z]+:(view|export)$/, /^class:[a-zA-Z]+:approve$/],
  },
  // 万能测试号（与主工程 SUPER_TEST_USER 对应，上线前随 DEV_MODE 一起删）
  SUPER_TEST: { allow: [/./] },

  // 学术经理 —— 审批 + 编辑，但不碰系统设置与操作日志
  [RoleCode.ACADEMIC_MGR]: {
    allow: [/:(view|export|approve|edit|add|promote)$/],
    deny: [/^class:(setting|opLog):/],
  },

  // 班主任 —— 班里的事都能办；审批 / 删除 / 系统设置不给
  [RoleCode.HEAD_TEACHER]: {
    allow: [
      /^class:(student|classInfo|attendance|exam|examScore|dorm|dormApply|fee|flow|repeat|refund|handover|setting):(view|export)$/,
      /^class:(student|attendance|exam|examScore|dorm|dormApply|fee|flow|repeat|refund):add$/,
      /^class:(student|classInfo|attendance|exam|dorm|refund):edit$/,
      // ★ 2026-10-05 升学：初高班主任把本班学生升入大学部（提交到大学部「待接收学员」）
      /^class:student:promote$/,
    ],
    deny: [/^class:opLog:/],
  },

  // 教员 / 助教 —— 只读出勤/考试，能录出勤与成绩
  [RoleCode.TEACHER]: {
    allow: [
      /^class:(student|classInfo|attendance|exam|examScore|dorm|dormApply|fee|flow|repeat|refund|setting):(view|export)$/,
      /^class:(student|attendance|exam|examScore):add$/,
      /^class:(attendance|exam|examScore):edit$/,
    ],
    deny: [/^class:opLog:/],
  },
  [RoleCode.ASSISTANT]: {
    allow: [
      /^class:(student|classInfo|attendance|exam|examScore|dorm|dormApply|fee|flow|repeat|refund|setting):(view|export)$/,
      /^class:(attendance|exam|examScore):add$/,
      /^class:(attendance|exam|examScore):edit$/,
    ],
    deny: [/^class:opLog:/],
  },

  // 教务老师 —— 管宿舍审批（调宿审批在他这），其余只读
  [RoleCode.EDU_ADMIN]: {
    allow: [
      /^class:[a-zA-Z]+:(view|export)$/,
      /^class:dormApply:(approve|add|edit)$/,
      /^class:dorm:(add|edit)$/,
    ],
  },

  // 财务 —— 退费执行 + 缴费查看
  [RoleCode.FINANCE]: {
    allow: [
      /^class:[a-zA-Z]+:(view|export)$/,
      /^class:refund:(add|edit|approve)$/,
    ],
  },

  // 就业老师 —— 只看就业协议相关
  [RoleCode.EMPLOYMENT]: {
    allow: [/^class:(student|classInfo|flow):(view|export)$/],
  },
};

/** 静态判权：某个角色（**老码**，POLICIES 的 key）是否放行某个权限点 */
export function staticAllowRole(role: string, code: string): boolean {
  const p = POLICIES[role];
  if (!p) return false;
  if (p.deny?.some((re) => re.test(code))) return false;
  return p.allow.some((re) => re.test(code));
}

/**
 * 是否放行某个权限点
 *
 * ★ 2026-10-07 起为 async：静态 POLICIES 表仍是**基线**，
 *   「职位权限分配」里对该角色的**显式改动**叠加其上
 *   （撤销 → 接口 403；新增 → 放行）。
 *   未被管理员改动过的码，行为与从前**完全一致**（差异存储，见 roleActionOverlay.ts）。
 *
 * ⚠️ 角色码口径（最容易踩的坑）：
 *   本模块的 `user.roles` 已被 `normalizeRoles` 翻成**老码**（ROLE_HEAD_TEACHER…），
 *   而权限树 `t_perm_role.role_code` 用的是**新码**（TEACH_HEAD…）
 *   → 叠加判定必须用 `user.businessRoles`（authMiddleware 挂上的原始新码），
 *     再经 `ROLE_ALIAS` 反查回老码去比对 POLICIES。
 */
export async function can(code: string, user: AuthUser | undefined): Promise<boolean> {
  if (!user) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('*') || perms.includes(code)) return true;

  /** 静态基线的判定结果 —— 也是叠加层异常时的降级目标 */
  const staticOk = (user.roles || []).some((role) => staticAllowRole(role, code));

  try {
    await preloadRoleActionOverrides();
    const overlayRoles = user.businessRoles?.length ? user.businessRoles : user.roles || [];
    return resolveActionWithOverlay(overlayRoles, code, (role) =>
      staticAllowRole(ROLE_ALIAS[role] || role, code),
    );
  } catch {
    // 降级：查不到权限树 → 退回纯静态判权（绝不误伤）
    return staticOk;
  }
}

// ============================================================
// ③ 数据范围兜底
// ============================================================

const CLASS_SCOPE_ROLES: string[] = [RoleCode.HEAD_TEACHER, RoleCode.TEACHER, RoleCode.ASSISTANT];
const SELF_SCOPE_ROLES: string[] = [RoleCode.RECRUIT, RoleCode.CONSULT];

/** token 里没给 dataScope 时，按角色推一个（宁可保守）
 *
 *  ⚠️ 2026-10-05 并入后：本模块的数据范围暂统一按 ALL 处理（见 authMiddleware 内说明），
 *     本函数暂时没有调用方；保留是为等「门户账号 ↔ 本模块用户」ID 映射接上后，
 *     再把 CLASS/DEPT 范围恢复时直接用。 */
function resolveDataScope(roles: string[], given?: number): DataScope {
  if (given !== undefined && given !== null && given >= 1 && given <= 4) return given as DataScope;
  if (roles.some((r) => r === RoleCode.ADMIN || r === RoleCode.PRINCIPAL || r === RoleCode.QUALITY_MGR)) {
    return DataScope.ALL;
  }
  if (roles.some((r) => CLASS_SCOPE_ROLES.includes(r))) return DataScope.CLASS;
  if (roles.some((r) => SELF_SCOPE_ROLES.includes(r))) return DataScope.SELF;
  return DataScope.SELF;
}

// ============================================================
// 中间件本体
// ============================================================

/** 开发模式假用户（仅在 AUTH_DEV_MODE=true 时生效） */
const DEV_USER: AuthUser = {
  userId: 'U001',
  userName: '测试用户',
  roles: [RoleCode.ADMIN],
  deptCode: 1,
  dataScope: DataScope.ALL,
  permissions: ['*'],
  classIds: [],
};

/** ★ 2026-10-05 内部入口白名单：允许跨模块服务调用（x-internal-token）的路径
 *
 *  这些路径【只】接受内部服务调用，普通用户 token 一律 401 ——
 *  避免把「开放班级清单 / 直建学生」这类接口暴露给前端。
 *  路径是相对【各自路由挂载点】的（如 classInfo 挂在 /api/class-jh/classInfo，
 *  中间件里 req.path 就是 '/open-options'，不含 '/classInfo' 段）。 */
const INTERNAL_INGRESS: RegExp[] = [
  /^\/open-options$/, // 初高开放班级（供咨询分班选择）
  /^\/upgrade-targets$/, // 大学部开放班级（供初高升学选择）
  /^\/from-consult$/, // 咨询分班 → 直接在初高班级建档
  /^\/enrolled-status$/, // ★ 2026-10-06 咨询侧查「该生是否已分进初高」（判定分班按钮可用性）
];

/** 内部服务调用时的假用户（等价主包 SYSTEM_USER；全权，路由自身不做业务权限判断） */
const SYSTEM_USER: AuthUser = {
  userId: 'system',
  userName: '系统同步',
  roles: [RoleCode.PRINCIPAL],
  deptCode: 0,
  dataScope: DataScope.ALL,
  permissions: ['*'],
  classIds: [],
  token: '',
};

/** ★ 2026-10-05 并入后改为 async：需要现查权限模块解析业务角色（见下方 ②'）。 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || '';

  // ---- ★ 2026-10-05 内部服务调用（咨询分班 / 初高升学 / 开放班级聚合）----
  //   判据：带 x-internal-token 且路径在白名单内。令牌不对 → 401。
  const internalToken = String(req.header('x-internal-token') || '');
  if (internalToken && INTERNAL_INGRESS.some((re) => re.test(req.path))) {
    if (internalToken !== config.internalToken) {
      reject(res, BizCode.UNAUTHORIZED, '内部服务凭证无效');
      return;
    }
    req.user = SYSTEM_USER;
    next();
    return;
  }

  // ---- 开发模式（仅 AUTH_DEV_MODE=true 时生效）：给个假用户，方便前端调 ----
  if (config.authDevMode && (!authHeader || authHeader === 'Bearer test')) {
    req.user = DEV_USER;
    next();
    return;
  }

  // ---- 正式逻辑：必须携带 Bearer token ----
  if (!authHeader.startsWith('Bearer ')) {
    reject(res, BizCode.UNAUTHORIZED, '请先登录');
    return;
  }

  const token = authHeader.slice(7);
  const result = verifyToken(token, config.jwt.secret);
  if (!result.ok) {
    // 过期与非法区分开，前端可据此决定「静默刷新」还是「跳登录」
    if (result.reason === 'expired') reject(res, BizCode.TOKEN_EXPIRED, '登录已过期，请重新登录');
    else reject(res, BizCode.UNAUTHORIZED, '登录凭证无效，请重新登录');
    return;
  }

  const p = result.payload;
  const kind = String(p.kind || '');
  const account = String(p.account || '');

  // ---- ★ 2026-10-05 模块门槛（并入统一门户后新增）----
  //  本模块（教学管理·初高）与「班级管理」（大学部）用的是**同一批角色码**，
  //  仅凭角色区分不出「大学部班主任」和「初高班主任」——
  //  后者在门户账号里的 modules 才带 'class-jh'。
  //  不做这一步的话：大学部班主任拿自己的合法 token 直连 /api/class-jh/* 也能读改初高数据。
  //  豁免：系统管理员 / 通配权限（它们本就该能看全部模块）。
  const mods: string[] = Array.isArray(p.modules) ? p.modules : [];
  const isSysAdmin =
    kind === 'sys_admin' ||
    (Array.isArray(p.roles) && p.roles.includes('SYS_ADMIN')) ||
    (Array.isArray(p.permissions) && p.permissions.includes('*'));
  if (!mods.includes('class-jh') && !isSysAdmin) {
    // ⚠️ 用 403 不是 401：用户是登录着的，只是没这个模块的权限。
    //    401 会让前端跳登录页，用户一脸懵（"我明明登录了"）。
    const body: ApiResponse<null> = {
      code: BizCode.NO_OPERATION_PERMISSION,
      message: '您没有访问「教学管理（初高）」模块的权限',
      data: null,
    };
    res.status(403).json(body);
    return;
  }

  // ---- ★ 2026-10-05 业务角色：现查权限管理模块（本模块最重要的一处改写）----
  //
  // 【坑】门户签发的 token 里 `roles` 只有门户级编码：
  //        SYS_ADMIN（管理员）或 SYS_STAFF（其余全部模块负责人）。
  //        真正的业务角色（校长 RM_PRINCIPAL / 班主任 TEACH_HEAD / 教务 ACAD_STAFF…）
  //        一个字都不在 token 里 —— 它们只存在于 sms_perm.t_perm_user。
  //
  // 后果（并入前的原始实现就是直接读 `p.roles`）：
  //        一个初高班主任进来，roles 被解析成 ['SYS_STAFF']，
  //        POLICIES 里没有 SYS_STAFF → can() 恒 false → **连列表都读不了**（40301/40302）。
  //
  // 做法：与主包 middleware/auth.ts 完全一致 —— 拿登录名去权限模块查真实角色，
  //       再经 normalizeRoles 翻译成本模块的老编码（ROLE_*）。
  let businessRoles: string[];
  if (kind === 'sys_admin') {
    businessRoles = ['SYS_ADMIN'];
  } else {
    businessRoles = await resolveBusinessRoles(account);
  }
  const roles = normalizeRoles(businessRoles);

  req.user = {
    userId: String(p.userId || ''),
    userName: String(p.userName || account || p.userId || ''),
    roles,
    // ★ 2026-10-07：叠加层（roleActionOverlay）按 **role_code 新码**索引，
    //   而上面的 roles 已被归一化成老码 → 这里保留一份原始业务角色码。
    businessRoles,
    // ⚠️ 数据范围暂按「全部」处理（与并入前 DEV_MODE 的演示口径一致）：
    //    门户账号 ID 与本模块班级表 head_teacher_id 是两套 ID，算不出「我带的班」，
    //    先不过滤（否则初高班主任会因为 dept/班级过滤看到空列表）。
    //    细化到 CLASS/DEPT 范围留待「门户账号 ↔ 本模块用户」映射接上后再做。
    deptCode: 0,
    dataScope: DataScope.ALL,
    // ⚠️ 故意【不下发 token.permissions】：
    //    本模块 66 个接口用的是自己的权限点 `class:<资源>:<动作>`，
    //    门户权限模块里并没有注册它们（token 里只有 'module:class-jh' 这种），
    //    若原样透传反而无用；权限判定统一交给 can() 的 POLICIES 角色兜底表。
    //    —— 系统管理员的「只读」也正靠这张表（POLICIES[ADMIN] = 只允许 view/export）。
    permissions: [],
    classIds: [],
    token,
  };
  next();
}

/** 统一的未授权响应（401，前端据此跳登录页） */
function reject(res: Response, code: BizCode, message: string): void {
  const body: ApiResponse<null> = { code, message, data: null };
  res.status(401).json(body);
}

/**
 * 权限校验中间件（细粒度）
 *
 * 用法：
 *   router.post('/delete/:id', checkPermission('class:student:delete'), handler);
 */
export function checkPermission(permissionCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      const body: ApiResponse<null> = { code: BizCode.UNAUTHORIZED, message: '请先登录', data: null };
      res.status(401).json(body);
      return;
    }

    // ★ 2026-10-07：can 已改 async（叠加「职位权限分配」的显式改动）
    if (await can(permissionCode, user)) {
      next();
      return;
    }

    // ⚠️ 已登录但无权限 → 403（不是 401！）
    //    401 会让前端跳登录页，用户会一脸懵：我明明登录了
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
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
