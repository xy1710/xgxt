/**
 * 通用导出路由
 *
 * 提供方：权限管理（林晓）
 * 前缀：  /api/perm/export
 *
 *  POST /do        生成导出文件，返回下载地址
 *  GET  /download  静态下载（由 app.ts 挂 express.static）
 *
 * ⚠️ 导出范围三选一（与原型一致）：
 *      当前页 / 全部筛选结果 / 全部数据
 *    「当前页」按 query.page + query.size 切；「筛选结果」按同条件全量取；
 *    「全部数据」忽略筛选条件。
 * ⚠️ CSV 必须带 UTF-8 BOM，否则 Excel 打开是乱码（中文用户 100% 会遇到）。
 * ⚠️ format=excel 产出 .xls（HTML 表格 + Excel MIME），Excel 可直接打开，
 *    这样不引入 xlsx 依赖也能满足交付。
 */

import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { BizCode, ExportScope, GENDER_NAME } from 'shared-types/perm';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { resolveLogRoleLabels } from '../services/perm.service';
import {
  addLog,
  clientIp,
  collectDescendants,
  joinRoleNames,
  maskPhone,
} from '../services/perm.service';

export const exportRouter = Router();

/** 导出文件落地目录（server-perm/exports） */
export const EXPORT_DIR = path.join(process.cwd(), 'exports');

type Row = Record<string, string | number>;

interface Sheet {
  title: string;
  columns: string[];
  rows: Row[];
}

/* ============================================================
 * 取数：四种资源
 * ============================================================ */

async function fetchDept(page?: number, size?: number, all = false): Promise<Sheet> {
  const columns = ['部门名称', '简称', '上级部门', '层级', '归属职位数', '归属账号数', '描述', '创建时间'];
  const query = db('t_perm_dept').where('is_deleted', false);
  if (!all && page && size) query.limit(size).offset((page - 1) * size);

  const [rows, allDepts, roleRows, userRows, deptLevelName] = await Promise.all([
    query.clone().select('*').orderBy([{ column: 'dept_level' }, { column: 'sort_no' }]),
    db('t_perm_dept').where('is_deleted', false).select('id', 'parent_id', 'dept_name'),
    db('t_perm_role').where('is_deleted', false).select('dept_id'),
    db('t_perm_user').where('is_deleted', false).select('dept_id'),
    Promise.resolve({ 1: '校级', 2: '部门', 3: '学段' } as Record<number, string>),
  ]);

  const nameById = new Map(allDepts.map((d: any) => [d.id, d.dept_name]));

  return {
    title: '部门清单',
    columns,
    rows: rows.map((r: any) => {
      const ids = collectDescendants(allDepts, r.id);
      return {
        部门名称: r.dept_name,
        简称: r.dept_short || '',
        上级部门: r.parent_id ? nameById.get(r.parent_id) || '—' : '—',
        层级: deptLevelName[r.dept_level] || '',
        归属职位数: roleRows.filter((x: any) => ids.includes(x.dept_id)).length,
        归属账号数: userRows.filter((x: any) => ids.includes(x.dept_id)).length,
        描述: r.remark || '',
        创建时间: fmt(r.create_time),
      };
    }),
  };
}

async function fetchRole(page?: number, size?: number, all = false): Promise<Sheet> {
  // ★ 2026-10-19：用户要求全系统去掉「职位编码」→ 导出表也不再带这一列
  // ★ 2026-10-20：同理去掉「职位类型」（界面上已无此列，导出也别带看不见的字段）
  const columns = [
    '职位名称', '所属部门', '状态', '权限点数', '关联账号数', '是否预置', '描述',
  ];
  const query = db('t_perm_role').where('is_deleted', false);
  if (!all && page && size) query.limit(size).offset((page - 1) * size);

  const [rows, depts, userCounts] = await Promise.all([
    query.clone().select('*').orderBy([{ column: 'is_sys', order: 'desc' }, { column: 'sort_no' }]),
    db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name'),
    db('t_perm_user_role').where('is_deleted', false).select('role_id').count({ n: '*' }).groupBy('role_id'),
  ]);

  const deptMap = new Map(depts.map((d: any) => [d.id, d.dept_name]));
  const userMap = new Map(userCounts.map((u: any) => [u.role_id, Number(u.n)]));

  return {
    title: '职位清单',
    columns,
    rows: rows.map((r: any) => ({
      职位名称: r.role_name,
      所属部门: deptMap.get(r.dept_id) || '—',
      状态: r.role_status,
      权限点数: Number(r.perm_count || 0),
      关联账号数: userMap.get(r.id) || 0,
      是否预置: r.is_sys ? '是' : '否',
      描述: r.remark || '',
    })),
  };
}

