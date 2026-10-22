/**
 * 「结业转就业」服务（就业管理 > 实训阶段）
 * ============================================================
 * 【这是什么】
 *   实训班的班主任点「结业」→ 学生学完了，转到「就业」阶段。
 *
 * ★★ 关键认知：就业和实训【在同一个服务(8004)、同一个数据库(sms_job)】，
 *    所以"转过去"= 把学生状态从「实训中(8)」改成「待就业(9)」，
 *    **根本不用搬数据**。
 *    （这跟大学部 8003 → 实训 8004 的跨库升阶是完全不同的两件事，
 *      那个必须调接口搬档案，这个只是改个状态。）
 *
 * ============================================================
 * 【一个动作，六件事】—— 全部在同一事务，要么都成、要么都不动
 * ============================================================
 *   ① 班级   → 已结业(4) + 结业日期 + 记住结业前状态（供撤销回滚）
 *   ② 花名册 → 在班 → 已离班，离班方式 = 结业(5)
 *   ③ 学生主档 → 实训中(8) → 待就业(9)     ← 这就是"转就业"
 *   ④ 有宿舍的 → 生成「退宿申请」（走教务老师审批，**不立即释放床位**）
 *   ⑤ 有宿舍的 → 生成「住宿费退费单」（待提交，班主任核对金额后再提交）
 *   ⑥ 给班主任发站内信
 *
 * ============================================================
 * 【谁会被转走】★ 斌哥 2026-10-01 拍板
 * ============================================================
 *   ✅ 花名册「在班」 且 学生状态 = 实训中(8)
 *   ⛔ 休学(6)  → 不转（人不在校，没学完）
 *   ⛔ 退学(7)  → 不转（人已经走了）
 *   ⛔ 待就业(9) → 跳过（幂等，防止重复点、重复生成单子）
 *
 * ============================================================
 * 【为什么退宿申请、退费单的"申请人"写班主任，而不是点结业的人】
 * ============================================================
 *   这两条审批链的第 1 环都是「班主任发起」——
 *   `submitApproval()` 会校验提交人有没有发起权限。
 *   如果写校长，校长提交时反而会被拦下来（40011 无发起权限）。
 *   所以统一挂到**该班班主任**名下，班主任登录后看到自己的待提交单，
 *   核对金额、提交审批。点结业的人只负责"触发"。
 *
 * ⚠️ 铁律：金额用「分」；逻辑删除；改花名册必须限定 class_id（否则会误改
 *    学生在其它历史班的记录，且不报错）。
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import {
  ApprovalBizType,
  ApprovalStatus,
  BizCode,
  DormChangeBizType,
  RefundType,
  REFUND_TYPE_NAME,
  RoleCode,
  STUDENT_STATUS_NAME,
} from 'shared-types';
import { db } from './db';
import { BizError } from '../middleware/errorHandler';
import { createApproval, type Operator } from './approval';
import { sendNotice, NOTICE_TYPE } from './notice';
// ★ 切读层：本文件的表全部在 sms_job（学段固定 job），开关关时与原实现等价
import { tbl, tblAs, tblInsTrx, tblRef, tblTrx } from '../teaching/shared/uniTable';

const DB = 'sms_job';
const STAGE = 'job' as const;

/* ============================================================
 * 表名与常量
 * ============================================================ */

const CLASS_TABLE = 't_job_class';
const CS_TABLE = 't_job_class_student';
const STUDENT_TABLE = 't_student_base';
const BED_TABLE = 't_job_dorm_bed';
const DORM_TABLE = 't_job_dorm';
const CHANGE_TABLE = 't_job_dorm_change';
const REFUND_TABLE = 't_job_refund';

/** 班级状态：已结业 */
const CLASS_GRADUATED = 4;
/** 花名册：在班 / 已离班 */
const CS_IN = 1;
const CS_LEFT = 2;
/** 离班方式：结业 */
const LEAVE_TYPE_GRADUATE = 5;
/** 学生状态：实训中 / 待就业 */
const STU_TRAINING = 8;
const STU_WAIT_EMPLOY = 9;

/** 部门名映射（t_student_base / t_job_class 都没有 dept_name 列） */
const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };

