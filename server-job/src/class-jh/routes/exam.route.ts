/**
 * 考试管理路由（教学管理初高）
 *
 * 覆盖：考试 CRUD + submit（草稿→已提交）+ 成绩 list/save（自动判定 examResult）+ approve（结业）。
 * 表：t_class_exam、t_class_exam_score、t_class_exam_field。
 * 挂载：examRouter → /api/class/exam；examScoreRouter → /api/class/examScore。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  EXAM_TYPE_NAME,
  EXAM_STATUS_NAME,
  EXAM_RESULT_NAME,
  EXAM_CONTENT_TYPE_NAME,
} from 'shared-types/class-jh';
import { ExamStatus, ExamResult } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf, namesOf } from '../utils/enumName';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P4 切读层：本文件四张表（t_class_exam / t_class_exam_score / t_class_exam_field /
//   t_class_info）以及内联的 t_class_student 均已归一，
//   全部走 tbl()/tblIns() 路由；开关关时与原实现逐字节等价。
import { tbl, tblIns } from '../../teaching/shared/uniTable';

export const examRouter = Router();
export const examScoreRouter = Router();

const EXAM_TABLE = 't_class_exam';
const SCORE_TABLE = 't_class_exam_score';
const FIELD_TABLE = 't_class_exam_field';
const CLASS_TABLE = 't_class_info';
const STUDENT_TABLE = 't_class_student';

/** ★ 统一表 edu_stage 取值（本路由只服务初高） */
const STAGE = 'jh' as const;
const DB = 'sms_class_jh';

/** 及格线比例（自动判定 examResult 用） */
const PASS_RATIO = 0.6;

/** 考试行 → 实体（双返回） */
function toExam(r: any) {
  const contentTypes = parseJsonArray(r.exam_content_types);
  return {
    examId: r.id,
    examName: r.exam_name,
    examType: r.exam_type,
    examTypeName: nameOf(EXAM_TYPE_NAME, r.exam_type),
    examDate: r.exam_date,
    classId: r.class_id,
    className: r.class_name,
    examContentTypes: contentTypes,
    examContentTypeNames: namesOf(EXAM_CONTENT_TYPE_NAME, contentTypes),
    contentFullScore: parseJsonObject(r.content_full_score),
    examStatus: r.exam_status,
    examStatusName: nameOf(EXAM_STATUS_NAME, r.exam_status),
    scoreTeacherIds: parseJsonArray(r.score_teacher_ids),
    judgeIds: parseJsonArray(r.judge_ids),
    createByName: r.create_by_name,
    remark: r.remark,
    createTime: r.create_time,
  };
}

/** 成绩行 → 实体（双返回） */
function toScore(s: any) {
  return {
    scoreId: s.id,
    examId: s.exam_id,
    examType: s.exam_type,
    examDate: s.exam_date,
    classId: s.class_id,
    studentId: s.student_id,
    studentNo: s.student_no,
    studentName: s.student_name,
    scoreWritten: numOrNull(s.score_written),
    scoreMachine: numOrNull(s.score_machine),
    scoreInterview: numOrNull(s.score_interview),
    scoreOther: numOrNull(s.score_other),
    scoreTotal: numOrNull(s.score_total),
    scoreTeacherId: s.score_teacher_id,
    scoreTeacherName: s.score_teacher_name,
    examResult: s.exam_result,
    examResultName: nameOf(EXAM_RESULT_NAME, s.exam_result),
    isPassed: s.is_passed,
    customValues: parseJsonObject(s.custom_values),
    remark: s.remark,
  };
}