async function fetchUser(page?: number, size?: number, all = false): Promise<Sheet> {
  const columns = [
    '姓名', '登录账号', '手机号', '性别', '年龄', '所属部门', '职位', '账号状态', '待改密码', '最近登录',
  ];
  const query = db('t_perm_user').where('is_deleted', false);
  if (!all && page && size) query.limit(size).offset((page - 1) * size);

  const rows = await query.clone().select('*').orderBy('create_time', 'desc');

  const depts = await db('t_perm_dept').where('is_deleted', false).select('id', 'dept_name');
  const deptMap = new Map(depts.map((d: any) => [d.id, d.dept_name]));

  const ids = rows.map((r: any) => r.id);
  const roleRows = ids.length
    ? await db('t_perm_user_role')
        .leftJoin('t_perm_role', 't_perm_user_role.role_id', 't_perm_role.id')
        .whereIn('t_perm_user_role.user_id', ids)
        .andWhere('t_perm_user_role.is_deleted', false)
        .select('t_perm_user_role.user_id', 't_perm_role.role_name')
    : [];
  const roleMap = new Map<string, string[]>();
  roleRows.forEach((r: any) => {
    const arr = roleMap.get(r.user_id) || [];
    if (r.role_name) arr.push(r.role_name);
    roleMap.set(r.user_id, arr);
  });

  return {
    title: '账号清单',
    columns,
    rows: rows.map((r: any) => ({
      姓名: r.user_name,
      登录账号: r.account,
      手机号: maskPhone(r.phone),
      性别: GENDER_NAME[r.gender] || '',
      年龄: r.age ?? '',
      所属部门: deptMap.get(r.dept_id) || '—',
      职位: joinRoleNames(roleMap.get(r.id) || []),
      账号状态: r.user_status,
      待改密码: r.need_change_pwd ? '是' : '否',
      最近登录: fmt(r.last_login_time),
    })),
  };
}

async function fetchLog(
  page?: number,
  size?: number,
  all = false,
  filters: Record<string, any> = {},
): Promise<Sheet> {
  const columns = [
    '操作时间', '操作人', '职位', '所属模块', '操作类型', '操作对象', '操作前', '操作后', 'IP', '结果',
  ];
  const query = db('t_perm_log').where('is_deleted', false);

  if (filters.moduleName) query.andWhere('module_name', filters.moduleName);
  if (filters.actionType) query.andWhere('action_type', filters.actionType);
  if (filters.result) query.andWhere('result', filters.result);
  if (filters.keyword) {
    query.andWhere((qb: any) => {
      qb.where('operator_name', 'like', `%${filters.keyword}%`)
        .orWhere('target_obj', 'like', `%${filters.keyword}%`)
        .orWhere('ip', 'like', `%${filters.keyword}%`);
    });
  }
  if (filters.startDate) query.andWhere('log_time', '>=', `${filters.startDate} 00:00:00`);
  if (filters.endDate) query.andWhere('log_time', '<=', `${filters.endDate} 23:59:59`);

  if (!all && page && size) query.limit(size).offset((page - 1) * size);

  const rows = await query.clone().select('*').orderBy('log_time', 'desc');

  // ★ 2026-10-20：导出的「职位」列同样要中文（库里可能存的是 SYS_STAFF / 空）
  const roleLabels = await resolveLogRoleLabels(rows as any[]);

  return {
    title: '操作日志',
    columns,
    rows: rows.map((r: any, i: number) => ({
      操作时间: fmt(r.log_time),
      操作人: r.operator_name,
      职位: roleLabels[i] ?? r.operator_role ?? '',
      所属模块: r.module_name,
      操作类型: r.action_type,
      操作对象: r.target_obj || '',
      操作前: r.before_value || '',
      操作后: r.after_value || '',
      IP: r.ip || '',
      结果: r.result,
    })),
  };
}

