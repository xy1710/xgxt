/**
 * 部门管理路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/dept
 *
 *  GET    /list              部门列表（分页）
 *  GET    /tree              部门树（部门管理页左侧树）
 *  GET    /overview          部门 KPI（4 个）
 *  GET    /detail?id=xxx     部门详情
 *  POST   /add               新建部门
 *  PUT    /update            编辑部门
 *  DELETE /delete/:id        删除部门（逻辑删除）
 *
 * ⚠️ 部门被职位/账号引用时不可删除；有子部门时不可删除。
 * ⚠️ 删除部门为不可恢复操作 —— 前端需二次确认。
 * ⚠️ 层级最多 3 级（校级 1 / 部门 2 / 下设子部门 3）；改上级部门时 dept_level
 *    连同其下级一起重算 —— 只改 parent_id 会让整棵树的前端缩进错位。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, DEPT_LEVEL_NAME, PermDeptTreeNode } from 'shared-types/perm';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  addLog,
  clientIp,
  collectDescendants,
  countDeptTotal,
  countStageTotal,
} from '../services/perm.service';

export const deptRouter = Router();

const TABLE = 't_perm_dept';
/** 校级部门的固定 id（与种子数据一致） */
const ROOT_DEPT_ID = 'D_ALL';
/** 层级上限（校级 1 / 部门 2 / 下设子部门 3）—— 与前端 MAX_DEPT_LEVEL 同值 */
const MAX_DEPT_LEVEL = 3;

/* ============================================================
 * 1. 部门列表
 *    GET /api/perm/dept/list?page=1&size=20&keyword=教学
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  parentId: z.string().optional(),
});

deptRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(TABLE).where('is_deleted', false);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('dept_name', 'like', `%${q.keyword}%`)
          .orWhere('dept_short', 'like', `%${q.keyword}%`);
      });
    }
    if (q.parentId) query.andWhere('parent_id', q.parentId);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy([{ column: 'dept_level' }, { column: 'sort_no' }])
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // 部门归属统计（职位数 / 账号数，含子部门）
    const allDepts = await db(TABLE).where('is_deleted', false).select('id', 'parent_id');
    const roleRows = await db('t_perm_role').where('is_deleted', false).select('dept_id');

    const list = rows.map((r: any) => {
      const ids = collectDescendants(allDepts, r.id);
      return {
        id: r.id,
        deptName: r.dept_name,
        deptShort: r.dept_short,
        parentId: r.parent_id,
        deptLevel: r.dept_level,
        deptLevelName: DEPT_LEVEL_NAME[r.dept_level] || '',
        sortNo: r.sort_no,
        remark: r.remark,
        roleCount: roleRows.filter((x: any) => ids.includes(x.dept_id)).length,
        createTime: r.create_time,
        createBy: r.create_by,
        updateTime: r.update_time,
        updateBy: r.update_by,
        isDeleted: !!r.is_deleted,
      };
    });

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 部门树
 *    GET /api/perm/dept/tree
 * ============================================================ */

deptRouter.get(
  '/tree',
  wrap(async (_req, res) => {
    const rows = await db(TABLE)
      .where('is_deleted', false)
      .orderBy([{ column: 'dept_level' }, { column: 'sort_no' }]);

    const allDepts = rows.map((r: any) => ({ id: r.id, parent_id: r.parent_id }));
    const roleRows = await db('t_perm_role').where('is_deleted', false).select('dept_id');
    const userRows = await db('t_perm_user').where('is_deleted', false).select('dept_id');

    const nodes: PermDeptTreeNode[] = rows.map((r: any) => {
      const ids = collectDescendants(allDepts, r.id);
      return {
        id: r.id,
        deptName: r.dept_name,
        deptShort: r.dept_short,
        deptLevel: r.dept_level,
        deptLevelName: DEPT_LEVEL_NAME[r.dept_level] || '',
        parentId: r.parent_id,
        roleCount: roleRows.filter((x: any) => ids.includes(x.dept_id)).length,
        userCount: userRows.filter((x: any) => ids.includes(x.dept_id)).length,
        children: [],
      };
    });

    // 组装成树
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const tree: PermDeptTreeNode[] = [];
    nodes.forEach((n) => {
      if (n.parentId && byId.has(n.parentId)) {
        byId.get(n.parentId)!.children!.push(n);
      } else {
        tree.push(n);
      }
    });

    res.json(ok(tree));
  }),
);

