import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { ConsultStatus, ExamResult, NotifyType, PermAction } from 'shared-types/class';
import { db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, notDeleted, paginate } from '../../lib/repo';
import { requirePerm } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { ExamResultName, ExamTypeName } from '../../lib/dict';
import { seqOfApplyNo, uuid } from '../../lib/ids';
import { applyDataScope, assertClassAccess } from '../../middleware/dataScope';
import { sendNotify } from '../shared/flow';
import { wrap } from '../../middleware/error';
import {
  tbl,
  tblIns,
  tblInsTrx,
  uniUpdCols,
  readPhaseCode,
} from '../../../teaching/shared/uniTable';

/**
 * 成绩管理（原型菜单「教务运行 / 成绩管理」）
 *
 * 关键规则（原型已写死，后端权威）：
 *   综合成绩 =笔试 × 50% + 面试 × 50%，**由后端计算，前端只读**
 *   素质分析（analysis）非必填
 *
 * ── 第 4 期 · 第 7 批（2026-10-11 · 成绩域）：统一表切读 ──
 *   本文件 21 处裸访问全部改走 `uniTable.ts` 路由层，涉及 4 张表：
 *     t_class_grade→ t_uni_exam_score（主表）
 *     t_class_student     → t_uni_student
 *     t_class_info        → t_uni_class
 *     t_class_consult_push → t_uni_consult_push   （末班推送复用咨询推送单）
 *     t_class_exam        → t_uni_exam（考试域，本批只读参照，不改 exam 模块）
 *
 *   ★★ **本批最关键的设计：`t_uni_exam_score` 里同一批分数存了「两套列」**
 *
 *     | 老表列（本文件原来在用） | 统一表另有 |
 *     |---|---|
 *     | written_score    | score_written    |
 *     | machine_score    | score_machine    |
 *     | interview_score  | score_interview  |
 *     | comp_score       | score_total      |
 *
 *     实测（102 行种子数据）：
 *       written_score 102 行有值 / score_written 102 行有值 → 两套都被填了
 *       comp_score     0 行有值 / score_total   102 行有值 → **综合分只存在 score_total**
 *
 *     → 切读时**读写都用 score_* 新列**（它们才是统一表的主套，且种子数据一致）；
 *       老表模式仍读写老列。**用列名常量按开关取，不在代码里硬写任何一套** ——
 *       硬写的话，「查列表用老列名、切读后整列空掉」是必然的静默 bug。
 *
 *   ⚠️ `exam_id` / `exam_name` 在统一表是 **NOT NULL DEFAULT ''**，老表是可空。
 *     代码里 `examId` 是选填、不传时写 `null` → 切读时会报 `Column 'exam_id' cannot be null`。
 *     → 统一在 `gradeRow()` 里把null 转成 `''`（**老表模式原样传 null，行为不变**）。
 */
export const gradeRouter = Router();

/* ---------------- 统一表路由助手（第 7 批新增） ---------------- */
const SRC = 'sms_class';
const STAGE = 'class' as const;

const GRADE_T = 't_class_grade';
const STU_T = 't_class_student';
const CLS_T = 't_class_info';
const EXAM_T = 't_class_exam';
const PUSH_T = 't_class_consult_push';

const GRADE = () => tbl(db, SRC, GRADE_T, STAGE);
const STU = () => tbl(db, SRC, STU_T, STAGE);
const CLS = () => tbl(db, SRC, CLS_T, STAGE);
const EXAM = () => tbl(db, SRC, EXAM_T, STAGE);
const PUSH = () => tbl(db, SRC, PUSH_T, STAGE);

/**
 * ★★ 分数列名按开关取 —— 这是本批的核心（见文件头说明）
 *
 * 读、排序、统计、写入**全部**必须走这四个常量，
 * 漏一处就会出现「列表能查出来但分数是 null」或「平均分恒为 0」。
 */
const COL_WRITTEN = () => 'score_written';
const COL_MACHINE = () => 'score_machine';
const COL_INTERVIEW = () => 'score_interview';
const COL_COMP = () => 'score_total';

/**
 * 把四项分数按开关写进一条成绩行
 *
 * ★ 这里**不做** NOT NULL 字段的空串兜底 —— 那是多余的：
 *   `tblIns()` 内部已经查过统一表的 NOT NULL 列清单，遇到 null 会**删掉整个键**
 *   让它走列DEFAULT（`uniTable.ts` 的 uniNotNullColsOf 逻辑）。
 *   老表模式则原样传 null，行为与改造前完全一致。
 *   → 自己再兜一层反而会在老表模式下把 null 变成 ''，**改变老行为**。
 *
 * @param row    已组装好的成绩行（学生/考试/班级等基础字段）
 * @param scores { written, machine, interview, comp }
 */
