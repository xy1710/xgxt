/**
 * ⭐ 权限模块 HTTP 客户端（咨询模块侧）
 *
 * ⚠️⚠️ 本文件承载两件事，别混在一起：
 *
 * 【一】登录时取权限写进 token（《三方操作清单-角色编码统一-20261002》第三节）
 *
 *    GET http://<权限模块地址>:8006/api/perm/user/auth-profile?account=<登录账号>
 *    Header: Authorization: Bearer <内部密钥>
 *    从返回里取这 4 个字段写进 token：userId / roles / permissions / dataScope
 *
 *    ⚠️ 这个接口「不需要登录就能调」（权限模块自己会回「账号不存在」），
 *       所以登录流程里可以放心前置调用。
 *
 *    ⚠️ 降级策略（关键）：
 *       权限模块 8006 可能没起（本地开发常见）。这时【不能】让用户登录不了，
 *       而是降级成「按本模块账号表里的岗位角色」造一份兜底权限，并在返回值里
 *       标记 degraded=true，让前端能提示「权限模块未连接，当前为本地兜底权限」。
 *       文档原话：「只要 token 里能解出这 4 个，我们这边就不用改任何代码」——
 *       所以降级时 [roles] 也必须填成【统一后的新编码】，否则别的模块仍然认不出来。
 *
 * 【二】按「权限分配」结果算咨询菜单（2026-10-03 新增 · 本轮联调）
 *
 *    GET http://<权限模块地址>:8006/api/perm/remote/account-profile?account=<登录账号>
 *    拿到该账号在权限库里的【功能点清单】，用 consultMenusFromPerm() 换算成
 *    咨询模块的 menuKeys —— 这样权限分配页改了什么，咨询菜单就跟着变。
 *
 *    改造前：menuKeys 一律由 menusOf(row.role) 按本模块岗位硬算
 *            → 权限分配改什么都影响不到咨询，分配形同虚设。
 *    改造后：优先用权限分配的结果；拿不到才回退岗位兜底。
 */

import {
  PERM_ACCOUNT_PROFILE_PATH,
  type RemotePermProfile,
  type RemotePermResult,
} from 'shared-types/consult';
import { config } from '../config';
/**
 * ★ 2026-10-14：底层 HTTP 从原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
 *   本文件 3 处调用全部**保留原语义**：
 *     · fetchAuthProfile / fetchPermProfile 都【不抛错】，要把「连不上」和
 *       「账号不存在」分开返回给调用方 → 用 `raw: true` 自己拿完整响应体判 code，
 *       不让统一拦截器把「业务码非 200」一律变成异常。
 *     · permHealth 的判据是「HTTP 状态码 < 500」（服务只要在响应就算健康），
 *       axios 会把 4xx 也当失败抛出，所以从 RemoteError.detail 里把状态码取回来。
 */
import { moduleUrl, remoteGet, isRemoteTimeout } from '../../shared/http';

/** 调权限接口的超时时间（毫秒）—— 权限模块是登录链路的一环，不能等太久 */
const TIMEOUT_MS = 2500;

/**
 * 权限模块地址（与统一封装的 config.services.perm 同源）
 *
 * ★ 2026-10-14：原来还兜底一个 shared-types 里的 DEFAULT_PERM_URL，
 *   那是「独立进程时代」的 8006。合并成单进程后 config.services.perm 的默认值
 *   已经指向本进程端口，比那个兜底更正确，故去掉三级兜底、统一走 moduleUrl。
 */
function permBaseUrl(): string {
  return moduleUrl('perm').replace(/\/$/, '');
}

/** 权限模块返回的「登录用档案」 */
export interface PermAuthProfile {
  /** 用户 id，例如 U013 */
  userId: string;
  /** 角色编码数组（统一后的新编码，如 ['TEACH_DEAN']） */
  roles: string[];
  /** 权限点数组，如 ['market:学生档案:view'] */
  permissions: string[];
  /** 数据范围：1 本人 / 2 本班 / 3 本部门 / 4 全部 */
  dataScope: number;
  /** 姓名 */
  userName: string;
}

/** 权限模块原始响应 */
interface PermResponse<T> {
  code: number;
  message: string;
  data: T;
}

/** 取权限档案的结果（含降级标记） */
export interface PermProfileResult {
  profile: PermAuthProfile;
  /** true = 权限模块没连上，用的是本地兜底权限 */
  degraded: boolean;
  /** 降级原因（便于提示与排查） */
  degradeReason?: string;
}

/* ============================================================
 * 一、登录时取权限（写进 token）
 * ============================================================ */

