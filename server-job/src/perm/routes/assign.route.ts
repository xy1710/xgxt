/**
 * 职位权限分配路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/assign
 *
 *  GET  /role-list              左栏职位清单
 *  GET  /tree?roleId=xxx        权限树 + 该职位勾选态 + 实时统计
 *  PUT  /save                   保存（全量覆盖）
 *  POST /copy                   从其他职位复制权限
 *  POST /reset                  清空该职位全部权限
 *
 * ⚠️ 本模块最关键的语义：**应用权限 = 全量覆盖**，不是增量合并。
 *    前端把整棵树的勾选状态一次性提交，后端先按 role_id 清空再插入。
 *    这样才不会出现「取消勾选后权限还在」的幽灵权限。
 * ⚠️ 未勾选即无权限 —— 不提供「拒绝」语义。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, PermModule, RolePermMap } from 'shared-types/perm';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  addLog,
  clientIp,
  getRolePermMap,
  getTreeStats,
  loadModules,
  replaceRolePerms,
} from '../services/perm.service';
import { clearRoleDefaultCache } from '../../utils/rolePageDefaults';
import { clearRoleActionCache } from '../../utils/roleActionOverlay';

/**
 * ★ 2026-10-07 新增：保存权限点后立刻清掉下游缓存
 *
 * 【为什么必须有这一步】
 *   权限点（t_perm_role_perm）在两个地方被当**默认值**用：
 *     ① 职位 → 页面 的默认可见集合（rolePageDefaults.ts，15 秒内存缓存）
 *     ② 职位 → 操作码 的按钮判权叠加（roleActionOverlay.ts，15 秒内存缓存）
 *   缓存 TTL 是 15 秒，但**改完不主动清**的话，管理员会看到
 *   「界面上取消了权限点，页面/按钮却要等十几秒才变」——
 *   实测确认过是 15.1 秒（见 docs/权限控制-端到端验证报告）。
 *   加上这两行后是**即时生效**。
 */
function invalidateAfterPermChange(): void {
  clearRoleDefaultCache();
  clearRoleActionCache();
}

export const assignRouter = Router();

const permKey = (moduleKey: string, itemName: string) => `${moduleKey}||${itemName}`;

/* ============================================================
 * 1. 左栏职位清单
 *    GET /api/perm/assign/role-list
 * ============================================================ */

assignRouter.get(
  '/role-list',
  wrap(async (_req, res) => {
    const rows = await db('t_perm_role').where('is_deleted', false).orderBy('sort_no');
    const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
    const deptMap = new Map(depts.map((d: any) => [d.id, d.dept_name]));

    res.json(
      ok(
        rows.map((r: any) => ({
          id: r.id,
          roleName: r.role_name,
          roleCode: r.role_code,
          deptName: deptMap.get(r.dept_id) || '—',
          roleType: r.role_type,
          isSys: !!r.is_sys,
          roleStatus: r.role_status,
          permCount: Number(r.perm_count || 0),
        })),
      ),
    );
  }),
);

/* ============================================================
 * 2. 权限树 + 勾选态
 *    GET /api/perm/assign/tree?roleId=R01
 * ============================================================ */

const treeSchema = z.object({ roleId: z.string().min(1, '必须传 roleId') });

assignRouter.get(
  '/tree',
  validate(treeSchema),
  wrap(async (req, res) => {
    const { roleId } = (req as any).validated as { roleId: string };

    const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    const [mods, perms, stats] = await Promise.all([
      loadModules(),
      getRolePermMap(roleId),
      getTreeStats(),
    ]);

    // 把勾选态挂到每个功能点上，前端不用再自己算
    const modules: PermModule[] = mods.map((m) => {
      let checkedCount = 0;
      let grantedItemCount = 0;
      const items = m.items.map((it) => {
        const checked = perms[permKey(m.moduleKey, it.itemName)] || [];
        if (checked.length) {
          checkedCount += checked.length;
          grantedItemCount += 1;
        }
        return { ...it, checked };
      });
      return { ...m, items, checkedCount, grantedItemCount };
    });

    // 实时统计（弹窗底部）
    const allChecked = new Set<string>();
    let coveredModuleCount = 0;
    Object.keys(perms).forEach((k) => {
      const codes = perms[k] || [];
      if (codes.length) coveredModuleCount += 1;
      codes.forEach((c) => allChecked.add(`${k}||${c}`));
    });
    // 覆盖模块数按「模块」去重（不是功能点）
    const coveredModules = new Set(
      Object.keys(perms)
        .filter((k) => (perms[k] || []).length)
        .map((k) => k.split('||')[0]),
    );
    coveredModuleCount = coveredModules.size;

    res.json(
      ok({
        role: {
          id: role.id,
          roleName: role.role_name,
          roleCode: role.role_code,
          roleType: role.role_type,
          isSys: !!role.is_sys,
          roleStatus: role.role_status,
        },
        modules,
        perms,
        stats,
        selected: {
          checkedActionCount: allChecked.size,
          coveredModuleCount,
          totalActionCount: stats.actionCount,
        },
      }),
    );
  }),
);

