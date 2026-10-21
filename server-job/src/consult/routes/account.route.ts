/**
 * 账号管理与登录路由
 *
 * 路径前缀：/api/consult/account
 *
 * ⚠️ 权限：
 *    登录           → 公开
 *    账号增删改查   → 仅系统管理员
 *    取当前用户     → 登录用户
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  BizCode,
  ConsultRole,
  CONSULT_ROLE_NAME,
  CONSULT_ROLE_DESC,
} from 'shared-types/consult';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { requireAdmin } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { consultMenusFromPerm } from 'shared-types/consult';
import { fetchPermProfile } from '../services/perm.client';
import {
  ACCOUNT_TABLE,
  login,
  findByTokenOrAccount,
  addAccount,
  updateAccount,
  resetPassword,
  toggleActive,
  removeAccount,
  buildAccountQuery,
  getAccountStats,
  toAccountView,
  menusOf,
  MENU_ITEMS,
} from '../services/account.service';

export const accountRouter = Router();

/* ============================================================
 * 1. 登录（公开接口）
 *    POST /api/consult/account/login
 * ============================================================ */

accountRouter.post(
  '/login',
  validate(
    z.object({
      account: z.string().min(1, '请输入账号').max(50),
      password: z.string().min(1, '请输入密码').max(100),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { account: string; password: string };
    const result = await login(body.account, body.password);
    res.json(ok(result, `欢迎回来，${result.account.userName}`));
  }),
);

/* ============================================================
 * 2. 当前登录用户
 *    GET /api/consult/account/profile
 *
 * ⚠️⚠️ 2026-10-03 用户指令（本轮核心改造）：
 *   「权限管理内的权限分配和财务市场咨询联调一下，
 *     让权限管理内的权限可以正常分配。」
 *
 *   改造前：menuKeys 一律由 menusOf(row.role) 按本模块岗位硬算
 *           → 权限分配页改什么都影响不到咨询，分配等于没做。
 *   改造后：菜单【优先按权限模块的权限分配结果】来算：
 *           ① 调权限模块 /api/perm/remote/account-profile 取功能点清单
 *           ② 用 consultMenusFromPerm() 换算成咨询 menuKeys
 *           ③ 权限模块不可用 / 账号没配过 → 回退岗位兜底菜单，
 *              并返回 permDegraded=true 让前端提示（绝不让用户进不来）
 * ============================================================ */

accountRouter.get(
  '/profile',
  wrap(async (req, res) => {
    const user = req.user!;
    // ⚠️ 兼容门户 token：accountId 可能是门户的主键，查不到就用登录名兜底
    const row = await findByTokenOrAccount(user.accountId, user.account);

    /**
     * ★ 2026-10-16 咨询师不下发「审批中心」菜单
     *
     * 口径：咨询师发起退费 → 咨询经理审批 → 财务打款。
     * 审批中心接口已加 requireManager，咨询师点进去只会 403；
     * 而菜单来源是权限模块的分配结果（那边不知道咨询模块内部的这条链），
     * 所以在这里统一摘掉，避免「有菜单但点不动」。
     */
    const menuForRole = (keys: string[]) =>
      user.role === ConsultRole.CONSULT ? keys.filter((k) => k !== 'approve') : keys;

    // ⭐ 系统管理员判定（2026-10-03）：
    //    门户系统管理员（permissions 含 '*'，或角色为 SYS_ADMIN）→ 全部页面可见。
    //    咨询库中查不到该账号时也按此口径给全量菜单，避免进来一片空白。
    const isSysAdmin =
      user.isAdmin === true ||
      (user.permissions || []).includes('*') ||
      (user.roles || []).includes('SYS_ADMIN');

    // ---- ⭐ 系统管理员：全开，不查权限库 ----
    if (isSysAdmin) {
      const rowView = row
        ? {
            ...toAccountView(row, true),
            menuKeys: menuForRole(menusOf(row.role, { isSysAdmin })),
          }
        : {
            accountId: user.accountId,
            account: user.account,
            userName: user.userName,
            active: true,
            createTime: '',
            menuKeys: menuForRole(menusOf('', { isSysAdmin })),
          };
      res.json(ok({ ...rowView, menuSource: 'sys_admin', permDegraded: false }));
      return;
    }

    // ---- ⭐ 普通账号：优先按「权限分配」的结果算菜单 ----
    const perm = await fetchPermProfile(user.account || '');

    if (perm.profile) {
      const menuKeys = menuForRole(consultMenusFromPerm(perm.profile));
      // ⚠️ 权限库里确实有这个人，但一个咨询功能点都没勾 →
      //    仍给首页兜底，否则进来是全白页 + 路由守卫死循环
      const finalKeys = menuKeys.length ? menuKeys : ['student'];
      const base = row
        ? toAccountView(row, true)
        : {
            accountId: user.accountId,
            account: user.account,
            userName: user.userName,
            active: true,
            createTime: '',
          };
      res.json(
        ok({
          ...base,
          menuKeys: finalKeys,
          menuSource: 'perm_assign',
          permDegraded: false,
          permRoles: perm.profile.roleNames,
        }),
      );
      return;
    }

    // ---- 降级：按本模块岗位的兜底菜单 ----
    if (!row) {
      // 门户账号在本模块无同名岗位记录 + 权限库也没有 → 按最高权限返回
      res.json(
        ok({
          accountId: user.accountId,
          account: user.account,
          userName: user.userName,
          role: user.role,
          roleTitle: user.roleTitle,
          dept: user.dept,
          active: true,
          createTime: '',
          menuKeys: menuForRole(menusOf('', { isSysAdmin: false })),
          menuSource: 'fallback',
          permDegraded: true,
          permTip: perm.degradeReason || '权限模块暂时不可用，当前使用本地兜底菜单。',
        }),
      );
      return;
    }

    res.json(
      ok({
        ...toAccountView(row, true),
        menuKeys: menuForRole(menusOf(row.role)),
        menuSource: 'fallback',
        permDegraded: true,
        permTip: perm.degradeReason || '权限模块暂时不可用，当前使用本地兜底菜单。',
      }),
    );
  }),
);

/* ============================================================
 * 3. 角色字典（登录页/账号弹窗用）
 *    GET /api/consult/account/roles
 * ============================================================ */

accountRouter.get(
  '/roles',
  wrap(async (_req, res) => {
    const roles = Object.values(ConsultRole).map((r) => ({
      role: r,
      roleTitle: CONSULT_ROLE_NAME[r],
      desc: CONSULT_ROLE_DESC[r],
      menus: menusOf(r),
    }));
    res.json(ok({ roles, menus: MENU_ITEMS }));
  }),
);

/* ============================================================
 * 4. 账号列表（仅管理员）
 *    GET /api/consult/account/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  userName: z.string().optional(),
  account: z.string().optional(),
  role: z.string().optional(),
  active: z.string().optional(),
  keyword: z.string().optional(),
});

accountRouter.get(
  '/list',
  requireAdmin,
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = buildAccountQuery(q);
    const [{ total }] = await query.clone().count({ total: '*' });

    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // ⚠️ 演示环境返回密码（列表页要展示）。正式环境应传 false。
    res.json(page(rows.map((r: any) => toAccountView(r, true)), Number(total), q));
  }),
);

/* ============================================================
 * 5. 账号统计
 *    GET /api/consult/account/stats
 * ============================================================ */

accountRouter.get(
  '/stats',
  requireAdmin,
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    res.json(ok(await getAccountStats(q)));
  }),
);

