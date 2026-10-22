import { Router } from 'express';
import { z } from 'zod';
import { Knex } from 'knex';
import { PermAction } from 'shared-types/class';
import { commonDb, db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, notDeleted, paginate } from '../../lib/repo';
import { requirePerm } from '../../lib/permGuard';
import { rowsToCamel } from '../../lib/case';
import { today } from '../../lib/ids';
import { applyDataScope, assertClassAccess } from '../../middleware/dataScope';
import { wrap } from '../../middleware/error';
import {
  tbl,
  tblTrx,
  tblInsTrx,
  uniUpdCols,
} from '../../../teaching/shared/uniTable';

const SRC = 'sms_class';
const STAGE = 'class' as const;

const ATT_T = 't_class_attendance';
const ABS_T = 't_class_attendance_absent';
const CLS_T = 't_class_info';
const STU_T = 't_class_student';

const ATT = () => tbl(db, SRC, ATT_T, STAGE);
const ABS = () => tbl(db, SRC, ABS_T, STAGE);
const CLS = () => tbl(db, SRC, CLS_T, STAGE);

/**
 * 出勤管理（原型菜单「教务运行 / 出勤管理」）
 * 录入粒度：**按班级按天**，缺勤到人（缺勤明细必须填原因）。
 */
export const attendanceRouter = Router();

const listSchema = z.object({
  ...pageQuerySchema.shape,
  classId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/attendance/list:
 *   get:
 *     tags: [教务运行]
 *     summary: 出勤记录列表（按班级按天）
 *     description: 老师只看自己负责班级的出勤记录。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: classId, schema: { type: string } }
 *       - { in: query, name: startDate, schema: { type: string } }
 *       - { in: query, name: endDate, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
attendanceRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = ATT();
    notDeleted(base);
    applyDataScope(base, user, { classIdColumn: 'class_id' });
    if (query.classId) base.where('class_id', query.classId);
    if (query.startDate) base.where('attendance_date', '>=', query.startDate);
    if (query.endDate) base.where('attendance_date', '<=', query.endDate);
    if (query.keyword) base.where('class_name', 'like', `%${query.keyword}%`);
    base.orderBy('attendance_date', 'desc').orderBy('class_name');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        ...rowsToCamel<Record<string, unknown>>([r])[0],
        attendanceRate: Number(r.attendance_rate ?? 0),
      }));
    });
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

const addSchema = z.object({
  classId: z.string().min(1, '缺少班级ID'),
  attendanceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '考勤日期格式应为 YYYY-MM-DD')
    .optional(),
  shouldCount: z.coerce.number().int().min(0, '应到人数不能为负'),
  presentCount: z.coerce.number().int().min(0, '实到人数不能为负'),
  teacherName: z.string().optional().nullable(),
  absents: z
    .array(
      z.object({
        studentId: z.string().min(1, '缺勤学员不能为空'),
        absentReason: z.string().min(1, '缺勤原因必须填写'),
      }),
    )
    .default([]),
});

/**
 * @openapi
 * /api/class/attendance/add:
 *   post:
 *     tags: [教务运行]
 *     summary: 录入 / 覆盖某班某天的考勤
 *     description: |
 *       缺勤人数与出勤率由后端算，不由前端传：
 *       `absentCount = 应到 - 实到`（负数按 0），`attendanceRate = 实到 / 应到 × 100`。
 *       同班同天重复提交为**覆盖**（重新录入）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [classId, shouldCount, presentCount]
 *             properties:
 *               classId: { type: string }
 *               attendanceDate: { type: string, example: '2026-09-30' }
 *               shouldCount: { type: integer, example: 40 }
 *               presentCount: { type: integer, example: 38 }
 *               absents:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     studentId: { type: string }
 *                     absentReason: { type: string, example: 病假 }
 *     responses:
 *       200: { description: 保存成功 }
 */
