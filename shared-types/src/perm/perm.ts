/**
 * 权限管理模块 · 领域类型
 *
 * 对应《学管系统 · 权限与职位管理模块 PRD》
 * 模块：权限管理（林晓）  端口 8006  接口前缀 /api/perm
 *
 * ⚠️ 全系统唯一的三级权限模型：
 *      模块（module） → 功能点（item） → 动作（action）
 *    权限只能配置到「动作」粒度；未勾选即无权限（不提供「拒绝」语义）。
 */

import {
  DataScope,
  DeptLevel,
  GENDER_NAME,
  LogResult,
  PermBaseAction,
  RoleStatus,
  RoleType,
  UserStatus,
} from './enums';
import { BaseEntity, PageQuery } from './common';

/* ============================================================
 * 一、部门（组织架构）
 * ============================================================ */

/** 部门实体 */
export interface PermDept extends BaseEntity {
  /** 部门名称 */
  deptName: string;
  /** 简称（表格窄列展示用） */
  deptShort: string;
  /** 上级部门 ID；校级部门为 null */
  parentId: string | null;
  /** 部门层级 1校级 2部门 3学段 */
  deptLevel: DeptLevel;
  /** 排序号 */
  sortNo: number;
  /** 描述 */
  remark?: string;

  /* ---- 运行时统计（不落库，接口计算后返回） ---- */
  /** 归属职位数（含子部门） */
  roleCount?: number;
  /** 归属账号数（含子部门） */
  userCount?: number;
  /** 子部门数量 */
  childCount?: number;
}

/** 部门树节点（部门管理页左侧树） */
export interface PermDeptTreeNode {
  id: string;
  deptName: string;
  deptShort: string;
  deptLevel: DeptLevel;
  deptLevelName: string;
  parentId: string | null;
  roleCount: number;
  userCount: number;
  children?: PermDeptTreeNode[];
}

/** 部门查询参数 */
export interface PermDeptQuery extends PageQuery {
  keyword?: string;
  parentId?: string;
}

/** 部门新增/编辑参数 */
export interface PermDeptSavePayload {
  id?: string;
  deptName: string;
  deptShort?: string;
  parentId?: string | null;
  sortNo?: number;
  remark?: string;
}

/* ============================================================
 * 二、职位
 * ============================================================ */

/** 职位实体 */
export interface PermRole extends BaseEntity {
  /** 职位名称 */
  roleName: string;
  /** 职位编码，正则 ^[A-Z][A-Z0-9_]*$，全局唯一 */
  roleCode: string;
  /** 所属部门 ID */
  deptId: string;
  /** 职位类型 */
  roleType: RoleType;
  /**
   * ★ 2026-10-08 新增：等价的内置职位码
   *
   * 【解决什么问题】
   *   业务代码里的审批链、权限判定写的是**主包内置职位码**
   *   （如 `PROJECT_MANAGER`、`TEACH_HEAD`）。而用户在权限管理里
   *   **自建**的职位（如 `XMJL_000`「项目经理2」）不在主包枚举里，
   *   于是「项目经理能发起退费」这类判定对自建职位**恒 false** ——
   *   页面能看见，按钮一点就 403。
   *
   * 【怎么用】
   *   建职位时声明「我等价于哪个内置职位」。
   *   运行时 `roleAlias.ts` 会读这一列，把自建职位码**动态**并入
   *   对应内置职位的别名集合，于是所有 `hasRole(roles, 'PROJECT_MANAGER')`
   *   对 `XMJL_000` 自动成立 —— 无需改任何业务代码。
   *
   * 【取值】
   *   · 为空 / null：不声明（内置职位无需填，它们自己就是权威码）
   *   · 填内置职位码：必须是主包 `RoleCode` 的取值，如 `PROJECT_MANAGER`
   *
   * ⚠️ 只填「内置职位码」，不要填另一个自建职位码（不做链式解析，避免环）。
   */
  equivRoleCode?: string | null;
  /** 是否系统预置（预置不可删除） */
  isSys: boolean;
  /** 状态 */
  roleStatus: RoleStatus;
  /** 权限数 = 该职位已勾选动作总数 */
  permCount: number;
  /** 排序号 */
  sortNo: number;
  /** 职位定位 / 权限特征说明 */
  remark?: string;
}

/** 职位列表项 */
export interface PermRoleListItem {
  id: string;
  roleName: string;
  roleCode: string;
  deptId: string;
  deptName: string;
  roleType: RoleType;
  /** ★ 2026-10-08：等价的内置职位码（自建职位声明自己等价于谁），见 PermRole.equivRoleCode */
  equivRoleCode?: string | null;
  isSys: boolean;
  /** 是否可删除：预置不可删，有关联账号不可删 */
  canDelete: boolean;
  roleStatus: RoleStatus;
  permCount: number;
  /** 关联账号数 */
  userCount: number;
  createTime: string;
}

