/**
 * 权限树缓存（Pinia）
 *
 * ⚠️ 为什么要有这个 store？
 *    完整权限树（8 模块 / 46 个顶级功能点 / 157 动作）被 4 处使用：
 *      App 顶栏（只取 stats）、权限总览（画模块分布图 + 手动刷新缓存）、
 *      权限配置（左树勾选）、职位管理（新建职位时选权限）。
 *    原来每进一个页面都重新拉一次全量树 —— 而树的变动频率极低。
 *
 *    放进 store 后：进过一次就缓存住；需要强制刷新时走 `loadTree(true)`，
 *    对应后端 `?refresh=1`（绕过后端那层 60 秒内存缓存重新查库）。
 *
 * ⚠️ 注意：这个「前端缓存」和后端 menu.route.ts 的「60 秒内存缓存」是两层，
 *    不要混为一谈。前端缓存活到刷新页面；后端缓存 60 秒自动过期。
 */

import { defineStore } from 'pinia';
import { menuApi } from '@/perm/api/perm';
import type { PermModule, PermTreeStats } from 'shared-types/perm';

export const usePermStore = defineStore('perm-tree', {
  state: () => ({
    /** 完整权限树 */
    modules: [] as PermModule[],
    /** 统计（模块数 / 功能点数 / 权限点数） */
    stats: null as PermTreeStats | null,
    /** 权限树加载中 */
    treeLoading: false,
    /** 已加载过标记，避免重复请求 */
    treeLoaded: false,
    /** 上次加载时间戳（毫秒） */
    loadedAt: 0,
  }),

  getters: {
    /** 模块数 */
    modCount: (s): number => s.stats?.modCount ?? s.modules.length,
    /** 功能点数 */
    itemCount: (s): number => s.stats?.itemCount ?? 0,
    /** 权限点数（按全部功能点求和，含二级功能点） */
    actionCount: (s): number => s.stats?.actionCount ?? 0,
    /** 是否已加载过权限树 */
    loaded: (s): boolean => s.treeLoaded,
  },

  actions: {
    /**
     * 加载权限树
     * @param refresh 是否绕过前后端两层缓存强制重取
     */
    async loadTree(refresh = false): Promise<PermModule[]> {
      if (!refresh && this.treeLoaded && this.modules.length) {
        return this.modules;
      }
      this.treeLoading = true;
      try {
        const tree = (await menuApi.tree(refresh)) as unknown as PermModule[];
        this.modules = tree;
        this.treeLoaded = true;
        this.loadedAt = Date.now();
        return tree;
      } catch {
        // 错误提示已由 request 拦截器统一弹出
        return this.modules;
      } finally {
        this.treeLoading = false;
      }
    },

    /**
     * 加载权限树统计（顶栏展示用）
     * @param force 强制重取
     */
    async loadStats(force = false): Promise<PermTreeStats | null> {
      if (!force && this.stats) return this.stats;
      try {
        this.stats = (await menuApi.stats()) as PermTreeStats;
        return this.stats;
      } catch {
        // 后端没起时不阻塞界面
        return this.stats;
      }
    },

    /** 一键刷新：树 + 统计都重取（权限总览页的「刷新」按钮用） */
    async refreshAll(): Promise<void> {
      await Promise.all([this.loadTree(true), this.loadStats(true)]);
    },
  },
});
