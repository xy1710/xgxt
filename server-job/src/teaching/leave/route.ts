/**
 * 学籍异动统一接口 · `/api/teaching/leave/*`
 * ============================================================
 * 取代原三套：
 *   · 实训 `/api/job/student-leave/*`（9 个）
 *   · 大学 `/api/class/suspend/*`（5 个）
 *   · 初高 `/api/class-jh/flow/*`（5 个）—— ★ 只接 休学/退学/复学 三条流程
 *
 * 学段由 `stage` 区分（jh / class / job）；类型由 `bizType` 区分（1休学 2退学 3复学）。
 * 老接口**一个都没删**。
 */

import { Router } from 'express';
import { BizCode } from 'shared-types';
import { ok, page } from '../../utils/response';
import { wrap } from '../../utils/wrap';
import { BizError } from '../../middleware/errorHandler';
import { LEAVE_DATE_WINDOW_DAYS } from '../shared/format';
import {
  LEAVE_BIZ_TYPE_NAME,
  LEAVE_CHAIN_STEPS,
  LEAVE_DEPARTMENTS,
  LEAVE_STAGE_BIZ,
  LEAVE_STATUS_NAME,
  TEACHING_STAGES,
  type TeachingStage,
} from '../shared/dto';
import * as svc from './service';

export const teachingLeaveRouter = Router();

/* ---------------- 入参小工具 ---------------- */

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}

function optStage(v: unknown): TeachingStage | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!TEACHING_STAGES.includes(s as TeachingStage)) {
    throw new BizError(BizCode.PARAM_ERROR, `学段参数非法：${s}`);
  }
  return s as TeachingStage;
}

function mustStage(v: unknown): TeachingStage {
  const s = optStage(v);
  if (!s) throw new BizError(BizCode.PARAM_ERROR, '缺少学段参数 stage');
  return s;
}

function optInt(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  return i >= min && i <= max ? i : undefined;
}

/* ============================================================
 * 1. 列表  GET /api/teaching/leave/list
 * ============================================================ */

teachingLeaveRouter.get(
  '/list',
  wrap(async (req, res) => {
    const q = {
      stage: optStage(req.query.stage),
      page: Math.max(1, Number(req.query.page) || 1),
      size: Math.min(200, Math.max(1, Number(req.query.size) || 20)),
      keyword: str(req.query.keyword),
      classId: str(req.query.classId),
      bizType: optInt(req.query.bizType, 1, 3),
      status: optInt(req.query.status, 1, 6),
      onlyMine: req.query.onlyMine === 'true' || req.query.onlyMine === '1',
      startDate: str(req.query.startDate),
      endDate: str(req.query.endDate),
    };
    const { rows, total } = await svc.list(q, req.user);
    res.json(page(rows, total, q));
  }),
);

/* ============================================================
 * 2. 详情  GET /api/teaching/leave/detail?id=
 * ============================================================ */

teachingLeaveRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少 id');
    res.json(ok(await svc.detail(id, req.user)));
  }),
);

/* ============================================================
 * 3. 学生下拉  GET /api/teaching/leave/student-options?stage=&bizType=
 *    ★ bizType=3（复学）时后端只返回**当前处于休学**的学生 ——
 *      复学是「把休学的人接回来」，下拉里就不该出现在读/退学的人。
 *    ★ 终态学生（退学 7 / 流失 11 / 已就业 10）**任何 bizType 都不返回** ——
 *      已经终结的学生不能再办学籍异动（先退学再休学 = 自相矛盾的单据）。
 * ============================================================ */

teachingLeaveRouter.get(
  '/student-options',
  wrap(async (req, res) => {
    const stage = mustStage(req.query.stage);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const bizType = optInt(req.query.bizType, 1, 3);
    res.json(
      ok(await svc.studentOptions(stage, str(req.query.keyword) || '', limit, req.user, bizType)),
    );
  }),
);

/* ============================================================
 * 4. 班级下拉（跨学段）  GET /api/teaching/leave/classes
 * ============================================================ */

teachingLeaveRouter.get(
  '/classes',
  wrap(async (req, res) => {
    res.json(ok(await svc.classOptions(req.user)));
  }),
);

/* ============================================================
 * 5. 汇总  GET /api/teaching/leave/summary
 * ============================================================ */

teachingLeaveRouter.get(
  '/summary',
  wrap(async (req, res) => {
    res.json(ok(await svc.summary(req.user)));
  }),
);

