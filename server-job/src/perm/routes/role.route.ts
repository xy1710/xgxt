/**
 * 职位管理路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/role
 *
 *  GET    /list              职位列表（分页；带 deptId 时默认含其下级部门，可用 withChild=false 关掉）
 *  GET    /detail?id=xxx     职位详情（含权限映射）
 *  POST   /add               新建职位
 *  PUT    /update            编辑职位
 *  DELETE /delete/:id        删除职位（逻辑删除）
 *  PUT    /status            启用 / 停用
 *  GET    /overview          职位 KPI（4 个）
 *  GET    /codes             职位编码清单（跨模块：登录模块签发 token）
 *  GET    /export            导出职位清单（不分页，前端据此生成表格）
 *  POST   /import            导入职位
 *
 * ⚠️ 职位即权限容器：
 *    · t_perm_role 存职位本身
 *    · t_perm_role_perm 一行一个「已勾选动作」
 *    · perm_count 是冗余字段，保存权限后必须回填
 * ⚠️ 13 个系统预置职位（is_sys = true）不可删除，只能停用或改权限。
 * ⚠️ 职位编码全局唯一（uk_role_code）。逻辑删除后需「释放编码」，
 *    否则同名编码无法重建（唯一索引不认 is_deleted）。
 * ★ 2026-10-19：界面已完全去掉「职位编码」（用户要求全系统不可见 / 不可填），
 *    新建、编辑、导入都不再要求传 roleCode —— 不传由 nextRoleCode() 自动生成。
 *    列与字段本身**必须保留**：它是跨模块鉴权连接键（见 nextRoleCode 注释）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, RoleStatus, PermRoleDetail, RolePermMap } from 'shared-types/perm';
import { RoleCode } from 'shared-types';
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
  countRoleUsers,
  getRolePermMap,
  replaceRolePerms,
} from '../services/perm.service';

export const roleRouter = Router();

const TABLE = 't_perm_role';
const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/* ============================================================
 * 工具：批量取「职位 → 部门名 / 账号数」
 * ============================================================ */

async function deptNameMap(): Promise<Map<string, string>> {
  const rows = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
  return new Map(rows.map((r: any) => [r.id, r.dept_name]));
}

async function userCountMap(): Promise<Map<string, number>> {
  // ★ 2026-10-16：join t_perm_user 只数【有效账号】——
  //   原来直接数关联表，账号被硬删后残留的关联（孤儿）会把职位人数撑大，
  //   出现「咨询老师 4 人、部门里只有 2 人」的对不上。
  const rows = await db('t_perm_user_role as ur')
    .join('t_perm_user as u', function (this: any) {
      this.on('u.id', 'ur.user_id').andOn('u.is_deleted', 0);
    })
    .where('ur.is_deleted', false)
    .select('ur.role_id')
    .count({ n: '*' })
    .groupBy('ur.role_id');
  return new Map(rows.map((r: any) => [r.role_id, Number(r.n)]));
}

/** 组装职位列表项（列表 / 导出 共用） */
async function buildRoleListItems(rows: any[]) {
  const [depts, users] = await Promise.all([deptNameMap(), userCountMap()]);
  return rows.map((r: any) => {
    const userCount = users.get(r.id) || 0;
    return {
      id: r.id,
      roleName: r.role_name,
      roleCode: r.role_code,
      deptId: r.dept_id,
      deptName: depts.get(r.dept_id) || '—',
      roleType: r.role_type,
      // ★ 2026-10-08：等价内置职位码（自建职位声明自己等价于谁）
      equivRoleCode: r.equiv_role_code || null,
      isSys: !!r.is_sys,
      canDelete: !r.is_sys && userCount === 0,
      roleStatus: r.role_status,
      permCount: Number(r.perm_count || 0),
      userCount,
      remark: r.remark,
      createTime: r.create_time,
    };
  });
}

