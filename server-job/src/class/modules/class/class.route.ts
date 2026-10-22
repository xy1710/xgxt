import { Router } from 'express';
import { z } from 'zod';
import { ClassStatus, PermAction, StudentStatus } from 'shared-types/class';
import { db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, notDeleted, paginate } from '../../lib/repo';
import { applyDataScope, assertClassAccess } from '../../middleware/dataScope';
import { requirePerm } from '../../lib/permGuard';
import { isFullAccess } from '../../lib/authUser';
import { rowToCamel, rowsToCamel } from '../../lib/case';
import { now, uuid } from '../../lib/ids';
import { ClassStatusName, isLastStage, nextStageOf, stageNameOf } from '../../lib/dict';
import { wrap } from '../../middleware/error';
// ★ 2026-10-04 斌哥：升实训改成「点确认 → 自动进入项目经理名下」
//   合并版里两边在同一进程、同一个 db 连接，所以直接函数调用复用接收逻辑，
//   不用绕 HTTP、不用管内部令牌、不用等 8003 那边推。
import { processHandoff } from '../../../routes/upgrade.route';
import { tbl, tblTrx, tblIns, tblInsTrx, phaseCodeCol, readPhaseCode } from '../../../teaching/shared/uniTable';
// ★ 第 4 期第 4 批：transfer_type 语义拆分（方案 B）需要这两个枚举
//   TransferType  = 「为什么换」（事由）→ 岗位交接统一填 1=调岗
//   ClassPostType = 「换的是哪个岗位」→ 写进新列 post_transfer_type
import { ClassPostType, TransferType } from 'shared-types';

/** 第 4 批：统一表切读 —— 大学学段班级域的老表全部改为路由到统一表 */
const SRC = 'sms_class';
const STAGE = 'class' as const;

/**
 * 班级管理（原型菜单「班级管理」）
 *  - 班级档案 CRUD（学管 / 校长可写；老师只看自己负责的班）
 *  - 班级交接（班主任 / 教员 / 助教变更 → 详情「班级信息 → 历史信息」）
 *  - 末班记录（考试不合格转班重修）
 */
export const classRouter = Router();

function toClassItem(row: Record<string, unknown>): Record<string, unknown> {
  const c = rowToCamel<Record<string, unknown>>(row);
  const st = row.class_status as number;
  return {
    ...c,
    classStatusName: ClassStatusName[st] ?? '未知',
    stageName: stageNameOf(readPhaseCode(row)),
    attendanceRate: row.attendance_rate !== null && row.attendance_rate !== undefined
      ? Number(row.attendance_rate)
      : null,
  };
}

/* ------------------------------ 列表 ------------------------------ */

const classListSchema = z.object({
  ...pageQuerySchema.shape,
  className: z.string().optional(),
  deptCode: z.coerce.number().int().optional(),
  stage: z.coerce.number().int().optional(),
  classStatus: z.coerce.number().int().optional(),
  headTeacherId: z.string().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/info/list:
 *   get:
 *     tags: [班级管理]
 *     summary: 班级档案列表
 *     description: 老师只返回自己负责的班级；学管 / 校长返回全部。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: keyword, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
classRouter.get(
  '/list',
  validate({ query: classListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof classListSchema>>(req);

    const base = tbl(db, SRC, 't_class_info', STAGE);
    notDeleted(base);
    applyDataScope(base, user, {
      classIdColumn: 'id',
      ownerColumns: ['head_teacher_id', 'teacher_id', 'assistant_id'],
    });
    if (query.className) base.where('class_name', 'like', `%${query.className}%`);
    if (query.deptCode) base.where('dept_code', query.deptCode);
    if (query.stage) base.where(phaseCodeCol(), query.stage);
    if (query.classStatus) base.where('class_status', query.classStatus);
    if (query.headTeacherId) base.where('head_teacher_id', query.headTeacherId);
    if (query.keyword) base.where('class_name', 'like', `%${query.keyword}%`);
    base.orderBy('class_name', 'asc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map(toClassItem);
    });
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* --------- 开放班级（★ 2026-10-05 内部接口：供咨询「分班」/ 初高「升学」选择目标班级） --------- */

/**
 * GET /api/class/info/open-options
 *
 * ⚠️ 故意不加 requirePerm：本接口【只接受内部服务调用】。
 *    路径以 `open-options` 结尾 → app.ts 挂的 authAllowSync 会要求 x-internal-token，
 *    普通用户 token（即使有 class:...:view）也会被 401，避免把全校班级名单暴露给业务前端。
 */
classRouter.get(
  '/open-options',
  wrap(async (_req, res) => {
    const rows = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE))
      .where('class_status', ClassStatus.OPEN)
      .orderBy('class_name', 'asc')) as Array<Record<string, unknown>>;
    return ok(res, rows.map(toClassItem), '查询成功');
  }),
);

/* ------------------------------ 详情 ------------------------------ */

classRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少班级ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { id } = q<{ id: string }>(req);
    const row = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.classNotFound();
    assertClassAccess(user, id, '该班级');

    const [students, transfers] = await Promise.all([
      notDeleted(tbl(db, SRC, 't_class_student', STAGE))
        .where('class_id', id)
        .select('id', 'student_no', 'student_name', 'gender', 'student_status')
        .orderBy('student_no'),
      notDeleted(tbl(db, SRC, 't_class_transfer', STAGE)).where('class_id', id).orderBy('transfer_time', 'desc'),
    ]);

    return ok(
      res,
      {
        classInfo: toClassItem(row),
        students: rowsToCamel(students as Array<Record<string, unknown>>),
        transfers: rowsToCamel(transfers as Array<Record<string, unknown>>),
      },
      '查询成功',
    );
  }),
);

