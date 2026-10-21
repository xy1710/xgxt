/**
 * 账号（用户）管理路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/user
 *
 *  GET    /list                  账号列表（分页）
 *  GET    /detail?id=xxx         账号详情（含职位）
 *  POST   /add                   新建账号
 *  PUT    /update                编辑账号
 *  DELETE /delete/:id            删除账号（逻辑删除）
 *  PUT    /status                启用 / 停用 / 锁定
 *  PUT    /reset-pwd             重置密码
 *  PUT    /unlock                解锁（清零错误次数）
 *  GET    /overview              账号 KPI（5 个，均可点击筛选）
 *  GET    /auth-profile?account= 账号鉴权档案（跨模块：登录模块调用）
 *
 * ⚠️ 归属决策：账号数据归【权限管理模块】所有（账号管理是权限管理的第 3 个功能页）。
 *    登录模块不建表，通过 /auth-profile 按账号取「账号 + 职位 + 权限并集 + 数据范围」。
 * ⚠️ 多职位：一个账号可挂多个职位，权限取【并集去重】，数据范围取【最宽的一档】。
 * ⚠️ 密码策略由规则配置（t_perm_rule / pwd 组）驱动，不写死。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID, randomInt } from 'crypto';
import {
  BizCode,
  DataScope,
  GENDER_NAME,
  RoleStatus,
  RoleType,
  UserStatus,
} from 'shared-types/perm';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
/* ★ 2026-10-19：密码策略抽出到 pwdPolicy —— 与门户「自助改密」共用同一份，
   原来这里和 portal 各写一套，口径不一致导致自助改密能绕过规则。 */
import { assertPwdStrength, loadPwdRule } from '../services/pwdPolicy';
import {
  addLog,
  avatarText,
  clientIp,
  collectDescendants,
  getUserEffectivePerms,
  joinRoleNames,
  maskPhone,
  SCOPE_ACTION_TO_VALUE,
  getPortalAccounts,
  syncPortalPassword,
  accountBusinessRefs,
  retirePortalAccount,
  setPortalAccountActive,
  upsertPortalAccount,
} from '../services/perm.service';

export const userRouter = Router();

const TABLE = 't_perm_user';
const NAME_RE = /^[\u4e00-\u9fa5]{2,}$/;          // 姓名：仅汉字，不低于 2 位
const GW_RE = /^GW\d{4}$/;                        // 工号：GW + 4 位数字
const ACCT_RE = /^[A-Za-z0-9]{4,20}$/;            // 账号：字母/数字，4-20 位
const PHONE_RE = /^1\d{10}$/;                     // 手机号：11 位，1 开头

/* ============================================================
 * 工具：密码策略校验
 *
 * ★ 2026-10-19：判定逻辑已抽到 perm/services/pwdPolicy.ts，
 *   与「顶栏自助改密」（portal/services/account.service.ts）共用同一份策略。
 *   本文件只负责「新增 / 编辑 / 重置密码」三个入口的调用。
 * ============================================================ */

/** 生成一个满足当前策略的随机密码（重置密码用） */
async function generatePassword(): Promise<string> {
  const rule = await loadPwdRule();
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '@#$%&*!';
  const pick = (s: string, n: number) =>
    Array.from({ length: n }, () => s[randomInt(0, s.length)]).join('');

  let pwd = pick(upper, 2) + pick(lower, 3) + pick(digit, 3) + (rule.symbol ? pick(symbol, 2) : '');
  while (pwd.length < rule.min) pwd += pick(lower, 1);
  // 打散顺序，避免固定「大写-小写-数字-符号」的格式
  return pwd
    .split('')
    .sort(() => (randomInt(0, 2) ? 1 : -1))
    .join('');
}

/* ============================================================
 * 工具：账号 → 职位 / 权限并集 批量组装
 * ============================================================ */

