/**
 * 成绩管理路由（就业管理 > 实训阶段）
 *
 * 接口前缀：/api/job/exam-score
 * 表：t_job_exam_score（成绩）、t_student_base（学生，用于末班次数）
 *     t_job_class / t_job_class_student（末班转班用）、t_job_notice（末班通知）
 * 字段依据：docs/考试成绩-字段定稿.md
 *
 * ⚠️ 三个核心逻辑：
 *    ① 录入分数后，系统自动算「笔试均分」和「综合成绩」
 *    ② 「末班」= 改本表 exam_result + 转班 + 学生班级变更 + 末班次数 +1 + 发通知（可撤销）
 *    ③ 撤销末班 = 反向操作
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, EXAM_RESULT_NAME, RoleCode, EXAM_TYPE_NAME } from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { today, fmtDateTime } from '../utils/date';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { sendNotice, NOTICE_TYPE } from '../utils/notice';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ P3 切读层：本文件五张表（t_job_exam_score / t_student_base / t_job_class /
//   t_job_class_student / t_job_exam）都已归一，全部走 tbl()/tblTrx()/tblInsTrx() 路由；
//   开关关时与原实现逐字节等价。
import { tbl, tblInsTrx, tblTrx } from '../teaching/shared/uniTable';

export const examScoreRouter = Router();

/** 表名常量 */
const TABLE = 't_job_exam_score';
const STUDENT_TABLE = 't_student_base';
const CLASS_TABLE = 't_job_class';
const CS_TABLE = 't_job_class_student';

/** 花名册状态 */
const CS_IN = 1;
const CS_LEFT = 2;

/** 考试表（成绩管理页的「考试下拉」要用） */
const EXAM_TABLE = 't_job_exam';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/* ============================================================
 * 考试下拉选项（给「成绩管理」页选考试用）
 *    GET /api/job/exam-score/exam-options
 *
 * ⚠️ 为什么单独开一个接口（2026-09-30 踩到）：
 *   成绩管理页原来调的是 /api/job/exam/page —— 那个接口挂在**考试管理**前缀下，
 *   需要 job:exam:view 页面权限，而班主任/教员/助教都**没有**（考试管理只给校长）。
 *   结果一进页面就弹「您没有该操作的权限」（虽然不影响录分，但很吓人）。
 *   所以这里给一份同前缀（exam-score）的精简列表。
 * ============================================================ */
examScoreRouter.get(
  '/exam-options',
  wrap(async (_req, res) => {
    const rows = await tbl(db, DB, EXAM_TABLE, STAGE)
      .where('is_deleted', false)
      .select('id', 'exam_name', 'exam_type', 'exam_time', 'class_ids', 'class_names', 'content_types')
      .orderBy('exam_time', 'desc')
      .limit(200);

    res.json(
      ok(
        rows.map((r: any) => ({
          examId: r.id,
          examName: r.exam_name,
          examType: r.exam_type,
          examTypeName: EXAM_TYPE_NAME[r.exam_type] || '',
          examTime: fmtDateTime(r.exam_time),
          classIds: r.class_ids || '',
          classNames: r.class_names || '',
          contentTypes: r.content_types || '',
          contentTypesName: '',
          creatorName: null,
        })),
      ),
    );
  }),
);
/** 入班方式：3末班转入 */
const JOIN_TYPE_REPEAT_IN = 3;
/** 离班方式：2末班转出 */
const LEAVE_TYPE_REPEAT_OUT = 2;
/** 班级状态：4已结业 */
const CLASS_STATUS_GRADUATED = 4;

/** 分数范围 */
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * ★ 核心：算两个均分
 *
 *   笔试部分均分 = 卷面 × 50% + 机试 × 50%（缺一项 → 留空）
 *   综合成绩     = 笔试均分 × 50% + 面试 × 50%（缺面试 → 留空）
 *
 * ⚠️ 为什么「留空」而不是按 0 算？
 *    按 0 算会把「没考」当成「考了 0 分」，领导看汇总会被误导。
 *    留空 = 「还没考完」，一眼看得出。
 */
function calcScores(paper?: number | null, machine?: number | null, interview?: number | null) {
  const has = (v: number | null | undefined): v is number =>
    v !== null && v !== undefined && !Number.isNaN(Number(v));

  const round2 = (n: number) => Math.round(n * 100) / 100;

  let writtenAvg: number | null = null;
  if (has(paper) && has(machine)) {
    writtenAvg = round2(Number(paper) * 0.5 + Number(machine) * 0.5);
  }

  let totalScore: number | null = null;
  if (writtenAvg !== null && has(interview)) {
    totalScore = round2(writtenAvg * 0.5 + Number(interview) * 0.5);
  }

  return { writtenAvg, totalScore };
}

