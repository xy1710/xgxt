/**
 * 页面管理路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/page
 *
 * 【板块 → 页面（台账 A：t_perm_page）】
 *  GET  /list               板块 + 页面清单 + 各自启用态
 *  PUT  /save               按板块保存（全量覆盖：只认提交的这批为启用）
 *  POST /reset              全部恢复启用
 *
 * 【职位 → 页面（台账 B：t_perm_role_page）】★ 2026-10-07 新增
 *  GET  /role-tree          左栏：板块 → 该板块下的职位
 *  GET  /role-pages         右侧：某职位在全部板块下的页面勾选态
 *  PUT  /role-save          保存某职位的页面可见性（差异存储）
 *  POST /role-reset         恢复默认（删光该职位的显式配置）
 *
 * 【给所有账号用的轻量接口（不带 permAuth，单独挂载）】
 *  GET  /my-paths           → routes/myPaths.route.ts
 *
 * ⚠️ 页面台账的语义：**打勾 = 该板块有该页面**，去勾 = 该板块没有这个页面。
 *    它管的是「板块级」的页面存在性，与「职位权限分配」（职位级的功能点授权）
 *    是两层，叠加生效：页面不存在 → 谁都没有；页面存在 → 再看职位有没有授权。
 *
 * ⚠️ 职位-页面台账是**第三层**（职位级）：某个职位能不能看到某个页面。
 *    三层叠加顺序：
 *      ① 板块有这个页面（t_perm_page）
 *      ② 该职位被允许看这个页面（t_perm_role_page）★ 本文件后半部分
 *      ③ 该职位真的持有该页面的权限点（职位权限分配 / pagePermissionSource）
 *
 * ⚠️ 权限码沿用 `perm:权限配置:editPerm`（与职位权限分配同一个功能点）——
 *    页面台账本身就是「授权配置」的一部分，不另立权限树功能点，
 *    这样 sys_admin（permissions = ['*']）与权限模块负责人无需额外授权即可用。
 *    查询接口不挂 checkPermission，与本模块其他只读接口（role-list / tree）口径一致。
 */

import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { BizCode } from 'shared-types/perm';
import { addLog, clientIp } from '../services/perm.service';
import {
  ensurePageTable,
  loadPageBoards,
  loadPathFlags,
  resetAllPages,
  saveModulePages,
} from '../services/page.service';
import {
  loadRolePages,
  loadRoleTree,
  resetRolePages,
  saveRolePages,
} from '../services/rolePage.service';

export const pageRouter = Router();

/* ============================================================
 * 1. 台账清单
 *    GET /api/perm/page/list
 * ============================================================ */

pageRouter.get(
  '/list',
  wrap(async (_req, res) => {
    const boards = await loadPageBoards();
    const total = boards.reduce((n, b) => n + b.total, 0);
    const enabledTotal = boards.reduce((n, b) => n + b.enabledCount, 0);
    res.json(ok({ boards, total, enabledTotal }));
  }),
);

/* ============================================================
 * 2. 页面 path 的两个集合（前端启动时拉一次：菜单过滤 + 路由守卫）
 *    GET /api/perm/page/enabled-paths
 *
 * ⚠️ 注意：本接口挂 permAuth（要求账号 modules 含 perm），
 *    所以只有权限管理板块的账号能拉到。
 *    **非 perm 账号（班主任/教务/财务/咨询…）拉不到** ——
 *    它们的前端菜单过滤走的是 `/api/perm/page/my-paths`
 *    （routes/myPaths.route.ts，宽松鉴权，且已叠加「职位 → 页面」台账）。
 *    本接口保留：权限管理页自己刷新台账状态时用得上，也是旧前端的兼容入口。
 * ============================================================ */

pageRouter.get(
  '/enabled-paths',
  wrap(async (_req, res) => {
    const flags = await loadPathFlags();
    res.json(ok(flags));
  }),
);

/* ============================================================
 * 3. 保存（按板块全量覆盖）
 *    PUT /api/perm/page/save   body: { moduleKey, enabledPaths: string[] }
 * ============================================================ */

const saveSchema = z.object({
  moduleKey: z.string().min(1, '必须传 moduleKey'),
  enabledPaths: z.array(z.string()),
});

pageRouter.put(
  '/save',
  checkPermission('perm:权限配置:editPerm'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as { moduleKey: string; enabledPaths: string[] };

    const before = (await loadPageBoards()).find((b) => b.moduleKey === body.moduleKey);
    const result = await saveModulePages(body.moduleKey, body.enabledPaths, {
      id: req.user?.userId,
      name: req.user?.userName,
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `板块 ${before?.moduleName || body.moduleKey} 的页面`,
      beforeValue: `启用 ${before?.enabledCount ?? '—'}/${before?.total ?? '—'} 页`,
      afterValue: `启用 ${result.enabledCount}/${result.total} 页`,
      ip: clientIp(req),
    });

    res.json(
      ok(result, `「${before?.moduleName || body.moduleKey}」已保存，启用 ${result.enabledCount}/${result.total} 个页面`),
    );
  }),
);

