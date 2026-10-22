/**
 * 流程管理路由（教学管理初高）
 *
 * 覆盖：flow list/detail/submit/approve（按 flowType 落库副作用）/reject + repeat list/add。
 * 表：t_class_flow、t_class_flow_log、t_class_repeat。
 * 挂载：flowRouter → /api/class/flow；repeatRouter → /api/class/repeat。
 *
 * 状态机：flow_status 1待提交 / 2待经理审批 / 3已同意 / 4已驳回（复用 SuspendStatus）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  FLOW_TYPE_NAME,
  SUSPEND_STATUS_NAME,
  HANDOVER_ROLE_NAME,
} from 'shared-types/class-jh';
import { FlowType, SuspendStatus, StudentStatus, HandoverRole, AgreementStatus } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { applyRepeatEffect, createRepeatFlow } from './student.route';
import { createQuitRefund } from './refund.route';
// ★ P4 切读层：本文件各表均已归一，裸 db() 全部走 tbl()/tblIns()；开关关时逐字节等价。
import { tbl, tblIns, phaseCodeCol, readPhaseCode } from '../../teaching/shared/uniTable';

export const flowRouter = Router();
export const repeatRouter = Router();

const TABLE = 't_class_flow';
const LOG_TABLE = 't_class_flow_log';
const REPEAT_TABLE = 't_class_repeat';
const STUDENT_TABLE = 't_class_student';
const CLASS_TABLE = 't_class_info';
const HANDOVER_TABLE = 't_class_handover';

const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/** 「已同意」需施加的学生/班级副作用（按 flowType） */
const FLOW_STATUS_APPROVED = SuspendStatus.APPROVED; // 3
const FLOW_STATUS_REJECTED = SuspendStatus.REJECTED; // 4

function toFlow(r: any) {
  return {
    flowId: r.id,
    flowType: r.flow_type,
    flowTypeName: nameOf(FLOW_TYPE_NAME, r.flow_type),
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    classId: r.class_id,
    className: r.class_name,
    applyUserId: r.apply_user_id,
    applyUserName: r.apply_user_name,
    applyTime: r.apply_time,
    applyReason: r.apply_reason,
    flowStatus: r.flow_status,
    flowStatusName: nameOf(SUSPEND_STATUS_NAME, r.flow_status),
    currentNodeName: r.current_node_name,
    approveUserId: r.approve_user_id,
    approveUserName: r.approve_user_name,
    approveTime: r.approve_time,
    rejectReason: r.reject_reason,
    suspendStartDate: r.suspend_start_date,
    expectResumeDate: r.expect_resume_date,
    suspendReason: r.suspend_reason,
    idCardNo: r.id_card_no,
    phone: r.phone,
    attendedHours: r.attended_hours,
    resumeClassId: r.resume_class_id,
    resumeDate: r.resume_date,
    isMealDormRestored: r.is_meal_dorm_restored,
    fromClassId: r.from_class_id,
    toClassId: r.to_class_id,
    fromStage: r.from_stage,
    toStage: r.to_stage,
    transferReason: r.transfer_reason,
    handoverRole: r.handover_role,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    handoverReason: r.handover_reason,
    handoverContent: r.handover_content,
    handoverTime: r.handover_time,
    arrangeUserId: r.arrange_user_id,
    agreementStatus: r.agreement_status,
    signDate: r.sign_date,
    agreementFileUrl: r.agreement_file_url,
    // ★ 退学 → 退费 / 末班 → 通知（F-01 / F-02）
    refundFeeType: r.refund_fee_type,
    refundAmount: r.refund_amount,
    notifyUserId: r.notify_user_id,
    isNotified: r.is_notified,
  };
}

async function writeFlowLog(
  flowId: string,
  nodeName: string | null,
  approveResult: number,
  user?: { userId?: string; userName?: string },
  rejectReason?: string,
): Promise<void> {
  const now = new Date();
  await tblIns(db, DB, LOG_TABLE, STAGE, {
    id: randomUUID(),
    flow_id: flowId,
    node_name: nodeName,
    approve_user_id: user?.userId ?? null,
    approve_user_name: user?.userName ?? null,
    approve_time: now,
    approve_result: approveResult,
    reject_reason: rejectReason ?? null,
    is_deleted: false,
    create_time: now,
    create_by: user?.userId || 'system',
  });
}

