/**
 * 宿舍分配路由（信息档案 - 宿舍分配）
 *
 * 业务流程：
 *   1. 先有宿舍台账（t_dorm：楼栋/楼层/宿舍号/男女寝/总床位）
 *   2. 给「还没分宿舍」的学生分配宿舍 → 校验性别 + 床位
 *   3. 可调整宿舍（换寝室）/ 退宿（清空、释放床位）
 *
 * ⚠️ 已住人数是【实时统计】出来的，不落库。
 *    落库就会有対不上的一天（比如删了学生没减床位），统计永远准。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  GENDER_NAME,
  DORM_TYPE_NAME,
  STUDENT_STATUS_NAME,
  JOB_STUDENT_STATUS_LIST,
  DormType,
  StudentStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
// ★ 阶段隔离（班主任只看大学 / 项目经理只看实训）
import { applyTrainingScope, myTrainingClassIds, operatorOf } from '../utils/stageScope';
// ★ P3 切读层：本文件 2 张老表（t_dorm / t_student_base）都已归一，
//   读写全部走 tbl()/tblIns()；开关关时与原实现等价。
import { tbl, tblIns } from '../teaching/shared/uniTable';

export const empDormRouter = Router();

const TABLE = 't_dorm';
const STUDENT = 't_student_base';

/** ★ 统一表 edu_stage 取值 / 老表所在库（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 统计某宿舍已住人数 */
async function countUsed(dormId: string): Promise<number> {
  const [{ total }] = (await tbl(db, DB, STUDENT, STAGE)
    .where({ dorm_id: dormId, is_deleted: false })
    .count({ total: '*' })) as Array<{ total: number }>;
  return Number(total);
}

/* ============================================================
 * 1. 宿舍列表
 *    GET /api/job/dorm/list?page=1&size=20&building=A栋&roomType=1
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  dormNo: z.string().optional(),
  building: z.string().optional(),
  roomType: z.coerce.number().int().optional(),
  onlyAvailable: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

empDormRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as {
      page: number;
      size: number;
      dormNo?: string;
      building?: string;
      roomType?: number;
      onlyAvailable?: boolean;
    };

    const query = tbl(db, DB, TABLE, STAGE).where('is_deleted', false);
    // ★ t_dorm 是「房间台账」，既没有 class_id 也不存 student_id
    //   → via='dorm'：用「我班学生住过的房间 id」反查
    await applyTrainingScope(query, req, { table: TABLE, dbName: DB, via: 'dorm' });

    if (q.dormNo) query.andWhere('dorm_no', 'like', `%${q.dormNo}%`);
    if (q.building) query.andWhere('building', 'like', `%${q.building}%`);
    if (q.roomType) query.andWhere('room_type', q.roomType);

    const rows = await query.clone().select('*').orderBy(['building', 'dorm_no']);

    // ---- 逐个算已住人数，再过滤「只看有空位」 ----
    const all = [];
    for (const r of rows) {
      const used = await countUsed(r.id);
      all.push({
        id: r.id,
        dormNo: r.dorm_no,
        building: r.building,
        floor: r.floor,
        roomType: r.room_type,
        roomTypeName: DORM_TYPE_NAME[r.room_type] || '',
        bedTotal: r.bed_total,
        bedUsed: used,
        remark: r.remark,
        createTime: r.create_time,
      });
    }

    const filtered = q.onlyAvailable ? all.filter((d) => d.bedUsed < d.bedTotal) : all;

    const total = filtered.length;
    const list = filtered.slice((q.page - 1) * q.size, q.page * q.size);

    res.json(page(list, total, q));
  }),
);

/* ============================================================
 * 2. 宿舍详情
 *    GET /api/job/dorm/detail?id=xxx
 * ============================================================ */

empDormRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '宿舍不存在');

    res.json(ok({
      id: row.id,
      dormNo: row.dorm_no,
      building: row.building,
      floor: row.floor,
      roomType: row.room_type,
      roomTypeName: DORM_TYPE_NAME[row.room_type] || '',
      bedTotal: row.bed_total,
      bedUsed: await countUsed(row.id),
      remark: row.remark,
    }));
  }),
);

