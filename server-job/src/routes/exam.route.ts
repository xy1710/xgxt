/**
 * 考试管理路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/exam
 * 表：t_job_exam（考试）、t_job_exam_score（成绩）
 * 字段依据：docs/考试成绩-字段定稿.md
 *
 * ⚠️ 核心逻辑：
 *    新建考试时，系统会【自动把所选班级的全体学生】写进成绩表，
 *    老师只需要进去填分数 —— 这就是「自动带出全班学生」（决定 13）。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  EXAM_TYPE_NAME,
  EXAM_CONTENT_TYPE_NAME,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P3 切读层：本文件三张表（t_job_exam / t_job_exam_score / t_student_base）都已归一，
//   全部走 tbl()/tblTrx()/tblInsTrx() 路由；开关关时与原实现逐字节等价。
import { tbl, tblInsTrx, tblTrx } from '../teaching/shared/uniTable';
import { assertExamNotDuplicated } from '../teaching/exam/uniExamUnique';

export const examRouter = Router();

/** 表名常量 */
const TABLE = 't_job_exam';
const SCORE_TABLE = 't_job_exam_score';
const STUDENT_TABLE = 't_student_base';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 本期固定的考试内容：笔试(1) + 机试(2) + 面试(3) */
const DEFAULT_CONTENT_TYPES = [1, 2, 3];

/**
 * 把 [1,2,3] 转成 "笔试、机试、面试"
 * 用于列表页双返回（铁律 3）
 */
function contentTypesToName(csv: string | null | undefined): string {
  if (!csv) return '';
  return String(csv)
    .split(',')
    .map((s) => EXAM_CONTENT_TYPE_NAME[Number(s.trim())] || '')
    .filter(Boolean)
    .join('、');
}

/* ============================================================
 * 1. 查询考试列表
 *    GET /api/job/exam/page?page=1&size=20&examName=月考
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  examName: z.string().optional(),
  examType: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

examRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);

    if (q.examName) query.andWhere('exam_name', 'like', `%${q.examName}%`);
    if (q.examType) query.andWhere('exam_type', q.examType);
    if (q.startDate) query.andWhere('exam_time', '>=', `${q.startDate} 00:00:00`);
    if (q.endDate) query.andWhere('exam_time', '<=', `${q.endDate} 23:59:59`);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('exam_name', 'like', `%${q.keyword}%`)
          .orWhere('class_names', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('exam_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // ---- 补充「已录入 / 总人数」，便于领导一眼看到进度 ----
    const ids = rows.map((r: any) => r.id);
    const statMap: Record<string, { totalCount: number; scoredCount: number }> = {};

    if (ids.length > 0) {
      const stats = await tbl(db, DB, SCORE_TABLE, STAGE)
        .whereIn('exam_id', ids)
        .andWhere('is_deleted', false)
        .groupBy('exam_id')
        .select('exam_id')
        .count({ total_count: '*' })
        .sum({ scored_count: db.raw('CASE WHEN total_score IS NOT NULL THEN 1 ELSE 0 END') });

      stats.forEach((s: any) => {
        statMap[s.exam_id] = {
          totalCount: Number(s.total_count) || 0,
          scoredCount: Number(s.scored_count) || 0,
        };
      });
    }

    const list = rows.map((r: any) => ({
      examId: r.id,
      examName: r.exam_name,
      examType: r.exam_type,
      examTypeName: EXAM_TYPE_NAME[r.exam_type] || '',
      examTime: r.exam_time,
      classIds: r.class_ids,
      classNames: r.class_names,
      contentTypes: r.content_types,
      contentTypesName: contentTypesToName(r.content_types),
      creatorName: r.creator_name,
      totalCount: statMap[r.id]?.totalCount ?? 0,
      scoredCount: statMap[r.id]?.scoredCount ?? 0,
      remark: r.remark,
      createTime: r.create_time,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 查询考试详情
 *    GET /api/job/exam/detail?id=xxx
 * ============================================================ */

examRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在或已被删除');
    }

    res.json(ok({
      id: row.id,
      examName: row.exam_name,
      examType: row.exam_type,
      examTypeName: EXAM_TYPE_NAME[row.exam_type] || '',
      examTime: row.exam_time,
      classIds: row.class_ids,
      classNames: row.class_names,
      contentTypes: row.content_types,
      contentTypesName: contentTypesToName(row.content_types),
      creatorId: row.creator_id,
      creatorName: row.creator_name,
      remark: row.remark,
      createTime: row.create_time,
      isDeleted: row.is_deleted,
    }));
  }),
);

