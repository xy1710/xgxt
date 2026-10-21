/**
 * 账号服务（系统管理员创建，各岗位登录）
 *
 * ⚠️ 权限模型说明（本模块是简化版，正式应由权限模块 8006 接管）：
 *    账号 → 岗位角色（admin/manager/consult/finance）→ 可见菜单 + 可执行操作
 *
 *    菜单可见性规则：
 *      admin   → 账号管理
 *      manager → 全部（学生/收款/审批中心/退费/流失）
 *      consult → 学生/收款/退费（只看自己名下）/流失
 *      finance → 收款（确认到账/驳回）/退费（打款）/审批中心仅看退费
 *
 * ⚠️ 密码：演示环境明文存。正式环境必须换 bcrypt。
 */

import { randomUUID } from 'crypto';
import { BizCode, ConsultRole, CONSULT_ROLE_NAME, CONSULT_ROLE_DESC } from 'shared-types/consult';
import type { ConsultAccount, ConsultAccountStats, ConsultLoginResult } from 'shared-types/consult';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { signToken } from '../utils/jwt';
import type { JwtPayload } from '../utils/jwt';
import { buildFallbackPayload } from '../middleware/auth';
import { fetchAuthProfile } from './perm.client';
// ★ 2026-10-06：咨询老师候选改为「门户账号 × sms_perm 角色」为首选数据源
import { consultantsFromAccounts } from './perm-roles';
import { formatTime } from './student.service';

export const ACCOUNT_TABLE = 't_consult_account';

/* ============================================================
 * 菜单定义
 * ============================================================ */

/** 菜单 key 与标题 */
export const MENU_ITEMS: Array<{ key: string; title: string; path: string }> = [
  { key: 'student', title: '学生管理', path: '/student' },
  { key: 'fee', title: '收款与缴费', path: '/fee' },
  { key: 'approve', title: '审批中心', path: '/approve' },
  { key: 'refund', title: '退费管理', path: '/refund' },
  { key: 'loss', title: '流失记录', path: '/loss' },
  // ⚠️⚠️ 2026-10-03 用户指令：
  //   「账号管理和权限管理内的账号管理是同一个功能，权限管理内的账号管理是唯一的，
  //     账号管理删除，功能一致。」
  //   → 本模块原有的 account（账号管理）菜单项已删除，
  //     账号维护统一收敛到【权限管理模块 → 账号管理】。
  //
  //   ⚠️ 注意：t_consult_account 表本身【保留不动】——
  //     它仍然是本模块判定「谁能登录咨询模块、是什么岗位角色」的依据
  //     （login() 仍然查这张表），删掉的只是【前端维护入口 + 目录树菜单项】。
];

/** 各角色可见的菜单 */
const ROLE_MENUS: Record<string, string[]> = {
  // ⚠️ 管理员 = 全模块总览（按用户要求「对应角色能查看对应模块的所有内容」）
  [ConsultRole.ADMIN]: ['student', 'fee', 'approve', 'refund', 'loss'],
  [ConsultRole.MANAGER]: ['student', 'fee', 'approve', 'refund', 'loss'],
  [ConsultRole.CONSULT]: ['student', 'fee', 'refund', 'loss'],
};

/**
 * ⭐ 全部菜单（系统管理员的兜底口径）
 *
 * ⚠️ 2026-10-03 用户指令：「将系统管理员的权限设置为最高，所有页面都可以访问」
 *
 * 只有当 t_consult_account 里确实没有这个账号时才会走到这里。
 * 场景：门户的系统管理员（如 admin）在咨询库中没有同名岗位记录。
 * 这种情况下不应该让他「一片空白」，而是按最高权限给全部页面。
 */
const ALL_MENUS: string[] = MENU_ITEMS.map((m) => m.key);

/**
 * 取菜单 key
 *
 * @param role  本模块岗位角色（可能为空 —— 门户账号在咨询库中无记录）
 * @param input 可选：传入 { isSysAdmin } 时，系统管理员直接全开
 */
export function menusOf(role: string, input?: { isSysAdmin?: boolean }): string[] {
  if (input?.isSysAdmin) return ALL_MENUS;
  return ROLE_MENUS[role] || ALL_MENUS;
}

