/**
 * ⭐ 催费信息 → 班级管理（只读副本）推送
 *
 * ============================================================
 * 【为什么有它】2026-10-05 联调发现的断链
 * ============================================================
 *   班级管理的「催费管理」页读共享库只读副本 sms_common.t_class_urge_sync，
 *   接收口 POST /api/class/urge/sync 早就写好了，但**没有任何一方推过**。
 *
 * 【谁推】教务老师（在「催费管理」页点「发起催费」）——
 *   这正是原始契约里写的「教务管理（8002）：催费信息」。
 *   合并后这个页面在【就业管理 → 催费管理】(/fee-call)，表是 sms_job.t_job_fee_call，
 *   但业务归属仍然是教务：/api/job/fee-call/create 只允许 ACAD_STAFF 发起。
 *
 * 【什么时候推】发起催费（create）后 / 班主任回填结果（handle）后
 *   —— 用户 2026-10-05 定的口径：「教务点击催费按钮」。
 *   ⚠️ 作废（void）暂不同步：班级侧的只读副本没有"单条删除"接口，
 *      作废单会残留在班级那边。属于已知差异，等班级侧补接口再说。
 *
 * 【失败怎么办】**绝不能影响主流程**（催费单已经建好了），只记日志。
 */

import { db } from '../utils/db';
import { classSync } from '../utils/classSync';

/** 催费单表（就业库） */
const FEE_CALL_TABLE = 't_job_fee_call';

/** 催缴状态：1 待催缴 / 2 催缴中 / 3 已缴清 */
const CALL_STATUS_PAID = 3;

function dateOnly(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeStr(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 催费单 → class 侧 urge 同步 item
 *
 * ⚠️ 状态映射（两边枚举不同名，做一次显式换算）：
 *   催费单 call_status：1 待催缴 / 2 催缴中 / 3 已缴清
 *   班级 PayStatus    ：1 待缴   / 2 已缴   / 3 已核对 / 5 冻结
 *   → 已缴清 → 2（已缴）；其余 → 1（待缴）
 *
 * ⚠️ 不传 studentId：就业侧只有自己的学生 ID（与班级侧 ID 空间不同），
 *    只传学号，由收方回查（见 class/modules/shared/studentRef.ts）。
 */
export function feeCallToUrgeItem(row: Record<string, any>): Record<string, unknown> {
  const callStatus = Number(row.call_status ?? 1);
  return {
    /* 幂等键：催费单自身 id —— 重复推只更新不新增 */
    sourceId: String(row.id),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    classId: row.class_id || null,
    className: row.class_name || null,
    phone: row.phone || null,
    parentPhone: row.parent_phone || null,
    headTeacherId: row.head_teacher_id || null,
    headTeacherName: row.head_teacher_name || null,
    feeType: Number(row.fee_type),
    amount: Number(row.fee_amount ?? 0),
    /* due_date 在催费单里是 NOT NULL，这里再兜一层防止 undefined 打到校验 */
    expireDate: dateOnly(row.due_date) || dateOnly(new Date())!,
    payStatus: callStatus === CALL_STATUS_PAID ? 2 : 1,
    /* 催缴次数/上次催缴时间：源头是催费单自己（班级侧是只读副本，不自己算） */
    urgeCount: callStatus === 1 ? 0 : 1,
    lastUrgeTime: timeStr(row.handle_time),
  };
}

/**
 * 把一张催费单推送到班级管理（幂等：class 侧按 sourceSystem+sourceId 更新）
 *
 * ⚠️ 永不抛错 —— 调用方不用 try/catch，也不该因为它失败而回滚业务。
 */
export async function syncFeeCallToClass(feeCallId: string): Promise<void> {
  if (!feeCallId) return;
  try {
    const row = (await db(FEE_CALL_TABLE)
      .where({ id: feeCallId, is_deleted: false })
      .first()) as Record<string, any> | undefined;
    if (!row) return; // 已作废/已删，没什么可同步的

    const r = await classSync.urgeSync([feeCallToUrgeItem(row)]);
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[催费→班级] 催费单 ${feeCallId} 同步失败（不影响本次操作）：${r.message}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[催费→班级] 催费单 ${feeCallId} 同步异常（不影响本次操作）：${(e as Error).message}`);
  }
}