/* ------------------------------ 新建 / 修改 ------------------------------ */

/**
 * ★ 2026-10-04：从班级名推「统一班级号」（Q+数字）
 *
 * 两库的班级靠这个编号关联（大学 Q6 → 升实训后还是 Q6）。
 * 【只认 Q 开头的形式】（`Q1` / `Q6` / `Q12`）：
 *   · 「Q6」  → Q6
 *   · 「Q06」 → Q6   ⚠️ 去掉前导零，否则两边编号对不上
 *   · 「U01」 → null  ⚠️ U 开头【不推】—— 统一编号只认 Q 开头，
 *                        否则测试班 T449356 也会被当成正式编号
 *   · 「实训一期1班」→ null（中文名不推，留空）
 *
 * 为什么不认 U 开头：U 是历史命名（已被改名成 Q），
 * 现在新建的班一律 Q 开头；U 开头的老数据由迁移 20261004_018 回填过。
 */
function deriveUniversityNo(className: string): string | null {
  const m = /^\s*[Qq]\s*0*(\d+)\s*$/.exec(className || '');
  return m ? `Q${Number(m[1])}` : null;
}

const classAddSchema = z.object({
  className: z.string().min(1, '班级名称不能为空'),
  deptCode: z.coerce.number().int('部门不能为空'),
  stage: z.coerce.number().int('学习阶段不能为空'),
  headTeacherId: z.string().optional().nullable(),
  headTeacherName: z.string().optional().nullable(),
  teacherId: z.string().optional().nullable(),
  teacherName: z.string().optional().nullable(),
  assistantId: z.string().optional().nullable(),
  assistantName: z.string().optional().nullable(),
  // ★ 2026-10-04 斌哥拍板：建班时把 5 个岗位一次定好
  //   项目经理     → 实训阶段接手带训的人（升实训时可留空，默认沿用班主任）
  //   就业指导老师 → 就业阶段带训的人
  projectManagerId: z.string().optional().nullable(),
  projectManagerName: z.string().optional().nullable(),
  employmentTeacherId: z.string().optional().nullable(),
  employmentTeacherName: z.string().optional().nullable(),
  /** ★ 统一班级号（Q+数字）。不给就按班级名里的数字自动推 */
  universityNo: z.string().optional().nullable(),
  room: z.string().optional().nullable(),
  openDate: z.string().optional().nullable(),
  classStatus: z.coerce.number().int().optional(),
});

/**
 * @openapi
 * /api/class/info/add:
 *   post:
 *     tags: [班级管理]
 *     summary: 新建班级
 *     description: 对应原型「班级管理」页的「＋ 新建班级」。班主任 / 教员 / 助教均可选填（对应原型「助教名称（非必填）」）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [className, deptCode, stage]
 *             properties:
 *               className: { type: string, example: G104 }
 *               deptCode: { type: integer, example: 1 }
 *               stage: { type: integer, example: 105 }
 *     responses:
 *       200: { description: 新建成功 }
 */
classRouter.post(
  '/add',
  requirePerm('class', PermAction.ADD),
  validate({ body: classAddSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof classAddSchema>;

    const dup = await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('class_name', b.className).first();
    if (dup) throw Errors.param(`班级名称「${b.className}」已存在，请更换`);

    const id = uuid();
    await tblIns(db, SRC, 't_class_info', STAGE, {
      ...baseInsert(user, id),
      class_name: b.className,
      dept_code: b.deptCode,
      [phaseCodeCol()]: b.stage,
      head_teacher_id: b.headTeacherId ?? null,
      head_teacher_name: b.headTeacherName ?? null,
      teacher_id: b.teacherId ?? null,
      teacher_name: b.teacherName ?? null,
      assistant_id: b.assistantId ?? null,
      assistant_name: b.assistantName ?? null,
      // ★ 2026-10-04：项目经理 / 就业指导老师 / 统一班级号
      project_manager_id: b.projectManagerId ?? null,
      project_manager_name: b.projectManagerName ?? null,
      employment_teacher_id: b.employmentTeacherId ?? null,
      employment_teacher_name: b.employmentTeacherName ?? null,
      university_no: b.universityNo || deriveUniversityNo(b.className),
      room: b.room ?? null,
      open_date: b.openDate ?? null,
      student_count: 0,
      class_status: b.classStatus ?? ClassStatus.OPEN,
    } as never);

    return ok(res, { classId: id }, '新建班级成功');
  }),
);