/* ============================================================
 * 6. 新建账号（仅管理员）
 *    POST /api/consult/account/add
 * ============================================================ */

accountRouter.post(
  '/add',
  requireAdmin,
  validate(
    z.object({
      account: z
        .string()
        .min(3, '账号至少 3 位')
        .max(50)
        .regex(/^[a-zA-Z0-9_]+$/, '账号只能包含字母、数字、下划线'),
      password: z.string().min(6, '密码至少 6 位').max(100),
      userName: z.string().min(1, '姓名必填').max(50),
      role: z.string().min(1, '请选择岗位'),
      dept: z.string().max(50).optional(),
      phone: z.string().max(20).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as any;
    const operator = req.user!;

    const result = await addAccount(
      {
        account: body.account,
        password: body.password,
        userName: body.userName,
        role: body.role as ConsultRole,
        dept: body.dept,
        phone: body.phone,
      },
      { name: operator.userName },
    );

    res.json(ok(result, '账号创建成功'));
  }),
);

/* ============================================================
 * 7. 修改账号（仅管理员）
 *    PUT /api/consult/account/update
 * ============================================================ */

accountRouter.put(
  '/update',
  requireAdmin,
  validate(
    z.object({
      accountId: z.string().min(1),
      userName: z.string().max(50).optional(),
      role: z.string().optional(),
      dept: z.string().max(50).optional(),
      phone: z.string().max(20).optional(),
      password: z.string().max(100).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as any;
    const operator = req.user!;

    await updateAccount(
      body.accountId,
      {
        userName: body.userName,
        role: body.role ? (body.role as ConsultRole) : undefined,
        dept: body.dept,
        phone: body.phone,
        password: body.password,
      },
      { name: operator.userName },
    );

    res.json(ok(null, '账号已更新'));
  }),
);

/* ============================================================
 * 8. 重置密码（仅管理员）
 *    POST /api/consult/account/reset-password
 * ============================================================ */

accountRouter.post(
  '/reset-password',
  requireAdmin,
  validate(
    z.object({
      accountId: z.string().min(1),
      newPassword: z.string().min(6, '密码至少 6 位').max(100),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { accountId: string; newPassword: string };
    const operator = req.user!;

    await resetPassword(body.accountId, body.newPassword, { name: operator.userName });
    res.json(ok(null, '密码已重置'));
  }),
);

/* ============================================================
 * 9. 启用 / 停用（仅管理员）
 *    POST /api/consult/account/toggle
 * ============================================================ */

accountRouter.post(
  '/toggle',
  requireAdmin,
  validate(
    z.object({
      accountId: z.string().min(1),
      active: z.coerce.boolean(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { accountId: string; active: boolean };
    const operator = req.user!;

    await toggleActive(body.accountId, body.active, { name: operator.userName });
    res.json(ok(null, body.active ? '账号已启用' : '账号已停用'));
  }),
);

/* ============================================================
 * 10. 删除账号（逻辑删除，仅管理员）
 *     DELETE /api/consult/account/delete/:id
 * ============================================================ */

accountRouter.delete(
  '/delete/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const operator = req.user!;
    await removeAccount(req.params.id, { name: operator.userName });
    res.json(ok(null, '账号已删除'));
  }),
);

export default accountRouter;