interface UserRoleBundle {
  roleIdsByUser: Map<string, string[]>;
  roleNameById: Map<string, string>;
  roleCodeById: Map<string, string>;
  permKeysByRole: Map<string, Set<string>>;
  dataScopeByRole: Map<string, DataScope>;
}

async function loadUserRoleBundle(userIds: string[]): Promise<UserRoleBundle> {
  const roleIdsByUser = new Map<string, string[]>();
  const roleNameById = new Map<string, string>();
  const roleCodeById = new Map<string, string>();
  const permKeysByRole = new Map<string, Set<string>>();
  const dataScopeByRole = new Map<string, DataScope>();

  if (!userIds.length) {
    return { roleIdsByUser, roleNameById, roleCodeById, permKeysByRole, dataScopeByRole };
  }

  const links = await db('t_perm_user_role')
    .whereIn('user_id', userIds)
    .andWhere('is_deleted', false);
  links.forEach((l: any) => {
    const arr = roleIdsByUser.get(l.user_id) || [];
    arr.push(l.role_id);
    roleIdsByUser.set(l.user_id, arr);
  });

  const roleIds = Array.from(new Set(links.map((l: any) => l.role_id)));
  if (!roleIds.length) {
    return { roleIdsByUser, roleNameById, roleCodeById, permKeysByRole, dataScopeByRole };
  }

  const roles = await db('t_perm_role').whereIn('id', roleIds).andWhere('is_deleted', false);
  roles.forEach((r: any) => {
    roleNameById.set(r.id, r.role_name);
    roleCodeById.set(r.id, r.role_code);
  });

  const permRows = await db('t_perm_role_perm').whereIn('role_id', roleIds).andWhere('is_deleted', false);
  permRows.forEach((p: any) => {
    const set = permKeysByRole.get(p.role_id) || new Set<string>();
    set.add(`${p.module_key}||${p.item_name}||${p.action_code}`);
    permKeysByRole.set(p.role_id, set);

    const scope = SCOPE_ACTION_TO_VALUE[p.action_code];
    if (scope) {
      const prev = dataScopeByRole.get(p.role_id) || DataScope.SELF;
      if (scope > prev) dataScopeByRole.set(p.role_id, scope);
    }
  });

  return { roleIdsByUser, roleNameById, roleCodeById, permKeysByRole, dataScopeByRole };
}

/** 组装账号列表项 */
async function buildUserListItems(rows: any[]) {
  const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
  const deptMap = new Map(depts.map((d: any) => [d.id, d.dept_name]));

  // ★ 2026-10-16：批量带出门户账号的可访问模块（列表 / 编辑表单回显用）
  const portalMap = await getPortalAccounts(rows.map((r: any) => r.account));

  const bundle = await loadUserRoleBundle(rows.map((r: any) => r.id));

  return rows.map((r: any) => {
    const roleIds = bundle.roleIdsByUser.get(r.id) || [];
    const roleNames = roleIds.map((id) => bundle.roleNameById.get(id)).filter(Boolean) as string[];

    const union = new Set<string>();
    roleIds.forEach((rid) => {
      (bundle.permKeysByRole.get(rid) || new Set<string>()).forEach((k) => union.add(k));
    });

    return {
      id: r.id,
      userName: r.user_name,
      avatarText: avatarText(r.user_name),
      gwNo: r.gw_no,
      account: r.account,
      phoneMasked: maskPhone(r.phone),
      phone: r.phone,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      age: r.age,
      deptId: r.dept_id,
      deptName: deptMap.get(r.dept_id) || '—',
      roleIds,
      roleNames,
      roleName: roleNames[0] || '—',
      effectivePermCount: union.size,
      userStatus: r.user_status,
      needChangePwd: !!r.need_change_pwd,
      lastLoginTime: r.last_login_time,
      createTime: r.create_time,
      createBy: r.create_by,
      remark: r.remark,
      /** ★ 门户账号的可访问模块（没有门户账号时是空数组） */
      portalModules: portalMap.get(String(r.account))?.modules || [],
      /** ★ 该登录名在门户有没有账号 */
      hasPortalAccount: portalMap.has(String(r.account)),
    };
  });
}

