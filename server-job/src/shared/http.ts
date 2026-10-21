/**
 * 跨服务（跨模块）HTTP 客户端 —— axios 统一封装【公共版】
 * ════════════════════════════════════════════════════════════
 *
 * 【这个文件是什么】
 *   全系统**唯一**的服务间调用入口。所有后端模块要调别的模块，
 *   一律走这里的 `remoteGet` / `remotePost`，不要再自己写 fetch 或 axios。
 *
 * ★ 2026-10-14：《技术选型表》约定「跨服务调用 = axios」。
 *   此前项目里两套写法并存 —— `perm/utils/http.ts`（axios 封装）只有权限
 *   模块在用，另外 8 个文件 / 17 处调用各写各的原生 fetch 样板。
 *   现把这份封装提升为公共版，8 个文件全部改用它，历史上那两套写法收敛为一套。
 *
 * 【为什么要封装，不直接 axios.get】
 *   如果每个调用点自己写，会出现：
 *     ✗ 超时时间各写各的（有的 3 秒有的 30 秒）
 *     ✗ 有的解包了 data、有的没解包，调用方写法不统一
 *     ✗ 别人的模块挂了，报出来的是 "ECONNREFUSED" 这种天书
 *   所以统一封装一个客户端 + 统一拦截错误，把这个坑一次性堵掉。
 *
 * 【与前端 axios 封装的关系】
 *   思路与各前端模块的 `api/request.ts` 一致：
 *     · 统一 baseURL 来源（config.services，从 .env 读，不硬编码）
 *     · 请求拦截：注入链路 ID（X-Trace-Id）+ 透传 token
 *     · 响应拦截：解包 {code,message,data}，非 200 直接抛业务错
 *
 * 【错误怎么走】
 *   抛出的 RemoteError 继承自全局的 BizError，
 *   所以会被 middleware/errorHandler.ts 接住，自动变成 {code,message,data}。
 *
 *   ⚠️ 但请注意：**现有的大多数调用点自己 catch 并降级**（返回 null / 记日志），
 *   这是各业务有意为之的容错（例如「推财务失败只记日志，本地留字段人工补录」）。
 *   改造时刻意保留了这些 try/catch —— 本封装只负责「把请求发出去、把错误翻译成人话」，
 *   要不要吞掉错误由调用方决定。
 * ════════════════════════════════════════════════════════════
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { randomUUID } from 'crypto';
/**
 * ⚠️ BizCode 必须从 `shared-types` 主入口取，不能用 `shared-types/perm`。
 *
 *   shared-types 里有 5 份各自独立的 BizCode（common/class/class-jh/consult/finance，
 *   另有 perm 子入口一份）。它们值域有重叠但**是不同类型**。
 *   本文件的 `BizError` 来自主 errorHandler，其 `code` 字段类型就是主入口的 BizCode，
 *   两边必须同源，否则 tsc 直接报类型不兼容。
 *   （4 个用到的成员 SUCCESS/UNAUTHORIZED/NO_OPERATION_PERMISSION/INTERNAL_ERROR
 *     在两个枚举里取值一致，所以运行时行为不变。）
 */
import { BizCode } from 'shared-types';
import { config } from '../config';
import { BizError } from '../middleware/errorHandler';

/** 七个兄弟模块的简称，与 config.services 的 key 一一对应 */
export type ModuleName = keyof typeof config.services;

/**
 * 模块中文名（写日志、报错文案用，让提示能直接看懂）
 *
 * ⚠️ 不写端口号：合并成单进程后各模块同端口，写死端口反而误导。
 */
export const MODULE_LABEL: Record<string, string> = {
  auth: '统一门户/登录',
  edu: '教务管理',
  class: '班级管理（大学部）',
  job: '就业管理（实训）',
  finance: '财务管理',
  perm: '权限管理',
  stat: '统计报表',
  consult: '市场咨询',
};

/** 单个模块的基础地址 */
export function moduleUrl(module: ModuleName): string {
  return config.services[module] || '';
}

