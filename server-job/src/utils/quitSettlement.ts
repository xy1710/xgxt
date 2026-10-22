/**
 * 「退学结算」服务（就业管理 > 实训阶段）
 * ============================================================
 * 【这是什么】
 *   学生退学审批**通过后**，系统自动帮他办好两件收尾的事：
 *     ① 有宿舍的 → 生成「退宿申请」（走教务老师审批，通过后才释放床位）
 *     ② 生成一张「退学退费」**合并单**：学费 + 住宿费 + 餐费 三项明细
 *
 * ★★ 和「结业转就业」是同一套思路（斌哥 2026-10-01），差别在：
 *     - 结业只退**住宿费**（学生学完了，学费不退）
 *     - 退学要退**学费 + 住宿费 + 餐费**（全额退，不按天扣）
 *     - 并且退学是**一张合并单**，三种费额分开记在同一张单的明细字段里
 *
 * ============================================================
 * 【⚠️ 金额现在算不出来，这是已知的"暂定"状态】
 * ============================================================
 *   "全额退"的"全额"= 学生**一共交过多少钱**。但这个数系统拿不到：
 *     - 缴费记录在**财务模块 8005**（接口还没接通）
 *     - 系统里也**没有**"学费多少钱/住宿费住多久"这类收费标准表
 *
 *   所以现在：三个明细都先填 0，由**班主任核对后手工填写**。
 *   将来财务接通后，只需要把 `calcRefundAmounts()` 的实现补上即可 ——
 *   **调用方一行都不用改**。
 *
 * ============================================================
 * 【为什么退宿单和退费单的申请人写班主任】
 * ============================================================
 *   两条审批链的第 1 环都是「班主任发起」，
 *   `submitApproval()` 会校验提交人的发起权限 —— 写别人会被拦。
 *   所以统一挂在**该班班主任**名下，班主任登录后自己填金额、提交。
 *
 * ⚠️ 铁律：金额用「分」；逻辑删除；本函数必须在调用方的事务里执行。
 */

import { randomUUID } from 'crypto';
import {
  ApprovalBizType,
  ApprovalStatus,
  DormChangeBizType,
  RefundType,
  REFUND_TYPE_NAME,
  RoleCode,
} from 'shared-types';
import { createApproval, type Operator } from './approval';
import { sendNotice, NOTICE_TYPE } from './notice';
import { today } from './date';
// ★ 切读层：本文件的表全部在 sms_job（学段固定 job），开关关时与原实现等价
import { tblInsTrx, tblTrx } from '../teaching/shared/uniTable';

const DB = 'sms_job';
const STAGE = 'job' as const;

/* ============================================================
 * 表名与常量
 * ============================================================ */

const CLASS_TABLE = 't_job_class';
const STUDENT_TABLE = 't_student_base';
const BED_TABLE = 't_job_dorm_bed';
const CHANGE_TABLE = 't_job_dorm_change';
const REFUND_TABLE = 't_job_refund';

/** 部门名映射（t_student_base / t_job_class 都没有 dept_name 列） */
const DEPT_NAME: Record<number, string> = { 1: '初高部', 2: '大学部' };

/* ============================================================
 * 类型
 * ============================================================ */

/** 退学退费的三项明细（单位：分） */
export interface RefundAmounts {
  /** 学费 */
  tuition: number;
  /** 住宿费（该生没有宿舍时为 0） */
  accommodation: number;
  /** 餐费 */
  meal: number;
}

/** 结算结果（给调用方拼提示语用） */
export interface QuitSettleResult {
  /** 宿舍是不是已经改成「走审批」了 —— 不直接释放床位 */
  hasDorm: boolean;
  /** 是否生成了退宿申请 */
  dormChangeCreated: boolean;
  /** 是否生成了退学退费合并单 */
  refundCreated: boolean;
  /** 生成的退费单 ID */
  refundId: string | null;
}

/* ============================================================
 * ★ 预留：金额自动计算（将来接财务 8005）
 * ============================================================ */

