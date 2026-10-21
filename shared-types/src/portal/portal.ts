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
  /** 市场咨询模块 · 原端口 8001 · 合并后并入 8004 / 前端 5173 */
  CONSULT = 'consult',
  /** 财务管理模块 · 原端口 8005 */
  FINANCE = 'finance',
  /** 权限管理模块 · 原端口 8006 */
  PERM = 'perm',

  /* ============================================================
   * ★★ 2026-10-05 深度单体合并：把原有三大模块也纳入「门户模块」概念
   *
   * 【为什么】
   *   合并前门户只认 consult / finance / perm 三个模块，
   *   登录门槛是「visibleModules 至少一个」（account.service.ts）。
   *   于是「只有就业/教务/班级权限」的人（班主任、教务老师、就业老师…）
   *   在门户模型里**根本没法登录**，也就没法编辑任何东西。
   *
   * 【口径】（用户 2026-10-05 拍板，方案 A）
   *   把这 3 个模块也登记进 MODULES，登录门槛不变，语义统一。
   *   ⚠️ 它们的【页面清单不放在这里】—— 仍是 `config/menu.ts` +
   *      「职位 → 页面权限」（pagePermissions.ts）在运行时算。
   *      所以这 3 个模块的 `menus` 是空的，且带 `legacy: true` 标记：
   *        · 后端：只用来判断「能不能登录 / 第一个落地模块」
   *        · 前端：`App.vue` 会把 legacy 模块从门户分组里滤掉，
   *                改由 `config/menu.ts` 渲染（带 hasPage() 过滤）
   * ============================================================ */
  /** 就业管理（实训 + 就业两个阶段）· 库 sms_job */
  JOB = 'job',
  /** 教务管理 · 库 sms_edu */
  EDU = 'edu',
  /** 班级管理（大学部）· 库 sms_class */
  CLASS = 'class',
  /** ★ 教学管理（初高）· 库 sms_class_jh · 接口 /api/class-jh/* · 页面 /class-jh/* */
  CLASS_JH = 'class-jh',
}

export const MODULE_NAME: Record<string, string> = {
  [ModuleKey.CONSULT]: '市场咨询',
  [ModuleKey.FINANCE]: '财务管理',
  [ModuleKey.PERM]: '权限管理',
  [ModuleKey.JOB]: '就业管理',
  [ModuleKey.EDU]: '教务管理',
  [ModuleKey.CLASS]: '班级管理',
  [ModuleKey.CLASS_JH]: '教学管理（初高）',
};

/**
 * ★ 2026-10-05：合并前的老模块（路由不带模块前缀、页面清单由职位权限算）
 *
 * 前端门户分组要把它们滤掉（改由 config/menu.ts 渲染），
 * 后端落地页计算也要跳过它们（交给 /api/job/auth/my-pages）。
 *
 * ★ 2026-10-05 追加：教学管理（初高）也按同一口径处理 ——
 *   它的页面清单同样在 config/menu.ts + pagePermissions.ts 里，
 *   不在下面的 MODULES.menus 里。
 */
export const LEGACY_MODULE_KEYS: string[] = [
  ModuleKey.JOB,
  ModuleKey.EDU,
  ModuleKey.CLASS,
  ModuleKey.CLASS_JH,
];

