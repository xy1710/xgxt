/**
 * 冻结名单 · 业务逻辑
 * 负责人：周铭（财务管理）
 *
 * 业务背景（需求③）：
 *    学生休学后，餐费和住宿费要「暂停消耗」——
 *    人都没来吃饭住宿，费用当然不能照扣。
 *    所以学籍一变成「休学」，财务这边就要把这两项费用冻结起来。
 *
 * ⚠️ 联动方式：
 *    学籍状态归【教务/市场咨询】模块管，财务不直接改别人的数据。
 *    所以由他们调我方的 POST /api/finance/freeze/sync 接口通知，
 *    我方根据通知的 studentStatus 决定「冻结」还是「解冻」。
 *
 * ⚠️ 关于 student_status 字段：
 *    这里存的是【学生状态】枚举（6=休学），不是 pay_status！
 *    见《公共数据字典》4.1，别混了。
 */

import { randomUUID } from 'crypto';
import { BizCode, StudentStatus, STUDENT_STATUS_NAME, DEPT_NAME } from 'shared-types/finance';
import { db } from '../utils/db';
import { BizError } from '../middleware/errorHandler';
import { toDateStr, toTimeStr, freezeFeeByStudent, FEE_TABLE, isTempStudentNo } from './fee.service';

export const FREEZE_TABLE = 't_finance_freeze';

/** 默认冻结范围 */
const DEFAULT_SCOPE = '餐费、住宿费';

/**
 * 计算剩余天数
 *
 * ⚠️ 为什么不用「到期日 - 冻结起始日」？
 *    因为「剩余天数」是给财务看的活数据 —— 今天看是 111 天，
 *    过一周再看应该是 104 天，而不是一直显示建档时的 111。
 *    所以这里按【当前日期】算。
 */
