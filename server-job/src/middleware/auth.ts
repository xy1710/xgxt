/**
 * 鉴权中间件
 *
 * ⚠️ 每个模块都必须挂这个中间件，不许自己写一套！
 *    如果 8 个模块各写一套，只要有一个忘了校验，整个系统就被击穿了。
 *
 * 用法（在 app.ts 里）：
 *   app.use('/api/consult', authMiddleware, consultRouter);
 *
 * 请求必须带：Header: Authorization: Bearer xxxxx
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { BizCode, ApiResponse, RoleCode, DataScope } from 'shared-types';
// ⚠️ 主包 RoleCode 的【枚举名】与班级包不一致（主包 SYS_ADMIN，班级包 ADMIN）。
//   下面这张别名表要用班级的枚举名，所以单独引一份并改名，别混着用。
import { RoleCode as ClassRoleCode } from 'shared-types/class';
import { getUserOperationPermissions } from '../utils/pagePermissionSource';
// ★ 2026-10-08：加载「自建角色 → 内置角色」等价声明（自建角色能发起/审批单据的前提）
import { ensureRoleEquivLoaded } from '../utils/roleEquiv';
import { config } from '../config';
// ★ 2026-10-14：跨服务调用统一走公共 axios 封装（技术选型表：跨服务调用 = axios）
import { remoteGet } from '../shared/http';

/** 把用户信息挂到 req 上，方便路由里用 */
export interface AuthUser {
  userId: string;
  userName: string;
  roles: string[];
  /**
   * ★ 2026-10-04 班级模块并入时：由「可选」改为**必填**。
   *   班级的 `dataScope.ts` 等代码直接读 `user.deptCode`（不带兜底），
   *   类型上必须是 number 才能通过编译。
   */
  deptCode: number;
  dataScope: DataScope;
  /** 该用户拥有的权限标识，如 ['consult:student:view', 'consult:student:add'] */
  permissions: string[];
  /**
   * ★ 2026-10-07 新增：**业务角色的原始码**（未经过任何模块的本地翻译）。
   *
   *   为什么需要它：各 legacy 模块有自己的老角色码（如初高模块把
   *   `TEACH_HEAD` 翻成 `ROLE_HEAD_TEACHER`），而「权限树」
   *   （`sms_perm.t_perm_role.role_code`）用的是**无前缀新码**。
   *   要让「职位权限分配」的改动叠加到接口判权上，必须拿得到新码。
   *
   *   —— 由各模块的 authMiddleware 在解析业务角色时顺手挂上（`resolveBusinessRoles` 的返回值）。
   */
  businessRoles?: string[];
  /**
   * ★ 2026-10-04 班级模块并入时新增：
   *   该用户【负责的班级 ID 列表】（班主任/教员/助教按此做数据范围过滤）。
   *   由 class/middleware/auth.ts 查 sms_class.t_class_info 补上；
   *   非班级角色给空数组。
   */
  classIds: string[];
  /** 原始 token（跨模块调用时透传用；班级代码暂未使用） */
  token?: string;
  /**
   * ★ 2026-10-06 门户下发的【可见模块】列表（job / edu / class / class-jh /
   *   consult / finance / perm）。
   *
   *   它是**模块级**权威口径，与 roles（页面级）叠加使用：
   *   页面权限守卫据此判断「这个模块有没有授权给我」——
   *   典型场景：权限管理员 linx 门户只授权 perm，但在 sms_perm 挂了系统管理员
   *   角色（页面全开），没有这道门槛它就能看到并进入全部业务板块。
   *
   *   ⚠️ 老 token（未带 modules）或系统管理员解析路径下可能为空 ——
   *      消费方必须把「空」当作「无模块信息、不拦」，不能当「无权限」。
   */
  modules?: string[];
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
// 【临时方案】开发阶段用假 token
//
// ⚠️ 说明：真正的 JWT 校验要在「登录模块（王寒逸）」做好之后接入。
//    现在先用假 token 让大家的服务能跑起来，不阻塞开发。
//
// 测试方式：
//   Header: Authorization: Bearer test
//     → 给一个【管理员】假用户（全权限）
//
//   Header: Authorization: Bearer test-ROLE_TEACHER
//     → 给一个【教员】假用户（用来测试权限拦截！）
//     角色码见 shared-types 的 RoleCode
// ============================================================
// ★ 2026-10-05 合并：DEV_MODE 关闭 —— 门户是唯一登录入口，
//   未带 token / 带 test 假令牌的请求一律按未登录处理（见下方「正式逻辑」）。
const DEV_MODE = false;

/**
 * ★★ 万能测试号（2026-10-04 斌哥要，用于「权限还没接进来，先验证业务连通性」）
 *
 * 【为什么要有】
 *   权限管理（8006）还没接进来，而各模块的菜单/按钮/数据范围都挂在权限上。
 *   斌哥要一个「能进所有页面、能做所有操作、能看所有数据」的号，
 *   专门用来**验证业务逻辑本身通不通**（表单能不能提交、下一步有没有数据…）。
 *
 * 【怎么做到的 —— 三道关卡全放行】
 *   ① 页面闸 requirePage / requireAnyPage
 *      → 判 `permissions.includes('*')` 就放行（这行本来就写好了，从没被用上过）
 *   ② 按钮闸 checkPermission
 *      → 同样判 `permissions.includes('*')`（本来就写好了）
 *   ③ 全局只读闸（app.ts）
 *      → 只拦「纯 SYS_ADMIN」，所以**不能**给 SYS_ADMIN，
 *         否则写操作全被拦。用一个不存在的角色码 SUPER_TEST 就绕开了。
 *   ④ 数据范围 stageScope
 *      → stageOfRoles() 认不出 SUPER_TEST → 返回 'all' → 不过滤
 *   ⑤ 前端菜单 / 路由守卫
 *      → getMyPages 里 `permissions.includes('*')` → 下发全部页面
 *
 * 【怎么用】
 *   后端：Authorization: Bearer test-SUPER_TEST
 *   前端：登录页选「万能测试号（验证业务用）」
 *
 * ⚠️⚠️ 千万注意：这是**演示/验证专用号，不是真实角色**。
 *   · 上线前必须删掉 DEV_MODE（连带这个号一起失效）
 *   · 别拿它演示「权限拦住了没有」—— 它本来就什么都不拦
 *   · 真实登录做好后，它应该自然消失（那时走的是真 JWT，不经过 parseDevRole）
 */
export const SUPER_TEST_ROLE = 'SUPER_TEST';

const SUPER_TEST_USER: AuthUser = {
  userId: 'U_SUPER_TEST',
  userName: '万能测试号',
  roles: [SUPER_TEST_ROLE],
  deptCode: 1,
  dataScope: DataScope.ALL,
  // ★ 这一颗星就是全部魔法所在：页面闸、按钮闸、getMyPages 都认它
  permissions: ['*'],
  // 交给他所有班（stageScope 是 'all'，这个字段实际用不上，留空更安全）
  classIds: [],
};

const DEV_USER: AuthUser = {
  userId: 'U001',
  userName: '测试用户',
  roles: [RoleCode.SYS_ADMIN],
  deptCode: 1,
  dataScope: DataScope.ALL,
  permissions: ['*'],
  classIds: [],
};

/**
 * ★ 旧角色码 → 新角色码 别名表（2026-10-04 角色编码统一为「无前缀」时加）
 *
 * 【为什么需要】
 *   演示令牌是手写的字符串（`test-ROLE_PRINCIPAL`），而 `parseDevRole` 会拿它
 *   去比 `RoleCode` 的**值**。角色码统一后校长的值从 `ROLE_PRINCIPAL` 改成了
 *   `RM_PRINCIPAL`，于是所有旧令牌比不中→ parseDevRole 返回 null
 *   → 落到下面的「正式逻辑」→ 拿 DEV_USER 兜底（**只读管理员**）
 *   → 写请求被全局闸拦成40302。
 *
 *   表象是「校长点升实训说没权限」，实际是令牌过期了。
 *   所以这里把旧码认回来，不改角色码本身（改了要动110 处引用）。
 *
 * ⚠️ 只做别名映射，**不做降级** —— 别名表里没有的一律当非法令牌处理。
 */
const LEGACY_ROLE_ALIAS: Record<string, string> = {
  ROLE_ADMIN: ClassRoleCode.ADMIN,
  ROLE_SYS_ADMIN: ClassRoleCode.ADMIN,
  ROLE_PRINCIPAL: ClassRoleCode.PRINCIPAL,
  ROLE_RECRUIT: ClassRoleCode.RECRUIT,
  ROLE_CONSULT: ClassRoleCode.CONSULT,
  MKT_RECRUIT: ClassRoleCode.RECRUIT,
  MKT_CONSULT: ClassRoleCode.CONSULT,
  ROLE_HEAD_TEACHER: ClassRoleCode.HEAD_TEACHER,
  ROLE_TEACHER: ClassRoleCode.TEACHER,
  ROLE_ASSISTANT: ClassRoleCode.ASSISTANT,
  TEACHER_HEAD: ClassRoleCode.HEAD_TEACHER,
  TEACHER_TUTOR: ClassRoleCode.TEACHER,
  TEACHER_ASSIST: ClassRoleCode.ASSISTANT,
  ROLE_QUALITY_MGR: ClassRoleCode.QUALITY_MGR,
  ROLE_ACADEMIC_MGR: ClassRoleCode.ACADEMIC_MGR,
  ROLE_EDU_ADMIN: ClassRoleCode.EDU_ADMIN,
  ROLE_FINANCE: ClassRoleCode.FINANCE,
  ROLE_EMPLOYMENT: ClassRoleCode.EMPLOYMENT,
  JOB_TEACHER: ClassRoleCode.EMPLOYMENT,
};

/**
 * 【开发调试用】按 token 后缀模拟不同角色
 *
 * 用法：Bearer test-TEACH_HEAD → 以「班主任」身份访问
 *      Bearer test-TEACH_HEAD@T001 → 以「真人 T001」的身份进入
 *
 * ⚠️ 这【只在开发模式】生效，正式环境必须删掉或关掉 DEV_MODE。
 *    它的用途是：在登录模块做好之前，能测「权限拦截对不对」。
 */
function parseDevRole(token: string): AuthUser | null {
  // 形如 "test-TEACH_HEAD" 或 "test-TEACH_HEAD@T001"
  //
  // ★ 2026-09-30 新增 @ 后缀 ——「以哪个真人的身份进入」
  //
  // 【为什么需要】
  //   不带 @ 时 userId 是角色级的假 ID（`U_TEACH_HEAD`），
  //   而班级表里的班主任是**真人 ID**（如 `T001`）。
  //   凡是「按本人过滤」的逻辑（我带的班 / 我发起的催费），两头对不上 → 查成空。
  //   演示时想在"某个具体班主任"视角下看数据，就在这里带上他的 ID。
  //
  // ⚠️ 2026-10-04：角色码统一为无前缀（校长 = RM_PRINCIPAL，不是 ROLE_PRINCIPAL）。
  //   旧令牌靠 LEGACY_ROLE_ALIAS 认回来；两套都不认的**直接判非法**，
  //   绝不静默降级成 DEV_USER（降级会让「令牌写错」变成「权限不足」，极难排查）。
  if (!token.startsWith('test-')) return null;

  // ★ 万能测试号：唯一一个不走角色码校验的（SUPER_TEST 不是真角色）
  const raw = token.slice('test-'.length).trim();
  if (raw.toUpperCase() === SUPER_TEST_ROLE) {
    return { ...SUPER_TEST_USER, classIds: [] };
  }

  const atIndex = raw.indexOf('@');
  const rolePart = (atIndex >= 0 ? raw.slice(0, atIndex) : raw).trim().toUpperCase();
  const asUser = atIndex >= 0 ? raw.slice(atIndex + 1).trim() : '';

  const validRoles = Object.values(RoleCode) as string[];
  // 先按新码认，再按旧码别名认
  const role = validRoles.includes(rolePart)
    ? rolePart
    : LEGACY_ROLE_ALIAS[rolePart] || null;
  if (!role) return null;

  return {
    userId: asUser || 'U_' + role,
    userName: asUser ? `测试用户·${role}（${asUser}）` : '测试用户·' + role,
    roles: [role],
    deptCode: 1,
    dataScope: DataScope.SELF,
    // ⚠️ 故意给空权限 —— 让 requirePage 去查角色对应的页面权限
    permissions: [],
    // 班级模块要用：负责的班级列表（由 class/middleware/auth.ts 查库补上）
    classIds: [],
  };
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || '';

  // ---- 开发阶段：没带 token 也给个假用户，方便前端调 ----
  if (DEV_MODE && (!authHeader || authHeader === 'Bearer test')) {
    req.user = DEV_USER;
    next();
    return;
  }

  // ---- 开发阶段：Bearer test-XXX 模拟指定角色 ----
  if (DEV_MODE && authHeader.startsWith('Bearer test-')) {
    const token = authHeader.slice(7);
    const user = parseDevRole(token);
    if (user) {
      req.user = user;
      next();
      return;
    }

    //⚠️ 2026-10-04：这里**必须直接报错**，不能往下走。
    //   以前是让 parseDevRole 返回 null → 落到「正式逻辑」→ 拿 DEV_USER（只读管理员）
    //   兜底 → 用户看到的是「40302 无权限」，真实原因却是「令牌里角色码写错了」。
    //   最典型的一次：校长令牌还写着旧码 ROLE_PRINCIPAL，角色码统一后就不认了，
    //   于是校长点任何写操作都弹「请联系学管或校长」，学管却是好的 —— 极难定位。
    //   现在直接把「令牌不合法」摆到台面上。
    const body: ApiResponse<null> = {
      code: BizCode.UNAUTHORIZED,
      message: `演示令牌无法识别：test-${token}。请到登录页重新选择角色（角色编码已统一为无前缀，如校长是 test-RM_PRINCIPAL）`,
      data: null,
    };
    res.status(401).json(body);
    return;
  }

  // ---- 正式逻辑 ----
  if (!authHeader.startsWith('Bearer ')) {
    const body: ApiResponse<null> = {
      code: BizCode.UNAUTHORIZED,
      message: '请先登录',
      data: null,
    };
    // ⚠️ 未登录返回 401，前端据此跳登录页
    res.status(401).json(body);
    return;
  }

  const token = authHeader.slice(7);

  /* ============================================================
   * ★ 2026-10-05 联调合并：改为校验「统一门户」签发的 JWT
   *
   *   门户（本服务内的 src/portal）登录后签发 HS256 token，载荷：
   *     userId / roles / permissions / dataScope      ← 三方清单 4 字段
   *     + modules / kind / account / accountId / userName ← 门户扩展
   *
   *   本模块（就业 / 教务 / 班级）的页面权限仍是「角色 → 页面」，
   *   所以这里要把门户身份「翻译」成角色码：
   *     · 系统管理员(kind=sys_admin) → SYS_ADMIN —— 能看全部页面，
   *       但会被上面的「只读总闸」拦掉所有写操作（原有设计不变）
   *     · 其他账号 → 拿登录名去【权限管理模块】查真实角色（sms_perm.t_perm_user）
   *                  查不到就按 SYS_ADMIN（只读）兜底 —— 与合并方案约定的
   *                  「解析不到按只读处理」一致，绝不静默放行写操作。
   * ============================================================ */
  let payload: any = null;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch {
    payload = null;
  }

  if (!payload || typeof payload !== 'object') {
    const body: ApiResponse<null> = {
      code: BizCode.UNAUTHORIZED,
      message: '登录已过期，请重新登录',
      data: null,
    };
    res.status(401).json(body);
    return;
  }

  const kind = String(payload.kind || '');
  const account = String(payload.account || '');

  let roles: string[];
  /**
   * ★★ 2026-10-12：业务侧用户 id（权限库 `t_perm_user.id`，如 `U004`）
   *
   * 【为什么必须带出来】
   *   业务表里的责任人列（`t_uni_class.head_teacher_id`、`t_student_base.head_teacher_id`…）
   *   存的是**权限库用户 id**，而门户 token 里的 `userId` 是**门户账号 id（UUID）** ——
   *   两套 ID 直接比永远比不中，表现就是「班主任进去什么都看不到」。
   *   这里顺手把映射结果带上，业务侧一句 `user.businessUserId || user.userId` 就能用。
   */
  let businessUserId = '';
  /** ★ 2026-10-15：权限库里的真实部门 id（映射成业务部门码用，见 DEPT_CODE_BY_PERM_DEPT） */
  let profileDeptId = '';
  if (kind === 'sys_admin') {
    // 系统管理员：全系统可见（页面全开，但受「只读总闸」限制不能写）
    roles = [RoleCode.SYS_ADMIN];
  } else {
    // 模块负责人：角色以【权限管理模块】为唯一权威源
    // ⚠️ 解析不到（该账号在 sms_perm 没有记录）→ 给【空角色】，
    //    即看不到任何 就业/教务/班级 页面，只能进自己被授权的门户模块。
    //    绝不降级成 SYS_ADMIN —— 那会让「财务/咨询负责人」看到全部
    //    就业/教务/班级 的页面，破坏门户「各模块互不越界」的约定。
    const profile = await resolveAccountProfile(account);
    roles = profile.roles;
    businessUserId = profile.permUserId;
    profileDeptId = profile.deptId;
  }

  /**
   * ★★ 2026-10-08：加载「自建角色 → 内置角色」等价声明
   *
   * 【为什么必须在【这里】加载】
   *   下游所有模块（就业/教务/班级/财务/权限）的角色判定，
   *   用的都是 `hasRole(roles, 'PROJECT_MANAGER')` 这类**内置角色码**判断。
   *   自建角色（`XMJL_000`）名字对不上 → 判定恒 false → 单据发不出去。
   *
   *   `ensureRoleEquivLoaded()` 会把权限库里声明的等价关系灌进
   *   `shared-types` 的别名表，于是下游 `hasRole` 对自建角色**自动成立**。
   *
   *   ⚠️ 放在鉴权中间件里（而不是各业务路由里）的原因：
   *     这里是**所有请求的唯一入口**，加载一次全局生效，
   *     各业务代码零改动、零遗漏。
   *   ⚠️ 它内部有 15 秒缓存，是个廉价的 no-op，不会拖慢每个请求。
   */
  await ensureRoleEquivLoaded();

  req.user = {
    userId: String(payload.userId || payload.accountId || ''),
    // ★ 业务侧用户 id（U004…），业务表责任人列用它做「我带的班」过滤
    businessUserId,
    userName: String(payload.userName || account || ''),
    roles,
    /* ★★★ 2026-10-15 修：部门码原来**硬编码 1**（等于把所有账号都当成初高），
     *   导致 `applyDataScope` 的「本部门」过滤对大学部/实训账号恒为空 ——
     *   大学部班主任、实训项目经理登录后看不到自己的班和学生（页面 0 条）。
     *   现在按权限库里的真实部门映射成业务部门码。
     *   （映射表见文件上方的 DEPT_CODE_BY_PERM_DEPT）*/
    deptCode: DEPT_CODE_BY_PERM_DEPT[profileDeptId] ?? 1,
    /* ★ 「全部门」（D_ALL，如校长 qiansy）→ 直接提升为「不过滤」，
     *   否则会被映射成某个具体部门码、反而只看得到一部分。 */
    dataScope:
      profileDeptId === 'D_ALL'
        ? DataScope.ALL
        : ((payload.dataScope as DataScope) ?? DataScope.ALL),
    permissions: kind === 'sys_admin' ? ['*'] : [],
    classIds: [],
    token,
    // ★ 2026-10-06：门户下发的可见模块，供页面权限守卫做「模块级」门槛
    //   （无此项 = 老 token，消费方按「不拦」处理，保持向后兼容）
    modules: Array.isArray(payload.modules) ? payload.modules.map((m: any) => String(m)) : [],
  };
  next();
}

/**
 * 拿登录名去【权限管理模块】查真实角色码
 *
 * 合并后权限模块就在同一个进程里，但这里仍走它对外暴露的**只读 HTTP 接口**
 * （/api/perm/remote/account-profile）而不是直接查表 ——
 * 因为权限的权威数据归权限模块所有，直接读它的表会把两个模块耦死，
 * 它一改表结构我们就得跟着改。走接口最稳。
 *
 * ⚠️ 任何失败（超时 / 权限模块不可用 / 账号没配权限）都返回空数组，
 *    由上层兜底成「只读」，绝不抛错中断请求。
 */
export interface AccountProfile {
  roles: string[];
  /**
   * ★★ 2026-10-12：业务侧用户 id（权限库 `t_perm_user.id`，如 `U004` / `U_sunjl`）
   *
   * 业务表里的责任人列（`t_uni_class.head_teacher_id`…）存的就是它，
   * 不是门户账号 UUID。拿不到时是空串，调用方按「无映射」处理。
   */
  permUserId: string;
  /**
   * ★★ 2026-10-15 新增：权限库部门 id（如 `D_TEACH_U` 大学部 / `D_TRAIN` 实训教学部）
   *
   * 【为什么需要】
   *   数据范围过滤（`DataScope.DEPT`）要按「本部门」筛数据，
   *   但原先 `req.user.deptCode` 是**写死的 1**（初高）——
   *   于是大学部班主任、实训项目经理按「部门 1」去查，永远查不到自己的班（部门 2）。
   *   这里把权限库的真实部门带出来，由下面的 DEPT_CODE_BY_PERM_DEPT 映射成业务部门码。
   */
  deptId: string;
  /** 部门中文名（如「大学部」），仅用于日志/排查 */
  deptName: string;
}

/**
 * 权限库部门 id → 业务部门码（数据表 `dept_code` 列的口径）
 *
 * 【业务口径（斌哥 2026-10-15 确认）】
 *   数据里只有两个部门码：**1 = 初高** / **2 = 大学部（这一类）**
 *   · 实训、就业 → **算大学部这一类（2）**
 *   · 教务 → **不算**（`D_ACAD`，见下方 TODO）
 *
 * 【`D_ALL`（全部门）不在这张表里】
 *   校长 qiansy 的部门就是 `D_ALL` —— 他要看全部数据，
 *   所以在中间件里**直接把 dataScope 提升为 ALL**（不过滤），而不是映射成一个码。
 */
const DEPT_CODE_BY_PERM_DEPT: Record<string, number> = {
  // —— 初高系 → 1 ——
  D_TEACH: 1, // 教学部（初高班主任 sunmin / 学管主任 congym 都挂这个部门）
  D_TEACH_G: 1, // 高中部
  D_TEACH_J: 1, // 初中部
  // —— 大学部这一类 → 2（实训、就业按斌哥口径并入）——
  D_TEACH_U: 2, // 大学部
  D_TRAIN: 2, // 实训教学部（项目经理 sunjl）
  D_JOB: 2, // 就业管理部
  /* ⚠️ TODO（待斌哥定口径）：`D_ACAD`（教务部）明确「不算大学部」，
   *   但教务的数据（sms_edu.t_student_base）dept_code 实测是 2 ——
   *   所以教务账号该映射成几，需要业务确认后再补这一条。
   *   当前未映射 → 走兜底值 1（与改动前的行为一致，不引入新问题）。 */
};

async function resolveAccountProfile(account: string): Promise<AccountProfile> {
  const EMPTY: AccountProfile = { roles: [], permUserId: '', deptId: '', deptName: '' };
  if (!account) return EMPTY;
  try {
    /**
     * ★ 2026-10-14：底层从原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
     *   · 地址不再手拼 `config.services.perm`，统一由封装按模块取（同源 config.services）
     *   · 超时从 `AbortSignal.timeout(2500)` 改成封装的 `timeout: 2500`（等价）
     *   · 判据不变：拿不到有效档案就返回空档案（roles 空、permUserId 空），
     *     **绝不抛错** —— 业务角色查不到时上层按「无映射」处理
     *   · 用 raw: true 自己取 body.data（这里的成功码口径由本文件掌握）
     */
    const body: any = await remoteGet(
      'perm',
      `/api/perm/remote/account-profile?account=${encodeURIComponent(account)}`,
      { timeout: 2500, raw: true },
    );
    const roles = body?.data?.roles;
    return {
      roles: Array.isArray(roles) ? roles.filter((r: any) => typeof r === 'string') : [],
      permUserId: String(body?.data?.permUserId || ''),
      deptId: String(body?.data?.deptId || ''),
      deptName: String(body?.data?.deptName || ''),
    };
  } catch {
    return EMPTY;
  }
}

/** 薄包装：老调用方只关心角色码，保持原签名不变 */
async function resolveBusinessRoles(account: string): Promise<string[]> {
  return (await resolveAccountProfile(account)).roles;
}

/**
 * ★ 2026-10-05 导出给「并入的独立模块」复用（教学管理·初高 → src/class-jh）。
 *
 * 【为什么必须复用、不能各写一套】
 *   门户签发的 token 里 `roles` 只有门户级编码（SYS_ADMIN / SYS_STAFF），
 *   **不含业务角色**（校长/班主任/教务…）。业务角色的唯一权威源是
 *   权限管理模块的 sms_perm.t_perm_user —— 任何需要业务角色的模块，
 *   都必须走这里现查一次，否则拿到的永远是 ['SYS_STAFF']，权限判定全部落空。
 *   抽成一个出口，避免 N 个模块各写一份、口径漂移。
 */
export { resolveBusinessRoles };

/**
 * 权限校验中间件（细粒度）
 *
 * 用法：
 *   router.post('/delete/:id', checkPermission('consult:student:delete'), handler);
 */
export function checkPermission(permissionCode: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      const body: ApiResponse<null> = {
        code: BizCode.UNAUTHORIZED,
        message: '请先登录',
        data: null,
      };
      res.status(401).json(body);
      return;
    }

    // 管理员或带通配权限的直接放行
    if (user.permissions.includes('*') || user.permissions.includes(permissionCode)) {
      next();
      return;
    }

    // ★ 兜底：按角色查「操作权限配置」（2026-09-30 补）
    //   user.permissions 要等「登录 8001 + 权限管理 8006」接上才会被填，
    //   在那之前它是空数组 —— 不加这一步，**连校长都点不了「新建考试」**。
    //   ★ 2026-10-07：这一层已叠加「职位权限分配」页面的权限树
    //     （详见 utils/roleActionOverlay.ts）→ 管理员改权限点，按钮立刻变。
    if ((await getUserOperationPermissions(user.roles)).includes(permissionCode)) {
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