/* ============================================================
 * 3. 保存权限（全量覆盖）
 *    PUT /api/perm/assign/save   body: { roleId, perms }
 * ============================================================ */

const saveSchema = z.object({
  roleId: z.string().min(1, '必须传 roleId'),
  perms: z.record(z.array(z.string())),
});

assignRouter.put(
  '/save',
  checkPermission('perm:权限配置:editPerm'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as { roleId: string; perms: RolePermMap };

    const role = await db('t_perm_role').where({ id: body.roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    const before = Number(role.perm_count || 0);
    const permCount = await replaceRolePerms(body.roleId, body.perms, req.user?.userId || 'system');
    // ★ 立刻让下游（页面默认 + 按钮判权）拿到最新权限点
    invalidateAfterPermChange();

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.role_name}`,
      beforeValue: `权限点 ${before}`,
      afterValue: `权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(ok({ permCount }, `已应用，共 ${permCount} 个权限点`));
  }),
);

/* ============================================================
 * 4. 复制权限
 *    POST /api/perm/assign/copy   body: { targetRoleId, sourceRoleId }
 * ============================================================ */

assignRouter.post(
  '/copy',
  checkPermission('perm:权限配置:editPerm'),
  validate(
    z.object({
      targetRoleId: z.string().min(1, '必须传 targetRoleId'),
      sourceRoleId: z.string().min(1, '必须传 sourceRoleId'),
    }),
  ),
  wrap(async (req, res) => {
    const { targetRoleId, sourceRoleId } = (req as any).validated as {
      targetRoleId: string;
      sourceRoleId: string;
    };

    if (targetRoleId === sourceRoleId) {
      throw new BizError(BizCode.PARAM_ERROR, '来源职位与目标职位不能是同一个');
    }

    const [target, source] = await Promise.all([
      db('t_perm_role').where({ id: targetRoleId, is_deleted: false }).first(),
      db('t_perm_role').where({ id: sourceRoleId, is_deleted: false }).first(),
    ]);
    if (!target) throw new BizError(BizCode.ROLE_NOT_FOUND, '目标职位不存在');
    if (!source) throw new BizError(BizCode.ROLE_NOT_FOUND, '来源职位不存在');

    const perms = await getRolePermMap(sourceRoleId);
    if (!Object.keys(perms).some((k) => (perms[k] || []).length)) {
      throw new BizError(BizCode.PERM_SAVE_EMPTY, `来源职位「${source.role_name}」没有任何权限可复制`);
    }

    const permCount = await replaceRolePerms(targetRoleId, perms, req.user?.userId || 'system');
    invalidateAfterPermChange();

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${target.role_name}`,
      beforeValue: `权限点 ${target.perm_count}`,
      afterValue: `复制自「${source.role_name}」，权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(ok({ permCount, sourceRoleName: source.role_name }, `已复制权限，共 ${permCount} 个权限点`));
  }),
);

/* ============================================================
 * 5. 恢复默认 / 清空
 *    POST /api/perm/assign/reset   body: { roleId, mode }
 *
 * ⚠️ mode = 'clear'（默认）清空为 0；
 *          'full' 恢复「全模块全动作」（仅调试用，正式环境不建议暴露）。
 * ============================================================ */

assignRouter.post(
  '/reset',
  checkPermission('perm:权限配置:editPerm'),
  validate(
    z.object({
      roleId: z.string().min(1, '必须传 roleId'),
      mode: z.enum(['clear', 'full']).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const { roleId, mode } = (req as any).validated as { roleId: string; mode?: 'clear' | 'full' };

    const role = await db('t_perm_role').where({ id: roleId, is_deleted: false }).first();
    if (!role) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    let perms: RolePermMap = {};
    if (mode === 'full') {
      const mods = await loadModules();
      mods.forEach((m) => {
        m.items.forEach((it) => {
          perms[permKey(m.moduleKey, it.itemName)] = it.actions.map((a) => a.actionCode);
        });
      });
    }

    const before = Number(role.perm_count || 0);
    const permCount = await replaceRolePerms(roleId, perms, req.user?.userId || 'system');
    invalidateAfterPermChange();

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '权限变更',
      targetObj: `职位 ${role.role_name}`,
      beforeValue: `权限点 ${before}`,
      afterValue: mode === 'full' ? `已全量赋予，权限点 ${permCount}` : '已清空权限',
      ip: clientIp(req),
    });

    res.json(ok({ permCount }, mode === 'full' ? '已赋予全部权限' : '已清空该职位的权限'));
  }),
);

export default assignRouter;
