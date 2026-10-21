/**
 * 规则配置路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/rule
 *
 *  GET /get            读取全部规则（pwd / login / approval 三组）
 *  PUT /save           保存某一组规则
 *  PUT /reset          恢复默认值
 *
 * ⚠️ 规则值在 t_perm_rule 里统一按【字符串】存储（rule_value varchar），
 *    接口返回时按类型还原成 number / boolean —— 前端不用自己转换。
 * ⚠️ 密码策略不是给前端做样子的：账号新增 / 重置密码都会回来读这里的值
 *    （见 user.route.ts 的 assertPwdStrength），改小长度会立刻生效。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, PermRules, RuleGroup } from 'shared-types/perm';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { addLog, clientIp, getRuleRaw } from '../services/perm.service';

export const ruleRouter = Router();

const TABLE = 't_perm_rule';

/* ============================================================
 * 默认值（与种子脚本 20260929_009_seed_perm_data.js 的 RULES 保持一致）
 * ============================================================ */

const DEFAULTS: Record<string, string> = {
  'pwd.min': '8',
  'pwd.upper': 'true',
  'pwd.digit': 'true',
  /**
   * ★ 2026-10-16 按用户要求改为 false：密码策略统一为「≥8 位 + 含大写字母和数字」，
   *   不再要求特殊符号（与账号表单「密码」右侧的提示文案一致）。
   *   ⚠️ 这只是【默认值】的兜底口径；实际生效值读 t_perm_rule（本次已同步改为 false）。
   */
  'pwd.symbol': 'false',
  'pwd.expireDays': '90',
  'pwd.forceFirst': 'true',
  'pwd.retry': '5',
  'pwd.lockMin': '30',
  'login.ip': 'true',
  'login.time': '07:00-23:00',
  'login.limit': 'true',
  'login.sameAcct': '1',
  'approval.holiday': '教质经理→学术经理→校长',
  'approval.refund': '咨询经理→教质经理→教务核算→财务出款→校长',
  'approval.settle': '教务核算→财务出款→校长',
};

const RULE_REMARKS: Record<string, string> = {
  'pwd.min': '密码最小长度 6/8/10/12',
  'pwd.upper': '要求包含大写字母',
  'pwd.digit': '要求包含数字',
  'pwd.symbol': '要求包含特殊符号',
  'pwd.expireDays': '密码有效期（天），0=永久',
  'pwd.forceFirst': '强制首次登录修改密码',
  'pwd.retry': '密码错误锁定次数 3/5/8/10',
  'pwd.lockMin': '锁定时长（分钟），0=永久锁定',
  'login.ip': 'IP 白名单限制（由部署方配置的校内网网段）',
  'login.time': '允许登录时间段',
  'login.limit': '是否限制同账号并发登录',
  'login.sameAcct': '同账号允许并发数，1=仅允许 1 处登录',
  'approval.holiday': '休学/退学审批链',
  'approval.refund': '退费审批链',
  'approval.settle': '教务核算 → 出款链',
};

/* ============================================================
 * 转换工具
 * ============================================================ */