/* ============================================================
 * 1. 职位列表
 *    GET /api/perm/role/list?page=1&size=20&keyword=咨询&roleType=业务职位&roleStatus=启用
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  roleType: z.string().optional(),
  roleStatus: z.string().optional(),
  deptId: z.string().optional(),
  /**
   * 按部门筛职位时是否包含下级部门的职位（默认包含，与账号列表同口径）。
   *
   * ★ 2026-10-20：部门树上的「职位数」是**含子部门**的聚合值（dept.route 用
   *   collectDescendants 算的），但这里原来是 `andWhere('dept_id', deptId)` 精确匹配 ——
   *   于是「就业部」行上写 1 个职位，点「查看职位」却弹空列表（职位挂在它的
   *   实训管理 / 就业管理 上）。教学部只有自己挂职位，所以这个不一致以前从没暴露。
   *   现在默认含下级，数量和弹窗内容终于同源。
   */
  withChild: z.union([z.string(), z.boolean()]).optional(),
  /** 只看预置 / 只看自建 */
  isSys: z.union([z.string(), z.boolean()]).optional(),
});

roleRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(TABLE).where('is_deleted', false);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('role_name', 'like', `%${q.keyword}%`)
          .orWhere('role_code', 'like', `%${q.keyword}%`);
      });
    }
    if (q.roleType) query.andWhere('role_type', q.roleType);
    if (q.roleStatus) query.andWhere('role_status', q.roleStatus);
    if (q.deptId) {
      const withChild = !(q.withChild === false || q.withChild === 'false' || q.withChild === '0');
      if (withChild) {
        const all = await db('t_perm_dept').where('is_deleted', false).select('id', 'parent_id');
        query.whereIn('dept_id', collectDescendants(all, q.deptId));
      } else {
        query.andWhere('dept_id', q.deptId);
      }
    }
    if (q.isSys !== undefined && q.isSys !== '') {
      query.andWhere('is_sys', q.isSys === true || q.isSys === 'true' || q.isSys === '1');
    }

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy([{ column: 'is_sys', order: 'desc' }, { column: 'sort_no' }])
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = await buildRoleListItems(rows);
    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 职位详情（含权限映射）
 *    GET /api/perm/role/detail?id=R01
 * ============================================================ */

roleRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    const [dept, perms, userCount] = await Promise.all([
      row.dept_id ? db('t_perm_dept').where({ id: row.dept_id }).first() : null,
      getRolePermMap(id),
      countRoleUsers(id),
    ]);

    const detail: PermRoleDetail = {
      id: row.id,
      roleName: row.role_name,
      roleCode: row.role_code,
      deptId: row.dept_id,
      deptName: dept?.dept_name || '—',
      roleType: row.role_type,
      // ★ 2026-10-08：等价内置职位码
      equivRoleCode: row.equiv_role_code || null,
      isSys: !!row.is_sys,
      roleStatus: row.role_status,
      permCount: Number(row.perm_count || 0),
      sortNo: row.sort_no,
      remark: row.remark,
      createTime: row.create_time,
      createBy: row.create_by,
      updateTime: row.update_time,
      updateBy: row.update_by,
      isDeleted: !!row.is_deleted,
      userCount,
      perms,
    };

    res.json(ok(detail));
  }),
);

/**
 * 生成一个可用的职位编码（ROLE_0001、ROLE_0002 …）
 *
 * ⚠️ 2026-10-19 按用户要求：**全系统界面不再出现「职位编码」** ——
 *    新建 / 编辑职位、批量导入都不再让用户填它。
 *
 * 【为什么字段和列不能跟着一起删】
 *    t_perm_role.role_code 不是普通展示字段，它是**跨模块鉴权连接键**：
 *      · 登录模块 GET /api/perm/role/codes 取它写进 token 的 roles[]
 *      · 教务 / 班级 / 咨询 / 财务等模块用 `role_code IN (...)` 判定角色
 *      · app.ts 靠 RoleCode.SYS_ADMIN 决定「只有系统管理员能写」
 *      · DB 上有唯一索引 uk_role_code
 *    删列 = 把所有模块的鉴权打穿。所以正确做法是：
 *    **保留列与字段，改由后端自动补号，前后端都不再让用户看见或填写。**
 *    （与 2026-10-16「工号」的处理口径完全一致，见 user.route.ts nextGwNo）
 */