/** 校验分数是否在 0-100（前端也校验，这里是最后一道防线） */
function assertScoreRange(label: string, v: number | null | undefined) {
  if (v === null || v === undefined) return;
  if (Number.isNaN(Number(v)) || Number(v) < MIN_SCORE || Number(v) > MAX_SCORE) {
    throw new BizError(BizCode.PARAM_ERROR, `${label}需在 ${MIN_SCORE}-${MAX_SCORE} 之间`);
  }
}

/* ============================================================
 * 1. 查询成绩列表
 *    GET /api/job/exam-score/page?page=1&size=20&examId=xxx&classId=xxx
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(200).default(20),
  examId: z.string().optional(),
  classId: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  examResult: z.coerce.number().int().optional(),
  /** 只看未录入成绩的（字符串 "true" / true 都认） */
  onlyUnscored: z.union([z.boolean(), z.string()]).optional(),
  keyword: z.string().optional(),
});

examScoreRouter.get(
  '/page',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    await applyTrainingScope(query, req, { table: TABLE, dbName: DB });

    // ★ 数据范围：班主任只能看【自己带的班】的成绩（斌哥 2026-09-30）
    //   口径与宿舍/催费一致 —— 以**班级表**的 head_teacher_id 为准
    //   （学生主档的那个字段大量为空，不可靠）。
    //   校长/管理员不受限，看全部。
    const myRoles = req.user?.roles || [];
    if (myRoles.includes(RoleCode.TEACH_HEAD) && !myRoles.includes(RoleCode.SYS_ADMIN)) {
      const myClasses = await tbl(db, DB, CLASS_TABLE, STAGE)
        .where({ head_teacher_id: req.user?.userId || '', is_deleted: false })
        .select('id');
      // 一个班都没有 → 传空数组，结果自然是空的（不会误放开成"看全部"）
      query.whereIn(
        'class_id',
        myClasses.map((c: any) => c.id),
      );
    }

    if (q.examId) query.andWhere('exam_id', q.examId);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.studentNo) query.andWhere('student_no', 'like', `%${q.studentNo}%`);
    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.examResult) query.andWhere('exam_result', q.examResult);

    // onlyUnscored：总分还是空的（说明还没录全）
    if (q.onlyUnscored === true || q.onlyUnscored === 'true') {
      query.whereNull('total_score');
    }

    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`)
          .orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('*')
      .orderBy('student_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // ---- 带出学生的当前末班次数（老师判断时要用）----
    const studentIds = rows.map((r: any) => r.student_id);
    const repeatMap: Record<string, number> = {};
    if (studentIds.length > 0) {
      const students = await tbl(db, DB, STUDENT_TABLE, STAGE)
        .whereIn('id', studentIds)
        .select('id', 'repeat_count');
      students.forEach((s: any) => {
        repeatMap[s.id] = Number(s.repeat_count) || 0;
      });
    }

    const list = rows.map((r: any) => ({
      scoreId: r.id,
      examId: r.exam_id,
      examName: r.exam_name,
      studentId: r.student_id,
      studentNo: r.student_no,
      studentName: r.student_name,
      classId: r.class_id,
      className: r.class_name,
      // ⚠️ decimal 在 mysql2 里可能返回字符串，统一转数字
      paperScore: r.paper_score === null ? undefined : Number(r.paper_score),
      machineScore: r.machine_score === null ? undefined : Number(r.machine_score),
      writtenAvg: r.written_avg === null ? undefined : Number(r.written_avg),
      interviewScore: r.interview_score === null ? undefined : Number(r.interview_score),
      totalScore: r.total_score === null ? undefined : Number(r.total_score),
      examResult: r.exam_result ?? undefined,
      examResultName: r.exam_result === null ? '' : (EXAM_RESULT_NAME[r.exam_result] || ''),
      repeatCount: repeatMap[r.student_id] ?? 0,
      remark: r.remark,
      entryByName: r.entry_by_name,
      entryTime: r.entry_time,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 录入 / 修改分数（★ 自动重算均分）
 *    PUT /api/job/exam-score/update
 * ============================================================ */

const updateSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  paperScore: z.coerce.number().min(MIN_SCORE).max(MAX_SCORE, `卷面成绩需在 0-100 之间`).optional().nullable(),
  machineScore: z.coerce.number().min(MIN_SCORE).max(MAX_SCORE, `机试成绩需在 0-100 之间`).optional().nullable(),
  interviewScore: z.coerce.number().min(MIN_SCORE).max(MAX_SCORE, `面试成绩需在 0-100 之间`).optional().nullable(),
  remark: z.string().max(500).optional(),
});

examScoreRouter.put(
  '/update',
  checkPermission('job:exam-score:edit'),
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!exists) {
      throw new BizError(BizCode.SCORE_NOT_FOUND, '成绩记录不存在或已被删除');
    }

    // 再兜一道分数范围校验（zod 已校验，这里防未来改动漏掉）
    assertScoreRange('卷面成绩', body.paperScore);
    assertScoreRange('机试成绩', body.machineScore);
    assertScoreRange('面试成绩', body.interviewScore);

    // ---- 空字符串统一转 null，避免把 '' 存进 decimal ----
    const norm = (v: number | null | undefined): number | null =>
      v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);

    const paper = norm(body.paperScore);
    const machine = norm(body.machineScore);
    const interview = norm(body.interviewScore);

    const { writtenAvg, totalScore } = calcScores(paper, machine, interview);

    const now = new Date();
    const operatorId = req.user?.userId || 'system';
    const operatorName = req.user?.userName || '系统';

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      paper_score: paper,
      machine_score: machine,
      interview_score: interview,
      written_avg: writtenAvg,
      total_score: totalScore,
      remark: body.remark ?? null,
      // 留痕（决定 8）
      entry_by: operatorId,
      entry_by_name: operatorName,
      entry_time: now,
      update_time: now,
      update_by: operatorId,
    });

    // 返回最新记录，前端可直接刷新那一行
    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).first();

    res.json(ok({
      scoreId: row.id,
      paperScore: row.paper_score === null ? undefined : Number(row.paper_score),
      machineScore: row.machine_score === null ? undefined : Number(row.machine_score),
      writtenAvg: row.written_avg === null ? undefined : Number(row.written_avg),
      interviewScore: row.interview_score === null ? undefined : Number(row.interview_score),
      totalScore: row.total_score === null ? undefined : Number(row.total_score),
      entryByName: row.entry_by_name,
      entryTime: row.entry_time,
      isDeleted: row.is_deleted,
      id: row.id,
      examId: row.exam_id,
      examName: row.exam_name,
      studentId: row.student_id,
      studentNo: row.student_no,
      studentName: row.student_name,
      className: row.class_name,
      examResult: row.exam_result ?? undefined,
      remark: row.remark,
    }, '保存成功'));
  }),
);

/* ============================================================
 * 3. 标末班（★ 改版：选目标班 + 填原因 + 转班 + 发通知）
 *    POST /api/job/exam-score/repeat/:id
 *
 * 【业务含义】（2026-09-29 斌哥改版）
 *   考试不合格 → 该生转到「末班目标班」重修，直到学会为止。
 *
 * 【一次末班要做的 6 件事】（全在同一事务）
 *   ① 成绩表：exam_result = 2未通过
 *   ② 原班花名册：status=2已离班 + leaveType=2末班转出 + 写末班原因
 *   ③ 目标班花名册：新增一条 status=1在班 + joinType=3末班转入
 *   ④ 学生主档：class_id/class_name 改成目标班
 *   ⑤ 学生主档：repeat_count +1
 *   ⑥ 给目标班班主任发站内信通知
 *
 * 【为什么不改成绩表结构存末班原因】
 *   末班原因 = 离班原因，花名册的 leave_reason 本来就是这个语义，不必重复存。
 * ============================================================ */

const repeatSchema = z.object({
  /** 末班后转入的目标班级（必填 —— 斌哥要求"选要末的班级"） */
  targetClassId: z.string().min(1, '请选择末班要转入的班级'),
  /** 末班原因（必填 —— 斌哥要求"填写末班原因"） */
  repeatReason: z.string().min(1, '请填写末班原因').max(200, '末班原因最多 200 字'),
  /** 末班日期（默认今天） */
  repeatDate: z.string().optional(),
});

examScoreRouter.post(
  '/repeat/:id',
  checkPermission('job:exam-score:repeat'),
  validate(repeatSchema),
  wrap(async (req, res) => {
    const { id } = req.params;
    const body = (req as any).validated as z.infer<typeof repeatSchema>;

    // ---- 成绩记录 ----
    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.SCORE_NOT_FOUND, '成绩记录不存在或已被删除');
    }

    // ⚠️ 防重复标记
    if (row.exam_result === 2) {
      throw new BizError(BizCode.PARAM_ERROR, `${row.student_name} 已是末班状态，无需重复标记`);
    }

    // ---- 学生主档（转班以主档的当前班级为准，不用成绩表里的快照）----
    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: row.student_id, is_deleted: false }).first();
    if (!stu) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或已被删除');
    }

    // ---- 目标班级 ----
    const targetCls = await tbl(db, DB, CLASS_TABLE, STAGE)
      .where({ id: body.targetClassId, is_deleted: false })
      .first();
    if (!targetCls) {
      throw new BizError(BizCode.CLASS_NOT_FOUND, '末班目标班级不存在');
    }

    // 已结业的班不能接收末班学生
    if (targetCls.class_status === CLASS_STATUS_GRADUATED) {
      throw new BizError(BizCode.CLASS_STATUS_NOT_ALLOW, '目标班级已结业，不能接收末班学生');
    }

    // 目标班不能是该生【当前】所在班
    if (stu.class_id && stu.class_id === body.targetClassId) {
      throw new BizError(BizCode.PARAM_ERROR, `${stu.student_name} 当前就在该班，无需末班转班`);
    }

    const now = new Date();
    const operatorId = req.user?.userId || 'system';
    const operatorName = req.user?.userName || null;
    const repeatDate = body.repeatDate || today();

    let newRepeatCount = 0;
    let leftFromClassName: string | null = null;
    let noticeId: string | null = null;

    await db.transaction(async (trx) => {
      // ① 成绩表：标记未通过（末班）
      await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update({
        exam_result: 2,
        update_time: now,
        update_by: operatorId,
      });

      // ② 原班花名册：改成"已离班 + 末班转出"
      if (stu.class_id) {
        const curCls = await tblTrx(trx, DB, CLASS_TABLE, STAGE).where({ id: stu.class_id }).first();
        leftFromClassName = curCls?.class_name || stu.class_name || null;

        await tblTrx(trx, DB, CS_TABLE, STAGE)
          .where({ class_id: stu.class_id, student_id: stu.id, status: CS_IN, is_deleted: false })
          .update({
            status: CS_LEFT,
            leave_date: repeatDate,
            leave_type: LEAVE_TYPE_REPEAT_OUT,   // 2末班转出
            leave_reason: body.repeatReason,
            update_time: now,
            update_by: operatorId,
          });

        // 重算原班人数
        const [{ cnt: oldCnt }] = (await tblTrx(trx, DB, CS_TABLE, STAGE)
          .where({ class_id: stu.class_id, status: CS_IN, is_deleted: false })
          .count({ cnt: '*' })) as Array<{ cnt: number }>;
        await tblTrx(trx, DB, CLASS_TABLE, STAGE)
          .where({ id: stu.class_id })
          .update({ student_count: Number(oldCnt), update_time: now });
      }

      // ③ 目标班花名册：新增"末班转入"
      //    先看是否已有"在班"记录（防重复）
      const already = await tblTrx(trx, DB, CS_TABLE, STAGE)
        .where({
          class_id: body.targetClassId,
          student_id: stu.id,
          status: CS_IN,
          is_deleted: false,
        })
        .first();

      if (!already) {
        await tblInsTrx(trx, DB, CS_TABLE, STAGE, {
          id: randomUUID(),
          create_time: now,
          create_by: operatorId,
          is_deleted: false,

          class_id: body.targetClassId,
          class_name: targetCls.class_name,
          student_id: stu.id,
          student_no: stu.student_no,
          student_name: stu.student_name,

          join_date: repeatDate,
          join_type: JOIN_TYPE_REPEAT_IN,   // 3末班转入
          status: CS_IN,
          remark: `末班转入：${body.repeatReason}`,
        });
      }

      // 重算目标班人数
      const [{ cnt: newCnt }] = (await tblTrx(trx, DB, CS_TABLE, STAGE)
        .where({ class_id: body.targetClassId, status: CS_IN, is_deleted: false })
        .count({ cnt: '*' })) as Array<{ cnt: number }>;
      await tblTrx(trx, DB, CLASS_TABLE, STAGE)
        .where({ id: body.targetClassId })
        .update({ student_count: Number(newCnt), update_time: now });

      // ④⑤ 学生主档：改班级 + 末班次数 +1
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .where({ id: stu.id })
        .update({
          class_id: body.targetClassId,
          class_name: targetCls.class_name,
          head_teacher_id: targetCls.head_teacher_id,
          head_teacher_name: targetCls.head_teacher_name,
          teacher_id: targetCls.teacher_id,
          teacher_name: targetCls.teacher_name,
          assistant_id: targetCls.assistant_id,
          assistant_name: targetCls.assistant_name,
          repeat_count: db.raw('repeat_count + 1'),
          update_time: now,
          update_by: operatorId,
        });

      const stuAfter = await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .where({ id: stu.id })
        .select('repeat_count')
        .first();
      newRepeatCount = Number(stuAfter?.repeat_count) || 0;

      // ⑥ 给目标班班主任发通知（站内信）
      if (targetCls.head_teacher_id) {
        noticeId = await sendNotice(
          {
            noticeType: NOTICE_TYPE.REPEAT,
            title: `末班转入通知：${stu.student_name}（${stu.student_no}）`,
            content:
              `学生【${stu.student_name}】因考试未通过，被标记为末班（累计第 ${newRepeatCount} 次），` +
              `已转入你带的【${targetCls.class_name}】。\n` +
              `原班级：${leftFromClassName || '（无）'}\n` +
              `末班原因：${body.repeatReason}\n` +
              `操作人：${operatorName || operatorId}\n` +
              `时间：${repeatDate}\n\n` +
              `请及时关注该生学习情况，做好接收与补课安排。`,
            receiverId: targetCls.head_teacher_id,
            receiverName: targetCls.head_teacher_name,
            receiverRole: RoleCode.TEACH_HEAD,
            senderId: operatorId,
            senderName: operatorName,
            bizType: 'repeat',
            bizId: id,
            classId: targetCls.id,
            className: targetCls.class_name,
            studentId: stu.id,
            studentName: stu.student_name,
          },
          trx,
        );
      }
    });

    res.json(
      ok(
        {
          repeatCount: newRepeatCount,
          targetClassName: targetCls.class_name,
          targetHeadTeacherName: targetCls.head_teacher_name,
          leftFromClassName,
          noticeId,
          notified: !!noticeId,
        },
        `${stu.student_name} 已标记末班（累计第 ${newRepeatCount} 次），` +
          `已从【${leftFromClassName || '无班级'}】转入【${targetCls.class_name}】` +
          (noticeId ? `，已通知班主任 ${targetCls.head_teacher_name || ''}` : '，该班暂无班主任，未发通知'),
      ),
    );
  }),
);

/* ============================================================
 * 4. 撤销末班（★ 改版：状态回退 + 末班次数 -1 + 学生转回原班）
 *    POST /api/job/exam-score/cancel-repeat/:id
 *
 * 【撤销 = 完整回退】（2026-09-29 斌哥确认方案 A）
 *   标末班做了 6 件事，撤销就反向做回来：
 *   ① 成绩表：exam_result 改回 null「未判断」（不改成「通过」，老师可能还要重判）
 *   ② 学生主档：repeat_count -1
 *   ③ 目标班花名册：把「末班转入」那条改成已离班（或直接软删）
 *   ④ 原班花名册：把「末班转出」那条恢复成「在班」
 *   ⑤ 学生主档：班级改回原班（含三负责人字段一起回退）
 *   ⑥ 两个班的 student_count 重算
 *
 * 【怎么知道"原班"是哪个班？】
 *   靠花名册：该生 leave_type=2末班转出 且 leave_reason 匹配的那条记录里的 class_id。
 *   取最近一条（按离班日期倒序）—— 万一学生末班过多次，撤销的是最后一次。
 *
 * 【回退不了怎么办？】
 *   如果找不到「末班转出」的原班记录（比如数据被人手工改过），
 *   就只做 ①② 两步状态回退，班级保持不变，并在返回里说明。
 *   —— 宁可少做，也不要瞎猜一个班塞进去。
 * ============================================================ */

examScoreRouter.post(
  '/cancel-repeat/:id',
  checkPermission('job:exam-score:repeat'),
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) {
      throw new BizError(BizCode.SCORE_NOT_FOUND, '成绩记录不存在或已被删除');
    }

    // ⚠️ 防误操作：没标末班的不能撤销
    if (row.exam_result !== 2) {
      throw new BizError(BizCode.PARAM_ERROR, `${row.student_name} 当前不是末班状态，无需撤销`);
    }

    // ⚠️ 防减成负数
    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: row.student_id }).first();
    if (!stu) {
      throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在或已被删除');
    }
    const currentCount = Number(stu?.repeat_count) || 0;
    if (currentCount <= 0) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `${row.student_name} 的末班次数已是 0，无法再减少。请先核对该生的末班记录`,
      );
    }

    const now = new Date();
    const operatorId = req.user?.userId || 'system';
    let newRepeatCount = 0;
    let restoredClassName: string | null = null;
    let rollbackClass = false;

    // ---- 先找「原班」：最近一条末班转出的花名册记录 ----
    const leftRecord = await tbl(db, DB, CS_TABLE, STAGE)
      .where({
        student_id: row.student_id,
        status: CS_LEFT,
        leave_type: LEAVE_TYPE_REPEAT_OUT,
        is_deleted: false,
      })
      .orderBy('leave_date', 'desc')
      .orderBy('update_time', 'desc')
      .first();

    const originClassId: string | null = leftRecord?.class_id || null;

    await db.transaction(async (trx) => {
      // ① 成绩表：改回「未判断」，而不是「通过」（老师可能还要重新判断）
      await tblTrx(trx, DB, TABLE, STAGE).where({ id }).update({
        exam_result: null,
        update_time: now,
        update_by: operatorId,
      });

      // ② 学生主档：末班次数 -1
      await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .where({ id: row.student_id })
        .decrement('repeat_count', 1);

      // ---- ③④⑤ 回退班级（只在找得到原班时才做）----
      if (originClassId) {
        const originCls = await tblTrx(trx, DB, CLASS_TABLE, STAGE)
          .where({ id: originClassId, is_deleted: false })
          .first();

        if (originCls) {
          rollbackClass = true;

          // ③ 当前班（末班目标班）花名册：把「末班转入」那条撤掉
          if (stu.class_id) {
            await tblTrx(trx, DB, CS_TABLE, STAGE)
              .where({
                class_id: stu.class_id,
                student_id: stu.id,
                status: CS_IN,
                is_deleted: false,
              })
              .update({
                status: CS_LEFT,
                leave_date: today(),
                leave_type: LEAVE_TYPE_REPEAT_OUT,
                leave_reason: '撤销末班（转回原班）',
                update_time: now,
                update_by: operatorId,
              });
          }

          // ④ 原班花名册：把「末班转出」那条恢复成在班
          await tblTrx(trx, DB, CS_TABLE, STAGE)
            .where({ id: leftRecord.id })
            .update({
              status: CS_IN,
              leave_date: null,
              leave_type: null,
              leave_reason: null,
              update_time: now,
              update_by: operatorId,
            });

          // ⑤ 学生主档：班级 + 三负责人字段一起回退
          await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
            .where({ id: stu.id })
            .update({
              class_id: originCls.id,
              class_name: originCls.class_name,
              head_teacher_id: originCls.head_teacher_id,
              head_teacher_name: originCls.head_teacher_name,
              teacher_id: originCls.teacher_id,
              teacher_name: originCls.teacher_name,
              assistant_id: originCls.assistant_id,
              assistant_name: originCls.assistant_name,
              update_time: now,
              update_by: operatorId,
            });

          restoredClassName = originCls.class_name;

          // ⑥ 重算两个班的人数
          for (const cid of [stu.class_id, originCls.id]) {
            if (!cid) continue;
            const [{ cnt }] = (await tblTrx(trx, DB, CS_TABLE, STAGE)
              .where({ class_id: cid, status: CS_IN, is_deleted: false })
              .count({ cnt: '*' })) as Array<{ cnt: number }>;
            await tblTrx(trx, DB, CLASS_TABLE, STAGE)
              .where({ id: cid })
              .update({ student_count: Number(cnt), update_time: now });
          }
        }
      }

      const after = await tblTrx(trx, DB, STUDENT_TABLE, STAGE)
        .where({ id: row.student_id })
        .select('repeat_count')
        .first();
      newRepeatCount = Number(after?.repeat_count) || 0;
    });

    res.json(ok(
      {
        repeatCount: newRepeatCount,
        rollbackClass,
        restoredClassName,
      },
      `已撤销 ${row.student_name} 的末班标记，末班次数 -1（当前 ${newRepeatCount} 次）` +
        (rollbackClass
          ? `，已转回原班级【${restoredClassName}】`
          : '，未找到原班级记录，班级未变动，请手动核对'),
    ));
  }),
);

export default examScoreRouter;