/* ============================================================
 * 3. 部门 KPI（4 个）
 *    GET /api/perm/dept/overview
 * ============================================================ */

deptRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const [deptTotal, stageTotal, roleTotal, userTotal] = await Promise.all([
      countDeptTotal(),
      countStageTotal(),
      db('t_perm_role').where('is_deleted', false).count({ n: '*' }),
      db('t_perm_user').where('is_deleted', false).count({ n: '*' }),
    ]);

    res.json(
      ok({
        deptTotal,
        stageTotal,
        roleTotal: Number(roleTotal[0]?.n || 0),
        userTotal: Number(userTotal[0]?.n || 0),
      }),
    );
  }),
);

/* ============================================================
 * 4. 部门详情
 *    GET /api/perm/dept/detail?id=xxx
 * ============================================================ */

deptRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.DEPT_NOT_FOUND, '部门不存在');

    const allDepts = await db(TABLE).where('is_deleted', false).select('id', 'parent_id');
    const ids = collectDescendants(allDepts, id);
    const roleCount = await db('t_perm_role').where('is_deleted', false).whereIn('dept_id', ids).count({ n: '*' });
    const userCount = await db('t_perm_user').where('is_deleted', false).whereIn('dept_id', ids).count({ n: '*' });

    res.json(
      ok({
        id: row.id,
        deptName: row.dept_name,
        deptShort: row.dept_short,
        parentId: row.parent_id,
        deptLevel: row.dept_level,
        deptLevelName: DEPT_LEVEL_NAME[row.dept_level] || '',
        sortNo: row.sort_no,
        remark: row.remark,
        roleCount: Number(roleCount[0]?.n || 0),
        userCount: Number(userCount[0]?.n || 0),
        createTime: row.create_time,
        createBy: row.create_by,
        updateTime: row.update_time,
        updateBy: row.update_by,
        isDeleted: !!row.is_deleted,
      }),
    );
  }),
);

/* ============================================================
 * 5. 新建部门
 *    POST /api/perm/dept/add
 * ============================================================ */

const addSchema = z.object({
  deptName: z.string().min(1, '部门名称必填').max(50, '部门名称不超过 50 个字'),
  deptShort: z.string().max(20).optional(),
  parentId: z.string().optional().nullable(),
  sortNo: z.coerce.number().int().optional(),
  remark: z.string().max(255).optional(),
});

deptRouter.post(
  '/add',
  checkPermission('perm:职位管理:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    const dup = await db(TABLE).where({ dept_name: body.deptName, is_deleted: false }).first();
    if (dup) throw new BizError(BizCode.DEPT_NAME_EXISTS, `部门「${body.deptName}」已存在`);

    const parentId = body.parentId || ROOT_DEPT_ID;
    const parent = await db(TABLE).where({ id: parentId, is_deleted: false }).first();
    if (!parent) throw new BizError(BizCode.DEPT_NOT_FOUND, '上级部门不存在');

    const deptLevel = Number(parent.dept_level) + 1;
    // 前端下拉把 level=3 的部门置灰了，这里再拦一次：接口被直接调用时也不能建出第 4 层
    if (deptLevel > MAX_DEPT_LEVEL) {
      throw new BizError(BizCode.PARAM_ERROR, `部门层级最多 ${MAX_DEPT_LEVEL} 级，不能再往下建`);
    }
    const id = randomUUID();

    await db(TABLE).insert({
      id,
      dept_name: body.deptName,
      dept_short: body.deptShort || body.deptName,
      parent_id: parentId,
      dept_level: deptLevel,
      sort_no: body.sortNo ?? 99,
      remark: body.remark || null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '新增',
      targetObj: `部门 ${body.deptName}`,
      beforeValue: '—',
      afterValue: '已创建',
      ip: clientIp(req),
    });

    res.json(ok({ id }, '已创建部门'));
  }),
);

/* ============================================================
 * 6. 编辑部门
 *    PUT /api/perm/dept/update
 * ============================================================ */

const updateSchema = addSchema.extend({ id: z.string().min(1, '必须传 id') });

