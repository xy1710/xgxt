/**
 * 成绩仓储 · 初高（sms_class_jh）· 表 t_class_exam_score
 *
 * 特点：字段全部带 `score_` 前缀；没有 exam_name（要 join t_class_exam）；
 *      公式 = 各项**直接求和**，再按「总分 ≥ 满分 × 0.6」自动判定通过。
 */

import { randomUUID } from 'crypto';
import { db } from '../../class-jh/utils/db';
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
import { tbl, tblIns, phaseCodeCol } from '../shared/uniTable';
import {
  CLASS_STATUS_GRADUATED,
  composeRepeatReason,
  insertUniRepeat,
  mergeRemark,
  repeatTimeOf,
} from './repeatRecord';

const S = 't_class_exam_score';
const E = 't_class_exam';
const STU = 't_class_student';
const CLS = 't_class_info';
const RPT = 't_class_repeat';
const STAGE = 'jh' as const;
const DB = 'sms_class_jh';

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

/** 该场考试的满分合计（来自 content_full_score 这个 JSON 对象） */
async function fullTotalOf(examId: string): Promise<number> {
  const e = (await tbl(db, 'sms_class_jh', E, STAGE).where({ id: examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!e?.content_full_score) return 0;
  try {
    const obj = JSON.parse(String(e.content_full_score));
    return Object.values(obj as Record<string, number>).reduce((a, b) => a + Number(b || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * 考试 id → 考试名 + 考试所属班级名
 *
 * ★ 2026-10-19：原来只取 exam_name，列表的「班级」列恒为 null（显示「—」）。
 *   末班要在列表上直接判断「从哪个班转走」，班级名必须有值 → 顺手补上。
 */
async function examNames(ids: string[]): Promise<Map<string, { examName: string; className: string | null }>> {
  const m = new Map<string, { examName: string; className: string | null }>();
  if (!ids.length) return m;
  const rows = (await tbl(db, 'sms_class_jh', E, STAGE)
    .whereIn('id', ids)
    .select('id', 'exam_name', 'class_name')) as Array<Record<string, any>>;
  for (const r of rows) {
    m.set(String(r.id), {
      examName: String(r.exam_name ?? ''),
      className: (r.class_name as string) ?? null,
    });
  }
  return m;
}

async function mapRow(
  r: Record<string, any>,
  nameMap: Map<string, { examName: string; className: string | null }>,
): Promise<ScoreRow> {
  const total = num(r.score_total);
  const meta = nameMap.get(String(r.exam_id));
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '初高部',
    examId: String(r.exam_id),
    examName: meta?.examName ?? '',
    examDate: r.exam_date ? String(r.exam_date).slice(0, 10) : null,
    classId: (r.class_id as string) ?? null,
    /* ★ 原来写死 null → 列表「班级」列恒为空（筛选却按 class_id 有值，所以能搜到） */
    className: (r.class_name as string) || null,
    studentId: String(r.student_id),
    studentNo: (r.student_no as string) ?? null,
    studentName: (r.student_name as string) ?? null,
    writtenScore: num(r.score_written),
    machineScore: num(r.score_machine),
    interviewScore: num(r.score_interview),
    otherScore: num(r.score_other),
    writtenAvg: null, // 初高不算笔试均分
    totalScore: total,
    examResult: r.exam_result === null || r.exam_result === undefined ? null : Number(r.exam_result),
    examResultName: EXAM_RESULT_NAME[Number(r.exam_result)] ?? '—',
    remark: (r.remark as string) ?? null,
  };
}

export async function list(q: ScoreListQuery): Promise<ScoreRow[]> {
  const qb = tbl(db, DB, S, STAGE).where('is_deleted', 0);
  if (q.examId) qb.andWhere('exam_id', q.examId);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.studentId) qb.andWhere('student_id', q.studentId);
  if (q.keyword) qb.andWhere('student_name', 'like', `%${q.keyword}%`);
  const rows = (await qb.orderBy('student_no')) as Array<Record<string, any>>;
  const nameMap = await examNames([...new Set(rows.map((r) => String(r.exam_id)))]);
  return Promise.all(rows.map((r) => mapRow(r, nameMap)));
}

export async function entry(examId: string, classId: string): Promise<ScoreEntry> {
  const exam = (await tbl(db, 'sms_class_jh', E, STAGE).where({ id: examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  const clsId = classId || String(exam.class_id);
  const students = (await tbl(db, 'sms_class_jh', STU, STAGE).where({ class_id: clsId, is_deleted: 0 }).orderBy('student_no')) as Array<
    Record<string, any>
  >;
  const scores = (await tbl(db, DB, S, STAGE).where({ exam_id: examId, is_deleted: 0 })) as Array<Record<string, any>>;
  const smap = new Map(scores.map((s) => [String(s.student_id), s]));
  const fullTotal = await fullTotalOf(examId);

  const rows: ScoreEntryRow[] = students.map((st) => {
    const s = smap.get(String(st.id));
    return {
      studentId: String(st.id),
      studentNo: (st.student_no as string) ?? null,
      studentName: (st.student_name as string) ?? null,
      scoreId: s ? String(s.id) : null,
      writtenScore: num(s?.score_written),
      machineScore: num(s?.score_machine),
      interviewScore: num(s?.score_interview),
      otherScore: num(s?.score_other),
      writtenAvg: null,
      totalScore: num(s?.score_total),
      examResult: s?.exam_result === null || s?.exam_result === undefined ? null : Number(s.exam_result),
      remark: (s?.remark as string) ?? null,
    };
  });

  return {
    stage: STAGE,
    stageName: '初高部',
    examId,
    examName: String(exam.exam_name ?? ''),
    examDate: exam.exam_date ? String(exam.exam_date).slice(0, 10) : null,
    classId: clsId,
    className: String(exam.class_name ?? ''),
    fullTotal,
    hasWrittenAvg: false,
    rows,
  };
}

/** ★ 各分数项的本场满分（初高存在 content_full_score 这个 JSON 里） */
const FIELD_OF_CONTENT: Record<number, string> = { 1: 'written', 2: 'machine', 3: 'interview', 4: 'other' };
export async function contentFull(examId: string): Promise<Record<string, number>> {
  const e = (await tbl(db, 'sms_class_jh', E, STAGE).where({ id: examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!e?.content_full_score) return {};
  try {
    const obj = JSON.parse(String(e.content_full_score)) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [t, v] of Object.entries(obj)) {
      const f = FIELD_OF_CONTENT[Number(t)];
      if (f && v !== null && v !== undefined) out[f] = Number(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function save(body: ScoreSaveBody, userId: string) {
  const exam = (await tbl(db, 'sms_class_jh', E, STAGE).where({ id: body.examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  const fullTotal = await fullTotalOf(body.examId);
  const now = new Date();
  let saved = 0;

  // ⚠️ t_class_exam_score 的 student_no / student_name 是 **NOT NULL** ——
  //    必须先查学生补上，否则插入直接报 `Column 'student_name' cannot be null`。
  const stuIds = body.rows.map((r) => r.studentId);
  const stuRows = (await tbl(db, 'sms_class_jh', STU, STAGE).whereIn('id', stuIds).where('is_deleted', 0)) as Array<
    Record<string, any>
  >;
  const stuMap = new Map(stuRows.map((s) => [String(s.id), s]));

  for (const r of body.rows) {
    const vals = {
      written: r.writtenScore ?? null,
      machine: r.machineScore ?? null,
      interview: r.interviewScore ?? null,
      other: r.otherScore ?? null,
    };
    const { totalScore, examResult } = await calcScores(STAGE, vals, fullTotal);

    const existed = (await tbl(db, DB, S, STAGE)
      .where({ exam_id: body.examId, student_id: r.studentId, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const payload = {
      score_written: vals.written,
      score_machine: vals.machine,
      score_interview: vals.interview,
      score_other: vals.other,
      score_total: totalScore,
      exam_result: examResult,
      is_passed: examResult === null ? null : examResult === 1 ? 1 : 0,
      remark: r.remark ?? null,
      update_time: now,
      update_by: userId,
    };

    if (existed) {
      await tbl(db, DB, S, STAGE).where({ id: existed.id }).update(payload);
    } else {
      const stu = stuMap.get(r.studentId);
      // ★ 必须用 tblIns：统一表 edu_stage NOT NULL 无默认
      await tblIns(db, DB, S, STAGE, {
        id: randomUUID(),
        exam_id: body.examId,
        exam_type: exam.exam_type,
        exam_date: exam.exam_date,
        class_id: exam.class_id,
        class_name: (exam.class_name as string) ?? null,
        student_id: r.studentId,
        student_no: (stu?.student_no as string) ?? '',
        student_name: (stu?.student_name as string) ?? '',
        score_teacher_id: userId,
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
 * ★ 只改传了的字段。备注列是内联编辑的，只传 remark 时**绝不重算分数**——
 *   浮点权重来回乘除会把 85 写成 84.999999，列表上就是 85 变 84.99。
 * ★ 2026-10-19：结果允许老师手改（通过 / 未通过）——
 *   传了 examResult 就以老师选的为准（不再按满分比例重判）；
 *   没传才用公式判出来的结果。老师只改结果不动分数时也走这里。
 */
export async function updateOne(body: ScoreUpdateBody, userId: string) {
  const row = (await db(S).where({ id: body.id, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!row) throw new Error('成绩记录不存在或已被删除');

  const payload: Record<string, any> = { update_time: new Date(), update_by: userId };

  const touched =
    body.writtenScore !== undefined ||
    body.machineScore !== undefined ||
    body.interviewScore !== undefined ||
    body.otherScore !== undefined;

  /** 结果落库：同时维护 is_passed（老表里两列是配套的） */
  const setResult = (v: number | null) => {
    payload.exam_result = v;
    payload.is_passed = v === null ? null : v === 1 ? 1 : 0;
  };

  if (touched) {
    // 没传的分数项按**原值**参与计算，而不是当 0
    const vals = {
      written: body.writtenScore !== undefined ? body.writtenScore : num(row.score_written),
      machine: body.machineScore !== undefined ? body.machineScore : num(row.score_machine),
      interview: body.interviewScore !== undefined ? body.interviewScore : num(row.score_interview),
      other: body.otherScore !== undefined ? body.otherScore : num(row.score_other),
    };
    const fullTotal = await fullTotalOf(String(row.exam_id));
    const { totalScore, examResult } = await calcScores(STAGE, vals, fullTotal);
    payload.score_written = vals.written;
    payload.score_machine = vals.machine;
    payload.score_interview = vals.interview;
    payload.score_other = vals.other;
    payload.score_total = totalScore;
    // 老师手选的结果优先；没选才用公式按满分比例判出来的
    setResult(body.examResult !== undefined ? body.examResult : examResult);
  } else if (body.examResult !== undefined) {
    // 只改结果、不动分数
    setResult(body.examResult);
  }

  if (body.remark !== undefined) payload.remark = body.remark;

  await db(S).where({ id: body.id }).update(payload);
  return { updated: 1 };
}

/* ============================================================
 * 末班（列表「末班」）
 * ============================================================
 * 【一末班要做 4 件事】
 *   ① 学生主档：class_id / class_name / stage 改成目标班，repeat_count +1
 *   ② 末班记录：本库 t_class_repeat + 统一表 t_uni_repeat（双写，见 repeatRecord.ts）
 *   ③ 成绩备注：把「学员不足说明」并进去（要求：同步写入成绩备注）
 *   ④ 成绩结果：保持 2「未通过」不变（末班的前置条件就是它）
 */
export async function repeat(body: ScoreRepeatBody, userId: string): Promise<ScoreRepeatResult> {
  if (body.targetStage !== STAGE) throw new Error('初高学生只能末班到初高班级');

  const row = (await db(S).where({ id: body.scoreId, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!row) throw new Error('成绩记录不存在或已被删除');
  if (Number(row.exam_result) !== 2) throw new Error('只有结果为「未通过」的学生才能执行末班');

  const stu = (await tbl(db, 'sms_class_jh', STU, STAGE)
    .where({ id: String(row.student_id), is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  if (!stu) throw new Error('学生不存在或已被删除');
  // ★ 防重复末班：末班成功后学生已经转走，再点同一条成绩就不该再动一次
  if (String(stu.class_id ?? '') !== String(row.class_id ?? '')) {
    throw new Error('该生已不在本场考试所在班级（可能已末班过），不能重复末班');
  }

  const toCls = (await tbl(db, 'sms_class_jh', CLS, STAGE)
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
  const toStageCode = toCls.stage === null || toCls.stage === undefined ? null : Number(toCls.stage);

  const trx = await db.transaction();
  try {
    // ① 学生主档
    await tbl(trx as any, 'sms_class_jh', STU, STAGE)
      .where({ id: String(stu.id) })
      .update({
        class_id: body.targetClassId,
        class_name: String(toCls.class_name ?? ''),
        [phaseCodeCol()]: toStageCode,
        repeat_count: nextCount,
        update_time: now,
        update_by: userId,
      });

    // ② 末班记录（老表）
    await trx(RPT).insert({
      id: randomUUID(),
      student_id: String(stu.id),
      student_no: String(stu.student_no ?? ''),
      student_name: String(stu.student_name ?? ''),
      from_class_id: (stu.class_id as string) ?? null,
      from_class_name: fromClassName,
      from_stage: stu.stage === null || stu.stage === undefined ? null : Number(stu.stage),
      to_class_id: body.targetClassId,
      to_class_name: String(toCls.class_name ?? ''),
      to_stage: toStageCode,
      repeat_reason: reason,
      repeat_time: repeatTime,
      repeat_count: nextCount,
      is_deleted: 0,
      create_time: now,
      create_by: userId,
    });

    // ③ 成绩备注
    if (body.shortcoming) {
      await trx(S)
        .where({ id: body.scoreId })
        .update({ remark: mergeRemark(row.remark, body.shortcoming), update_time: now, update_by: userId });
    }

    await trx.commit();
  } catch (e) {
    await trx.rollback();
    throw e;
  }

  // ④ 统一表（跨库，不进上面的事务；失败只影响切读开关打开后的可见性，故单独提示）
  await insertUniRepeat({
    stage: STAGE,
    studentId: String(stu.id),
    studentNo: String(stu.student_no ?? ''),
    studentName: String(stu.student_name ?? ''),
    fromClassId: (stu.class_id as string) ?? null,
    fromClassName,
    fromStageCode: stu.stage === null || stu.stage === undefined ? null : Number(stu.stage),
    toClassId: body.targetClassId,
    toClassName: String(toCls.class_name ?? ''),
    toStageCode,
    repeatReason: reason,
    repeatTime,
    repeatCount: nextCount,
    examName: String(row.exam_name ?? '') || null,
    compScore: num(row.score_total),
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