/* ============================================================
 * 行 → 视图
 * ============================================================ */

export function toAccountView(row: any, withPassword = false): ConsultAccount {
  return {
    accountId: row.id,
    account: row.account,
    // ⚠️ 演示环境才返回密码（列表页要展示）。正式环境删掉这一行。
    password: withPassword ? row.password : undefined,
    userName: row.user_name,
    roleTitle: row.role_title || CONSULT_ROLE_NAME[row.role] || '',
    role: row.role,
    dept: row.dept || undefined,
    phone: row.phone || undefined,
    active: !!row.active,
    createdByName: row.create_by_name || undefined,
    createTime: formatTime(row.create_time),
    lastLogin: row.last_login ? formatTime(row.last_login) : undefined,
  };
}

/* ============================================================
 * 登录
 * ============================================================ */

/**
 * 登录
 *
 * ⭐ 按《三方操作清单-角色编码统一-20261002》第三节：
 *    登录时调权限模块 8006 取「权限档案」，把这 4 个字段写进 token：
 *      userId / roles / permissions / dataScope
 *    这样各业务模块（含实训 8004）从 token 里就能解出角色与权限。
 *
 * ⚠️ 降级策略（关键）：
 *    权限模块没连上时【不能让用户登不进来】，而是用本模块账号表里的岗位角色
 *    造一份「本地兜底权限」签发 token，并在 token 里标记 degraded:true。
 *    前端看到这个标记会提示「权限模块未连接，当前为本地兜底权限」。
 *
 * ⚠️ token 形态：JWT（HS256），payload 含上述 4 字段 + 本模块补充字段。
 */
export async function login(account: string, password: string): Promise<ConsultLoginResult> {
  const row = await db(ACCOUNT_TABLE).where({ account, is_deleted: false }).first();

  if (!row) {
    throw new BizError(BizCode.LOGIN_FAILED, '账号或密码错误');
  }
  if (row.password !== password) {
    throw new BizError(BizCode.LOGIN_FAILED, '账号或密码错误');
  }
  if (!row.active) {
    throw new BizError(
      BizCode.ACCOUNT_DISABLED,
      '该账号已停用，无法登录。请联系系统管理员恢复。',
    );
  }

  // 更新最近登录时间
  await db(ACCOUNT_TABLE).where({ id: row.id }).update({ last_login: new Date() });

  // ---- ⭐ 调权限模块取权限档案（拿不到就降级）----
  const perm = await fetchAuthProfile(row.account);

  let payload: JwtPayload;
  let permDegraded = false;
  let permTip = '';

  if (perm.profile) {
    // ① 正常路径：权限模块给了档案 → 用它的 4 个字段
    payload = {
      userId: perm.profile.userId,
      roles: perm.profile.roles,
      permissions: perm.profile.permissions,
      dataScope: perm.profile.dataScope,
      userName: perm.profile.userName || row.user_name,
      accountId: row.id,
      account: row.account,
      consultRole: row.role,
      degraded: false,
    };
  } else {
    // ② 降级路径：权限模块没连上（或账号不在权限库里）→ 本地兜底
    payload = buildFallbackPayload(row);
    permDegraded = true;
    permTip = perm.notFound
      ? '权限模块中未找到该账号的档案，当前使用本地兜底权限。'
      : perm.degradeReason || '权限模块暂时不可用，当前使用本地兜底权限。';
  }

  const token = signToken(payload);

  return {
    token,
    account: toAccountView(row, true),
    menuKeys: menusOf(row.role),
    // ⭐ 让前端知道是否走了降级（可选字段，老前端忽略即可）
    permDegraded,
    permTip: permTip || undefined,
  };
}

/** 按 token（accountId）取账号 —— 中间件用 */
export async function findByToken(token: string): Promise<any | null> {
  if (!token) return null;
  return db(ACCOUNT_TABLE).where({ id: token, is_deleted: false, active: true }).first();
}