async function nextRoleCode(): Promise<string> {
  const rows: any[] = await db(TABLE).where('is_deleted', false).select('role_code');
  const used = new Set<string>();
  let max = 0;
  for (const r of rows) {
    const code = String(r.role_code || '');
    used.add(code);
    const m = /^ROLE_(\d{4,})$/.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (used.has(`ROLE_${String(n).padStart(4, '0')}`)) n += 1;
  return `ROLE_${String(n).padStart(4, '0')}`;
}

/* ============================================================
 * 3. 新建职位
 *    POST /api/perm/role/add
 * ============================================================ */

const saveSchema = z.object({
  roleName: z.string().min(1, '职位名称必填').max(50, '职位名称不超过 50 个字'),
  /**
   * ★ 2026-10-19：界面已去掉「职位编码」→ 这里改为**可选**。
   *   不传（或传空串）由 nextRoleCode() 自动生成；
   *   显式传值时仍按老规则校验，保持开放接口的向后兼容。
   */
  roleCode: z.string().max(64).optional(),
  deptId: z.string().optional(),
  roleType: z.string().optional(),
  /**
   * ★ 2026-10-08 新增：等价的内置职位码
   *
   *   自建职位声明「我等价于哪个内置职位」，运行时 `roleAlias.ts`
   *   会据此把它并入对应内置职位的别名集合 —— 于是审批链/权限判定
   *   里的 `hasRole(roles, 'PROJECT_MANAGER')` 对自建职位也能成立。
   *
   *   允许空字符串（= 清除声明），统一在 handler 里归一成 null。
   */
  equivRoleCode: z.string().max(64).optional().nullable(),
  roleStatus: z.string().optional(),
  sortNo: z.coerce.number().int().optional(),
  remark: z.string().max(255).optional(),
  /** 权限草稿：{ '模块key||功能点名': ['动作编码'] }；不传则不设权限 */
  perms: z.record(z.array(z.string())).optional(),
});

/**
 * ★ 2026-10-08：校验「等价内置职位码」
 *
 * 【为什么必须校验】
 *   这个字段会被 `roleAlias` 用作**权限判定依据** —— 填错等于给错权限。
 *   典型错误：
 *     · 填了一个自建职位码（如 `XMJL_000`）→ 别名表里查不到，等于没填，
 *       静默失效，用户以为配好了其实没有（最难排查）。
 *     · 填了小写 / 拼错（`project_manager`）→ 同样静默失效。
 *   所以这里**宁可报错也不静默接受**。
 *
 * @param code 用户填的值（可为空 = 不声明）
 * @returns 归一化后的值（null 或合法内置码）
 */
function normalizeEquivRoleCode(code: string | null | undefined): string | null {
  const v = String(code ?? '').trim();
  if (!v) return null;

  // 必须是主包 RoleCode 的取值
  const builtin = Object.values(RoleCode) as string[];
  if (!builtin.includes(v)) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `「等价内置职位」填的「${v}」不是有效的内置职位码。` +
        `只能填内置职位（如 ${builtin.slice(0, 5).join(' / ')} …），` +
        `不能填自建职位的编码。`,
    );
  }
  return v;
}

