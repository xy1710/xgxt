/**
 * 数据统计路由（数据统计）
 *
 * 脑图五个指标：就业人数 / 获得offer / 就业率 / 平均投简历数 / kpi
 *
 * ⚠️ 口径说明（写在接口注释里，避免各模块算得不一样）：
 *    - 就业人数：学生状态 = 已就业(10) 的人数
 *    - 参与就业管理人数：待就业(9) + 已就业(10)，就业率的分母就是这个
 *    - 获得 offer 数：复盘记录中「面试结论 = 已发 offer」的条数
 *    - 平均投简历数：累计有效投递 ÷ 有投递记录的学生数（不是÷全体学生，否则会被没动过的学生拉低）
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  DEPT_NAME,
  STUDENT_STATUS_NAME,
  StudentStatus,
  InterviewConclusion,
  ReviewConclusion,
} from 'shared-types';
import { ok } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
// ★ P3 切读层：本文件 4 张表（t_student_base / t_employment_log / t_review / t_kpi_target）
//   均已在 UNI_MAP 登记，全部走 tbl()/tblIns() 路由；开关关时与原实现等价。
//   ⚠️ db.raw(...) 里只有 CASE WHEN 表达式、不含表名，按规则保持不动。
import { tbl, tblIns } from '../teaching/shared/uniTable';

export const statisticsRouter = Router();

const STUDENT = 't_student_base';
const LOG = 't_employment_log';
const REVIEW = 't_review';
const KPI = 't_kpi_target';

/** ★ 统一表 edu_stage 取值（本路由只服务实训 → sms_job） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 就业模块管辖的状态 */
const JOB_SCOPE = [StudentStatus.WAIT_EMPLOY, StudentStatus.EMPLOYED, StudentStatus.SUSPENDED, StudentStatus.QUIT];

/** 四舍五入到两位小数，避免出现 66.66666666666667 这种 */
function round(v: number, digits = 2): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** 取 KPI 目标（没有就按默认值建一条） */
async function getOrCreateTarget() {
  let row = await tbl(db, DB, KPI, STAGE).where('is_deleted', false).first();
  if (!row) {
    const id = randomUUID();
    await tblIns(db, DB, KPI, STAGE, {
      id,
      target_rate: 85,
      target_offer: 60,
      target_resume: 20,
      is_deleted: false,
      create_time: new Date(),
    });
    row = await tbl(db, DB, KPI, STAGE).where({ id }).first();
  }
  return row;
}

/* ============================================================
 * 1. 核心指标总览
 *    GET /api/job/statistics/overview
 * ============================================================ */

statisticsRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    // ---- 就业人数 / 待就业人数 ----
    const [{ employedCount }] = (await tbl(db, DB, STUDENT, STAGE)
      .where({ is_deleted: false, student_status: StudentStatus.EMPLOYED })
      .count({ employedCount: '*' })) as Array<Record<string, any>>;

    const [{ waitingCount }] = (await tbl(db, DB, STUDENT, STAGE)
      .where({ is_deleted: false, student_status: StudentStatus.WAIT_EMPLOY })
      .count({ waitingCount: '*' })) as Array<Record<string, any>>;

    // ---- 获得 offer ----
    const [{ offerCount }] = (await tbl(db, DB, REVIEW, STAGE)
      .where({ is_deleted: false, interview_conclusion: InterviewConclusion.OFFER })
      .count({ offerCount: '*' })) as Array<Record<string, any>>;

    const offerRows = await tbl(db, DB, REVIEW, STAGE)
      .where({ is_deleted: false, interview_conclusion: InterviewConclusion.OFFER })
      .distinct('student_id')
      .select('student_id');

    // ---- 投递 / 面试累计 ----
    const [{ totalResumeCount }] = (await tbl(db, DB, LOG, STAGE)
      .where('is_deleted', false)
      .sum({ totalResumeCount: 'resume_count' })) as Array<Record<string, any>>;
    const [{ totalInterviewCount }] = (await tbl(db, DB, LOG, STAGE)
      .where('is_deleted', false)
      .sum({ totalInterviewCount: 'interview_count' })) as Array<Record<string, any>>;

    // 有投递记录的学生数（人均投递的分母）
    const [{ resumeStudentCount }] = (await tbl(db, DB, LOG, STAGE)
      .where('is_deleted', false)
      .where('resume_count', '>', 0)
      .countDistinct({ resumeStudentCount: 'student_id' })) as Array<Record<string, any>>;

    const employed = Number(employedCount);
    const waiting = Number(waitingCount);
    const jobManagedCount = employed + waiting;
    const totalResume = Number(totalResumeCount || 0);
    const resumeStudents = Number(resumeStudentCount || 0);
    const offer = Number(offerCount || 0);

    const employedRate = jobManagedCount > 0 ? round((employed / jobManagedCount) * 100) : 0;
    const avgResume = resumeStudents > 0 ? round(totalResume / resumeStudents) : 0;

    // ---- KPI 达成率 ----
    const target = await getOrCreateTarget();
    const tRate = Number(target.target_rate);
    const tOffer = Number(target.target_offer);
    const tResume = Number(target.target_resume);

    const rateCompletion = tRate > 0 ? round((employedRate / tRate) * 100) : 0;
    const offerCompletion = tOffer > 0 ? round((offer / tOffer) * 100) : 0;
    const resumeCompletion = tResume > 0 ? round((avgResume / tResume) * 100) : 0;

    res.json(ok({
      employedCount: employed,
      waitingCount: waiting,
      jobManagedCount,
      offerCount: offer,
      offerStudentCount: offerRows.length,
      employmentRate: employedRate,
      avgResumeCount: avgResume,
      totalResumeCount: totalResume,
      totalInterviewCount: Number(totalInterviewCount || 0),
      kpi: {
        target: {
          id: target.id,
          targetRate: tRate,
          targetOffer: tOffer,
          targetResume: tResume,
          updateTime: target.update_time,
        },
        actualRate: employedRate,
        actualOffer: offer,
        actualResume: avgResume,
        rateCompletion,
        offerCompletion,
        resumeCompletion,
        overallCompletion: round((rateCompletion + offerCompletion + resumeCompletion) / 3),
      },
    }));
  }),
);