/* ============================================================
 * 3. 宿舍成员
 *    GET /api/job/dorm/members?dormId=xxx
 * ============================================================ */

empDormRouter.get(
  '/members',
  validate(z.object({ dormId: z.string().min(1, '必须传 dormId') })),
  wrap(async (req, res) => {
    const { dormId } = (req as any).validated as { dormId: string };

    const query = tbl(db, DB, STUDENT, STAGE)
      .where({ dorm_id: dormId, is_deleted: false });
    // ★ 成员名单也是「我班的学生」才给看（t_student_base 有 class_id，直接按列过滤）
    await applyTrainingScope(query, req, { table: STUDENT, dbName: DB });

    const rows = await query
      .select('id', 'student_no', 'student_name', 'gender', 'class_name', 'phone', 'student_status')
      .orderBy('create_time', 'asc');

    res.json(ok(rows.map((r: any) => ({
      studentId: r.id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      className: r.class_name,
      phone: r.phone,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
    }))));
  }),
);

/* ============================================================
 * 4. 待分配宿舍的学生
 *    GET /api/job/dorm/unassigned-students?studentName=张&gender=1
 * ============================================================ */

const unassignedSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentName: z.string().optional(),
  gender: z.coerce.number().int().optional(),
});

empDormRouter.get(
  '/unassigned-students',
  validate(unassignedSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as {
      page: number;
      size: number;
      studentName?: string;
      gender?: number;
    };

    // 只认「待就业 / 已就业」的在读学生 —— 休学、退学的学生本来就不占床位，
    // 放进待分配列表里会给老师造成误导
    const query = tbl(db, DB, STUDENT, STAGE)
      .where('is_deleted', false)
      .whereIn('student_status', [...JOB_STUDENT_STATUS_LIST])
      .whereNotIn('student_status', [StudentStatus.SUSPENDED, StudentStatus.QUIT])
      .where(function () {
        this.whereNull('dorm_id').orWhere('dorm_no', '');
      });
    // ★ 别把别班的学生列进来让我分配
    await applyTrainingScope(query, req, { table: STUDENT, dbName: DB });

    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.gender) query.andWhere('gender', q.gender);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;

    const rows = await query
      .clone()
      .select('id', 'student_no', 'student_name', 'gender', 'class_name', 'phone', 'student_status')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map((r: any) => ({
      studentId: r.id,
      studentNo: r.student_no,
      studentName: r.student_name,
      gender: r.gender,
      genderName: GENDER_NAME[r.gender] || '',
      className: r.class_name,
      phone: r.phone,
      studentStatus: r.student_status,
      studentStatusName: STUDENT_STATUS_NAME[r.student_status] || '',
    })), Number(total), q));
  }),
);

/* ============================================================
 * 5. 新增宿舍
 *    POST /api/job/dorm/add
 * ============================================================ */

const saveSchema = z.object({
  dormNo: z.string().min(1, '宿舍号必填').max(20),
  building: z.string().min(1, '楼栋必填').max(20),
  floor: z.coerce.number().int().min(1).max(30),
  roomType: z.coerce.number().int().min(1).max(2, '宿舍类型只能是 1(男寝) 或 2(女寝)'),
  bedTotal: z.coerce.number().int().min(1).max(20, '床位数应在 1~20 之间'),
  remark: z.string().max(500).optional(),
});

