/**
 * 退费路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/refund
 * 表：t_job_refund（退费申请）+ t_job_approval（审批单，共用）
 * 字段依据：`D:\产品经理\就业模块.xmind`「退费」+ 斌哥 2026-09-29 确认
 *
 * ============================================================
 * 【业务规则（斌哥 2026-09-29 拍板）】
 * ============================================================
 *   审批链：班主任发起 → 学管审批 → 校长审批 → 财务直接退费
 *   ⚠️ 每笔都走校长，不设金额阈值。
 *
 *   ★ 页面是【班主任 / 学管 / 校长】三人共用：
 *       班主任 = 只能发申请 + 撤回自己没被批的
 *       学管   = 只能审批（第 1 步）
 *       校长   = 只能审批（第 2 步）
 *
 *   ★★ 关键：班主任【看不到审批按钮】
 *       前端：canApprove 字段控制按钮显隐
 *       后端：approve/reject 里走 approval.ts 的 canApprove() 拦截
 *       （★ 前端藏按钮 ≠ 权限控制，后端必须拦）
 *
 * ============================================================
 * 【「学管」是哪个角色】
 * ============================================================
 *   斌哥拍板方案 A：学管 = 教质经理 / 学术经理 的另一种叫法，不新增角色。
 *   见 shared-types/src/approval.ts 的 XUE_GUAN_ROLES。
 *
 * ⚠️ 铁律：金额一律用「分」（整数）存，前端展示时 ÷100
 * ⚠️ 铁律：逻辑删除，禁物理删除
 * ⚠️ 铁律：枚举双返回（refundType + refundTypeName）
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  ApprovalBizType,
  ApprovalStatus,
  APPROVAL_STATUS_NAME,
  REFUND_TYPE_NAME,
  DEPT_NAME,
  canApprove,
  canInitiate,
  isFinished,
  isMyApproval,
  hasRole,
  RoleCode,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import {
  createApproval,
  submitApproval,
  doApprove,
  doReject,
  doCancel,
  getApprovalLogs,
  buildChainNodes,
  getApproval,
  APPROVAL_TABLE,
  type Operator,
} from '../utils/approval';
// ★ 2026-10-08：审批通过 → 推财务建退费单（修「财务那边没有记录」，见 pushRefundToFinance）
import { applyRefundToFinance } from '../utils/financeClient';
// ★ P3 切读层：本文件各表（t_job_refund / t_student_base / t_job_class / t_job_approval）
//   都已归一，全部走 tbl()/tblAs()/tblRef()/tblTrx()/tblInsTrx() 路由；
//   开关关时与原实现逐字节等价。
import { tbl, tblAs, tblInsTrx, tblRef, tblTrx } from '../teaching/shared/uniTable';

export const refundRouter = Router();

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 表名常量 */
const TABLE = 't_job_refund';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';
const ATT_SUM_TABLE = 't_job_attendance_summary';

const BIZ = ApprovalBizType.REFUND;

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 从 req.user 提取操作人 */
function getOperator(req: any): Operator {
  const u = req.user;
  if (!u) throw new BizError(BizCode.UNAUTHORIZED, '请先登录');
  return { userId: u.userId, userName: u.userName, roles: u.roles || [] };
}

/** 金额（分）转展示文本，如 150000 → "1,500.00" */
function amountText(cent: number | string | null | undefined): string {
  const n = Number(cent || 0);
  const yuan = (n / 100).toFixed(2);
  const [int, dec] = yuan.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}


/**
 * 数据库行 → 前端对象（详情）
 */
