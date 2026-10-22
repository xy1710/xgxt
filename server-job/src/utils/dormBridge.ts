/**
 * 宿舍申请「就业 ↔ 教务」桥接（2026-10-03 合并后新增）
 *
 * ============================================================
 * 【解决什么问题】
 * ============================================================
 *   合并前：实训学生的换宿 / 退宿申请，在「就业管理 → 宿舍管理」里
 *           由班主任发起、**教务老师在自己的系统里审批**（但那其实是两条线）。
 *
 *   合并后（斌哥 2026-10-03 拍板）：
 *     · 我们这边只负责**发起 + 看进度 + 撤回**，不再审批；
 *     · 申请单一提交，就**同步一条到教务的申请表**；
 *     · 教务在「教务管理 → 宿舍管理 → 申请审批」里审批；
 *     · 审批结果**跨库回写**我们这边（状态 + 床位）。
 *
 * ------------------------------------------------------------
 * 【为什么能跨库】
 *   教务的表在 sms_edu，我们的在 sms_job，但**同一个 MySQL 实例**。
 *   这里全部用 `sms_edu.xxx` 全限定名 + 调用方传进来的同一个事务对象（trx），
 *   所以「改我们这边 + 改教务那边」在**同一个事务**里，要么都成、要么都滚。
 *
 * ------------------------------------------------------------
 * 【字段映射】我们的申请单 → 教务申请表
 *   change_no          → apply_no
 *   student_name       → student_name
 *   class_name         → class_name
 *   head_teacher_name  → head_teacher_name
 *   change_reason      → reason
 *   change_date        → apply_date
 *   旧宿舍(building/room_no/old_bed_no) → from_* 或 quit_*
 *   新宿舍(building/room_no/new_bed_no) → to_*
 *   （并额外打上 source='job' + source_id=我们的申请单ID + student_no，
 *     供教务审批时认出来并回写）
 */

import { randomUUID } from 'crypto';
import { DormChangeBizType, ApplyStatus } from 'shared-types';
import { today } from './date';
// ★ 统一表切读层：本文件**只有** t_job_dorm 已归一（→ t_uni_dorm_room）；
//   sms_edu 的两张申请表未归一，继续走裸 trx(table)（见下方同步/撤回函数）。
import { tblTrx } from '../teaching/shared/uniTable';

/** 教务侧申请表（按业务类型选）—— sms_edu 未归一，保持裸表名访问 */
export const EDU_CHANGE_APPLY = 'sms_edu.t_edu_dorm_change_apply';
export const EDU_QUIT_APPLY = 'sms_edu.t_edu_dorm_quit_apply';

/** 我们的宿舍主档（拿楼栋 / 房间号用）—— 已归一，走 tblTrx 路由 */
const JOB_DORM = 't_job_dorm';
/** ★ t_job_dorm 的库名与学段（实训） */
const JOB_DB = 'sms_job';
const JOB_STAGE = 'job' as const;

export function eduApplyTableOf(bizType: number): string {
  return bizType === DormChangeBizType.CHANGE ? EDU_CHANGE_APPLY : EDU_QUIT_APPLY;
}

/**
 * 把就业侧的一条申请单，同步写入教务申请表（**提交时**调用）
 *
 * @param trx      调用方的事务对象（必须传，保证跨库原子）
 * @param jobRow   t_job_dorm_change 的一行
 * @param operator 操作人
 */