/** 职位查询参数 */
export interface PermRoleQuery extends PageQuery {
  /** 职位名称 / 编码模糊搜索 */
  keyword?: string;
  roleType?: RoleType;
  roleStatus?: RoleStatus;
  deptId?: string;
}

/** 职位新增/编辑参数 */
export interface PermRoleSavePayload {
  id?: string;
  roleName: string;
  /**
   * ★ 2026-10-19：界面已去掉「职位编码」——改为可选。
   *   不传由后端自动生成（t_perm_role.role_code 是 NOT NULL + 唯一索引，
   *   且是跨模块鉴权连接键，所以列与字段必须保留，只是不再由用户填写）。
   */
  roleCode?: string;
  deptId?: string;
  roleType?: RoleType;
  /** ★ 2026-10-08：等价的内置职位码，见 PermRole.equivRoleCode */
  equivRoleCode?: string | null;
  roleStatus?: RoleStatus;
  sortNo?: number;
  remark?: string;
  /** 权限草稿：{ '模块key||功能点名': ['动作名', ...] }，随职位一起保存 */
  perms?: RolePermMap;
}

/** 职位详情（含权限） */
export interface PermRoleDetail extends PermRole {
  deptName: string;
  userCount: number;
  /** 该职位的完整权限映射 */
  perms: RolePermMap;
}

/* ============================================================
 * 三、账号（用户）
 *
 * ⚠️ 归属决策：账号归【权限管理模块】所有（账号管理是权限管理的第 3 个功能页）。
 *    登录模块通过 GET /api/perm/user/auth-profile 取账号 + 职位 + 权限。
 * ============================================================ */

/** 账号实体 */
export interface PermUser extends BaseEntity {
  /** 姓名，仅汉字且不低于 2 位 */
  userName: string;
  /** 工号：2026-10-16 起界面不再维护（所有职位统一去掉），由后端自动生成 */
  gwNo: string;
  /** 登录账号，字母/数字，4-20 位，全局唯一 */
  account: string;
  /** 手机号，11 位以 1 开头，全局唯一 */
  phone: string;
  /** 性别 */
  gender: number;
  /** 年龄 */
  age: number;
  /** 所属部门 ID */
  deptId: string;
  /** 账号状态 */
  userStatus: UserStatus;
  /** 是否待改初始密码 */
  needChangePwd: boolean;
  /** 最近登录时间 */
  lastLoginTime?: string;
}

/** 账号列表项 */
export interface PermUserListItem {
  id: string;
  userName: string;
  /** 姓名首字（头像占位） */
  avatarText: string;
  gwNo: string;
  account: string;
  /** 脱敏手机号 138****4567 */
  phoneMasked: string;
  phone: string;
  gender: number;
  genderName: string;
  age: number;
  deptId: string;
  deptName: string;
  /** 职位 ID 数组 */
  roleIds: string[];
  /** 职位名称数组 */
  roleNames: string[];
  /** 主职位名（列表展示用，取第一个） */
  roleName: string;
  /** 有效权限动作数 = 所有职位权限并集去重后的动作总数 */
  effectivePermCount: number;
  userStatus: UserStatus;
  needChangePwd: boolean;
  lastLoginTime?: string;
  createTime: string;
  createBy: string;
  /** ★ 2026-10-16：该登录名在门户账号表里的可访问模块（没有门户账号时为空数组） */
  portalModules?: string[];
  /** ★ 该登录名在门户是否已有账号（false = 现在登不进系统） */
  hasPortalAccount?: boolean;
}

/** 账号查询参数 */
export interface PermUserQuery extends PageQuery {
  /** 姓名 / 手机号 / 账号 模糊搜索 */
  keyword?: string;
  deptId?: string;
  roleId?: string;
  userStatus?: UserStatus;
  /** 待改初始密码筛选 */
  needChangePwd?: boolean;
}

/** 账号新增/编辑参数 */
export interface PermUserSavePayload {
  id?: string;
  userName: string;
  /** 工号（可选）：不传=后端自动生成，编辑不传=保持原值 */
  gwNo?: string;
  account: string;
  phone: string;
  gender: number;
  age: number;
  deptId: string;
  userStatus?: UserStatus;
  /**
   * ★ 2026-10-16：可访问模块（门户登录后能进哪几个模块）
   *   新增账号时必填 ≥1 —— 门户要求至少一个模块，否则该账号登不进去；
   *   编辑时不传 = 不动门户那边的模块配置。
   */
  modules?: string[];
  /** 所属职位（多选，权限取并集） */
  roleIds: string[];
  /** 新增时必填；编辑时留空表示不修改 */
  password?: string;
  needChangePwd?: boolean;
}

