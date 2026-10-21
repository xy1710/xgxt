/**
 * 当前登录用户（Pinia）
 *
 * ⚠️⚠️ 2026-10-03 接入统一门户改造
 *
 * 改造前：账号写死成 DEV_ACCOUNT = 'admin'，调 /user/auth-profile?account=admin
 *         —— 换个账号进来还是显示「系统管理员」，是假的。
 * 改造后：token 由门户签发（从 URL 接管，见 utils/portal-token.ts），
 *         调新增的 /api/perm/auth/profile，后端从 token 里解出「我是谁」。
 *
 * ⚠️ 为什么还要保留 userApi.authProfile？
 *    那个接口是给「账号管理」页的『查看权限』抽屉用的
 *    —— 管理员查任意账号的权限。和「我是谁」不是一回事，两者并存。
 *
 * 数据来源：GET /api/perm/auth/profile（凭门户 token）
 */

import { defineStore } from 'pinia';
import { authApi, userApi, type PermProfileResp } from '@/perm/api/perm';
import type { PermAuthProfile } from 'shared-types/perm';

export const useUserStore = defineStore('perm-user', {
  state: () => ({
    /** 当前登录人档案（来自门户 token）；null 表示还没加载 */
    profile: null as PermProfileResp | null,
    /** 正在请求 */
    loading: false,

    /**
     * ⚠️ 兼容层：原来的「查看权限」抽屉读的是 PermAuthProfile，
     *    接入门户后这部分能力没变，保留独立字段避免大改页面代码。
     */
    adminViewProfile: null as PermAuthProfile | null,
  }),

  getters: {
    /** 姓名 */
    userName: (s): string => s.profile?.userName || '未登录',
    /** 登录账号 */
    account: (s): string => s.profile?.account || '',
    /** 职位名数组（接入门户后，顶栏显示身份头衔） */
    roleNames: (s): string[] => {
      if (!s.profile) return [];
      return s.profile.isSysAdmin ? ['系统管理员'] : ['权限管理员'];
    },
    /** 是否系统管理员 */
    isSysAdmin: (s): boolean => !!s.profile?.isSysAdmin,
    /** ⭐ 可访问的页面 key（路由守卫读它） */
    menuKeys: (s): string[] => s.profile?.menuKeys || [],
    /** 头像里用的首字（姓名第一个字） */
    initial: (s): string => (s.profile?.userName || '未').slice(0, 1),
    /** 所属部门名（接入门户后保持展示位） */
    deptName: (): string => '信息中心',
    /** 生效权限点数量（门户为粗粒度授权，用菜单数近似展示） */
    permCount: (s): number => (s.profile?.menuKeys || []).length,
  },

  actions: {
    /**
     * 拉取当前登录人档案（凭门户 token）
     *
     * @param force 强制重新拉取
     */
    async fetchProfile(force = false): Promise<PermProfileResp | null> {
      if (!force && this.profile) return this.profile;
      this.loading = true;
      try {
        const res = await authApi.profile();
        this.profile = res.profile;
        return this.profile;
      } catch {
        // 错误提示已由 request 拦截器统一弹出，这里只负责不阻塞界面
        this.profile = null;
        return null;
      } finally {
        this.loading = false;
      }
    },

    /**
     * 管理员查任意账号的权限（「查看权限」抽屉用）
     * ⚠️ 与「我是谁」是两回事，走的是原来的跨模块接口。
     */
    async fetchAdminViewProfile(account: string, force = false): Promise<PermAuthProfile | null> {
      if (!force && this.adminViewProfile) return this.adminViewProfile;
      try {
        this.adminViewProfile = (await userApi.authProfile(account)) as PermAuthProfile;
        return this.adminViewProfile;
      } catch {
        return null;
      }
    },

    /** 是否拥有某个菜单（路由守卫与页面内按钮显隐） */
    hasMenu(key: string): boolean {
      return this.menuKeys.includes(key);
    },

    /** 是否系统管理员 */
    isSysAdminCheck(): boolean {
      return this.isSysAdmin;
    },

    /** 退出登录：清 token 并跳门户 */
    logout(): void {
      localStorage.removeItem('sms_token');
      localStorage.removeItem('portal_modules');
      this.profile = null;
      window.location.href = '/#/login';
    },

    /** 切换账号 / 退出登录时清空 */
    reset(): void {
      this.profile = null;
      this.adminViewProfile = null;
    },
  },
});