/**
 * ⭐ 按「登录名或 ID」取账号 —— 兼容统一门户签发的 token
 *
 * ⚠️⚠️ 为什么需要这个（2026-10-02 门户改造）：
 *    本模块的 accountId 与门户的 accountId 是【两个不同的主键】：
 *      · 本模块自己登录 → accountId = t_consult_account.id
 *      · 统一门户登录   → accountId = t_sys_account.id
 *    所以只按 id 查会查空。这里加一层「查不到就用登录名再查」，
 *    保证从门户进来的人也能正确解出本模块的角色与菜单。
 *
 * @param accountId token 里的 accountId（可能是门户的）
 * @param account   登录名（门户 token 里一定有）
 */
export async function findByTokenOrAccount(
  accountId: string | undefined,
  account: string | undefined,
): Promise<any | null> {
  if (accountId) {
    const byId = await db(ACCOUNT_TABLE)
      .where({ id: accountId, is_deleted: false, active: true })
      .first();
    if (byId) return byId;
  }
  if (account) {
    return db(ACCOUNT_TABLE)
      .where({ account, is_deleted: false, active: true })
      .first();
  }
  return null;
}

/* ============================================================
 * 增删改查
 * ============================================================ */

/** 新增账号 */
export async function addAccount(
  payload: {
    account: string;
    password: string;
    userName: string;
    role: ConsultRole;
    dept?: string;
    phone?: string;
  },
  operator: { name: string },
): Promise<{ accountId: string }> {
  const exists = await db(ACCOUNT_TABLE)
    .where({ account: payload.account, is_deleted: false })
    .first();
  if (exists) {
    throw new BizError(BizCode.ACCOUNT_EXISTS, `登录账号「${payload.account}」已存在，请换一个`);
  }

  const id = randomUUID();
  await db(ACCOUNT_TABLE).insert({
    id,
    account: payload.account,
    password: payload.password,
    user_name: payload.userName,
    role: payload.role,
    role_title: CONSULT_ROLE_NAME[payload.role] || payload.role,
    dept: payload.dept || null,
    phone: payload.phone || null,
    active: true,
    create_time: new Date(),
    create_by: operator.name,
    create_by_name: operator.name,
    is_deleted: false,
  });

  return { accountId: id };
}

/** 修改账号 */
export async function updateAccount(
  id: string,
  payload: {
    userName?: string;
    role?: ConsultRole;
    dept?: string;
    phone?: string;
    password?: string;
  },
  operator: { name: string },
): Promise<void> {
  const row = await db(ACCOUNT_TABLE).where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.ACCOUNT_NOT_FOUND, '账号不存在');

  const patch: Record<string, any> = {
    update_time: new Date(),
    update_by: operator.name,
  };
  if (payload.userName) patch.user_name = payload.userName;
  if (payload.role) {
    patch.role = payload.role;
    patch.role_title = CONSULT_ROLE_NAME[payload.role] || payload.role;
  }
  if (payload.dept !== undefined) patch.dept = payload.dept || null;
  if (payload.phone !== undefined) patch.phone = payload.phone || null;
  if (payload.password) patch.password = payload.password;

  await db(ACCOUNT_TABLE).where({ id }).update(patch);
}

/** 重置密码 */
export async function resetPassword(
  id: string,
  newPassword: string,
  operator: { name: string },
): Promise<void> {
  const row = await db(ACCOUNT_TABLE).where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.ACCOUNT_NOT_FOUND, '账号不存在');

  await db(ACCOUNT_TABLE).where({ id }).update({
    password: newPassword,
    update_time: new Date(),
    update_by: operator.name,
  });
}

/** 启用/停用 */
export async function toggleActive(
  id: string,
  active: boolean,
  operator: { name: string },
): Promise<void> {
  const row = await db(ACCOUNT_TABLE).where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.ACCOUNT_NOT_FOUND, '账号不存在');

  // 不允许停用自己（会导致自己立刻掉线且无法恢复）
  if (row.account === operator.name) {
    throw new BizError(BizCode.INVALID_STATUS, '不能停用当前登录的账号');
  }

  await db(ACCOUNT_TABLE).where({ id }).update({
    active,
    update_time: new Date(),
    update_by: operator.name,
  });
}