function numOrNull(v: any): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function parseJsonArray(v: any): any[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
function parseJsonObject(v: any): any {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/* ============================================================
 * 1. 考试列表
 *   GET /api/class/exam/list
 * ============================================================ */

const examListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  examType: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  headTeacherId: z.string().optional(),
  teacherId: z.string().optional(),
  examStatus: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

examRouter.get(
  '/list',
  checkPermission('class:exam:view'),
  validate(examListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof examListSchema>;
    const query = tbl(db, DB, EXAM_TABLE, STAGE).where('is_deleted', false);
    if (q.examType) query.andWhere('exam_type', q.examType);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.startDate) query.andWhere('exam_date', '>=', q.startDate);
    if (q.endDate) query.andWhere('exam_date', '<=', q.endDate);
    if (q.examStatus) query.andWhere('exam_status', q.examStatus);
    if (q.keyword) query.andWhere('exam_name', 'like', `%${q.keyword}%`);
    // 班主任/教员筛选：按班级归属反查
    if (q.headTeacherId || q.teacherId) {
      const cq = tbl(db, DB, CLASS_TABLE, STAGE).where('is_deleted', false);
      if (q.headTeacherId) cq.andWhere('head_teacher_id', q.headTeacherId);
      if (q.teacherId) cq.andWhere('teacher_id', q.teacherId);
      const classRows = await cq.select('id');
      const ids = classRows.map((r: any) => r.id);
      if (!ids.length) {
        res.json(page([], 0, q));
        return;
      }
      query.whereIn('class_id', ids);
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('exam_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toExam), Number(total), q));
  }),
);

/* ============================================================
 * 2. 考试详情（含自定义字段 + 成绩汇总）
 *   GET /api/class/exam/detail?id=xxx
 * ============================================================ */

examRouter.get(
  '/detail',
  checkPermission('class:exam:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const exam = await tbl(db, DB, EXAM_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exam) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');

    const fields = await tbl(db, DB, FIELD_TABLE, STAGE).where({ exam_id: id, is_deleted: false }).orderBy('sort_no', 'asc');
    const scores = await tbl(db, DB, SCORE_TABLE, STAGE).where({ exam_id: id, is_deleted: false }).select('*');

    const totalCount = scores.length;
    const passCount = scores.filter((s: any) => s.exam_result === ExamResult.PASS).length;
    const failCount = scores.filter((s: any) => s.exam_result === ExamResult.FAIL).length;
    const sum = scores.reduce((acc: number, s: any) => acc + (Number(s.score_total) || 0), 0);
    const avgScore = totalCount ? Number((sum / totalCount).toFixed(2)) : 0;

    res.json(
      ok({
        ...toExam(exam),
        fields: fields.map((f: any) => ({
          fieldId: f.id,
          examId: f.exam_id,
          fieldName: f.field_name,
          fieldType: f.field_type,
          sortNo: f.sort_no,
        })),
        scoreSummary: { totalCount, passCount, failCount, avgScore },
      }),
    );
  }),
);

/* ============================================================
 * 3. 新增考试（含自定义字段）
 *   POST /api/class/exam/add
 * ============================================================ */

const examSaveSchema = z.object({
  examName: z.string().min(1, '考试名称必填'),
  examType: z.coerce.number().int().min(1).max(5, '考试类型不正确'),
  examDate: z.string().min(1, '考试日期必填'),
  classId: z.string().min(1, '考试班级必填'),
  examContentTypes: z.array(z.coerce.number().int().min(1).max(4)).min(1, '至少一个内容项'),
  contentFullScore: z.record(z.coerce.number()).optional(),
  customFields: z
    .array(z.object({ fieldName: z.string().min(1), fieldType: z.coerce.number().int().min(1).max(2).default(1), sortNo: z.coerce.number().int().optional() }))
    .optional(),
  scoreTeacherIds: z.array(z.string()).optional(),
  judgeIds: z.array(z.string()).optional(),
  remark: z.string().max(500).optional(),
});

examRouter.post(
  '/add',
  checkPermission('class:exam:add'),
  validate(examSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof examSaveSchema>;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '考试班级不存在');

    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, EXAM_TABLE, STAGE, {
      id,
      exam_name: body.examName,
      exam_type: body.examType,
      exam_date: body.examDate,
      class_id: cls.id,
      class_name: cls.class_name,
      exam_content_types: JSON.stringify(body.examContentTypes),
      content_full_score: body.contentFullScore ? JSON.stringify(body.contentFullScore) : null,
      exam_status: ExamStatus.DRAFT,
      score_teacher_ids: body.scoreTeacherIds ? JSON.stringify(body.scoreTeacherIds) : null,
      judge_ids: body.judgeIds ? JSON.stringify(body.judgeIds) : null,
      create_by_name: req.user?.userName ?? null,
      remark: body.remark ?? null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await saveFields(id, body.customFields, now, req.user?.userId);

    res.json(ok({ id }, '新增成功'));
  }),
);