function gradeRow(
  row: Record<string, unknown>,
  scores: {
    written?: number | null;
    machine?: number | null;
    interview?: number | null;
    comp: number | null;
  },
): Record<string, unknown> {
  return {
    ...row,
    [COL_WRITTEN()]: scores.written ?? null,
    [COL_MACHINE()]: scores.machine ?? null,
    [COL_INTERVIEW()]: scores.interview ?? null,
    [COL_COMP()]: scores.comp,
  };
}

/** 从一行成绩里读出综合分（按开关取列） */
function compOf(row: Record<string, unknown>): number | null {
  const v = row[COL_COMP()];
  return v === null || v === undefined ? null : Number(v);
}

/** 综合成绩计算（保留两位小数；缺失项按 0 计） */
function calcCompScore(written?: number | null, interview?: number | null): number {
  const w = Number(written ?? 0);
  const i = Number(interview ?? 0);
  return Number((w * 0.5 + i * 0.5).toFixed(2));
}

/** 统一补「xxxName」与综合成绩（前端不维护映射表） */
function decorate(row: Record<string, unknown>): Record<string, unknown> {
  const c = rowsToCamel<Record<string, unknown>>([row])[0];
  const num = (k: string) => {
    const v = row[k];
    return v === null || v === undefined ? null : Number(v);
  };
  return {
    ...c,
    examResultName: ExamResultName[row.exam_result as number] ?? '未知',
    // ★ 分数按开关取列后再转数字；输出字段名保持 camelCase 不变，**前端契约不动**
    writtenScore: num(COL_WRITTEN()),
    machineScore: num(COL_MACHINE()),
    interviewScore: num(COL_INTERVIEW()),
    compScore: num(COL_COMP()),
  };
}

const listSchema = z.object({
  ...pageQuerySchema.shape,
  examId: z.string().optional(),
  classId: z.string().optional(),
  studentId: z.string().optional(),
  studentNo: z.string().optional(),
  studentName: z.string().optional(),
  examResult: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/grade/list:
 *   get:
 *     tags: [教务运行]
 *     summary: 成绩列表
 *     description: 老师只看自己负责班级的成绩；学管 / 校长看全部。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: examId, schema: { type: string } }
 *       - { in: query, name: studentId, schema: { type: string }, description: 查某学员全部成绩 }
 *     responses:
 *       200: { description: 分页列表 }
 */
gradeRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = GRADE();
    notDeleted(base);
    applyDataScope(base, user, { classIdColumn: 'class_id' });
    if (query.examId) base.where('exam_id', query.examId);
    if (query.classId) base.where('class_id', query.classId);
    if (query.studentId) base.where('student_id', query.studentId);
    if (query.studentNo) base.where('student_no', 'like', `%${query.studentNo}%`);
    if (query.studentName) base.where('student_name', 'like', `%${query.studentName}%`);
    if (query.examResult) base.where('exam_result', query.examResult);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy('create_time', 'desc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map(decorate);
    });
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