/** 逻辑删除账号 */
export async function removeAccount(id: string, operator: { name: string }): Promise<void> {
  const row = await db(ACCOUNT_TABLE).where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.ACCOUNT_NOT_FOUND, '账号不存在');

  if (row.account === 'admin') {
    throw new BizError(BizCode.INVALID_STATUS, '系统管理员账号不可删除');
  }

  await db(ACCOUNT_TABLE).where({ id }).update({
    is_deleted: true,
    update_time: new Date(),
    update_by: operator.name,
  });
}

/** 构造查询 */
export function buildAccountQuery(q: any) {
  const query = db(ACCOUNT_TABLE).where('is_deleted', false);
  if (q.userName) query.andWhere('user_name', 'like', `%${q.userName}%`);
  if (q.account) query.andWhere('account', 'like', `%${q.account}%`);
  if (q.role) query.andWhere('role', q.role);
  if (q.active !== undefined && q.active !== null && q.active !== '') {
    query.andWhere('active', q.active === true || q.active === 'true' || q.active === 1 || q.active === '1');
  }
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('user_name', 'like', `%${q.keyword}%`)
        .orWhere('account', 'like', `%${q.keyword}%`)
        .orWhere('phone', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/** 账号统计 */
export async function getAccountStats(q: any = {}): Promise<ConsultAccountStats> {
  const rows: any[] = await buildAccountQuery(q).select('role', 'active');
  return {
    total: rows.length,
    active: rows.filter((r) => r.active).length,
    inactive: rows.filter((r) => !r.active).length,
    adminCount: rows.filter((r) => r.role === ConsultRole.ADMIN).length,
    managerCount: rows.filter((r) => r.role === ConsultRole.MANAGER).length,
    consultCount: rows.filter((r) => r.role === ConsultRole.CONSULT).length,
  };
}

/**
 * 取咨询老师候选（分配跟进人用）
 *
 * 【口径（2026-10-06 用户拍板）】
 *   「选择角色时，选项要来自系统内账户所对应的角色」
 *     ① 首选：`sms_portal.t_sys_account × sms_perm`（谁是咨询经理/咨询师，唯一事实来源）
 *     ② 兜底：本模块自己的 `t_consult_account`（老数据 / 权限库不可用时）
 *
 * 【原来错在哪】
 *   只查 `t_consult_account`。2026-10-06 全量重建把业务库清空后这张表为空
 *   → 下拉永远「无数据」（用户截图反馈）；连带的还有：经理被降级成咨询师。
 *
 * 【返回结构】前端 el-select 读 `id / name / title`，同时保留 `userName` 兼容旧调用。
 *   分配接口按 `ownerName` 落库，所以 `name` 必须就是姓名。
 */
export async function listConsultants(): Promise<
  Array<{ id: string; name: string; userName: string; title: string; count: number }>
> {
  /** 内部统一结构（id 允许为空串：老数据没有门户账号 id） */
  type Cand = { id: string; name: string; title: string };

  let cands: Cand[] = (await consultantsFromAccounts()).map((c) => ({
    id: c.id,
    name: c.userName,
    // 门户账号的 title 更准（「市场咨询经理」/「咨询师」），优先用它
    title: c.title || CONSULT_ROLE_NAME[c.role] || '',
  }));

  // 首选源为空 → 回落到本模块账号表
  if (!cands.length) {
    const rows: any[] = await db(ACCOUNT_TABLE)
      .where({ is_deleted: false, active: true })
      .whereIn('role', [ConsultRole.CONSULT, ConsultRole.MANAGER])
      .select('id', 'user_name', 'role', 'role_title');
    cands = rows.map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.user_name ?? ''),
      title: r.role_title || CONSULT_ROLE_NAME[r.role] || '',
    }));
  }

  // 去重（同名只留一条）并补「名下学生数」
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string; userName: string; title: string; count: number }> = [];
  for (const c of cands) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    const countRow: any = await db('t_consult_student')
      .where({ owner_name: c.name, is_deleted: false })
      .count({ c: '*' })
      .first();
    out.push({
      id: c.id,
      name: c.name,
      userName: c.name,
      title: c.title,
      count: Number(countRow?.c || 0),
    });
  }
  return out;
}