/**
 * 计算某学生退学时该退的三项费用（单位：分）
 *
 * ============================================================
 * ⚠️⚠️ 现在恒返回 0，这是**有意为之的"暂定"**，不是没写完 ⚠️⚠️
 * ============================================================
 *
 * 【为什么是 0】
 *   退学口径是"**全额退、不按天扣**"，所以金额 = **学生已缴的三项费用总和**。
 *   而这个数只有**财务模块 8005** 知道 —— 它的接口目前还没接通
 *   （我们调用会返回"暂未接入"），系统里也没有收费标准表可以反推。
 *
 * 【将来怎么补】
 *   等财务 8005 接通后，在这里调用它按学号查已缴明细，例如：
 *
 *     const resp = await fetch(
 *       `${config.services.finance}/api/finance/payment/summary?studentNo=${student.student_no}`,
 *       { signal: AbortController.timeout(3000) },
 *     );
 *     const d = (await resp.json()).data;
 *     return { tuition: d.tuition, accommodation: d.accommodation, meal: d.meal };
 *
 *   ⚠️ 必须做成"调不通就返回 0"（跟缴费记录那块一样优雅降级），
 *      否则财务一宕机，退学流程就整个走不动了。
 *
 *   **补完之后，调用方一眼都不用改** —— 这就是把它单独抽成函数的原因。
 *
 * @param student 学生主档行
 * @param conn    数据库连接（事务），将来查财务走 HTTP 的话这个参数可以不用
 */
export async function calcRefundAmounts(
  student: any,
  conn?: any,
): Promise<RefundAmounts> {
  // TODO【等财务 8005 接通】在这里实现"查已缴明细"
  // 现在：拿不到缴费数据 → 一律 0，由班主任手工填写
  void student;
  void conn;
  return { tuition: 0, accommodation: 0, meal: 0 };
}

/* ============================================================
 * 主流程：退学审批通过后的结算
 * ============================================================ */

/**
 * 退学结算：生成退宿申请 + 退学退费合并单 + 通知班主任
 *
 * ⚠️ 必须在调用方的事务里跑（`trx`），保证"改学生状态 + 生成单据"要么都成、要么都不动。
 *
 * @param trx      事务连接
 * @param leaveRow `t_job_student_leave` 的行（退学单）
 * @param operator 审批通过的人
 */