roleRouter.post(
  '/add',
  checkPermission('perm:职位管理:add'),
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema>;

    // ★ 2026-10-19：界面不再填「职位编码」——不传就自动生成一个可用的
    const roleCode = (body.roleCode || '').trim() || (await nextRoleCode());
    if (!ROLE_CODE_RE.test(roleCode)) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        '职位编码只能是「大写字母开头 + 大写字母/数字/下划线」',
      );
    }

    const dup = await db(TABLE).where({ role_code: roleCode, is_deleted: false }).first();
    if (dup) throw new BizError(BizCode.ROLE_CODE_EXISTS, `职位编码「${roleCode}」已被占用`);

    const dupName = await db(TABLE).where({ role_name: body.roleName, is_deleted: false }).first();
    if (dupName) throw new BizError(BizCode.ROLE_NAME_EXISTS, `职位名称「${body.roleName}」已存在`);

    if (body.deptId) {
      const dept = await db('t_perm_dept').where({ id: body.deptId, is_deleted: false }).first();
      if (!dept) throw new BizError(BizCode.DEPT_NOT_FOUND, '所属部门不存在');
    }

    const id = randomUUID();
    await db(TABLE).insert({
      id,
      role_name: body.roleName,
      role_code: roleCode,
      dept_id: body.deptId || null,
      role_type: body.roleType || '业务职位',
      // ★ 2026-10-08：等价内置职位（校验后再写，填错直接报错不静默）
      equiv_role_code: normalizeEquivRoleCode(body.equivRoleCode),
      // ⚠️ 新建的一律是自建职位，预置职位只能由种子数据产生
      is_sys: false,
      role_status: body.roleStatus || RoleStatus.ENABLED,
      perm_count: 0,
      sort_no: body.sortNo ?? 99,
      remark: body.remark || null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    let permCount = 0;
    if (body.perms) {
      permCount = await replaceRolePerms(id, body.perms as RolePermMap, req.user?.userId || 'system');
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '新增',
      targetObj: `职位 ${body.roleName}(${roleCode})`,
      beforeValue: '—',
      afterValue: `已创建，权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(ok({ id, permCount }, '已创建职位'));
  }),
);

/* ============================================================
 * 4. 编辑职位
 *    PUT /api/perm/role/update
 * ============================================================ */

const updateSchema = saveSchema.extend({ id: z.string().min(1, '必须传 id') });

roleRouter.put(
  '/update',
  checkPermission('perm:职位管理:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    // ★ 2026-10-19：界面不再填「职位编码」——不传就沿用库里原值，绝不误清空
    const givenCode = (body.roleCode || '').trim();
    if (givenCode && !ROLE_CODE_RE.test(givenCode)) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        '职位编码只能是「大写字母开头 + 大写字母/数字/下划线」',
      );
    }
    const nextCode = givenCode || exists.role_code;

    // ⚠️ 预置职位的编码不可改（登录模块 token 里的 roles[] 依赖它）
    if (exists.is_sys && nextCode !== exists.role_code) {
      throw new BizError(BizCode.PRESET_ROLE_PROTECTED, '系统预置职位的编码不可修改');
    }

    const dupName = await db(TABLE)
      .where({ role_name: body.roleName, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dupName) throw new BizError(BizCode.ROLE_NAME_EXISTS, `职位名称「${body.roleName}」已存在`);

    // 只有真的要换编码时才查重（不传就沿用原值，没必要查）
    if (nextCode !== exists.role_code) {
      const dupCode = await db(TABLE)
        .where({ role_code: nextCode, is_deleted: false })
        .whereNot('id', body.id)
        .first();
      if (dupCode) throw new BizError(BizCode.ROLE_CODE_EXISTS, `职位编码「${nextCode}」已被占用`);
    }

    await db(TABLE).where({ id: body.id }).update({
      role_name: body.roleName,
      role_code: nextCode,
      dept_id: body.deptId || exists.dept_id,
      role_type: body.roleType || exists.role_type,
      // ★ 2026-10-08：等价内置职位。
      //   ⚠️ 用 `!== undefined` 而不是 `??` —— 语义上要区分
      //      「没传这个字段」（保持原值）和「传了空串」（显式清除声明）。
      ...(body.equivRoleCode !== undefined
        ? { equiv_role_code: normalizeEquivRoleCode(body.equivRoleCode) }
        : {}),
      role_status: body.roleStatus || exists.role_status,
      sort_no: body.sortNo ?? exists.sort_no,
      remark: body.remark ?? exists.remark,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    let permCount = Number(exists.perm_count || 0);
    if (body.perms) {
      permCount = await replaceRolePerms(body.id, body.perms as RolePermMap, req.user?.userId || 'system');
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `职位 ${exists.role_name}`,
      beforeValue: `${exists.role_name} / 权限点 ${exists.perm_count}`,
      afterValue: `${body.roleName} / 权限点 ${permCount}`,
      ip: clientIp(req),
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 启用 / 停用
 *    PUT /api/perm/role/status   body: { id, roleStatus }
 * ============================================================ */

roleRouter.put(
  '/status',
  checkPermission('perm:职位管理:edit'),
  validate(
    z.object({
      id: z.string().min(1, '必须传 id'),
      roleStatus: z.enum([RoleStatus.ENABLED, RoleStatus.DISABLED], {
        errorMap: () => ({ message: '状态只能是「启用」或「停用」' }),
      }),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; roleStatus: RoleStatus };

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在');

    // ⚠️ 系统管理员是权限体系的最后一道门，停掉就没人能改权限了
    if (exists.role_code === 'SYS_ADMIN' && body.roleStatus === RoleStatus.DISABLED) {
      throw new BizError(BizCode.PRESET_ROLE_PROTECTED, '系统管理员职位不可停用');
    }

    await db(TABLE).where({ id: body.id }).update({
      role_status: body.roleStatus,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `职位 ${exists.role_name}`,
      beforeValue: exists.role_status,
      afterValue: body.roleStatus,
      ip: clientIp(req),
    });

    res.json(ok(null, `已${body.roleStatus === RoleStatus.ENABLED ? '启用' : '停用'}职位`));
  }),
);

/* ============================================================
 * 6. 删除职位（逻辑删除）
 *    DELETE /api/perm/role/delete/:id
 * ============================================================ */

roleRouter.delete(
  '/delete/:id',
  checkPermission('perm:职位管理:del'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.ROLE_NOT_FOUND, '职位不存在或已被删除');

    if (exists.is_sys) {
      throw new BizError(BizCode.PRESET_ROLE_PROTECTED, `「${exists.role_name}」是系统预置职位，不可删除`);
    }

    const userCount = await countRoleUsers(id);
    if (userCount > 0) {
      throw new BizError(BizCode.ROLE_IN_USE, `该职位还关联着 ${userCount} 个账号，请先解绑再删除`);
    }

    await db.transaction(async (trx) => {
      // ⚠️ 释放编码：唯一索引不认 is_deleted，不改编码则同名编码无法重建
      const freedCode = `${exists.role_code}#DEL#${Date.now()}`.slice(0, 64);
      await trx(TABLE).where({ id }).update({
        role_code: freedCode,
        is_deleted: true,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      // 权限明细一并逻辑删除，避免残留
      await trx('t_perm_role_perm').where({ role_id: id }).update({
        is_deleted: true,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '删除',
      targetObj: `职位 ${exists.role_name}(${exists.role_code})`,
      beforeValue: `存在，权限点 ${exists.perm_count}`,
      afterValue: '已删除',
      ip: clientIp(req),
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 7. 职位 KPI（4 个）
 *    GET /api/perm/role/overview
 * ============================================================ */

roleRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const [all, preset, custom, disabled] = await Promise.all([
      db(TABLE).where('is_deleted', false).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, is_sys: true }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, is_sys: false }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, role_status: RoleStatus.DISABLED }).count({ n: '*' }),
    ]);

    res.json(
      ok({
        roleTotal: Number(all[0]?.n || 0),
        presetTotal: Number(preset[0]?.n || 0),
        customTotal: Number(custom[0]?.n || 0),
        disabledTotal: Number(disabled[0]?.n || 0),
      }),
    );
  }),
);

