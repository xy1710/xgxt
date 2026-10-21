/**
 * 接口契约：权限管理模块
 *
 * 模块：权限管理（林晓）  端口 8006  接口前缀 /api/perm
 *
 * ⚠️ 遵循《02-接口契约规范》：
 *    · 响应统一 { code, message, data }
 *    · 分页统一 { total, page, size, list }，参数 page / size
 *    · 路径规范 /api/{模块}/{资源}/{动作}
 *    · 枚举双返回 xxx / xxxName
 *    · 金额单位「分」，时间格式 YYYY-MM-DD HH:mm:ss
 *
 * 【本文件就是「接口契约」本身 —— 不再是文档，而是编译器能校验的代码。】
 * 调用方 import 这里的类型，字段写错在保存代码时就报错。
 */

import { ApiResponse, PageResponse, PageQuery } from '../common';
import {
  AssignRoleItem,
  DeptOverview,
  ExportScope,
  LogOverview,
  PermAuthProfile,
  PermDept,
  PermDeptQuery,
  PermDeptSavePayload,
  PermDeptTreeNode,
  PermItem,
  PermLog,
  PermLogQuery,
  PermModule,
  PermOptionItem,
  PermOptions,
  PermOverview,
  PermRole,
  PermRoleDetail,
  PermRoleListItem,
  PermRoleQuery,
  PermRoleSavePayload,
  PermRules,
  PermRuleSavePayload,
  PermTreeSelectionStats,
  PermTreeStats,
  PermUser,
  PermUserListItem,
  PermUserQuery,
  PermUserResetPwdPayload,
  PermUserSavePayload,
  RoleOverview,
  RolePermCopyPayload,
  RolePermMap,
  RolePermSavePayload,
  UserOverview,
} from '../perm';

/* ============================================================
 * 契约 1：权限总览
 * 提供方：权限管理（林晓）
 * 路径：  GET /api/perm/overview/get
 * 调用方：权限总览页
 * ============================================================ */

export type PermOverviewResponse = ApiResponse<PermOverview>;

/* ============================================================
 * 契约 2：部门管理
 * 路径：  GET    /api/perm/dept/list
 *        GET    /api/perm/dept/detail?id=xxx
 *        POST   /api/perm/dept/add
 *        PUT    /api/perm/dept/update
 *        DELETE /api/perm/dept/delete/:id
 *        GET    /api/perm/dept/tree
 *        GET    /api/perm/dept/overview
 * ============================================================ */

export type DeptListQuery = PermDeptQuery;
export type PermDeptListResponse = PageResponse<PermDept>;
export type PermDeptDetailResponse = ApiResponse<PermDept>;
export type PermDeptTreeResponse = ApiResponse<PermDeptTreeNode[]>;
/** 部门 KPI：{ deptTotal, stageTotal, roleTotal, userTotal } */
export type PermDeptOverviewResponse = ApiResponse<DeptOverview>;
export type PermDeptAddResponse = ApiResponse<{ id: string }>;
export type PermDeptUpdateResponse = ApiResponse<null>;
export type PermDeptDeleteResponse = ApiResponse<null>;
export type PermDeptSaveBody = PermDeptSavePayload;

/* ============================================================
 * 契约 3：职位管理
 * 路径：  GET    /api/perm/role/list
 *        GET    /api/perm/role/detail?id=xxx
 *        POST   /api/perm/role/add
 *        PUT    /api/perm/role/update
 *        DELETE /api/perm/role/delete/:id
 *        PUT    /api/perm/role/status
 *        GET    /api/perm/role/overview
 *        GET    /api/perm/role/export
 *        POST   /api/perm/role/import
 *        GET    /api/perm/role/template
 *
 * ⚠️ 跨模块：登录模块调 GET /api/perm/role/codes 取全部职位编码
 * ============================================================ */

export type PermRoleListResponse = PageResponse<PermRoleListItem>;
export type PermRoleDetailResponse = ApiResponse<PermRoleDetail>;
export type PermRoleOverviewResponse = ApiResponse<RoleOverview>;
export type PermRoleAddResponse = ApiResponse<{ id: string }>;
export type PermRoleUpdateResponse = ApiResponse<null>;
export type PermRoleDeleteResponse = ApiResponse<null>;
export type PermRoleSaveBody = PermRoleSavePayload;

/** 启用/停用职位 */
export interface PermRoleStatusPayload {
  id: string;
  roleStatus: '启用' | '停用';
}
export type PermRoleStatusResponse = ApiResponse<null>;

/** 职位编码清单（跨模块：登录模块签发 token 用） */
export interface RoleCodeItem {
  roleCode: string;
  roleName: string;
  roleStatus: string;
  isSys: boolean;
}
export type PermRoleCodesResponse = ApiResponse<RoleCodeItem[]>;

/* ============================================================
 * 契约 4：用户（账号）管理
 * 路径：  GET    /api/perm/user/list
 *        GET    /api/perm/user/detail?id=xxx
 *        POST   /api/perm/user/add
 *        PUT    /api/perm/user/update
 *        DELETE /api/perm/user/delete/:id
 *        PUT    /api/perm/user/status
 *        PUT    /api/perm/user/reset-pwd
 *        PUT    /api/perm/user/unlock
 *        GET    /api/perm/user/overview
 *
 * ⚠️ 跨模块：登录模块调 GET /api/perm/user/auth-profile?account=xxx
 * ============================================================ */