/** 写入考试自定义字段（先逻辑删旧、再插新） */
async function saveFields(
  examId: string,
  fields: Array<{ fieldName: string; fieldType: number; sortNo?: number }> | undefined,
  now: Date,
  userId?: string,
): Promise<void> {
  await tbl(db, DB, FIELD_TABLE, STAGE).where({ exam_id: examId, is_deleted: false }).update({ is_deleted: true, update_time: now });
  if (!fields || !fields.length) return;
  let i = 0;
  for (const f of fields) {
    await tblIns(db, DB, FIELD_TABLE, STAGE, {
      id: randomUUID(),
      exam_id: examId,
      field_name: f.fieldName,
      field_type: f.fieldType,
      sort_no: f.sortNo ?? i,
      is_deleted: false,
      create_time: now,
      create_by: userId || 'system',
    });
    i += 1;
  }
}

/* ============================================================
 * 4. 修改考试
 *   PUT /api/class/exam/update
 * ============================================================ */

examRouter.put(
  '/update',
  checkPermission('class:exam:edit'),
  validate(examSaveSchema.extend({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof examSaveSchema> & { id: string };

    const exam = await tbl(db, DB, EXAM_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!exam) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');
    if (exam.exam_status === ExamStatus.SUBMITTED) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '考试已提交，不可修改');
    }

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '考试班级不存在');

    const now = new Date();
    await tbl(db, DB, EXAM_TABLE, STAGE).where({ id: body.id }).update({
      exam_name: body.examName,
      exam_type: body.examType,
      exam_date: body.examDate,
      class_id: cls.id,
      class_name: cls.class_name,
      exam_content_types: JSON.stringify(body.examContentTypes),
      content_full_score: body.contentFullScore ? JSON.stringify(body.contentFullScore) : null,
      score_teacher_ids: body.scoreTeacherIds ? JSON.stringify(body.scoreTeacherIds) : null,
      judge_ids: body.judgeIds ? JSON.stringify(body.judgeIds) : null,
      remark: body.remark ?? null,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await saveFields(body.id, body.customFields, now, req.user?.userId);

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 提交考试（草稿→已提交）
 *   POST /api/class/exam/submit
 * ============================================================ */

examRouter.post(
  '/submit',
  checkPermission('class:exam:edit'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const exam = await tbl(db, DB, EXAM_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exam) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');
    if (exam.exam_status !== ExamStatus.DRAFT) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅草稿状态可提交');
    }

    await tbl(db, DB, EXAM_TABLE, STAGE).where({ id }).update({
      exam_status: ExamStatus.SUBMITTED,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '提交成功'));
  }),
);

/* ============================================================
 * 6. 成绩列表
 *   GET /api/class/examScore/list
 * ============================================================ */

const scoreListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  examId: z.string().optional(),
  classId: z.string().optional(),
  keyword: z.string().optional(),
});

examScoreRouter.get(
  '/list',
  checkPermission('class:examScore:view'),
  validate(scoreListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof scoreListSchema>;
    const query = tbl(db, DB, SCORE_TABLE, STAGE).where('is_deleted', false);
    if (q.examId) query.andWhere('exam_id', q.examId);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(toScore), Number(total), q));
  }),
);

/* ============================================================
 * 7. 成绩录入（按内容项满分自动判定 examResult）
 *   POST /api/class/examScore/save
 * ============================================================ */

const scoreSaveSchema = z.object({
  examId: z.string().min(1, '考试必填'),
  classId: z.string().min(1, '班级必填'),
  scores: z
    .array(
      z.object({
        studentId: z.string().min(1, '学生必填'),
        scoreWritten: z.coerce.number().optional(),
        scoreMachine: z.coerce.number().optional(),
        scoreInterview: z.coerce.number().optional(),
        scoreOther: z.coerce.number().optional(),
        scoreTeacherId: z.string().optional(),
        customValues: z.record(z.any()).optional(),
        remark: z.string().max(500).optional(),
      }),
    )
    .min(1, '至少一条成绩'),
});

