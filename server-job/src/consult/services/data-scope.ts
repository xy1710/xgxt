/**
 * ★ 2026-10-16 咨询模块【数据范围】统一口径
 *
 * 用户口径（原话）：
 *   「咨询经理可以看到全部，咨询师只能看到分配给他的学生，
 *     咨询师那边的退费是由咨询师发起自己负责的学生，
 *     由咨询经理审批没问题之后，财务打款」
 *
 * 落地规则：
 *   · 咨询经理 / 系统管理员 → 全部学生（含「待分配」的）
 *   · 咨询师                → 只认 owner_name = 本人姓名的学生
 *                             ＋ 兼容：自己录入但还没被分配（owner_name 为空）的
 *                               （否则咨询师新建完就看不到自己录的那条，体验上是 bug）
 *
 * ⚠️ 只管「看得到 / 操作得动」，不管「能不能审批」：
 *    审批链（咨询师发起 → 经理审批 → 财务打款）仍由
 *    requireManager / 退费状态机负责，两个维度互不替代。
 */

import type { Request, Response, NextFunction } from 'express';
import { BizCode, ConsultRole } from 'shared-types/consult';
import { BizError } from '../middleware/errorHandler';
import { db } from '../utils/db';
import { STUDENT_TABLE } from './student.service';

/**
 * 取数据范围归属人姓名
 *
 * @returns 咨询师 → 本人姓名（作为 owner_name 过滤值）；经理 / 管理员 → undefined（不限）
 */
export function scopeOwnerName(user?: any): string | undefined {
  if (!user) return undefined;
  // 只有「咨询师」收窄；经理、管理员、以及角色解析失败时的兜底一律不收窄
  if (user.role === ConsultRole.CONSULT) return user.userName || undefined;
  return undefined;
}

/** 是否受数据范围限制 */
export function isScoped(user?: any): boolean {
  return !!scopeOwnerName(user);
}

/**
 * 学生行是否在当前用户的数据范围内（不在 → 抛 403）
 *
 * @param row  学生表行（至少要有 owner_name / student_name）
 */
export function assertStudentInScope(row: any, user?: any): void {
  const owner = scopeOwnerName(user);
  if (!owner || !row) return;

  const own = String(row.owner_name || '').trim();
  // 已经分配给他 → 放行；自己录入还没分配 → 也放行
  if (own === owner) return;
  if (!own && String(row.create_by_name || '').trim() === owner) return;

  throw new BizError(
    BizCode.NO_OPERATION_PERMISSION,
    `「${row.student_name || '该学生'}」不是您名下的学生，咨询师只能查看和操作分配给自己的学生`,
  );
}

/** 按学生 id 校验数据范围（先查库再判） */
export async function assertStudentIdInScope(id: string, user?: any): Promise<any | null> {
  const owner = scopeOwnerName(user);
  if (!owner || !id) return null;

  const row: any = await db(STUDENT_TABLE).where({ id, is_deleted: false }).first();
  if (!row) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
  assertStudentInScope(row, user);
  return row;
}

/**
 * 给「学生列表」查询加数据范围条件（原地修改 query）
 *
 * 口径：owner_name = 本人 **或**（owner_name 为空 且 建档人 = 本人）
 */
export function applyStudentScope(query: any, user?: any): void {
  const owner = scopeOwnerName(user);
  if (!owner) return;

  query.andWhere((qb: any) => {
    qb.where('owner_name', owner).orWhere((qb2: any) => {
      qb2
        .whereNull('owner_name')
        .orWhere('owner_name', '')
        .where('create_by_name', owner);
    });
  });
}

/**
 * 当前用户可见的学生 id 列表（收款单 / 退费单等「按学生归属」过滤用）
 *
 * @returns null = 不限制；数组 = 只允许这些学生（空数组 → 什么都看不到）
 */
export async function scopedStudentIds(user?: any): Promise<string[] | null> {
  const owner = scopeOwnerName(user);
  if (!owner) return null;

  const rows: any[] = await db(STUDENT_TABLE)
    .where('is_deleted', false)
    .andWhere((qb: any) => {
      qb.where('owner_name', owner).orWhere((qb2: any) => {
        qb2
          .whereNull('owner_name')
          .orWhere('owner_name', '')
          .where('create_by_name', owner);
      });
    })
    .select('id');

  return rows.map((r) => String(r.id));
}

/**
 * Express 中间件：学生写操作的归属守卫
 *
 * 用法（放在 validate 之后，业务 handler 之前）：
 *   router.post('/loss', validate(schema), guardOwnStudent, wrap(handler))
 *
 * ⚠️ 只校验「请求里带了学生 id」的写接口；
 *    经理 / 管理员直接放行（数据范围是咨询师专属限制）。
 */
export function guardOwnStudent(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!isScoped(user)) {
    next();
    return;
  }

  const v = (req as any).validated || {};
  const id = String(
    v.consultStudentId || v.id || req.body?.consultStudentId || req.body?.id || req.query?.id || '',
  );

  // 请求里没有学生 id → 交给下游业务校验（不在这里替它报错）
  if (!id) {
    next();
    return;
  }

  assertStudentIdInScope(id, user)
    .then(() => next())
    .catch(next);
}

/**
 * ★ 2026-10-20 面试归属校验（比数据范围更严，经理也受约束）
 *
 * 用户口径（原话）：「经理已经分配给咨询老师，经理这里就不可以再面试了」
 *
 * 和数据范围的区别：
 *   · 数据范围是「能看多少」，经理能看全部 → 不拦；
 *   · 面试是「谁负责谁录」，学生已经挂在张三名下，就只有张三能录面试结果，
 *     经理/管理员在旁边只能看、不能替他面。
 *
 * ⚠️ 为什么不做成中间件：它比 guardOwnStudent 窄（只用于面试类接口），
 *    而且必须拿到学生行（owner_name）才能判，所以做成 handler 内的断言，
 *    在 findStudent 之后调用。
 *
 * @param row  学生表行（需含 owner_name / student_name）
 */
export function assertInterviewOwner(row: any, user?: any): void {
  if (!row) return;
  const own = String(row.owner_name || '').trim();
  if (!own) return; // 未分配 → 公海，谁都能面

  const me = String(user?.userName || '').trim();
  // /claim 认领时经理的 owner_name 带「（本人接待）」后缀，比对前先剥掉
  const normalized = own.replace(/[（(]本人接待[）)]$/, '').trim();
  if (me && (normalized === me || own === me)) return;

  throw new BizError(
    BizCode.NO_OPERATION_PERMISSION,
    `「${row.student_name || '该学生'}」已分配给 ${own}，面试结果只能由该咨询老师录入`,
  );
}