classRouter.put(
  '/update',
  requirePerm('class', PermAction.EDIT),
  validate({
    body: classAddSchema.partial().extend({ classId: z.string().min(1, '缺少班级ID') }),
  }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof classAddSchema> & { classId: string };
    const row = await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.classId).first();
    if (!row) throw Errors.classNotFound();
    assertClassAccess(user, b.classId, '该班级');

    const patch: Record<string, unknown> = {};
    const map: Array<[string, string]> = [
      ['className', 'class_name'],
      ['deptCode', 'dept_code'],
      ['stage', phaseCodeCol()],
      ['headTeacherId', 'head_teacher_id'],
      ['headTeacherName', 'head_teacher_name'],
      ['teacherId', 'teacher_id'],
      ['teacherName', 'teacher_name'],
      ['assistantId', 'assistant_id'],
      ['assistantName', 'assistant_name'],
      ['room', 'room'],
      ['openDate', 'open_date'],
      ['classStatus', 'class_status'],
    ];
    for (const [src, col] of map) {
      const v = (b as Record<string, unknown>)[src];
      if (v !== undefined) patch[col] = v;
    }
    await db.transaction(async (trx) => {
      if (Object.keys(patch).length) {
        await tblTrx(trx, SRC, 't_class_info', STAGE).where({ id: b.classId }).update({ ...patch, ...baseUpdate(user) });
      }
      // 学习阶段与班级阶段保持一致：班级阶段一改，班内学员的学习阶段同步跟改
      if (patch[phaseCodeCol()] !== undefined) {
        await tblTrx(trx, SRC, 't_class_student', STAGE)
          .where({ class_id: b.classId, is_deleted: 0 })
          .update({ [phaseCodeCol()]: patch[phaseCodeCol()] as number, ...baseUpdate(user) });
      }
    });
    return ok(res, { classId: b.classId, stage: patch[phaseCodeCol()] ?? null }, '保存成功');
  }),
);

/* ------------------------------ 班级交接 ------------------------------ */