/* ============================================================
 * 1. 流程列表
 *   GET /api/class/flow/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  flowType: z.coerce.number().int().optional(),
  flowStatus: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  applyUserId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

flowRouter.get(
  '/list',
  checkPermission('class:flow:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    if (q.flowType) query.andWhere('flow_type', q.flowType);
    if (q.flowStatus) query.andWhere('flow_status', q.flowStatus);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.applyUserId) query.andWhere('apply_user_id', q.applyUserId);
    if (q.startDate) query.andWhere('apply_time', '>=', `${q.startDate} 00:00:00`);
    if (q.endDate) query.andWhere('apply_time', '<=', `${q.endDate} 23:59:59`);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toFlow), Number(total), q));
  }),
);

/* ============================================================
 * 2. 流程详情（含审批日志）
 *   GET /api/class/flow/detail?id=xxx
 * ============================================================ */

flowRouter.get(
  '/detail',
  checkPermission('class:flow:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const flow = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!flow) throw new BizError(BizCode.FLOW_NOT_FOUND, '流程不存在');

    const logs = await tbl(db, DB, LOG_TABLE, STAGE).where({ flow_id: id, is_deleted: false }).orderBy('approve_time', 'asc');
    res.json(
      ok({
        ...toFlow(flow),
        logs: logs.map((l: any) => ({
          logId: l.id,
          flowId: l.flow_id,
          nodeName: l.node_name,
          approveUserId: l.approve_user_id,
          approveUserName: l.approve_user_name,
          approveTime: l.approve_time,
          approveResult: l.approve_result,
          rejectReason: l.reject_reason,
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3. 流程提交
 *   POST /api/class/flow/submit
 *   - 传 id：推进已有流程 1→2（待经理审批）
 *   - 不传 id：按 flowType 新建流程（flow_status=1）
 * ============================================================ */

const submitSchema = z.object({
  id: z.string().optional(),
  flowType: z.coerce.number().int().min(1).max(7).optional(),
  studentId: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  classId: z.string().optional(),
  applyReason: z.string().max(500).optional(),
  suspendStartDate: z.string().optional(),
  expectResumeDate: z.string().optional(),
  suspendReason: z.string().max(500).optional(),
  phone: z.string().max(20).optional(),
  attendedHours: z.coerce.number().int().optional(),
  idCardNo: z.string().max(32).optional(),
  resumeClassId: z.string().optional(),
  resumeDate: z.string().optional(),
  toClassId: z.string().optional(),
  fromClassId: z.string().optional(),
  toStage: z.coerce.number().int().optional(),
  fromStage: z.coerce.number().int().optional(),
  transferReason: z.string().max(500).optional(),
  handoverRole: z.coerce.number().int().min(1).max(2).optional(),
  toUserId: z.string().optional(),
  fromUserId: z.string().optional(),
  handoverReason: z.string().max(500).optional(),
  handoverContent: z.string().max(1000).optional(),
  handoverTime: z.string().optional(),
  arrangeUserId: z.string().optional(),
  agreementStatus: z.coerce.number().int().min(1).max(3).optional(),
  signDate: z.string().optional(),
  agreementFileUrl: z.string().max(255).optional(),
  // ★ 退学 → 退费（F-01）：审批通过后据此自动生成退费单
  refundFeeType: z.coerce.number().int().min(1).max(4).optional(),
  refundAmount: z.coerce.number().int().positive('退费金额必须为正整数（分）').optional(),
  // ★ 末班通知（F-02）
  notifyUserId: z.string().optional(),
  isNotified: z.coerce.boolean().optional(),
}).refine(
  (v) => v.flowType !== FlowType.QUIT || (!!v.refundFeeType && !!v.refundAmount),
  { message: '退学流程必须填写「退费类型」与「退费金额」', path: ['refundAmount'] },
).refine(
  (v) => v.flowType !== FlowType.REPEAT || !!v.toClassId,
  { message: '末班流程必须选择「转入班级」', path: ['toClassId'] },
);

flowRouter.post(
  '/submit',
  checkPermission('class:flow:add'),
  validate(submitSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof submitSchema>;

    // ---- 情形 A：推进已有流程 1→2 ----
    if (body.id) {
      const flow = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
      if (!flow) throw new BizError(BizCode.FLOW_NOT_FOUND, '流程不存在');
      if (flow.flow_status !== SuspendStatus.DRAFT) {
        throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅「待提交」流程可提交');
      }
      await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
        flow_status: SuspendStatus.PENDING_MANAGER,
        suspend_status: SuspendStatus.PENDING_MANAGER,
        current_node_name: '待经理审批',
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      await writeFlowLog(body.id, '提交', 1, req.user);
      res.json(ok({ flowId: body.id }, '提交成功'));
      return;
    }

    // ---- 情形 B：新建流程 ----
    if (!body.flowType || !body.studentId) {
      throw new BizError(BizCode.PARAM_ERROR, '请传 id（推进已有流程），或 flowType + studentId（新建流程）');
    }

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (stu.pending_flow_type) {
      throw new BizError(BizCode.DUPLICATE_SUBMIT, '该学生已有审批中的流程，请勿重复提交');
    }

    const now = new Date();
    const flowId = randomUUID();
    await tblIns(db, DB, TABLE, STAGE, {
      id: flowId,
      flow_type: body.flowType,
      student_id: stu.id,
      student_no: body.studentNo ?? stu.student_no,
      student_name: body.studentName ?? stu.student_name,
      class_id: body.classId ?? stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      apply_user_id: req.user?.userId ?? null,
      apply_user_name: req.user?.userName ?? null,
      apply_time: now,
      apply_reason: body.applyReason ?? body.suspendReason ?? null,
      flow_status: SuspendStatus.DRAFT,
      suspend_status: SuspendStatus.DRAFT,
      current_node_name: '待提交',
      suspend_start_date: body.suspendStartDate ?? null,
      expect_resume_date: body.expectResumeDate ?? null,
      suspend_reason: body.suspendReason ?? null,
      id_card_no: body.idCardNo ?? stu.id_card_no ?? null,
      phone: body.phone ?? stu.phone ?? null,
      attended_hours: body.attendedHours ?? null,
      resume_class_id: body.resumeClassId ?? null,
      resume_date: body.resumeDate ?? null,
      from_class_id: body.fromClassId ?? stu.class_id ?? null,
      to_class_id: body.toClassId ?? null,
      from_stage: body.fromStage ?? readPhaseCode(stu) ?? null,
      to_stage: body.toStage ?? null,
      transfer_reason: body.transferReason ?? null,
      handover_role: body.handoverRole ?? null,
      from_user_id: body.fromUserId ?? null,
      to_user_id: body.toUserId ?? null,
      handover_reason: body.handoverReason ?? null,
      handover_content: body.handoverContent ?? null,
      handover_time: body.handoverTime ? new Date(body.handoverTime) : null,
      arrange_user_id: body.arrangeUserId ?? null,
      agreement_status: body.agreementStatus ?? null,
      sign_date: body.signDate ?? null,
      agreement_file_url: body.agreementFileUrl ?? null,
      refund_fee_type: body.refundFeeType ?? null,
      refund_amount: body.refundAmount ?? null,
      notify_user_id: body.notifyUserId ?? null,
      is_notified: body.isNotified ?? false,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: stu.id }).update({
      pending_flow_type: body.flowType,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeFlowLog(flowId, '提交', 1, req.user);

    res.json(ok({ flowId }, '提交成功'));
  }),
);

/* ============================================================
 * 4. 流程审批（按 flowType 落库副作用）
 *   POST /api/class/flow/approve
 * ============================================================ */

/** 按流程类型施加副作用 */
async function applyFlowSideEffects(flow: any, user?: { userId?: string; userName?: string }): Promise<void> {
  const now = new Date();
  const uid = user?.userId;

  switch (flow.flow_type) {
    case FlowType.SUSPEND: {
      // 休学：学生 → 6，清 pending
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        student_status: StudentStatus.SUSPENDED,
        pending_flow_type: null,
        update_time: now,
        update_by: uid || 'system',
      });
      break;
    }
    case FlowType.RESUME: {
      // 复学：学生 → 5，切班级/阶段，清 pending，恢复餐宿费标记
      const cls = flow.resume_class_id
        ? await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: flow.resume_class_id, is_deleted: false }).first()
        : null;
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        student_status: StudentStatus.STUDYING,
        class_id: cls?.id ?? flow.resume_class_id ?? null,
        class_name: cls?.class_name ?? null,
        [phaseCodeCol()]: readPhaseCode(cls) ?? flow.to_stage ?? null,
        pending_flow_type: null,
        update_time: now,
        update_by: uid || 'system',
      });
      await tbl(db, DB, TABLE, STAGE).where({ id: flow.id }).update({ is_meal_dorm_restored: true, update_time: now });
      break;
    }
    case FlowType.TRANSFER: {
      // 转班：切班级/阶段，清 pending
      const toCls = flow.to_class_id
        ? await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: flow.to_class_id, is_deleted: false }).first()
        : null;
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        class_id: toCls?.id ?? flow.to_class_id ?? null,
        class_name: toCls?.class_name ?? null,
        [phaseCodeCol()]: readPhaseCode(toCls) ?? flow.to_stage ?? null,
        pending_flow_type: null,
        update_time: now,
        update_by: uid || 'system',
      });
      break;
    }
    case FlowType.QUIT: {
      // 退学：学生 → 7，清 pending
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        student_status: StudentStatus.QUIT,
        pending_flow_type: null,
        update_time: now,
        update_by: uid || 'system',
      });
      // ★ F-01：退学审批通过 → 自动生成「待提交」退费单，衔接「教务核算 → 财务退款」
      const quitStu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id, is_deleted: false }).first();
      if (quitStu) {
        await createQuitRefund(quitStu, {
          feeType: flow.refund_fee_type ?? 1,
          refundAmount: Number(flow.refund_amount ?? 0),
          applyDate: now.toISOString().slice(0, 10),
          applyUserId: flow.apply_user_id ?? uid,
          applyUserName: flow.apply_user_name ?? user?.userName,
        });
      }
      break;
    }
    case FlowType.HANDOVER: {
      // 换人：更新班级岗位 + 生成交接记录
      if (flow.class_id && flow.to_user_id) {
        const isHead = flow.handover_role === HandoverRole.HEAD_TEACHER;
        await tbl(db, DB, CLASS_TABLE, STAGE)
          .where({ id: flow.class_id })
          .update(isHead ? { head_teacher_id: flow.to_user_id, update_time: now } : { teacher_id: flow.to_user_id, update_time: now });
        await tblIns(db, DB, HANDOVER_TABLE, STAGE, {
          id: randomUUID(),
          class_id: flow.class_id,
          class_name: flow.class_name ?? null,
          handover_role: flow.handover_role ?? HandoverRole.HEAD_TEACHER,
          from_user_id: flow.from_user_id ?? null,
          to_user_id: flow.to_user_id,
          handover_reason: flow.handover_reason ?? null,
          handover_content: flow.handover_content ?? '（换人流程审批通过）',
          handover_time: flow.handover_time ?? now,
          arrange_user_id: flow.arrange_user_id ?? uid ?? null,
          is_deleted: false,
          create_time: now,
          create_by: uid || 'system',
        });
      }
      break;
    }
    case FlowType.AGREEMENT: {
      // 就业协议：存档到学生（只读展示）
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        agreement_status: flow.agreement_status ?? AgreementStatus.SIGNED,
        pending_flow_type: null,
        update_time: now,
        update_by: uid || 'system',
      });
      break;
    }
    case FlowType.REPEAT: {
      // 末班（F-02）：审批通过后才生效 —— 改班级/阶段 + 累计次数 + 写末班记录
      if (flow.to_class_id) {
        await applyRepeatEffect(
          flow.student_id,
          flow.to_class_id,
          flow.apply_reason || '末班',
          user,
          flow.notify_user_id ?? null,
          !!flow.is_notified,
        );
      }
      break;
    }
    default:
      break;
  }
}