function decorate(row: any): any {
  if (!row) return row;
  return {
    id: row.id,

    studentId: row.student_id,
    studentNo: row.student_no || '',
    studentName: row.student_name || '',
    classId: row.class_id || null,
    className: row.class_name || null,
    deptName: row.dept_name || (row.dept_code ? DEPT_NAME[row.dept_code] : null) || null,
    deptCode: row.dept_code ?? null,

    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,

    refundType: row.refund_type,
    refundTypeName: REFUND_TYPE_NAME[row.refund_type] || '',
    refundAmount: Number(row.refund_amount || 0),
    refundAmountText: amountText(row.refund_amount),

    // ★ 「退学退费」合并单的三项明细（2026-10-01）——
    //   只有退学自动生成的单子会填，其余单子这三项是 null。
    tuitionAmount: row.tuition_amount != null ? Number(row.tuition_amount) : null,
    tuitionAmountText: row.tuition_amount != null ? amountText(row.tuition_amount) : null,
    accommodationAmount: row.accommodation_amount != null ? Number(row.accommodation_amount) : null,
    accommodationAmountText:
      row.accommodation_amount != null ? amountText(row.accommodation_amount) : null,
    mealAmount: row.meal_amount != null ? Number(row.meal_amount) : null,
    mealAmountText: row.meal_amount != null ? amountText(row.meal_amount) : null,

    applyDate: fmtDate(row.apply_date),
    refundReason: row.refund_reason || '',

    approvalId: row.approval_id || null,
    approvalStatus: row.approval_status,
    approvalStatusName: APPROVAL_STATUS_NAME[row.approval_status] || '',

    financeRemark: row.finance_remark || null,
    refundTime: row.refund_time ? fmtDateTime(row.refund_time) : null,

    remark: row.remark || null,
    createTime: row.create_time ? fmtDateTime(row.create_time) : null,
    updateTime: row.update_time ? fmtDateTime(row.update_time) : null,
  };
}

/**
 * 列表项：附「这条我能不能审批 / 能不能撤回」
 *
 * ★ 这是前端控制按钮显隐的依据。
 *   班主任的 roles 里没有学管/校长角色 → canApprove = false → 不显示审批按钮。
 */
function decorateListItem(row: any, operator: Operator, approvalRow: any): any {
  const base = decorate(row);
  let canApproveIt = false;
  let canCancelIt = false;
  let canSubmitIt = false;

  // ★ isMyApproval：系统自动生成的单子申请人是「业务责任人」而非当前点开的人，
  //   万能测试号全放行才能验证「生成 → 提交 → 审批」整条链路。
  const isMine = isMyApproval(approvalRow, operator.userId, operator.roles);

  if (approvalRow && !isFinished(approvalRow.status) && approvalRow.status !== ApprovalStatus.DRAFT) {
    canApproveIt = canApprove(BIZ, approvalRow.current_step, operator.roles);
  }
  // 撤回：本人发起、**已提交**且还没结束
  if (
    approvalRow &&
    !isFinished(approvalRow.status) &&
    approvalRow.status !== ApprovalStatus.DRAFT &&
    isMine
  ) {
    canCancelIt = true;
  }
  // ★ 提交：状态是「待提交（草稿）」+ 本人发起
  //   ⚠️ 2026-10-01 修正：以前这里错误地把 DRAFT 也塞进 canCancel，
  //      导致「待提交」的单在页面上只显示一个「撤回」按钮、**没有「提交」**。
  //      班级结业自动生成的住宿费退费单正好卡在这种状态，老师根本提交不了。
  if (approvalRow && approvalRow.status === ApprovalStatus.DRAFT && isMine) {
    canSubmitIt = true;
  }

  return {
    id: base.id,
    studentId: base.studentId,
    studentNo: base.studentNo,
    studentName: base.studentName,
    className: base.className,
    deptName: base.deptName,
    headTeacherName: base.headTeacherName,
    refundType: base.refundType,
    refundTypeName: base.refundTypeName,
    refundAmount: base.refundAmount,
    refundAmountText: base.refundAmountText,
    applyDate: base.applyDate,
    refundReason: base.refundReason,
    approvalId: base.approvalId,
    approvalStatus: base.approvalStatus,
    approvalStatusName: base.approvalStatusName,
    currentHandlerHint: approvalRow?.current_handler_hint || null,
    canApprove: canApproveIt,
    canCancel: canCancelIt,
    canSubmit: canSubmitIt,
  };
}

