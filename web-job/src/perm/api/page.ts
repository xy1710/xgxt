/**
 * 权限管理 · 页面管理（板块 → 页面 台账）接口层
 *
 * ⚠️ 与其他 perm 接口一样走 `./request` 的 http（自动带 token、自动弹错、自动解包 data）。
 * ⚠️ 路径前缀统一 /api/perm，由 vite.config.ts 代理到 8004。
 *
 * ⚠️ 本文件只服务「页面管理」页（/perm/page）。
 *    左侧菜单过滤 + 路由守卫用的是 `@/store/pageConfig` 里的原生 fetch
 *    —— 那边要「静默失败」（无 perm 权限的账号不该看到报错弹窗），
 *    与本文件的「报错就弹」是两种不同的错误策略，故意分开。
 */

import { http } from './request';
import type {
  PermPageListResult,
  PermPageSavePayload,
  PermRolePageSavePayload,
  PermRolePageSaveResult,
  PermRolePagesResult,
  PermRoleTreeResult,
} from 'shared-types/perm';

const P = '/api/perm';

/* ============================================================
 * 十、页面管理（板块 → 页面 台账）
 * ============================================================ */

/** 保存结果 */
export interface PermPageSaveResult {
  moduleKey: string;
  enabledCount: number;
  total: number;
}

export const pageApi = {
  /** 板块 + 页面清单 + 启用态 */
  list: () => http.get<PermPageListResult>(`${P}/page/list`),

  /**
   * 保存某板块的勾选（按板块**全量覆盖**）
   * @param moduleKey    板块 key
   * @param enabledPaths 该板块当前打勾的页面 path 数组
   */
  save: (moduleKey: string, enabledPaths: string[]) =>
    http.put<PermPageSaveResult>(`${P}/page/save`, {
      moduleKey,
      enabledPaths,
    } as PermPageSavePayload),

  /** 全部恢复启用 */
  reset: () => http.post<{ affected: number }>(`${P}/page/reset`, {}),

  /* ------------------------------------------------------------
   * ★ 2026-10-07 新增：**职位 → 页面** 台账
   *   左栏「板块 → 职位」，右侧按职位编辑页面可见性。
   * ------------------------------------------------------------ */

  /** 左栏：板块 + 该板块下的职位 */
  roleTree: () => http.get<PermRoleTreeResult>(`${P}/page/role-tree`),

  /** 右侧：某职位在全部板块下的页面勾选态 */
  rolePages: (roleId: string) =>
    http.get<PermRolePagesResult>(`${P}/page/role-pages`, { roleId }),

  /**
   * 保存某职位的页面可见性
   * @param roleId 职位 id
   * @param items  该职位在全部板块下的最终勾选结果（全量）
   */
  saveRole: (roleId: string, items: PermRolePageSavePayload['items']) =>
    http.put<PermRolePageSaveResult>(`${P}/page/role-save`, { roleId, items } as PermRolePageSavePayload),

  /** 恢复默认：删光该职位的显式配置 */
  resetRole: (roleId: string) =>
    http.post<{ affected: number }>(`${P}/page/role-reset`, { roleId }),
};