/** 重置密码参数 */
export interface PermUserResetPwdPayload {
  userId: string;
  /** 新密码；不传则后端生成随机密码 */
  newPassword?: string;
  /** 是否强制下次登录修改 */
  needChangePwd?: boolean;
}

/**
 * 账号鉴权档案（给登录模块调用）
 * 路径：GET /api/perm/user/auth-profile?account=xxx
 */
export interface PermAuthProfile {
  userId: string;
  userName: string;
  account: string;
  deptId: string;
  deptName: string;
  userStatus: UserStatus;
  /** 职位编码数组，写进 token 的 roles[] */
  roles: string[];
  roleIds: string[];
  roleNames: string[];
  /** 该账号全部职位的权限并集，元素形如 'market:预到校名单:查看' */
  permissions: string[];
  /** 有效数据范围（取所有职位中最宽的一档） */
  dataScope: DataScope;
  /** 是否需要强制修改密码 */
  needChangePwd: boolean;
}

/* ============================================================
 * 四、权限树（模块 → 功能点 → 动作）
 * ============================================================ */

/**
 * 权限动作（叶子节点）
 *
 * ⚠️ 命名说明：这个接口原叫 `PermAction`，现更名为 `PermActionItem`。
 *    原因：字典里已有的 `PermAction`（6 个动作基类）为了兼容其他模块，
 *    在 enums.ts 里保留了别名，两个同名符号会冲突，所以这里改名。
 *    新名字也更准确 —— 它描述的是「一个具体的动作项」。
 */
export interface PermActionItem {
  /** 细粒度动作编码，如 'view' / 'import' / 'confirmPay' */
  actionCode: string;
  /** 细粒度动作名称，如 '查看' / '导入' / '确认出款' */
  actionName: string;
  /** 归入字典 4.12 的 6 个基类之一 */
  baseAction: PermBaseAction;
  baseActionName: string;
  /** 动作说明 */
  remark?: string;
}

/** 权限功能点（模块子节点） */
export interface PermItem {
  id: string;
  /** 功能点名称 */
  itemName: string;
  /** 父功能点名称（二级功能点，如「教质/学术审批 → 休学/退学审批」） */
  parentItemName?: string;
  /** 该功能点下的动作 */
  actions: PermActionItem[];
  /** 备注（如「咨询经理有审批权限，普通咨询老师没有」） */
  remark?: string;
  /** 该职位在此功能点下已勾选的动作名（职位权限详情接口返回） */
  checked?: string[];
  /**
   * ★ 2026-10-19 新增：是否用户自建
   *
   * true  = 在「新增权限」里自己加的（可改可删）
   * false / 未传 = 系统预置（不可改删，改动会破坏业务代码里的权限串）
   */
  isCustom?: boolean;
}

/* ============================================================
 * 三之二、权限点维护（用户自建权限点）
 *
 * 【背景】系统预置 8 个板块 / 55 个功能点是「系统能力清单」，
 *   新加的部门（如招生部）与职位（如招生老师）往往需要一批
 *   「预置清单里没有」的功能点。这一组类型就是那条维护通道的契约：
 *   新增后与预置权限**格式完全一致**（模块 → 功能点 → 动作），
 *   直接进入权限树，可以在「职位权限分配」里勾选给任何职位。
 * ============================================================ */

/** 自建权限点里的一个动作（提交用） */
export interface PermItemActionSavePayload {
  /** 动作编码，如 view / add / followUp；留空时后端按基类自动生成 */
  actionCode?: string;
  /** 动作中文名，如 查看 / 新建 / 跟进 */
  actionName: string;
  /** 动作基类 1查看 2新增 3编辑 4删除 5审批 6导出 */
  baseAction: number;
  remark?: string;
}

/** 自建权限点的新增 / 编辑参数 */
export interface PermItemSavePayload {
  /** 编辑时必传 */
  id?: string;
  /** 所属板块 key；传 __new__ 或留空 = 新建板块 */
  moduleKey: string;
  /** 板块名称（新建板块时必填） */
  moduleName?: string;
  /** 板块图标 emoji */
  moduleIcon?: string;
  /** 板块排序（不传则排到最后） */
  moduleSort?: number;
  /** 功能点名称 */
  itemName: string;
  /** 上级功能点名称（做二级功能点时用，可空） */
  parentItemName?: string | null;
  /** 备注 */
  remark?: string;
  /** 该功能点下的动作，至少 1 个 */
  actions: PermItemActionSavePayload[];
}