flowRouter.post(
  '/approve',
  checkPermission('class:flow:approve'),
  validate(z.object({ id: z.string().min(1, '必须传 id'), remark: z.string().max(500).optional() })),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; remark?: string };
    const flow = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!flow) throw new BizError(BizCode.FLOW_NOT_FOUND, '流程不存在');
    if (![SuspendStatus.DRAFT, SuspendStatus.PENDING_MANAGER].includes(flow.flow_status)) {
      throw new BizError(
        BizCode.ILLEGAL_STATE_TRANSITION,
        `当前流程状态「${nameOf(SUSPEND_STATUS_NAME, flow.flow_status)}」不可审批`,
      );
    }

    const beforeStatus = flow.flow_status;
    await applyFlowSideEffects(flow, req.user);

    const now = new Date();
    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      flow_status: FLOW_STATUS_APPROVED,
      suspend_status: FLOW_STATUS_APPROVED,
      current_node_name: '已同意',
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeFlowLog(body.id, '审批', 1, req.user);

    await writeOpLog({
      module: 'flow',
      bizType: nameOf(FLOW_TYPE_NAME, flow.flow_type),
      bizId: body.id,
      studentId: flow.student_id,
      classId: flow.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `流程「${nameOf(FLOW_TYPE_NAME, flow.flow_type)}」审批通过`,
      beforeValue: { flowStatus: beforeStatus },
      afterValue: { flowStatus: FLOW_STATUS_APPROVED },
    });

    res.json(ok(null, '审批通过'));
  }),
);