/* ============================================================
 * 1. 退费列表
 *    GET /api/job/refund/page
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().optional(),
  classId: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  refundType: z.coerce.number().int().optional(),
  approvalStatus: z.coerce.number().int().optional(),
  onlyMine: z.coerce.boolean().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

refundRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const operator = getOperator(req);

    // ⚠️ 必须【始终】leftJoin 审批表 ——
    //    因为列表要算 canApprove（要看审批单的 status / current_step），
    //    只在 onlyMine 时 join 会导致 select 引用不存在的别名，直接报 50002。
    const query = tblAs(db, DB, TABLE, STAGE, 'r')
      .leftJoin(`${tblRef(DB, APPROVAL_TABLE)} as a`, 'r.approval_id', 'a.id')
      .where('r.is_deleted', false);

    if (q.keyword) {
      query.andWhere((b: import('knex').Knex.QueryBuilder) => {
        b.where('r.student_name', 'like', `%${q.keyword}%`)
          .orWhere('r.student_no', 'like', `%${q.keyword}%`);
      });
    }
    if (q.classId) query.andWhere('r.class_id', q.classId);
    if (q.deptCode) query.andWhere('r.dept_code', q.deptCode);
    if (q.refundType) query.andWhere('r.refund_type', q.refundType);
    if (q.approvalStatus) query.andWhere('r.approval_status', q.approvalStatus);
    if (q.startDate) query.andWhere('r.apply_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('r.apply_date', '<=', q.endDate);

    // ★ 只看"待我审批"：按"当前步骤我能不能批"过滤
    if (q.onlyMine) {
      query.whereNotIn('a.status', [
        ApprovalStatus.DRAFT,
        ApprovalStatus.APPROVED,
        ApprovalStatus.REJECTED,
        ApprovalStatus.CANCELED,
      ]);

      // 按角色过滤：第1步只给学管看，第2步只给校长看
      const stepsIcanHandle: number[] = [];
      for (let s = 1; s <= 2; s++) {
        if (canApprove(BIZ, s, operator.roles)) stepsIcanHandle.push(s);
      }
      if (!stepsIcanHandle.length) {
        // 没有任何审批权 → 直接返回空
        res.json(page([], 0, q));
        return;
      }
      query.whereIn('a.current_step', stepsIcanHandle);
    } else {
      /* ============================================================
       * ★ 2026-10-08 数据范围隔离（斌哥拍板：项目经理只限自己带的实训班）
       *
       * 【为什么必须加】
       *   本接口此前**没有任何范围过滤** —— 任何登录用户拉 /page
       *   都能看到全部 20 张退费单。实测项目经理 sunjl 看到 4 个班的单子。
       *
       * 【口径】与 dorm.route / student.route 保持一致
       *   · 管理员/学管/校长 → 不限
       *   · 项目经理        → 只看自己带的实训班（按退费单上的 head_teacher_id
       *                       判定 —— 发起时已写成项目经理本人，见本文件 443 行）
       *   · 班主任          → 只看自己带的（head_teacher_id = 我）
       * ============================================================ */
      const _r = operator.roles;
      const _isAdmin = hasRole(_r, RoleCode.SYS_ADMIN);
      const _isDean = hasRole(_r, RoleCode.TEACH_DEAN);
      const _isPrincipal = hasRole(_r, RoleCode.RM_PRINCIPAL);
      const _isPM = hasRole(_r, RoleCode.PROJECT_MANAGER);
      const _isHead = hasRole(_r, RoleCode.TEACH_HEAD);

      if (!_isAdmin && !_isDean && !_isPrincipal) {
        if (_isPM) {
          // 项目经理：只限自己带的实训班（含已结业）
          const mine = await tbl(db, DB, CLASS_TABLE, STAGE)
            .where({ project_manager_id: operator.userId, is_deleted: false })
            .select('id');
          const ids = mine.map((c: any) => c.id);
          query.andWhere((b: import('knex').Knex.QueryBuilder) =>
            b
              .where('r.head_teacher_id', operator.userId)
              .orWhereIn('r.class_id', ids.length ? ids : ['__none__']),
          );
        } else if (_isHead) {
          query.andWhere('r.head_teacher_id', operator.userId);
        }
      }
    }

    const [{ total }] = await query.clone().count({ total: 'r.id' });

    const rows = await query
      .clone()
      .select(
        'r.*',
        'a.status as _a_status',
        'a.current_step as _a_step',
        'a.current_handler_hint as _a_hint',
        'a.applicant_id as _a_applicant',
      )
      .orderBy('r.create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) =>
      decorateListItem(r, operator, {
        status: r._a_status,
        current_step: r._a_step,
        current_handler_hint: r._a_hint,
        applicant_id: r._a_applicant,
      }),
    );

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 退费详情（含审批轨迹 + 流程条）
 *    GET /api/job/refund/detail?id=xxx
 * ============================================================ */

refundRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '退费单ID必传') })),
  wrap(async (req, res) => {
    const q = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: q.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

    const appr = row.approval_id ? await getApproval(row.approval_id) : null;
    const logs = row.approval_id ? await getApprovalLogs(row.approval_id) : [];
    const chainNodes = appr ? await buildChainNodes(BIZ, appr) : [];

    const base = decorate(row);

    let canApproveIt = false;
    let canCancelIt = false;
    let canSubmitIt = false;
    const isMine = isMyApproval(appr, operator.userId, operator.roles);

    if (appr && !isFinished(appr.status) && appr.status !== ApprovalStatus.DRAFT) {
      canApproveIt = canApprove(BIZ, appr.current_step, operator.roles);
    }
    // 撤回：本人发起、已提交且还没结束
    if (appr && !isFinished(appr.status) && appr.status !== ApprovalStatus.DRAFT && isMine) {
      canCancelIt = true;
    }
    // ★ 提交：待提交（草稿）+ 本人发起（2026-10-01 新增）
    if (appr && appr.status === ApprovalStatus.DRAFT && isMine) {
      canSubmitIt = true;
    }

    res.json(
      ok({
        ...base,
        canApprove: canApproveIt,
        canCancel: canCancelIt,
        canSubmit: canSubmitIt,
        currentStep: appr?.current_step || 0,
        totalSteps: chainNodes.length,
        chainNodes,
        logs: logs.map((l: any) => ({
          id: l.id,
          step: l.step,
          nodeName: l.node_name,
          operatorId: l.operator_id,
          operatorName: l.operator_name,
          operatorRole: l.operator_role,
          action: l.action,
          actionName: l.action_name,
          comment: l.comment,
          createTime: l.create_time ? fmtDateTime(l.create_time) : null,
          avatarText: (l.operator_name || '?').slice(0, 1),
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 新建退费申请（班主任）
 *    POST /api/job/refund/create
 *
 * 流程：
 *   ① 校验学生存在
 *   ② 取学生/班级/班主任 快照
 *   ③ 建退费单（草稿）
 *   ④ 建审批单（草稿）
 *   ⑤ 关联起来
 * ============================================================ */

const createSchema = z.object({
  studentId: z.string().min(1, '学生必选'),
  refundType: z.number().int().min(1).max(9),
  refundAmount: z.number().int().min(0, '退费金额不能为负'),
  applyDate: z.string().optional(),
  refundReason: z.string().min(1, '退费原因必填').max(500),
  remark: z.string().max(500).optional(),
  /** 是否直接提交（true = 建完就提交审批）*/
  submit: z.boolean().optional(),
});

refundRouter.post(
  '/create',
  validate(createSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof createSchema>;
    const operator = getOperator(req);

    // ★ 只有班主任能发起
    if (!canInitiate(BIZ, operator.roles)) {
      throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有班主任 / 项目经理能发起退费申请');
    }

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    let cls: any = null;
    if (stu.class_id) {
      cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id, is_deleted: false }).first();
    }

    const refundId = randomUUID();
    const now = new Date();
    const applyDate = body.applyDate || today();

    await db.transaction(async (trx) => {

      // ③ 建退费单（先草稿）
      await tblInsTrx(trx, DB, TABLE, STAGE, {
        id: refundId,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,


        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        class_id: cls?.id || stu.class_id || null,
        class_name: cls?.class_name || stu.class_name || null,
        // ⚠️ t_job_class 没有 dept_name 字段 —— 这里以前写的是 cls?.dept_name（恒为 undefined）
        //    → 结果退费单的「部门」列永远存空。必须用 dept_code 映射。
        dept_name: DEPT_NAME[cls?.dept_code ?? stu.dept_code] || null,
        dept_code: cls?.dept_code ?? stu.dept_code ?? null,

        // ★ 2026-10-08 修：「发起人」字段要按发起者身份正确落库。
        //   原来无条件写 `cls.head_teacher_id || operator.userId`，
        //   导致**项目经理发起的单子被记到实训班班主任名下**（那是别人），
        //   审批人看到的名字是错的，而且本人后续可能因此"管不到自己提的单"。
        //   口径：谁发起就记谁 —— 项目经理发起 → 记项目经理；班主任发起 → 记班主任。
        head_teacher_id: hasRole(operator.roles, RoleCode.PROJECT_MANAGER)
          ? operator.userId
          : cls?.head_teacher_id || operator.userId,
        head_teacher_name: hasRole(operator.roles, RoleCode.PROJECT_MANAGER)
          ? operator.userName
          : cls?.head_teacher_name || operator.userName,

        refund_type: body.refundType,
        refund_type_name: REFUND_TYPE_NAME[body.refundType] || null,
        refund_amount: body.refundAmount,
        apply_date: applyDate,
        refund_reason: body.refundReason,

        approval_status: ApprovalStatus.DRAFT,
        remark: body.remark || null,
      });

      // ④ 建审批单
      const approvalId = await createApproval(
        {
          bizType: BIZ,
          bizId: refundId,
          applicant: operator,
          studentId: stu.id,
          studentNo: stu.student_no || undefined,
          studentName: stu.student_name || undefined,
          classId: cls?.id || stu.class_id || undefined,
          className: cls?.class_name || stu.class_name || undefined,
          deptCode: cls?.dept_code ?? undefined,
        },
        trx,
      );

      // ⑤ 关联
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: refundId }).update({ approval_id: approvalId });

      // ④' 直接提交
      if (body.submit) {
        await submitApproval(approvalId, operator, trx);
        await tblTrx(trx, DB, TABLE, STAGE).where({ id: refundId }).update({
          approval_status: ApprovalStatus.PENDING_MANAGER,
          update_time: now,
        });
      }
    });

    res.json(ok({ id: refundId }));
  }),
);

/* ============================================================
 * 4. 提交审批
 *    POST /api/job/refund/submit
 * ============================================================ */

refundRouter.post(
  '/submit',
  validate(
    z.object({
      id: z.string().min(1, '退费单ID必传'),
      /**
       * ★ 2026-10-01 新增：提交时顺便改金额（单位：分）
       *
       * 用途：班级结业自动生成的「住宿费退费单」——
       *   系统拿不到"已缴住宿费"（在财务 8005，接口未接通），生成时金额只能是 0，
       *   必须让班主任填了再提交。所以提交接口允许带一个金额。
       * ⚠️ 只有「待提交」的单能改金额。
       */
      refundAmount: z.coerce.number().int().min(0).optional(),
      /**
       * ★ 2026-10-01：「退学退费」合并单的三项明细（单位：分）
       *
       * 退学自动生成的单子含 学费 + 住宿费 + 餐费，
       * 班主任提交时分别填，总金额由后端求和写入 refund_amount。
       */
      tuitionAmount: z.coerce.number().int().min(0).optional(),
      accommodationAmount: z.coerce.number().int().min(0).optional(),
      mealAmount: z.coerce.number().int().min(0).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');
    if (row.approval_status !== ApprovalStatus.DRAFT) {
      throw new BizError(BizCode.APPROVAL_ALREADY_SUBMITTED, '该单已提交，不能重复提交');
    }

    const patch: Record<string, any> = {
      approval_status: ApprovalStatus.PENDING_MANAGER,
      update_time: new Date(),
      update_by: operator.userId,
    };

    // ★ 两种填法：
    //   ① 「退学退费」合并单 → 传三项明细，总金额由后端求和
    //   ② 普通单 → 传一个总额
    const hasDetail =
      body.tuitionAmount !== undefined ||
      body.accommodationAmount !== undefined ||
      body.mealAmount !== undefined;

    if (hasDetail) {
      const t = Number(body.tuitionAmount ?? 0);
      const a = Number(body.accommodationAmount ?? 0);
      const m = Number(body.mealAmount ?? 0);
      if (t + a + m <= 0) {
        throw new BizError(BizCode.PARAM_ERROR, '退费金额必须大于 0（学费/住宿费/餐费至少填一项）');
      }
      patch.tuition_amount = t;
      patch.accommodation_amount = a;
      patch.meal_amount = m;
      patch.refund_amount = t + a + m;
    } else if (body.refundAmount !== undefined) {
      if (Number(body.refundAmount) <= 0) {
        throw new BizError(BizCode.PARAM_ERROR, '退费金额必须大于 0');
      }
      patch.refund_amount = body.refundAmount;
    } else if (Number(row.refund_amount) <= 0) {
      throw new BizError(BizCode.PARAM_ERROR, '请先填写退费金额再提交');
    }

    await db.transaction(async (trx) => {
      await submitApproval(row.approval_id, operator, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update(patch);
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 5. 同意（学管 / 校长）
 *    POST /api/job/refund/approve
 *
 * ★ 后端拦截：approval.ts 的 doApprove 里会 canApprove()，
 *   班主任调这个接口一定被拒（403）。
 * ============================================================ */

/**
 * ★★ 2026-10-08 新增：审批全部通过 → 把退费单推给财务（8005）
 *
 * 【调用链】
 *   `POST /api/job/refund/approve`（本文件）→ 审批链 finished
 *     → 本函数 → `POST /api/finance/refund/apply`（财务建单）
 *     → 回写 `finance_refund_id` / `finance_refund_no`
 *
 * 【失败策略 —— 绝不阻断】
 *   财务挂了 / 超时 / 校验不过 → 只写日志 + 在 remark 追加一行提示，
 *   **不抛错、不回滚**。理由：本模块的审批已经完成，出款是财务的事，
 *   不该因为下游抖动让「审批结果」这个既成事实消失。
 *   （口径与 `consult/services/refund.service.ts` 的 reportToFinance 一致。）
 *
 * 【幂等】
 *   `finance_refund_id` 已有值 → 直接返回（重复审批/重放不会重复建单）。
 *
 * @param row      本地退费单（t_job_refund 那一行）
 * @param operator 操作人
 */
async function pushRefundToFinance(
  row: any,
  operator: { userId?: string; userName?: string },
): Promise<void> {
  // 幂等：已经推过就不再推
  if (row.finance_refund_id) return;

  /**
   * 退费项目：财务要求 `refundItems`（数组，值域 1-5）。
   *
   * 映射口径：
   *   · `refund_type = 6`（RefundType.QUIT，退学退费/结业合并单）
   *     → 拆成学费 + 住宿费 + 餐费三项中**金额大于 0** 的那些
   *   · 其余（1 学费 / 2 住宿费 / 3 餐费 / 4 保险费 / 5 试学费）
   *     → 单元素数组，直接透传（两边枚举值域一致）
   */
  const RefundTypeQuit = 6;
  let refundItems: number[] = [];
  if (Number(row.refund_type) === RefundTypeQuit) {
    if (Number(row.tuition_amount) > 0) refundItems.push(1);
    if (Number(row.accommodation_amount) > 0) refundItems.push(2);
    if (Number(row.meal_amount) > 0) refundItems.push(3);
  }
  // 合并单没填明细，或普通单 → 用 refund_type 本身（落到 1-5 内）
  if (!refundItems.length) {
    const t = Number(row.refund_type) || 1;
    refundItems = [t >= 1 && t <= 5 ? t : 1];
  }

  const amount = Number(row.refund_amount) || 0;
  // 财务要求 refundAmount > 0，金额为 0 的单没有出款意义 → 跳过（留日志）
  if (amount <= 0) {
    await tbl(db, DB, TABLE, STAGE)
      .where({ id: row.id })
      .update({
        finance_remark: '退费金额为 0，无需出款（审批已通过）',
        update_time: new Date(),
        update_by: operator.userId || null,
      });
    return;
  }

  /**
   * 退费原因：财务要求 `refundReason` 必填且 ≤255。
   *
   * ⚠️ 2026-10-08 实测踩坑：演示数据里 `t_job_refund.refund_reason`
   *    有些行存的是**纯数字枚举值**（如 `"2"`）而不是文字描述。
   *    直接透传 → 财务单上「退费原因」显示成 `2`，看单的人一头雾水。
   *    所以这里做一次净化：纯数字/空值 → 退化成可读文案（带单类型）。
   */
  const rawReason = String(row.refund_reason || '').trim();
  const isMeaningless = !rawReason || /^\d+$/.test(rawReason);
  const refundReason = (
    isMeaningless
      ? `实训${row.refund_type_name || '退费'}申请`
      : rawReason
  ).slice(0, 255);

  try {
    const res = await applyRefundToFinance({
      studentId: String(row.student_id || ''),
      studentNo: String(row.student_no || ''),
      studentName: String(row.student_name || ''),
      classId: row.class_id || undefined,
      className: row.class_name || undefined,
      deptCode: row.dept_code != null ? Number(row.dept_code) : undefined,
      refundItems,
      refundAmount: amount,
      refundReason,
      sourceType: 2, // 2 = 就业/实训来源
      remark: `就业模块退费单 ${row.id}（${row.refund_type_name || ''}）`,
    });

    await tbl(db, DB, TABLE, STAGE)
      .where({ id: row.id })
      .update({
        finance_refund_id: res.id || null,
        finance_refund_no: res.orderNo || null,
        update_time: new Date(),
        update_by: operator.userId || null,
      });

    // eslint-disable-next-line no-console
    console.log(`[退费推送财务] 成功：本地单 ${row.id} → 财务单 ${res.orderNo}`);
  } catch (err: any) {
    /**
     * ⚠️ 失败不阻断：审批已生效，出款由财务人工补录。
     *    在 remark 里留痕，便于运营/财务对照排查。
     */
    const tip = `⚠️ 已推财务失败（${err?.message || '未知错误'}），请在财务模块人工补录`;
    await tbl(db, DB, TABLE, STAGE)
      .where({ id: row.id })
      .update({
        finance_remark: tip.slice(0, 500),
        update_time: new Date(),
        update_by: operator.userId || null,
      })
      .catch(() => {
        /* 连留痕都失败也不抛 —— 主流程已成功 */
      });
    // eslint-disable-next-line no-console
    console.error('[退费推送财务] 失败：', row.id, err?.message);
  }
}

refundRouter.post(
  '/approve',
  validate(
    z.object({
      id: z.string().min(1, '退费单ID必传'),
      comment: z.string().max(500).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    let finished = false;
    let nextStatus = ApprovalStatus.PENDING_MANAGER;

    await db.transaction(async (trx) => {
      const result = await doApprove(row.approval_id!, operator, body.comment, trx);
      finished = result.finished;
      nextStatus = result.status;

      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: nextStatus,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    /**
     * ★★ 2026-10-08 修复（斌哥报的问题②：「就业模块退费审批通过后，财务那边没有记录」）
     *
     * 【原来什么样】
     *   这里曾经只有一句注释：
     *     「★ 全部通过 = 通知财务退费（本模块只改状态，出款是财务在 8005 做的）」
     *   注释下面直接结束 —— **从未有过任何推送代码**。所以财务侧永远没有记录。
     *
     * 【现在怎么修】
     *   `finished === true`（审批链全部走完）时，调用财务的
     *   `POST /api/finance/refund/apply` 建一张退费单，并把财务返回的
     *   单号回写本地（`finance_refund_id` / `finance_refund_no`）便于溯源。
     *
     * 【为什么放在事务【外】】
     *   · 财务是**另一个模块**（内网 HTTP），把外部调用放进本地事务，
     *     财务一旦超时（3 秒）会把整笔审批一起回滚 —— 审批白做了，非常糟。
     *   · 推财务失败**不回滚**：本模块的审批已生效，财务侧人工补录即可
     *     （与咨询模块 reportToFinance 的失败策略完全一致）。
     *   · 只记日志 + 在 remark 里留痕，不抛错给前端。
     *
     * ⚠️ 幂等：`finance_refund_id` 已有值 → 说明推过了，跳过（防重复推送）。
     */
    if (finished) {
      await pushRefundToFinance(row, operator);
    }

    res.json(ok({ finished, approvalStatus: nextStatus, approvalStatusName: APPROVAL_STATUS_NAME[nextStatus] || '' }));
  }),
);

/* ============================================================
 * 6. 驳回（学管 / 校长）
 *    POST /api/job/refund/reject
 *
 * ⚠️ 驳回必须填原因（斌哥要求：驳回原因发到班主任）
 * ============================================================ */

refundRouter.post(
  '/reject',
  validate(
    z.object({
      id: z.string().min(1, '退费单ID必传'),
      reason: z.string().min(1, '驳回原因必填').max(500),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    await db.transaction(async (trx) => {
      await doReject(row.approval_id!, operator, body.reason, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.REJECTED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 7. 撤回（申请人本人）
 *    POST /api/job/refund/cancel
 * ============================================================ */

refundRouter.post(
  '/cancel',
  validate(
    z.object({
      id: z.string().min(1, '退费单ID必传'),
      reason: z.string().max(500).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');
    if (!row.approval_id) throw new BizError(BizCode.APPROVAL_NOT_FOUND, '该单没有关联审批单');

    await db.transaction(async (trx) => {
      await doCancel(row.approval_id!, operator, body.reason, trx);
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: row.id }).update({
        approval_status: ApprovalStatus.CANCELED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 8. 财务确认出款（财务 8005 用 / 或本页财务同事点）
 *    POST /api/job/refund/finance-confirm
 *
 * ⚠️ 只有审批通过（已通过）的单子才能确认出款
 * ⚠️ 真正扣款动作在财务模块 8005，这里只记录"办完了"
 * ============================================================ */

refundRouter.post(
  '/finance-confirm',
  validate(
    z.object({
      id: z.string().min(1, '退费单ID必传'),
      financeRemark: z.string().max(500).optional(),
      refundTime: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const operator = getOperator(req);

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.REFUND_NOT_FOUND, '退费单不存在');

    if (row.approval_status !== ApprovalStatus.APPROVED) {
      throw new BizError(
        BizCode.APPROVAL_STATUS_NOT_ALLOW,
        `该单还没审批通过（当前：${APPROVAL_STATUS_NAME[row.approval_status]}），不能确认出款`,
      );
    }

    const now = new Date();
    await tbl(db, DB, TABLE, STAGE).where({ id: row.id }).update({
      finance_remark: body.financeRemark || null,
      refund_time: body.refundTime ? new Date(body.refundTime) : now,
      update_time: now,
      update_by: operator.userId,
    });

    res.json(ok(null));
  }),
);

/* ============================================================
 * 9. 可选学生（班主任选人下拉）
 *    GET /api/job/refund/student-options?keyword=xxx
 *
 * ⚠️ 真实场景要按"班主任自己的班"过滤（数据范围），
 *    现在先给全量，等数据范围做好再收紧。
 * ============================================================ */

refundRouter.get(
  '/student-options',
  validate(
    z.object({
      keyword: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false);

    if (q.keyword) {
      query.andWhere((b: import('knex').Knex.QueryBuilder) => {
        b.where('s.student_name', 'like', `%${q.keyword}%`).orWhere(
          's.student_no',
          'like',
          `%${q.keyword}%`,
        );
      });
    }

    const rows = await query
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        'c.class_name',
        'c.dept_code',
        // ⚠️⚠️ t_job_class 表【没有 dept_name 字段】（只有 dept_code）！
        //    部门名称必须用 DEPT_NAME[dept_code] 映射，**绝不能 select 'c.dept_name'**，
        //    否则报 50002「数据库字段不存在」——而且是在"打开弹窗选学生"时就炸。
        //    ★ 这个坑在 studentLeave.route.ts 已经踩过一次并留了注释，这里是重犯，务必记牢。
        'c.head_teacher_id',
        'c.head_teacher_name',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.limit);

    res.json(
      ok(
        rows.map((r: any) => ({
          studentId: r.student_id,
          studentNo: r.student_no,
          studentName: r.student_name,
          className: r.class_name || null,
          deptCode: r.dept_code ?? null,
          deptName: DEPT_NAME[r.dept_code] || null,
          headTeacherId: r.head_teacher_id || null,
          headTeacherName: r.head_teacher_name || null,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 10. 统计（列表页顶部卡片用）
 *     GET /api/job/refund/summary
 * ============================================================ */

refundRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const operator = getOperator(req);

    const totalRow = await tbl(db, DB, TABLE, STAGE).where('is_deleted', false).count({ c: 'id' }).first();

    const pendingMgr = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.PENDING_MANAGER })
      .count({ c: 'id' })
      .first();
    const pendingPrincipal = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.PENDING_PRINCIPAL })
      .count({ c: 'id' })
      .first();
    const approved = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.APPROVED })
      .count({ c: 'id' })
      .first();

    const amountRow = await tbl(db, DB, TABLE, STAGE)
      .where({ is_deleted: false, approval_status: ApprovalStatus.APPROVED })
      .sum({ s: 'refund_amount' })
      .first();

    // 待我审批的条数
    let myCount = 0;
    const stepsIcanHandle: number[] = [];
    for (let s = 1; s <= 2; s++) {
      if (canApprove(BIZ, s, operator.roles)) stepsIcanHandle.push(s);
    }
    if (stepsIcanHandle.length) {
      const r = await tblAs(db, DB, TABLE, STAGE, 'r')
        .join(`${tblRef(DB, APPROVAL_TABLE)} as a`, 'r.approval_id', 'a.id')
        .where('r.is_deleted', false)
        .whereNotIn('a.status', [
          ApprovalStatus.DRAFT,
          ApprovalStatus.APPROVED,
          ApprovalStatus.REJECTED,
          ApprovalStatus.CANCELED,
        ])
        .whereIn('a.current_step', stepsIcanHandle)
        .count({ c: 'r.id' })
        .first();
      myCount = Number(r?.c || 0);
    }

    res.json(
      ok({
        total: Number(totalRow?.c || 0),
        pendingMgr: Number(pendingMgr?.c || 0),
        pendingPrincipal: Number(pendingPrincipal?.c || 0),
        approved: Number(approved?.c || 0),
        approvedAmount: Number(amountRow?.s || 0),
        approvedAmountText: amountText(amountRow?.s),
        myPending: myCount,
      }),
    );
  }),
);