const transferSchema = z.object({
  classId: z.string().min(1, '缺少班级ID'),
  transferType: z.enum(['headTeacher', 'teacher', 'assistant'], {
    errorMap: () => ({ message: '交接类型只能是 headTeacher / teacher / assistant' }),
  }),
  toUserId: z.string().min(1, '请选择接手的老师'),
  toUserName: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/info/transfer/add:
 *   post:
 *     tags: [班级管理]
 *     summary: 班级交接（换班主任 / 教员 / 助教）
 *     description: |
 *       交接后：① 班级档案更新负责人；② 该班学员的对应负责人字段同步更新；
 *       ③ 写一条交接历史（详情 → 班级信息 → 历史信息 可见）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [classId, transferType, toUserId]
 *             properties:
 *               classId: { type: string }
 *               transferType: { type: string, enum: [headTeacher, teacher, assistant] }
 *               toUserId: { type: string }
 *               reason: { type: string }
 *     responses:
 *       200: { description: 交接成功 }
 */
classRouter.post(
  '/transfer/add',
  requirePerm('transfer', PermAction.ADD),
  validate({ body: transferSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof transferSchema>;

    const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.classId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!cls) throw Errors.classNotFound();

    const colMap = {
      headTeacher: { id: 'head_teacher_id', name: 'head_teacher_name', label: '班主任' },
      teacher: { id: 'teacher_id', name: 'teacher_name', label: '教员' },
      assistant: { id: 'assistant_id', name: 'assistant_name', label: '助教' },
    } as const;
    const target = colMap[b.transferType];
    /**
     * ★★ 第 4 期第 4 批（方案 B）：岗位 → 统一列 `post_transfer_type`
     *
     * 统一表 `t_uni_class_transfer` 被两件事共用：
     *   岗位交接（本接口）与学生升学转班（upgrade.route.ts）。
     *   老表那一列装的是**岗位名** headTeacher/teacher/assistant，
     *   统一表那一列是**事由** int → 直接塞字符串会报
     *   `Incorrect integer value: 'headTeacher'`。
     *
     * 【斌哥 2026-10-11 拍板方案 B：拆两列，不是给字典加 7/8/9】
     *   transfer_type     → 回归「事由」语义，岗位交接一律 1=调岗
     *   post_transfer_type→ 新列，回答「换的是哪个岗位」（迁移 20261011_001）
     *
     * 为什么不塞进备注：那会让岗位变成文本，统计只能 like，拆不回去。
     */
    const postType = {
      headTeacher: ClassPostType.HEAD_TEACHER,
      teacher: ClassPostType.TEACHER,
      assistant: ClassPostType.ASSISTANT,
    } as const;
    const fromUserId = (cls[target.id] as string) ?? null;
    const fromUserName = (cls[target.name] as string) ?? null;
    const toUserName = b.toUserName ?? null;

    if (fromUserId === b.toUserId) {
      throw Errors.param(`接手的老师与现任${target.label}相同，无需交接`);
    }

    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_info', STAGE)
        .where({ id: b.classId })
        .update({ [target.id]: b.toUserId, [target.name]: toUserName, ...baseUpdate(user) });

      // 该班学员的负责人字段同步更新
      await tblTrx(trx, SRC, 't_class_student', STAGE)
        .where({ class_id: b.classId, is_deleted: 0 })
        .update({ [target.id]: b.toUserId, [target.name]: toUserName, ...baseUpdate(user) });

      /**
       * ★★ 切读时**不能**直接写 from_user_id / from_user_name / to_user_*
       *
       * 【为什么 —— 这是本批最容易埋雷的一处】
       *   `uniTable.ts` 的列名翻译表把 t_class_transfer 的
       *     from_user_name → from_class_name
       *     to_user_name   → to_class_name
       *   因为**升学转班**那条路径（upgrade.route.ts）借用了这两列装班级名
       *   （老表的「列语义借用」，见 uniTable.ts 里UNI_COL_RENAME 的说明）。
       *
       *   但**岗位交接**写进去的是「人名」，不是班级名。
       *   若照老代码原样写 → 人名被塞进 from_class_name
       *   → 「班主任交接」被记成「从某个班级换到某个班级」
       *   → 数据看着有值、含义全错，**比报错更难查**。
       *
       * 【正确落点：统一表本来就有专门的岗位列】
       *   old_head_teacher_id/name、new_head_teacher_id/name
       *   old_teacher_id/name、     new_teacher_id/name
       *   old_assistant_id/name、   new_assistant_id/name
       *   这12 列就是为「换了哪个岗位的人」准备的，写进去语义自洽。
       */
      const uniPostCols = {
        headTeacher: {
          old: ['old_head_teacher_id', 'old_head_teacher_name'],
          neo: ['new_head_teacher_id', 'new_head_teacher_name'],
        },
        teacher: {
          old: ['old_teacher_id', 'old_teacher_name'],
          neo: ['new_teacher_id', 'new_teacher_name'],
        },
        assistant: {
          old: ['old_assistant_id', 'old_assistant_name'],
          neo: ['new_assistant_id', 'new_assistant_name'],
        },
      } as const;
      const uc = uniPostCols[b.transferType];

      /**
       * ★ 老表模式：transfer_type 是 varchar(20)，原样存岗位名（行为与改写前完全一致）
       * ★ 切读模式：int(11) 存事由码 = 1 调岗，岗位另存 post_transfer_type
       */
      const transferRow: Record<string, unknown> = {
        ...baseInsert(user),
        class_id: b.classId,
        class_name: cls.class_name as string,
        transfer_type: TransferType.REASSIGN,
        transfer_time: now(),
        reason: b.reason ?? `更换${target.label}`,
      };

      /* 岗位另存新列（迁移 20261011_001）；不适用时留 NULL 是诚实的表达 */
      transferRow.post_transfer_type = postType[b.transferType];
      /* 岗位交接的「人」写 old_ / new_ 系列 12 列，不碰被借用走的 from_user_ / to_user_ */
      transferRow[uc.old[0]] = fromUserId;
      transferRow[uc.old[1]] = fromUserName;
      transferRow[uc.neo[0]] = b.toUserId;
      transferRow[uc.neo[1]] = toUserName;

      await tblInsTrx(trx, SRC, 't_class_transfer', STAGE, transferRow as never);
    });

    return ok(res, { classId: b.classId }, `${target.label}交接成功`);
  }),
);

/* ------------------------------ 末班记录 ------------------------------ */

const repeatSchema = z.object({
  studentId: z.string().min(1, '缺少学生ID'),
  repeatReason: z.string().min(1, '末班原因不能为空'),
  toClassId: z.string().optional().nullable(),
  repeatTime: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/info/repeat/add:
 *   post:
 *     tags: [班级管理]
 *     summary: 新增末班记录
 *     description: |
 *       末班是**事件**不是学生状态：记录一次「考试不合格 → 转班重修」，
 *       同时把学生累计末班次数 +1，并把学生转到目标班级。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, repeatReason]
 *             properties:
 *               studentId: { type: string }
 *               repeatReason: { type: string, example: 阶段考核未通过 }
 *               toClassId: { type: string, description: 转入班级，留空表示暂不转班 }
 *     responses:
 *       200: { description: 新增成功 }
 */
classRouter.post(
  '/repeat/add',
  requirePerm('repeat', PermAction.ADD),
  validate({ body: repeatSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof repeatSchema>;

    const stu = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE)).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学生');

    let toClassName: string | null = null;
    if (b.toClassId) {
      const to = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.toClassId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!to) throw Errors.classNotFound('转入班级不存在');
      toClassName = to.class_name as string;
    }

    const newCount = Number(stu.repeat_count ?? 0) + 1;

    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, 't_class_repeat', STAGE, {
        ...baseInsert(user),
        student_id: b.studentId,
        student_no: stu.student_no as string,
        student_name: stu.student_name as string,
        repeat_time: b.repeatTime ?? now(),
        repeat_reason: b.repeatReason,
        from_class_id: (stu.class_id as string) ?? null,
        from_class_name: (stu.class_name as string) ?? null,
        to_class_id: b.toClassId ?? null,
        to_class_name: toClassName,
        repeat_count: newCount,
      } as never);

      const patch: Record<string, unknown> = { repeat_count: newCount, ...baseUpdate(user) };
      if (b.toClassId) {
        patch.class_id = b.toClassId;
        patch.class_name = toClassName;
      }
      await tblTrx(trx, SRC, 't_class_student', STAGE).where({ id: b.studentId }).update(patch);
    });

    return ok(res, { repeatCount: newCount }, '末班记录已保存');
  }),
);