const asBool = (v: string | undefined, dflt = false) => (v === undefined ? dflt : v === 'true');
const asNum = (v: string | undefined, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/**
 * 布尔入参解析
 * ⚠️ 不能用 z.coerce.boolean()：它按 JS 真值判断，字符串 "false" 会被转成 true，
 *    用户在前端把开关关掉、后端却存成了 true —— 这类 bug 极难发现。
 *    这里显式识别 'true'/'1'/'on' 才算真。
 */
const boolFlag = z.preprocess(
  (v) => (typeof v === 'string' ? ['true', '1', 'on', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
  z.boolean(),
);

/** 把库里的字符串还原成契约要求的 PermRules 结构 */
async function readRules(): Promise<PermRules> {
  const [pwd, login, approval] = await Promise.all([
    getRuleRaw(RuleGroup.PWD),
    getRuleRaw(RuleGroup.LOGIN),
    getRuleRaw(RuleGroup.APPROVAL),
  ]);

  return {
    pwd: {
      min: asNum(pwd.min, 8),
      upper: asBool(pwd.upper, true),
      digit: asBool(pwd.digit, true),
      symbol: asBool(pwd.symbol, true),
      expireDays: asNum(pwd.expireDays, 90),
      forceFirst: asBool(pwd.forceFirst, true),
      retry: asNum(pwd.retry, 5),
      lockMin: asNum(pwd.lockMin, 30),
    },
    login: {
      ip: asBool(login.ip, true),
      time: login.time || '07:00-23:00',
      limit: asBool(login.limit, true),
      sameAcct: asNum(login.sameAcct, 1),
    },
    approval: {
      holiday: approval.holiday || DEFAULTS['approval.holiday'],
      refund: approval.refund || DEFAULTS['approval.refund'],
      settle: approval.settle || DEFAULTS['approval.settle'],
    },
  };
}

/* ============================================================
 * 分组校验规则（不同组的值域不一样，必须分开校验）
 * ============================================================ */

const pwdSchema = z.object({
  min: z.coerce.number().int().refine((v) => [6, 8, 10, 12].includes(v), '密码长度只能是 6/8/10/12'),
  upper: boolFlag,
  digit: boolFlag,
  symbol: boolFlag,
  expireDays: z.coerce.number().int().min(0, '有效期不能为负数'),
  forceFirst: boolFlag,
  retry: z.coerce.number().int().refine((v) => [3, 5, 8, 10].includes(v), '锁定次数只能是 3/5/8/10'),
  lockMin: z.coerce.number().int().min(0, '锁定时长不能为负数'),
});

const loginSchema = z.object({
  ip: boolFlag,
  time: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, '时间格式应为 07:00-23:00'),
  limit: boolFlag,
  sameAcct: z.coerce.number().int().min(1, '并发数至少为 1').max(9, '并发数最多为 9'),
});

const approvalSchema = z.object({
  holiday: z.string().min(1, '休学/退学审批链不能为空'),
  refund: z.string().min(1, '退费审批链不能为空'),
  settle: z.string().min(1, '出款链不能为空'),
});

const GROUP_SCHEMA: Record<string, z.ZodTypeAny> = {
  [RuleGroup.PWD]: pwdSchema,
  [RuleGroup.LOGIN]: loginSchema,
  [RuleGroup.APPROVAL]: approvalSchema,
};

/* ============================================================
 * 1. 读取全部规则
 *    GET /api/perm/rule/get
 * ============================================================ */

ruleRouter.get(
  '/get',
  wrap(async (_req, res) => {
    res.json(ok(await readRules()));
  }),
);

/* ============================================================
 * 2. 保存某组规则
 *    PUT /api/perm/rule/save   body: { group, value }
 * ============================================================ */

ruleRouter.put(
  '/save',
  checkPermission('perm:规则配置:edit'),
  validate(
    z.object({
      group: z.enum([RuleGroup.PWD, RuleGroup.LOGIN, RuleGroup.APPROVAL], {
        errorMap: () => ({ message: '规则分组只能是 pwd / login / approval' }),
      }),
      value: z.record(z.any()),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as { group: string; value: Record<string, any> };

    const schema = GROUP_SCHEMA[body.group];
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      throw new BizError(
        BizCode.RULE_VALUE_INVALID,
        `${first.path.join('.')} ${first.message}`.trim(),
      );
    }

    const before = await getRuleRaw(body.group);
    const entries = Object.entries(parsed.data as Record<string, unknown>);

    for (let i = 0; i < entries.length; i += 1) {
      const [key, value] = entries[i];
      const strValue = String(value);
      const exists = await db(TABLE)
        .where({ rule_group: body.group, rule_key: key })
        .first();

      if (exists) {
        await db(TABLE)
          .where({ id: exists.id })
          .update({
            rule_value: strValue,
            is_deleted: false,
            update_time: new Date(),
            update_by: req.user?.userId || 'system',
          });
      } else {
        await db(TABLE).insert({
          id: `RU_${body.group}_${key}`,
          rule_group: body.group,
          rule_key: key,
          rule_value: strValue,
          rule_sort: i + 1,
          remark: RULE_REMARKS[`${body.group}.${key}`] || null,
          is_deleted: false,
          create_time: new Date(),
          create_by: req.user?.userId || 'system',
        });
      }
    }

    const after = await getRuleRaw(body.group);
    const diff = Object.keys(after)
      .filter((k) => before[k] !== after[k])
      .map((k) => `${k}: ${before[k] ?? '—'} → ${after[k]}`)
      .join('；');

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `规则配置 ${body.group}`,
      beforeValue: diff || '无变化',
      afterValue: '已保存',
      ip: clientIp(req),
    });

    res.json(ok(await readRules(), '规则已保存'));
  }),
);

/* ============================================================
 * 3. 恢复默认
 *    PUT /api/perm/rule/reset   body: { group? }
 * ============================================================ */

ruleRouter.put(
  '/reset',
  checkPermission('perm:规则配置:edit'),
  validate(
    z.object({
      group: z
        .enum([RuleGroup.PWD, RuleGroup.LOGIN, RuleGroup.APPROVAL])
        .optional(),
    }),
  ),
  wrap(async (req, res) => {
    const { group } = (req as any).validated as { group?: string };
    const groups = group ? [group] : [RuleGroup.PWD, RuleGroup.LOGIN, RuleGroup.APPROVAL];

    for (const g of groups) {
      const keys = Object.keys(DEFAULTS).filter((k) => k.startsWith(`${g}.`));
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i].split('.')[1];
        const exists = await db(TABLE).where({ rule_group: g, rule_key: key }).first();
        if (exists) {
          await db(TABLE).where({ id: exists.id }).update({
            rule_value: DEFAULTS[keys[i]],
            is_deleted: false,
            update_time: new Date(),
            update_by: req.user?.userId || 'system',
          });
        } else {
          await db(TABLE).insert({
            id: `RU_${g}_${key}`,
            rule_group: g,
            rule_key: key,
            rule_value: DEFAULTS[keys[i]],
            rule_sort: i + 1,
            remark: RULE_REMARKS[keys[i]] || null,
            is_deleted: false,
            create_time: new Date(),
            create_by: req.user?.userId || 'system',
          });
        }
      }
    }

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '修改',
      targetObj: `规则配置 ${group || '全部'}`,
      beforeValue: '自定义值',
      afterValue: '已恢复默认值',
      ip: clientIp(req),
    });

    res.json(ok(await readRules(), '已恢复默认值'));
  }),
);

export default ruleRouter;