/* ============================================================
 * 2. 月度趋势
 *    GET /api/job/statistics/trend?months=6
 * ============================================================ */

statisticsRouter.get(
  '/trend',
  wrap(async (_req, res) => {
    const months = Number(_req.query.months) || 6;
    const count = Math.min(Math.max(months, 1), 12);

    // ---- 生成最近 N 个月的月份列表 ----
    const list: string[] = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      list.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const result = [];
    for (const month of list) {
      const [{ employed }] = (await tbl(db, DB, REVIEW, STAGE)
        .where('is_deleted', false)
        .where('review_conclusion', ReviewConclusion.SIGNED)
        .whereRaw("DATE_FORMAT(review_time, '%Y-%m') = ?", [month])
        .count({ employed: '*' })) as Array<Record<string, any>>;

      const [{ resume }] = (await tbl(db, DB, LOG, STAGE)
        .where('is_deleted', false)
        .whereRaw("DATE_FORMAT(log_date, '%Y-%m') = ?", [month])
        .sum({ resume: 'resume_count' })) as Array<Record<string, any>>;

      const [{ interview }] = (await tbl(db, DB, LOG, STAGE)
        .where('is_deleted', false)
        .whereRaw("DATE_FORMAT(log_date, '%Y-%m') = ?", [month])
        .sum({ interview: 'interview_count' })) as Array<Record<string, any>>;

      result.push({
        month,
        employed: Number(employed || 0),
        resume: Number(resume || 0),
        interview: Number(interview || 0),
      });
    }

    res.json(ok(result));
  }),
);

/* ============================================================
 * 3. 部门就业分布
 *    GET /api/job/statistics/dept-distribution
 * ============================================================ */

statisticsRouter.get(
  '/dept-distribution',
  wrap(async (_req, res) => {
    const rows = await tbl(db, DB, STUDENT, STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', JOB_SCOPE)
      .select('dept_code')
      .sum({ employed: db.raw('CASE WHEN student_status = ? THEN 1 ELSE 0 END', [StudentStatus.EMPLOYED]) })
      .groupBy('dept_code');

    const result = rows.map((r: any) => ({
      name: DEPT_NAME[r.dept_code] || `部门${r.dept_code}`,
      value: Number(r.employed || 0),
    }));

    res.json(ok(result));
  }),
);

/* ============================================================
 * 4. 学生状态分布
 *    GET /api/job/statistics/status-distribution
 * ============================================================ */

statisticsRouter.get(
  '/status-distribution',
  wrap(async (_req, res) => {
    const rows = await tbl(db, DB, STUDENT, STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', JOB_SCOPE)
      .select('student_status')
      .count({ total: '*' })
      .groupBy('student_status');

    const result = rows.map((r: any) => ({
      name: STUDENT_STATUS_NAME[r.student_status] || String(r.student_status),
      value: Number(r.total),
    }));

    res.json(ok(result));
  }),
);

/* ============================================================
 * 5. 班级就业 TOP
 *    GET /api/job/statistics/class-top?limit=10
 * ============================================================ */

statisticsRouter.get(
  '/class-top',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

    const rows = await tbl(db, DB, STUDENT, STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', JOB_SCOPE)
      .whereNotNull('class_name')
      .where('class_name', '!=', '')
      .select('class_name')
      .sum({ employed: db.raw('CASE WHEN student_status = ? THEN 1 ELSE 0 END', [StudentStatus.EMPLOYED]) })
      .count({ total: '*' })
      .groupBy('class_name')
      .havingRaw('employed > 0')
      .orderBy('employed', 'desc')
      .limit(limit);

    const result = rows.map((r: any) => ({
      name: r.class_name,
      value: Number(r.employed || 0),
    }));

    res.json(ok(result));
  }),
);

/* ============================================================
 * 6. 查询 / 修改 KPI 目标
 *    GET  /api/job/statistics/kpi-target
 *    PUT  /api/job/statistics/kpi-target
 * ============================================================ */

statisticsRouter.get(
  '/kpi-target',
  wrap(async (_req, res) => {
    const row = await getOrCreateTarget();
    res.json(ok({
      id: row.id,
      targetRate: Number(row.target_rate),
      targetOffer: Number(row.target_offer),
      targetResume: Number(row.target_resume),
      updateTime: row.update_time,
    }));
  }),
);

statisticsRouter.put(
  '/kpi-target',
  validate(z.object({
    targetRate: z.coerce.number().min(0).max(100, '目标就业率应在 0~100 之间'),
    targetOffer: z.coerce.number().int().min(0).max(99999),
    targetResume: z.coerce.number().min(0).max(9999),
  })),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      targetRate: number;
      targetOffer: number;
      targetResume: number;
    };

    const row = await getOrCreateTarget();

    await tbl(db, DB, KPI, STAGE).where({ id: row.id }).update({
      target_rate: body.targetRate,
      target_offer: body.targetOffer,
      target_resume: body.targetResume,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, 'KPI 目标已保存'));
  }),
);

export default statisticsRouter;