attendanceRouter.post(
  '/add',
  requirePerm('attendance', PermAction.ADD),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof addSchema>;
    assertClassAccess(user, b.classId, '该班级');

    const cls = (await notDeleted(CLS()).where('id', b.classId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!cls) throw Errors.classNotFound();

    if (b.presentCount > b.shouldCount) {
      throw Errors.param('实到人数不能大于应到人数');
    }
    const date = b.attendanceDate ?? today();
    const absentCount = Math.max(0, b.shouldCount - b.presentCount);
    const rate = b.shouldCount > 0 ? Number(((b.presentCount / b.shouldCount) * 100).toFixed(2)) : 0;

    const existing = (await notDeleted(ATT())
      .where({ class_id: b.classId, attendance_date: date })
      .first()) as Record<string, unknown> | undefined;

    await db.transaction(async (trx) => {
      let attendanceId: string;
      if (existing) {
        attendanceId = existing.id as string;
        const patch = await uniUpdCols(db, SRC, ATT_T, {
          should_count: b.shouldCount,
          present_count: b.presentCount,
          absent_count: absentCount,
          attendance_rate: rate,
          teacher_name: b.teacherName ?? (cls.teacher_name as string) ?? null,
          head_teacher_name: (cls.head_teacher_name as string) ?? null,
          ...baseUpdate(user),
        });
        await tblTrx(trx, SRC, ATT_T, STAGE).where({ id: attendanceId }).update(patch as never);
        // ⚠️ 明细「整体替换」的软删移到下面统一做（按学生 upsert）——
        //    「先整体软删、再插入」在统一表上必撞唯一键
        //    `t_uni_attendance_detail.uk_attendance_detail(attendance_id, student_id, edu_stage)`
        //    （软删行仍占键）。老表只有普通索引，所以老表模式一直"看起来正常"。
      } else {
        attendanceId = baseInsert(user).id as string;
        await tblInsTrx(trx, SRC, ATT_T, STAGE, {
          ...baseInsert(user),
          id: attendanceId,
          class_id: b.classId,
          class_name: cls.class_name as string,
          attendance_date: date,
          should_count: b.shouldCount,
          present_count: b.presentCount,
          absent_count: absentCount,
          attendance_rate: rate,
          teacher_name: b.teacherName ?? (cls.teacher_name as string) ?? null,
          head_teacher_name: (cls.head_teacher_name as string) ?? null,
        });
      }

      // 缺勤明细按（本次考勤 + 学生）upsert：已存在则原地更新（含复活软删行），否则插入
      const submittedAbsents = new Set(b.absents.map((a) => String(a.studentId)));
      const prevAbsents = (await tblTrx(trx, SRC, ABS_T, STAGE)
        .where({ attendance_id: attendanceId })
        .select('id', 'student_id')) as Array<Record<string, unknown>>;
      const prevAbsentMap = new Map(
        prevAbsents.map((d) => [String(d.student_id), String(d.id)]),
      );
      const staleAbsents = prevAbsents.filter((d) => !submittedAbsents.has(String(d.student_id)));
      if (staleAbsents.length) {
        await tblTrx(trx, SRC, ABS_T, STAGE)
          .whereIn(
            'id',
            staleAbsents.map((d) => String(d.id)),
          )
          .update(
            (await uniUpdCols(db, SRC, ABS_T, {
              is_deleted: 1,
              ...baseUpdate(user),
            })) as never,
          );
      }

      for (const a of b.absents) {
        const stu = (await tblTrx(trx, SRC, STU_T, STAGE).where({ id: a.studentId, is_deleted: 0 }).first()) as
          | Record<string, unknown>
          | undefined;
        if (!stu) throw Errors.studentNotFound(`缺勤学员不存在：${a.studentId}`);
        const absentPayload = {
          attendance_id: attendanceId,
          student_id: a.studentId,
          student_no: stu.student_no as string,
          student_name: stu.student_name as string,
          class_name: cls.class_name as string,
          phone: (stu.phone as string) ?? null,
          absent_reason: a.absentReason,
        };
        const prevId = prevAbsentMap.get(String(a.studentId));
        if (prevId) {
          await tblTrx(trx, SRC, ABS_T, STAGE)
            .where({ id: prevId })
            .update(
              (await uniUpdCols(db, SRC, ABS_T, {
                ...absentPayload,
                is_deleted: 0,
                ...baseUpdate(user),
              })) as never,
            );
        } else {
          await tblInsTrx(trx, SRC, ABS_T, STAGE, {
            ...baseInsert(user),
            ...absentPayload,
          });
        }
      }

      // 班级出勤率取最近一次
      await tblTrx(trx, SRC, CLS_T, STAGE).where({ id: b.classId }).update(
        (await uniUpdCols(db, SRC, CLS_T, { attendance_rate: rate, ...baseUpdate(user) })) as never,
      );
    });

    return ok(
      res,
      { classId: b.classId, attendanceDate: date, absentCount, attendanceRate: rate },
      `${date} 考勤已保存（缺勤 ${absentCount} 人）`,
    );
  }),
);

