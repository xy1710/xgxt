/**
 * 学生基础信息路由（信息档案 - 基础信息）
 *
 * ⚠️ 脑图要求的 12 个字段：
 *    姓名 / 学号 / 班级 / 性别 / 年龄 / 手机号 / 家长手机号
 *    宿舍号 / 入学时间 / 学历 / 简历 / 学生状态（待就业·已就业·休学·退学）
 *
 * 在原示例基础上补充：
 *    - 列表返回完整档案字段（避免点开详情才能看）
 *    - 简历文件（文件名 + base64 内容）
 *    - unassigned 筛选（宿舍分配页用来找「还没分宿舍」的学生）
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  STUDENT_STATUS_NAME,
  GENDER_NAME,
  DEPT_NAME,
  DORM_TYPE_NAME,
  StudentStatus,
  RoleCode,
  ClassStatus,
  hasRole,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission, SUPER_TEST_ROLE } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { fmtDate } from '../utils/date';
// ★ P3 切读层：本文件四张表（t_student_base / t_job_class / t_dorm / t_employment_log）都已归一，
//   读/写走 tbl()/tblTrx()/tblIns()/tblInsTrx()；列表接口的一处 join 走 tblAs()/tblRef()；
//   开关关时与原实现等价。
import { tbl, tblAs, tblRef, tblIns, tblInsTrx, tblTrx } from '../teaching/shared/uniTable';

export const studentRouter = Router();

const TABLE = 't_student_base';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/* ============================================================
 * 1. 查询学生列表（信息档案 - 基础信息）
 *    GET /api/job/student/list?page=1&size=20&studentName=张
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  className: z.string().optional(),
  /**
   * ★ 2026-10-04：按班级 ID 精确筛选（档案页顶部「班级筛选器」用）
   *   为什么不用已有的 className：那是 `like '%Q1%'` 模糊匹配，
   *   Q1 会把 Q10~Q19 一起捞出来。班级筛选必须精确。
   */
  classId: z.string().optional(),
  phone: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  studentStatus: z.coerce.number().int().optional(),
  education: z.string().optional(),
  keyword: z.string().optional(),
  unassigned: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

studentRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as {
      page: number;
      size: number;
      studentNo?: string;
      studentName?: string;
      className?: string;
      classId?: string;
      phone?: string;
      deptCode?: number;
      studentStatus?: number;
      education?: string;
      keyword?: string;
      unassigned?: boolean;
    };

    const query = tblAs(db, DB, TABLE, STAGE, TABLE)
      .leftJoin(`${tblRef(DB, 't_dorm')} as t_dorm`, 't_student_base.dorm_id', '=', 't_dorm.id')
      .where('t_student_base.is_deleted', false)
      // ⚠️ 就业模块只管「走出咨询阶段」的学生，前面的状态一概不显示
      .whereIn('t_student_base.student_status', [
        StudentStatus.WAIT_EMPLOY,
        StudentStatus.EMPLOYED,
        StudentStatus.SUSPENDED,
        StudentStatus.QUIT,
      ]);

    if (q.studentNo) query.andWhere('t_student_base.student_no', 'like', `%${q.studentNo}%`);
    if (q.studentName) query.andWhere('t_student_base.student_name', 'like', `%${q.studentName}%`);
    if (q.className) query.andWhere('t_student_base.class_name', 'like', `%${q.className}%`);
    if (q.classId) query.andWhere('t_student_base.class_id', q.classId);
    if (q.phone) query.andWhere('t_student_base.phone', 'like', `%${q.phone}%`);
    if (q.deptCode) query.andWhere('t_student_base.dept_code', q.deptCode);
    if (q.studentStatus) query.andWhere('t_student_base.student_status', q.studentStatus);
    if (q.education) query.andWhere('t_student_base.education', 'like', `%${q.education}%`);
    if (q.keyword) {
      query.andWhere((qb: any) => {
        qb.where('t_student_base.student_no', 'like', `%${q.keyword}%`)
          .orWhere('t_student_base.student_name', 'like', `%${q.keyword}%`)
          .orWhere('t_student_base.phone', 'like', `%${q.keyword}%`);
      });
    }
    // 未分配宿舍：没宿舍ID 或 宿舍号为空
    if (q.unassigned) {
      query.andWhere((qb: any) => {
        qb.whereNull('t_student_base.dorm_id').orWhere('t_student_base.dorm_no', '');
      });
    }

    /* ============================================================
     * ★ 2026-10-08 数据范围隔离（斌哥拍板：项目经理只限自己带的实训班）
     *
     * 【为什么这处必须补】
     *   本接口此前**完全没有范围过滤** —— 任何登录用户拉一次
     *   /api/job/student/list 就能看到全部 16 个学生。
     *   实测：项目经理 sunjl 在宿舍页只看到 4 个（Q1），
     *        但在信息档案页看到 16 个（Q1~Q4 全班）→ 口径不一致。
     *
     * 【三分支口径】（与 dorm.route / classInfo.route 保持一致）
     *   · 管理员/学管/校长 → 不限（全量）
     *   · 项目经理        → 只看自己带的、的实训班
     *   · 班主任          → 只看自己带的班（班级优先，缺班级时按学生主档兜底）
     * ============================================================ */
    const roles = req.user?.roles || [];
    const uid = req.user?.userId || '';
    const isAdmin = hasRole(roles, RoleCode.SYS_ADMIN);
    const isPM = hasRole(roles, RoleCode.PROJECT_MANAGER);
    const isHead = hasRole(roles, RoleCode.TEACH_HEAD);
    const isDean = hasRole(roles, RoleCode.TEACH_DEAN);
    const isPrincipal = hasRole(roles, RoleCode.RM_PRINCIPAL);

    if (!isAdmin && !isDean && !isPrincipal) {
      if (isPM) {
        // 项目经理：只限自己带的实训班（含已结业 —— 见下方停用说明）
        // ⚠️ 这里**只按 class_id 过滤，不做 head_teacher_id 兜底** ——
        //    因为实训班的班主任字段与项目经理同人（斌哥口径：实训阶段班主任由
        //    项目经理担任），用 head_teacher_id 兜底会等于「全放开」，失去隔离。
        const mine = await tbl(db, DB, 't_job_class', STAGE)
          .where({ project_manager_id: uid, is_deleted: false })
          // [已停用] ★ 2026-10-08 斌哥拍板：项目经理可见自己带的【所有】实训班（含已结业）—— 去掉未结业限制
          // .whereNot('class_status', ClassStatus.GRADUATED)
          .select('id');
        const ids = mine.map((c: any) => c.id);
        if (ids.length === 0) query.whereRaw('1 = 0');
        else query.whereIn('t_student_base.class_id', ids);
      } else if (isHead) {
        // 班主任：只看自己带的班
        // ⚠️ 与上同理：实训阶段班主任与项目经理同人，head_teacher_id 无区分度，
        //    这里按 head_teacher_id **精确匹配**（不 OR 开班表），
        //    语义是「学生主档上写着我是他班主任」——
        //    对大学部真人班主任是准确的；对实训阶段的 sunjl 就是全部实训班。
        query.andWhere('t_student_base.head_teacher_id', uid);
      }
    }

    const [{ total }] = await query.clone().count({ total: '*' });

    const rows = await query
      .clone()
      .select(
        't_student_base.id',
        't_student_base.student_no',
        't_student_base.student_name',
        't_student_base.gender',
        't_student_base.age',
        't_student_base.dept_code',
        't_student_base.class_name',
        't_student_base.student_status',
        't_student_base.phone',
        't_student_base.parent_phone',
        't_student_base.dorm_id',
        't_student_base.dorm_no',
        't_student_base.education',
        't_student_base.enroll_date',
        't_student_base.resume_name',
        't_student_base.head_teacher_name',
        't_student_base.create_time',
        't_dorm.building as building',
        't_dorm.room_type as room_type',
      )
      .orderBy('t_student_base.create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // ⚠️ join 后 create_time 会被 t_dorm 覆盖，这里不依赖它，直接用上面的别名即可
    const list = rows.map((r: any) => ({
      studentId: r.id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      age: r.age,
      className: r.class_name,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
      phone: r.phone,
      parentPhone: r.parent_phone,
      dormNo: r.dorm_no,
      building: r.building,
      education: r.education,
      enrollDate: fmtDate(r.enroll_date),
      resumeName: r.resume_name,
      headTeacherName: r.head_teacher_name,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 查询学生详情（含简历内容）
 *    GET /api/job/student/detail?id=xxx
 * ============================================================ */

studentRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();

    if (!row) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    }

    const dorm = row.dorm_id
      ? await tbl(db, DB, 't_dorm', STAGE).where({ id: row.dorm_id, is_deleted: false }).first()
      : null;

    res.json(ok({
      id: row.id,
      studentNo: row.student_no,
      studentName: row.student_name,
      gender: row.gender,
      genderName: GENDER_NAME[row.gender] || '',
      age: row.age,
      deptCode: row.dept_code,
      deptName: DEPT_NAME[row.dept_code] || '',
      classId: row.class_id,
      className: row.class_name,
      studentStatus: row.student_status,
      studentStatusName: STUDENT_STATUS_NAME[row.student_status] || '',
      phone: row.phone,
      parentPhone: row.parent_phone,
      dormId: row.dorm_id,
      dormNo: row.dorm_no,
      building: dorm?.building,
      dormTypeName: dorm ? DORM_TYPE_NAME[dorm.room_type] || '' : '',
      education: row.education,
      enrollDate: fmtDate(row.enroll_date),
      resumeName: row.resume_name,
      resumeData: row.resume_data,
      remark: row.remark,
      createTime: row.create_time,
    }));
  }),
);