/**
 * @openapi
 * /api/class/info/repeat/list:
 *   get:
 *     tags: [班级管理]
 *     summary: 末班记录列表
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: studentId, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
classRouter.get(
  '/repeat/list',
  validate({
    query: z.object({
      ...pageQuerySchema.shape,
      studentId: z.string().optional(),
      className: z.string().optional(),
      keyword: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const query = q<{ page: number; size: number; studentId?: string; className?: string; keyword?: string }>(req);
    const base = tbl(db, SRC, 't_class_repeat', STAGE);
    notDeleted(base);
    if (query.studentId) base.where('student_id', query.studentId);
    if (query.className) base.where('from_class_name', query.className);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: import('knex').Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy('repeat_time', 'desc');

    const paged = await paginate(base, query, async (qb) =>
      rowsToCamel(await qb as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ------------------------------------------------------------------ *
 * 推进阶段（需求 v1.2）
 *   学习阶段与班级阶段一致：班级推进一阶段，班内全部学员同步跟改。
 *   学管 / 校长可在「班级管理」逐级推进。
 * ------------------------------------------------------------------ */

const stageAdvanceSchema = z.object({
  classId: z.string().min(1, '缺少班级ID'),
  reason: z.string().max(200).optional().nullable(),
});

/**
 * @openapi
 * /api/class/info/stage/advance:
 *   post:
 *     tags: [班级管理]
 *     summary: 推进班级阶段（逐级 +1，并同步班内学员的学习阶段）
 *     description: |
 *       阶段名称为 一阶段…六阶段（大学部 201–206）。
 *       已处于最后一个阶段的班级不能再推进，应走「升实训」。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [classId]
 *             properties:
 *               classId: { type: string }
 *               reason: { type: string, example: 阶段考核通过 }
 *     responses:
 *       200: { description: 推进成功 }
 */
classRouter.post(
  '/stage/advance',
  requirePerm('class', PermAction.EDIT),
  validate({ body: stageAdvanceSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof stageAdvanceSchema>;

    const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.classId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!cls) throw Errors.classNotFound();
    assertClassAccess(user, b.classId, '该班级');

    const fromStage = Number(readPhaseCode(cls));
    const toStage = nextStageOf(fromStage);
    if (toStage === null) {
      throw Errors.param(
        `该班级已处于最后一个阶段（${stageNameOf(fromStage)}），不能再推进；第六阶段可执行「升实训」`,
      );
    }
    const fromName = stageNameOf(fromStage);
    const toName = stageNameOf(toStage);
    let count = 0;

    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_info', STAGE)
        .where({ id: b.classId })
        .update({ [phaseCodeCol()]: toStage, ...baseUpdate(user) });

      // 班内学员的学习阶段与班级保持一致
      count = await tblTrx(trx, SRC, 't_class_student', STAGE)
        .where({ class_id: b.classId, is_deleted: 0 })
        .update({ [phaseCodeCol()]: toStage, ...baseUpdate(user) });

      await tblInsTrx(trx, SRC, 't_class_stage_log', STAGE, {
        ...baseInsert(user),
        class_id: b.classId,
        class_name: cls.class_name as string,
        from_stage: fromStage,
        from_stage_name: fromName,
        to_stage: toStage,
        to_stage_name: toName,
        student_count: count,
        operate_time: now(),
        operator_id: user.userId,
        operator_name: user.userName,
        reason: b.reason ?? '推进阶段',
      } as never);
    });

    return ok(
      res,
      {
        classId: b.classId,
        fromStage,
        toStage,
        fromStageName: fromName,
        toStageName: toName,
        studentCount: count,
      },
      `已推进到「${toName}」，同步更新 ${count} 名学员的学习阶段`,
    );
  }),
);

/**
 * @openapi
 * /api/class/info/stage/log:
 *   get:
 *     tags: [班级管理]
 *     summary: 阶段推进记录
 *     parameters:
 *       - { in: query, name: classId, schema: { type: string } }
 *     responses:
 *       200: { description: 列表 }
 */