/* ============================================================
 * 1. 账号列表
 *    GET /api/perm/user/list?page=1&size=20&deptId=D_MKT&roleId=R01&userStatus=正常
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  deptId: z.string().optional(),
  roleId: z.string().optional(),
  userStatus: z.string().optional(),
  needChangePwd: z.union([z.string(), z.boolean()]).optional(),
  /** 部门筛选是否含子部门（默认含） */
  withChild: z.union([z.string(), z.boolean()]).optional(),
});

userRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(TABLE).where('is_deleted', false);

    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('user_name', 'like', `%${q.keyword}%`)
          .orWhere('account', 'like', `%${q.keyword}%`)
          .orWhere('gw_no', 'like', `%${q.keyword}%`)
          .orWhere('phone', 'like', `%${q.keyword}%`);
      });
    }
    if (q.userStatus) query.andWhere('user_status', q.userStatus);

    if (q.needChangePwd !== undefined && q.needChangePwd !== '') {
      query.andWhere('need_change_pwd', q.needChangePwd === true || q.needChangePwd === 'true' || q.needChangePwd === '1');
    }

    if (q.deptId) {
      const withChild = !(q.withChild === false || q.withChild === 'false' || q.withChild === '0');
      if (withChild) {
        const all = await db('t_perm_dept').where('is_deleted', false).select('id', 'parent_id');
        query.whereIn('dept_id', collectDescendants(all, q.deptId));
      } else {
        query.andWhere('dept_id', q.deptId);
      }
    }

    if (q.roleId) {
      // 按职位筛选：先取该职位下的账号 id，再作为主查询条件
      const links = await db('t_perm_user_role')
        .where({ role_id: q.roleId, is_deleted: false })
        .select('user_id');
      const ids = links.map((l: any) => l.user_id);
      if (!ids.length) {
        res.json(page([], 0, q));
        return;
      }
      query.whereIn('id', ids);
    }

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = await buildUserListItems(rows);
    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 账号详情
 *    GET /api/perm/user/detail?id=U001
 * ============================================================ */

userRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    const [item] = await buildUserListItems([row]);
    res.json(ok(item));
  }),
);

/**
 * 生成一个可用的工号（GW + 4 位数字）
 *
 * ⚠️ 2026-10-16：界面不再维护「工号」（所有职位统一去掉），
 *    但 t_perm_user.gw_no 是 NOT NULL + 唯一索引（组织架构等页面仍在读它），
 *    所以新建账号时由后端自动补号，列约束与历史数据口径都不破。
 */