export interface RemoteOptions {
  /** 超时毫秒数，默认 5000。探活用 2000，正常业务调用 5000 足够 */
  timeout?: number;
  /** 失败重试次数（仅对「超时 / 连不上」这类可恢复错误生效），默认 0 */
  retries?: number;
  /** 透传的 Authorization 头（形如 'Bearer xxx'） */
  forwardAuth?: string;
  /** 链路 ID，不传自动生成；同一条链路建议传同一个 */
  traceId?: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 查询串参数 */
  params?: Record<string, unknown>;
  /** 请求体（POST/PUT 用） */
  body?: unknown;
  /**
   * 是否返回**完整响应体** `{code,message,data}` 而不是解包后的 data
   *
   * ★ 2026-10-14 新增。默认 false（解包，调用方直接拿 data）。
   *   但有些调用点需要对方给的 `message` 原文（例如班级同步要把
   *   「同步成功，新增 3 条」这类提示透给用户），或者要自己细看 code。
   *   这类场景传 `raw: true`，行为与改造前的「自己 fetch + 自己解包」完全一致。
   */
  raw?: boolean;
}

/**
 * 跨模块调用失败
 *
 * ⚠️ 继承 BizError → 走到全局错误中间件即可输出统一响应，
 *    调用方无需自己拼 {code,message,data}。
 */
export class RemoteError extends BizError {
  module: ModuleName;
  /** 底层原始错误码（ECONNREFUSED / ECONNABORTED / HTTP 500 ...），排查用 */
  detail: string;
  /**
   * 对方返回的**原始响应体**
   *
   * ★ 2026-10-14 新增。为什么需要它：
   *   改造前各调用点自己 fetch + 自己解包，业务失败时能拿到对方的
   *   `{code,message,data}`，据此做「精确降级」（例如把对方的中文提示
   *   原样透给用户、把 data 里的 errors 记下来）。
   *   换成统一封装后异常是抛出来的，若不把原始响应体带出来，
   *   调用方就只能从 message 里正则抠文案 —— 又脆又难看。
   *   所以在这里挂一份原始 payload，调用方想精细处理时取 `err.payload` 即可。
   */
  payload?: any;

  constructor(
    module: ModuleName,
    message: string,
    detail = '',
    code: BizCode = BizCode.INTERNAL_ERROR,
    payload?: any,
  ) {
    super(code, message);
    this.name = 'RemoteError';
    this.module = module;
    this.detail = detail;
    this.payload = payload;
  }
}

/**
 * 把 axios 的各种失败形态，翻译成一句能直接看懂的中文
 *
 * 这是「统一拦截错误」的核心 —— 不翻译的话，
 * 调用方拿到的是 "connect ECONNREFUSED 127.0.0.1:8002" 这种东西。
 */
function mapAxiosError(module: ModuleName, err: AxiosError): RemoteError {
  const label = MODULE_LABEL[module] || module;
  const raw = err.code || '';

  // ---- 1. 超时 ----
  // ⚠️ axios 超时是 ECONNABORTED（不是 fetch 那套 AbortError），改造调用方时要按这个判断
  if (raw === 'ECONNABORTED' || raw === 'ETIMEDOUT') {
    return new RemoteError(module, `${label} 响应超时，请确认该模块是否卡住`, raw);
  }

  // ---- 2. 连不上（对方没启动 / 地址填错）----
  if (raw === 'ECONNREFUSED' || raw === 'ENOTFOUND' || raw === 'EAI_AGAIN' || raw === 'EHOSTUNREACH') {
    return new RemoteError(module, `无法连接 ${label}，请确认该模块已启动`, raw);
  }

  // ---- 3. 对方返回了非 2xx ----
  const status = err.response?.status;
  const payload: any = err.response?.data;

  // 对方也是本系统的模块 → 响应体里有我们的统一结构，直接把 message 带出来
  if (payload && typeof payload === 'object' && payload.message) {
    return new RemoteError(
      module,
      `${label} 返回错误：${payload.message}`,
      `HTTP ${status}`,
      (payload.code as BizCode) || BizCode.INTERNAL_ERROR,
      payload,
    );
  }

  if (status === 401) {
    return new RemoteError(
      module,
      `${label} 拒绝了本次调用（未登录）`,
      'HTTP 401',
      BizCode.UNAUTHORIZED,
      payload,
    );
  }
  if (status === 403) {
    return new RemoteError(
      module,
      `${label} 拒绝了本次调用（无权限）`,
      'HTTP 403',
      BizCode.NO_OPERATION_PERMISSION,
      payload,
    );
  }
  if (status) {
    return new RemoteError(module, `${label} 返回 HTTP ${status}`, `HTTP ${status}`, BizCode.INTERNAL_ERROR, payload);
  }

  // ---- 4. 其他（DNS / 证书 / 被中断……）----
  return new RemoteError(module, `调用 ${label} 失败：${err.message}`, raw);
}

