/**
 * ⭐ 统一账号服务（门户）
 *
 * ⚠️⚠️ 2026-10-02：全系统「一个账号表管跨模块角色」
 *
 * 设计：
 *    t_sys_account —— 统一账号表
 *      一个账号通过 modules 字段声明「能进哪些模块」
 *        系统管理员 → ['consult','finance']（全部）
 *        咨询负责人 → ['consult']
 *        财务负责人 → ['finance']
 *
 *    登录后签发含 modules 的 JWT，门户据此渲染目录树，
 *    各业务模块据此判断「这人能不能进我这儿」。
 *
 * ⚠️ 密码：演示环境明文存。正式环境必须换 bcrypt。
 */

import { randomUUID } from 'crypto';
import {
  BizCode,
  ModuleKey,
  MODULES,
  AccountKind,
  ModuleDef,
} from 'shared-types/portal';
import type { SysAccount, PortalLoginResult } from 'shared-types/portal';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { signToken } from '../utils/jwt';
import type { JwtPayload } from '../utils/jwt';

export const ACCOUNT_TABLE = 't_sys_account';

/** 密码策略视图（给改密弹窗做提示 + 前端预校验用） */
export interface PwdPolicyView {
  /** 最小长度 */
  min: number;
  /** 需包含大写字母 */
  upper: boolean;
  /** 需包含数字 */
  digit: boolean;
  /** 需包含特殊符号 */
  symbol: boolean;
  /** 人话版规则文案，例：不少于 8 位，且需包含大写字母、数字 */
  tip: string;
}

/* ============================================================
 * 行 → 视图
 * ============================================================ */

/** 解析 modules 列（库里存 JSON 字符串或逗号分隔） */
function parseModules(raw: any): ModuleKey[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ModuleKey[];
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr)) return arr as ModuleKey[];
  } catch {
    // 退回逗号分隔
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as ModuleKey[];
}

export function toAccountView(row: any, withPassword = false): SysAccount {
  return {
    accountId: row.id,
    account: row.account,
    userName: row.user_name,
    // ⚠️ 演示环境才返回密码。正式环境必须传 false。
    password: withPassword ? row.password : undefined,
    kind: row.kind as AccountKind,
    title: row.title || undefined,
    dept: row.dept || undefined,
    phone: row.phone || undefined,
    modules: parseModules(row.modules),
    active: !!row.active,
    lastLogin: row.last_login ? fmt(row.last_login) : undefined,
    createTime: row.create_time ? fmt(row.create_time) : undefined,
  };
}

function fmt(d: any): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

/* ============================================================
 * 可见模块
 * ============================================================ */

/**
 * ⭐ 取该账号可见的模块（含各自页面）
 *
 * ⚠️ 系统管理员 = 全部模块；模块负责人 = 只看 modules 里声明的。
 *    这里统一按 modules 字段过滤，管理员在数据层就存了全部模块，
 *    所以不需要额外特判 —— 规则单一，少一处出错的地方。
 */
export function visibleModulesOf(account: SysAccount): ModuleDef[] {
  return MODULES.filter((m) => account.modules.includes(m.key));
}

/**
 * 建议落地路径
 * ★ 2026-10-16 用户指令：「将工作台放置首页，每个角色进来第一个页面就是工作台」
 *   → 所有角色（含原先返回空串的 legacy 模块账号）统一落到 '/' 工作台首页。
 *     前端 Login.vue 拿到后 router.replace，无任何角色特判。
 */
export function landingPathOf(_account: SysAccount): string {
  return '/';
}

/* ============================================================
 * 登录
 * ============================================================ */

export async function login(account: string, password: string): Promise<PortalLoginResult> {
  const row = await db(ACCOUNT_TABLE).where({ account, is_deleted: false }).first();

  if (!row) throw new BizError(BizCode.LOGIN_FAILED, '账号或密码错误');
  if (row.password !== password) throw new BizError(BizCode.LOGIN_FAILED, '账号或密码错误');
  if (!row.active) {
    throw new BizError(
      BizCode.ACCOUNT_DISABLED,
      '该账号已停用，无法登录。请联系系统管理员恢复。',
    );
  }

  await db(ACCOUNT_TABLE).where({ id: row.id }).update({ last_login: new Date() });

  const view = toAccountView(row, false);
  const visibleModules = visibleModulesOf(view);

  if (visibleModules.length === 0) {
    throw new BizError(BizCode.NO_MENU_PERMISSION, '该账号未分配任何模块权限，请联系系统管理员');
  }

  // ⭐ 签发含 modules 的 JWT —— 各业务模块验签后可解出「这人能进哪些模块」
  const payload: JwtPayload = {
    userId: row.id,
    // 三方清单口径：角色用统一新编码
    roles: [view.kind === AccountKind.SYS_ADMIN ? 'SYS_ADMIN' : 'SYS_STAFF'],
    permissions: view.kind === AccountKind.SYS_ADMIN ? ['*'] : [`module:${view.modules.join(',')}`],
    dataScope: view.kind === AccountKind.SYS_ADMIN ? 4 : 3,
    // ⭐ 门户扩展
    modules: view.modules,
    kind: view.kind,
    userName: view.userName,
    accountId: row.id,
    account: row.account,
    degraded: false,
  };

  return {
    token: signToken(payload),
    account: view,
    visibleModules,
    landingPath: landingPathOf(view),
  };
}

/** 按 token（accountId）取账号 —— 中间件用 */
export async function findById(id: string): Promise<any | null> {
  if (!id) return null;
  return db(ACCOUNT_TABLE).where({ id, is_deleted: false }).first();
}

