/**
 * ⭐ 权限模块 HTTP 客户端（财务模块侧）
 *
 * ⚠️⚠️ 2026-10-03 新增：打通「权限分配 → 财务菜单」
 *
 * 背景（用户指令）：
 *   「权限管理内的权限分配和财务市场咨询联调一下，
 *     让权限管理内的权限可以正常分配。」
 *
 * 问题：先前财务菜单是 buildProfile() 自己按 FINANCE_ROLE_MENUS 硬算的，
 *       权限分配页改什么都影响不到财务 → 分配形同虚设。
 *
 * 方案：财务登录/刷新时调权限模块的只读接口
 *     GET <PERM_URL>/api/perm/remote/account-profile?account=<登录名>
 *   拿到该账号在权限库里的功能点清单，换算成财务的 menuKeys。
 *
 * ⚠️ 降级策略（关键，与 perm.client 同哲学）：
 *    权限模块没起 / 该账号不在权限库 → 【不能让用户进不来】，
 *    退回原有的「按岗位角色算菜单」逻辑，并标记 degraded。
 *
 * ⚠️ 超时给 2 秒：权限接口是登录链路的一环，不能让人干等。
 */

import {
  PERM_ACCOUNT_PROFILE_PATH,
  type RemotePermProfile,
  type RemotePermResult,
} from 'shared-types/finance';
/**
 * ★ 2026-10-14：底层 HTTP 从原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
 *   语义逐条保持：本文件【不抛错】，把「连不上」翻成 degraded 结果交给调用方兜底
 *   （所以用 `raw: true` 自己拿完整响应体判 code，不让拦截器代判）。
 */
import { moduleUrl, remoteGet, isRemoteTimeout } from '../../shared/http';

/** 调权限接口的超时时间（毫秒） */
const TIMEOUT_MS = 2000;

/**
 * 权限模块地址（与统一封装的 config.services.perm 同源）
 *
 * ★ 2026-10-14：原来兜底用的是 shared-types 里的 DEFAULT_PERM_URL（独立进程时代的
 *   8006）。合并成单进程后 config.services.perm 的默认值已指向本进程端口，更正确。
 */
function permBaseUrl(): string {
  return moduleUrl('perm').replace(/\/$/, '');
}

/** 权限模块统一响应包 */
interface PermEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

/**
 * 取某账号的权限全景档案
 *
 * ⚠️ 本函数【不抛错】—— 把「连不上」「账号不存在」都变成 degraded 结果，
 *    交给调用方决定兜底，避免权限模块抖动导致财务登录失败。
 *
 * @param account 登录名（如 zhoum / liukj）
 */
export async function fetchPermProfile(account: string): Promise<RemotePermResult> {
  if (!account) {
    return { profile: null, degraded: true, degradeReason: '缺少登录名，无法取权限档案' };
  }

  let json: PermEnvelope<RemotePermProfile>;
  try {
    json = await remoteGet<PermEnvelope<RemotePermProfile>>(
      'perm',
      `${PERM_ACCOUNT_PROFILE_PATH}?account=${encodeURIComponent(account)}`,
      {
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
        raw: true,
      },
    );
  } catch (err: any) {
    const reason = isRemoteTimeout(err)
      ? `权限模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`
      : `无法连接权限模块（${permBaseUrl()}），请确认权限服务已启动`;
    return { profile: null, degraded: true, degradeReason: reason };
  }

  if (!json || typeof json !== 'object') {
    return { profile: null, degraded: true, degradeReason: '权限模块返回了无法解析的内容' };
  }

  if (json.code !== 200 || !json.data) {
    return {
      profile: null,
      degraded: true,
      degradeReason: json.message || '权限模块未返回有效数据',
    };
  }

  // ⚠️ found=false 表示「权限库里没这个人」——
  //    这不是故障，是正常业务结果：该账号还没在权限模块配过权限。
  if (!json.data.found) {
    return {
      profile: null,
      degraded: true,
      degradeReason: `权限库中未找到账号「${account}」，请到「权限管理 → 账号管理」中补录`,
    };
  }

  return { profile: json.data, degraded: false };
}

/** 健康检查（启动时探测，不在线只警告不阻断） */
export async function permHealth(): Promise<boolean> {
  try {
    await remoteGet('perm', '/health', { timeout: 1500, raw: true });
    return true;
  } catch (err: any) {
    // 判据与改造前一致：HTTP 状态码 < 500 就算健康（服务在响应即可，401/403 也算）
    const m = /^HTTP (\d+)$/.exec(String(err?.detail || ''));
    if (m) return Number(m[1]) < 500;
    return false;
  }
}

export default { fetchPermProfile, permHealth };
