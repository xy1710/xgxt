/**
 * 班级花名册路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/class-student
 * 表：t_job_class_student（花名册）
 * 字段依据：docs/班级信息+出勤-字段定稿.md 第二节
 *
 * ⚠️ 核心规则（斌哥拍板）：
 *   1. 【同步学生主档】加学生进班 / 移出班级时，必须同步更新
 *      t_student_base.class_id 和 class_name（学生表是主档）
 *   2. 【封班限制】封班的班只接受「休学学生」和「末次班学生」转入
 *   3. 【结业限制】已结业的班不允许再加学生
 *   4. 学生换班后旧记录留着（改成 status=2已离班），保留完整履历
 *   5. 班级 student_count 每次变动后重算
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  RoleCode,
  JOIN_TYPE_NAME,
  LEAVE_TYPE_NAME,
  CLASS_STUDENT_STATUS_NAME,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDate, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ P3 切读层：本文件三张表（t_job_class_student / t_job_class / t_student_base）都已归一，
//   读/写走 tbl()/tblTrx()/tblInsTrx()，两处 join 走 tblAs()/tblRef()；开关关时与原实现等价。
import { tbl, tblAs, tblRef, tblInsTrx, tblTrx, phaseCodeSelect } from '../teaching/shared/uniTable';

export const classStudentRouter = Router();

/** 表名常量 */
const CS_TABLE = 't_job_class_student';
const CLASS_TABLE = 't_job_class';
const STUDENT_TABLE = 't_student_base';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 花名册在班状态 */
const CS_IN = 1;
const CS_LEFT = 2;

/** 班级状态 */
const STATUS_OPEN = 1;
const STATUS_SEALED = 2;
const STATUS_GRADUATED = 4;

/** 学生状态：6休学 */
const STUDENT_SUSPENDED = 6;

/**
 * 重算班级人数（只统计在班）
 * 任何花名册变动后都要调一次 —— 保证 t_job_class.student_count 准确
 */
async function refreshStudentCount(classId: string) {
  const [{ cnt }] = (await tbl(db, DB, CS_TABLE, STAGE)
    .where({ class_id: classId, status: CS_IN, is_deleted: false })
    .count({ cnt: '*' })) as Array<{ cnt: number }>;
  await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: classId }).update({
    student_count: Number(cnt),
    update_time: new Date(),
  });
}

/* ============================================================
 * 1. 花名册列表
 *    GET /api/job/class-student/page?classId=xxx&status=1
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  classId: z.string().min(1, '班级ID必传'),
  status: z.coerce.number().int().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
});

classStudentRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tblAs(db, DB, CS_TABLE, STAGE, 'cs')
      .leftJoin(`${tblRef(DB, STUDENT_TABLE)} as s`, 'cs.student_id', 's.id')
      .where('cs.is_deleted', false)
      .andWhere('cs.class_id', q.classId);

    // ★ 阶段隔离：班主任看不到实训花名册；项目经理只看自己带的班
    await applyTrainingScope(query, req, { table: 'cs' });

    if (q.status) query.andWhere('cs.status', q.status);
    if (q.studentNo) query.andWhere('cs.student_no', 'like', `%${q.studentNo}%`);
    if (q.studentName) query.andWhere('cs.student_name', 'like', `%${q.studentName}%`);

    const [{ total }] = await query.clone().count({ total: 'cs.id' });

    const rows = await query
      .clone()
      .select(
        'cs.*',
        's.gender as s_gender',
        's.phone as s_phone',
        's.parent_phone as s_parent_phone',
        's.repeat_count as s_repeat_count',
        // ★ #23 方案B：join 侧换列名（别名保持 s_stage，下游 r.s_stage 不变）
        phaseCodeSelect({ ref: 's', alias: 's_stage' }),
        's.dorm_no as s_dorm_no',
      )
      .orderBy('cs.status', 'asc')
      .orderBy('cs.student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      id: r.id,
      classId: r.class_id,
      className: r.class_name,
      studentId: r.student_id,
      studentNo: r.student_no,
      studentName: r.student_name,
      joinDate: fmtDate(r.join_date),
      joinType: r.join_type,
      joinTypeName: JOIN_TYPE_NAME[r.join_type] || '',
      leaveDate: fmtDate(r.leave_date),
      leaveType: r.leave_type,
      leaveTypeName: r.leave_type ? LEAVE_TYPE_NAME[r.leave_type] || '' : '',
      leaveReason: r.leave_reason,
      status: r.status,
      statusName: CLASS_STUDENT_STATUS_NAME[r.status] || '',
      remark: r.remark,
      createTime: fmtDateTime(r.create_time),

      // 学生主档带出来的附加信息
      gender: r.s_gender,
      phone: r.s_phone,
      parentPhone: r.s_parent_phone,
      repeatCount: r.s_repeat_count,
      stage: r.s_stage,
      dormNo: r.s_dorm_no,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 可加入班级的候选人
 *    GET /api/job/class-student/candidates?classId=xxx
 *
 * 返回：不在本班（在班状态）、且未逻辑删除的学生
 * ============================================================ */

