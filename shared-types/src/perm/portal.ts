/**
 * ⭐ 统一账号与模块注册表（全系统契约）
 *
 * ⚠️⚠️ 2026-10-02 新增：一个账号表管跨模块职位 + 目录树按模块展开
 *
 * 背景（用户指令）：
 *   「给财务也补录账号，然后系统管理员也能看到财务的模块，全部糅合到一个系统中，
 *    系统管理员登录之后在右侧显示咨询模块和财务模块的目录，
 *    然后点击目录之后展开为模块内的功能，各模块的负责人只能查看自己的模块内容。」
 *
 * 设计要点：
 *   ① 统一账号表存「这个账号能进哪些模块」→ modules: ['consult', 'finance']
 *   ② 模块注册表（MODULES）声明每个模块叫什么、入口在哪、有哪些页面
 *   ③ 门户侧栏按 MODULES 渲染「一级模块（可折叠）→ 二级页面」
 *   ④ 各模块自己只校验「我是否在这个人的 modules 里」
 *
 * ⚠️ 本文件是【跨模块契约】，改动必须两边同步 + 群里公告。
 */

/* ============================================================
 * 1. 模块标识
 * ============================================================ */

/** 系统内的模块 key（与端口/目录对应，不要随意改） */
export enum ModuleKey {
  /** 市场咨询模块 · 端口 8001 · 前端 5173 */
  CONSULT = 'consult',
  /** 财务管理模块 · 端口 8005 · 前端 5174 */
  FINANCE = 'finance',
  /** 权限管理模块 · 端口 8006 · 前端 5176 */
  PERM = 'perm',
}

export const MODULE_NAME: Record<string, string> = {
  [ModuleKey.CONSULT]: '市场咨询',
  [ModuleKey.FINANCE]: '财务管理',
  [ModuleKey.PERM]: '权限管理',
};

/* ============================================================
 * 2. 模块注册表（门户侧栏与路由都用它）
 * ============================================================ */

/** 模块内的一个页面 */
export interface ModuleMenuItem {
  /** 页面 key（= 该模块路由的 menuKey） */
  key: string;
  /** 菜单显示名 */
  title: string;
  /** 该模块内的路由路径（hash 形式，如 '/student'） */
  path: string;
}

/** 一个模块 */
export interface ModuleDef {
  key: ModuleKey;
  /** 显示名 */
  title: string;
  /** 一句话说明（侧栏模块标题下的副标题 / 面包屑） */
  desc: string;
  /** 子应用入口（门户用 iframe 承载时的基地址） */
  entryUrl: string;
  /** 该模块有哪些页面（顺序即菜单顺序） */
  menus: ModuleMenuItem[];
  /**
   * 允许进入本模块的职位（**模块内职位**，不是全局岗位）
   * ⚠️ 留空数组 = 任何被授权访问本模块的账号都能进
   */
  allowedRoles?: string[];
}

/**
 * ⭐ 模块注册表
 *
 * ⚠️ 门户侧栏直接按这个数组渲染，顺序就是显示顺序。
 * ⚠️ 加新模块：在这里加一项 + 到 t_sys_account 里给账号授权即可。
 */
export const MODULES: ModuleDef[] = [
  {
    key: ModuleKey.CONSULT,
    title: '市场咨询',
    desc: '学生 · 缴费 · 审批 · 退费 · 流失',
    entryUrl: 'http://127.0.0.1:5173',
    menus: [
      { key: 'student', title: '学生管理', path: '/student' },
      { key: 'fee', title: '收款与缴费', path: '/fee' },
      { key: 'approve', title: '审批中心', path: '/approve' },
      { key: 'refund', title: '退费管理', path: '/refund' },
      { key: 'loss', title: '流失记录', path: '/loss' },
      { key: 'account', title: '账号管理', path: '/account' },
    ],
  },
  {
    key: ModuleKey.FINANCE,
    title: '财务管理',
    desc: '缴费 · 退费 · 冻结 · 账单 · 标准',
    entryUrl: 'http://127.0.0.1:5174',
    menus: [
      { key: 'finance', title: '财务概览', path: '/finance' },
      { key: 'fee', title: '缴费管理', path: '/fee' },
      { key: 'freeze', title: '冻结名单', path: '/freeze' },
      { key: 'refund', title: '退费管理', path: '/refund' },
      { key: 'bill', title: '账单明细', path: '/bill' },
      { key: 'standard', title: '费用标准', path: '/standard' },
    ],
  },
  {
    key: ModuleKey.PERM,
    title: '权限管理',
    desc: '部门 · 职位 · 账号 · 授权 · 日志',
    entryUrl: 'http://127.0.0.1:5176',
    menus: [
      { key: 'overview', title: '权限总览', path: '/overview' },
      { key: 'dept', title: '部门管理', path: '/dept' },
      { key: 'role', title: '职位管理', path: '/role' },
      { key: 'user', title: '账号管理', path: '/user' },
      { key: 'assign', title: '职位权限分配', path: '/assign' },
      { key: 'log', title: '操作日志', path: '/log' },
      // ⚠️ 2026-10-06：规则配置页面已删除（与 portal/portal.ts 同步，勿只改一处）。
    ],
  },
];