/* ============================================================
 * ⭐ 2026-10-15 新增：登录人【自助修改密码】
 *
 * 需求（用户原话）：
 *   「在顶栏加一个重置密码的按钮，每个角色登录进去都能看到并修改；
 *     弹窗先输旧密码，旧密码正确后才能输新密码，再确认一遍新密码，
 *     两次一致才能改成功。」
 *
 * 设计要点：
 *   ① 只要「登录了」就能改自己的密码 —— 不校验模块/权限点，
 *      所以校长、班主任、教务、咨询、财务、权限管理员全都能用。
 *   ② 旧密码必须由后端复核（前端那一步只是为了交互流畅），
 *      改密接口里再验一次，防止前端跳过验证直接提交。
 *   ③ 演示环境密码是明文存储（与登录同口径），这里保持一致；
 *      正式环境换成 bcrypt 时，只需改本文件这三处比较/写入。
 * ============================================================ */

/**
 * 取当前生效的密码策略（供改密弹窗提示 + 前端预校验）
 *
 * ⚠️ 策略的单一事实来源在权限管理的 t_perm_rule（perm/services/pwdPolicy.ts），
 *    门户侧只做转发，**不再定义第二份规则** —— 本次 bug 的根因就是两份规则漂移。
 */
export async function getPwdPolicy(): Promise<PwdPolicyView> {
  const { loadPwdRule, describePwdRule } = await import('../../perm/services/pwdPolicy');
  const [rule, tip] = await Promise.all([loadPwdRule(), describePwdRule()]);
  return { min: rule.min, upper: rule.upper, digit: rule.digit, symbol: rule.symbol, tip };
}

/**
 * 新密码规则
 *
 * ★ 2026-10-19 修复：原来这里写死了「6~20 位、不含空格、不能与原密码相同」，
 *   与账号管理那套密码策略（t_perm_rule：≥8 位 + 含大写字母 + 含数字）**不是同一份**，
 *   于是出现「规则要求含大写字母，但用户全小写一样能改成功」。
 *   现在强度判定统一走 assertPwdStrength（读同一份策略），
 *   本函数只补策略管不到的三条：长度上限、不含空格、不能与原密码相同。
 *
 * ⚠️ 策略读取用【动态 import】：门户与权限是两个库，
 *    不能让「权限库暂时连不上」把用户改自己密码的入口整个拖死
 *    （pwdPolicy.loadPwdRule 读不到时回退默认策略，不会抛错）。
 */
export async function assertNewPassword(newPassword: string, oldPassword?: string): Promise<void> {
  const p = String(newPassword ?? '');

  // ① 强度：与「账号管理 → 新增账号 / 重置密码」完全同一口径
  const { assertPwdStrength } = await import('../../perm/services/pwdPolicy');
  await assertPwdStrength(p);

  // ② 策略之外的补充规则
  if (p.length > 20) {
    throw new BizError(BizCode.PARAM_ERROR, '新密码不超过 20 位');
  }
  if (/\s/.test(p)) {
    throw new BizError(BizCode.PARAM_ERROR, '新密码不能包含空格');
  }
  if (oldPassword !== undefined && p === oldPassword) {
    throw new BizError(BizCode.PARAM_ERROR, '新密码不能与原密码相同');
  }
}

/**
 * 校验「本人原密码」
 *
 * ⚠️ 密码错用 PARAM_ERROR（HTTP 200 + 业务码）而不是 401：
 *    401 会让前端拦截器判定「登录过期」并把人踢回登录页 —— 只是输错一次密码，不至于。
 */
export async function verifyOwnPassword(accountId: string, password: string): Promise<any> {
  const row = await db(ACCOUNT_TABLE).where({ id: accountId, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.UNAUTHORIZED, '账号不存在或已删除，请重新登录', 401);
  if (String(row.password ?? '') !== String(password ?? '')) {
    throw new BizError(BizCode.PARAM_ERROR, '原密码不正确，请重新输入');
  }
  return row;
}

/**
 * 修改本人密码
 *
 * @returns 是否顺带同步了「权限管理 → 账号管理」里的同名账号
 */
export async function changeOwnPassword(
  accountId: string,
  oldPassword: string,
  newPassword: string,
): Promise<boolean> {
  const row = await verifyOwnPassword(accountId, oldPassword);
  // ★ 2026-10-19：assertNewPassword 现在要读策略，改成 await
  await assertNewPassword(newPassword, oldPassword);

  await db(ACCOUNT_TABLE).where({ id: accountId }).update({
    password: newPassword,
    update_time: new Date(),
    update_by: accountId,
  });

  // 顺手把「权限管理 → 账号管理」（sms_perm.t_perm_user）里同登录名的密码对齐，
  // 否则管理员在那个页面上看到的还是旧密码。失败不影响改密结果。
  return syncPermUserPassword(row.account, newPassword);
}

/**
 * 同步同名业务账号的密码（best-effort）
 *
 * ⚠️ 门户账号库（sms_portal）与权限库（sms_perm）是两套库，
 *    这里用动态 import 拿权限库的连接，避免把两个模块的依赖在文件顶部硬绑死；
 *    查不到（如该账号只有门户账号、没有业务档案）或库暂时连不上，都直接返回 false。
 */
async function syncPermUserPassword(account: string, newPassword: string): Promise<boolean> {
  if (!account) return false;
  try {
    const { db: permDb } = await import('../../perm/utils/db');
    const affected = await permDb('t_perm_user')
      .where({ account, is_deleted: false })
      .update({
        password: newPassword,
        pwd_algo: 'plain',
        need_change_pwd: false,
        pwd_error_count: 0,
        update_time: new Date(),
      });
    return Number(affected) > 0;
  } catch {
    return false;
  }
}