/* ============================================================
 * 类型
 * ============================================================ */

/** 结业预览（点按钮前先让人看清楚会发生什么） */
export interface GraduatePreview {
  /** 班里在班学生总数 */
  totalInClass: number;
  /** 会被转走的 */
  willTransfer: number;
  /** 会被跳过的（休学/退学等） */
  skipped: Array<{
    studentId: string;
    studentName: string;
    studentStatus: number;
    studentStatusName: string;
  }>;
  /** 其中"有宿舍"的（会生成退宿申请 + 住宿费退费单） */
  withDorm: number;
}

/** 结业执行结果 */
export interface GraduateResult {
  /** 实际转出（→ 待就业）的学生数 */
  graduatedCount: number;
  /** 生成的退宿申请单数 */
  dormChangeCount: number;
  /** 生成的住宿费退费单数 */
  refundCount: number;
  /** 被跳过的学生姓名（休学/退学，前端提示用） */
  skippedNames: string[];
}

/* ============================================================
 * 内部工具
 * ============================================================ */

/**
 * 该班班主任的操作人身份
 *
 * ⚠️ 退宿申请 / 退费单的申请人必须是**班主任** —— 这两条审批链的第 1 环
 *    是「班主任发起」，写别人会被 submitApproval 拦下来。
 */
function headOperatorOf(cls: any, fallback: Operator): Operator {
  return {
    userId: cls?.head_teacher_id || fallback.userId,
    userName: cls?.head_teacher_name || fallback.userName,
    roles: [RoleCode.TEACH_HEAD],
  };
}

/** 重算班级在班人数（★ 花名册任何变动后都要调） */
async function refreshClassStudentCount(conn: any, classId: string): Promise<void> {
  const [{ cnt }] = (await tbl(conn, DB, CS_TABLE, STAGE)
    .where({ class_id: classId, status: CS_IN, is_deleted: false })
    .count({ cnt: '*' })) as Array<{ cnt: number }>;
  await tbl(conn, DB, CLASS_TABLE, STAGE).where({ id: classId }).update({ student_count: Number(cnt) });
}

/**
 * 捞出本班「在班」的学生（连学生主档）
 *
 * ⚠️ 只认花名册 status=1，且必须限定 class_id
 */
async function listInClassStudents(conn: any, classId: string): Promise<any[]> {
  return tblAs(conn, DB, CS_TABLE, STAGE, 'cs')
    .join(`${tblRef(DB, STUDENT_TABLE)} as s`, 'cs.student_id', 's.id')
    .where('cs.class_id', classId)
    .andWhere('cs.status', CS_IN)
    .andWhere('cs.is_deleted', false)
    .andWhere('s.is_deleted', false)
    .select(
      's.id',
      's.student_no',
      's.student_name',
      's.gender',
      's.phone',
      's.student_status',
      's.dorm_id',
      's.dorm_no',
    );
}

/** 同步删除「其它历史班里还挂着在班」的脏数据？不做 —— 只动本班（见坑 3） */

/* ============================================================
 * 1. 结业预览
 * ============================================================ */

export async function previewGraduate(classId: string): Promise<GraduatePreview> {
  const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: classId, is_deleted: false }).first();
  if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
  if (cls.class_status === CLASS_GRADUATED) {
    throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '该班级已结业');
  }

  const rows = await listInClassStudents(db, classId);

  const willTransfer = rows.filter((r) => r.student_status === STU_TRAINING);
  const skipped = rows
    .filter((r) => r.student_status !== STU_TRAINING)
    .map((r) => ({
      studentId: r.id,
      studentName: r.student_name,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
    }));

  return {
    totalInClass: rows.length,
    willTransfer: willTransfer.length,
    skipped,
    withDorm: willTransfer.filter((r) => !!r.dorm_id).length,
  };
}

/* ============================================================
 * 2. 结业（= 转就业）
 * ============================================================ */

