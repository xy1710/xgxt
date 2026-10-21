/**
 * 可选项字典缓存（Pinia）
 *
 * ⚠️ 为什么要有这个 store？
 *    字典来自 `GET /api/perm/option/get`，而它被 3 处调用：
 *      LogQuery（日志筛选）、RoleManage（职位表单）、UserManage（账号表单）。
 *    原来每进一个页面都要打一次这个接口 —— 而字典内容是「全局固定」的，
 *    一个会话内完全没有必要重复拉。
 *
 *    放进 store 后：**一个会话只请求一次**，并额外做了「并发去重」——
 *    多个组件同时首次加载时只会发一个请求，其余复用同一个 Promise。
 *
 * 注意：字典会随「密码策略」变化（pwdTipText 是按当前策略动态拼接的）。
 *      ⚠️ 2026-10-06：原先由 RuleConfig（规则配置页）保存密码策略后调
 *      `load(true)` 强制刷新，该页面已删除 → 目前**没有调用方**再传 force；
 *      `load(force)` 这个能力保留（将来若密码策略改由别处维护可直接复用）。
 */

import { defineStore } from 'pinia';
import { optionApi } from '@/perm/api/perm';
import type { PermOptions, PermOptionItem } from 'shared-types/perm';

type OptionDict = PermOptions & Record<string, any>;

export const useOptionStore = defineStore('perm-option', {
  state: () => ({
    /** 字典内容 */
    data: null as OptionDict | null,
    /** 加载中 */
    loading: false,
    /** 正在飞行的请求（并发去重用） */
    inflight: null as Promise<OptionDict> | null,
  }),

  getters: {
    /** 是否已加载 */
    loaded: (s): boolean => !!s.data,
    /**
     * ⚠️ 字典项是 `{ value, label }` 对象，不是裸字符串。
     *    El 的 el-select / el-option 直接用 `:value="o.value" :label="o.label"`。
     */
    roleTypes: (s): PermOptionItem[] => s.data?.roleTypes || [],
    roleStatuses: (s): PermOptionItem[] => s.data?.roleStatuses || [],
    userStatuses: (s): PermOptionItem[] => s.data?.userStatuses || [],
    deptLevels: (s): PermOptionItem[] => s.data?.deptLevels || [],
    dataScopes: (s): PermOptionItem[] => s.data?.dataScopes || [],
    baseActions: (s): PermOptionItem[] => s.data?.baseActions || [],
    exportScopes: (s): PermOptionItem[] => s.data?.exportScopes || [],
    /** 操作日志用（在 PermOptions 类型里没声明，接口实际会返回，故走 Record 兜底） */
    logActionTypes: (s): PermOptionItem[] => (s.data?.logActionTypes as PermOptionItem[]) || [],
    logModules: (s): PermOptionItem[] => (s.data?.logModules as PermOptionItem[]) || [],
    logResults: (s): PermOptionItem[] => (s.data?.logResults as PermOptionItem[]) || [],
    /** 密码提示文案（随密码策略动态变化） */
    pwdTipText: (s): string => s.data?.pwdTipText || '',
  },

  actions: {
    /**
     * 加载字典
     * @param force 强制重新拉取（默认命中缓存直接返回）
     */
    async load(force = false): Promise<OptionDict | null> {
      if (!force && this.data) return this.data;
      // 并发去重：已经有一个请求在路上，就复用它，不再发第二个
      if (!force && this.inflight) {
        try {
          return await this.inflight;
        } catch {
          return null;
        }
      }

      this.loading = true;
      const req = optionApi.get() as unknown as Promise<OptionDict>;
      this.inflight = req;
      try {
        this.data = await req;
        return this.data;
      } catch {
        // 错误提示已由 request 拦截器统一弹出
        return null;
      } finally {
        this.inflight = null;
        this.loading = false;
      }
    },
  },
});
