/**
 * 成绩仓储 · 大学（sms_class）· 表 t_class_grade
 *
 * 特点：字段名无前缀（written_score / comp_score）；exam_name 冗余在本表；
 *      公式 = 笔试×50% + 面试×50%，**缺项按 0 计**；另有素质分析 analysis。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class/db';
import { calcScores } from '../shared/conf';
import type {
  ScoreEntry,
  ScoreEntryRow,
  ScoreListQuery,
  ScoreRepeatBody,
  ScoreRepeatResult,
  ScoreRow,
  ScoreSaveBody,
  ScoreUpdateBody,
} from '../shared/dto';
import { EXAM_RESULT_NAME, TEACHING_STAGE_NAME } from '../shared/dto';
import { tbl, phaseCodeCol } from '../shared/uniTable';
import {
  CLASS_STATUS_GRADUATED,
  composeRepeatReason,
  insertUniRepeat,
  mergeRemark,
  repeatTimeOf,
} from './repeatRecord';

const G = 't_class_grade';
const E = 't_class_exam';
const EC = 't_class_exam_content';
const STU = 't_class_student';
const CLS = 't_class_info';
const RPT = 't_class_repeat';
const STAGE = 'class' as const;

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** 满分合计 = 该场考试内容项满分的和 */
async function fullTotalOf(examId: string): Promise<number> {
  const rows = (await db(EC).where({ exam_id: examId, is_deleted: 0 }).select('full_score')) as Array<
    Record<string, any>
  >;
  return rows.reduce((a, r) => a + Number(r.full_score || 0), 0);
}

function mapRow(r: Record<string, any>): ScoreRow {
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '大学部',
    examId: String(r.exam_id ?? ''),
    examName: String(r.exam_name ?? ''),
    examDate: null,
    classId: (r.class_id as string) ?? null,
    className: (r.class_name as string) ?? null,
    studentId: String(r.student_id),
    studentNo: (r.student_no as string) ?? null,
    studentName: (r.student_name as string) ?? null,
    writtenScore: num(r.written_score),
    machineScore: num(r.machine_score),
    interviewScore: num(r.interview_score),
    otherScore: null,
    writtenAvg: null, // 大学不算笔试均分
    totalScore: num(r.comp_score),
    examResult: r.exam_result === null || r.exam_result === undefined ? null : Number(r.exam_result),
    examResultName: EXAM_RESULT_NAME[Number(r.exam_result)] ?? '—',
    remark: (r.analysis as string) ?? (r.remark as string) ?? null,
  };
}

