/**
 * 就业日志路由（就业日志 / 信息档案 - 就业日志记录）
 *
 * 脑图字段：
 *   页面：姓名 / 有效简历投递 / 面试邀约 / 面试场次 / 面试时间 / 面试公司 / 面试情况
 *   操作：新建 / 编辑 / 详情 / 搜索·筛选
 *   信息档案视角还需要：岗位 / 薪资
 *
 * ⚠️ 学生姓名/学号/班级是【冗余存储】的。
 *    因为就业日志必须留痕：学生毕业被删了，历史求职记录也还在。
 *    前端列表因此不需要 join，一次查询就能出结果。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode } from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { fmtDate } from '../utils/date';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ P3 切读层：本文件两张表（t_employment_log / t_student_base）都已归一，
//   全部走 tbl()/tblIns() 路由；开关关时与原实现逐字节等价。
import { tbl, tblIns } from '../teaching/shared/uniTable';
// ★ 2026-10-16：姓名可手填 → 复用「按姓名尽量匹配学生」的共用逻辑
import { resolveStudentByName } from '../utils/studentResolve';
// ★ 2026-10-16：班级下拉选项（只读，就业老师也有权限）
import { listJobClassOptions } from './shared/jobClassOptions';

export const employmentLogRouter = Router();

const TABLE = 't_employment_log';
const STUDENT = 't_student_base';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/* ============================================================
 * 0. 班级下拉选项（只读）
 *    ⚠️ 不要改用 /api/job/class/options —— 就业老师没有「班级管理」页面权限，
 *       调用会 403（前端弹「您没有该操作的权限」）。详见 routes/shared/jobClassOptions.ts
 * ============================================================ */
employmentLogRouter.get('/classes', listJobClassOptions);

const SELECT_FIELDS = [
  'id', 'student_id', 'student_no', 'student_name', 'class_name',
  'log_date', 'resume_count', 'interview_invite', 'interview_count',
  'interview_time', 'company', 'position', 'salary', 'interview_situation', 'create_time',
];

/** 行 → 前端对象 */
function toVo(r: any) {
  return {
    id: r.id,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    className: r.class_name,
    logDate: fmtDate(r.log_date),
    resumeCount: r.resume_count,
    interviewInvite: r.interview_invite,
    interviewCount: r.interview_count,
    interviewTime: r.interview_time,
    company: r.company,
    position: r.position,
    salary: r.salary === null || r.salary === undefined ? undefined : Number(r.salary),
    interviewSituation: r.interview_situation,
    createTime: r.create_time,
  };
}

/* ============================================================
 * 1. 列表查询（含搜索/筛选）
 *    GET /api/job/employment-log/list?studentName=张&company=字节&startDate=&endDate=
 * ============================================================ */
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentId: z.string().optional(),
  studentName: z.string().optional(),
  // ★ 2026-10-16：班级筛选下拉
  classId: z.string().optional(),
  company: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

employmentLogRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    // ★ t_employment_log 挂在「学生」身上，没有 class_id 列
    //   → via='student'：换成一串「我班上的学生 id」再过滤
    // ★ 2026-10-16 补 ownCreatedBy：姓名可手填 → 匹配不到学生的日志 student_id 为 NULL，
    //   若只按 student_id 过滤，建单人（就业老师/项目经理）自己反而看不到。
    //   → 额外放行「我自己创建的」记录。
    await applyTrainingScope(query, req, { table: TABLE, dbName: DB, via: 'student', ownCreatedBy: true });

    if (q.studentId) query.andWhere('student_id', q.studentId);
    // ★ 2026-10-16：班级筛选 —— 日志表没有 class_id（只有 class_name 快照），
    //   所以经 student_id 反查「当前在该班的学生」。学生调过班也能按新班查到。
    if (q.classId) {
      query.whereIn(
        'student_id',
        db(STUDENT).select('id').where('class_id', q.classId).where('is_deleted', false),
      );
    }
    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.company) query.andWhere('company', 'like', `%${q.company}%`);
    if (q.startDate) query.andWhere('log_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('log_date', '<=', q.endDate);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select(SELECT_FIELDS)
      .orderBy('log_date', 'desc')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toVo), Number(total), q));
  }),
);

