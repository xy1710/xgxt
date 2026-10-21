/**
 * 权限管理模块 · 登录人信息路由
 *
 * ⚠️ 权限模块【不提供登录接口】—— 登录统一由门户（8000）负责。
 *    本路由只做一件事：把门户签发的 token 解成前端能直接用的 profile，
 *    让前端知道「我是谁、能看哪些页」。
 *
 * 接口清单：
 *   GET /api/perm/auth/profile    当前登录人 + 可访问页面
 *   GET /api/perm/auth/menus      仅菜单（轻量，供侧栏用）
 *
 * ⚠️ 与财务模块的区别：
 *    权限模块不自己定义职位 —— 它本身就是职位表的维护方。
 *    页面可见性按【门户身份】算，见 shared-types/perm-auth.ts 的 permMenusOf()。
 */

import { Router } from 'express';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
import { authMiddleware } from '../middleware/auth';
import { buildPermProfile } from 'shared-types/perm';

const router = Router();

/* ============================================================
 * GET /api/perm/auth/profile
 * ============================================================ */

router.get(
  '/profile',
  authMiddleware,
  wrap(async (req, res) => {
    const profile = buildPermProfile(req.user);
    res.json(ok({ profile, menuKeys: profile.menuKeys }));
  }),
);

/* ============================================================
 * GET /api/perm/auth/menus
 * ============================================================ */

router.get(
  '/menus',
  authMiddleware,
  wrap(async (req, res) => {
    const profile = buildPermProfile(req.user);
    res.json(ok({ menuKeys: profile.menuKeys }));
  }),
);

export default router;
