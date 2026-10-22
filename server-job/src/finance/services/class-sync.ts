/**
 * ⭐ 财务管理 → 班级管理：缴费信息推送
 *
 * ============================================================
 * 【为什么有它】2026-10-05 联调发现的断链
 * ============================================================
 *   班级管理的「缴费管理」页读的是共享库只读副本
 *     sms_common.t_class_fee_sync
 *   接收口 POST /api/class/fee/sync 早就写好了，但**没有任何一方推过** ——
 *   所以班主任在班级模块永远看不到缴费记录。
 *   本文件补上生产端。
 *
 * 【什么时候推】缴费单**新增 / 变更**就推（用户 2026-10-05 定的口径）：
 *   新增(add) / 回传凭证(attach-voucher) / 核对(verify) / 打回(reject)
 *   ⚠️ 独立服务时可以放在 fee.service 里；合并成单体后为免循环依赖，
 *      改成路由层显式调用（见 routes/fee.route.ts）。
 *
 * ★ 2026-10-06 扩：一份单推**两个收方**（用户需求：三处详情缴费情况统一与财务对齐）
 *   · 大学部（班级管理）→ sms_common.t_class_fee_sync        原链路，不动
 *   · 初高（教学管理）  → sms_class_jh.t_class_fee            新增；只推
 *     dept_code=1（财务页面显示为「二三期」）且学号能在初高库里找到的单
 *
 * 【失败怎么办】**绝不能影响主流程** —— 钱已经收好了，同步失败只是
 *   班主任那边晚一点看到。所以这里只记日志、不抛错（非阻断语义）。
 */

import { db } from '../utils/db';
import { classSync } from '../../utils/classSync';
// ★ P3 切读层：推给初高的两张表（`sms_class_jh.t_class_student` / `t_class_fee`）
//   都已归一 → 读走 tbl()、写走 tblIns()。本文件 `db` 连的是 sms_job，
//   属于**跨库**调用，`tbl()` 会自动补库名前缀（与改造前的 `db('库.表')` 一致）。
import { tbl, tblIns } from '../../teaching/shared/uniTable';

/** 缴费单表（与 fee.service.ts 的 FEE_TABLE 一致，这里本地声明避免循环依赖） */
const FEE_TABLE = 't_finance_fee';