examScoreRouter.post(
  '/save',
  checkPermission('class:examScore:add'),
  validate(scoreSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof scoreSaveSchema>;

    const exam = await tbl(db, DB, EXAM_TABLE, STAGE).where({ id: body.examId, is_deleted: false }).first();
    if (!exam) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');

    // 满分合计（用于自动判定）
    const fullScoreMap = parseJsonObject(exam.content_full_score) || {};
    const fullTotal = Object.values(fullScoreMap).reduce((a: number, b: any) => a + (Number(b) || 0), 0);

    const now = new Date();
    let saved = 0;

    for (const item of body.scores) {
      const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: item.studentId, is_deleted: false }).first();
      if (!stu) continue;

      const parts = [item.scoreWritten, item.scoreMachine, item.scoreInterview, item.scoreOther];
      const provided = parts.filter((p) => p !== undefined && p !== null) as number[];
      const scoreTotal = provided.length ? Number(provided.reduce((a, b) => a + Number(b), 0).toFixed(2)) : null;

      // 自动判定：总分 >= 满分 * 及格线 → 通过
      let examResult: number | null = null;
      if (scoreTotal !== null && fullTotal > 0) {
        examResult = scoreTotal >= fullTotal * PASS_RATIO ? ExamResult.PASS : ExamResult.FAIL;
      }

      // upsert：按 exam_id + student_id (+ score_teacher_id)
      const whereKey: any = { exam_id: body.examId, student_id: item.studentId, is_deleted: false };
      if (item.scoreTeacherId) whereKey.score_teacher_id = item.scoreTeacherId;
      const existed = await tbl(db, DB, SCORE_TABLE, STAGE).where(whereKey).first();

      const payload = {
        exam_id: body.examId,
        exam_type: exam.exam_type,
        exam_date: exam.exam_date,
        class_id: body.classId,
        student_id: item.studentId,
        student_no: stu.student_no,
        student_name: stu.student_name,
        score_written: item.scoreWritten ?? null,
        score_machine: item.scoreMachine ?? null,
        score_interview: item.scoreInterview ?? null,
        score_other: item.scoreOther ?? null,
        score_total: scoreTotal,
        score_teacher_id: item.scoreTeacherId ?? null,
        score_teacher_name: req.user?.userName ?? null,
        exam_result: examResult,
        custom_values: item.customValues ? JSON.stringify(item.customValues) : null,
        remark: item.remark ?? null,
      };

      if (existed) {
        await tbl(db, DB, SCORE_TABLE, STAGE).where({ id: existed.id }).update({ ...payload, update_time: now, update_by: req.user?.userId || 'system' });
      } else {
        await tblIns(db, DB, SCORE_TABLE, STAGE, { id: randomUUID(), ...payload, is_deleted: false, create_time: now, create_by: req.user?.userId || 'system' });
      }
      saved += 1;
    }

    res.json(ok({ saved }, `已保存 ${saved} 条成绩`));
  }),
);

/* ============================================================
 * 8. 结业成绩审批（经理决定 isPassed）
 *   POST /api/class/examScore/approve
 * ============================================================ */

const approveSchema = z.object({
  examId: z.string().min(1, '考试必填'),
  studentId: z.string().optional(),
  isPassed: z.coerce.boolean(),
});

examScoreRouter.post(
  '/approve',
  checkPermission('class:examScore:approve'),
  validate(approveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof approveSchema>;

    const exam = await tbl(db, DB, EXAM_TABLE, STAGE).where({ id: body.examId, is_deleted: false }).first();
    if (!exam) throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');

    const q = tbl(db, DB, SCORE_TABLE, STAGE).where({ exam_id: body.examId, is_deleted: false });
    if (body.studentId) q.andWhere('student_id', body.studentId);
    const rows = await q.select('id', 'student_id');
    if (!rows.length) throw new BizError(BizCode.EXAM_NOT_FOUND, '未找到对应成绩记录');

    await q.update({
      is_passed: body.isPassed,
      exam_result: body.isPassed ? ExamResult.PASS : ExamResult.FAIL,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'exam',
      bizType: '结业审批',
      bizId: body.examId,
      classId: exam.class_id,
      studentId: body.studentId,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `结业考试「${exam.exam_name}」审批：${body.isPassed ? '通过' : '未通过'}`,
      afterValue: { isPassed: body.isPassed },
    });

    res.json(ok(null, '审批成功'));
  }),
);

export default examRouter;