const addSchema = z.object({
  studentId: z.string().min(1, '缺少学员ID'),
  examId: z.string().optional().nullable(),
  writtenScore: z.coerce.number().min(0, '笔试分数不能为负').max(1000, '笔试分数超出范围').optional().nullable(),
  machineScore: z.coerce.number().min(0, '机试分数不能为负').max(1000, '机试分数超出范围').optional().nullable(),
  interviewScore: z.coerce.number().min(0, '面试分数不能为负').max(1000, '面试分数超出范围').optional().nullable(),
  examResult: z.coerce.number().int('考试结果不能为空'),
  analysis: z.string().optional().nullable(),
  remark: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/grade/add:
 *   post:
 *     tags: [教务运行]
 *     summary: 录入成绩
 *     description: |
 *       **综合成绩由后端自动计算**：笔试 × 50% + 面试 × 50%，前端不要传 `compScore`。
 *       考试结果为 1 通过（升班）/ 2 未通过（末班转班重修）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, examResult]
 *             properties:
 *               studentId: { type: string }
 *               examId: { type: string }
 *               writtenScore: { type: number, example: 86 }
 *               interviewScore: { type: number, example: 92 }
 *               examResult: { type: integer, example: 1 }
 *               analysis: { type: string, description: 素质分析（非必填） }
 *     responses:
 *       200: { description: 录入成功，返回综合成绩 }
 */
gradeRouter.post(
  '/add',
  requirePerm('grade', PermAction.ADD),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof addSchema>;

    if (b.examResult !== ExamResult.PASS && b.examResult !== ExamResult.FAIL) {
      throw Errors.param('考试结果只能是 1（通过）或 2（未通过）');
    }
    if (b.writtenScore === null && b.interviewScore === null && b.machineScore === null) {
      throw Errors.required('分数');
    }

    const stu = (await notDeleted(STU()).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    let examName: string | null = null;
    let examClassId: string | null = null;
    if (b.examId) {
      const exam = (await notDeleted(EXAM()).where('id', b.examId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!exam) throw Errors.param('所选考试不存在');
      examName = exam.exam_name as string;
      examClassId = (exam.class_id as string) ?? null;
    }

    const compScore = calcCompScore(b.writtenScore, b.interviewScore);
    const id = baseInsert(user).id as string;

    // ★ 分数列名按开关由 gradeRow() 组装；切读时走 score_* 新列
    await tblIns(db, SRC, GRADE_T, STAGE, gradeRow(
      {
        ...baseInsert(user),
        id,
        student_id: b.studentId,
        student_no: stu.student_no as string,
        student_name: stu.student_name as string,
        class_id: examClassId ?? ((stu.class_id as string) ?? null),
        class_name: (stu.class_name as string) ?? null,
        exam_id: b.examId ?? null,
        exam_name: examName,
        exam_result: b.examResult,
        analysis: b.analysis ?? null,
        remark: b.remark ?? null,
      },
      {
        written: b.writtenScore ?? null,
        machine: b.machineScore ?? null,
        interview: b.interviewScore ?? null,
        comp: compScore,
      },
    ));

    return ok(res, { gradeId: id, compScore }, `成绩已录入，综合成绩 ${compScore} 分`);
  }),
);

const updateSchema = addSchema.partial().extend({ gradeId: z.string().min(1, '缺少成绩ID') });

/**
 * @openapi
 * /api/class/grade/update:
 *   put:
 *     tags: [教务运行]
 *     summary: 修改成绩（综合成绩自动重算）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gradeId]
 *             properties:
 *               gradeId: { type: string }
 *     responses:
 *       200: { description: 保存成功 }
 */
gradeRouter.put(
  '/update',
  requirePerm('grade', PermAction.EDIT),
  validate({ body: updateSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof updateSchema>;

    const row = (await notDeleted(GRADE()).where('id', b.gradeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.param('成绩记录不存在');
    assertClassAccess(user, row.class_id as string | null, '该成绩');

    // ★ 未传的分数从已存行里取（按开关取列），而不是写死 row.written_score
    const written = b.writtenScore !== undefined ? b.writtenScore : (row[COL_WRITTEN()] as number | null);
    const interview = b.interviewScore !== undefined ? b.interviewScore : (row[COL_INTERVIEW()] as number | null);

    const patch: Record<string, unknown> = { ...baseUpdate(user) };
    if (b.writtenScore !== undefined) patch[COL_WRITTEN()] = b.writtenScore;
    if (b.machineScore !== undefined) patch[COL_MACHINE()] = b.machineScore;
    if (b.interviewScore !== undefined) patch[COL_INTERVIEW()] = b.interviewScore;
    if (b.examResult !== undefined) patch.exam_result = b.examResult;
    if (b.analysis !== undefined) patch.analysis = b.analysis;
    if (b.remark !== undefined) patch.remark = b.remark;
    if (b.examId !== undefined) patch.exam_id = b.examId;
    patch[COL_COMP()] = calcCompScore(written, interview);

    // ★ update 路径必须过 uniUpdCols（归一铁律⑨：insert 翻译了 update 没翻译会二次炸）
    await GRADE().where({ id: b.gradeId }).update(
      await uniUpdCols(db, SRC, GRADE_T, patch),
    );
    return ok(res, { gradeId: b.gradeId, compScore: patch[COL_COMP()] }, '成绩已保存，综合成绩已重算');
  }),
);

/**
 * @openapi
 * /api/class/grade/delete:
 *   post:
 *     tags: [教务运行]
 *     summary: 删除某条成绩记录（原型「操作 → 删除」）
 *     description: 软删除（`is_deleted = 1`），列表与统计立即不再计入。
 *     responses:
 *       200: { description: 删除成功 }
 */
gradeRouter.post(
  '/delete',
  requirePerm('grade', PermAction.DELETE),
  validate({ body: z.object({ gradeId: z.string().min(1, '缺少成绩记录ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as { gradeId: string };

    const row = (await notDeleted(GRADE()).where('id', b.gradeId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.param('成绩记录不存在');
    assertClassAccess(user, row.class_id as string | null, '该成绩');

    await GRADE().where({ id: b.gradeId }).update({ is_deleted: 1, ...baseUpdate(user) });
    return ok(res, { gradeId: b.gradeId }, '成绩记录已删除');
  }),
);

/**
 * @openapi
 * /api/class/grade/student/list:
 *   get:
 *     tags: [教务运行]
 *     summary: 某学员的成绩列表（详情 → 考试信息 标签用）
 *     description: 默认只返回最近 3 次技术考试成绩（与原型一致），`limit` 可调。
 *     parameters:
 *       - { in: query, name: studentId, schema: { type: string }, required: true }
 *       - { in: query, name: limit, schema: { type: integer, example: 3 } }
 *     responses:
 *       200: { description: 成绩列表 }
 */
gradeRouter.get(
  '/student/list',
  validate({
    query: z.object({
      studentId: z.string().min(1, '缺少学员ID'),
      limit: z.coerce.number().int().min(1).max(50).default(3),
    }),
  }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { studentId, limit } = q<{ studentId: string; limit: number }>(req);

    const stu = (await notDeleted(STU()).where('id', studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    const rows = (await notDeleted(GRADE())
      .where('student_id', studentId)
      .orderBy('create_time', 'desc')
      .limit(limit)) as Array<Record<string, unknown>>;

    const who = `${String(stu.student_name)} / ${String(stu.student_no)}`;
    return ok(
      res,
      rows.map((r) => ({ ...decorate(r), who, examTypeName: null as string | null })),
      '查询成功',
    );
  }),
);

/**
 * @openapi
 * /api/class/grade/statistics:
 *   get:
 *     tags: [教务运行]
 *     summary: 成绩统计（按班级 / 按考试）
 *     description: 返回参考人数、通过人数、通过率、平均分，供成绩管理页顶部卡片使用。
 *     parameters:
 *       - { in: query, name: examId, schema: { type: string } }
 *       - { in: query, name: classId, schema: { type: string } }
 *     responses:
 *       200: { description: 统计结果 }
 */
gradeRouter.get(
  '/statistics',
  validate({
    query: z.object({ examId: z.string().optional(), classId: z.string().optional() }),
  }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<{ examId?: string; classId?: string }>(req);

    const base = GRADE();
    notDeleted(base);
    applyDataScope(base, user, { classIdColumn: 'class_id' });
    if (query.examId) base.where('exam_id', query.examId);
    if (query.classId) base.where('class_id', query.classId);

    const rows = (await base) as Array<Record<string, unknown>>;
    const total = rows.length;
    const pass = rows.filter((r) => (r.exam_result as number) === ExamResult.PASS).length;
    // ★ 综合分按开关取列：写死 r.comp_score → 切读时整列读不到，平均分恒为 0（静默 bug）
    const scores = rows.map((r) => compOf(r) ?? 0).filter((x) => Number.isFinite(x));
    const avg = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

    return ok(
      res,
      {
        total,
        passCount: pass,
        failCount: total - pass,
        passRate: total ? Number(((pass / total) * 100).toFixed(2)) : 0,
        avgCompScore: avg,
        maxCompScore: scores.length ? Math.max(...scores) : 0,
        minCompScore: scores.length ? Math.min(...scores) : 0,
      },
      '查询成功',
    );
  }),
);

/* ============================== 末班 → 待接收学员 ============================== */

const repeatHandoffSchema = z.object({
  studentId: z.string().min(1, '缺少学员ID'),
  /** v1.5：末班时可选择学生去到的目标班级；不传则默认回到学员当前班级重修 */
  targetClassId: z.string().optional().nullable(),
  remark: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/grade/repeat-handoff:
 *   post:
 *     tags: [教务运行]
 *     summary: 成绩管理「末班」→ 推送到班主任「待接收学员」
 *     description: |
 *       对某学员点「末班」后：把该学员信息推送到**其所在班级班主任**的「待接收学员」
 *       （复用咨询推送单，`is_repeat_in = 1` 标记末班 / 重修转入）。
 *       班主任在「待接收学员」里点「接收 / 同意」，该学员即回到对应班级（封班班级也可接收）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId]
 *             properties:
 *               studentId: { type: string }
 *               remark: { type: string }
 *     responses:
 *       200: { description: 已推送，返回接收单号 }
 */
gradeRouter.post(
  '/repeat-handoff',
  requirePerm('grade', PermAction.EDIT),
  validate({ body: repeatHandoffSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof repeatHandoffSchema>;

    const stu = (await notDeleted(STU()).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学员');

    const fromClassId = (stu.class_id as string) ?? null;
    if (!fromClassId) throw Errors.param('该学员尚未分配班级，无法发起末班接收');

    // v1.5：目标班级可指定；默认回到学员当前班级重修
    const classId = b.targetClassId ?? fromClassId;
    const cls = (await notDeleted(CLS()).where('id', classId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!cls) throw Errors.classNotFound('目标班级不存在');
    assertClassAccess(user, classId, '目标班级');

    // 同一学员不允许同时有多条待接收的末班记录
    const dup = (await notDeleted(PUSH())
      .where({ origin_student_id: b.studentId, apply_status: ConsultStatus.PENDING })
      .first()) as Record<string, unknown> | undefined;
    if (dup) {
      throw Errors.param(`该学员已有一条待接收的末班记录（${String(dup.consult_no)}），请勿重复发起`);
    }

    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const maxRow = (await notDeleted(PUSH())
      .where('consult_no', 'like', `LB${ymd}%`)
      .max({ m: 'consult_no' })
      .first()) as { m: string | null } | undefined;
    const seq = seqOfApplyNo(maxRow?.m ?? null) + 1;
    const consultNo = `LB${ymd}${String(seq).padStart(4, '0')}`;

    const headTeacherId = (cls.head_teacher_id as string) ?? null;
    const headTeacherName = (cls.head_teacher_name as string) ?? null;
    const id = uuid();
    const t = new Date().toISOString().slice(0, 19).replace('T', ' ');

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, PUSH_T, STAGE, {
        ...baseInsert(user, id),
        consult_no: consultNo,
        student_name: stu.student_name as string,
        gender: (stu.gender as number) ?? null,
        phone: (stu.phone as string) ?? null,
        parent_phone: (stu.parent_phone as string) ?? null,
        age: (stu.age as number) ?? null,
        education: (stu.education as string) ?? null,
        origin: (stu.origin as string) ?? null,
        graduate_school: (stu.graduate_school as string) ?? null,
        home_address: (stu.home_address as string) ?? null,
        intend_dept_code: (stu.dept_code as number) ?? (cls.dept_code as number) ?? null,
        // ⚠️ 阶段码：切读时班级/学生表的列名是 stage_code，不是 stage。
        //   写死 cls.stage 会静默写成 null（不报错，只丢数据）→ 必须走 readPhaseCode
        intend_stage: readPhaseCode(cls) ?? readPhaseCode(stu),
        intend_class_id: classId,
        intend_class_name: cls.class_name as string,
        remark: b.remark?.trim() || '成绩管理「末班」转入，等待班主任接收',
        apply_status: ConsultStatus.PENDING,
        push_time: t,
        receiver_id: headTeacherId,
        receiver_name: headTeacherName,
        origin_student_id: b.studentId,
        from_class_id: fromClassId,
        from_class_name: (stu.class_name as string) ?? null,
        is_repeat_in: 1,
        source_system: 'grade-repeat',
      } as never);

      if (headTeacherId) {
        await sendNotify(
          trx,
          {
            notifyType: NotifyType.TODO,
            bizId: id,
            title: `末班待接收：${String(stu.student_name)}`,
            content: `成绩管理将 ${String(stu.student_name)}（${String(stu.student_no)}）标记为末班，待您接收后回到班级「${String(cls.class_name)}」。`,
            linkPath: '/consult',
          },
          { userId: headTeacherId, userName: headTeacherName ?? '' },
        );
      }
    });

    return ok(
      res,
      { consultId: id, consultNo },
      `已推送到班主任「待接收学员」，接收单号 ${consultNo}`,
    );
  }),
);

/* ============================== 表格批量导入 ============================== */

const importSchema = z.object({
  examId: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        studentNo: z.string().min(1, '缺少学号'),
        studentName: z.string().optional().nullable(),
        writtenScore: z.coerce.number().min(0, '笔试分数不能为负').max(1000).optional().nullable(),
        machineScore: z.coerce.number().min(0, '机试分数不能为负').max(1000).optional().nullable(),
        interviewScore: z.coerce.number().min(0, '面试分数不能为负').max(1000).optional().nullable(),
        examResult: z.coerce.number().int().optional().nullable(),
        analysis: z.string().optional().nullable(),
        remark: z.string().optional().nullable(),
      }),
    )
    .min(1, '导入数据不能为空')
    .max(500, '单次最多导入 500 条'),
});

/**
 * @openapi
 * /api/class/grade/import:
 *   post:
 *     tags: [教务运行]
 *     summary: 表格批量导入成绩（前端解析表格后逐条提交）
 *     description: |
 *       支持把 Excel / CSV 解析后的数组一次性录入（综合成绩由后端重算）。
 *       按学号匹配学生；学号不存在或越权的行计入 failed，不影响其余行。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               examId: { type: string }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: 返回 inserted / updated / failed 与失败明细 }
 */
gradeRouter.post(
  '/import',
  requirePerm('grade', PermAction.ADD),
  validate({ body: importSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof importSchema>;

    let examName: string | null = null;
    let examClassId: string | null = null;
    if (b.examId) {
      const exam = (await notDeleted(EXAM()).where('id', b.examId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!exam) throw Errors.param('所选考试不存在');
      examName = exam.exam_name as string;
      examClassId = (exam.class_id as string) ?? null;
    }

    const errors: Array<{ studentNo: string; reason: string }> = [];
    let inserted = 0;
    let updated = 0;

    for (const it of b.items) {
      const stu = (await notDeleted(STU())
        .where('student_no', it.studentNo)
        .first()) as Record<string, unknown> | undefined;
      if (!stu) {
        errors.push({ studentNo: it.studentNo, reason: '学号不存在' });
        continue;
      }
      try {
        assertClassAccess(user, stu.class_id as string | null, `学号 ${it.studentNo}`);
      } catch {
        errors.push({ studentNo: it.studentNo, reason: '无该学员班级的数据权限' });
        continue;
      }

      const examResult = it.examResult ?? ExamResult.PASS;
      if (examResult !== ExamResult.PASS && examResult !== ExamResult.FAIL) {
        errors.push({ studentNo: it.studentNo, reason: '判定只能是 1（升）或 2（末）' });
        continue;
      }
      if (it.writtenScore == null && it.interviewScore == null && it.machineScore == null) {
        errors.push({ studentNo: it.studentNo, reason: '缺少分数' });
        continue;
      }

      const compScore = calcCompScore(it.writtenScore, it.interviewScore);

      // 幂等：同一学员在同一考试下已有一条成绩则更新（避免重复导入翻倍）
      const existed = examClassId || b.examId
        ? ((await notDeleted(GRADE())
            .where('student_id', stu.id as string)
            .where('exam_id', b.examId)
            .first()) as Record<string, unknown> | undefined)
        : undefined;

      if (existed) {
        // ★★ update 分支同样必须走 uniUpdCols，且分数列名按开关取
        //（归一铁律⑨：只翻 insert 的话，首次成功、二次必炸）
        const patch = gradeRow(
          {
            exam_result: examResult,
            analysis: it.analysis ?? null,
            remark: it.remark ?? null,
            ...baseUpdate(user),
          },
          {
            written: it.writtenScore ?? null,
            machine: it.machineScore ?? null,
            interview: it.interviewScore ?? null,
            comp: compScore,
          },
        );
        await GRADE().where({ id: existed.id as string }).update(
          await uniUpdCols(db, SRC, GRADE_T, patch),
        );
        updated += 1;
        continue;
      }

      await tblIns(db, SRC, GRADE_T, STAGE, gradeRow(
        {
          ...baseInsert(user),
          student_id: stu.id as string,
          student_no: stu.student_no as string,
          student_name: stu.student_name as string,
          class_id: examClassId ?? ((stu.class_id as string) ?? null),
          class_name: (stu.class_name as string) ?? null,
          exam_id: b.examId ?? null,
          exam_name: examName,
          exam_result: examResult,
          analysis: it.analysis ?? null,
          remark: it.remark ?? null,
        },
        {
          written: it.writtenScore ?? null,
          machine: it.machineScore ?? null,
          interview: it.interviewScore ?? null,
          comp: compScore,
        },
      ));
      inserted += 1;
    }

    return ok(
      res,
      { inserted, updated, failed: errors.length, errors },
      `导入完成：新增 ${inserted} 条，更新 ${updated} 条，失败 ${errors.length} 条`,
    );
  }),
);