async function nextGwNo(): Promise<string> {
  const rows: any[] = await db(TABLE).where('gw_no', 'like', 'GW%').select('gw_no');
  let max = 1000;
  for (const r of rows) {
    const m = /^GW(\d{4})$/.exec(String(r.gw_no || ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'GW' + String(max + 1).padStart(4, '0');
}

/* ============================================================
 * 3. 新建账号
 *    POST /api/perm/user/add
 *
 * ⚠️ 不传密码时后端按当前策略生成一个，并在响应里回传（前端一次性展示）。
 * ============================================================ */

const addSchema = z.object({
  userName: z.string().min(1, '姓名必填').regex(NAME_RE, '姓名只能是汉字，且不少于 2 个字'),
  // ★ 2026-10-16：界面已去掉「工号」字段（所有职位统一），这里改为可选 ——
  //   不传就由后端自动补一个（见 nextGwNo），NOT NULL + 唯一索引都不破。
  gwNo: z.string().regex(GW_RE, '工号格式为 GW + 4 位数字，如 GW1016').optional(),
  account: z.string().min(1, '登录账号必填').regex(ACCT_RE, '登录账号为字母/数字，4-20 位'),
  phone: z.string().min(1, '手机号必填').regex(PHONE_RE, '手机号格式不正确'),
  gender: z.coerce.number().int().refine((v) => v === 1 || v === 2, '性别只能是 1(男) 或 2(女)'),
  // ★ 2026-10-19 按用户要求：账号年龄范围收紧为 20-65（与前端 validateForm 同口径）
  age: z.coerce.number().int().min(20, '年龄不得小于 20').max(65, '年龄不得大于 65'),
  deptId: z.string().min(1, '必须选择所属部门'),
  userStatus: z.string().optional(),
  roleIds: z.array(z.string()).min(1, '至少需要分配一个职位'),
  /**
   * ★ 2026-10-16：可访问模块（门户登录后能进哪几个模块）
   *   新增时必填 ≥1 —— 门户登录明确要求「至少有一个可见模块」，
   *   一个都不给 = 建出来的人登不进系统。
   */
  modules: z.array(z.string()).min(1, '请至少勾选一个可访问模块（否则该账号无法登录）'),
  password: z.string().optional(),
  needChangePwd: z.union([z.string(), z.boolean()]).optional(),
});

userRouter.post(
  '/add',
  checkPermission('perm:账号管理:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    const dupAcct = await db(TABLE).where({ account: body.account, is_deleted: false }).first();
    if (dupAcct) throw new BizError(BizCode.USER_ACCOUNT_EXISTS, `登录账号「${body.account}」已存在`);

    // ⚠️ 界面不传工号 → 后端自动生成一个可用号
    const gwNo = body.gwNo || (await nextGwNo());
    if (body.gwNo) {
      const dupGw = await db(TABLE).where({ gw_no: body.gwNo, is_deleted: false }).first();
      if (dupGw) throw new BizError(BizCode.USER_GW_EXISTS, `工号「${body.gwNo}」已存在`);
    }

    const dupPhone = await db(TABLE).where({ phone: body.phone, is_deleted: false }).first();
    if (dupPhone) throw new BizError(BizCode.USER_PHONE_EXISTS, `手机号 ${maskPhone(body.phone)} 已存在`);

    const dept = await db('t_perm_dept').where({ id: body.deptId, is_deleted: false }).first();
    if (!dept) throw new BizError(BizCode.DEPT_NOT_FOUND, '所属部门不存在');

    const roles = await db('t_perm_role').whereIn('id', body.roleIds).andWhere('is_deleted', false);
    if (roles.length !== body.roleIds.length) {
      throw new BizError(BizCode.ROLE_NOT_FOUND, '存在无效的职位，请重新选择');
    }
    const disabled = roles.filter((r: any) => r.role_status === RoleStatus.DISABLED);
    if (disabled.length) {
      throw new BizError(
        BizCode.ROLE_DISABLED,
        `职位「${disabled.map((r: any) => r.role_name).join('、')}」已停用，不可分配给账号`,
      );
    }

    const pwd = body.password || (await generatePassword());
    if (body.password) await assertPwdStrength(body.password);

    const id = randomUUID();
    const needChange = body.needChangePwd === undefined
      ? true
      : body.needChangePwd === true || body.needChangePwd === 'true' || body.needChangePwd === '1';

    await db.transaction(async (trx) => {
      await trx(TABLE).insert({
        id,
        user_name: body.userName,
        gw_no: gwNo,
        account: body.account,
        phone: body.phone,
        gender: body.gender,
        age: body.age,
        dept_id: body.deptId,
        // ⚠️ 演示阶段存明文（pwd_algo = plain）；接入登录模块后改 bcrypt
        password: pwd,
        pwd_algo: 'plain',
        user_status: body.userStatus || UserStatus.NORMAL,
        need_change_pwd: needChange,
        pwd_error_count: 0,
        is_deleted: false,
        create_time: new Date(),
        create_by: req.user?.userId || 'system',
      });

      await trx('t_perm_user_role').insert(
        body.roleIds.map((rid) => ({
          id: randomUUID(),
          user_id: id,
          role_id: rid,
          is_deleted: false,
          create_time: new Date(),
          create_by: req.user?.userId || 'system',
        })),
      );
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '新增',
      targetObj: `用户 ${body.userName}(${body.account})`,
      beforeValue: '—',
      afterValue: `职位 ${roles.map((r: any) => r.role_name).join('、')}`,
      ip: clientIp(req),
    });

    // ★ 2026-10-16：开通/同步【门户登录账号】——
    //   登录校验只读 sms_portal.t_sys_account；那边没有账号（或没有模块）就等于
    //   「建了个登不进去的人」。这里用同一个初始密码 + 勾选的模块一起开好。
    const portal = await upsertPortalAccount({
      account: body.account,
      userName: body.userName,
      password: pwd,
      phone: body.phone,
      dept: (dept as any)?.dept_name || undefined,
      modules: body.modules,
    });

    const portalMsg = portal.created
      ? '（已开通门户登录）'
      : portal.existed
        ? '（门户登录账号已同步）'
        : '（⚠️ 门户登录未开通，该账号暂时登不进系统）';

    res.json(ok({ id, password: pwd, portal }, `已创建账号${portalMsg}`));
  }),
);

/* ============================================================
 * 4. 编辑账号
 *    PUT /api/perm/user/update
 * ============================================================ */

const updateSchema = addSchema
  .extend({
    id: z.string().min(1, '必须传 id'),
    password: z.string().optional(),
    /** ★ 2026-10-16：编辑时模块可选 —— 不传 = 不动门户那边的模块 */
    modules: z.array(z.string()).optional(),
  });

userRouter.put(
  '/update',
  checkPermission('perm:账号管理:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    const dupAcct = await db(TABLE)
      .where({ account: body.account, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dupAcct) throw new BizError(BizCode.USER_ACCOUNT_EXISTS, `登录账号「${body.account}」已存在`);

    if (body.gwNo) {
      const dupGw = await db(TABLE)
        .where({ gw_no: body.gwNo, is_deleted: false })
        .whereNot('id', body.id)
        .first();
      if (dupGw) throw new BizError(BizCode.USER_GW_EXISTS, `工号「${body.gwNo}」已存在`);
    }

    const dupPhone = await db(TABLE)
      .where({ phone: body.phone, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dupPhone) throw new BizError(BizCode.USER_PHONE_EXISTS, `手机号 ${maskPhone(body.phone)} 已存在`);

    if (!body.roleIds.length) throw new BizError(BizCode.USER_NO_ROLE, '账号至少需要保留一个职位');

    const roles = await db('t_perm_role').whereIn('id', body.roleIds).andWhere('is_deleted', false);
    if (roles.length !== body.roleIds.length) {
      throw new BizError(BizCode.ROLE_NOT_FOUND, '存在无效的职位，请重新选择');
    }

    const beforeRoleNames = await db('t_perm_user_role')
      .leftJoin('t_perm_role', 't_perm_user_role.role_id', 't_perm_role.id')
      .where({ 't_perm_user_role.user_id': body.id, 't_perm_user_role.is_deleted': false })
      .select('t_perm_role.role_name');
    const beforeRolesStr = joinRoleNames(beforeRoleNames.map((x: any) => x.role_name));

    const needChange = body.needChangePwd === undefined
      ? !!exists.need_change_pwd
      : body.needChangePwd === true || body.needChangePwd === 'true' || body.needChangePwd === '1';

    // ★ 2026-10-16：编辑里填了新密码 → 事务提交后同步到门户登录表
    let pwdToSync = '';
    await db.transaction(async (trx) => {
      const patch: Record<string, unknown> = {
        user_name: body.userName,
        account: body.account,
        phone: body.phone,
        gender: body.gender,
        age: body.age,
        dept_id: body.deptId,
        user_status: body.userStatus || exists.user_status,
        need_change_pwd: needChange,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      };
      // 工号：界面已不再维护（所有职位统一去掉）—— 不传就保持库里原值不动
      if (body.gwNo) patch.gw_no = body.gwNo;
      // 编辑时留空密码 = 不修改
      if (body.password) {
        await assertPwdStrength(body.password);
        patch.password = body.password;
        pwdToSync = body.password; // ★ 待同步到门户登录表
      }
      await trx(TABLE).where({ id: body.id }).update(patch);

      // 职位：全量覆盖（先删后插）
      await trx('t_perm_user_role').where({ user_id: body.id }).del();
      await trx('t_perm_user_role').insert(
        body.roleIds.map((rid) => ({
          id: randomUUID(),
          user_id: body.id,
          role_id: rid,
          is_deleted: false,
          create_time: new Date(),
          create_by: req.user?.userId || 'system',
        })),
      );
    });

    // ★ 2026-10-16：密码 / 可访问模块 / 姓名手机号 一起同步到门户登录账号。
    //   · 改了密码 → 同步（这是用户报障的那条链路）
    //   · 只是勾了模块 → 同步模块；门户里没有这个登录名时顺手开通
    //   · 密码没改 → 绝不拿 passwordIfCreating 去覆盖已有账号的密码
    if (pwdToSync || body.modules?.length) {
      await upsertPortalAccount({
        account: body.account,
        userName: body.userName,
        phone: body.phone,
        password: pwdToSync || undefined,
        passwordIfCreating: String(exists.password || ''),
        modules: body.modules?.length ? body.modules : undefined,
      });
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `用户 ${exists.user_name}(${exists.account})`,
      beforeValue: `职位 ${beforeRolesStr || '—'}`,
      afterValue: `职位 ${roles.map((r: any) => r.role_name).join('、')}`,
      ip: clientIp(req),
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 启用 / 停用 / 锁定
 *    PUT /api/perm/user/status
 * ============================================================ */

userRouter.put(
  '/status',
  checkPermission('perm:账号管理:edit'),
  validate(
    z.object({
      id: z.string().min(1, '必须传 id'),
      userStatus: z.enum([UserStatus.NORMAL, UserStatus.DISABLED, UserStatus.LOCKED], {
        errorMap: () => ({ message: '状态只能是「正常」「已停用」「已锁定」' }),
      }),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; userStatus: UserStatus };

    const exists = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    const isAdmin = await db('t_perm_user_role')
      .leftJoin('t_perm_role', 't_perm_user_role.role_id', 't_perm_role.id')
      .where({ 't_perm_user_role.user_id': body.id, 't_perm_role.role_code': 'SYS_ADMIN' })
      .first();
    if (isAdmin && body.userStatus !== UserStatus.NORMAL) {
      throw new BizError(BizCode.PRESET_ROLE_PROTECTED, '系统管理员账号不可停用或锁定');
    }

    // ★ 2026-10-16 用户定的删除规则：账号有业务数据关联时【不可停用】
    if (body.userStatus === UserStatus.DISABLED) {
      const refs = await accountBusinessRefs(exists.account);
      if (refs.length) {
        throw new BizError(
          BizCode.USER_HAS_BUSINESS_DATA,
          `该账号存在业务数据关联（${refs.join('、')}），不可停用`,
        );
      }
    }

    await db(TABLE).where({ id: body.id }).update({
      user_status: body.userStatus,
      // 启用时顺手解锁：错误次数归零
      pwd_error_count: body.userStatus === UserStatus.NORMAL ? 0 : exists.pwd_error_count,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // ★ 2026-10-16：同步到门户登录账号 ——
    //   不然后台把人「停用」了，他照样能登进系统（门户那边只看 active）
    await setPortalAccountActive(exists.account, body.userStatus === UserStatus.NORMAL);

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `用户 ${exists.user_name}(${exists.account})`,
      beforeValue: exists.user_status,
      afterValue: body.userStatus,
      ip: clientIp(req),
    });

    res.json(ok(null, `已设置为「${body.userStatus}」`));
  }),
);

/* ============================================================
 * 6. 重置密码
 *    PUT /api/perm/user/reset-pwd   body: { userId, newPassword?, needChangePwd? }
 * ============================================================ */

userRouter.put(
  '/reset-pwd',
  checkPermission('perm:账号管理:resetPwd'),
  validate(
    z.object({
      userId: z.string().min(1, '必须传 userId'),
      newPassword: z.string().optional(),
      needChangePwd: z.union([z.string(), z.boolean()]).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      userId: string;
      newPassword?: string;
      needChangePwd?: string | boolean;
    };

    const exists = await db(TABLE).where({ id: body.userId, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    const newPassword = body.newPassword || (await generatePassword());
    if (body.newPassword) await assertPwdStrength(body.newPassword);

    const needChange = body.needChangePwd === undefined
      ? true
      : body.needChangePwd === true || body.needChangePwd === 'true' || body.needChangePwd === '1';

    await db(TABLE).where({ id: body.userId }).update({
      password: newPassword,
      pwd_algo: 'plain',
      need_change_pwd: needChange,
      pwd_error_count: 0,
      user_status: exists.user_status === UserStatus.LOCKED ? UserStatus.NORMAL : exists.user_status,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `用户 ${exists.user_name}(${exists.account})`,
      beforeValue: '原密码',
      afterValue: needChange ? '已重置，需首次登录修改' : '已重置',
      ip: clientIp(req),
    });

    // ★ 2026-10-16：同步到门户登录表 —— 不然后台重置完密码，本人还是登不进系统
    const portalSynced = await syncPortalPassword(exists.account, newPassword);

    res.json(
      ok(
        { newPassword, portalSynced },
        portalSynced ? '密码已重置' : '密码已重置（该登录名在门户无账号，暂时无法登录系统）',
      ),
    );
  }),
);

/* ============================================================
 * 7. 解锁
 *    PUT /api/perm/user/unlock   body: { id }
 * ============================================================ */

userRouter.put(
  '/unlock',
  checkPermission('perm:账号管理:edit'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    await db(TABLE).where({ id }).update({
      pwd_error_count: 0,
      user_status: UserStatus.NORMAL,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // ★ 2026-10-16：解锁 = 状态回到「正常」→ 门户登录账号也要跟着启用
    await setPortalAccountActive(exists.account, true);

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `用户 ${exists.user_name}(${exists.account})`,
      beforeValue: exists.user_status,
      afterValue: '已解锁',
      ip: clientIp(req),
    });

    res.json(ok(null, '已解锁'));
  }),
);

/* ============================================================
 * 8. 删除账号（逻辑删除）
 *    DELETE /api/perm/user/delete/:id
 * ============================================================ */

userRouter.delete(
  '/delete/:id',
  checkPermission('perm:账号管理:edit'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const exists = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在或已被删除');

    const isAdmin = await db('t_perm_user_role')
      .leftJoin('t_perm_role', 't_perm_user_role.role_id', 't_perm_role.id')
      .where({ 't_perm_user_role.user_id': id, 't_perm_role.role_code': 'SYS_ADMIN' })
      .first();
    if (isAdmin) throw new BizError(BizCode.PRESET_ROLE_PROTECTED, '系统管理员账号不可删除');

    // ★ 2026-10-16 用户定的删除规则：账号有业务数据关联时【不可删除】
    const bizRefs = await accountBusinessRefs(exists.account);
    if (bizRefs.length) {
      throw new BizError(
        BizCode.USER_HAS_BUSINESS_DATA,
        `该账号存在业务数据关联（${bizRefs.join('、')}），不可删除`,
      );
    }

    // ★ 2026-10-16：后缀两处共用（权限库 + 门户库），
    //   两边同步改名，唯一键都腾出来给以后复用
    const suffix = `#DEL#${Date.now()}`;

    await db.transaction(async (trx) => {
      // 释放唯一键：账号/工号/手机号加了唯一索引，不改则无法复用
      await trx(TABLE).where({ id }).update({
        account: `${exists.account}${suffix}`.slice(0, 50),
        gw_no: `${exists.gw_no}${suffix}`.slice(0, 20),
        phone: `${exists.phone}${suffix}`.slice(0, 20),
        is_deleted: true,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      await trx('t_perm_user_role').where({ user_id: id }).update({
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
      targetObj: `用户 ${exists.user_name}(${exists.account})`,
      beforeValue: `存在，状态 ${exists.user_status}`,
      afterValue: '已删除',
      ip: clientIp(req),
    });

    // ★ 2026-10-16：门户登录账号一并作废（改名 + 逻辑删除 + 停用）——
    //   不然后台把人删了，他还能登录门户（只是进去什么都看不到）
    await retirePortalAccount(exists.account, `${exists.account}${suffix}`.slice(0, 50));

    res.json(ok(null, '删除成功（门户登录账号已作废）'));
  }),
);

/* ============================================================
 * 9. 账号 KPI（5 个）
 *    GET /api/perm/user/overview
 * ============================================================ */

userRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const [all, normal, disabled, locked, needChange] = await Promise.all([
      db(TABLE).where('is_deleted', false).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, user_status: UserStatus.NORMAL }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, user_status: UserStatus.DISABLED }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, user_status: UserStatus.LOCKED }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, need_change_pwd: true }).count({ n: '*' }),
    ]);

    res.json(
      ok({
        userTotal: Number(all[0]?.n || 0),
        normalTotal: Number(normal[0]?.n || 0),
        disabledTotal: Number(disabled[0]?.n || 0),
        lockedTotal: Number(locked[0]?.n || 0),
        needChangePwdTotal: Number(needChange[0]?.n || 0),
      }),
    );
  }),
);

/* ============================================================
 * 10. 账号鉴权档案（跨模块：登录模块调用）
 *     GET /api/perm/user/auth-profile?account=admin
 *
 * ⚠️ 这个接口【不加 checkPermission】—— 它是给登录流程用的，
 *    调用者此时还没有 token。
 * ⚠️ 也【不返回密码】。密码校验由登录模块拿 auth-profile 后自行比对
 *    （或后续把校验逻辑收敛到本模块的 /verify-pwd）。
 * ============================================================ */

userRouter.get(
  '/auth-profile',
  validate(z.object({ account: z.string().min(1, '必须传 account') })),
  wrap(async (req, res) => {
    const { account } = (req as any).validated as { account: string };

    const row = await db(TABLE).where({ account, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.USER_NOT_FOUND, '账号不存在');

    const dept = row.dept_id ? await db('t_perm_dept').where({ id: row.dept_id }).first() : null;

    const links = await db('t_perm_user_role').where({ user_id: row.id, is_deleted: false });
    const roleIds = links.map((l: any) => l.role_id);
    const roles = roleIds.length
      ? await db('t_perm_role').whereIn('id', roleIds).andWhere('is_deleted', false)
      : [];

    const { permissions, dataScope } = await getUserEffectivePerms(row.id);

    res.json(
      ok({
        userId: row.id,
        userName: row.user_name,
        account: row.account,
        deptId: row.dept_id,
        deptName: dept?.dept_name || '—',
        userStatus: row.user_status,
        roles: roles.map((r: any) => r.role_code),
        roleIds,
        roleNames: roles.map((r: any) => r.role_name),
        roleTypes: roles.map((r: any) => r.role_type as RoleType),
        permissions,
        dataScope,
        needChangePwd: !!row.need_change_pwd,
      }),
    );
  }),
);

export default userRouter;