export async function graduateClass(
  classId: string,
  closeDate: string,
  operator: Operator,
): Promise<GraduateResult> {
  const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: classId, is_deleted: false }).first();
  if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
  if (cls.class_status === CLASS_GRADUATED) {
    throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '该班级已结业');
  }
  if (!closeDate) throw new BizError(BizCode.PARAM_ERROR, '结业日期必填');

  const rows = await listInClassStudents(db, classId);
  const willTransfer = rows.filter((r) => r.student_status === STU_TRAINING);
  const skippedNames = rows
    .filter((r) => r.student_status !== STU_TRAINING)
    .map((r) => r.student_name || '');

  const headOp = headOperatorOf(cls, operator);
  const now = new Date();

  let dormChangeCount = 0;
  let refundCount = 0;

  await db.transaction(async (trx) => {
    /* ---- ① 班级：已结业 + 记住原状态（供撤销） ---- */
    await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: classId }).update({
      class_status: CLASS_GRADUATED,
      close_date: closeDate,
      prev_class_status: cls.class_status ?? null,
      update_time: now,
      update_by: operator.userId,
    });

    if (willTransfer.length === 0) {
      // 全班都在休学/退学 → 班级照样结业，但没人可转
      return;
    }

    const ids = willTransfer.map((r) => r.id);

    /* ---- ② 花名册：在班 → 已离班（⚠️ 必须限定 class_id） ---- */
    await tblTrx(trx, DB, CS_TABLE, STAGE)
      .where('class_id', classId)
      .whereIn('student_id', ids)
      .andWhere('status', CS_IN)
      .update({
        status: CS_LEFT,
        leave_type: LEAVE_TYPE_GRADUATE,
        leave_date: closeDate,
        update_time: now,
        update_by: operator.userId,
      });

    /* ---- ③ 学生主档：实训中(8) → 待就业(9)  ← 这就是"转就业" ---- */
    await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
      .whereIn('id', ids)
      .andWhere('student_status', STU_TRAINING)
      .update({
        student_status: STU_WAIT_EMPLOY,
        update_time: now,
        update_by: operator.userId,
      });

    /* ---- ④ 班级人数重算 ---- */
    await refreshClassStudentCount(trx, classId);

    /* ---- ⑤⑥ 给「有宿舍」的学生生成退宿申请 + 住宿费退费单 ---- */
    const withDorm = willTransfer.filter((r) => !!r.dorm_id);

    for (const stu of withDorm) {
      const bed = await tblTrx(trx, DB, BED_TABLE, STAGE)
        .where({ student_id: stu.id, is_deleted: false })
        .orderBy('create_time', 'desc')
        .first();

      const dormNo = stu.dorm_no || bed?.dorm_no || null;
      const deptCode = cls.dept_code ?? null;

      /* --- ⑤ 退宿申请（走教务老师审批，床位不立即释放） --- */
      const changeId = randomUUID();
      const changeApprovalId = await createApproval(
        {
          bizType: ApprovalBizType.DORM_CHANGE,
          bizId: changeId,
          applicant: headOp,
          studentId: stu.id,
          studentNo: stu.student_no || undefined,
          studentName: stu.student_name || undefined,
          classId,
          className: cls.class_name || undefined,
          deptCode: deptCode ?? undefined,
        },
        trx,
      );

      await tblInsTrx(trx, DB, CHANGE_TABLE, STAGE, {
        id: changeId,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        biz_type: DormChangeBizType.CHECKOUT,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        gender: stu.gender ?? null,
        phone: stu.phone || null,

        class_id: classId,
        class_name: cls.class_name || null,
        dept_code: deptCode,
        head_teacher_id: cls.head_teacher_id || null,
        head_teacher_name: cls.head_teacher_name || null,

        old_dorm_id: stu.dorm_id || null,
        old_dorm_no: dormNo,
        old_bed_id: bed?.id || null,
        old_bed_no: bed?.bed_no ?? null,

        new_dorm_id: null,
        new_dorm_no: null,
        new_bed_id: null,
        new_bed_no: null,

        change_date: closeDate,
        change_reason: `班级「${cls.class_name || ''}」结业转就业，自动生成退宿申请`,
        head_teacher_opinion: null,

        approval_id: changeApprovalId,
        approval_status: ApprovalStatus.DRAFT,

        remark: '系统在班级结业时自动生成，由教务老师审批',
      });
      dormChangeCount += 1;

      /* --- ⑥ 住宿费退费单（待提交；⚠️ 金额系统算不出来，留 0 等班主任填） --- */
      const refundId = randomUUID();
      const refundApprovalId = await createApproval(
        {
          bizType: ApprovalBizType.REFUND,
          bizId: refundId,
          applicant: headOp,
          studentId: stu.id,
          studentNo: stu.student_no || undefined,
          studentName: stu.student_name || undefined,
          classId,
          className: cls.class_name || undefined,
          deptCode: deptCode ?? undefined,
        },
        trx,
      );

      await tblInsTrx(trx, DB, REFUND_TABLE, STAGE, {
        id: refundId,
        create_time: now,
        create_by: operator.userId,
        is_deleted: false,

        student_id: stu.id,
        student_no: stu.student_no || null,
        student_name: stu.student_name || null,
        class_id: classId,
        class_name: cls.class_name || null,
        dept_name: DEPT_NAME[deptCode as number] || null,
        dept_code: deptCode,

        head_teacher_id: cls.head_teacher_id || null,
        head_teacher_name: cls.head_teacher_name || null,

        refund_type: RefundType.ACCOMMODATION,
        refund_type_name: REFUND_TYPE_NAME[RefundType.ACCOMMODATION] || null,
        // ⚠️ 系统拿不到"已缴住宿费"（在财务 8005，接口未接通），
        //    所以金额先留 0，由班主任核对后填写再提交。
        refund_amount: 0,
        apply_date: closeDate,
        refund_reason: `班级「${cls.class_name || ''}」结业转就业，退还剩余住宿费${
          dormNo ? `（原宿舍 ${dormNo}）` : ''
        }`,

        approval_id: refundApprovalId,
        approval_status: ApprovalStatus.DRAFT,

        remark: '系统在班级结业时自动生成，请班主任核对金额后提交',
      });
      refundCount += 1;
    }

    /* ---- ⑦ 通知班主任 ---- */
    const receiverId = cls.head_teacher_id || operator.userId;
    const receiverName = cls.head_teacher_name || operator.userName;

    const lines = [
      `班级「${cls.class_name || ''}」已于 ${closeDate} 结业。`,
      `本次转出到「待就业」：${ids.length} 人。`,
    ];
    if (dormChangeCount > 0) {
      lines.push(`已自动生成 ${dormChangeCount} 张退宿申请，请等教务老师审批。`);
    }
    if (refundCount > 0) {
      lines.push(`已自动生成 ${refundCount} 张住宿费退费单（待提交），请核对金额后提交审批。`);
    }
    if (skippedNames.length > 0) {
      lines.push(`未转出（休学/退学）：${skippedNames.join('、')}。`);
    }

    await sendNotice(
      {
        noticeType: NOTICE_TYPE.SYSTEM,
        title: `【结业转就业】${cls.class_name || ''}`,
        content: lines.join('\n'),
        receiverId,
        receiverName,
        senderId: operator.userId,
        senderName: operator.userName,
        bizType: 'classGraduate',
        bizId: classId,
        classId,
        className: cls.class_name || null,
      },
      trx,
    );
  });

  return {
    graduatedCount: willTransfer.length,
    dormChangeCount,
    refundCount,
    skippedNames,
  };
}