/**
 * @openapi
 * /api/class/attendance/detail:
 *   get:
 *     tags: [教务运行]
 *     summary: 某条出勤记录详情（含缺勤明细）
 *     parameters:
 *       - { in: query, name: id, schema: { type: string }, required: true }
 *     responses:
 *       200: { description: 详情 }
 */
attendanceRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少出勤记录ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { id } = q<{ id: string }>(req);

    const row = (await notDeleted(ATT()).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.param('出勤记录不存在');
    assertClassAccess(user, row.class_id as string, '该班级');

    const absents = (await notDeleted(ABS())
      .where('attendance_id', id)
      .orderBy('student_no')) as Array<Record<string, unknown>>;

    return ok(
      res,
      {
        record: { ...rowsToCamel<Record<string, unknown>>([row])[0], attendanceRate: Number(row.attendance_rate ?? 0) },
        absents: rowsToCamel(absents),
      },
      '查询成功',
    );
  }),
);

/** 缺勤明细单独取（花名册里点「缺勤」时用） */
attendanceRouter.get(
  '/absent/list',
  validate({
    query: z.object({
      ...pageQuerySchema.shape,
      classId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<{ page: number; size: number; classId?: string; startDate?: string; endDate?: string }>(req);

    // ★ 第 10 批：`tbl()` 只映射单表 + 注入 edu_stage，不支持 JOIN 两张表
    //   → 本接口是全项目唯一一处「缺勤明细 JOIN 出勤主表拿日期/班级」的写法，
    //   只能手写切读分支。老表分支保持原样，零行为变化。
    //
    // ⚠️ 老表分支 select 了 `t.class_name`，它与 `a.class_name` 同名，
    //   MySQL 结果集里**后面的 t.class_name 会覆盖前面的 a.class_name**，
    //   所以老表实际返回的是主表的班级名。
    //   → 切读分支必须**同样不加别名**，否则同一字段两分支含义不同（前端会时好时坏）。
    const base = commonDb('t_uni_attendance_detail as a')
      .leftJoin('t_uni_attendance as t', 'a.attendance_id', 't.id')
      .where('a.edu_stage', STAGE)
      .where('t.edu_stage', STAGE)
      .where('a.is_deleted', 0)
      .where('t.is_deleted', 0)
      // 显式列清单而非 a.*：a.* 会带出 edu_stage/stage_code/parent_phone 等列，
      // 前端拿到的结构与历史契约不同
      .select(
        'a.id',
        'a.create_time',
        'a.create_by',
        'a.update_time',
        'a.update_by',
        'a.is_deleted',
        'a.attendance_id',
        'a.student_id',
        'a.student_no',
        'a.student_name',
        'a.phone',
        'a.absent_reason',
        't.attendance_date',
        't.class_id',
        't.class_name',
      );

    applyDataScope(base, user, { classIdColumn: 't.class_id' });
    if (query.classId) base.where('t.class_id', query.classId);
    if (query.startDate) base.where('t.attendance_date', '>=', query.startDate);
    if (query.endDate) base.where('t.attendance_date', '<=', query.endDate);
    base.orderBy('t.attendance_date', 'desc');

    const paged = await paginate(base as unknown as Knex.QueryBuilder, query, async (qb) =>
      rowsToCamel(await (qb as unknown as Knex.QueryBuilder) as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);