export async function syncApplyToEdu(trx: any, jobRow: any, operator: any): Promise<void> {
  const isChange = jobRow.biz_type === DormChangeBizType.CHANGE;
  const table = eduApplyTableOf(jobRow.biz_type);
  const now = new Date();

  // 拿新旧宿舍的楼栋 / 房间号（我们表里存的是 dorm_no 快照，教务要拆成 building + room）
  const oldDorm = jobRow.old_dorm_id
    ? await tblTrx(trx, JOB_DB, JOB_DORM, JOB_STAGE).where({ id: jobRow.old_dorm_id }).first()
    : null;
  const newDorm = jobRow.new_dorm_id
    ? await tblTrx(trx, JOB_DB, JOB_DORM, JOB_STAGE).where({ id: jobRow.new_dorm_id }).first()
    : null;

  const common = {
    id: randomUUID(),
    create_time: now,
    create_by: operator?.userId || 'system',
    is_deleted: false,

    // ⚠️ 我们的 change_no 目前 create 时没写入（历史遗留），
    //    教务这边 apply_no 是 notNullable → 兜一个，避免 DEFAULT 报错
    apply_no: jobRow.change_no || `JOB-${String(jobRow.id).slice(0, 24)}`,
    student_name: jobRow.student_name || '',
    class_name: jobRow.class_name || null,
    head_teacher_name: jobRow.head_teacher_name || null,
    reason: jobRow.change_reason || null,
    apply_date: jobRow.change_date || today(),
    status: ApplyStatus.PENDING,

    // ⭐ 同步标记：教务审批时靠这三列认出「这是就业侧来的」并回写
    source: 'job',
    source_id: jobRow.id,
    student_no: jobRow.student_no || null,

    // 性别：教务「申请审批」列表要和就业侧一样显示 姓名+性别+学号
    // （2026-10-04 新增列，见 migrations-edu/20261004_001_add_gender_to_dorm_apply.js）
    gender: jobRow.gender ?? null,
  };

  // ⚠️★★ 2026-10-04 幂等化（斌哥报「同步不到教务」的真正原因之一）
  //
  //  原来这里是**无条件 insert** —— 同一张申请单只要再走一次提交
  //  （撤回后重提、或重复点提交），教务那边就会**多出一条一模一样的单**。
  //  实测：job 侧 9 张申请单，教务侧却收到 10 条（4+6）——
  //  教务列表里混着重复单，审批人看到一堆一样的单子，
  //  就会以为「同步乱了 / 看不到刚提交的那条」。
  //
  //  现在改成 upsert：按 source + source_id 找
  //    · 找不到 → insert（首次提交）
  //    · 找到了且还在「待审核」→ update，把内容刷新到最新（撤回后重提）
  //    · 找到了但已审批过 → **不动**（保住教务的审批结果，不能被重提覆盖）
  const existed = await trx(table)
    .where({ source: 'job', source_id: jobRow.id, is_deleted: false })
    .first();

  if (existed) {
    if (existed.status !== ApplyStatus.PENDING) {
      // 已经审批过了 → 不覆盖，保留教务的结论
      return;
    }
    const { id: _drop, ...patch } = common;
    void _drop;
    if (isChange) {
      await trx(table)
        .where({ id: existed.id })
        .update({
          ...patch,
          from_building: oldDorm?.building || null,
          from_room: oldDorm?.room_no || null,
          from_bed: jobRow.old_bed_no != null ? String(jobRow.old_bed_no) : null,
          to_building: newDorm?.building || null,
          to_room: newDorm?.room_no || null,
          to_bed: jobRow.new_bed_no != null ? String(jobRow.new_bed_no) : null,
        });
    } else {
      await trx(table)
        .where({ id: existed.id })
        .update({
          ...patch,
          quit_building: oldDorm?.building || null,
          quit_room: oldDorm?.room_no || null,
          quit_bed: jobRow.old_bed_no != null ? String(jobRow.old_bed_no) : null,
          phone: jobRow.phone || null,
        });
    }
    return;
  }

  if (isChange) {
    await trx(table).insert({
      ...common,
      from_building: oldDorm?.building || null,
      from_room: oldDorm?.room_no || null,
      from_bed: jobRow.old_bed_no != null ? String(jobRow.old_bed_no) : null,
      to_building: newDorm?.building || null,
      to_room: newDorm?.room_no || null,
      to_bed: jobRow.new_bed_no != null ? String(jobRow.new_bed_no) : null,
    });
  } else {
    await trx(table).insert({
      ...common,
      quit_building: oldDorm?.building || null,
      quit_room: oldDorm?.room_no || null,
      quit_bed: jobRow.old_bed_no != null ? String(jobRow.old_bed_no) : null,
      phone: jobRow.phone || null,
    });
  }
}

/**
 * 撤回时，把教务那条也撤掉（逻辑删除，教务列表里就看不到了）
 *
 * ⚠️ 只撤「还没审批」的那条 —— 已通过 / 已驳回的不动。
 */
export async function cancelEduApply(trx: any, jobRow: any): Promise<void> {
  const table = eduApplyTableOf(jobRow.biz_type);
  await trx(table)
    .where({
      source: 'job',
      source_id: jobRow.id,
      status: ApplyStatus.PENDING,
      is_deleted: false,
    })
    .update({ is_deleted: true, update_time: new Date() });
}
