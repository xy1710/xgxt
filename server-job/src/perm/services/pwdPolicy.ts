/**
 * 密码策略（单一事实来源）
 *
 * 提供方：权限管理（林晓）
 *
 * ⚠️ 为什么要有这个文件？
 *    密码规则原来散在【三处】，其中两处读库、一处硬编码：
 *      ① perm/routes/user.route.ts 的 assertPwdStrength —— 账号新增 / 编辑 / 重置密码
 *      ② perm/routes/option.route.ts 的 buildPwdTip    —— 界面上那句策略提示文案
 *      ③ portal/services/account.service.ts 的 assertNewPassword —— 顶栏「修改密码」（自助改密）
 *    ①② 都读 t_perm_rule，③ 却是另一套写死的「6~20 位、不含空格、不能与原密码相同」。
 *    后果：规则明明要求含大写字母，用户自助改密时全小写照样改成功。
 *    现在统一到这里 —— 策略从 t_perm_rule 读一次，判定与文案都基于同一份。
 *
 * ⚠️ 读不到策略时【回退到 PWD_FALLBACK】而不是抛错：
 *    自助改密是「用户被挡在系统门外」时的救命入口，不能因为权限库/规则表暂时不可用
 *    （sms_perm 未初始化、连接抖动）就连自己的密码都改不了。
 *    回退值与 t_perm_rule 的种子值一致（见 rule.route.ts 的 DEFAULTS）。
 */

import { BizCode } from 'shared-types/perm';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';

/** 密码策略（pwd 组） */
export interface PwdRule {
  /** 最小长度 */
  min: number;
  /** 要求包含大写字母 */
  upper: boolean;
  /** 要求包含数字 */
  digit: boolean;
  /** 要求包含特殊符号 */
  symbol: boolean;
  /** 密码有效期（天），0 = 永久 */
  expireDays: number;
  /** 强制首次登录修改密码 */
  forceFirst: boolean;
  /** 密码错误锁定次数 */
  retry: number;
  /** 锁定时长（分钟），0 = 永久锁定 */
  lockMin: number;
}

/** 兜底策略（= t_perm_rule 的种子值）：不少于 8 位 + 含大写字母 + 含数字，不要求特殊符号 */
export const PWD_FALLBACK: PwdRule = {
  min: 8,
  upper: true,
  digit: true,
  symbol: false,
  expireDays: 90,
  forceFirst: true,
  retry: 5,
  lockMin: 30,
};

/**
 * 布尔解析
 * ⚠️ 金库里统一按字符串存，且**可能大小写不一**（'true' / 'True' / '1'），
 *    这里统一小写后判断，避免「页面上开着、代码里当 false」。
 */
const asBool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === null || v === '' ? dflt : ['true', '1', 'on', 'yes'].includes(String(v).toLowerCase());

const asNum = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : dflt;
};

/** 读取当前生效的密码策略（任何异常都回退到 PWD_FALLBACK） */
export async function loadPwdRule(): Promise<PwdRule> {
  try {
    const rows = await db('t_perm_rule').where({ rule_group: 'pwd', is_deleted: false });
    const raw: Record<string, string> = {};
    rows.forEach((r: any) => {
      raw[r.rule_key] = r.rule_value;
    });
    // 规则表为空（没跑种子脚本）→ 用兜底值，不当成「无任何限制」
    if (!Object.keys(raw).length) return { ...PWD_FALLBACK };
    return {
      min: asNum(raw.min, PWD_FALLBACK.min),
      upper: asBool(raw.upper, PWD_FALLBACK.upper),
      digit: asBool(raw.digit, PWD_FALLBACK.digit),
      symbol: asBool(raw.symbol, PWD_FALLBACK.symbol),
      expireDays: asNum(raw.expireDays, PWD_FALLBACK.expireDays),
      forceFirst: asBool(raw.forceFirst, PWD_FALLBACK.forceFirst),
      retry: asNum(raw.retry, PWD_FALLBACK.retry),
      lockMin: asNum(raw.lockMin, PWD_FALLBACK.lockMin),
    };
  } catch {
    return { ...PWD_FALLBACK };
  }
}

/**
 * 该密码相对策略【缺什么】—— 空数组表示合规。
 *
 * 与 assertPwdStrength 拆开是为了让调用方既能「抛错」也能「只取清单」
 * （例如把缺失项拼进接口返回，让前端就地提示）。
 */
export function pwdRuleMiss(pwd: string, rule: PwdRule): string[] {
  const p = String(pwd ?? '');
  const miss: string[] = [];
  if (p.length < rule.min) miss.push(`不少于 ${rule.min} 位`);
  if (rule.upper && !/[A-Z]/.test(p)) miss.push('含大写字母');
  if (rule.digit && !/\d/.test(p)) miss.push('含数字');
  if (rule.symbol && !/[^A-Za-z0-9]/.test(p)) miss.push('含特殊符号');
  return miss;
}

/**
 * 校验密码强度，不合规抛 PWD_WEAK（40023）。
 *
 * ⚠️ 三个入口共用这一个判据：账号新增 / 账号编辑 / 重置密码 / 自助改密。
 *    提示语必须保持「人话」——前端拦截器会把 message 原样弹出来。
 */
export async function assertPwdStrength(pwd: string): Promise<void> {
  const rule = await loadPwdRule();
  const miss = pwdRuleMiss(pwd, rule);
  if (miss.length) {
    throw new BizError(BizCode.PWD_WEAK, `密码不符合安全策略，需：${miss.join('、')}`);
  }
}

/**
 * 一句人话的规则文案（前端提示 / 接口返回共用）
 * 例：不少于 8 位，且需包含大写字母、数字
 */
export async function describePwdRule(): Promise<string> {
  const rule = await loadPwdRule();
  const need: string[] = [];
  if (rule.upper) need.push('大写字母');
  if (rule.digit) need.push('数字');
  if (rule.symbol) need.push('特殊符号');
  return need.length ? `不少于 ${rule.min} 位，且需包含${need.join('、')}` : `不少于 ${rule.min} 位`;
}