/* ============================================================
 * 8. 职位编码清单（跨模块）
 *    GET /api/perm/role/codes
 *
 * ⚠️ 登录模块签发 token 时取这个接口，把 roleCode 写进 roles[]。
 * ============================================================ */

roleRouter.get(
  '/codes',
  wrap(async (_req, res) => {
    const rows = await db(TABLE).where('is_deleted', false).orderBy('sort_no');
    res.json(
      ok(
        rows.map((r: any) => ({
          roleCode: r.role_code,
          roleName: r.role_name,
          roleStatus: r.role_status,
          isSys: !!r.is_sys,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 9. 导出职位清单（不分页，前端据此生成 xlsx）
 *    GET /api/perm/role/export?keyword=...
 * ============================================================ */

roleRouter.get(
  '/export',
  wrap(async (req, res) => {
    const keyword = String(req.query.keyword || '');
    const query = db(TABLE).where('is_deleted', false);
    if (keyword) {
      query.andWhere((qb) => {
        qb.where('role_name', 'like', `%${keyword}%`).orWhere('role_code', 'like', `%${keyword}%`);
      });
    }
    const rows = await query.orderBy([{ column: 'is_sys', order: 'desc' }, { column: 'sort_no' }]);
    const list = await buildRoleListItems(rows);
    res.json(ok({ total: list.length, list }));
  }),
);

/* ============================================================
 * 10. 导入职位
 *     POST /api/perm/role/import
 *     body: { list: [{ roleName, deptName, roleType, remark }] }  // roleCode 可选，不传自动生成
 *
 * ⚠️ 逐行校验，成功的入库、失败的回报行号与原因 —— 不要整批回滚，
 *    否则用户拿不到「哪一行错了」的信息。
 * ============================================================ */

const importSchema = z.object({
  list: z
    .array(
      z.object({
        roleName: z.string().min(1, '职位名称必填'),
        // ★ 2026-10-19：界面已去掉「职位编码」→ 可选，不传自动生成
        roleCode: z.string().max(64).optional(),
        deptName: z.string().optional(),
        roleType: z.string().optional(),
        remark: z.string().optional(),
      }),
    )
    .min(1, '导入内容不能为空'),
});

roleRouter.post(
  '/import',
  checkPermission('perm:职位管理:add'),
  validate(importSchema),
  wrap(async (req, res) => {
    const { list } = (req as any).validated as z.infer<typeof importSchema>;

    const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
    const deptByName = new Map(depts.map((d: any) => [d.dept_name, d.id]));

    const errors: { row: number; reason: string }[] = [];
    let success = 0;

    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      const rowNo = i + 1;

      // ★ 2026-10-19：导入模板已不含「职位编码」列 → 缺省自动生成
      const code = (row.roleCode || '').trim() || (await nextRoleCode());
      if (!ROLE_CODE_RE.test(code)) {
        errors.push({ row: rowNo, reason: `职位编码「${code}」格式非法` });
        continue;
      }
      const dup = await db(TABLE).where({ role_code: code, is_deleted: false }).first();
      if (dup) {
        errors.push({ row: rowNo, reason: `职位编码「${code}」已存在` });
        continue;
      }
      const dupName = await db(TABLE).where({ role_name: row.roleName, is_deleted: false }).first();
      if (dupName) {
        errors.push({ row: rowNo, reason: `职位名称「${row.roleName}」已存在` });
        continue;
      }

      await db(TABLE).insert({
        id: randomUUID(),
        role_name: row.roleName,
        role_code: code,
        dept_id: row.deptName ? deptByName.get(row.deptName) || null : null,
        role_type: row.roleType || '业务职位',
        is_sys: false,
        role_status: RoleStatus.ENABLED,
        perm_count: 0,
        sort_no: 99,
        remark: row.remark || null,
        is_deleted: false,
        create_time: new Date(),
        create_by: req.user?.userId || 'system',
      });
      success += 1;
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      moduleName: '权限管理',
      actionType: '新增',
      targetObj: '职位批量导入',
      beforeValue: '—',
      afterValue: `成功 ${success} 条，失败 ${errors.length} 条`,
      ip: clientIp(req),
    });

    res.json(
      ok(
        { success, fail: errors.length, errors },
        `导入完成：成功 ${success} 条，失败 ${errors.length} 条`,
      ),
    );
  }),
);

export default roleRouter;