/* ============================================================
 * 3. 新建考试（★ 核心：自动带出全班学生到成绩表）
 *    POST /api/job/exam/add
 * ============================================================ */

const addSchema = z.object({
  examName: z.string().min(1, '考试名称必填').max(100),
  examType: z.coerce.number().int().min(1).max(5, '考试类型取值 1-5'),
  examTime: z.string().min(1, '考试时间必填'),
  classIds: z.array(z.string().min(1)).min(1, '至少选择一个考试班级'),
  classNames: z.array(z.string()).optional(),
  contentTypes: z.array(z.coerce.number().int()).optional(),
  remark: z.string().max(500).optional(),
});

examRouter.post(
  '/add',
  checkPermission('job:exam:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    const examId = randomUUID();
    const contentTypes = (body.contentTypes?.length ? body.contentTypes : DEFAULT_CONTENT_TYPES)
      .join(',');
    const classIdsCsv = body.classIds.join(',');
    const classNamesCsv = (body.classNames?.length ? body.classNames : body.classIds).join(',');
    const now = new Date();
    const operatorId = req.user?.userId || 'system';
    const operatorName = req.user?.userName || '系统';

    /**
     * ★ 同班 + 同日 + 同名 查重（任务 #20）
     *
     * 统一表 `t_uni_exam` 的 `uk_exam` 唯一索引**已废弃**（迁移 20261016_007，
     * 它不含 class_id、且老表本就没有唯一键）→ 改由应用层在此拦，
     * 两种开关模式走同一段逻辑。实训是多班，按「班级有交集」判定。
     */
    await assertExamNotDuplicated(db, STAGE, {
      classIds: body.classIds,
      examName: body.examName,
      examDate: body.examTime,
    });

    // ---- ① 查所选班级的所有在校学生 ----
    const students = await tbl(db, DB, STUDENT_TABLE, STAGE)
      .whereIn('class_id', body.classIds)
      .andWhere('is_deleted', false)
      .select('id', 'student_no', 'student_name', 'class_id', 'class_name');

    // ---- ② 事务：写考试 + 批量写成绩 ----
    await db.transaction(async (trx) => {
      await tblInsTrx(trx, DB, TABLE, STAGE, {
        id: examId,
        exam_name: body.examName,
        exam_type: body.examType,
        exam_time: body.examTime,
        class_ids: classIdsCsv,
        class_names: classNamesCsv,
        content_types: contentTypes,
        creator_id: operatorId,
        creator_name: operatorName,
        remark: body.remark ?? null,
        is_deleted: false,
        create_time: now,
        create_by: operatorId,
      });

      if (students.length > 0) {
        const scoreRows = students.map((s: any) => ({
          id: randomUUID(),
          exam_id: examId,
          exam_name: body.examName,
          student_id: s.id,
          student_no: s.student_no,
          student_name: s.student_name,
          class_id: s.class_id ?? null,
          class_name: s.class_name ?? null,
          paper_score: null,
          machine_score: null,
          written_avg: null,
          interview_score: null,
          total_score: null,
          exam_result: null,
          remark: null,
          entry_by: null,
          entry_by_name: null,
          entry_time: null,
          is_deleted: false,
          create_time: now,
          create_by: operatorId,
        }));

        // 分批插入，防止单条 SQL 过长（1000 条一批足够）
        const BATCH = 500;
        for (let i = 0; i < scoreRows.length; i += BATCH) {
          await tblInsTrx(trx, DB, SCORE_TABLE, STAGE, scoreRows.slice(i, i + BATCH));
        }
      }
    });

    res.json(ok(
      { id: examId, studentCount: students.length },
      `新建成功，已自动带入 ${students.length} 名学生`,
    ));
  }),
);

/* ============================================================
 * 4. 编辑考试
 *    PUT /api/job/exam/update
 * ============================================================ */

const updateSchema = addSchema.extend({
  id: z.string().min(1, '必须传 id'),
});