export function calcRestDays(expire: any): number {
  if (!expire) return 0;
  const d = new Date(toDateStr(expire) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((d.getTime() - today.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

/** 冻结行 → 前端契约格式 */
export function toFreezeListItem(r: any) {
  return {
    id: r.id,
    studentId: r.student_id,
    // ★ 2026-10-22 未分班（只有 ZX 临时号）→ 学号留空，前端显示「—」
    studentNo: isTempStudentNo(r.student_no) ? '' : r.student_no,
    studentName: r.student_name,
    classId: r.class_id ?? undefined,
    className: r.class_name ?? undefined,
    deptCode: r.dept_code ?? undefined,
    deptName: r.dept_code ? DEPT_NAME[r.dept_code] : undefined,
    studentStatus: r.student_status,
    studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
    freezeScope: r.freeze_scope,
    freezeReason: r.freeze_reason ?? '',
    freezeDate: toDateStr(r.freeze_date) || '',
    freezeSource: r.freeze_source,
    freezeSourceName: r.freeze_source === 1 ? '自动冻结' : '手动冻结',
    operatorName: r.operator_name ?? undefined,
    mealFrom: toDateStr(r.meal_from),
    mealExpire: toDateStr(r.meal_expire),
    // ⚠️ 剩余天数按【今天】实时算，不读库里的静态值（库里的值是建档时的快照）
    mealRestDays: calcRestDays(r.meal_expire),
    dormFrom: toDateStr(r.dorm_from),
    dormExpire: toDateStr(r.dorm_expire),
    dormRestDays: calcRestDays(r.dorm_expire),
    isFrozen: !!r.is_frozen,
  };
}

/** 构造列表查询条件 */
export function buildFreezeQuery(q: any) {
  const query = db(FREEZE_TABLE).where('is_deleted', false);

  if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
  if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
  if (q.classId) query.andWhere('class_id', q.classId);
  if (q.deptCode) query.andWhere('dept_code', q.deptCode);
  if (q.freezeSource) query.andWhere('freeze_source', q.freezeSource);
  if (q.onlyFrozen === true) query.andWhere('is_frozen', true);
  if (q.keyword) {
    query.andWhere((qb: any) => {
      qb.where('student_no', 'like', `%${q.keyword}%`)
        .orWhere('student_name', 'like', `%${q.keyword}%`);
    });
  }
  return query;
}

/** 判断某笔冻结是否覆盖餐费 / 住宿费 */
function scopeHas(scope: string, item: string): boolean {
  return (scope || '').includes(item);
}

/**
 * 【核心】学籍状态变更同步（供其他模块调用）
 *
 * 入参：studentId、studentStatus（变更后的状态）、changeTime
 *
 * 逻辑：
 *    studentStatus = 6 休学  → 冻结该生「餐费 + 住宿费」
 *        · 若已有生效中的冻结记录，不重复建（幂等）
 *        · 同时把未缴/已缴未核对的餐费、住宿费缴费单置为「冻结」
 *    studentStatus ≠ 6      → 解冻其生效中的冻结记录（复学、转班等）
 *        · 同时把缴费单从「冻结」恢复为「待缴」
 *
 * ⚠️ 幂等很重要：
 *    教务模块可能因为重试、批量操作等原因重复调用同步接口。
 *    如果每次都插一条新冻结记录，名单里就会出现一堆重复项。
 *
 * @returns { freezeCount, unfreezeCount, message }
 */
export async function syncStudentStatus(
  body: {
    studentId: string;
    studentStatus: number;
    changeTime?: string;
    // 以下为兜底快照字段：教务/咨询拉不到学生主数据时可直接带过来，
    // 避免因为跨模块取数失败导致冻结记录里学生姓名为空。
    studentNo?: string;
    studentName?: string;
    classId?: string;
    className?: string;
    deptCode?: number;
  },
  operator: { userId: string; userName: string },
): Promise<{ freezeCount: number; unfreezeCount: number; message: string }> {
  const { studentId, studentStatus } = body;
  const isSuspended = Number(studentStatus) === StudentStatus.SUSPENDED;
  const now = new Date();

  // ---- 查学生基础信息（拿姓名/班级/学号，用于冗余存储）----
  // ⚠️ 跨模块取数失败不能白屏：拉不到就允许调用方只传 studentId
  let stu: any = null;
  try {
    stu = await db('t_student_base').where({ id: studentId, is_deleted: false }).first();
  } catch {
    stu = null;
  }

  // ---- 快照兜底顺序：学生主数据 → 请求体传入 → 缴费单里的冗余信息 ----
  // 最后这层兜底很关键：t_student_base 是各模块同步过来的示例表，
  // 经常是空的，但缴费单里本来就存着学生姓名/班级（冗余字段），
  // 从这里取能保证冻结记录不会是「无名氏」。
  let feeSnapshot: any = null;
  if (!stu?.student_name && !body.studentName) {
    try {
      feeSnapshot = await db(FEE_TABLE)
        .where({ student_id: studentId, is_deleted: false })
        .first();
    } catch {
      feeSnapshot = null;
    }
  }

  const snapshot = {
    student_no:
      stu?.student_no ?? body.studentNo ?? feeSnapshot?.student_no ?? '',
    student_name:
      stu?.student_name ?? body.studentName ?? feeSnapshot?.student_name ?? '',
    class_id: stu?.class_id ?? body.classId ?? feeSnapshot?.class_id ?? null,
    class_name:
      stu?.class_name ?? body.className ?? feeSnapshot?.class_name ?? null,
    dept_code:
      stu?.dept_code ?? body.deptCode ?? feeSnapshot?.dept_code ?? null,
  };

  // ================= 休学 → 冻结 =================
  if (isSuspended) {
    const active = await db(FREEZE_TABLE)
      .where({ student_id: studentId, is_frozen: true, is_deleted: false })
      .first();

    if (active) {
      // 幂等：已经有生效中的冻结，把缴费单同步一下就行
      await freezeFeeByStudent(studentId, true, operator);
      return {
        freezeCount: 0,
        unfreezeCount: 0,
        message: `该学生已处于冻结中（冻结日期 ${toDateStr(active.freeze_date)}），未重复冻结`,
      };
    }

    // 冻结期限：默认从休学日起算到当年年底 / 次年 1 月中
    const freezeDate = toDateStr(body.changeTime || now)!;
    const year = new Date(freezeDate).getFullYear();
    const mealExpire = `${year}-12-31`;
    const dormExpire = `${year + 1}-01-15`;

    await db(FREEZE_TABLE).insert({
      id: randomUUID(),
      create_time: now,
      create_by: operator.userId,
      is_deleted: false,
      student_id: studentId,
      ...snapshot,
      student_status: StudentStatus.SUSPENDED,
      freeze_scope: DEFAULT_SCOPE,
      meal_from: freezeDate,
      meal_expire: mealExpire,
      meal_rest_days: calcRestDays(mealExpire),
      dorm_from: freezeDate,
      dorm_expire: dormExpire,
      dorm_rest_days: calcRestDays(dormExpire),
      freeze_reason: '休学',
      freeze_date: freezeDate,
      freeze_source: 1, // 自动冻结
      operator_id: operator.userId,
      operator_name: operator.userName,
      is_frozen: true,
    });

    // 缴费单同步置为「冻结」
    const feeCount = await freezeFeeByStudent(studentId, true, operator);

    return {
      freezeCount: 1,
      unfreezeCount: 0,
      message: `已自动冻结餐费与住宿费（同步 ${feeCount} 笔缴费单）`,
    };
  }

  // ================= 非休学 → 解冻 =================
  const affected = await db(FREEZE_TABLE)
    .where({ student_id: studentId, is_frozen: true, is_deleted: false })
    .update({
      is_frozen: false,
      unfreeze_time: now,
      unfreeze_reason: `学籍变更为「${STUDENT_STATUS_NAME[studentStatus] || studentStatus}」，自动解冻`,
      update_time: now,
      update_by: operator.userId,
    });

  if (!affected) {
    return {
      freezeCount: 0,
      unfreezeCount: 0,
      message: '该学生当前没有生效中的冻结记录，无需解冻',
    };
  }

  const feeCount = await freezeFeeByStudent(studentId, false, operator);

  return {
    freezeCount: 0,
    unfreezeCount: Number(affected) || 0,
    message: `学籍已变更，已自动解冻餐费与住宿费（恢复 ${feeCount} 笔缴费单）`,
  };
}

/** 解冻（财务手工操作，比如误冻结要撤销） */
export async function unfreeze(
  id: string,
  unfreezeReason: string,
  operator: { userId: string; userName: string },
): Promise<void> {
  const row = await db(FREEZE_TABLE).where({ id, is_deleted: false }).first();
  if (!row) {
    throw new BizError(BizCode.PARAM_ERROR, '冻结记录不存在');
  }
  if (!row.is_frozen) {
    throw new BizError(BizCode.PARAM_ERROR, '该记录已是解冻状态，无需重复操作');
  }
  if (!unfreezeReason || !unfreezeReason.trim()) {
    throw new BizError(BizCode.REQUIRED_FIELD_MISSING, '解冻原因必填');
  }

  const now = new Date();
  await db(FREEZE_TABLE).where({ id }).update({
    is_frozen: false,
    unfreeze_time: now,
    unfreeze_reason: unfreezeReason.trim(),
    update_time: now,
    update_by: operator.userId,
  });

  // 同步恢复缴费单状态
  if (row.student_id) {
    await freezeFeeByStudent(row.student_id, false, operator);
  }
}

/** 手工冻结（兜底：学籍接口没通或特殊情况） */
export async function manualFreeze(
  body: { studentId: string; freezeScope?: string; freezeReason?: string },
  operator: { userId: string; userName: string },
): Promise<{ id: string }> {
  const { studentId } = body;

  const active = await db(FREEZE_TABLE)
    .where({ student_id: studentId, is_frozen: true, is_deleted: false })
    .first();
  if (active) {
    throw new BizError(BizCode.PARAM_ERROR, '该学生已处于冻结中，请勿重复冻结');
  }

  let stu: any = null;
  try {
    stu = await db('t_student_base').where({ id: studentId, is_deleted: false }).first();
  } catch {
    stu = null;
  }

  const id = randomUUID();
  const now = new Date();
  const freezeDate = toDateStr(now)!;
  const scope = body.freezeScope || '餐费';
  const year = now.getFullYear();

  await db(FREEZE_TABLE).insert({
    id,
    create_time: now,
    create_by: operator.userId,
    is_deleted: false,
    student_id: studentId,
    student_no: stu?.student_no ?? '',
    student_name: stu?.student_name ?? '',
    class_id: stu?.class_id ?? null,
    class_name: stu?.class_name ?? null,
    dept_code: stu?.dept_code ?? null,
    // 手工冻结时学生不一定休学，记录其当前状态
    student_status: stu?.student_status ?? StudentStatus.STUDYING,
    freeze_scope: scope,
    meal_from: scopeHas(scope, '餐费') ? freezeDate : null,
    meal_expire: scopeHas(scope, '餐费') ? `${year}-12-31` : null,
    meal_rest_days: scopeHas(scope, '餐费') ? calcRestDays(`${year}-12-31`) : 0,
    dorm_from: scopeHas(scope, '住宿') ? freezeDate : null,
    dorm_expire: scopeHas(scope, '住宿') ? `${year + 1}-01-15` : null,
    dorm_rest_days: scopeHas(scope, '住宿') ? calcRestDays(`${year + 1}-01-15`) : 0,
    freeze_reason: body.freezeReason || '手动冻结',
    freeze_date: freezeDate,
    freeze_source: 2, // 手动冻结
    operator_id: operator.userId,
    operator_name: operator.userName,
    is_frozen: true,
  });

  await freezeFeeByStudent(studentId, true, operator);
  return { id };
}
