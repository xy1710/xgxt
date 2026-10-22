/**
 * 教学 → 财务：学号回填（★ 2026-10-22 用户口径，方案 A）
 * ============================================================
 *
 * 【为什么需要这个同步】
 *   财务缴费单/账单里的 `student_id` 存的是【咨询学生 id】，
 *   与教学库 `t_class_student.id` 完全不是一套（实测 100 张单按 id 匹配教学库 0 条）。
 *   **学号是财务 ↔ 教学之间唯一的关联键**。
 *
 *   学生建单时还没入学、没有学号，所以缴费单学号是空的；
 *   等班主任在班级侧「接收」建档、按规则生成学号之后，
 *   财务这边必须跟着更新，否则会断两件事：
 *     ① 单据学号永远为空，按学号对不了账、账单明细搜不到人
 *     ② `syncFeeToAll` 推缴费台账前要用学号回查教学学生，
 *        学号为空直接 `return`，这张单永远进不了教学侧缴费台账
 *
 * 【定位方式】
 *   接收端只有 `consult_no`（= 咨询学生的 student_no，没学号时咨询侧直接拿 id 当单号，
 *   见 consult/routes/student.route.ts 的 consultNoOf），
 *   所以先按 `id = ? OR student_no = ?` 反查咨询学生 id，再用它匹配财务单据。
 *
 * 【更新范围】
 *   · `t_finance_fee.student_no`：该学生所有未删除单据（**含已入账**）
 *     —— 实际流程是「财务先核对入账 → 再分班建档」，只更新未入账的等于什么都不更新。
 *   · `t_finance_bill.student_no`：只改学号这一个字段，不动金额/日期/凭证/操作人。
 *     账单是账本，但学号属于身份信息，不跟着改会导致账单明细按学号查不到人。
 *
 * 【安全】
 *   · 幂等：学号已是目标值的跳过，不产生无意义更新
 *   · 永不抛错：调用方（班主任接收建档）不应因为财务侧失败而回滚学籍
 */

import { db } from '../utils/db';
import { FEE_TABLE, BILL_TABLE } from './fee.service';
import { syncFeesToAll } from './class-sync';

export interface StudentNoSyncResult {
  /** 匹配到的咨询学生 id（定位不到时退回用咨询单号本身） */
  consultStudentId: string;
  /** 实际更新的缴费单条数 */
  feeUpdated: number;
  /** 实际更新的账单条数 */
  billUpdated: number;
  /** 重推台账的缴费单条数 */
  pushed: number;
}

/**
 * 按咨询单号 + 新学号，把财务侧单据的学号补齐并重推缴费台账。
 *
 * @param consultNo 咨询单号（咨询学号；无学号时是咨询学生 id）
 * @param studentNo 教学侧刚生成的学号
 */
export async function syncStudentNoFromTeaching(
  consultNo: string,
  studentNo: string,
): Promise<StudentNoSyncResult> {
  const cno = String(consultNo ?? '').trim();
  const sno = String(studentNo ?? '').trim();
  const empty: StudentNoSyncResult = {
    consultStudentId: '',
    feeUpdated: 0,
    billUpdated: 0,
    pushed: 0,
  };
  // 任一为空都不同步：没有学号没什么可填的，没有单号也定位不到人
  if (!cno || !sno) return empty;

  // ---- 1. 咨询单号 → 咨询学生 id（两库同实例，全限定名跨库查）----
  let consultStudentId = cno;
  try {
    const stu = (await db('sms_consult.t_consult_student')
      .where('is_deleted', false)
      .andWhere((q: any) => q.where('id', cno).orWhere('student_no', cno))
      .first('id')) as { id?: string } | undefined;
    if (stu?.id) consultStudentId = String(stu.id);
  } catch {
    // 咨询库异常时退回用单号本身当 id，最多更新 0 条，不影响建档
  }

  const now = new Date();

  // ---- 2. 缴费单：含已入账的单，只补学号 ----
  let feeUpdated = 0;
  try {
    feeUpdated = await db(FEE_TABLE)
      .where({ student_id: consultStudentId, is_deleted: false })
      .andWhere((q: any) => q.whereNot('student_no', sno).orWhereNull('student_no'))
      .update({ student_no: sno, update_time: now });
  } catch {
    feeUpdated = 0;
  }

  // ---- 3. 账单：账本只补学号，其余字段一律不动 ----
  let billUpdated = 0;
  try {
    billUpdated = await db(BILL_TABLE)
      .where({ student_id: consultStudentId, is_deleted: false })
      .andWhere((q: any) => q.whereNot('student_no', sno).orWhereNull('student_no'))
      .update({ student_no: sno });
  } catch {
    billUpdated = 0;
  }

  // ---- 4. 重推缴费台账：学号已经可用，之前因学号为空被跳过的单这次能推出去 ----
  let pushed = 0;
  try {
    const ids = (await db(FEE_TABLE)
      .where({ student_id: consultStudentId, is_deleted: false })
      .pluck('id')) as string[];
    if (ids.length) {
      await syncFeesToAll(ids);
      pushed = ids.length;
    }
  } catch {
    pushed = 0;
  }

  return { consultStudentId, feeUpdated, billUpdated, pushed };
}