export type PermUserListResponse = PageResponse<PermUserListItem>;
export type PermUserDetailResponse = ApiResponse<PermUser & { roleIds: string[]; roleNames: string[] }>;
export type PermUserOverviewResponse = ApiResponse<UserOverview>;
export type PermUserAddResponse = ApiResponse<{ id: string; password: string }>;
export type PermUserUpdateResponse = ApiResponse<null>;
export type PermUserDeleteResponse = ApiResponse<null>;
export type PermUserSaveBody = PermUserSavePayload;
export type PermUserResetPwdResponse = ApiResponse<{ newPassword: string }>;

/** 启用/停用/解锁账号 */
export interface PermUserStatusPayload {
  id: string;
  userStatus: '正常' | '已停用' | '已锁定';
}
export type PermUserStatusResponse = ApiResponse<null>;

/** 账号鉴权档案（登录模块调用） */
export type PermAuthProfileResponse = ApiResponse<PermAuthProfile>;

/* ============================================================
 * 契约 5：权限树
 * 路径：  GET /api/perm/menu/tree
 *        GET /api/perm/menu/stats
 * ============================================================ */

export type PermMenuTreeResponse = ApiResponse<PermModule[]>;
export type PermMenuStatsResponse = ApiResponse<PermTreeStats>;
export type PermMenuItem = PermItem;

/* ============================================================
 * 契约 6：职位权限分配
 * 路径：  GET  /api/perm/assign/role-list
 *        GET  /api/perm/assign/tree?roleId=xxx    权限树 + 该职位勾选态
 *        PUT  /api/perm/assign/save
 *        POST /api/perm/assign/copy
 *        POST /api/perm/assign/reset
 * ============================================================ */

export type AssignRoleListResponse = ApiResponse<AssignRoleItem[]>;
/** 权限树 + 该职位勾选态；同时回传统计 */
export interface AssignTreeData {
  modules: PermModule[];
  perms: RolePermMap;
  stats: PermTreeStats;
  selected: PermTreeSelectionStats;
}
export type AssignTreeResponse = ApiResponse<AssignTreeData>;
export type AssignSaveBody = RolePermSavePayload;
export type AssignSaveResponse = ApiResponse<{ permCount: number }>;
export type AssignCopyBody = RolePermCopyPayload;
export type AssignCopyResponse = ApiResponse<{ permCount: number; sourceRoleName: string }>;
export type AssignResetResponse = ApiResponse<{ permCount: number }>;

/* ============================================================
 * 契约 7：操作日志
 * 路径：  GET /api/perm/log/list
 *        GET /api/perm/log/detail?id=xxx
 *        GET /api/perm/log/overview
 *        GET /api/perm/log/export
 *
 * ⚠️ 日志只读：不提供 add / update / delete 接口。
 *    写入由后端在关键动作处自动完成（见 server 端 addLog()）。
 * ============================================================ */

export type PermLogListResponse = PageResponse<PermLog>;
export type PermLogDetailResponse = ApiResponse<PermLog>;
export type PermLogOverviewResponse = ApiResponse<LogOverview>;

/* ============================================================
 * 契约 8：规则配置
 * 路径：  GET /api/perm/rule/get
 *        PUT /api/perm/rule/save
 *        PUT /api/perm/rule/reset
 * ============================================================ */

export type PermRuleGetResponse = ApiResponse<PermRules>;
export type PermRuleSaveBody = PermRuleSavePayload;
export type PermRuleSaveResponse = ApiResponse<null>;
export type PermRuleResetResponse = ApiResponse<PermRules>;

/* ============================================================
 * 契约 9：可选项字典（前端下拉统一取这里，避免各页面维护映射表）
 * 路径：  GET /api/perm/option/get
 * ============================================================ */

export type PermOptionsResponse = ApiResponse<PermOptions>;
export type PermOption = PermOptionItem;

/* ============================================================
 * 契约 10：通用导出
 * 路径：  POST /api/perm/export/do
 * ============================================================ */

export interface PermExportPayload {
  /** 导出资源：dept / role / user / log */
  resource: 'dept' | 'role' | 'user' | 'log';
  /** 导出范围三选一 */
  scope: ExportScope;
  /** 导出格式 */
  format: 'excel' | 'csv';
  /** 当前筛选条件（原样回传，后端按同条件取数） */
  query?: Record<string, unknown>;
}
export type PermExportResponse = ApiResponse<{ fileName: string; total: number; downloadUrl: string }>;

/* ============================================================
 * 契约 11：健康检查
 * ============================================================ */

export const PERM_API_PREFIX = '/api/perm';
export const PERM_SERVICE_PORT = 8006;
export type PermHealthResponse = ApiResponse<{
  service: string;
  port: number;
  time: string;
}>;

/* ============================================================
 * 汇总：前端 api 层一份可直接用的类型索引
 * ============================================================ */

export type {
  PermDept,
  PermDeptTreeNode,
  PermRole,
  PermRoleListItem,
  PermRoleDetail,
  PermUser,
  PermUserListItem,
  PermModule,
  PermItem,
  PermLog,
  PermRules,
  PermOverview,
  RolePermMap,
  PermTreeStats,
  PermTreeSelectionStats,
  AssignRoleItem,
  PageQuery,
};