/**
 * 调权限模块取「登录用档案」
 *
 * @param account 登录账号（如 wangjl）
 * @returns 成功 → { profile, degraded:false }
 *          连不上/超时 → { profile: null, degraded:true, degradeReason }
 *          账号不存在（权限模块明确回 404/非 200）→ { profile: null, degraded:false, notFound:true }
 *
 * ⚠️ 本函数【不抛错】，把「连不上」和「账号不存在」分开交给调用方决策。
 */
export async function fetchAuthProfile(account: string): Promise<{
  profile: PermAuthProfile | null;
  degraded: boolean;
  degradeReason?: string;
  notFound?: boolean;
}> {
  let json: PermResponse<PermAuthProfile | null>;
  try {
    json = await remoteGet<PermResponse<PermAuthProfile | null>>(
      'perm',
      `/api/perm/user/auth-profile?account=${encodeURIComponent(account)}`,
      {
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ 开发期用固定内部密钥；正式环境应换成服务间凭证
          Authorization: `Bearer ${config.internalToken}`,
        },
        raw: true,
      },
    );
  } catch (err: any) {
    const reason = isRemoteTimeout(err)
      ? `权限模块响应超时（超过 ${TIMEOUT_MS / 1000} 秒）`
      : `无法连接权限模块（${permBaseUrl()}），请确认权限服务已启动`;
    return { profile: null, degraded: true, degradeReason: reason };
  }

  // 对方返回的不是本系统统一结构（例如网关的 HTML 错误页）
  if (!json || typeof json !== 'object') {
    return {
      profile: null,
      degraded: true,
      degradeReason: '权限模块返回了无法解析的内容',
    };
  }

  // ---- 业务码非 200：区分「账号不存在」和「其他错误」----
  if (json.code !== 200 || !json.data) {
    // 权限模块明确回「账号不存在」→ 这不是故障，是业务结果
    return {
      profile: null,
      degraded: false,
      notFound: true,
      degradeReason: json.message || '权限模块中不存在该账号',
    };
  }

  const d = json.data;
  return {
    profile: {
      userId: String(d.userId ?? ''),
      roles: Array.isArray(d.roles) ? d.roles : [],
      permissions: Array.isArray(d.permissions) ? d.permissions : [],
      dataScope: Number(d.dataScope ?? 4),
      userName: String(d.userName ?? ''),
    },
    degraded: false,
  };
}

/* ============================================================
 * 二、⭐ 按「权限分配」结果取权限全景档案（2026-10-03 本轮联调新增）
 * ============================================================ */

/**
 * 取某账号的权限全景档案（角色 / 权限点 / 各模块功能点清单）
 *
 * ⚠️ 与上面 fetchAuthProfile 的区别：
 *    · fetchAuthProfile → 旧接口，只回 4 个字段，用于写 token
 *    · fetchPermProfile → 新接口，多回 moduleItems（各模块下的功能点清单），
 *                         这是「权限分配 → 咨询菜单」联调的关键原料
 *
 * ⚠️ 本函数【不抛错】—— 把「连不上」「账号不存在」都变成 degraded 结果，
 *    交给调用方决定兜底，避免权限模块抖动导致咨询模块进不去。
 *
 * @param account 登录名（如 wangjl）
 */
export async function fetchPermProfile(account: string): Promise<RemotePermResult> {
  if (!account) {
    return { profile: null, degraded: true, degradeReason: '缺少登录名，无法取权限档案' };
  }

  let json: PermResponse<RemotePermProfile>;
  try {
    json = await remoteGet<PermResponse<RemotePermProfile>>(
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

  // ⚠️ found=false = 权限库里没这个人（正常业务结果，不是故障）
  if (!json.data.found) {
    return {
      profile: null,
      degraded: true,
      degradeReason: `权限库中未找到账号「${account}」，请到「权限管理 → 账号管理」中补录`,
    };
  }

  return { profile: json.data, degraded: false };
}

/** 健康检查（启动时探测权限模块是否在线，不在线只警告不阻断） */
export async function permHealth(): Promise<boolean> {
  try {
    await remoteGet('perm', '/', { timeout: 1500, raw: true });
    return true;
  } catch (err: any) {
    /**
     * ⚠️ 判据与改造前一致：**HTTP 状态码 < 500 就算健康** ——
     *   服务只要在响应就算活着（401/403 也是正常响应，说明对方进程在跑）。
     *   axios 会把 4xx 也当失败抛出，所以从 RemoteError.detail（形如 'HTTP 401'）
     *   里把状态码取回来判断；detail 没有 HTTP 状态码 = 连不上/超时。
     */
    const m = /^HTTP (\d+)$/.exec(String(err?.detail || ''));
    if (m) return Number(m[1]) < 500;
    return false;
  }
}

export default { fetchAuthProfile, fetchPermProfile, permHealth };