/** 权限点维护列表项（「新增权限」弹窗左侧列表用） */
export interface PermMenuItemAdmin {
  /** 功能点 id（t_perm_menu.id） */
  id: string;
  moduleKey: string;
  moduleName: string;
  moduleIcon: string;
  moduleSort: number;
  itemName: string;
  parentItemName?: string;
  itemSort: number;
  remark?: string;
  /** 是否用户自建 */
  isCustom: boolean;
  /** 动作清单 */
  actions: PermActionItem[];
  /** 有多少个职位勾选了它（删前提示用） */
  grantedRoleCount: number;
}

/** 权限点新增 / 编辑结果 */
export interface PermItemSaveResult {
  id: string;
  moduleKey: string;
  moduleName: string;
  itemName: string;
  /** 落库的动作数 */
  actionCount: number;
  /** true = 本次新建，false = 本次修改 */
  created: boolean;
}

/** 权限模块（一级节点） */
export interface PermModule {
  /** 模块 key，见 PermModuleKey */
  moduleKey: string;
  moduleName: string;
  /** 模块图标 emoji */
  moduleIcon: string;
  sortNo: number;
  /** 该模块下的功能点 */
  items: PermItem[];
  /** 已授权功能点数（职位权限详情接口返回） */
  grantedItemCount?: number;
  /** 功能点总数 */
  itemCount?: number;
  /** 该模块已勾选动作数（职位权限详情接口返回） */
  checkedCount?: number;
}

/** 权限树整体统计 */
export interface PermTreeStats {
  /** 模块数（8） */
  modCount: number;
  /** 功能点总数（47） */
  itemCount: number;
  /** 可配置权限点（动作）总数 */
  actionCount: number;
}

/**
 * 职位权限映射
 *
 * key   = `模块key||功能点名`，如 'market||预到校名单'
 * value = 该功能点下**已勾选的动作编码**数组（对应 PermAction.actionCode，如 ['view','edit']）
 *
 * ⚠️ 用动作编码而非中文名做 key 的取值，原因：编码稳定、不受改名影响，
 *    中文名由权限树接口（/api/perm/menu/tree）统一提供，前端不硬编码。
 */
export type RolePermMap = Record<string, string[]>;

/* ============================================================
 * 五、职位权限分配
 * ============================================================ */

/** 权限树查询参数（含某职位的勾选态） */
export interface RolePermQuery {
  roleId: string;
}

/** 保存职位权限 */
export interface RolePermSavePayload {
  roleId: string;
  /** 全量覆盖（非增量合并） */
  perms: RolePermMap;
}

/** 从其他职位复制权限 */
export interface RolePermCopyPayload {
  /** 目标职位 */
  targetRoleId: string;
  /** 来源职位 */
  sourceRoleId: string;
}

/** 权限树勾选统计（弹窗底部实时统计） */
export interface PermTreeSelectionStats {
  /** 已选动作数（去重） */
  checkedActionCount: number;
  /** 覆盖模块数 */
  coveredModuleCount: number;
  /** 系统权限点总数 */
  totalActionCount: number;
}

/* ============================================================
 * 六、操作日志
 * ============================================================ */

/** 操作日志实体 */
export interface PermLog extends BaseEntity {
  /** 操作时间 */
  logTime: string;
  /** 操作人 */
  operatorName: string;
  /** 操作人职位 */
  operatorRole: string;
  /** 所属模块：市场咨询 / 教学部门 / 实训-教学 / 就业管理 / 教务部门 / 财务管理 / 审批中心 / 权限管理 */
  moduleName: string;
  /** 操作类型：登录 / 新增 / 修改 / 删除 / 审批 / 导出 / 权限变更 */
  actionType: string;
  /** 操作对象 */
  targetObj: string;
  /** 操作前值 */
  beforeValue: string;
  /** 操作后值 */
  afterValue: string;
  /** 来源 IP */
  ip: string;
  /** 结果 */
  result: LogResult;
}

/** 日志查询参数 */
export interface PermLogQuery extends PageQuery {
  /** 操作人 / 对象 / IP 模糊搜索 */
  keyword?: string;
  moduleName?: string;
  actionType?: string;
  result?: LogResult;
  operatorName?: string;
  startDate?: string;
  endDate?: string;
}

/* ============================================================
 * 七、规则配置
 * ============================================================ */

