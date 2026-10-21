/**
 * 操作日志路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/log
 *
 *  GET /list             日志列表（分页）
 *  GET /detail?id=xxx    日志详情
 *  GET /overview         日志 KPI（5 个，均可点击筛选）
 *  GET /export           导出日志（不分页）
 *
 * ⚠️ 日志只读：本模块不提供 add / update / delete 接口。
 *    写入由后端在关键动作处自动完成（见 services/perm.service.ts 的 addLog()）。
 *    这是刻意的 —— 日志一旦能被前端写，就不再是证据。
 */

import { Router } from 'express';
import { z } from 'zod';
import { BizCode, LogResult } from 'shared-types/perm';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { resolveLogRoleLabels } from '../services/perm.service';

export const logRouter = Router();

const TABLE = 't_perm_log';

/**
 * 行 → 接口对象
 * @param roleLabel 已解析好的中文职位名（见 resolveLogRoleLabels）
 *
 * ★ 2026-10-20：`所属职位` 以前直接吐 `operator_role` 原值，
 *   于是列表里出现 `SYS_STAFF` 这种英文编码（门户 token 只有粗粒度身份，
 *   写日志时既没映射到业务职位、也没有备选来源）。现在统一走解析层：
 *   编码→中文名，空值/门户级编码→按操作人现查真实职位。
 */
function toLogItem(r: any, roleLabel?: string) {
  return {
    id: r.id,
    logTime: r.log_time,
    operatorId: r.operator_id,
    operatorName: r.operator_name,
    operatorRole: roleLabel ?? r.operator_role,
    moduleName: r.module_name,
    actionType: r.action_type,
    targetObj: r.target_obj,
    beforeValue: r.before_value,
    afterValue: r.after_value,
    ip: r.ip,
    result: r.result,
    createTime: r.create_time,
    createBy: r.create_by,
    isDeleted: !!r.is_deleted,
  };
}

/** 批量转接口对象（职位名一次解析，避免每行查两次库） */
async function toLogItems(rows: any[]) {
  const labels = await resolveLogRoleLabels(rows);
  return rows.map((r, i) => toLogItem(r, labels[i]));
}

/** 组装筛选条件（列表 / 导出 / KPI 复用，保证口径一致） */
function applyFilters(q: any) {
  const query = db(TABLE).where('is_deleted', false);

  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('operator_name', 'like', `%${q.keyword}%`)
        .orWhere('target_obj', 'like', `%${q.keyword}%`)
        .orWhere('ip', 'like', `%${q.keyword}%`);
    });
  }
  if (q.moduleName) query.andWhere('module_name', q.moduleName);
  if (q.actionType) query.andWhere('action_type', q.actionType);
  if (q.result) query.andWhere('result', q.result);
  if (q.operatorName) query.andWhere('operator_name', 'like', `%${q.operatorName}%`);
  if (q.startDate) query.andWhere('log_time', '>=', `${q.startDate} 00:00:00`);
  if (q.endDate) query.andWhere('log_time', '<=', `${q.endDate} 23:59:59`);

  return query;
}

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  keyword: z.string().optional(),
  moduleName: z.string().optional(),
  actionType: z.string().optional(),
  result: z.string().optional(),
  operatorName: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

/* ============================================================
 * 1. 日志列表
 *    GET /api/perm/log/list?page=1&size=20&actionType=登录&result=失败
 * ============================================================ */

logRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = applyFilters(q);
    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('log_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(await toLogItems(rows), Number(total), q));
  }),
);

/* ============================================================
 * 2. 日志详情
 *    GET /api/perm/log/detail?id=LG0001
 * ============================================================ */

logRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.LOG_NOT_FOUND, '日志不存在');
    const [roleLabel] = await resolveLogRoleLabels([row]);
    res.json(ok(toLogItem(row, roleLabel)));
  }),
);

/* ============================================================
 * 3. 日志 KPI（5 个）
 *    GET /api/perm/log/overview
 * ============================================================ */

logRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const [all, success, fail, login, approve] = await Promise.all([
      db(TABLE).where('is_deleted', false).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, result: LogResult.SUCCESS }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, result: LogResult.FAIL }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, action_type: '登录' }).count({ n: '*' }),
      db(TABLE).where({ is_deleted: false, action_type: '审批' }).count({ n: '*' }),
    ]);

    res.json(
      ok({
        logTotal: Number(all[0]?.n || 0),
        successTotal: Number(success[0]?.n || 0),
        failTotal: Number(fail[0]?.n || 0),
        loginTotal: Number(login[0]?.n || 0),
        approveTotal: Number(approve[0]?.n || 0),
      }),
    );
  }),
);

/* ============================================================
 * 4. 导出日志（不分页）
 *    GET /api/perm/log/export?actionType=审批
 * ============================================================ */

logRouter.get(
  '/export',
  validate(listSchema.omit({ page: true, size: true })),
  wrap(async (req, res) => {
    const q = (req as any).validated as Record<string, string | undefined>;
    const rows = await applyFilters(q).select('*').orderBy('log_time', 'desc').limit(10000);
    const list = await toLogItems(rows);
    res.json(ok({ total: list.length, list }));
  }),
);

export default logRouter;