export function isLegacyModule(key: string): boolean {
  return LEGACY_MODULE_KEYS.includes(key);
}

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
  /**
   * ★ 2026-10-05：合并前的老模块（就业/教务/班级）
   *
   * `true` 表示：
   *   · 这是本系统原有的模块，路由【不带模块前缀】（/class、/edu/student …）
   *   · 页面清单【不在这里】，由 `config/menu.ts` + 职位页面权限在运行时决定
   *   · 前端门户分组要跳过它（否则会与 menu.ts 渲染的分组重复）
   */
  legacy?: boolean;
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
      // ⚠️⚠️ 2026-10-03 用户指令：
      //   「账号管理和权限管理内的账号管理是同一个功能，权限管理内的账号管理是唯一的，
      //     账号管理删除，功能一致。」
      //   → 删掉这里的 { key: 'account', title: '账号管理', path: '/account' }。
      //     注意：这是门户侧栏真正读的那份注册表（渲染 sources），
      //     与 01-王寒逸-consult 的 MENU_ITEMS 是两处独立定义，必须【同步】改，
      //     否则门户会继续渲染出一个指向已删除页面的「账号管理」入口。
      //     账号维护统一收敛到【权限管理模块 → 账号管理】。
    ],
  },
  {
    key: ModuleKey.FINANCE,
    title: '财务管理',
    desc: '缴费 · 退费 · 冻结 · 账单 · 标准',
    entryUrl: 'http://127.0.0.1:5174',
    menus: [
      /* ⚠️ 2026-10-06 修：这里原来写的是 `path: '/finance'`。
       *   App.vue 拼路由的规则是 `/${模块key}${菜单path}`，于是它拼出
       *   `/finance` + `/finance` = **`/finance/finance`** —— 而 web-job 的真实路由
       *   是 `/finance/overview`（router/index.ts）→ 点「财务概览」会落到 404 兜底页。
       *   改回 `/overview` 后与真实路由、与《系统板块与页面总览.md》3.3 节一致。
       *   ★ 这一处必须对，否则「页面管理」台账按 path 比对时，
       *     财务概览永远匹配不上（配置里是 /finance/overview、菜单里是 /finance/finance）。 */
      { key: 'finance', title: '财务概览', path: '/overview' },
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
    desc: '部门 · 职位 · 账号 · 授权 · 页面 · 日志',
    entryUrl: 'http://127.0.0.1:5176',
    menus: [
      { key: 'overview', title: '权限总览', path: '/overview' },
      { key: 'dept', title: '部门管理', path: '/dept' },
      { key: 'role', title: '职位管理', path: '/role' },
      { key: 'user', title: '账号管理', path: '/user' },
      { key: 'assign', title: '职位权限分配', path: '/assign' },
      /* ★ 2026-10-06 新增：页面管理（板块 → 页面 台账，勾选即生效）
       *   它是【权限管理板块自己的一个页面】，而它的数据又决定【所有板块有哪些页面】，
       *   所以 `sms_perm.t_perm_page` 里有一行 `page` 指向自己，且 locked=true 不可取消。 */
      { key: 'page', title: '页面管理', path: '/page' },
      // ⚠️⚠️ 2026-10-06 用户指令：「权限管理板块里面删除规则配置页面」
      //   → 删掉这里的 { key: 'rule', title: '规则配置', path: '/rule' }。
      //     这是门户侧栏真正读的那份注册表，删掉后 App.vue 不再渲染该菜单项，
      //     同时 router 守卫的 menuAllowed('perm','rule') 也会把直连 /perm/rule 拦下。
      //   同步改：shared-types/src/perm/perm-auth.ts 的 PERM_MENU_KEYS、
      //           web-job 路由 /perm/rule、views/RuleConfig.vue（已删除）、
      //           前端 perm/api/perm.ts 的 ruleApi。
      //   ⚠️ 后端 /api/perm/rule/*（rule.route.ts）按项目既有约定【暂留】作为兜底通道，
      //      权限树里的 MN_perm_04「规则配置」功能点也随之保留（仍守着那几个接口）；
      //      密码策略由 t_perm_rule 驱动，页面删掉后策略值仍照常生效。
      { key: 'log', title: '操作日志', path: '/log' },
    ],
  },

  /* ============================================================
   * ★★ 2026-10-05 合并：原有三大模块也登记为「门户模块」
   *
   * ⚠️⚠️ 这 3 项是 **legacy 模块**，与上面 3 个新模块不同：
   *   · 它们的页面清单【不写在这里】—— 仍然是 `web-job/src/config/menu.ts`
   *     配合「职位 → 页面权限」（后端 config/pagePermissions.ts）在运行时算出来的，
   *     因为同一个模块里「班主任 / 校长 / 教务」看到的页面完全不同。
   *   · 前端 `App.vue` 会按 `legacy` 标记把它们从【门户分组】里滤掉，
   *     改由 `config/menu.ts` 渲染（带 hasPage() 过滤），避免菜单重复。
   *   · 所以这里的 `menus` 故意留空。
   *
   * 【它们唯一的作用】让「只有就业/教务/班级权限」的账号也能通过门户登录
   *   （登录门槛 = visibleModules 至少一个，见 portal/services/account.service.ts），
   *   并让「登录后去哪」有据可依。
   *
   * 【账号怎么授权】t_sys_account.modules 里写 ['class'] / ['job','class'] 这样即可。
   * ============================================================ */
  {
    key: ModuleKey.JOB,
    title: '就业管理',
    desc: '实训阶段 · 就业阶段',
    entryUrl: 'http://127.0.0.1:5173',
    legacy: true,
    menus: [],
  },
  {
    key: ModuleKey.EDU,
    title: '教务管理',
    desc: '学生档案 · 宿舍 · 缴费',
    entryUrl: 'http://127.0.0.1:5173',
    legacy: true,
    menus: [],
  },
  {
    key: ModuleKey.CLASS,
    title: '班级管理',
    desc: '大学部 · 花名册 · 出勤 · 成绩 · 催费',
    entryUrl: 'http://127.0.0.1:5173',
    legacy: true,
    menus: [],
  },
  {
    /**
     * ★ 教学管理（初高）2026-10-05 并入
     *
     * ⚠️ 与上面的「班级管理」是两套模块，别混：
     *      class    = 大学部（Q1~Q6）      库 sms_class    · /api/class/*
     *      class-jh = 初高中部（J/G 班）   库 sms_class_jh · /api/class-jh/*
     *
     * 同样按 legacy 处理：页面清单在 `config/menu.ts`
     * （权限码 classjh:*，见后端 config/pagePermissions.ts），
     * 所以这里 menus 留空 —— 留了会和 menu.ts 渲染的分组重复一次。
     */
    key: ModuleKey.CLASS_JH,
    title: '教学管理（初高）',
    desc: '初高部 · 学生主档 · 班级 · 出勤 · 考试 · 宿舍 · 催费 · 退费',
    entryUrl: 'http://127.0.0.1:5173',
    legacy: true,
    menus: [],
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
