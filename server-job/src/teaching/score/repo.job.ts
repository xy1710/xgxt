/**
 * 成绩仓储 · 实训（sms_job）· 表 t_job_exam_score
 *
 * 特点：字段名与另两套又不同（paper_score / written_avg / total_score）；
 *      公式 = **两次加权**：笔试均分 = 卷面×50% + 机试×50%，
 *                        综合 = 笔试均分×50% + 面试×50%（缺项 → 整项留空）。
 *      考试支持多班，所以「录入表」要指定班级。
 */

import { randomUUID } from 'crypto';
import { db } from '../../utils/db';
import { db as classDb } from '../../class/db';
import { db as jhDb } from '../../class-jh/utils/db';
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
import { tbl } from '../shared/uniTable';
import {
  CLASS_STATUS_GRADUATED,
  composeRepeatReason,
  insertUniRepeat,
  mergeRemark,
  repeatTimeOf,
} from './repeatRecord';

const S = 't_job_exam_score';
const E = 't_job_exam';
const CS = 't_job_class_student';
const CLS = 't_job_class';
const STU = 't_student_base';
const STAGE = 'job' as const;

/** 花名册：在班 / 已离班 */
const CS_IN = 1;
const CS_LEFT = 2;
/** 离班方式 2 = 末班转出；入班方式 3 = 末班转入（见 shared-types/enums.ts） */
const LEAVE_TYPE_REPEAT_OUT = 2;
const JOIN_TYPE_REPEAT_IN = 3;
/** 实训学生的「流失」状态（shared-types 里 StudentStatus 口径） */
const STATUS_LOST = 11;

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);

function mapRow(r: Record<string, any>): ScoreRow {
  return {
    id: String(r.id),
    stage: STAGE,
    stageName: '实训',
    examId: String(r.exam_id ?? ''),
    examName: String(r.exam_name ?? ''),
    examDate: null,
    classId: (r.class_id as string) ?? null,
    className: (r.class_name as string) ?? null,
    studentId: String(r.student_id),
    studentNo: (r.student_no as string) ?? null,
    studentName: (r.student_name as string) ?? null,
    writtenScore: num(r.paper_score),
    machineScore: num(r.machine_score),
    interviewScore: num(r.interview_score),
    otherScore: null,
    writtenAvg: num(r.written_avg),
    totalScore: num(r.total_score),
    examResult: r.exam_result === null || r.exam_result === undefined ? null : Number(r.exam_result),
    examResultName: EXAM_RESULT_NAME[Number(r.exam_result)] ?? '—',
    remark: (r.remark as string) ?? null,
  };
}

/** 当天在班学生（花名册 status=1） */
async function roster(classId: string) {
  return (await db(`${CS} as cs`)
    .leftJoin(`${STU} as s`, 'cs.student_id', 's.id')
    .where('cs.class_id', classId)
    .andWhere('cs.status', 1)
    .andWhere('cs.is_deleted', 0)
    .select('cs.student_id', 'cs.student_no', 'cs.student_name')
    .orderBy('cs.student_no', 'asc')) as Array<Record<string, any>>;
}

export async function list(q: ScoreListQuery): Promise<ScoreRow[]> {
  const qb = db(S).where('is_deleted', 0);
  if (q.examId) qb.andWhere('exam_id', q.examId);
  if (q.classId) qb.andWhere('class_id', q.classId);
  if (q.studentId) qb.andWhere('student_id', q.studentId);
  if (q.keyword) qb.andWhere('student_name', 'like', `%${q.keyword}%`);
  const rows = (await qb.orderBy('student_no')) as Array<Record<string, any>>;
  return rows.map(mapRow);
}