/* ============================================================
 * 5. 流程驳回（→4）
 *   POST /api/class/flow/reject
 * ============================================================ */

flowRouter.post(
  '/reject',
  checkPermission('class:flow:approve'),
  validate(z.object({ id: z.string().min(1, '必须传 id'), rejectReason: z.string().min(1, '驳回原因必填') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as { id: string; rejectReason: string };
    const flow = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!flow) throw new BizError(BizCode.FLOW_NOT_FOUND, '流程不存在');
    if (![SuspendStatus.DRAFT, SuspendStatus.PENDING_MANAGER].includes(flow.flow_status)) {
      throw new BizError(
        BizCode.ILLEGAL_STATE_TRANSITION,
        `当前流程状态「${nameOf(SUSPEND_STATUS_NAME, flow.flow_status)}」不可驳回`,
      );
    }

    const now = new Date();
    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      flow_status: FLOW_STATUS_REJECTED,
      suspend_status: FLOW_STATUS_REJECTED,
      current_node_name: '已驳回',
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      reject_reason: body.rejectReason,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    // 清空学生 pending_flow_type（审批期间学生状态未变，仅挂起标记）
    if (flow.student_id) {
      await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: flow.student_id }).update({
        pending_flow_type: null,
        update_time: now,
        update_by: req.user?.userId || 'system',
      });
    }

    await writeFlowLog(body.id, '驳回', 2, req.user, body.rejectReason);

    await writeOpLog({
      module: 'flow',
      bizType: nameOf(FLOW_TYPE_NAME, flow.flow_type),
      bizId: body.id,
      studentId: flow.student_id,
      classId: flow.class_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `流程「${nameOf(FLOW_TYPE_NAME, flow.flow_type)}」驳回：${body.rejectReason}`,
      beforeValue: { flowStatus: flow.flow_status },
      afterValue: { flowStatus: FLOW_STATUS_REJECTED },
    });

    res.json(ok(null, '已驳回'));
  }),
);