examRouter.put(
  '/update',
  checkPermission('job:exam:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在');
    }

    /** ★ 改名后也查重（排除自己），规则同 /add（任务 #20） */
    await assertExamNotDuplicated(db, STAGE, {
      classIds: body.classIds,
      examName: body.examName,
      examDate: body.examTime,
      excludeId: body.id,
    });

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      exam_name: body.examName,
      exam_type: body.examType,
      exam_time: body.examTime,
      class_ids: body.classIds.join(','),
      class_names: (body.classNames?.length ? body.classNames : body.classIds).join(','),
      content_types: (body.contentTypes?.length ? body.contentTypes : DEFAULT_CONTENT_TYPES).join(','),
      remark: body.remark ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除考试（逻辑删除 + 级联逻辑删成绩）
 *    DELETE /api/job/exam/delete/:id
 * ============================================================ */

examRouter.delete(
  '/delete/:id',
  checkPermission('job:exam:delete'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在或已被删除');
    }

    const operatorId = req.user?.userId || 'system';
    const now = new Date();

    // ⚠️ 逻辑删除，绝不用 .del()。同时级联删成绩，避免留下孤儿数据
    await db.transaction(async (trx) => {
      await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update({
        is_deleted: true,
        update_time: now,
        update_by: operatorId,
      });
      await tblTrx(trx, DB, SCORE_TABLE, STAGE).where({ exam_id: id }).update({
        is_deleted: true,
        update_time: now,
        update_by: operatorId,
      });
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6. 成绩汇总（只读统计，按班级分组）
 *    GET /api/job/exam/summary?id=xxx
 * ============================================================ */

examRouter.get(
  '/summary',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const exam = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!exam) {
      throw new BizError(BizCode.EXAM_NOT_FOUND, '考试不存在或已被删除');
    }

    // 按班级分组统计
    const rows = await tbl(db, DB, SCORE_TABLE, STAGE)
      .where({ exam_id: id, is_deleted: false })
      .groupBy('class_id', 'class_name')
      .select('class_id', 'class_name')
      .count({ student_count: '*' })
      .select(
        db.raw('SUM(CASE WHEN total_score IS NOT NULL THEN 1 ELSE 0 END) AS scored_count'),
        db.raw('AVG(total_score) AS avg_score'),
        db.raw('MAX(total_score) AS max_score'),
        db.raw('MIN(total_score) AS min_score'),
        db.raw('SUM(CASE WHEN exam_result = 2 THEN 1 ELSE 0 END) AS repeat_count'),
      );

    /** 统一把统计数字规整成数字/2位小数/null */
    const toNum = (v: any): number | null => {
      if (v === null || v === undefined || v === '') return null;
      return Math.round(Number(v) * 100) / 100;
    };

    const list = rows.map((r: any) => ({
      classId: r.class_id ?? undefined,
      className: r.class_name || '未分班',
      studentCount: Number(r.student_count) || 0,
      scoredCount: Number(r.scored_count) || 0,
      avgScore: toNum(r.avg_score),
      maxScore: toNum(r.max_score),
      minScore: toNum(r.min_score),
      repeatCount: Number(r.repeat_count) || 0,
    }));

    // 合计行
    const total = list.reduce(
      (acc: any, r: any) => ({
        classId: undefined,
        className: '全部班合计',
        studentCount: acc.studentCount + r.studentCount,
        scoredCount: acc.scoredCount + r.scoredCount,
        avgScore: null,
        maxScore: Math.max(acc.maxScore ?? -1, r.maxScore ?? -1) === -1
          ? null
          : Math.max(acc.maxScore ?? -1, r.maxScore ?? -1),
        minScore: Math.min(acc.minScore ?? 999, r.minScore ?? 999) === 999
          ? null
          : Math.min(acc.minScore ?? 999, r.minScore ?? 999),
        repeatCount: acc.repeatCount + r.repeatCount,
      }),
      {
        classId: undefined as string | undefined,
        className: '全部班合计',
        studentCount: 0,
        scoredCount: 0,
        avgScore: null as number | null,
        maxScore: null as number | null,
        minScore: null as number | null,
        repeatCount: 0,
      },
    );

    // 合计行的平均分单独算（用全部有分数的记录）
    const allAvg = await tbl(db, DB, SCORE_TABLE, STAGE)
      .where({ exam_id: id, is_deleted: false })
      .whereNotNull('total_score')
      .avg({ avg: 'total_score' })
      .first();
    total.avgScore = toNum(allAvg?.avg);

    res.json(ok({
      examId: exam.id,
      examName: exam.exam_name,
      examTime: exam.exam_time,
      classNames: exam.class_names,
      total,
      rows: list,
    }));
  }),
);

export default examRouter;