deptRouter.put(
  '/update',
  checkPermission('perm:职位管理:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.DEPT_NOT_FOUND, '部门不存在');

    const dup = await db(TABLE)
      .where({ dept_name: body.deptName, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dup) throw new BizError(BizCode.DEPT_NAME_EXISTS, `部门「${body.deptName}」已存在`);

    // 上级部门：不传 = 保持原挂载点
    const parentId = body.parentId || exists.parent_id;

    const all = await db(TABLE)
      .where('is_deleted', false)
      .select('id', 'parent_id', 'dept_level');

    // 不允许把部门挂到自己或自己的后代下（会把树挂断）
    if (body.parentId) {
      const descendants = collectDescendants(all, body.id);
      if (descendants.includes(body.parentId)) {
        throw new BizError(BizCode.PARAM_ERROR, '不能把部门移动到它自己的下级部门');
      }
    }

    /* ★ 2026-10-20：上级变了，dept_level 必须跟着重算 ——
     *   原实现只改 parent_id，层级还留在旧值上。前端是按 dept_level 算缩进、
     *   并按「level 是否已达上限」决定下拉能不能选，层级不对整棵树就错位了
     *   （就业部 / 教学部这种带下级部门的父级尤其明显）。
     *   后代也要跟着平移，所以记一个 delta 往下刷。 */
    const parent = all.find((d) => d.id === parentId);
    if (!parent) throw new BizError(BizCode.DEPT_NOT_FOUND, '上级部门不存在');

    const nextLevel = Number(parent.dept_level) + 1;
    if (nextLevel > MAX_DEPT_LEVEL) {
      throw new BizError(BizCode.PARAM_ERROR, `部门层级最多 ${MAX_DEPT_LEVEL} 级，不能再往下挂`);
    }
    const levelDelta = nextLevel - Number(exists.dept_level);

    await db(TABLE).where({ id: body.id }).update({
      dept_name: body.deptName,
      dept_short: body.deptShort || body.deptName,
      parent_id: parentId,
      dept_level: nextLevel,
      sort_no: body.sortNo ?? exists.sort_no,
      remark: body.remark || null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // 下级部门的层级跟着同一 delta 平移（不提的话「父 2 子 3」会变成「父 2 子 4」）
    if (levelDelta !== 0) {
      const childIds = collectDescendants(all, body.id).filter((id) => id !== body.id);
      if (childIds.length) {
        await db(TABLE)
          .whereIn('id', childIds)
          .update({ dept_level: db.raw('dept_level + ?', [levelDelta]) });
      }
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `部门 ${exists.dept_name}`,
      beforeValue: exists.dept_name,
      afterValue: body.deptName,
      ip: clientIp(req),
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 7. 删除部门（逻辑删除）
 *    DELETE /api/perm/dept/delete/:id
 * ============================================================ */

deptRouter.delete(
  '/delete/:id',
  checkPermission('perm:职位管理:del'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.DEPT_NOT_FOUND, '部门不存在或已被删除');
    if (id === ROOT_DEPT_ID) throw new BizError(BizCode.DEPT_IN_USE, '校级部门不可删除');

    // 有子部门 → 不可删
    const childCount = await db(TABLE).where({ parent_id: id, is_deleted: false }).count({ n: '*' });
    if (Number(childCount[0]?.n || 0) > 0) {
      throw new BizError(BizCode.DEPT_HAS_CHILD, '该部门下还有子部门，请先处理子部门');
    }

    // 被职位/账号引用 → 不可删
    const roleCount = await db('t_perm_role').where({ dept_id: id, is_deleted: false }).count({ n: '*' });
    const userCount = await db('t_perm_user').where({ dept_id: id, is_deleted: false }).count({ n: '*' });
    if (Number(roleCount[0]?.n || 0) > 0 || Number(userCount[0]?.n || 0) > 0) {
      throw new BizError(
        BizCode.DEPT_IN_USE,
        `该部门被 ${roleCount[0]?.n || 0} 个职位、${userCount[0]?.n || 0} 个账号引用，不可删除`,
      );
    }

    // ⚠️ 逻辑删除，不要用 del()
    await db(TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      moduleName: '权限管理',
      actionType: '删除',
      targetObj: `部门 ${exists.dept_name}`,
      beforeValue: '存在',
      afterValue: '已删除',
      ip: clientIp(req),
    });

    res.json(ok(null, '删除成功'));
  }),
);

export default deptRouter;