/* ============================================================
 * 3. 新增学生
 *    POST /api/job/student/add
 * ============================================================ */

const addSchema = z.object({
  studentNo: z.string().min(1, '学号必填'),
  studentName: z.string().min(1, '姓名必填'),
  gender: z.coerce.number().int().min(1).max(2, '性别只能是 1(男) 或 2(女)'),
  age: z.coerce.number().int().min(10).max(60).optional(),
  deptCode: z.coerce.number().int().min(1).max(2, '部门只能是 1(初高部) 或 2(大学部)'),
  className: z.string().max(50).optional(),
  classId: z.string().optional(),
  /** 就业模块只认这四种状态 */
  studentStatus: z.coerce
    .number()
    .int()
    .refine(
      (v) => [StudentStatus.WAIT_EMPLOY, StudentStatus.EMPLOYED, StudentStatus.SUSPENDED, StudentStatus.QUIT].includes(v),
      '学生状态只能是 待就业/已就业/休学/退学',
    )
    .optional(),
  phone: z.string().max(20).optional(),
  parentPhone: z.string().max(20).optional(),
  education: z.string().max(50).optional(),
  enrollDate: z.string().optional(),
  remark: z.string().max(500).optional(),
  resumeName: z.string().max(200).optional(),
  resumeData: z.string().optional(),
});

