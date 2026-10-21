/**
 * 就业/实训（job）+ 教务（edu）板块的【写接口总闸】
 *
 * ============================================================
 * 【解决什么问题】
 *   这两个板块的写接口**绝大多数没有挂 `checkPermission`**——
 *   只有 exam / examScore / eduStudent 三处挂了（已收口），
 *   其余约 70 个写方法靠「角色白名单 + 只读拦截」粗粒度控制，
 *   甚至零判权（eduDorm / eduPayment 只 validate）。
 *   结果：管理员在「职位权限分配」里勾/取消 train / acad 模块的
 *   功能点动作，这两个板块的按钮/接口**完全不变**。
 *
 * 【本文件做什么】
 *   仿 consult 的 `consultPermGate`：一张「路径 → 操作码」映射表，
 *   用 `resolveActionWithOverlay(roles, code, () => true)` 判定。
 *   只叠加权限树里管理员做出的**显式改动**（差异存储语义）：
 *     · 显式撤销 → 403（按钮/接口真正失效）
 *     · 显式授权 → 放行（原本的角色白名单仍在路由内部继续判）
 *     · 未改动   → 行为与从前完全一致（零回归）
 *
 * 【⚠️ 语义与边界】
 *   - 审批动作（approve/reject）也纳入映射，但「授权审批」**不覆盖**
 *     路由内部的 canApprove 审批链 —— 审批权仍由审批流定义（刻意）。
 *   - 查看/导出（view/export）不纳入（归页面可见性管）。
 *   - 路径模板里 `:id` 是动态段，匹配任意一段（不含 `/`）。
 *   - 未登记路径 → 不干预（next 放行），绝不误伤。
 * ============================================================
 */

import type { Request, Response, NextFunction } from 'express';
import { BizCode } from 'shared-types';
import {
  preloadRoleActionOverrides,
  resolveActionWithOverlay,
  getOverrideSync,
} from '../utils/roleActionOverlay';

/* ============================================================
 * 路径模板 → 操作码（:id 为动态段）
 * ============================================================ */

const JOB_WRITE_PERM: Record<string, string[]> = {
  /* ---- 实训-班级信息（edit 及 graduate/seal 等次要写动作统一归 edit） ---- */
  '/api/job/class/add': ['job:class:edit'],
  '/api/job/class/update': ['job:class:edit'],
  '/api/job/class/delete/:id': ['job:class:edit'],
  '/api/job/class/graduate/:id': ['job:class:edit'],
  '/api/job/class/revoke-graduate/:id': ['job:class:edit'],
  '/api/job/class/seal/:id': ['job:class:edit'],
  '/api/job/class/unseal/:id': ['job:class:edit'],
  '/api/job/class-info/update-student': ['job:class:edit', 'job:empArchive:edit'],
  '/api/job/class-student/add': ['job:class:edit'],
  '/api/job/class-student/remove': ['job:class:edit'],
  /* ---- 实训-班级交接 / 就业-换班交接 ---- */
  '/api/job/class-transfer/do': ['job:classTransfer:add'],
  '/api/job/class-transfer/delete/:id': ['job:classTransfer:add'],
  /* ---- 实训-催费管理 ---- */
  '/api/job/fee-call/create': ['job:feeCall:add'],
  '/api/job/fee-call/handle': ['job:feeCall:handle'],
  '/api/job/fee-call/void': ['job:feeCall:handle'],
  /* ---- 实训-出勤管理 ---- */
  '/api/job/attendance/save': ['job:attendance:add'],
  /* ---- 实训-宿舍管理 ---- */
  '/api/job/dorm/create': ['job:dorm:add'],
  '/api/job/dorm/update': ['job:dorm:edit'],
  '/api/job/dorm/delete': ['job:dorm:add'],
  '/api/job/dorm/assign': ['job:dorm:edit'],
  '/api/job/dorm/change/create': ['job:dorm:apply'],
  '/api/job/dorm/change/submit': ['job:dorm:apply'],
  '/api/job/dorm/change/cancel': ['job:dorm:apply'],
  '/api/job/dorm/change/approve': ['job:dorm:approve'],
  '/api/job/dorm/change/reject': ['job:dorm:approve'],
  /* ---- 实训-退费申请 ---- */
  '/api/job/refund/create': ['job:refund:apply'],
  '/api/job/refund/submit': ['job:refund:apply'],
  '/api/job/refund/cancel': ['job:refund:apply'],
  '/api/job/refund/approve': ['job:refund:approve'],
  '/api/job/refund/reject': ['job:refund:approve'],
  '/api/job/refund/finance-confirm': ['job:refund:approve'],
  /* ---- 实训-休学/退学/复学审批 ---- */
  '/api/job/student-leave/create': ['job:leave:apply'],
  '/api/job/student-leave/submit': ['job:leave:apply'],
  '/api/job/student-leave/cancel': ['job:leave:apply'],
  '/api/job/student-leave/approve': ['job:leave:approve'],
  '/api/job/student-leave/reject': ['job:leave:approve'],
  /* ---- 就业-就业日志 ---- */
  '/api/job/employment-log/add': ['job:employmentLog:add'],
  '/api/job/employment-log/update': ['job:employmentLog:edit'],
  '/api/job/employment-log/delete/:id': ['job:employmentLog:edit'],
  /* ---- 就业-复盘填写 ---- */
  '/api/job/review/add': ['job:review:add'],
  '/api/job/review/update': ['job:review:edit'],
  '/api/job/review/delete/:id': ['job:review:edit'],
  '/api/job/review/remove-audio/:id': ['job:review:edit'],
  /* ---- 就业-学生基础数据（就业档案编辑） ---- */
  '/api/job/student/add': ['job:empArchive:edit'],
  '/api/job/student/update': ['job:empArchive:edit'],
  '/api/job/student/delete/:id': ['job:empArchive:edit'],
  '/api/job/student/confirm-employment': ['job:empArchive:edit'],
};