export async function entry(examId: string, classId: string): Promise<ScoreEntry> {
  const exam = (await tbl(db, 'sms_job', E, STAGE).where({ id: examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  // 实训是多班：优先用传入的班；没传就取第一个班
  const clsId = classId || String(exam.class_ids ?? '').split(',')[0] || '';
  if (!clsId) throw new Error('该考试没有班级');

  const students = await roster(clsId);
  const scores = (await db(S).where({ exam_id: examId, class_id: clsId, is_deleted: 0 })) as Array<
    Record<string, any>
  >;
  const smap = new Map(scores.map((s) => [String(s.student_id), s]));

  const rows: ScoreEntryRow[] = students.map((st) => {
    const s = smap.get(String(st.student_id));
    return {
      studentId: String(st.student_id),
      studentNo: (st.student_no as string) ?? null,
      studentName: (st.student_name as string) ?? null,
      scoreId: s ? String(s.id) : null,
      writtenScore: num(s?.paper_score),
      machineScore: num(s?.machine_score),
      interviewScore: num(s?.interview_score),
      otherScore: null,
      writtenAvg: num(s?.written_avg),
      totalScore: num(s?.total_score),
      examResult: s?.exam_result === null || s?.exam_result === undefined ? null : Number(s.exam_result),
      remark: (s?.remark as string) ?? null,
    };
  });

  const names = String(exam.class_names ?? '').split('、');
  const idx = String(exam.class_ids ?? '').split(',').indexOf(clsId);

  return {
    stage: STAGE,
    stageName: '实训',
    examId,
    examName: String(exam.exam_name ?? ''),
    examDate: null,
    classId: clsId,
    className: names[idx] || names[0] || '',
    fullTotal: 0, // 实训不按满分比例判定通过
    hasWrittenAvg: true, // ★ 只有实训有「笔试均分」这一列
    rows,
  };
}

export async function save(body: ScoreSaveBody, userId: string) {
  const exam = (await tbl(db, 'sms_job', E, STAGE).where({ id: body.examId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!exam) throw new Error('考试不存在');
  const now = new Date();
  let saved = 0;

  for (const r of body.rows) {
    const vals = {
      written: r.writtenScore ?? null,
      machine: r.machineScore ?? null,
      interview: r.interviewScore ?? null,
      other: null,
    };
    const { writtenAvg, totalScore, examResult } = await calcScores(STAGE, vals, 0);
    // ★ 实训 judgeMode='action'：默认 null「未判断」，由「标末班」动作置 2（可撤销回 null）
    const finalResult = r.examResult ?? examResult ?? null;

    const stu = (await db(`${CS} as cs`)
      .leftJoin(`${STU} as s`, 'cs.student_id', 's.id')
      .where('cs.student_id', r.studentId)
      .andWhere('cs.is_deleted', 0)
      .select('cs.student_no', 'cs.student_name', 'cs.class_id', 'cs.class_name')
      .first()) as Record<string, any> | undefined;

    const existed = (await db(S)
      .where({ exam_id: body.examId, student_id: r.studentId, is_deleted: 0 })
      .first()) as Record<string, any> | undefined;

    const payload = {
      paper_score: vals.written,
      machine_score: vals.machine,
      written_avg: writtenAvg,
      interview_score: vals.interview,
      total_score: totalScore,
      exam_result: finalResult,
      remark: r.remark ?? null,
      entry_by: userId,
      entry_time: now,
      update_time: now,
      update_by: userId,
    };

    if (existed) {
      await db(S).where({ id: existed.id }).update(payload);
    } else {
      await db(S).insert({
        id: randomUUID(),
        exam_id: body.examId,
        exam_name: exam.exam_name,
        student_id: r.studentId,
        student_no: stu?.student_no ?? null,
        student_name: stu?.student_name ?? null,
        class_id: stu?.class_id ?? null,
        class_name: stu?.class_name ?? null,
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
 * ★ 实训 judgeMode='action'：exam_result 默认 null「未判断」，
 *   由「末班」动作置 2。改分**不会**顺手改结果 ——
 *   否则老师一保存分数，学生就自动被判未通过，末班按钮直接可点，容易误操作。
 *   只有显式传 examResult 才写（撤销末班时也走这里传 null）。
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

  if (touched) {
    const vals = {
      written: body.writtenScore !== undefined ? body.writtenScore : num(row.paper_score),
      machine: body.machineScore !== undefined ? body.machineScore : num(row.machine_score),
      interview: body.interviewScore !== undefined ? body.interviewScore : num(row.interview_score),
      other: null,
    };
    const { writtenAvg, totalScore } = await calcScores(STAGE, vals, 0);
    payload.paper_score = vals.written;
    payload.machine_score = vals.machine;
    payload.written_avg = writtenAvg;
    payload.interview_score = vals.interview;
    payload.total_score = totalScore;
  }

  if (body.examResult !== undefined) payload.exam_result = body.examResult;
  if (body.remark !== undefined) payload.remark = body.remark;

  await db(S).where({ id: body.id }).update(payload);
  return { updated: 1 };
}

/* ============================================================
 * 末班（列表「末班」）
 * ============================================================
 * 【实训是三学段里唯一允许跨学段末班的】
 *   初高只能转初高、大学只能转大学，实训可以转任意学段（不合格退回重修）。
 *   目标落在别的学段时，光改 class_id 没用 —— 那个班在**另一个库**的另一张学生表里，
 *   所以要在目标学段**新建一条学生档案**（复制学号/姓名/性别/联系方式等基础信息），
 *   同时把实训侧的花名册改成「末班转出」、主档标「流失」。
 *
 * 【为什么先写实训事务、再建目标档案、最后写统一表】
 *   三件事分属三个数据库连接，knex 事务只绑一个连接 → 做不到原子性。
 *   顺序按「回滚代价」排：先把本库的离班+计数落定，再建目标档案，
 *   最后写跨库的统一表（失败只影响切读开关打开后的可见性）。
 */
export async function repeat(body: ScoreRepeatBody, userId: string): Promise<ScoreRepeatResult> {
  const row = (await db(S).where({ id: body.scoreId, is_deleted: 0 }).first()) as Record<string, any> | undefined;
  if (!row) throw new Error('成绩记录不存在或已被删除');
  if (Number(row.exam_result) !== 2) throw new Error('只有结果为「未通过」的学生才能执行末班');

  const stu = (await db(STU).where({ id: String(row.student_id), is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!stu) throw new Error('学生不存在或已被删除');

  // 当前所在班以花名册为准（主档的 class_id 是冗余快照）
  const cur = (await db(CS)
    .where({ student_id: String(stu.id), status: CS_IN, is_deleted: 0 })
    .first()) as Record<string, any> | undefined;
  // ★ 防重复末班：上一次末班已经把这条花名册改成「已离班」，
  //   再点同一条成绩会因为找不到在班记录而被拦住。
  if (!cur || String(cur.class_id) !== String(row.class_id ?? '')) {
    throw new Error('该生已不在本场考试所在班级（可能已末班过），不能重复末班');
  }
  const fromClassId = (cur?.class_id as string) ?? ((stu.class_id as string) ?? null);
  const fromClassName = (cur?.class_name as string) ?? ((stu.class_name as string) ?? null);

  // ---- 目标班级（按学段去各自的库查）----
  const target = await loadTargetClass(body.targetStage, body.targetClassId);
  if (Number(target.row.class_status) === CLASS_STATUS_GRADUATED) {
    throw new Error('目标班级已结业，不能接收末班学生');
  }
  if (fromClassId && fromClassId === body.targetClassId) throw new Error('目标班级就是该生当前所在班，无需末班');

  const now = new Date();
  const repeatTime = repeatTimeOf(body.repeatDate);
  const nextCount = Number(stu.repeat_count ?? 0) + 1;
  const reason = composeRepeatReason(body.repeatReason, body.shortcoming);
  const toClassName = String(target.row.class_name ?? '');
  const toStageCode = target.row.stage === null || target.row.stage === undefined ? null : Number(target.row.stage);

  const trx = await db.transaction();
  try {
    // ① 原班花名册：末班转出
    if (fromClassId) {
      await trx(CS)
        .where({ class_id: fromClassId, student_id: String(stu.id), status: CS_IN, is_deleted: 0 })
        .update({
          status: CS_LEFT,
          leave_date: repeatTime,
          leave_type: LEAVE_TYPE_REPEAT_OUT,
          leave_reason: reason.slice(0, 200),
          update_time: now,
          update_by: userId,
        });
    }

    // ② 目标班花名册：末班转入（同一学段内才有花名册行）
    if (body.targetStage === STAGE) {
      const already = (await trx(CS)
        .where({ class_id: body.targetClassId, student_id: String(stu.id), status: CS_IN, is_deleted: 0 })
        .first()) as Record<string, any> | undefined;
      if (!already) {
        await trx(CS).insert({
          id: randomUUID(),
          class_id: body.targetClassId,
          class_name: toClassName,
          student_id: String(stu.id),
          student_no: (stu.student_no as string) ?? null,
          student_name: (stu.student_name as string) ?? null,
          join_date: repeatTime,
          join_type: JOIN_TYPE_REPEAT_IN,
          status: CS_IN,
          remark: reason.slice(0, 200),
          is_deleted: 0,
          create_time: now,
          create_by: userId,
        });
      }
    }

    // ③ 实训主档：同段转班 → 换班；跨段 → 标流失（人已不在实训）
    const patch: Record<string, any> = {
      repeat_count: nextCount,
      update_time: now,
      update_by: userId,
    };
    if (body.targetStage === STAGE) {
      patch.class_id = body.targetClassId;
      patch.class_name = toClassName;
      patch.head_teacher_id = target.row.head_teacher_id ?? null;
      patch.head_teacher_name = target.row.head_teacher_name ?? null;
      patch.teacher_id = target.row.teacher_id ?? null;
      patch.teacher_name = target.row.teacher_name ?? null;
      patch.assistant_id = target.row.assistant_id ?? null;
      patch.assistant_name = target.row.assistant_name ?? null;
    } else {
      patch.student_status = STATUS_LOST;
    }
    await trx(STU).where({ id: String(stu.id) }).update(patch);

    // ④ 两个班的人数重算（原班必算；目标班只在同段时有意义）
    await recountClass(trx, fromClassId);
    if (body.targetStage === STAGE) await recountClass(trx, body.targetClassId);

    await trx.commit();
  } catch (e) {
    await trx.rollback();
    throw e;
  }

  // ⑤ 跨学段：在目标学段建档案，学生才会真的出现在那个班的花名册里
  if (body.targetStage !== STAGE) {
    await createStudentInStage(body.targetStage, stu, target.row, toStageCode, nextCount, userId);
  }

  // ⑥ 成绩备注（同步写入学员不足说明）
  if (body.shortcoming) {
    await db(S)
      .where({ id: body.scoreId })
      .update({ remark: mergeRemark(row.remark, body.shortcoming), update_time: now, update_by: userId });
  }

  // ⑦ 统一表
  await insertUniRepeat({
    stage: STAGE,
    studentId: String(stu.id),
    studentNo: String(stu.student_no ?? ''),
    studentName: String(stu.student_name ?? ''),
    fromClassId,
    fromClassName,
    fromStageCode: stu.stage === null || stu.stage === undefined ? null : Number(stu.stage),
    toClassId: body.targetClassId,
    toClassName,
    toStageCode,
    repeatReason: reason,
    repeatTime,
    repeatCount: nextCount,
    examName: String(row.exam_name ?? '') || null,
    compScore: num(row.total_score),
    operatorId: userId,
  });

  return {
    repeatCount: nextCount,
    fromClassName,
    toClassName,
    toStageName: TEACHING_STAGE_NAME[body.targetStage],
    notified: !!target.row.head_teacher_id,
  };
}

/** 按目标学段取目标班级（三个库三张表） */
async function loadTargetClass(
  stage: 'jh' | 'class' | 'job',
  classId: string,
): Promise<{ row: Record<string, any> }> {
  const table = stage === 'job' ? CLS : 't_class_info';
  const conn = stage === 'job' ? db : stage === 'class' ? classDb : jhDb;
  const row = (await conn(table).where({ id: classId, is_deleted: 0 }).first()) as
    | Record<string, any>
    | undefined;
  if (!row) throw new Error('目标班级不存在或已被删除');
  return { row };
}

/** 重算某班在班人数（花名册 status=1） */
async function recountClass(trx: any, classId: string | null): Promise<void> {
  if (!classId) return;
  const [{ cnt }] = (await trx(CS).where({ class_id: classId, status: CS_IN, is_deleted: 0 }).count({
    cnt: '*',
  })) as Array<{ cnt: number }>;
  await trx(CLS).where({ id: classId }).update({ student_count: Number(cnt), update_time: new Date() });
}

/**
 * 跨学段：在目标学段学生表新建一条档案
 *
 * ⚠️ 三张学生表的列名**各不相同**（同一件事三个叫法），这里只映射已验证存在的列：
 *      身份证   实训 id_card     → 初高 id_card_no  → 大学 id_card
 *      籍贯     实训 native_place → 初高 native_place → 大学 origin
 *      部门     初高 dept_code=1 / 大学 dept_code=2（NOT NULL，不给默认值会插不进）
 *    大学那张表还有 source_system / sync_status 两个 NOT NULL 列，
 *    必须显式写 'manual' / 2，否则报 `Field 'sync_status' doesn't have a default value`。
 */
async function createStudentInStage(
  stage: 'jh' | 'class',
  src: Record<string, any>,
  target: Record<string, any>,
  toStageCode: number | null,
  repeatCount: number,
  userId: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const common = {
    id,
    create_time: now,
    create_by: userId,
    is_deleted: 0,
    student_no: String(src.student_no ?? ''),
    student_name: String(src.student_name ?? ''),
    gender: Number(src.gender ?? 1),
    student_status: 5, // 正式在读
    stage: toStageCode,
    birth_date: src.birth_date ?? null,
    phone: src.phone ?? null,
    parent_phone: src.parent_phone ?? null,
    education: src.education ?? null,
    enroll_date: src.enroll_date ?? null,
    class_id: target.id,
    class_name: String(target.class_name ?? ''),
    head_teacher_id: target.head_teacher_id ?? null,
    head_teacher_name: target.head_teacher_name ?? null,
    teacher_id: target.teacher_id ?? null,
    teacher_name: target.teacher_name ?? null,
    assistant_id: target.assistant_id ?? null,
    assistant_name: target.assistant_name ?? null,
    repeat_count: repeatCount,
    remark: src.remark ?? null,
  };

  if (stage === 'jh') {
    await jhDb('t_class_student').insert({
      ...common,
      dept_code: 1,
      id_card_no: src.id_card ?? null,
      native_place: src.native_place ?? null,
      graduate_school: src.graduate_school ?? null,
      home_address: src.home_address ?? null,
    });
  } else {
    await classDb('t_class_student').insert({
      ...common,
      source_system: 'manual',
      sync_status: 2,
      dept_code: 2,
      id_card: src.id_card ?? null,
      origin: src.native_place ?? null,
      graduate_school: src.graduate_school ?? null,
      home_address: src.home_address ?? null,
    });
  }
  return id;
}
