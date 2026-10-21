/**
 * 跨模块调用路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/remote
 *
 *  GET /modules                     7 个模块联通自检（谁没起一眼看出）
 *  GET /modules/:name               单个模块探活
 *  GET /auth-profile?account=xxx    去登录模块取账号档案（跨模块业务调用示例）
 *  GET /account-profile?account=xxx ⭐ 本模块按登录名给出「权限全景档案」（各业务模块调用）
 *
 * ⚠️ 联调期最实用的就是 /modules：
 *    以前要一个个 curl /health，现在一个请求把所有模块状态列出来。
 *
 * ⚠️ 唯一路径段名 :name 只允许 config.services 里的键（auth/edu/class/job/finance/perm/stat），
 *    传别的会被当成参数错误挡回去，避免拿它当 SSRF 跳板去打任意地址。
 *
 * ⚠️⚠️ 2026-10-03 新增 /account-profile（关键联调接口）：
 *    财务（8005）/ 咨询（8001）登录后要按「权限分配」的结果决定显示哪些页面，
 *    而权限数据只在本模块（sms_perm）里。于是对外暴露这一个只读接口：
 *      入参：account（登录名）
 *      出参：职位 / 权限点 / 数据范围 / moduleItems（各模块下的功能点清单）
 *    各业务模块拿 moduleItems 自己映射成 menuKeys 即可。
 *    【不需登录】—— 与 /user/auth-profile 同口径，供登录链路前置调用。
 */

import { Router } from 'express';
import { BizCode } from 'shared-types/perm';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
import { BizError } from '../middleware/errorHandler';
import { config } from '../config';
import { ModuleName } from '../utils/http';
import { pingAllModules, pingModule, fetchAuthProfile } from '../services/remote.service';
import { getAccountPermProfile } from '../services/perm.service';

export const remoteRouter = Router();

/** 合法的模块名清单（从 config.services 的键取，不硬编码） */
const VALID_MODULES = Object.keys(config.services) as ModuleName[];

/* ============================================================
 * 1. 全模块联通自检
 *    GET /api/perm/remote/modules?timeout=2000
 * ============================================================ */

remoteRouter.get(
  '/modules',
  wrap(async (req, res) => {
    const timeout = Number(req.query.timeout) || 2000;
    // 上限 10 秒，防止有人传 999999 把接口挂死
    const report = await pingAllModules(Math.min(Math.max(timeout, 500), 10000));
    res.json(ok(report, `自检完成：${report.onlineCount}/${report.total} 个模块在线`));
  }),
);

/* ============================================================
 * 2. 单个模块探活
 *    GET /api/perm/remote/modules/edu
 * ============================================================ */

remoteRouter.get(
  '/modules/:name',
  wrap(async (req, res) => {
    const name = String(req.params.name) as ModuleName;
    if (!VALID_MODULES.includes(name)) {
      // 参数不合法属于「调用方用错了」→ PARAM_ERROR
      throw new BizError(
        BizCode.PARAM_ERROR,
        `模块名不合法：${name}。可选值：${VALID_MODULES.join(' / ')}`,
        400,
      );
    }
    const probe = await pingModule(name, Number(req.query.timeout) || 2000);
    res.json(ok(probe, probe.online ? '模块在线' : '模块不可用'));
  }),
);

/* ============================================================
 * 3. 跨模块取账号档案（真实业务调用示例）
 *    GET /api/perm/remote/auth-profile?account=admin
 *
 * ⚠️ 登录模块（8001）没启动时，本接口会返回一条
 *    「无法连接 登录与市场咨询(8001)，请确认该模块已启动」的提示，
 *    而不是 500 堆栈 —— 这正是「统一拦截错误」的效果。
 * ============================================================ */

remoteRouter.get(
  '/auth-profile',
  wrap(async (req, res) => {
    const account = String(req.query.account || '').trim();
    if (!account) {
      throw new BizError(BizCode.PARAM_ERROR, '缺少参数 account', 400);
    }
    // 透传调用方 token，让登录模块认得是谁在调
    const profile = await fetchAuthProfile(account, req.headers.authorization);
    res.json(ok(profile, '已从登录模块取到账号档案'));
  }),
);

/* ============================================================
 * 4. ⭐ 按登录名给出「权限全景档案」（各业务模块消费）
 *    GET /api/perm/remote/account-profile?account=liukj
 *
 * ⚠️ 这是「权限分配 → 财务/咨询生效」链路的关键一环：
 *    财务(8005)/咨询(8001) 拿到本接口返回的 moduleItems 后，
 *    换成自己模块的 menuKeys，从而实现「权限分配改了 → 菜单跟着变」。
 *
 * ⚠️ 查不到账号返回 found:false（200 而非 404）：
 *    对调用方来说「这个人没配权限」是正常业务结果，
 *    不是接口错误 —— 让它自己决定兜底（各模块的处理见自己的 auth 路由）。
 * ============================================================ */

remoteRouter.get(
  '/account-profile',
  wrap(async (req, res) => {
    const account = String(req.query.account || '').trim();
    if (!account) {
      throw new BizError(BizCode.PARAM_ERROR, '缺少参数 account', 400);
    }
    const profile = await getAccountPermProfile(account);
    res.json(
      ok(
        profile,
        profile.found
          ? `已取到「${profile.userName}」的权限档案（${profile.roles.length} 个职位 / ${profile.permissions.length} 个权限点）`
          : `权限库中不存在账号「${account}」`,
      ),
    );
  }),
);

export default remoteRouter;
