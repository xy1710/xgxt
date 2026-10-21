/**
 * 跨模块调用 · 领域服务
 * ════════════════════════════════════════════════════════════
 *
 * 底层 HTTP 能力在 utils/http.ts（axios 统一封装），
 * 这个文件只关心「权限模块到底要调别人什么」：
 *
 *   1. pingAllModules()     —— 7 个模块联通自检（联调时最常用：谁没起一眼看出）
 *   2. fetchAuthProfile()   —— 去登录模块取账号档案（职位/权限/数据范围）
 *
 * ⚠️ 这两个函数的区别：
 *    pingAllModules 是「容错」的 —— 某个模块挂了不抛错，而是记进结果里，
 *    因为它本身就是用来排查「谁挂了」的。
 *    真正走业务的调用（fetchAuthProfile）则会把错误抛出去，
 *    由全局错误中间件变成统一响应 —— 这就是「统一拦截错误」。
 * ════════════════════════════════════════════════════════════
 */

import { config } from '../config';
import { remoteGet, ModuleName, MODULE_LABEL, moduleUrl } from '../utils/http';

/**
 * ⭐ 登录模块（auth / 8001）里「取账号档案」的真实路径
 *
 * ⚠️ 2026-10-03 实测校正：咨询模块挂载前缀是 `/api/consult`，
 *    不是 `/api`。原来写 `/api/auth/profile` 会 404。
 *    集中成常量，杜绝两处路由各写各的。
 */
const AUTH_PROFILE_PATH = '/api/consult/account/profile';

/** 一个模块的探活结果 */
export interface ModuleProbe {
  /** 模块简称，如 'edu' */
  module: ModuleName;
  /** 中文名，如 '教务管理(8002)' */
  label: string;
  /** 基础地址 */
  url: string;
  /** 是否在线 */
  online: boolean;
  /** 往返耗时（毫秒） */
  latency: number;
  /** 对方 /health 返回的 service 标识 */
  service: string | null;
  /** 人话说明：'在线' 或具体失败原因 */
  message: string;
}

/** 全部模块的探活汇总 */
export interface ModuleProbeReport {
  total: number;
  onlineCount: number;
  offlineCount: number;
  /** 本次自检时间 'YYYY-MM-DD HH:mm:ss' */
  checkedAt: string;
  list: ModuleProbe[];
}

/** 把 Date 格式化成契约要求的 'YYYY-MM-DD HH:mm:ss' */
function nowText(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 探活单个模块（不抛错 —— 失败也返回一条结果）
 *
 * @param module  模块简称
 * @param timeout 超时毫秒数，默认 2000（探活要快，别让人干等）
 */
export async function pingModule(module: ModuleName, timeout = 2000): Promise<ModuleProbe> {
  const url = moduleUrl(module);
  const label = MODULE_LABEL[module] || module;
  const started = Date.now();

  try {
    // /health 是所有模块约定都有的、不鉴权的健康检查接口
    const data: any = await remoteGet(module, '/health', { timeout, retries: 0 });
    return {
      module,
      label,
      url,
      online: true,
      latency: Date.now() - started,
      service: data?.service ?? null,
      message: '在线',
    };
  } catch (e: any) {
    return {
      module,
      label,
      url,
      online: false,
      latency: Date.now() - started,
      service: null,
      // RemoteError 已经把 ECONNREFUSED 翻译成人话了
      message: e?.message || '未知错误',
    };
  }
}

/**
 * 7 个模块一键联通自检
 *
 * ⚠️ 并发探测（Promise.all），总耗时 ≈ 最慢的那个模块，
 *    而不是 7 个模块耗时相加 —— 否则等一轮要 14 秒。
 */
export async function pingAllModules(timeout = 2000): Promise<ModuleProbeReport> {
  const names = Object.keys(config.services) as ModuleName[];
  const list = await Promise.all(names.map((m) => pingModule(m, timeout)));
  const onlineCount = list.filter((x) => x.online).length;

  return {
    total: list.length,
    onlineCount,
    offlineCount: list.length - onlineCount,
    checkedAt: nowText(),
    // 在线的排前面，方便一眼看到「谁起来了」
    list: list.sort((a, b) => Number(b.online) - Number(a.online)),
  };
}

/**
 * 去登录模块取账号档案（跨模块真实业务调用示例）
 *
 * 登录模块（王寒逸，8001）提供账号的职位 / 权限 / 数据范围，
 * 权限模块做鉴权时需要它。
 *
 * ⚠️ 这里**不吞异常** —— 登录模块没起来时，会抛 RemoteError，
 *    由全局错误中间件统一变成 {code,message,data}。
 *
 * ⚠️⚠️ 2026-10-03 修复（实测踩坑）：
 *    原路径写的是 `/api/auth/profile`，实测返回
 *      { code: 40401, message: '接口不存在：GET /api/auth/profile?account=xxx' }
 *    咨询模块（8001）里真实挂载的路由前缀是 `/api/consult`，
 *    正确路径是 `/api/consult/account/profile`。
 *    这里统一收敛到常量 AUTH_PROFILE_PATH，避免以后再出现两处各写各的。
 *
 * @param account 账号
 * @param token   透传调用方的 Authorization（形如 'Bearer xxx'）
 */
export async function fetchAuthProfile(account: string, token?: string): Promise<any> {
  return remoteGet('auth', AUTH_PROFILE_PATH, {
    params: { account },
    forwardAuth: token,
    timeout: 3000,
    // 网络抖动重试一次即可，别把登录流程拖太久
    retries: 1,
  });
}

/**
 * 用 token 换账号档案（鉴权中间件用）
 *
 * 与上面那个的区别：不知道账号时，直接把 token 透传给登录模块让它自己解。
 *
 * ⚠️ 账号档案（职位 / 权限 / 数据范围）只有登录模块维护一份，
 *    权限模块不重复存 —— 否则两边对不上时极难排查。
 *
 * ⚠️ 同样按 2026-10-03 修复：路径从 `/api/auth/profile`
 *    改为真实的 `/api/consult/account/profile`。
 *
 * @param token Authorization 头原值，形如 'Bearer xxxxx'
 */
export async function fetchProfileByToken(token: string): Promise<any> {
  return remoteGet('auth', AUTH_PROFILE_PATH, {
    forwardAuth: token,
    timeout: 3000,
    retries: 1,
  });
}