/* ============================================================
 * 6. 元信息（类型 / 状态 / 各学段支持哪些类型 / 走几步 / 部门）
 *    GET /api/teaching/leave/meta
 *    —— 前端据此隐藏"该学段不支持的类型"，而不是给个点不动的按钮
 *    —— ★ departments：发起申请时的「部门」下拉（初高中/大学/实训/就业）。
 *       「就业」的 stage 是 null = 暂不办理学籍异动（前端据此置灰 + 提示），
 *       前端不要再抄一份列表。
 * ============================================================ */

teachingLeaveRouter.get(
  '/meta',
  wrap(async (_req, res) => {
    res.json(
      ok({
        bizTypes: Object.entries(LEAVE_BIZ_TYPE_NAME).map(([k, v]) => ({
          value: Number(k),
          label: v,
          steps: LEAVE_CHAIN_STEPS[Number(k)] || 1,
        })),
        statuses: Object.entries(LEAVE_STATUS_NAME).map(([k, v]) => ({
          value: Number(k),
          label: v,
        })),
        stageBizTypes: LEAVE_STAGE_BIZ,
        departments: LEAVE_DEPARTMENTS,
        /** ★ 异动日期可选窗口（今天 ± N 天）：前端 picker 的 disabled-date 用它 */
        leaveDateWindowDays: LEAVE_DATE_WINDOW_DAYS,
      }),
    );
  }),
);

/* ============================================================
 * 7. 新建  POST /api/teaching/leave/create
 *    ★ bizType=3（复学）时 `newClassId`（复学班）必填 —— 见 service.create 的校验
 * ============================================================ */

teachingLeaveRouter.post(
  '/create',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = mustStage(b.stage);
    if (!str(b.studentId)) throw new BizError(BizCode.PARAM_ERROR, '学生必选');
    if (!str(b.leaveReason)) throw new BizError(BizCode.PARAM_ERROR, '异动原因必填');
    const bizType = optInt(b.bizType, 1, 3);
    if (!bizType) throw new BizError(BizCode.PARAM_ERROR, '请选择异动类型（休学/退学/复学）');

    const r = await svc.create(
      {
        stage,
        studentId: String(b.studentId),
        bizType,
        leaveDate: str(b.leaveDate),
        expectResumeDate: str(b.expectResumeDate),
        newClassId: str(b.newClassId),
        leaveReason: String(b.leaveReason),
        remark: str(b.remark) ?? null,
        submit: b.submit === true || b.submit === 'true',
      },
      req.user,
    );
    res.json(ok(r, '申请已创建'));
  }),
);

/* ============================================================
 * 8. 提交  POST /api/teaching/leave/submit
 * ============================================================ */

teachingLeaveRouter.post(
  '/submit',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = mustStage(b.stage);
    if (!str(b.id)) throw new BizError(BizCode.PARAM_ERROR, '缺少 id');
    res.json(ok(await svc.submit(stage, String(b.id), req.user), '已提交'));
  }),
);

/* ============================================================
 * 9. 审批  POST /api/teaching/leave/approve
 *    body: { stage, id, comment?, newClassId? }
 *    ★ newClassId 只有「复学」在终审通过时必填
 * ============================================================ */

teachingLeaveRouter.post(
  '/approve',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = mustStage(b.stage);
    if (!str(b.id)) throw new BizError(BizCode.PARAM_ERROR, '缺少 id');
    const r = await svc.approve(
      stage,
      String(b.id),
      { comment: str(b.comment), newClassId: str(b.newClassId) },
      req.user,
    );
    res.json(ok(r, r.finished ? '审批通过' : '已通过本环节'));
  }),
);

/* ============================================================
 * 10. 驳回  POST /api/teaching/leave/reject
 * ============================================================ */

teachingLeaveRouter.post(
  '/reject',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = mustStage(b.stage);
    if (!str(b.id)) throw new BizError(BizCode.PARAM_ERROR, '缺少 id');
    if (!str(b.reason)) throw new BizError(BizCode.PARAM_ERROR, '驳回原因必填');
    res.json(ok(await svc.reject(stage, String(b.id), String(b.reason), req.user), '已驳回'));
  }),
);

/* ============================================================
 * 11. 撤回  POST /api/teaching/leave/cancel
 * ============================================================ */

teachingLeaveRouter.post(
  '/cancel',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = mustStage(b.stage);
    if (!str(b.id)) throw new BizError(BizCode.PARAM_ERROR, '缺少 id');
    res.json(ok(await svc.cancel(stage, String(b.id), str(b.reason), req.user), '已撤回'));
  }),
);