export async function settleQuit(
  trx: any,
  leaveRow: any,
  operator: Operator,
): Promise<QuitSettleResult> {
  const now = new Date();
  const applyDate = leaveRow.leave_date || today();

  const stu = await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ id: leaveRow.student_id }).first();
  if (!stu) {
    return { hasDorm: false, dormChangeCreated: false, refundCreated: false, refundId: null };
  }

  const cls = leaveRow.class_id
    ? await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: leaveRow.class_id, is_deleted: false }).first()
    : null;

  // 单据挂在**该班班主任**名下（两条审批链第 1 环都是"班主任发起"）
  const headOp: Operator = {
    userId: cls?.head_teacher_id || operator.userId,
    userName: cls?.head_teacher_name || operator.userName,
    roles: [RoleCode.TEACH_HEAD],
  };

  const classId = leaveRow.class_id || cls?.id || null;
  const className = leaveRow.class_name || cls?.class_name || null;
  const deptCode = cls?.dept_code ?? stu.dept_code ?? null;
  const hasDorm = !!stu.dorm_id;

  let dormChangeCreated = false;
  let refundCreated = false;
  let refundId: string | null = null;

  /* ------------------------------------------------------------
   * ① 有宿舍 → 生成「退宿申请」（走教务老师审批，不直接释放床位）
   *
   *    ★ 顺带修了一个 bug：以前退学只是把学生主档的 dorm_id 清空，
   *      **没有动床位表** → 那张床在系统里一直显示"已占用"，别人分不进来，
   *      宿舍的已住人数也虚高。改走退宿审批后，审批通过时会正确释放床位。
   * ------------------------------------------------------------ */
  if (hasDorm) {
    const bed = await tblTrx(trx, DB, BED_TABLE, STAGE)
      .where({ student_id: stu.id, is_deleted: false })
      .orderBy('create_time', 'desc')
      .first();

    const changeId = randomUUID();
    const approvalId = await createApproval(
      {
        bizType: ApprovalBizType.DORM_CHANGE,
        bizId: changeId,
        applicant: headOp,
        studentId: stu.id,
        studentNo: stu.student_no || undefined,
        studentName: stu.student_name || undefined,
        classId: classId || undefined,
        className: className || undefined,
        deptCode: deptCode ?? undefined,
      },
      trx,
    );

    await tblInsTrx(trx, DB, CHANGE_TABLE, STAGE, {
      id: changeId,
      create_time: now,
      create_by: operator.userId,
      is_deleted: false,

      biz_type: DormChangeBizType.CHECKOUT, // 2 退宿

      student_id: stu.id,
      student_no: stu.student_no || null,
      student_name: stu.student_name || null,
      gender: stu.gender ?? null,
      phone: stu.phone || null,

      class_id: classId,
      class_name: className,
      dept_code: deptCode,
      head_teacher_id: cls?.head_teacher_id || null,
      head_teacher_name: cls?.head_teacher_name || null,

      old_dorm_id: stu.dorm_id || null,
      old_dorm_no: stu.dorm_no || bed?.dorm_no || null,
      old_bed_id: bed?.id || null,
      old_bed_no: bed?.bed_no ?? null,

      new_dorm_id: null,
      new_dorm_no: null,
      new_bed_id: null,
      new_bed_no: null,

      change_date: applyDate,
      change_reason: `学生退学，自动生成退宿申请`,
      head_teacher_opinion: null,

      approval_id: approvalId,
      approval_status: ApprovalStatus.DRAFT,

      remark: '系统在退学审批通过时自动生成，由教务老师审批',
    });
    dormChangeCreated = true;
  }

  /* ------------------------------------------------------------
   * ② 生成「退学退费」合并单（学费 + 住宿费 + 餐费）
   *    金额三项目前都是 0，等班主任核对后填写。
   * ------------------------------------------------------------ */
  const amounts = await calcRefundAmounts(stu, trx);
  // 没有宿舍 → 住宿费为 0（不占住宿费这一项）
  const accommodation = hasDorm ? amounts.accommodation : 0;
  const total = amounts.tuition + accommodation + amounts.meal;

  refundId = randomUUID();
  const refundApprovalId = await createApproval(
    {
      bizType: ApprovalBizType.REFUND,
      bizId: refundId,
      applicant: headOp,
      studentId: stu.id,
      studentNo: stu.student_no || undefined,
      studentName: stu.student_name || undefined,
      classId: classId || undefined,
      className: className || undefined,
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
    class_name: className,
    dept_name: DEPT_NAME[deptCode as number] || null,
    dept_code: deptCode,

    head_teacher_id: cls?.head_teacher_id || null,
    head_teacher_name: cls?.head_teacher_name || null,

    refund_type: RefundType.QUIT,
    refund_type_name: REFUND_TYPE_NAME[RefundType.QUIT] || null,

    // 三项明细（分）—— 现在都是 0，班主任核对后填
    tuition_amount: amounts.tuition,
    accommodation_amount: accommodation,
    meal_amount: amounts.meal,
    // 总金额 = 三者之和
    refund_amount: total,

    apply_date: applyDate,
    refund_reason: `学生退学，退还学费${hasDorm ? '、住宿费' : ''}、餐费（全额退，不按天扣）`,

    approval_id: refundApprovalId,
    approval_status: ApprovalStatus.DRAFT,

    remark: '系统在退学审批通过时自动生成，请班主任核对三项金额后提交',
  });
  refundCreated = true;

  /* ------------------------------------------------------------
   * ③ 通知班主任（有单子要填金额、要盯审批）
   * ------------------------------------------------------------ */
  const receiverId = cls?.head_teacher_id || operator.userId;
  const receiverName = cls?.head_teacher_name || operator.userName;

  const lines = [
    `${stu.student_name || ''}（${stu.student_no || ''}）的退学申请已审批通过。`,
    '已自动生成一张「退学退费」单（学费 + 住宿费 + 餐费），**请到「退费申请」核对金额后提交审批**。',
  ];
  if (dormChangeCreated) {
    lines.push('该生有宿舍，已自动生成退宿申请，请提交后由教务老师审批。');
  }

  await sendNotice(
    {
      noticeType: NOTICE_TYPE.SYSTEM,
      title: `【退学结算】${stu.student_name || ''}`,
      content: lines.join('\n'),
      receiverId,
      receiverName,
      senderId: operator.userId,
      senderName: operator.userName,
      bizType: 'quitSettle',
      bizId: leaveRow.id,
      classId,
      className,
      studentId: stu.id,
      studentName: stu.student_name || null,
    },
    trx,
  );

  return { hasDorm, dormChangeCreated, refundCreated, refundId };
}
