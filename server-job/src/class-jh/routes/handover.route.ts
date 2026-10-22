/**
 * 师资交接 + 学期路由（教学管理初高）
 *
 * 挂载点：/api/class（路径含 /handover/*、/term/*）
 * 表：t_class_handover、t_class_term。
 *
 * 交接副作用：更新班级 head_teacher/teacher 及学生冗余字段，并写 op_log。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, HANDOVER_ROLE_NAME } from 'shared-types/class-jh';
import { HandoverRole } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P4 切读层：本文件各表均已归一，裸 db() 全部走 tbl()/tblIns()；开关关时逐字节等价。
import { tbl, tblIns } from '../../teaching/shared/uniTable';

export const handoverRouter = Router();

const HANDOVER_TABLE = 't_class_handover';
const TERM_TABLE = 't_class_term';
const CLASS_TABLE = 't_class_info';
const STUDENT_TABLE = 't_class_student';

const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

/* ============================================================
 * 1. 交接列表
 *   GET /api/class/handover/list
 * ============================================================ */

const handoverListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

handoverRouter.get(
  '/handover/list',
  checkPermission('class:handover:view'),
  validate(handoverListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof handoverListSchema>;

    const query = tbl(db, DB, HANDOVER_TABLE, STAGE).where('is_deleted', false);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.startDate) query.andWhere('handover_time', '>=', `${q.startDate} 00:00:00`);
    if (q.endDate) query.andWhere('handover_time', '<=', `${q.endDate} 23:59:59`);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('handover_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((h: any) => ({
      handoverId: h.id,
      classId: h.class_id,
      className: h.class_name,
      handoverRole: h.handover_role,
      handoverRoleName: nameOf(HANDOVER_ROLE_NAME, h.handover_role),
      fromUserId: h.from_user_id,
      fromUserName: h.from_user_name,
      toUserId: h.to_user_id,
      toUserName: h.to_user_name,
      handoverReason: h.handover_reason,
      handoverContent: h.handover_content,
      handoverTime: h.handover_time,
      arrangeUserId: h.arrange_user_id,
      arrangeUserName: h.arrange_user_name,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 新增交接（更新班级/user + op_log）
 *   POST /api/class/handover/add
 * ============================================================ */

const handoverAddSchema = z.object({
  classId: z.string().min(1, '班级必填'),
  handoverRole: z.coerce.number().int().min(1).max(2, '交接岗位只能是 1(班主任) 或 2(教员)'),
  toUserId: z.string().min(1, '接管人必填'),
  // ⚠️ t_class_handover.to_user_name 与 t_class_info.head_teacher_name/teacher_name 都是 NOT NULL 列。
  //    接管人姓名必填（缺失返回 40002）—— 不能用空串兜底，否则"交接成功"却把班级与全班学生的
  //    班主任/教员姓名静默清空（违反《项目骨架》"宁可报错，不静默跑错"的设计哲学）。
  toUserName: z.string().min(1, '接管人姓名必填'),
  handoverReason: z.string().max(500).optional(),
  handoverContent: z.string().min(1, '交接内容必填'),
});

handoverRouter.post(
  '/handover/add',
  checkPermission('class:handover:add'),
  validate(handoverAddSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof handoverAddSchema>;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const isHead = body.handoverRole === HandoverRole.HEAD_TEACHER;
    const fromUserId = isHead ? cls.head_teacher_id : cls.teacher_id;
    const fromUserName = isHead ? cls.head_teacher_name : cls.teacher_name;

    const id = randomUUID();
    const now = new Date();

    // 1) 交接记录
    await tblIns(db, DB, HANDOVER_TABLE, STAGE, {
      id,
      class_id: cls.id,
      class_name: cls.class_name,
      handover_role: body.handoverRole,
      from_user_id: fromUserId ?? null,
      from_user_name: fromUserName ?? null,
      to_user_id: body.toUserId,
      to_user_name: body.toUserName,
      handover_reason: body.handoverReason ?? null,
      handover_content: body.handoverContent,
      handover_time: now,
      arrange_user_id: req.user?.userId ?? null,
      arrange_user_name: req.user?.userName ?? null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    // 2) 更新班级岗位（t_class_info.head_teacher_name/teacher_name 为 NOT NULL，写入必填的接管人姓名）
    await tbl(db, DB, CLASS_TABLE, STAGE)
      .where({ id: cls.id })
      .update(
        isHead
          ? { head_teacher_id: body.toUserId, head_teacher_name: body.toUserName, update_time: now }
          : { teacher_id: body.toUserId, teacher_name: body.toUserName, update_time: now },
      );

    // 3) 同步学生冗余字段
    await tbl(db, DB, STUDENT_TABLE, STAGE)
      .where({ class_id: cls.id, is_deleted: false })
      .update(
        isHead
          ? { head_teacher_id: body.toUserId, head_teacher_name: body.toUserName, update_time: now }
          : { teacher_id: body.toUserId, teacher_name: body.toUserName, update_time: now },
      );

    // 4) op_log
    await writeOpLog({
      module: 'class',
      bizType: '交接',
      bizId: id,
      classId: cls.id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `班级 ${cls.class_name} ${nameOf(HANDOVER_ROLE_NAME, body.handoverRole)} 交接：${fromUserName || '—'} → ${body.toUserName}`,
      beforeValue: { [isHead ? 'headTeacherId' : 'teacherId']: fromUserId },
      afterValue: { [isHead ? 'headTeacherId' : 'teacherId']: body.toUserId, toUserName: body.toUserName },
    });

    res.json(ok({ id }, '交接成功'));
  }),
);

/* ============================================================
 * 3. 学期列表
 *   GET /api/class/term/list
 * ============================================================ */

handoverRouter.get(
  '/term/list',
  checkPermission('class:classInfo:view'),
  validate(z.object({ classId: z.string().min(1, '班级必填') })),
  wrap(async (req, res) => {
    const { classId } = (req as any).validated as { classId: string };
    const rows = await tbl(db, DB, TERM_TABLE, STAGE)
      .where({ class_id: classId, is_deleted: false })
      .orderBy('start_date', 'asc');

    res.json(
      ok(
        rows.map((t: any) => ({
          termId: t.id,
          classId: t.class_id,
          className: t.class_name,
          termName: t.term_name,
          startDate: t.start_date,
          endDate: t.end_date,
          remark: t.remark,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 学期新增
 *   POST /api/class/term/add
 * ============================================================ */

const termAddSchema = z.object({
  classId: z.string().min(1, '班级必填'),
  termName: z.string().min(1, '学期名称必填'),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  remark: z.string().max(500).optional(),
});

handoverRouter.post(
  '/term/add',
  checkPermission('class:classInfo:edit'),
  validate(termAddSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof termAddSchema>;

    const cls = await tbl(db, DB, CLASS_TABLE, STAGE).where({ id: body.classId, is_deleted: false }).first();
    if (!cls) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在');

    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, TERM_TABLE, STAGE, {
      id,
      class_id: cls.id,
      class_name: cls.class_name,
      term_name: body.termName,
      start_date: body.startDate ?? null,
      end_date: body.endDate ?? null,
      remark: body.remark ?? null,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

export default handoverRouter;