empDormRouter.post(
  '/add',
  validate(saveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof saveSchema>;

    const exists = await tbl(db, DB, TABLE, STAGE).where({ dorm_no: body.dormNo, is_deleted: false }).first();
    if (exists) {
      throw new BizError(BizCode.PARAM_ERROR, `宿舍号 ${body.dormNo} 已存在`);
    }

    const id = randomUUID();
    await tblIns(db, DB, TABLE, STAGE, {
      id,
      dorm_no: body.dormNo,
      building: body.building,
      floor: body.floor,
      room_type: body.roomType,
      bed_total: body.bedTotal,
      remark: body.remark ?? null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 6. 修改宿舍
 *    PUT /api/job/dorm/update
 * ============================================================ */

const updateSchema = saveSchema.extend({ id: z.string().min(1, '必须传 id') });

empDormRouter.put(
  '/update',
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '宿舍不存在');

    const dup = await tbl(db, DB, TABLE, STAGE)
      .where({ dorm_no: body.dormNo, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dup) {
      throw new BizError(BizCode.PARAM_ERROR, `宿舍号 ${body.dormNo} 已被占用`);
    }

    const used = await countUsed(body.id);
    // ⚠️ 缩床位不能小于已住人数，否则数据就自相矛盾了
    if (body.bedTotal < used) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `该宿舍已住 ${used} 人，总床位不能小于已住人数`,
      );
    }

    await tbl(db, DB, TABLE, STAGE).where({ id: body.id }).update({
      dorm_no: body.dormNo,
      building: body.building,
      floor: body.floor,
      room_type: body.roomType,
      bed_total: body.bedTotal,
      remark: body.remark ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // 宿舍号改了，要同步到已住学生身上
    if (row.dorm_no !== body.dormNo) {
      await tbl(db, DB, STUDENT, STAGE).where({ dorm_id: body.id }).update({ dorm_no: body.dormNo });
    }

    res.json(ok(null, '修改成功'));
  }),
);

/* ============================================================
 * 7. 删除宿舍
 *    DELETE /api/job/dorm/delete/:id
 * ============================================================ */

empDormRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await tbl(db, DB, TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '宿舍不存在或已被删除');

    const used = await countUsed(id);
    if (used > 0) {
      throw new BizError(BizCode.PARAM_ERROR, `该宿舍还有 ${used} 人居住，请先办理退宿再删除`);
    }

    await tbl(db, DB, TABLE, STAGE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 8. 分配宿舍（新增分配 / 调整宿舍 共用这一个接口）
 *    POST /api/job/dorm/assign  { studentId, dormId }
 * ============================================================ */

const assignSchema = z.object({
  studentId: z.string().min(1, '请选择学生'),
  dormId: z.string().min(1, '请选择宿舍'),
});

empDormRouter.post(
  '/assign',
  validate(assignSchema),
  wrap(async (req, res) => {
    const { studentId, dormId } = (req as any).validated as z.infer<typeof assignSchema>;

    const student = await tbl(db, DB, STUDENT, STAGE).where({ id: studentId, is_deleted: false }).first();
    if (!student) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const dorm = await tbl(db, DB, TABLE, STAGE).where({ id: dormId, is_deleted: false }).first();
    if (!dorm) throw new BizError(BizCode.PARAM_ERROR, '宿舍不存在');

    // ---- 校验 1：性别必须对得上 ----
    const expectGender = dorm.room_type === DormType.MALE_DORM ? 1 : 2;
    if (student.gender !== expectGender) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `性别不匹配：${dorm.dorm_no} 是${DORM_TYPE_NAME[dorm.room_type]}，不能安排${GENDER_NAME[student.gender]}生入住`,
      );
    }

    // ---- 校验 2：床位不能超 ----
    const used = await countUsed(dormId);
    if (student.dorm_id !== dormId && used >= dorm.bed_total) {
      throw new BizError(BizCode.PARAM_ERROR, `宿舍 ${dorm.dorm_no} 床位已满（${used}/${dorm.bed_total}）`);
    }

    const isTransfer = !!student.dorm_id && student.dorm_id !== dormId;

    await tbl(db, DB, STUDENT, STAGE).where({ id: studentId }).update({
      dorm_id: dormId,
      dorm_no: dorm.dorm_no,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, isTransfer ? '调整宿舍成功' : '分配成功'));
  }),
);

/* ============================================================
 * 9. 退宿（释放床位）
 *    POST /api/job/dorm/checkout  { studentId }
 * ============================================================ */

empDormRouter.post(
  '/checkout',
  validate(z.object({ studentId: z.string().min(1, '请选择学生') })),
  wrap(async (req, res) => {
    const { studentId } = (req as any).validated as { studentId: string };

    const student = await tbl(db, DB, STUDENT, STAGE).where({ id: studentId, is_deleted: false }).first();
    if (!student) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');
    if (!student.dorm_id) throw new BizError(BizCode.PARAM_ERROR, '该学生当前没有住宿');

    await tbl(db, DB, STUDENT, STAGE).where({ id: studentId }).update({
      dorm_id: null,
      dorm_no: null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '退宿成功'));
  }),
);

export default empDormRouter;
