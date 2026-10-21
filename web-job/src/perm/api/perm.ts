/**
 * 权限管理 · 前端接口层
 *
 * ⚠️ 所有接口都走 @/perm/api/request 的 http（自动带 token、自动弹错、自动解包 data）。
 * ⚠️ 路径前缀统一 /api/perm，由 vite.config.ts 代理到 8006。
 * ⚠️ 类型全部来自 shared-types —— 字段写错在编译期就会报错，
 *    这样前后端不会出现「我传的 userStatus、他收的 status」这种事故。
 */

import { http, API_BASE, isMockMode } from './request';
import type {
  PageData,
  PermDept,
  PermDeptTreeNode,
  DeptOverview,
  PermDeptSavePayload,
  PermRoleListItem,
  PermRoleDetail,
  RoleOverview,
  PermRoleSavePayload,
  RoleCodeItem,
  PermUserListItem,
  PermUserDetailResponse,
  UserOverview,
  PermUserSavePayload,
  PermAuthProfile,
  PermModule,
  PermTreeStats,
  AssignRoleItem,
  AssignTreeData,
  RolePermMap,
  PermLog,
  LogOverview,
  PermOptions,
  PermOverview,
  ExportScope,
  PermMenuItemAdmin,
  PermItemSavePayload,
  PermItemSaveResult,
} from 'shared-types/perm';

const P = '/api/perm';

/* ============================================================
 * 一、权限总览
 * ============================================================ */

export const overviewApi = {
  get: () => http.get<PermOverview>(`${P}/overview/get`),
};

/* ============================================================
 * 二、部门管理
 * ============================================================ */

export const deptApi = {
  list: (params?: Record<string, any>) => http.get<PageData<PermDept>>(`${P}/dept/list`, params),
  tree: () => http.get<PermDeptTreeNode[]>(`${P}/dept/tree`),
  overview: () => http.get<DeptOverview>(`${P}/dept/overview`),
  detail: (id: string) => http.get<PermDept>(`${P}/dept/detail`, { id }),
  add: (data: PermDeptSavePayload) => http.post<{ id: string }>(`${P}/dept/add`, data),
  update: (data: PermDeptSavePayload & { id: string }) => http.put<null>(`${P}/dept/update`, data),
  remove: (id: string) => http.delete<null>(`${P}/dept/delete/${id}`),
};

/* ============================================================
 * 三、职位管理
 * ============================================================ */

export const roleApi = {
  list: (params?: Record<string, any>) => http.get<PageData<PermRoleListItem>>(`${P}/role/list`, params),
  detail: (id: string) => http.get<PermRoleDetail>(`${P}/role/detail`, { id }),
  add: (data: PermRoleSavePayload) => http.post<{ id: string; permCount: number }>(`${P}/role/add`, data),
  update: (data: PermRoleSavePayload & { id: string }) => http.put<null>(`${P}/role/update`, data),
  remove: (id: string) => http.delete<null>(`${P}/role/delete/${id}`),
  setStatus: (id: string, roleStatus: string) => http.put<null>(`${P}/role/status`, { id, roleStatus }),
  overview: () => http.get<RoleOverview>(`${P}/role/overview`),
  codes: () => http.get<RoleCodeItem[]>(`${P}/role/codes`),
  exportList: (params?: Record<string, any>) =>
    http.get<{ total: number; list: PermRoleListItem[] }>(`${P}/role/export`, params),
  importList: (list: any[]) =>
    http.post<{ success: number; fail: number; errors: { row: number; reason: string }[] }>(
      `${P}/role/import`,
      { list },
    ),
};

/* ============================================================
 * 四、账号管理
 * ============================================================ */

export const userApi = {
  list: (params?: Record<string, any>) => http.get<PageData<PermUserListItem>>(`${P}/user/list`, params),
  detail: (id: string) => http.get<PermUserDetailResponse['data']>(`${P}/user/detail`, { id }),
  add: (data: PermUserSavePayload) =>
    http.post<{ id: string; password: string }>(`${P}/user/add`, data),
  update: (data: PermUserSavePayload & { id: string }) => http.put<null>(`${P}/user/update`, data),
  remove: (id: string) => http.delete<null>(`${P}/user/delete/${id}`),
  setStatus: (id: string, userStatus: string) => http.put<null>(`${P}/user/status`, { id, userStatus }),
  resetPwd: (payload: { userId: string; newPassword?: string; needChangePwd?: boolean }) =>
    http.put<{ newPassword: string }>(`${P}/user/reset-pwd`, payload),
  unlock: (id: string) => http.put<null>(`${P}/user/unlock`, { id }),
  overview: () => http.get<UserOverview>(`${P}/user/overview`),
  /** 跨模块：登录模块用；本页用于「查看权限」抽屉 */
  authProfile: (account: string) => http.get<PermAuthProfile>(`${P}/user/auth-profile`, { account }),
};

/* ============================================================
 * 五、权限树
 * ============================================================ */

