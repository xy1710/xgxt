/**
 * 登录态 store（Pinia）
 *
 * ⚠️ token 现在是 JWT（HS256），由后端登录接口签发，
 *    payload 里带 userId / roles / permissions / dataScope 4 个字段
 *    （见《三方操作清单-角色编码统一-20261002》第三节）。
 *    前端只负责原样存进 localStorage 并在请求头带上，不解析、不关心内容。
 *
 * ⚠️⚠️ 2026-10-02 统一门户改造：
 *    TOKEN_KEY 从 'sms_token' 改为 'sms_token'。
 *    原因：门户（5175）是全系统唯一登录入口，它用 iframe 承载本模块时
 *         会把 token 通过 URL 传进来（见 utils/portal-token.ts）。
 *          两边必须用同一个 key，否则 iframe 里会重复要求登录。
 *          本模块自己的登录页仍保留，用于脱离门户单独调试。
 *
 * ⚠️ 菜单机制：后端只下发「菜单 key」（menuKeys），
 *    title / path 由前端维护（见 MENU_MAP），
 *    这样后端改文案不用动前端，前端改路由不用动后端。
 */

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ConsultAccount } from 'shared-types/consult';
import { ConsultRole } from 'shared-types/consult';
import { login as apiLogin, fetchProfile } from '@/consult/api/consult';
import { getPortalToken } from '@/portal/token';

const TOKEN_KEY = 'sms_token';
const MENU_KEYS_KEY = 'sms_menu_keys';

/**
 * 菜单 key → 展示信息（⚠️ key 必须和后端 MENU_ITEMS 对齐）
 *
 * ★ 第 3 期 D2 修 bug（2026-10-09）
 *   原来这一组**全都漏了 `/consult/` 前缀**（写成 `/student` `/fee` `/approve`
 *   `/refund` `/loss`），而路由实际是 `/consult/student` `/consult/fee` …
 *   （见 router/index.ts）—— **点这五个菜单全都 404**，是合并遗留的老 bug，
 *   这次一并修掉。判定方法：菜单路径必须能在 router/index.ts 里找到同名 path。
 */
export const MENU_MAP: Record<string, { title: string; path: string }> = {
  student: { title: '学生管理', path: '/consult/student' },
  fee: { title: '收款与缴费', path: '/consult/fee' },
  approve: { title: '审批中心', path: '/consult/approve' },
  refund: { title: '退费管理', path: '/consult/refund' },
  loss: { title: '流失记录', path: '/consult/loss' },
  // ⚠️ 2026-10-03：account（账号管理）已移除 —— 与权限模块「账号管理」是同一功能，
  //    按用户指令保留权限侧、删除本侧。后端 MENU_ITEMS 同步删除该 key。
};

export const useAuthStore = defineStore('consult-auth', () => {
  // ⚠️ 用 getPortalToken() 而不是直接读 localStorage ——
  //    门户 iframe 带进来的 token 由 utils/portal-token.ts 接管，
  //    这里统一走同一个入口，避免两处 key 写岔。
  const token = ref<string>(getPortalToken());
  const account = ref<ConsultAccount | null>(null);
  const menuKeys = ref<string[]>(JSON.parse(localStorage.getItem(MENU_KEYS_KEY) || '[]'));
  const loading = ref(false);

  /** 是否已登录 */
  const isLogin = computed(() => !!token.value && !!account.value);

  /** 岗位角色（admin / manager / consult） */
  const role = computed<ConsultRole | ''>(() => (account.value?.role as ConsultRole) || '');

  const isAdmin = computed(() => role.value === ConsultRole.ADMIN);
  const isManager = computed(() => role.value === ConsultRole.MANAGER);
  const isConsult = computed(() => role.value === ConsultRole.CONSULT);

  /** 经理及以上（经理 + 管理员） */
  const isManagerUp = computed(() => isManager.value || isAdmin.value);

  /** 侧栏菜单（key 转成 { path, title }） */
  const menus = computed(() =>
    menuKeys.value
      .map((k) => {
        const item = MENU_MAP[k];
        return item ? { key: k, ...item } : null;
      })
      .filter(Boolean) as Array<{ key: string; title: string; path: string }>,
  );

  /** 登录 */
  async function login(accountName: string, password: string) {
    loading.value = true;
    try {
      const res = await apiLogin({ account: accountName, password });
      token.value = res.token;
      account.value = res.account;
      menuKeys.value = res.menuKeys || [];
      localStorage.setItem(TOKEN_KEY, res.token);
      localStorage.setItem(MENU_KEYS_KEY, JSON.stringify(menuKeys.value));
      return res;
    } finally {
      loading.value = false;
    }
  }

  /** 拉取当前登录人（刷新页面后恢复身份） */
  async function loadProfile() {
    // ⚠️ 重新读一遍 token：可能是本次挂载时刚从门户 URL 接管进来的
    token.value = getPortalToken();
    if (!token.value) return null;
    const me = await fetchProfile();
    account.value = me;
    // profile 里可能带 menus（后端 profile 接口也返回），没有就用缓存的 key
    if ((me as any).menuKeys?.length) {
      menuKeys.value = (me as any).menuKeys;
      localStorage.setItem(MENU_KEYS_KEY, JSON.stringify(menuKeys.value));
    }
    return me;
  }

  /** 退出登录 */
  function logout() {
    token.value = '';
    account.value = null;
    menuKeys.value = [];
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(MENU_KEYS_KEY);
  }

  return {
    token,
    account,
    menuKeys,
    loading,
    isLogin,
    role,
    isAdmin,
    isManager,
    isConsult,
    isManagerUp,
    menus,
    login,
    loadProfile,
    logout,
  };
});