studentRouter.post(
  '/add',
  checkPermission('consult:student:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ student_no: body.studentNo, is_deleted: false }).first();
    if (exists) {
      throw new BizError(BizCode.STUDENT_NO_EXISTS, `学号 ${body.studentNo} 已存在，请勿重复添加`);
    }

    const id = randomUUID();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      student_no: body.studentNo,
      student_name: body.studentName,
      gender: body.gender,
      age: body.age ?? null,
      dept_code: body.deptCode,
      class_id: body.classId ?? null,
      class_name: body.className ?? null,
      student_status: body.studentStatus ?? StudentStatus.WAIT_EMPLOY,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      education: body.education ?? null,
      enroll_date: body.enrollDate ?? null,
      remark: body.remark ?? null,
      resume_name: body.resumeName ?? null,
      resume_data: body.resumeData ?? null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改学生
 *    PUT /api/job/student/update
 * ============================================================ */

const updateSchema = addSchema.extend({
  id: z.string().min(1, '必须传 id'),
});

studentRouter.put(
  '/update',
  checkPermission('consult:student:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    }

    if (body.studentNo !== exists.student_no) {
      const dup = await tbl(db, DB, TABLE, STAGE)
        .where({ student_no: body.studentNo, is_deleted: false })
        .whereNot('id', body.id)
        .first();
      if (dup) {
        throw new BizError(BizCode.STUDENT_NO_EXISTS, `学号 ${body.studentNo} 已被占用`);
      }
    }

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      student_no: body.studentNo,
      student_name: body.studentName,
      gender: body.gender,
      age: body.age ?? null,
      dept_code: body.deptCode,
      class_name: body.className ?? null,
      student_status: body.studentStatus ?? exists.student_status,
      phone: body.phone ?? null,
      parent_phone: body.parentPhone ?? null,
      education: body.education ?? null,
      enroll_date: body.enrollDate ?? null,
      remark: body.remark ?? null,
      resume_name: body.resumeName ?? null,
      resume_data: body.resumeData ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除学生（逻辑删除）
 *    DELETE /api/job/student/delete/:id
 * ============================================================ */

studentRouter.delete(
  '/delete/:id',
  checkPermission('consult:student:delete'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或已被删除');
    }

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6. 确认就业（待就业 → 已就业）★ 2026-10-02 新增
 *    POST /api/job/student/confirm-employment
 *
 * 【为什么要这个接口】
 *   斌哥反馈："假如说就业了，那这个状态怎么从待就业变为已就业，缺少相关按钮"。
 *   此前**全模块没有任何地方能写入「已就业」**（搜遍 routes 只有"读"），
 *   所以「数据统计」里的就业人数 / 就业率**永远是 0**。
 *
 * 【谁能调】
 *   本路由（`/api/job/student`）**没有挂 requirePage**（它同时被就业侧多个页面用），
 *   所以这里**自己做角色白名单**：就业老师 / 校长 / 学管主任。
 *   ⚠️ 班主任不在白名单 —— 学生转就业后档案已移交，他只能看
 *      （与 classInfo 里的 assertStudentEditable 口径一致）。
 *
 * 【顺带记一条就业日志】
 *   把「单位 / 岗位 / 薪资 / 入职日期」写进 t_employment_log，
 *   否则这些信息没地方存（就业日志页本来就该有这条记录）。
 *
 * 【口径】只能 待就业(9) → 已就业(10)。已是已就业的会被拒（防重复点）。
 *    "改回待就业"暂不做（要改只能走数据库）—— 如需，后续再加。
 * ============================================================ */

/** 可以确认就业的角色 */
const CONFIRM_EMPLOY_ROLES: string[] = [
  RoleCode.JOB_STAFF,
  RoleCode.RM_PRINCIPAL,
  // ★ 2026-10-06 移除 TEACH_DEAN（学管主任）：他是审批角色，
  //   「确认就业」是就业阶段的业务写操作，学管只看不办。
  // ★ 万能测试号（SUPER_TEST）：业务验证用
  SUPER_TEST_ROLE,
];

const EMPLOYMENT_LOG_TABLE = 't_employment_log';

studentRouter.post(
  '/confirm-employment',
  validate(
    z.object({
      studentId: z.string().min(1, '学生ID必传'),
      hireDate: z.string().min(1, '入职日期必填'),
      company: z.string().max(100).optional(),
      position: z.string().max(100).optional(),
      salary: z.coerce.number().min(0).max(1000000).optional(),
      remark: z.string().max(2000).optional(),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated;
    const roles = req.user?.roles || [];

    // ① 角色白名单
    if (!roles.some((r: string) => CONFIRM_EMPLOY_ROLES.includes(r))) {
      throw new BizError(
        BizCode.NO_OPERATION_PERMISSION,
        '只有就业老师 / 校长 / 学管主任可以确认就业',
      );
    }

    const stu = await tbl(db, DB, TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    // ② 状态校验：必须还在「待就业」
    if (stu.student_status !== StudentStatus.WAIT_EMPLOY) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `只有「待就业」的学生才能确认就业；该生当前是「${
          STUDENT_STATUS_NAME[stu.student_status] || '未知'
        }」`,
      );
    }

    const now = new Date();
    const operatorId = req.user?.userId || 'system';
    const operatorName = req.user?.userName || '';

    await db.transaction(async (trx) => {
      // ③ 待就业(9) → 已就业(10)
      await tblTrx(trx, DB, TABLE, STAGE).where({ id: stu.id }).update({
        student_status: StudentStatus.EMPLOYED,
        update_time: now,
        update_by: operatorId,
      });

      // ④ 记一条就业日志（入职信息）—— 免得单位/岗位/薪资没处存
      await tblInsTrx(trx, DB, EMPLOYMENT_LOG_TABLE, STAGE, {
        id: randomUUID(),
        create_time: now,
        create_by: operatorId,
        is_deleted: false,
        student_id: stu.id,
        student_no: stu.student_no,
        student_name: stu.student_name,
        class_name: stu.class_name,
        log_date: body.hireDate,
        resume_count: 0,
        interview_invite: 0,
        interview_count: 0,
        interview_time: null,
        company: body.company || null,
        position: body.position || null,
        salary: body.salary ?? null,
        interview_situation:
          body.remark || `已确认就业${operatorName ? `（操作人：${operatorName}）` : ''}`,
      });
    });

    res.json(ok(null, '已标记为「已就业」'));
  }),
);

export default studentRouter;