export const menuApi = {
  tree: (refresh = false) => http.get<PermModule[]>(`${P}/menu/tree`, refresh ? { refresh: 1 } : undefined),
  stats: () => http.get<PermTreeStats>(`${P}/menu/stats`),
  /**
   * ★ 2026-10-19 新增：权限点维护（用户自建权限点）
   *
   * 【为什么需要】预置权限树是「系统能力清单」，新部门（招生部）＋新职位（招生老师）
   *   常常需要预置清单里没有的功能点。这一组接口让界面自己加，格式与预置完全一致，
   *   存完立刻出现在权限树里，可以直接勾选给任意职位。
   */
  items: () => http.get<PermMenuItemAdmin[]>(`${P}/menu/items`),
  addItem: (data: PermItemSavePayload) => http.post<PermItemSaveResult>(`${P}/menu/item`, data),
  updateItem: (data: PermItemSavePayload & { id: string }) =>
    http.put<PermItemSaveResult>(`${P}/menu/item`, data),
  removeItem: (id: string) => http.delete<{ itemName: string; affectedRoles: number }>(`${P}/menu/item/${id}`),
};

/* ============================================================
 * 六、职位权限分配
 * ============================================================ */

export const assignApi = {
  roleList: () => http.get<AssignRoleItem[]>(`${P}/assign/role-list`),
  tree: (roleId: string) => http.get<AssignTreeData>(`${P}/assign/tree`, { roleId }),
  save: (roleId: string, perms: RolePermMap) =>
    http.put<{ permCount: number }>(`${P}/assign/save`, { roleId, perms }),
  copy: (targetRoleId: string, sourceRoleId: string) =>
    http.post<{ permCount: number; sourceRoleName: string }>(`${P}/assign/copy`, {
      targetRoleId,
      sourceRoleId,
    }),
  reset: (roleId: string, mode: 'clear' | 'full' = 'clear') =>
    http.post<{ permCount: number }>(`${P}/assign/reset`, { roleId, mode }),
};

/* ============================================================
 * 七、操作日志
 * ============================================================ */

export const logApi = {
  list: (params?: Record<string, any>) => http.get<PageData<PermLog>>(`${P}/log/list`, params),
  detail: (id: string) => http.get<PermLog>(`${P}/log/detail`, { id }),
  overview: () => http.get<LogOverview>(`${P}/log/overview`),
};

/* ============================================================
 * 八、规则配置 —— ⚠️ 2026-10-06 前端已删除
 *
 * 【用户指令】「权限管理板块里面删除规则配置页面」
 *   → 页面（views/RuleConfig.vue）已删除，本节 3 个接口的**前端封装**随之下线
 *     （原文：ruleApi.get / save / reset）。
 *
 * ⚠️ 后端 `/api/perm/rule/get|save|reset`（server-job/src/perm/routes/rule.route.ts）
 *    按项目既有约定【暂留】作为兜底通道（与「账号管理」的处置一致：删前端、留后端）。
 *    它的另一个原因是：**密码策略由 t_perm_rule / pwd 组驱动**
 *    （见 user.route.ts 的 assertPwdStrength），表与接口都还得在。
 *    后续若要彻底下线，连后端路由 + 权限树 MN_perm_04「规则配置」功能点一起删。
 * ============================================================ */

/* ============================================================
 * 九、可选项字典
 * ============================================================ */

export const optionApi = {
  get: () => http.get<PermOptions & Record<string, any>>(`${P}/option/get`),
};

/* ============================================================
 * 十、通用导出
 * ============================================================ */

export const exportApi = {
  /**
   * 生成导出文件并触发浏览器下载
   *
   * ⚠️ scope 用 string 而不是 ExportScope 枚举：
   *    TS 的字符串枚举是「名义类型」，页面里直接写 '全部筛选结果' 这种字面量
   *    会报「不可赋值」。这里放宽为 string，取值仍由后端 zod 兜底校验。
   */
  async do(payload: {
    resource: 'dept' | 'role' | 'user' | 'log';
    scope: ExportScope | string;
    format?: 'excel' | 'csv';
    query?: Record<string, unknown>;
  }) {
    // 导出要后端真的生成文件（exports/ 目录 + 下载流），假数据模式给不了
    if (isMockMode) {
      throw {
        code: 0,
        message: '假数据模式不支持导出：导出需要后端真实生成文件。请用真后端（npm run dev）。',
        data: null,
      };
    }
    const res = await http.post<{ fileName: string; total: number; downloadUrl: string }>(
      `${P}/export/do`,
      { format: 'excel', ...payload },
    );
    // 触发下载（同源，走 vite 代理）
    const a = document.createElement('a');
    a.href = res.downloadUrl;
    a.download = res.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return res;
  },
};

/* ============================================================
 * ⭐ 登录人信息（2026-10-03 接入统一门户新增）
 *
 * ⚠️ 本模块不提供登录接口 —— 登录统一由门户（8000）负责。
 *    这两个接口只做一件事：把门户 token 换成前端能用的 profile。
 * ============================================================ */

/** 权限模块的登录人档案（与 shared-types/perm-auth.ts 的 PermProfile 对应） */
export interface PermProfileResp {
  accountId: string;
  account: string;
  userName: string;
  kind: string;
  isSysAdmin: boolean;
  menuKeys: string[];
}

export const authApi = {
  /** 当前登录人 + 可访问页面 */
  profile: () => http.get<{ profile: PermProfileResp; menuKeys: string[] }>(`${P}/auth/profile`),
  /** 仅菜单（轻量） */
  menus: () => http.get<{ menuKeys: string[] }>(`${P}/auth/menus`),
};