classStudentRouter.get(
  '/candidates',
  validate(
    z.object({
      classId: z.string().min(1),
      studentNo: z.string().optional(),
      studentName: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated;

    // 先查出「已经在本班（在班）」的学生ID，排除掉
    const inClass = await tbl(db, DB, CS_TABLE, STAGE)
      .where({ class_id: q.classId, status: CS_IN, is_deleted: false })
      .select('student_id');
    const excludeIds = inClass.map((r: any) => r.student_id);

    const query = tblAs(db, DB, STUDENT_TABLE, STAGE, 's')
      .leftJoin(`${tblRef(DB, CLASS_TABLE)} as c`, 's.class_id', 'c.id')
      .where('s.is_deleted', false);

    if (excludeIds.length) query.whereNotIn('s.id', excludeIds);
    if (q.studentNo) query.andWhere('s.student_no', 'like', `%${q.studentNo}%`);
    if (q.studentName) query.andWhere('s.student_name', 'like', `%${q.studentName}%`);

    const rows = await query
      .select(
        's.id as student_id',
        's.student_no',
        's.student_name',
        's.gender',
        's.repeat_count',
        's.student_status',
        'c.class_name as current_class_name',
      )
      .orderBy('s.student_no', 'asc')
      .limit(q.limit);

    res.json(
      ok(
        rows.map((r: any) => ({
          studentId: r.student_id,
          studentNo: r.student_no,
          studentName: r.student_name,
          gender: r.gender,
          currentClassName: r.current_class_name || null,
          repeatCount: r.repeat_count,
          studentStatus: r.student_status,
          studentStatusName: '',
        })),
      ),
    );
  }),
);

/* ============================================================
 * 3. 批量加学生进班
 *    POST /api/job/class-student/add
 *
 * ⚠️ 同步改学生主档 t_student_base.class_id / class_name
 * ============================================================ */

/**
 * ⚠️ 教务老师对花名册是【只读】的（斌哥 2026-09-30）：能看名单，不能加/移学生。
 *    前端已经把按钮藏了，这里再拦一道 —— 前端藏 ≠ 安全。
 *
 * ⚠️ ★ 2026-10-06：学管主任（TEACH_DEAN）同样【只读】。
 *    他是审批角色，花名册加减人属业务写操作，不由他办。
 *    （更外层还有 middleware/approvalOnly.ts 的只读总闸兜底。）
 */
function blockEduAdminWrite(req: any, _res: any, next: any): void {
  const roles: string[] = req.user?.roles || [];
  if (roles.includes(RoleCode.TEACH_DEAN)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '学管主任对花名册只有查看权限');
  }
  if (roles.includes(RoleCode.ACAD_STAFF) && !roles.includes(RoleCode.SYS_ADMIN)) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '教务老师对花名册只有查看权限');
  }
  next();
}