/* ============================================================
 * 3. 撤销结业（仅校长）
 * ============================================================ */

export interface RevokeGraduateResult {
  /** 被恢复回「实训中」的学生数 */
  restoredCount: number;
  /** 被作废的退宿申请单数 */
  cancelledDormChange: number;
}

export async function revokeGraduate(
  classId: string,
  operator: Operator,
): Promise<RevokeGraduateResult> {
  const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: classId, is_deleted: false }).first();
  if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');
  if (cls.class_status !== CLASS_GRADUATED) {
    throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '该班级未结业，无法撤销');
  }

  const now = new Date();

  // 本批"因结业而离班"的纪录（一个班只结业一次，不会有别的批次混进来）
  const leftRows = await tbl(db, DB, CS_TABLE, STAGE)
    .where({ class_id: classId, status: CS_LEFT, leave_type: LEAVE_TYPE_GRADUATE, is_deleted: false })
    .select('student_id');
  const studentIds = leftRows.map((r: any) => r.student_id);

  let restoredCount = 0;
  let cancelledDormChange = 0;

  await db.transaction(async (trx) => {
    /* ---- ① 班级：回到结业前的状态 ---- */
    await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: classId }).update({
      // ★ 2026-10-02：「开放」已废弃 —— 兜底值从 1(开放) 改成 2(封班)
      class_status: cls.prev_class_status ?? 2,
      close_date: null,
      prev_class_status: null,
      update_time: now,
      update_by: operator.userId,
    });

    if (studentIds.length > 0) {
      /* ---- ② 花名册：回「在班」 ---- */
      await tblTrx(trx, DB, CS_TABLE, STAGE)
        .where('class_id', classId)
        .whereIn('student_id', studentIds)
        .andWhere('status', CS_LEFT)
        .andWhere('leave_type', LEAVE_TYPE_GRADUATE)
        .update({
          status: CS_IN,
          leave_type: null,
          leave_date: null,
          update_time: now,
          update_by: operator.userId,
        });

      /* ---- ③ 学生主档：待就业(9) → 实训中(8) ----
         ⚠️ 只回滚"待就业"的，别把已经就业(10)的学生也拽回来 */
      const affected = await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .whereIn('id', studentIds)
        .andWhere('student_status', STU_WAIT_EMPLOY)
        .update({
          student_status: STU_TRAINING,
          update_time: now,
          update_by: operator.userId,
        });
      restoredCount = Number(affected) || 0;

      /* ---- ④ 班级人数重算 ---- */
      await refreshClassStudentCount(trx, classId);
    }

    /* ---- ⑤ 作废"这次生成的、还没审批通过"的退宿申请 ----
       ⚠️ 必须做！否则学生已经回班了，教务老师一点通过就把他的床位退了。 */
    cancelledDormChange = await tblTrx(trx, DB, CHANGE_TABLE, STAGE)
      .where({ class_id: classId, biz_type: DormChangeBizType.CHECKOUT, is_deleted: false })
      .whereIn('approval_status', [
        ApprovalStatus.DRAFT,
        ApprovalStatus.PENDING_MANAGER,
        ApprovalStatus.PENDING_PRINCIPAL,
      ])
      .update({
        is_deleted: true,
        remark: '（班级撤销结业，本申请单自动作废）',
        update_time: now,
        update_by: operator.userId,
      });

    /* ⚠️ 退费单【不动】—— 斌哥 2026-10-01 拍板：撤销只回滚学生，宿舍和退费不动。
       已生成的住宿费退费单由班主任自行判断是否提交/作废（界面上有提示）。 */
  });

  return { restoredCount, cancelledDormChange: Number(cancelledDormChange) || 0 };
}

