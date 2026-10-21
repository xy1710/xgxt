/**
 * ⭐ 服务间凭证（machine-to-machine token）
 *
 * ⚠️⚠️ 2026-10-02 新增：统一门户改造后，财务模块开始【真实验签】token。
 *
 * 背景：
 *   改造前财务模块是 DEV_MODE，任何请求都给 ADMIN 假用户，
 *   所以咨询模块用固定的 'test' 当 token 也能调通财务。
 *   改造后财务模块会校验 JWT 签名，'test' 直接被拒
 *   （错误：登录凭证格式不正确），跨模块联动全断。
 *
 * 解法：
 *   机器调用不该伪装成某个用户，而应该用一个【服务身份】的 JWT。
 *   本模块用自己的 JWT_SECRET（与门户/财务同一个）签一个服务 token：
 *     · roles: ['ROLE_SERVICE']       —— 标记这是服务身份，不是人
 *     · permissions: ['*']            —— 服务间调用放行（内网可信）
 *     · modules: ['consult','finance']—— 声明它要访问哪些模块
 *
 * ⚠️ 安全说明：
 *    这是「内网 + 同一个共享密钥」的简化方案，适合本项目的本地联调。
 *    正式环境应改为：
 *      ① 每个服务一对独立的非对称密钥（RS256），或
 *      ② 走服务注册中心发短期凭证。
 *    本项目 11 人并行开发阶段，先保证「跨模块联动不断」且「不再用假用户」。
 *
 * ⚠️ 为什么不能长期用 'test' 兜底：
 *    那等于财务模块对外网裸奔——任何人带 Bearer test 就能改财务数据。
 */

import { signToken } from '../utils/jwt';

/** 服务身份的角色编码（写在 token.roles 里，便于下游识别） */
export const SERVICE_ROLE = 'ROLE_SERVICE';

/** 服务 token 缓存（有效期 7 天，没必要每次调用都重签） */
let cached: { token: string; exp: number } | null = null;

/** 服务 token 有效期（秒）—— 比用户 token 短，降低泄漏风险 */
const SERVICE_TTL_SEC = 3600; // 1 小时

/**
 * ⭐ 2026-10-08 新增：按「调用方模块」区分服务身份
 *
 * 【为什么不能所有模块共用一个 SVC_CONSULT】
 *   原先只有咨询模块会用这个函数，所以写死了 `userId:'SVC_CONSULT'` /
 *   `userName:'市场咨询模块（服务调用）'`。现在就业模块（job）也要调财务，
 *   若继续共用同一个 token，财务侧建出来的单子上
 *   `applicant_name` 会显示成「市场咨询模块」—— 明明是就业的退费，
 *   申请人却写着咨询，对账时必然引起误解（本轮实测已复现）。
 *
 * 【口径】
 *   服务身份仍是一个（`ROLE_SERVICE` + `permissions:['*']`），
 *   只是把「自报家门」的那几个字段按来源模块区分开，
 *   让下游日志/单据能看出是谁在调。
 *
 * ⚠️ 缓存按模块分开 —— 不同模块的 token 不能互相顶掉。
 */
const SVC_IDENTITY: Record<string, { userId: string; account: string; userName: string }> = {
  consult: {
    userId: 'SVC_CONSULT',
    account: 'svc-consult',
    userName: '市场咨询模块（服务调用）',
  },
  job: {
    userId: 'SVC_JOB',
    account: 'svc-job',
    userName: '就业模块（服务调用）',
  },
  /**
   * ★ 2026-10-15 新增：教务模块上传缴费截图后要回传给财务，
   *   否则财务侧建/改单据时 applicant 会显示成别的模块（同上文的坑）。
   */
  edu: {
    userId: 'SVC_EDU',
    account: 'svc-edu',
    userName: '教务模块（服务调用）',
  },
};

/** 每个来源模块各缓存一份 token */
const cacheByCaller = new Map<string, { token: string; exp: number }>();

/**
 * 取一个服务间调用的 token
 *
 * ⚠️ 带 1 小时缓存：避免每次跨模块调用都做一次 HMAC 计算（虽然很便宜，
 *    但更主要的是让日志里的 token 稳定，便于排查）。
 *
 * @param caller 调用方模块名（`consult` / `job` / `edu`），默认 `consult` 保持向后兼容。
 *               仅影响 token 里的「自报家门」字段，不影响鉴权强度。
 */
export function getServiceToken(caller: 'consult' | 'job' | 'edu' = 'consult'): string {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = caller;
  const hit = cacheByCaller.get(cacheKey);

  if (hit && hit.exp > now + 60) {
    return hit.token;
  }

  const who = SVC_IDENTITY[caller] || SVC_IDENTITY.consult;

  const token = signToken({
    userId: who.userId,
    roles: [SERVICE_ROLE],
    permissions: ['*'],
    dataScope: 4, // 全部
    modules: [caller, 'finance'],
    kind: 'service',
    account: who.account,
    userName: who.userName,
  });

  cacheByCaller.set(cacheKey, { token, exp: now + SERVICE_TTL_SEC });
  // 兼容旧的单变量缓存（老代码可能在别处读它）
  if (caller === 'consult') cached = { token, exp: now + SERVICE_TTL_SEC };

  return token;
}