/** 密码策略 */
export interface PwdRule {
  /** 密码最小长度 6/8/10/12 */
  min: number;
  /** 要求大写字母 */
  upper: boolean;
  /** 要求数字 */
  digit: boolean;
  /** 要求特殊符号 */
  symbol: boolean;
  /** 密码有效期（天），0 = 永久 */
  expireDays: number;
  /** 强制首次登录修改密码 */
  forceFirst: boolean;
  /** 密码错误锁定次数 3/5/8/10 */
  retry: number;
  /** 锁定时长（分钟），0 = 永久锁定 */
  lockMin: number;
}

/** 登录安全 */
export interface LoginRule {
  /** IP 白名单限制（由部署方配置的校内网网段） */
  ip: boolean;
  /** 允许登录时间段，形如 '07:00-23:00' */
  time: string;
  /** 是否限制同账号并发登录 */
  limit: boolean;
  /** 同账号允许并发数，1 = 仅允许 1 处登录 */
  sameAcct: number;
}

/** 审批流程配置 */
export interface ApprovalRule {
  /** 休学/退学审批链 */
  holiday: string;
  /** 退费审批链 */
  refund: string;
  /** 教务核算 → 出款链 */
  settle: string;
}

/** 规则配置总集 */
export interface PermRules {
  pwd: PwdRule;
  login: LoginRule;
  approval: ApprovalRule;
}

/** 保存规则参数 */
export interface PermRuleSavePayload {
  group: 'pwd' | 'login' | 'approval';
  value: Record<string, unknown>;
}

/* ============================================================
 * 八、权限总览
 * ============================================================ */

/** 总览 KPI */
export interface PermOverview {
  /** 职位总数 */
  roleTotal: number;
  /** 其中启用数 */
  roleEnabled: number;
  /** 账号总数 */
  userTotal: number;
  /** 其中正常数 */
  userNormal: number;
  /** 可配置权限点（动作总数） */
  permPointTotal: number;
  /** 模块数 */
  moduleTotal: number;
  /** 功能点总数 */
  itemTotal: number;
  /** 部门总数（学段已并入教学部，口径 = 7） */
  deptTotal: number;
  /** 下设学段数（3） */
  stageTotal: number;
  /** 最近操作动态 */
  recentLogs: PermLog[];
}

/** 部门管理 KPI */
export interface DeptOverview {
  /** 部门总数（7，学段合并统计） */
  deptTotal: number;
  /** 下设学段（3） */
  stageTotal: number;
  /** 归属职位数 */
  roleTotal: number;
  /** 归属账号数 */
  userTotal: number;
}

/** 职位管理 KPI */
export interface RoleOverview {
  roleTotal: number;
  presetTotal: number;
  customTotal: number;
  disabledTotal: number;
}

/** 账号管理 KPI（5 个，均可点击筛选） */
export interface UserOverview {
  userTotal: number;
  normalTotal: number;
  disabledTotal: number;
  lockedTotal: number;
  needChangePwdTotal: number;
}

/** 操作日志 KPI（5 个，均可点击筛选） */
export interface LogOverview {
  logTotal: number;
  successTotal: number;
  failTotal: number;
  loginTotal: number;
  approveTotal: number;
}

/** 职位权限分配 左栏职位项 */
export interface AssignRoleItem {
  id: string;
  roleName: string;
  roleCode: string;
  deptName: string;
  roleType: RoleType;
  isSys: boolean;
  /** 职位状态（停用的职位在权限配置页会标出来，防止误配） */
  roleStatus: RoleStatus;
  permCount: number;
}

/* ============================================================
 * 九、可选项字典（前端下拉用，后端 /api/perm/option/* 提供）
 * ============================================================ */

export interface PermOptionItem<T = string | number> {
  value: T;
  label: string;
}

export interface PermOptions {
  roleTypes: PermOptionItem<RoleType>[];
  roleStatuses: PermOptionItem<RoleStatus>[];
  userStatuses: PermOptionItem<UserStatus>[];
  deptLevels: PermOptionItem<DeptLevel>[];
  dataScopes: PermOptionItem<DataScope>[];
  baseActions: PermOptionItem<PermBaseAction>[];
  /** 导出范围 三选一 */
  exportScopes: PermOptionItem<string>[];
  /** 当前生效的密码策略提示文案（由各项配置动态拼接） */
  pwdTipText: string;
}

/** 导出范围（通用导出弹窗，三选一） */
export enum ExportScope {
  CURRENT_PAGE = '当前页',
  FILTERED = '全部筛选结果',
  ALL = '全部数据',
}

/** 性别中文名映射（前端下拉直接用） */
export const PERM_GENDER_NAME = GENDER_NAME;