/* ============================================================
 * 4. 查询：某班未处理的结业遗留单（前端提示用）
 * ============================================================ */

export async function countPendingGraduateBills(classId: string): Promise<{
  pendingDormChange: number;
  pendingRefund: number;
}> {
  const [{ c: dormCnt }] = (await tbl(db, DB, CHANGE_TABLE, STAGE)
    .where({ class_id: classId, biz_type: DormChangeBizType.CHECKOUT, is_deleted: false })
    .whereIn('approval_status', [ApprovalStatus.DRAFT, ApprovalStatus.PENDING_MANAGER])
    .count({ c: '*' })) as Array<{ c: number }>;

  const [{ c: refundCnt }] = (await tbl(db, DB, REFUND_TABLE, STAGE)
    .where({ class_id: classId, is_deleted: false, refund_type: RefundType.ACCOMMODATION })
    .whereIn('approval_status', [ApprovalStatus.DRAFT, ApprovalStatus.PENDING_MANAGER, ApprovalStatus.PENDING_PRINCIPAL])
    .count({ c: '*' })) as Array<{ c: number }>;

  return {
    pendingDormChange: Number(dormCnt) || 0,
    pendingRefund: Number(refundCnt) || 0,
  };
}

/* 占位：Knex 类型仅为显式引用，避免 TS 未使用告警 */
export type { Knex };