/* ============================================================
 * 序列化
 * ============================================================ */

function fmt(v: any): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const esc = (v: unknown) => String(v ?? '').replace(/"/g, '""');

function toCsv(sheet: Sheet): string {
  const head = sheet.columns.map((c) => `"${esc(c)}"`).join(',');
  const body = sheet.rows
    .map((r) => sheet.columns.map((c) => `"${esc(r[c])}"`).join(','))
    .join('\r\n');
  // ⚠️ BOM 必须有，否则 Excel 打开中文乱码
  return `\uFEFF${head}\r\n${body}`;
}

function toXls(sheet: Sheet): string {
  const th = sheet.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const trs = sheet.rows
    .map(
      (r) =>
        `<tr>${sheet.columns
          .map((c) => `<td style="mso-number-format:'\\@'">${esc(r[c])}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8" /></head>
<body><table border="1"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></body></html>`;
}

/* ============================================================
 * POST /api/perm/export/do
 * ============================================================ */

exportRouter.post(
  '/do',
  checkPermission('perm:操作日志:export'),
  validate(
    z.object({
      resource: z.enum(['dept', 'role', 'user', 'log'], {
        errorMap: () => ({ message: '导出资源只能是 dept / role / user / log' }),
      }),
      scope: z.enum([ExportScope.CURRENT_PAGE, ExportScope.FILTERED, ExportScope.ALL], {
        errorMap: () => ({ message: '导出范围只能是 当前页 / 全部筛选结果 / 全部数据' }),
      }),
      format: z.enum(['excel', 'csv']).default('excel'),
      query: z.record(z.any()).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      resource: 'dept' | 'role' | 'user' | 'log';
      scope: string;
      format: 'excel' | 'csv';
      query?: Record<string, any>;
    };

    const q = body.query || {};
    const page = Number(q.page) || 1;
    const size = Number(q.size) || 20;
    const isAll = body.scope === ExportScope.ALL;
    const rawFilters = isAll ? {} : q;

    let sheet: Sheet;
    switch (body.resource) {
      case 'dept':
        sheet = await fetchDept(page, size, isAll);
        break;
      case 'role':
        sheet = await fetchRole(page, size, isAll);
        break;
      case 'user':
        sheet = await fetchUser(page, size, isAll);
        break;
      case 'log':
      default:
        sheet = await fetchLog(page, size, isAll, rawFilters);
        break;
    }

    if (!sheet.rows.length) {
      throw new BizError(BizCode.PARAM_ERROR, '当前条件下没有可导出的数据');
    }

    const stamp = fmt(new Date()).replace(/[-: ]/g, '');
    const ext = body.format === 'csv' ? 'csv' : 'xls';
    const fileName = `${sheet.title}_${stamp}_${randomUUID().slice(0, 6)}.${ext}`;
    const content = body.format === 'csv' ? toCsv(sheet) : toXls(sheet);

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(EXPORT_DIR, fileName), content, 'utf8');

    await addLog({
      operatorId: req.user?.userId,
      operatorName: req.user?.userName,
      operatorRole: req.user?.roles?.join('、'),
      moduleName: '权限管理',
      actionType: '导出',
      targetObj: sheet.title,
      beforeValue: '—',
      afterValue: `导出 ${sheet.rows.length} 条（${body.scope}）`,
      ip: clientIp(req),
    });

    res.json(
      ok(
        {
          fileName,
          total: sheet.rows.length,
          downloadUrl: `/api/perm/export/download/${encodeURIComponent(fileName)}`,
        },
        `已生成导出文件，共 ${sheet.rows.length} 条`,
      ),
    );
  }),
);

export default exportRouter;