classStudentRouter.post(
  '/add',
  blockEduAdminWrite,
  validate(
    z.object({
      classId: z.string().min(1),
      studentIds: z.array(z.string().min(1)).min(1, '至少选一个学生'),
      joinType: z.number().int().min(1).max(4),
      joinDate: z.string().optional(),
      remark: z.string().max(200).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // ---- 规则：已结业的班不能加人 ----
    if (cls.class_status === STATUS_GRADUATED) {
      throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '班级已结业，不能再加学生');
    }

    // ---- 规则：封班的班只接受「休学学生」和「末次班学生」 ----
    const students = await tbl(db, DB, STUDENT_TABLE, STAGE)
      .whereIn('id', body.studentIds)
      .andWhere('is_deleted', false)
      .select('id', 'student_no', 'student_name', 'student_status', 'repeat_count', 'class_id', 'class_name');

    if (students.length !== body.studentIds.length) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '部分学生不存在，请刷新后重试');
    }

    if (cls.class_status === STATUS_SEALED) {
      const illegal = students.filter(
        (s: any) => s.student_status !== STUDENT_SUSPENDED && !(s.repeat_count > 0),
      );
      if (illegal.length) {
        const names = illegal.map((s: any) => s.student_name).join('、');
        throw new BizError(
          BizCode.CLASS_STATUS_NOT_ALLOW,
          `班级已封班，只接受休学学生和末次班学生转入。以下学生不符合：${names}`,
        );
      }
    }

    // ---- 找出已经在班的（防重复） ----
    const exist = await tbl(db, DB, CS_TABLE, STAGE)
      .where({ class_id: body.classId, status: CS_IN, is_deleted: false })
      .whereIn('student_id', body.studentIds)
      .select('student_id');
    const existIds = new Set(exist.map((r: any) => r.student_id));

    const toAdd = students.filter((s: any) => !existIds.has(s.id));
    if (!toAdd.length) {
      throw new BizError(BizCode.STUDENT_ALREADY_IN_CLASS, '所选学生都已在班，无需重复添加');
    }

    const joinDate = body.joinDate || today();
    const now = new Date();

    await db.transaction(async (trx) => {
      const rows = toAdd.map((s: any) => ({
        id: randomUUID(),
        create_time: now,
        create_by: req.user?.userId || null,
        is_deleted: false,

        class_id: body.classId,
        class_name: cls.class_name,
        student_id: s.id,
        student_no: s.student_no,
        student_name: s.student_name,

        join_date: joinDate,
        join_type: body.joinType,
        status: CS_IN,
        remark: body.remark || null,
      }));

      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        await tblInsTrx(trx, DB, CS_TABLE, STAGE, rows.slice(i, i + BATCH));
      }

      // ⚠️ 同步学生主档（斌哥拍板：要同步）
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .whereIn('id', toAdd.map((s: any) => s.id))
        .update({
          class_id: body.classId,
          class_name: cls.class_name,
          update_time: now,
        });
    });

    await refreshStudentCount(body.classId);

    res.json(ok({ addedCount: toAdd.length }));
  }),
);

/* ============================================================
 * 4. 批量移出班级
 *    POST /api/job/class-student/remove
 *
 * 做法：把 status 改成 2已离班 + 记录离班方式/日期/原因
 *      （不删记录，保留履历）
 * ⚠️ 同步清空学生主档的 class_id
 * ============================================================ */

classStudentRouter.post(
  '/remove',
  blockEduAdminWrite,
  validate(
    z.object({
      classId: z.string().min(1),
      studentIds: z.array(z.string().min(1)).min(1, '至少选一个学生'),
      leaveType: z.number().int().min(1).max(5),
      leaveDate: z.string().optional(),
      leaveReason: z.string().max(200).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    // 只处理「在班」的那条记录
    const rows = await tbl(db, DB, CS_TABLE, STAGE)
      .where({ class_id: body.classId, status: CS_IN, is_deleted: false })
      .whereIn('student_id', body.studentIds)
      .select('id', 'student_id', 'student_name');

    if (!rows.length) {
      throw new BizError(BizCode.STUDENT_NOT_IN_CLASS, '所选学生不在此班的在班名单中');
    }

    const leaveDate = body.leaveDate || today();
    const now = new Date();

    await db.transaction(async (trx) => {
      await tblTrx(trx, DB, CS_TABLE, STAGE)
        .whereIn(
          'id',
          rows.map((r: any) => r.id),
        )
        .update({
          status: CS_LEFT,
          leave_date: leaveDate,
          leave_type: body.leaveType,
          leave_reason: body.leaveReason || null,
          update_time: now,
          update_by: req.user?.userId || null,
        });

      // ⚠️ 同步学生主档：把 class_id / class_name 清空
      //    （说明：本模块只管实训班，学生可能马上要进新班；
      //      若走「换班」流程，换班接口会在新班里重新写 class_id）
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .whereIn('id', rows.map((r: any) => r.student_id))
        .andWhere('class_id', body.classId)
        .update({
          class_id: null,
          class_name: null,
          update_time: now,
        });
    });

    await refreshStudentCount(body.classId);

    res.json(ok({ removedCount: rows.length }));
  }),
);