classRouter.get(
  '/stage/log',
  validate({ query: z.object({ classId: z.string().optional() }) }),
  wrap(async (req, res) => {
    const { classId } = q<{ classId?: string }>(req);
    const base = tbl(db, SRC, 't_class_stage_log', STAGE);
    notDeleted(base);
    if (classId) base.where('class_id', classId);
    base.orderBy('operate_time', 'desc').limit(100);
    const rows = await base;
    return ok(res, rowsToCamel(rows as Array<Record<string, unknown>>), '查询成功');
  }),
);

/* ------------------------------------------------------------------ *
 * 升实训（需求 v1.2）
 *   仅「第六阶段」班级可出现；确认后把班级与班内学员交接到实训模块，
 *   班级状态 → 实训中，班内学员学生状态 → 实训中，并生成一张交接单。
 * ------------------------------------------------------------------ */

const upgradeTrainingSchema = z.object({
  classId: z.string().min(1, '缺少班级ID'),
  remark: z.string().max(500).optional().nullable(),
  /* ============================================================
   * ★ 2026-10-06（用户口径）：
   *   「班级管理页面当阶段为六阶段升实训时，需要选择项目经理、就业指导老师，
   *     确认后班级信息进入就业管理模块的班级管理」
   *   → 升实训弹窗上现选这两个岗位，随请求一起传。
   *   不传时沿用建班/改班时定的值（老流程仍然可用）。
   * ============================================================ */
  projectManagerId: z.string().min(1).optional().nullable(),
  projectManagerName: z.string().max(50).optional().nullable(),
  employmentTeacherId: z.string().min(1).optional().nullable(),
  employmentTeacherName: z.string().max(50).optional().nullable(),
});

/** 按门户账号 id 取姓名（升实训弹窗只传 id 时的兜底） */
async function accountNameOf(id: string): Promise<string | null> {
  if (!id) return null;
  try {
    const [rows] = (await db.raw(
      `SELECT user_name AS n FROM \`${process.env.DB_NAME_PORTAL || 'sms_portal'}\`.t_sys_account
        WHERE id = ? LIMIT 1`,
      [id],
    )) as unknown as [Array<{ n?: string }>, unknown];
    return rows?.[0]?.n ?? null;
  } catch {
    return null;
  }
}

/**
 * @openapi
 * /api/class/info/training/upgrade:
 *   post:
 *     tags: [班级管理]
 *     summary: 班级升实训（确认后交接到实训模块）
 *     description: |
 *       前置：班级阶段必须是「六阶段」（大学部 206），否则报错；
 *             ★ 2026-10-06：项目经理在**本弹窗现选**（projectManagerId 必传；
 *             不传则沿用建班时定的，仍为空则报错）。就业指导老师可选。
 *       影响：班级状态 → 实训中；班内学员学生状态 → 实训中；生成「升实训交接单」；
 *             ★ 自动交接到**就业管理模块 → 班级信息管理**（sms_job.t_job_class，
 *             按统一班级号 Q+数字复用/新建班级，落到所选项目经理名下）。
 *       权限：★ 交棒① 由原负责人发起 —— 大学班主任（仅自己带的班）；
 *             学管 / 校长也可代发（管理动作不受交棒影响）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [classId]
 *             properties:
 *               classId: { type: string }
 *               remark: { type: string }
 *               projectManagerId: { type: string, description: 升实训后接手带训的项目经理（门户账号ID） }
 *               employmentTeacherId: { type: string, description: 就业指导老师（门户账号ID，可选） }
 *     responses:
 *       200: { description: 升实训成功 }
 */
