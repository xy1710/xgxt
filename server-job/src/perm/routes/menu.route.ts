/**
 * 权限树路由（模块 → 功能点 → 动作）
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/menu
 *
 *  GET /tree     完整权限树（8 模块 / 53 个顶级功能点 / 185 个动作）
 *  GET /stats    权限树统计（模块数 / 顶级功能点数 / 动作数）
 *
 * ⚠️ 权限树是「系统能力清单」，与职位无关 —— 职位勾选态走 /api/perm/assign/tree。
 *    t_perm_menu 与 t_perm_menu_action 是这两张表的数据来源。
 * ⚠️ 「教质/学术审批」是父功能点，下挂 休学/退学审批 + 退费审批 两个二级功能点，
 *    父项自身不挂动作。功能点数只算顶级项，动作数按全部项求和 ——
 *    口径与原型 treeStats() 一致，详见 perm.service.ts 的 getTreeStats()。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode } from 'shared-types/perm';
import { ok } from '../utils/response';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { addLog, clientIp, getTreeStats, loadModules } from '../services/perm.service';
import {
  createMenuItem,
  deleteMenuItem,
  listMenuItemsAdmin,
  updateMenuItem,
} from '../services/menuAdmin.service';

export const menuRouter = Router();

/* ============================================================
 * 1. 完整权限树
 *    GET /api/perm/menu/tree?refresh=1
 *
 * ⚠️ refresh=1 强制清缓存（改完种子数据后不用重启服务）
 * ============================================================ */

menuRouter.get(
  '/tree',
  wrap(async (req, res) => {
    const force = String(req.query.refresh || '') === '1';
    const mods = await loadModules(force);
    res.json(ok(mods));
  }),
);

/* ============================================================
 * 2. 权限树统计
 *    GET /api/perm/menu/stats
 *    → { modCount: 8, itemCount: 53, actionCount: 185 }
 * ⚠️ 2026-10-02：实训-教学由 3 个功能点补到 10 个，故 46→53、157→185。
 * ============================================================ */

menuRouter.get(
  '/stats',
  wrap(async (_req, res) => {
    res.json(ok(await getTreeStats()));
  }),
);

/* ============================================================
 * 3. 权限点维护（★ 2026-10-19 新增）
 *
 *   GET    /api/perm/menu/items       全部功能点（含自建 / 含动作 / 含被几个职位勾选）
 *   POST   /api/perm/menu/item        新增自建权限点
 *   PUT    /api/perm/menu/item        修改自建权限点
 *   DELETE /api/perm/menu/item/:id    删除自建权限点
 *
 * ⚠️ 为什么要这套接口：
 *   预置权限树是「系统能力清单」，新部门（招生部）＋新职位（招生老师）
 *   往往需要预置清单里没有的功能点。过去只能改 SQL，现在由界面维护。
 * ⚠️ 自建权限点与预置权限【格式完全一致】（t_perm_menu + t_perm_menu_action），
 *   所以存完立刻出现在权限树里，可直接勾选给任意职位。
 * ⚠️ 预置权限点只读：业务代码里写死了 `模块:功能点:动作码` 权限串，
 *   改预置项等于让对应按钮失效。
 * ============================================================ */

/** 动作参数校验 */
const actionSchema = z.object({
  actionCode: z.string().max(64).optional(),
  actionName: z.string().min(1, '动作名称不能为空').max(32),
  baseAction: z.number().int().min(1).max(6),
  remark: z.string().max(255).optional(),
});

/** 新增 / 编辑权限点参数校验 */
const itemSchema = z.object({
  id: z.string().optional(),
  /** 选已有板块传 module_key；新建板块传 __new__ 或不传 */
  moduleKey: z.string().max(32).optional().default('__new__'),
  moduleName: z.string().max(32).optional(),
  moduleIcon: z.string().max(16).optional(),
  moduleSort: z.number().int().optional(),
  itemName: z.string().min(1, '请填写功能点名称').max(64),
  parentItemName: z.string().max(64).nullable().optional(),
  remark: z.string().max(255).optional(),
  actions: z.array(actionSchema).min(1, '请至少添加一个动作'),
});

menuRouter.get(
  '/items',
  wrap(async (_req, res) => {
    res.json(ok(await listMenuItemsAdmin()));
  }),
);

menuRouter.post(
  '/item',
  checkPermission('perm:权限配置:editPerm'),
  validate(itemSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const r = await createMenuItem(body, req.user?.userId || 'system');
    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `权限点 ${r.moduleName} / ${r.itemName}`,
      beforeValue: '—',
      afterValue: `新增，${r.actionCount} 个动作`,
      ip: clientIp(req),
    });
    res.json(
      ok(r, `已新增权限点「${r.itemName}」（${r.actionCount} 个动作），现在可以在权限树里勾选分配`),
    );
  }),
);

menuRouter.put(
  '/item',
  checkPermission('perm:权限配置:editPerm'),
  validate(itemSchema.extend({ id: z.string().min(1, '缺少权限点 id') })),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const r = await updateMenuItem(body, req.user?.userId || 'system');
    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `权限点 ${r.moduleName} / ${r.itemName}`,
      beforeValue: '—',
      afterValue: `修改，现 ${r.actionCount} 个动作`,
      ip: clientIp(req),
    });
    res.json(ok(r, `已保存「${r.itemName}」的修改`));
  }),
);

menuRouter.delete(
  '/item/:id',
  checkPermission('perm:权限配置:editPerm'),
  wrap(async (req, res) => {
    const id = String(req.params.id || '');
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少权限点 id');
    const r = await deleteMenuItem(id, req.user?.userId || 'system');
    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `权限点 ${r.itemName}`,
      beforeValue: `被 ${r.affectedRoles} 个职位勾选`,
      afterValue: '已删除并收回授权',
      ip: clientIp(req),
    });
    res.json(
      ok(
        r,
        r.affectedRoles
          ? `已删除权限点「${r.itemName}」，并收回 ${r.affectedRoles} 个职位上的授权`
          : `已删除权限点「${r.itemName}」`,
      ),
    );
  }),
);

export default menuRouter;