/** 已创建的客户端缓存（每个模块一个实例，复用连接池） */
const clients = new Map<ModuleName, AxiosInstance>();

/** 取（或惰性创建）某模块的 axios 实例 */
function clientOf(module: ModuleName): AxiosInstance {
  const cached = clients.get(module);
  if (cached) return cached;

  const instance = axios.create({
    baseURL: moduleUrl(module),
    timeout: 5000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    /**
     * ⚠️⚠️ 必须显式关掉代理！（2026-09-30 实测踩坑）
     *
     * Node 版的 axios 会**自动读取环境变量** HTTP_PROXY / HTTPS_PROXY / NO_PROXY，
     * 把请求转发给代理。开发机上只要装了 Clash / 公司网络代理 / 各种加速工具，
     * 这些变量基本都会存在。
     *
     * 后果非常隐蔽：调本机 8002 端口，请求被送进代理，
     * 代理连不上内网地址 → 一直等到超时，报出来的是「响应超时」，
     * 让人以为是对方模块卡死了，查半天查不到原因。
     * （实测：默认配置报 ECONNABORTED timeout；
     *   加 proxy:false 后立刻正确报 ECONNREFUSED，一眼看出是「对方没启动」。）
     *
     * 模块之间的调用是内网直连，永远不该走 HTTP 代理，所以无条件关掉。
     */
    proxy: false,
  });

  /* ---------- 请求拦截：注入链路 ID + 透传 token ---------- */
  instance.interceptors.request.use((cfg: InternalAxiosRequestConfig) => {
    const traceId = (cfg as any).__traceId || randomUUID();
    cfg.headers.set('X-Trace-Id', traceId);
    // 跨模块调用也带上调用方身份，方便对方模块做鉴权
    if (!cfg.headers.get('Authorization')) {
      const inherited = (cfg as any).__auth;
      if (inherited) cfg.headers.set('Authorization', inherited);
    }
    return cfg;
  });

  /* ---------- 响应拦截：解包 + 抛业务错 ---------- */
  instance.interceptors.response.use(
    (resp) => {
      const body: any = resp.data;
      // 永远保留一份原始响应体：raw 模式要用它，异常时也挂到 RemoteError.payload
      (resp as any).__rawBody = body;

      /**
       * ★ raw 模式：**完全不干预**，原样交给调用方。
       *
       * 为什么不干预：有的调用点有自己的成功码口径 ——
       *   例如 `utils/financeClient.ts` 历史上兼容 `code === 0 || code === 200`
       *   （财务早期返回 0）。若这里按统一的 200 去判，会把对方的「成功」
       *   当成业务错误抛出去，属于**改造引入的新 bug**。
       * 所以 raw 模式下不解包、不判业务码，判断权交回调用方。
       */
      if ((resp.config as any)?.__raw) return resp;

      // 假如对方是本系统模块，响应体一定是 {code,message,data}
      if (body && typeof body === 'object' && 'code' in body) {
        if (Number(body.code) !== Number(BizCode.SUCCESS)) {
          throw new RemoteError(
            module,
            `${MODULE_LABEL[module] || module} 返回业务错误：${body.message}`,
            `code=${body.code}`,
            (body.code as BizCode) || BizCode.INTERNAL_ERROR,
            body,
          );
        }
        // 解包：调用方直接拿到 data，不用自己 .data.data
        resp.data = body.data;
      }
      return resp;
    },
    (err: AxiosError) => Promise.reject(mapAxiosError(module, err)),
  );

  clients.set(module, instance);
  return instance;
}