export async function list(q: ScoreListQuery): Promise<ScoreRow[]> {
  const qb = db(G).where('is_deleted', 0);
  if (q.examId) qb.andWhere('exam_id', q.examId);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.studentId) qb.andWhere('student_id', q.studentId);
  if (q.keyword) qb.andWhere('student_name', 'like', `%${q.keyword}%`);
  const rows = (await qb.orderBy('student_no')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function entry(examId: string, classId: string): Promise<ScoreEntry> {
  const exam = (await tbl(db, 'sms_class', E, STAGE).where({ id: examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  const clsId = classId || String(exam.class_id);
  const students = (await tbl(db, 'sms_class', STU, STAGE).where({ class_id: clsId, is_deleted: 0 }).orderBy('student_no')) as Array<
    Record<string, any>
  >;
  const scores = (await db(G).where({ exam_id: examId, is_deleted: 0 })) as Array<Record<string, any>>;
  const smap = new Map(scores.map((s) => [String(s.student_id), s]));

  const rows: ScoreEntryRow[] = students.map((st) => {
    const s = smap.get(String(st.id));
    return {
      studentId: String(st.id),
      studentNo: (st.student_no as string) ?? null,
      studentName: (st.student_name as string) ?? null,
      scoreId: s ? String(s.id) : null,
      writtenScore: num(s?.written_score),
      machineScore: num(s?.machine_score),
      interviewScore: num(s?.interview_score),
      otherScore: null,
      writtenAvg: null,
      totalScore: num(s?.comp_score),
      examResult: s?.exam_result === null || s?.exam_result === undefined ? null : Number(s.exam_result),
      remark: (s?.analysis as string) ?? null,
    };
  });

  return {
    stage: STAGE,
    stageName: '大学部',
    examId,
    examName: String(exam.exam_name ?? ''),
    examDate: exam.exam_date ? String(exam.exam_date).slice(0, 10) : null,
    classId: clsId,
    className: String(exam.class_name ?? ''),
    fullTotal: await fullTotalOf(examId),
    hasWrittenAvg: false,
    rows,
  };
}

export async function save(body: ScoreSaveBody, userId: string) {
  const exam = (await tbl(db, 'sms_class', E, STAGE).where({ id: body.examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  const fullTotal = await fullTotalOf(body.examId);
  const now = new Date();
  let saved = 0;

  for (const r of body.rows) {
    const vals = {
      written: r.writtenScore ?? null,
      machine: r.machineScore ?? null,
      interview: r.interviewScore ?? null,
      other: r.otherScore ?? null,
    };
    const { totalScore, examResult } = await calcScores(STAGE, vals, fullTotal);
    // ★ 大学 judgeMode='manual'：老师手选。该列 NOT NULL → 未传时默认「通过」。
    const finalResult = r.examResult ?? examResult ?? 1;

    const existed = (await db(G)
      .where({ exam_id: body.examId, student_id: r.studentId, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const payload = {
      written_score: vals.written,
      machine_score: vals.machine,
      interview_score: vals.interview,
      comp_score: totalScore,
      exam_result: finalResult,
      analysis: r.remark ?? null,
      update_time: now,
      update_by: userId,
    };

    if (existed) {
      await db(G).where({ id: existed.id }).update(payload);
    } else {
      const stu = (await tbl(db, 'sms_class', STU, STAGE).where({ id: r.studentId, is_deleted: 0 }).first()) as
        | Record<string, any>
        | undefined;
      await db(G).insert({
        id: randomUUID(),
        exam_id: body.examId,
        exam_name: exam.exam_name,
        class_id: exam.class_id,
        class_name: exam.class_name,
        student_id: r.studentId,
        student_no: stu?.student_no ?? null,
        student_name: stu?.student_name ?? null,
        ...payload,
        is_deleted: 0,
        create_time: now,
        create_by: userId,
      });
    }
    saved += 1;
  }
  return { saved };
}

/* ============================================================
 * 编辑：单行改分（列表「编辑」）
 * ============================================================
 * ★ 大学的「结果」是老师手选（judgeMode='manual'），所以：
 *   传了 examResult 就用传的；没传就保持原值。
 *   该列 NOT NULL —— 永远不会写 null（写 null 会 ER_BAD_NULL_ERROR）。
 * ★ 备注在这张表里叫 analysis（历史列名），不是 remark。
 */
export async function updateOne(body: ScoreUpdateBody, userId: string) {
  const row = (await db(G).where({ id: body.id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!row) throw new Error('成绩记录不存在或已被删除');

  const payload: Record<string, any> = { update_time: new Date(), update_by: userId };

  const touched =
    body.writtenScore !== undefined ||
    body.machineScore !== undefined ||
    body.interviewScore !== undefined ||
    body.otherScore !== undefined;

  if (touched) {
    const vals = {
      written: body.writtenScore !== undefined ? body.writtenScore : num(row.written_score),
      machine: body.machineScore !== undefined ? body.machineScore : num(row.machine_score),
      interview: body.interviewScore !== undefined ? body.interviewScore : num(row.interview_score),
      other: body.otherScore !== undefined ? body.otherScore : num(row.other_score),
    };
    const fullTotal = await fullTotalOf(String(row.exam_id));
    const { totalScore, examResult } = await calcScores(STAGE, vals, fullTotal);
    payload.written_score = vals.written;
    payload.machine_score = vals.machine;
    payload.interview_score = vals.interview;
    payload.comp_score = totalScore;
    payload.exam_result = body.examResult ?? examResult ?? row.exam_result ?? 1;
  } else if (body.examResult !== undefined) {
    // 只改结果（不动分数）：老师可以直接把「通过」改成「未通过」
    payload.exam_result = body.examResult ?? row.exam_result ?? 1;
  }

  if (body.remark !== undefined) payload.analysis = body.remark;

  await db(G).where({ id: body.id }).update(payload);
  return { updated: 1 };
}

/* ============================================================
 * 末班（列表「末班」）
 * ============================================================
 * 与初高同构，差别只有三处：
 *   ① 成绩表/列名不同（comp_score / analysis）
 *   ② 末班记录表多 4 列（exam_name + 三项分数快照）
 *   ③ 结果由老师手选，末班只是把学生转走，不重算成绩
 */
export async function repeat(body: ScoreRepeatBody, userId: string): Promise<ScoreRepeatResult> {
  if (body.targetStage !== STAGE) throw new Error('大学学生只能末班到大学班级');

  const row = (await db(G).where({ id: body.scoreId, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!row) throw new Error('成绩记录不存在或已被删除');
  if (Number(row.exam_result) !== 2) throw new Error('只有结果为「未通过」的学生才能执行末班');

  const stu = (await tbl(db, 'sms_class', STU, STAGE)
    .where({ id: String(row.student_id), is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!stu) throw new Error('学生不存在或已被删除');
  // ★ 防重复末班：末班成功后学生已经转走，再点同一条成绩就不该再动一次
  if (String(stu.class_id ?? '') !== String(row.class_id ?? '')) {
    throw new Error('该生已不在本场考试所在班级（可能已末班过），不能重复末班');
  }

  const toCls = (await tbl(db, 'sms_class', CLS, STAGE)
    .where({ id: body.targetClassId, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!toCls) throw new Error('目标班级不存在或已被删除');
  if (Number(toCls.class_status) === CLASS_STATUS_GRADUATED) throw new Error('目标班级已结业，不能接收末班学生');
  if (String(stu.class_id ?? '') === body.targetClassId) throw new Error('目标班级就是该生当前所在班，无需末班');

  const now = new Date();
  const repeatTime = repeatTimeOf(body.repeatDate);
  const nextCount = Number(stu.repeat_count ?? 0) + 1;
  const reason = composeRepeatReason(body.repeatReason, body.shortcoming);
  const fromClassName = (stu.class_name as string) ?? null;
  const fromStageCode = stu.stage === null || stu.stage === undefined ? null : Number(stu.stage);
  const toStageCode = toCls.stage === null || toCls.stage === undefined ? null : Number(toCls.stage);

  const trx = await db.transaction();
  try {
    await tbl(trx as any, 'sms_class', STU, STAGE)
      .where({ id: String(stu.id) })
      .update({
        class_id: body.targetClassId,
        class_name: String(toCls.class_name ?? ''),
        [phaseCodeCol()]: toStageCode,
        repeat_count: nextCount,
        update_time: now,
        update_by: userId,
      });

    await trx(RPT).insert({
      id: randomUUID(),
      student_id: String(stu.id),
      student_no: String(stu.student_no ?? ''),
      student_name: String(stu.student_name ?? ''),
      from_class_id: (stu.class_id as string) ?? null,
      from_class_name: fromClassName,
      to_class_id: body.targetClassId,
      to_class_name: String(toCls.class_name ?? ''),
      repeat_reason: reason,
      repeat_time: repeatTime,
      repeat_count: nextCount,
      exam_name: String(row.exam_name ?? '') || null,
      written_score: num(row.written_score),
      interview_score: num(row.interview_score),
      comp_score: num(row.comp_score),
      is_deleted: 0,
      create_time: now,
      create_by: userId,
    });

    if (body.shortcoming) {
      // 大学这张表的备注列是 analysis
      await trx(G)
        .where({ id: body.scoreId })
        .update({ analysis: mergeRemark(row.analysis ?? row.remark, body.shortcoming), update_time: now, update_by: userId });
    }

    await trx.commit();
  } catch (e) {
    await trx.rollback();
    throw e;
  }

  await insertUniRepeat({
    stage: STAGE,
    studentId: String(stu.id),
    studentNo: String(stu.student_no ?? ''),
    studentName: String(stu.student_name ?? ''),
    fromClassId: (stu.class_id as string) ?? null,
    fromClassName,
    fromStageCode,
    toClassId: body.targetClassId,
    toClassName: String(toCls.class_name ?? ''),
    toStageCode,
    repeatReason: reason,
    repeatTime,
    repeatCount: nextCount,
    examName: String(row.exam_name ?? '') || null,
    writtenScore: num(row.written_score),
    interviewScore: num(row.interview_score),
    compScore: num(row.comp_score),
    operatorId: userId,
  });

  return {
    repeatCount: nextCount,
    fromClassName,
    toClassName: String(toCls.class_name ?? ''),
    toStageName: TEACHING_STAGE_NAME[STAGE],
    notified: !!toCls.head_teacher_id,
  };
}