/** 按 key 取模块定义 */
export function findModule(key: string): ModuleDef | undefined {
  return MODULES.find((m) => m.key === key);
}

/* ============================================================
 * 3. 统一账号
 * ============================================================ */

/** 账号的「主身份」——决定默认落地哪个模块、门户显示什么头衔 */
export enum AccountKind {
  /** 系统管理员：可访问全部模块，全模块总览 */
  SYS_ADMIN = 'sys_admin',
  /** 模块负责人：只能访问自己被授权的模块 */
  MODULE_OWNER = 'module_owner',
}

export const ACCOUNT_KIND_NAME: Record<string, string> = {
  [AccountKind.SYS_ADMIN]: '系统管理员',
  [AccountKind.MODULE_OWNER]: '模块负责人',
};

/** ⭐ 统一账号（t_sys_account） */
export interface SysAccount {
  accountId: string;
  /** 登录账号 */
  account: string;
  /** 姓名 */
  userName: string;
  /**
   * ⚠️ 演示环境才返回的明文密码（列表页展示用）。
   *    正式环境必须不返回 —— 见 toAccountView(row, false)。
   */
  password?: string;
  /** 主身份 */
  kind: AccountKind;
  /** 头衔（展示用，如「市场咨询经理」「财务负责人」） */
  title?: string;
  /** 部门 */
  dept?: string;
  /** 联系电话 */
  phone?: string;
  /**
   * ⭐ 这个账号能访问的模块 key 列表
   *   - 系统管理员：全部模块
   *   - 模块负责人：只含自己被授权的模块（通常 1 个）
   */
  modules: ModuleKey[];
  /** 是否启用 */
  active: boolean;
  /** 最近登录时间 */
  lastLogin?: string;
  createTime?: string;
}

/**
 * ⭐ 登录结果
 *
 * ⚠️ 门户登录后拿到这个，据此渲染侧栏目录树。
 */
export interface PortalLoginResult {
  token: string;
  account: SysAccount;
  /** 这个账号可见的模块（已按 modules 过滤，含各模块的 menus） */
  visibleModules: ModuleDef[];
  /** 建议落地路径（第一个可见模块的第一页） */
  landingPath: string;
}

/** 登录请求 */
export interface PortalLoginPayload {
  account: string;
  password: string;
}

/* ============================================================
 * 4. 跨模块 token 载荷（门户签发，各模块验签）
 * ============================================================ */

/**
 * ⭐ 门户签发的 JWT 载荷
 *
 * ⚠️ 与《三方清单第三节》要求的 4 字段保持兼容：
 *    userId / roles / permissions / dataScope 仍在，另外多带 modules。
 *    这样各业务模块（含实训 8004）既能按老口径解，也能按模块口径解。
 */
export interface PortalJwtPayload {
  /* ---- 三方清单要求的 4 个字段 ---- */
  userId: string;
  roles: string[];
  permissions: string[];
  /** 1 本人 / 2 本班 / 3 本部门 / 4 全部 */
  dataScope: number;

  /* ---- ⭐ 门户扩展 ---- */
  /** 可访问的模块 key 列表 */
  modules: string[];
  /** 主身份 */
  kind: string;
  /** 姓名 */
  userName?: string;
  /** 统一账号表主键 */
  accountId?: string;
  /** 登录账号 */
  account?: string;

  /* ---- 标准声明 ---- */
  iat?: number;
  exp?: number;
}

/** 判断某账号能否访问某模块 */
export function canAccessModule(account: SysAccount | null, moduleKey: string): boolean {
  if (!account) return false;
  return account.modules.includes(moduleKey as ModuleKey);
}

/** 取该账号可见的模块定义（含各自页面） */
export function visibleModulesOf(account: SysAccount | null): ModuleDef[] {
  if (!account) return [];
  return MODULES.filter((m) => account.modules.includes(m.key));
}