/** 是否值得重试（只重试「超时 / 连不上」这类瞬时故障） */
function isRetriable(err: unknown): boolean {
  if (!(err instanceof RemoteError)) return false;
  return /超时|无法连接|失败/.test(err.message);
}

/**
 * 发起一次跨模块请求（底层入口）
 *
 * @param module 目标模块简称
 * @param method HTTP 方法
 * @param url    目标路径，如 '/health'、'/api/auth/profile'
 * @param opts   超时 / 重试 / 透传 token 等
 * @returns 已解包的 data（对方的 {code,message,data} 里那个 data）
 * @throws RemoteError
 */
export async function remoteRequest<T = any>(
  module: ModuleName,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  url: string,
  opts: RemoteOptions = {},
): Promise<T> {
  const {
    timeout = 5000,
    retries = 0,
    forwardAuth,
    traceId = randomUUID(),
    headers = {},
    params,
    body,
    raw = false,
  } = opts;

  const client = clientOf(module);
  const cfg: any = {
    method,
    url,
    timeout,
    params,
    headers: { ...headers, 'X-Trace-Id': traceId },
    __traceId: traceId,
    __auth: forwardAuth,
    // → 响应拦截器据此决定「是否解包 + 是否抛业务错」，见拦截器里的说明
    __raw: raw,
  };
  if (forwardAuth) cfg.headers.Authorization = forwardAuth;
  if (body !== undefined) cfg.data = body;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    try {
      const resp = await client.request<T>(cfg);
      console.log(
        `[remote] ${module} ${method} ${url} → 成功 ${Date.now() - started}ms (trace=${traceId.slice(0, 8)})`,
      );
      // raw 模式返回完整 {code,message,data}；默认返回解包后的 data
      if (raw) return (((resp as any).__rawBody ?? resp.data) as T);
      return resp.data as T;
    } catch (e: any) {
      lastErr = e;
      const cost = Date.now() - started;
      if (attempt < retries && isRetriable(e)) {
        const wait = 200 * Math.pow(2, attempt); // 200ms → 400ms → 800ms
        console.warn(
          `[remote] ${module} ${method} ${url} → 第 ${attempt + 1} 次失败(${cost}ms)，${wait}ms 后重试：${e.message}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.warn(`[remote] ${module} ${method} ${url} → 失败 ${cost}ms：${e.message}`);
      break;
    }
  }

  throw lastErr;
}

/** 便捷方法：GET */
export function remoteGet<T = any>(
  module: ModuleName,
  url: string,
  opts?: RemoteOptions,
): Promise<T> {
  return remoteRequest<T>(module, 'GET', url, opts);
}

/** 便捷方法：POST */
export function remotePost<T = any>(
  module: ModuleName,
  url: string,
  body?: unknown,
  opts?: RemoteOptions,
): Promise<T> {
  return remoteRequest<T>(module, 'POST', url, { ...(opts || {}), body });
}

/**
 * 判断一个错误是不是「超时/连不上」这类可恢复的远端故障
 *
 * ★ 2026-10-14 新增：各调用点在 catch 里原本判断 `err.name === 'AbortError'`
 *   （原生 fetch 超时的特征）。换成 axios 后特征变成 `ECONNABORTED`，
 *   所以统一提供这个判定，避免每个调用点各写各的、写错还没人发现。
 */
export function isRemoteTimeout(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  return (
    e.code === 'ECONNABORTED' ||
    e.code === 'ETIMEDOUT' ||
    e.detail === 'ECONNABORTED' ||
    e.detail === 'ETIMEDOUT' ||
    /超时/.test(e.message || '')
  );
}

/** 判断错误是不是「连不上」 */
export function isRemoteUnreachable(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  const raw = e.code || e.detail || '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'].includes(raw);
}