/** 日期 → YYYY-MM-DD（class 侧 pay_date / expire_date 只收日期串） */
function dateOnly(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 缴费单 → class 侧 SyncRequest 的 item
 *
 * ⚠️ 状态码是【数字契约】，两个模块的 PayStatus 取值完全一致（1待缴…5冻结），
 *    只有 2 的中文名不同（财务叫「待核对」、班级叫「已缴」），数值照传即可。
 *
 * ⚠️ 不传 studentId：财务只有学号，收方（班级）会按学号回查自己的学生 ID
 *    （见 class/modules/shared/studentRef.ts）。
 */
export function feeToSyncItem(row: Record<string, any>): Record<string, unknown> {
  const payStatus = Number(row.pay_status ?? 1);
  const amount = Number(row.amount ?? 0);
  return {
    sourceId: String(row.id),
    studentNo: String(row.student_no || ''),
    studentName: String(row.student_name || ''),
    classId: row.class_id || null,
    className: row.class_name || null,
    feeType: Number(row.fee_type),
    amount,
    // 待缴(1) 视为未收到钱；其余状态（待核对/已缴/冻结）按已收金额展示
    paidAmount: payStatus === 1 ? 0 : amount,
    payStatus,
    payDate: dateOnly(row.pay_date),
    expireDate: dateOnly(row.expire_date),
    voucherUrl: row.voucher_url || null,
    payMethod: null,
    // ★ 2026-10-06 新增：费用周期 + 部门，让「缴费情况」三处展示同一套字段
    period: row.period || null,
    deptCode: row.dept_code == null ? null : Number(row.dept_code),
  };
}

/**
 * 把一张缴费单推送到班级管理（幂等：class 侧按 sourceSystem+sourceId 更新）
 *
 * ⚠️ 永不抛错 —— 调用方不需要 try/catch，也不该因为它失败而回滚业务。
 */
export async function syncFeeToClass(feeId: string): Promise<void> {
  if (!feeId) return;
  try {
    const row = (await db(FEE_TABLE).where({ id: feeId, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!row) return; // 单子被删了，没什么可同步的

    const r = await classSync.feeSync([feeToSyncItem(row)]);
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[finance→class] 缴费单 ${feeId} 同步失败（不影响本次操作）：${r.message}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[finance→class] 缴费单 ${feeId} 同步异常（不影响本次操作）：${(e as Error).message}`);
  }
}

/* ============================================================
 * ★ 2026-10-06 新增：财务管理 → 教学管理（初高）缴费台账副本
 *   sms_class_jh.t_class_fee （幂等键 source_system + source_id）
 *
 *   为什么要副本：初高「学生详情 · 缴费情况」的取数口径是
 *   **实时为主 + 副本兜底**（用户 2026-10-06 拍板）——
 *   实时查不到财务数据时，页面回落到这张表，所以它必须保持新鲜。
 *
 *   只推两类单，避免污染初高库：
 *     1. dept_code = 1（财务页面的「二三期」＝初高部）
 *     2. 学号能在 sms_class_jh.t_class_student 里回查到
 *        （查得到说明确实是初高的学生；查不到就不推）
 * ============================================================ */

/** 初高缴费台账（兜底副本）—— ★ 已归一 → 写走 tblIns() */
const JH_FEE_TABLE = 't_class_fee';
/** 初高学生表（按学号回查学生 ID 用）—— ★ 已归一 → 读走 tbl() */
const JH_STUDENT_TABLE = 't_class_student';
/** 初高库（本文件的 `db` 连的是 sms_job → 这两个常量让切读层补库名前缀） */
const JH_DB = 'sms_class_jh';
/** 统一表 `edu_stage` 取值：初高 */
const JH_STAGE = 'jh' as const;

/**
 * ★ 切读层连接的**纯类型**转换（不改任何运行时行为）
 *
 * `src/finance/utils/db.ts` 导出的是「带表名校验的函数 `db`」，它把
 * `client` / `transaction` / `raw` 等静态成员挂在函数本身上（有意为之，见该文件注释）。
 * 而 `tbl()` 的第一个参数声明成 `Knex` 实例，只用来「调用取 QueryBuilder」+
 * 读 `client.config.connection.database` —— **这两件事 finance 的 `db` 都满足**。
 * → 运行时 100% 兼容，仅类型层面需要一次断言。
 */
const CONN = db as unknown as Parameters<typeof tbl>[0];

/** 按学号回查初高学生（查不到返回 null；跨库异常也返回 null，不抛） */
async function findJhStudent(studentNo: string): Promise<Record<string, any> | null> {
  if (!studentNo) return null;
  try {
    const row = (await tbl(CONN, JH_DB, JH_STUDENT_TABLE, JH_STAGE)
      .where({ student_no: studentNo, is_deleted: false })
      .first()) as Record<string, any> | undefined;
    return row || null;
  } catch {
    return null;
  }
}

/**
 * 把一张缴费单推送到初高缴费台账（幂等：按 source_system+source_id upsert）
 *
 * ⚠️ 永不抛错 —— 同步失败只是初高页面的兜底数据旧一点，不该影响收款主流程。
 */
export async function syncFeeToJh(feeId: string): Promise<void> {
  if (!feeId) return;
  try {
    const row = (await db(FEE_TABLE).where({ id: feeId, is_deleted: false }).first()) as
      | Record<string, any>
      | undefined;
    if (!row) return;

    // 只推「二三期」（初高部）的单
    if (row.dept_code != null && Number(row.dept_code) !== 1) return;

    // 学号必须是初高的学生，否则不推（避免大学部/咨询试学的单落到初高库）
    const stu = await findJhStudent(String(row.student_no || ''));
    if (!stu) return;

    const now = new Date();
    const payload: Record<string, any> = {
      id: String(row.id),
      create_time: now,
      create_by: 'finance-sync',
      update_time: now,
      update_by: 'finance-sync',
      is_deleted: false,
      student_id: stu.id,
      student_no: String(row.student_no || ''),
      student_name: String(stu.student_name || row.student_name || ''),
      class_id: stu.class_id ?? row.class_id ?? null,
      class_name: stu.class_name ?? row.class_name ?? null,
      dept_code: 1,
      fee_type: Number(row.fee_type ?? 1),
      fee_amount: Number(row.amount ?? 0),
      pay_status: Number(row.pay_status ?? 1),
      pay_date: dateOnly(row.pay_date),
      expire_date: dateOnly(row.expire_date),
      voucher_url: row.voucher_url || null,
      period: row.period || null,
      source_system: 'finance',
      source_id: String(row.id),
    };

    // MySQL：ON DUPLICATE KEY UPDATE（幂等键 uk_fee_source = source_system + source_id）
    //
    // ⚠️ 幂等性依赖 `uk_fee_source`：老表 `sms_class_jh.t_class_fee` 有这个唯一键，
    //    而统一表 `t_uni_fee` **没有**（只有 PK(id) + idx_edu_stage）。
    //    → 切读打开后靠 `payload.id`（= 财务单 id，确定性）命中主键来兜住幂等；
    //      只有「不同来源但 id 相同」这种极端情况才会插成两行。
    //    这不是 P3 引入的，属统一表的索引口径差异，已登记待 P5/P6 拍板。
    const upsert = await tblIns(CONN, JH_DB, JH_FEE_TABLE, JH_STAGE, payload);
    await upsert.onConflict(['source_system', 'source_id']).merge(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[finance→class-jh] 缴费单 ${feeId} 同步异常（不影响本次操作）：${(e as Error).message}`);
  }
}

/** 批量版（批量核对用）：串行推送，避免一瞬间打爆数据库 */
export async function syncFeesToClass(feeIds: string[]): Promise<void> {
  for (const id of feeIds) {
    // eslint-disable-next-line no-await-in-loop
    await syncFeeToClass(id);
  }
}

/** 批量推送给初高（与 syncFeesToClass 配对，路由层一起调） */
export async function syncFeesToJh(feeIds: string[]): Promise<void> {
  for (const id of feeIds) {
    // eslint-disable-next-line no-await-in-loop
    await syncFeeToJh(id);
  }
}

/* ============================================================
 * 统一出口：一张缴费单推给**所有**下游
 *   路由层只调这两个，以后再加收方（比如实训）不用到处补调用。
 * ============================================================ */

/** 单条：大学部（班级管理）+ 初高（教学管理） */
export async function syncFeeToAll(feeId: string): Promise<void> {
  await syncFeeToClass(feeId);
  await syncFeeToJh(feeId);
}

/** 批量：串行，避免一瞬间打爆数据库 */
export async function syncFeesToAll(feeIds: string[]): Promise<void> {
  for (const id of feeIds) {
    // eslint-disable-next-line no-await-in-loop
    await syncFeeToAll(id);
  }
}