const EDU_WRITE_PERM: Record<string, string[]> = {
  /* ---- 教务-宿舍总名单 + 换宿/退宿审批 ---- */
  '/api/edu/dorm/room/add': ['edu:dorm:add'],
  '/api/edu/dorm/room/info': ['edu:dorm:edit'],
  '/api/edu/dorm/room/occupants': ['edu:dorm:edit'],
  '/api/edu/dorm/room/delete/:id': ['edu:dorm:delete'],
  '/api/edu/dorm/assign': ['edu:dorm:edit'],
  '/api/edu/dorm/assign/replace': ['edu:dorm:edit'],
  '/api/edu/dorm/assign/remove': ['edu:dorm:edit'],
  '/api/edu/dorm/assign/clear': ['edu:dorm:edit'],
  '/api/edu/dorm/import': ['edu:dorm:add'],
  '/api/edu/dorm/change/approve': ['edu:dorm:approve'],
  '/api/edu/dorm/change/reject': ['edu:dorm:approve'],
  '/api/edu/dorm/quit/approve': ['edu:dorm:approve'],
  '/api/edu/dorm/quit/reject': ['edu:dorm:approve'],
  /* ---- 教务-缴费总名单 + 临期名单 + 餐费住宿费 ---- */
  '/api/edu/payment/add': ['edu:fee:add'],
  '/api/edu/payment/upload': ['edu:fee:add'],
  '/api/edu/payment/import': ['edu:fee:import'],
  '/api/edu/payment/batch-upload': ['edu:fee:import'],
  '/api/edu/payment/toggle-freeze': ['edu:fee:freeze'],
  '/api/edu/payment/batch-freeze': ['edu:fee:freeze'],
  '/api/edu/payment/notify': ['edu:fee:notify'],
  '/api/edu/payment/notify-all': ['edu:fee:notify'],
};

/* ============================================================
 * 匹配 + 判定
 * ============================================================ */

/** 模板 → 正则（`:id` 匹配任意非 `/` 一段） */
function compileTemplate(tpl: string): RegExp {
  const escaped = tpl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** 预编译（模块加载时做一次，避免每请求重编译） */
function compileTable(table: Record<string, string[]>): Array<[RegExp, string[]]> {
  return Object.entries(table).map(([tpl, codes]) => [compileTemplate(tpl), codes]);
}

const JOB_COMPILED = compileTable(JOB_WRITE_PERM);
const EDU_COMPILED = compileTable(EDU_WRITE_PERM);

function matchPath(compiled: Array<[RegExp, string[]]>, pathname: string): string[] | null {
  for (const [re, codes] of compiled) {
    if (re.test(pathname)) return codes;
  }
  return null;
}

async function gate(
  req: Request,
  res: Response,
  next: NextFunction,
  compiled: Array<[RegExp, string[]]>,
  headerName: string,
): Promise<void> {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: BizCode.UNAUTHORIZED, message: '请先登录', data: null });
    return;
  }

  // 只读方法 / 通配权限 → 直接过
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if ((user.permissions || []).includes('*')) {
    next();
    return;
  }

  const pathname = String(req.originalUrl || req.url || '').split('?')[0];
  const candidates = matchPath(compiled, pathname);
  if (!candidates) {
    res.setHeader(headerName, 'miss');
    next(); // 未登记 → 不干预
    return;
  }

  try {
    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    await preloadRoleActionOverrides();
    const ok = candidates.some((code) => resolveActionWithOverlay(roles, code, () => true));
    const hitCount = roles.filter((r) => !!getOverrideSync(r)).length;
    res.setHeader(
      headerName,
      ok
        ? `allow(roles=${roles.join('|') || '空'};ov=${hitCount}/${roles.length})`
        : `deny(roles=${roles.join('|') || '空'})`,
    );
    if (!ok) {
      res.status(403).json({
        code: BizCode.NO_OPERATION_PERMISSION,
        message: `该操作已被取消：权限点「${candidates.join('」或「')}」未授权给您的角色`,
        data: null,
      });
      return;
    }
  } catch {
    res.setHeader(headerName, 'error');
    /* 降级：权限库抖动 → 放行，绝不误伤正常业务 */
  }
  next();
}

/** 就业/实训（job）写接口总闸 */
export function jobPermGate(req: Request, res: Response, next: NextFunction): void {
  void gate(req, res, next, JOB_COMPILED, 'X-Job-Perm-Gate');
}

/** 教务（edu）写接口总闸 */
export function eduPermGate(req: Request, res: Response, next: NextFunction): void {
  void gate(req, res, next, EDU_COMPILED, 'X-Edu-Perm-Gate');
}
