/**
 * 工作台路由（教学管理初高）
 *
 * 覆盖：dashboard/stat（KPI + 待办）。
 * 挂载：/api/class/dashboard。
 */

import { Router } from 'express';
import { BizCode } from 'shared-types/class-jh';
import { StudentStatus, RefundStatus, SuspendStatus, ApplyStatus, PayStatus } from 'shared-types/class-jh';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { getNumberSetting } from '../utils/setting';
import { checkPermission } from '../middleware/auth';
// ★ P4 切读层：本文件六张初高表（t_class_student / t_class_attendance / t_class_fee /
//   t_class_flow / t_class_refund / t_class_dorm_apply）均已归一，全部走 tbl() 路由；
//   开关关时与原实现逐字节等价。
import { tbl } from '../../teaching/shared/uniTable';

export const statsRouter = Router();

const STUDENT_TABLE = 't_class_student';
const ATTENDANCE_TABLE = 't_class_attendance';
const FEE_TABLE = 't_class_fee';
const FLOW_TABLE = 't_class_flow';
const REFUND_TABLE = 't_class_refund';
const DORM_APPLY_TABLE = 't_class_dorm_apply';

/** ★ 统一表 edu_stage 取值（本路由只服务初高） */
const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/* ============================================================
 * 工作台统计
 *   GET /api/class/dashboard/stat
 * ============================================================ */

statsRouter.get(
  '/stat',
  checkPermission('class:student:view'),
  wrap(async (_req, res) => {
    // 1) 在读学生数（试学/预在读/正式在读）
    const [{ readingStudentCount }] = (await tbl(db, DB, STUDENT_TABLE, STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', [StudentStatus.TRIAL, StudentStatus.PRE_STUDY, StudentStatus.STUDYING])
      .count({ readingStudentCount: '*' })) as Array<{ readingStudentCount: number }>;

    // 2) 今日出勤率（取今日台账平均）
    const today = new Date().toISOString().slice(0, 10);
    const attRows = await tbl(db, DB, ATTENDANCE_TABLE, STAGE)
      .where({ attendance_date: today, is_deleted: false })
      .select('attendance_rate');
    const todayAttendanceRate = attRows.length
      ? Number((attRows.reduce((a: number, r: any) => a + (Number(r.attendance_rate) || 0), 0) / attRows.length).toFixed(2))
      : 0;

    // 3) 目标出勤率（配置）
    const attendanceTargetRate = await getNumberSetting('attendanceTargetRate');

    // 4) 紧急催费数（未结清且剩余天数 <= 阈值）
    //    ★ 2026-10-20：未结清补上「逾期(4)」—— 与催费列表的 UNPAID_STATUSES 同口径，
    //      否则列表里标着紧急、首页这个数字却不含这些行。
    const remindDays = await getNumberSetting('feeRemindDays');
    const feeRows = await tbl(db, DB, FEE_TABLE, STAGE)
      .where('is_deleted', false)
      .whereIn('pay_status', [PayStatus.UNPAID, PayStatus.OVERDUE, PayStatus.FROZEN])
      .select('expire_date');
    const todayZero = new Date();
    todayZero.setHours(0, 0, 0, 0);
    const urgentFeeCount = feeRows.filter((r: any) => {
      if (!r.expire_date) return false;
      const d = new Date(r.expire_date);
      d.setHours(0, 0, 0, 0);
      const remain = Math.round((d.getTime() - todayZero.getTime()) / (24 * 3600 * 1000));
      return remain <= remindDays;
    }).length;

    // 5) 待办
    const [{ pendingFlow }] = (await tbl(db, DB, FLOW_TABLE, STAGE)
      .where('is_deleted', false)
      .whereIn('flow_status', [SuspendStatus.DRAFT, SuspendStatus.PENDING_MANAGER])
      .count({ pendingFlow: '*' })) as Array<{ pendingFlow: number }>;
    const [{ pendingRefund }] = (await tbl(db, DB, REFUND_TABLE, STAGE)
      .where('is_deleted', false)
      .whereIn('refund_status', [
        RefundStatus.PENDING_MANAGER,
        RefundStatus.PENDING_ACADEMIC,
        RefundStatus.PENDING_PRINCIPAL,
        RefundStatus.PENDING_FINANCE,
      ])
      .count({ pendingRefund: '*' })) as Array<{ pendingRefund: number }>;
    const [{ pendingDormApply }] = (await tbl(db, DB, DORM_APPLY_TABLE, STAGE)
      .where({ is_deleted: false, apply_status: ApplyStatus.PENDING })
      .count({ pendingDormApply: '*' })) as Array<{ pendingDormApply: number }>;

    // ★ 2026-10-16 修：待办跳转路径改为第 1 期合并入口 /teaching/<域>。
    //   原来的裸路径（/approval 等）在老路由下线后只会落到 404 占位页；
    //   工作台迁到系统首页后这个清单会直接展示给所有初高角色，必须可点达。
    const todos = [
      { type: 'flow', title: '待审批流程', count: Number(pendingFlow), path: '/teaching/approval' },
      { type: 'refund', title: '待审批退费', count: Number(pendingRefund), path: '/teaching/refund' },
      { type: 'dormApply', title: '待审批调宿', count: Number(pendingDormApply), path: '/teaching/dorm' },
      { type: 'fee', title: '紧急催费', count: urgentFeeCount, path: '/teaching/fee' },
    ];
    const pendingTodoCount = todos.reduce((a, t) => a + t.count, 0);

    res.json(
      ok({
        readingStudentCount: Number(readingStudentCount),
        todayAttendanceRate,
        attendanceTargetRate,
        urgentFeeCount,
        pendingTodoCount,
        todos,
      }),
    );
  }),
);

export default statsRouter;

/** 占位导出，保持模块一致性（避免未使用告警） */
export const _bizCode = BizCode.SUCCESS;