/* ============================================================
 * 4. 全部恢复启用
 *    POST /api/perm/page/reset
 * ============================================================ */

pageRouter.post(
  '/reset',
  checkPermission('perm:权限配置:editPerm'),
  wrap(async (req, res) => {
    await ensurePageTable();
    const affected = await resetAllPages({ id: req.user?.userId, name: req.user?.userName });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: '全部板块的页面',
      beforeValue: '部分页面已关闭',
      afterValue: `全部启用（${affected} 行）`,
      ip: clientIp(req),
    });

    res.json(ok({ affected }, `已恢复全部 ${affected} 个页面的启用状态`));
  }),
);

/* ============================================================
 * 5. 左栏：板块 → 职位
 *    GET /api/perm/page/role-tree
 * ============================================================ */

pageRouter.get(
  '/role-tree',
  wrap(async (_req, res) => {
    res.json(ok(await loadRoleTree()));
  }),
);

/* ============================================================
 * 6. 右侧：某职位在全部板块下的页面勾选态
 *    GET /api/perm/page/role-pages?roleId=xxx
 * ============================================================ */

const rolePagesSchema = z.object({ roleId: z.string().min(1, '必须传 roleId') });

pageRouter.get(
  '/role-pages',
  validate(rolePagesSchema),
  wrap(async (req, res) => {
    const { roleId } = (req as any).validated as { roleId: string };
    try {
      res.json(ok(await loadRolePages(roleId)));
    } catch (e: any) {
      throw new BizError(BizCode.ROLE_NOT_FOUND, e?.message || '职位不存在');
    }
  }),
);

/* ============================================================
 * 7. 保存某职位的页面可见性
 *    PUT /api/perm/page/role-save
 *    body: { roleId, items: [{ moduleKey, pagePath, enabled }] }
 *
 * ⚠️ 语义 = 该职位【差异存储】：与默认一致的行不落库，
 *    所以在界面上「改回默认」再保存 = 那一行消失。
 * ============================================================ */

const roleSaveSchema = z.object({
  roleId: z.string().min(1, '必须传 roleId'),
  items: z
    .array(
      z.object({
        moduleKey: z.string().min(1),
        pagePath: z.string().min(1),
        enabled: z.boolean(),
      }),
    )
    .max(500, '一次提交的页面数过多'),
});

pageRouter.put(
  '/role-save',
  checkPermission('perm:权限配置:editPerm'),
  validate(roleSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      roleId: string;
      items: Array<{ moduleKey: string; pagePath: string; enabled: boolean }>;
    };

    const role = await loadRolePages(body.roleId);
    const result = await saveRolePages(body.roleId, body.items, {
      id: req.user?.userId,
      name: req.user?.userName,
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.roleName} 的页面可见性`,
      beforeValue: role.configured
        ? `已配置 ${role.overrideCount} 处 · 可见 ${role.enabledTotal}/${role.total} 页`
        : `沿用默认 · 可见 ${role.enabledTotal}/${role.total} 页`,
      afterValue: result.configured
        ? `已配置 ${result.changed} 处 · 可见 ${result.enabledTotal}/${result.total} 页`
        : `沿用默认 · 可见 ${result.enabledTotal}/${result.total} 页`,
      ip: clientIp(req),
    });

    res.json(
      ok(
        result,
        `「${role.roleName}」页面可见性已保存：可见 ${result.enabledTotal}/${result.total} 页`,
      ),
    );
  }),
);

/* ============================================================
 * 8. 恢复默认（删光该职位的显式配置）
 *    POST /api/perm/page/role-reset   body: { roleId }
 * ============================================================ */

const roleResetSchema = z.object({ roleId: z.string().min(1, '必须传 roleId') });

pageRouter.post(
  '/role-reset',
  checkPermission('perm:权限配置:editPerm'),
  validate(roleResetSchema),
  wrap(async (req, res) => {
    const { roleId } = (req as any).validated as { roleId: string };
    const role = await loadRolePages(roleId);
    const { affected } = await resetRolePages(roleId, {
      id: req.user?.userId,
      name: req.user?.userName,
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.roleName} 的页面可见性`,
      beforeValue: `已配置 ${role.overrideCount} 处`,
      afterValue: `已恢复默认（清除 ${affected} 行）`,
      ip: clientIp(req),
    });

    res.json(ok({ affected }, `「${role.roleName}」已恢复默认页面可见性`));
  }),
);

export default pageRouter;