/* ============================================================
 * 6. 末班列表
 *   GET /api/class/repeat/list
 * ============================================================ */

const repeatListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentId: z.string().optional(),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

repeatRouter.get(
  '/list',
  checkPermission('class:repeat:view'),
  validate(repeatListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof repeatListSchema>;
    const query = tbl(db, DB, REPEAT_TABLE, STAGE).where('is_deleted', false);
    if (q.studentId) query.andWhere('student_id', q.studentId);
    if (q.classId) query.andWhere((qb) => qb.where('from_class_id', q.classId).orWhere('to_class_id', q.classId));
    if (q.startDate) query.andWhere('repeat_time', '>=', `${q.startDate} 00:00:00`);
    if (q.endDate) query.andWhere('repeat_time', '<=', `${q.endDate} 23:59:59`);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('repeat_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      repeatId: r.id,
      studentId: r.student_id,
      studentNo: r.student_no,
      studentName: r.student_name,
      fromClassId: r.from_class_id,
      fromClassName: r.from_class_name,
      fromStage: r.from_stage,
      toClassId: r.to_class_id,
      toClassName: r.to_class_name,
      toStage: r.to_stage,
      repeatReason: r.repeat_reason,
      repeatTime: r.repeat_time,
      repeatCount: r.repeat_count,
      notifyUserId: r.notify_user_id,
      isNotified: r.is_notified,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 7. 末班新增（改走审批流：创建待提交流程）
 *   POST /api/class/repeat/add
 * ============================================================ */

const repeatAddSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  toClassId: z.string().min(1, '转入班级必填'),
  repeatReason: z.string().min(1, '末班原因必填'),
  notifyUserId: z.string().optional(),
  isNotified: z.coerce.boolean().optional(),
});

repeatRouter.post(
  '/add',
  checkPermission('class:repeat:add'),
  validate(repeatAddSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof repeatAddSchema>;
    const flowId = await createRepeatFlow(body, req.user);
    res.json(ok({ flowId }, '末班申请已提交'));
  }),
);

export default flowRouter;