/* ============================================================
 * 2. 详情
 *    GET /api/job/employment-log/detail?id=xxx
 * ============================================================ */

employmentLogRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    // ★ 2026-10-16：详情也要过数据范围，否则拿到 id 就能绕过列表看别人的日志。
    //   不通过时统一抛「不存在」，避免暴露"这条记录存在但你没权限"。
    const guard: any = tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false });
    await applyTrainingScope(guard, req, { table: TABLE, dbName: DB, via: 'student', ownCreatedBy: true });
    if (!(await guard.first())) throw new BizError(BizCode.PARAM_ERROR, '就业日志不存在');

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '就业日志不存在');

    res.json(ok(toVo(row)));
  }),
);

/* ============================================================
 * 3. 新增
 *    POST /api/job/employment-log/add
 * ============================================================ */

/**
 * ★ 2026-10-16：姓名改为可直接手填（原先是「必须从学生下拉里选」）。
 *   studentId 变成可选；studentName 必填。
 *   后端会拿姓名去学生库精确匹配：唯一命中就自动关联（带出学号/班级），
 *   匹配不到、或重名不唯一 → 只存姓名，不关联学生（student_id = NULL）。
 */
const addSchema = z.object({
  studentId: z.string().optional(),
  studentName: z.string().min(1, '请输入姓名').max(50, '姓名最长 50 个字'),
  logDate: z.string().min(1, '请选择日志日期'),
  resumeCount: z.coerce.number().int().min(0).max(999).default(0),
  interviewInvite: z.coerce.number().int().min(0).max(999).default(0),
  interviewCount: z.coerce.number().int().min(0).max(999).default(0),
  interviewTime: z.string().max(32).optional(),
  company: z.string().max(100).optional(),
  position: z.string().max(100).optional(),
  salary: z.coerce.number().min(0).max(1000000).optional(),
  interviewSituation: z.string().max(2000).optional(),
});

employmentLogRouter.post(
  '/add',
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    // ★ 姓名可直接手填：能唯一匹配到学生就自动关联（带出学号/班级），否则只记姓名
    const student = await resolveStudentByName(body.studentId, body.studentName);

    const id = randomUUID();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      student_id: student ? student.id : null,
      student_no: student ? student.student_no : null,
      student_name: body.studentName,
      class_name: student ? student.class_name : null,
      log_date: body.logDate,
      resume_count: body.resumeCount,
      interview_invite: body.interviewInvite,
      interview_count: body.interviewCount,
      interview_time: body.interviewTime ?? null,
      company: body.company ?? null,
      position: body.position ?? null,
      salary: body.salary ?? null,
      interview_situation: body.interviewSituation ?? null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改
 *    PUT /api/job/employment-log/update
 * ============================================================ */

const updateSchema = addSchema.extend({ id: z.string().min(1, '必须传 id') });

employmentLogRouter.put(
  '/update',
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '就业日志不存在或已被删除');

    // ★ 同新增：姓名可直接手填，能唯一匹配到学生就重新关联
    const student = await resolveStudentByName(body.studentId, body.studentName);

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      student_id: student ? student.id : null,
      student_no: student ? student.student_no : null,
      student_name: body.studentName,
      class_name: student ? student.class_name : null,
      log_date: body.logDate,
      resume_count: body.resumeCount,
      interview_invite: body.interviewInvite,
      interview_count: body.interviewCount,
      interview_time: body.interviewTime ?? null,
      company: body.company ?? null,
      position: body.position ?? null,
      salary: body.salary ?? null,
      interview_situation: body.interviewSituation ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除（逻辑删除）
 *    DELETE /api/job/employment-log/delete/:id
 * ============================================================ */

employmentLogRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '就业日志不存在或已被删除');

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

export default employmentLogRouter;