classRouter.post(
  '/training/upgrade',
  // ★ 2026-10-04 交棒模型：升实训 = 交棒①，发起权给「原负责人」= 大学班主任
  //   （upgrade 资源 = 学管/校长 + 班主任；班主任是否带这个班在下面再校验）
  requirePerm('upgrade', PermAction.ADD),
  validate({ body: upgradeTrainingSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof upgradeTrainingSchema>;

    const cls = (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).where('id', b.classId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!cls) throw Errors.classNotFound();

    // ★ 班主任组发起时，必须是该班三岗之一（班主任/教员/助教）；
    //   学管/校长不受限。斌哥 2026-10-04：大学部班主任能用全部班级操作。
    if (!isFullAccess(user)) {
      const inPosts = [cls.head_teacher_id, cls.teacher_id, cls.assistant_id]
        .includes(user.userId);
      if (!inPosts) {
        throw Errors.noOperationPermission('只能对自己所在的班级执行升实训');
      }
    }
    assertClassAccess(user, b.classId, '该班级');

    // ★ 交棒模型：项目经理 = 真人，必填（后续可走交接换人）；不默认原班主任接手
    //   ★ 2026-10-06：升实训弹窗里可以**现选**（本次传入优先），
    //     否则沿用建班/改班时安排好的那个人。
    const pmId = ((b.projectManagerId ?? cls.project_manager_id) as string | null) || null;
    const etId = ((b.employmentTeacherId ?? cls.employment_teacher_id) as string | null) || null;
    if (!pmId) {
      throw Errors.param('请先选择「项目经理」后再升实训');
    }

    const pmName =
      b.projectManagerName || (await accountNameOf(pmId)) || (cls.project_manager_name as string) || null;
    const etName =
      b.employmentTeacherName || (etId ? await accountNameOf(etId) : null) || (cls.employment_teacher_name as string) || null;
    if (b.projectManagerId && !pmName) {
      throw Errors.param('选择的「项目经理」在系统账号里不存在，请重新选择');
    }
    if (b.employmentTeacherId && !etName) {
      throw Errors.param('选择的「就业指导老师」在系统账号里不存在，请重新选择');
    }

    const stage = Number(readPhaseCode(cls));
    if (!isLastStage(stage)) {
      throw Errors.param(
        `仅处于第六阶段（最后阶段）的班级可升实训，当前为「${stageNameOf(stage)}」`,
      );
    }

    // ★ 2026-10-04 斌哥：「点确认升实训」= 一步到位，班自动落到项目经理名下
    //   原来这一步只写交接单，实训侧要另外调 /receive 才建班 → 点了没反应。
    //   现在同一进程直接调 processHandoff（幂等），失败也不回滚交接单。
    const students = (await notDeleted(tbl(db, SRC, 't_class_student', STAGE))
      .where('class_id', b.classId)
      .select(
        'id',
        'student_no',
        'student_name',
        'gender',
        'age',
        'id_card',
        'phone',
        'parent_phone',
        'education',
        'enroll_date',
        'attendance_rate',
        'repeat_count',
        'remark',
        // ★ 2026-10-04：宿舍跟着搬到实训库（dorm_building 是当天新加的字段）
        'dorm_building',
        'dorm_no',
        'bed_no',
      )) as Array<Record<string, unknown>>;
    if (!students.length) throw Errors.param('该班级没有学员，无法升实训');

    const ymd = now().slice(0, 10).replace(/-/g, '');
    const cntRow = (await tbl(db, SRC, 't_class_training_handoff', STAGE)
      .where('handoff_no', 'like', `ST${ymd}%`)
      .count({ c: '*' })
      .first()) as unknown as { c?: number | string } | undefined;
    const handoffNo = `ST${ymd}${String(Number(cntRow?.c ?? 0) + 1).padStart(3, '0')}`;
    const studentIds = students.map((s) => String(s.id));

    await db.transaction(async (trx) => {
      await tblTrx(trx, SRC, 't_class_info', STAGE)
        .where({ id: b.classId })
        .update({
          class_status: ClassStatus.TRAINING,
          // ★ 2026-10-06：把升实训弹窗上选的两个人回写到班级（后续花名册/列表都看得到）
          project_manager_id: pmId,
          project_manager_name: pmName,
          ...(etId
            ? { employment_teacher_id: etId, employment_teacher_name: etName }
            : {}),
          ...baseUpdate(user),
        });

      await tblTrx(trx, SRC, 't_class_student', STAGE)
        .where({ class_id: b.classId, is_deleted: 0 })
        .update({ student_status: StudentStatus.TRAINING, ...baseUpdate(user) });

      await tblInsTrx(trx, SRC, 't_class_training_handoff', STAGE, {
        ...baseInsert(user),
        handoff_no: handoffNo,
        class_id: b.classId,
        class_name: cls.class_name as string,
        dept_code: (cls.dept_code as number) ?? null,
        stage,
        stage_name: stageNameOf(stage),
        head_teacher_id: (cls.head_teacher_id as string) ?? null,
        head_teacher_name: (cls.head_teacher_name as string) ?? null,
        teacher_id: (cls.teacher_id as string) ?? null,
        teacher_name: (cls.teacher_name as string) ?? null,
        student_count: students.length,
        student_ids: JSON.stringify(studentIds),
        to_module: '实训模块',
        handoff_status: 1,
        handoff_time: now(),
        operator_id: user.userId,
        operator_name: user.userName,
        remark: b.remark ?? null,
      } as never);
    });

    /* ============================================================
     * ★ 2026-10-04 斌哥：点确认后**自动接收**，班直接落到项目经理名下
     *
     * 【为什么放在事务外】
     *   processHandoff 自己开事务（它要写班级/学生/花名册/交接单副本四张表）。
     *   如果嵌进上面那个事务，会变成事务套事务 —— 双方各自 commit，
     *   一旦这里失败会把交接单也回滚掉，用户就「点了完全没反应」。
     *   分开写：交接单落库成功 = 发起成功（可重试）；接收失败 = 明确报错文案。
     *
     * 【幂等】processHandoff 内部按 handoffNo 判重，重复调不会重复建班。
     * ============================================================ */
    let result: {
      targetClassId?: string;
      targetClassName?: string;
      projectManagerId?: string;
      projectManagerName?: string;
      receiveError?: string;
    };
    try {
      const r = (await processHandoff(
        {
          handoffNo,
          sourceClassId: b.classId,
          sourceClassName: (cls.class_name as string) ?? null,
          universityNo: (cls.university_no as string) ?? null,
          sourceStage: stage,
          headTeacherId: (cls.head_teacher_id as string) ?? null,
          headTeacherName: (cls.head_teacher_name as string) ?? null,
          // ★ 交棒模型：项目经理 = 升实训时选定（本次传入优先，否则沿用建班时定的）
          projectManagerId: pmId,
          projectManagerName: pmName,
          // ★ 2026-10-04 斌哥要求：就业指导老师一起带过去
          //   （之前没带，升实训后班级列表上这一列是空的）
          employmentTeacherId: etId,
          employmentTeacherName: etName,
          students: students.map((s) => ({
            studentNo: String(s.student_no ?? ''),
            studentName: String(s.student_name ?? ''),
            gender: (s.gender as number) ?? null,
            age: (s.age as number) ?? null,
            idCard: (s.id_card as string) ?? null,
            phone: (s.phone as string) ?? null,
            parentPhone: (s.parent_phone as string) ?? null,
            education: (s.education as string) ?? null,
            enrollDate: (s.enroll_date as string) ?? null,
            attendanceRate: (s.attendance_rate as number) ?? null,
            repeatCount: (s.repeat_count as number) ?? null,
            remark: (s.remark as string) ?? null,
            // ★ 宿舍（楼 + 房间 + 床位序号），实训侧按需建间/建床/占床
            dormBuilding: (s.dorm_building as string) ?? null,
            dormNo: (s.dorm_no as string) ?? null,
            bedNo: (s.bed_no as number) ?? null,
          })),
        },
        { userId: user.userId, userName: user.userName },
      )) as Record<string, unknown>;

      result = {
        targetClassId: r.targetClassId as string,
        targetClassName: r.targetClassName as string,
        projectManagerId: pmId,
        projectManagerName: pmName ?? '',
      };
    } catch (e) {
      // ⚠️ 不抛：交接单已落库（发起成功），这里只是接收失败，要让用户看见并可重试
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[upgrade] 实训侧自动接收失败（交接单 ${handoffNo}）:`, msg);
      result = { receiveError: msg };
    }

    return ok(
      res,
      {
        classId: b.classId,
        handoffNo,
        studentCount: students.length,
        // ↓ 实训侧落库结果（让前端能直接告诉用户「已归到某某项目经理名下」）
        ...(result.targetClassId
          ? {
              targetClassId: result.targetClassId,
              targetClassName: result.targetClassName,
              projectManagerId: result.projectManagerId,
              projectManagerName: result.projectManagerName,
            }
          : {}),
      },
      result.targetClassId
        ? `已确认升实训：${cls.class_name} 及 ${students.length} 名学员已交接到实训模块，由项目经理「${result.projectManagerName}」接手`
        : `已确认升实训：${cls.class_name} 及 ${students.length} 名学员已交接到实训模块（⚠️ 实训侧建班失败：${result.receiveError}，请让管理员执行「重试接收」）`,
    );
  }),
);

/**
 * @openapi
 * /api/class/info/training/list:
 *   get:
 *     tags: [班级管理]
 *     summary: 升实训交接单列表
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: classId, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
classRouter.get(
  '/training/list',
  validate({
    query: z.object({
      ...pageQuerySchema.shape,
      classId: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const query = q<{ page: number; size: number; classId?: string }>(req);
    const base = tbl(db, SRC, 't_class_training_handoff', STAGE);
    notDeleted(base);
    if (query.classId) base.where('class_id', query.classId);
    base.orderBy('handoff_time', 'desc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = rowsToCamel(await (qb as unknown as Array<Record<string, unknown>>));
      // ★ 交棒模型：把「建班时安排的项目经理」和统一班级号带出去
      //   （实训模块 pull 时据此把项目经理写到实训班上 —— 不默认回退班主任）
      const classIds = [...new Set(rows.map((r) => String(r.classId || '')))].filter(Boolean);
      if (!classIds.length) return rows;
      const clsRows = rowsToCamel(
        (await notDeleted(tbl(db, SRC, 't_class_info', STAGE)).whereIn('id', classIds)) as Array<
          Record<string, unknown>
        >,
      );
      const map = new Map(clsRows.map((c) => [String(c.id), c]));
      return rows.map((r) => {
        const c = map.get(String(r.classId || ''));
        return c
          ? {
              ...r,
              projectManagerId: c.projectManagerId ?? null,
              projectManagerName: c.projectManagerName ?? null,
              // ★ 2026-10-04：就业指导老师一起带给实训侧（否则 /pull 搬过去是空的）
              employmentTeacherId: c.employmentTeacherId ?? null,
              employmentTeacherName: c.employmentTeacherName ?? null,
              universityNo: c.universityNo ?? null,
            }
          : r;
      });
    });
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);
