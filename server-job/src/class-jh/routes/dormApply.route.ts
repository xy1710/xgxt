/**
 * 调宿管理路由（教学管理初高）
 *
 * 覆盖：add / list / approve（物品完好校验 + 变更床位）/ reject。
 * 表：t_class_dorm_apply（含 t_class_room/bed/resident 联动）。
 * 挂载：/api/class/dormApply。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, APPLY_STATUS_NAME, DORM_TYPE_NAME, GENDER_NAME } from 'shared-types/class-jh';
import { ApplyStatus, DormType } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
// ★ P4 切读层：本文件五张表（t_class_dorm_apply / t_class_room / t_class_bed /
//   t_class_dorm_resident / t_class_student）均已归一，全部走 tbl()/tblIns() 路由；
//   开关关时与原实现逐字节等价。
import { tbl, tblIns } from '../../teaching/shared/uniTable';

const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

export const dormApplyRouter = Router();

const APPLY_TABLE = 't_class_dorm_apply';
const ROOM_TABLE = 't_class_room';
const BED_TABLE = 't_class_bed';
const RESIDENT_TABLE = 't_class_dorm_resident';
const STUDENT_TABLE = 't_class_student';

function toApply(a: any) {
  return {
    applyId: a.id,
    studentId: a.student_id,
    studentNo: a.student_no,
    studentName: a.student_name,
    classId: a.class_id,
    className: a.class_name,
    fromRoomId: a.from_room_id,
    fromRoomNo: a.from_room_no,
    fromBedId: a.from_bed_id,
    toRoomId: a.to_room_id,
    toRoomNo: a.to_room_no,
    toBedId: a.to_bed_id,
    applyReason: a.apply_reason,
    applyUserId: a.apply_user_id,
    applyUserName: a.apply_user_name,
    applyTime: a.apply_time,
    applyStatus: a.apply_status,
    applyStatusName: nameOf(APPLY_STATUS_NAME, a.apply_status),
    approveUserId: a.approve_user_id,
    approveUserName: a.approve_user_name,
    approveTime: a.approve_time,
    isItemIntact: a.is_item_intact,
    rejectReason: a.reject_reason,
  };
}

async function recalcRoom(roomId: string, now: Date): Promise<void> {
  const rows = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ room_id: roomId, is_active: true, is_deleted: false }).select('id');
  await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: roomId }).update({ occupied_count: rows.length, update_time: now });
}

/* ============================================================
 * 1. 调宿列表
 *   GET /api/class/dormApply/list
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  applyStatus: z.coerce.number().int().optional(),
  classId: z.string().optional(),
  keyword: z.string().optional(),
});

dormApplyRouter.get(
  '/list',
  checkPermission('class:dormApply:view'),
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const query = tbl(db, DB, APPLY_TABLE, STAGE).where('is_deleted', false);
    if (q.applyStatus) query.andWhere('apply_status', q.applyStatus);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.keyword) {
      query.andWhere((qb) => {
        qb.where('student_no', 'like', `%${q.keyword}%`).orWhere('student_name', 'like', `%${q.keyword}%`);
      });
    }

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('create_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map(toApply);

    // 申请表只存 room_no / bed_id —— 这里批量补「楼栋名 + 床位号」，
    // 否则前端「原房间/床位」只能显示一串床位 UUID（看不懂）。
    const roomIds = [...new Set<string>(rows.flatMap((r: any) => [r.from_room_id, r.to_room_id] as string[]).filter(Boolean))];
    const bedIds = [...new Set<string>(rows.flatMap((r: any) => [r.from_bed_id, r.to_bed_id] as string[]).filter(Boolean))];
    const roomRows = roomIds.length
      ? await tbl(db, DB, ROOM_TABLE, STAGE).whereIn('id', roomIds).select('id', 'building_name')
      : [];
    const bedRows = bedIds.length ? await tbl(db, DB, BED_TABLE, STAGE).whereIn('id', bedIds).select('id', 'bed_no') : [];
    const roomMap = new Map(roomRows.map((r: any) => [r.id, r.building_name]));
    const bedMap = new Map(bedRows.map((b: any) => [b.id, b.bed_no]));

    for (const it of list as any[]) {
      it.fromBuildingName = roomMap.get(it.fromRoomId) ?? null;
      it.toBuildingName = roomMap.get(it.toRoomId) ?? null;
      it.fromBedNo = bedMap.get(it.fromBedId) ?? null;
      it.toBedNo = bedMap.get(it.toBedId) ?? null;
    }

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 2. 新增调宿申请
 *   POST /api/class/dormApply/add
 * ============================================================ */

const addSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  fromRoomId: z.string().min(1, '原房间必填'),
  fromBedId: z.string().optional(),
  toRoomId: z.string().min(1, '目标房间必填'),
  toBedId: z.string().min(1, '目标床位必填'),
  applyReason: z.string().min(1, '换宿原因必填'),
});

dormApplyRouter.post(
  '/add',
  checkPermission('class:dormApply:add'),
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const fromRoom = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: body.fromRoomId, is_deleted: false }).first();
    if (!fromRoom) throw new BizError(BizCode.DORM_NOT_FOUND, '原房间不存在');
    const toRoom = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: body.toRoomId, is_deleted: false }).first();
    if (!toRoom) throw new BizError(BizCode.DORM_NOT_FOUND, '目标房间不存在');
    const toBed = await tbl(db, DB, BED_TABLE, STAGE).where({ id: body.toBedId, is_deleted: false }).first();
    if (!toBed) throw new BizError(BizCode.DORM_NOT_FOUND, '目标床位不存在');
    if (toBed.room_id !== toRoom.id) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '目标床位不属于目标房间');

    // 目标床位占用校验（待审核时提醒，审批时会再校验）
    if (toBed.bed_status && toBed.bed_status !== '空闲') {
      throw new BizError(BizCode.BED_OCCUPIED, `目标床位 ${toBed.bed_no} 已被占用`);
    }
    // 性别校验
    const expectedDormType = stu.gender === 1 ? DormType.MALE_DORM : DormType.FEMALE_DORM;
    if (toRoom.dorm_type !== expectedDormType) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        `学生性别（${nameOf(GENDER_NAME, stu.gender)}）与目标房间类型（${nameOf(DORM_TYPE_NAME, toRoom.dorm_type)}）不匹配`,
      );
    }

    // 原床位：优先取入参，否则取学生在住床位
    let fromBedId = body.fromBedId;
    let fromBedNo: string | null = null;
    if (fromBedId) {
      const fb = await tbl(db, DB, BED_TABLE, STAGE).where({ id: fromBedId, is_deleted: false }).first();
      fromBedNo = fb?.bed_no ?? null;
    } else {
      const resident = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ student_id: stu.id, is_active: true, is_deleted: false }).first();
      if (resident) {
        fromBedId = resident.bed_id;
        fromBedNo = resident.bed_no;
      }
    }

    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, APPLY_TABLE, STAGE, {
      id,
      student_id: stu.id,
      student_no: stu.student_no,
      student_name: stu.student_name,
      class_id: stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      from_room_id: fromRoom.id,
      from_room_no: fromRoom.room_no,
      from_bed_id: fromBedId ?? null,
      to_room_id: toRoom.id,
      to_room_no: toRoom.room_no,
      to_bed_id: toBed.id,
      apply_reason: body.applyReason,
      apply_user_id: req.user?.userId ?? null,
      apply_user_name: req.user?.userName ?? null,
      apply_time: now,
      apply_status: ApplyStatus.PENDING,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    res.json(ok({ id }, '调宿申请已提交'));
  }),
);

/* ============================================================
 * 3. 调宿审批（物品完好校验 + 变更床位）
 *   POST /api/class/dormApply/approve
 * ============================================================ */

const approveSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  isItemIntact: z.coerce.boolean(),
});

dormApplyRouter.post(
  '/approve',
  checkPermission('class:dormApply:approve'),
  validate(approveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof approveSchema>;

    const apply = await tbl(db, DB, APPLY_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!apply) throw new BizError(BizCode.DORM_NOT_FOUND, '调宿申请不存在');
    if (apply.apply_status !== ApplyStatus.PENDING) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅待审核的调宿申请可审批');
    }
    if (!body.isItemIntact) {
      throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '须确认原宿舍物品完好后方可同意调宿');
    }

    // 目标床位占用校验
    const toBed = await tbl(db, DB, BED_TABLE, STAGE).where({ id: apply.to_bed_id, is_deleted: false }).first();
    if (!toBed) throw new BizError(BizCode.DORM_NOT_FOUND, '目标床位不存在');
    if (toBed.student_id && toBed.student_id !== apply.student_id) {
      throw new BizError(BizCode.BED_OCCUPIED, `目标床位 ${toBed.bed_no} 已被占用`);
    }

    const now = new Date();

    // 释放原床位（若有在住）
    const resident = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ student_id: apply.student_id, is_active: true, is_deleted: false }).first();
    if (resident) {
      await tbl(db, DB, BED_TABLE, STAGE).where({ id: resident.bed_id }).update({ bed_status: '空闲', student_id: null, update_time: now });
      await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ id: resident.id }).update({ is_active: false, update_time: now });
      await recalcRoom(resident.room_id, now);
    }

    // 占用目标床位 + 新建入住
    const room = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: apply.to_room_id }).first();
    await tbl(db, DB, BED_TABLE, STAGE).where({ id: toBed.id }).update({ bed_status: '已占用', student_id: apply.student_id, update_time: now });
    await tblIns(db, DB, RESIDENT_TABLE, STAGE, {
      id: randomUUID(),
      student_id: apply.student_id,
      student_no: apply.student_no,
      student_name: apply.student_name,
      class_id: apply.class_id ?? null,
      class_name: apply.class_name ?? null,
      gender: null,
      building_id: room?.building_id ?? null,
      room_id: apply.to_room_id,
      room_no: apply.to_room_no,
      bed_id: toBed.id,
      bed_no: toBed.bed_no,
      check_in_date: now.toISOString().slice(0, 10),
      owner_name: room?.owner_name ?? null,
      is_active: true,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });
    await recalcRoom(apply.to_room_id, now);

    // 回写学生宿舍字段
    await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: apply.student_id }).update({
      dorm_id: apply.to_room_id,
      dorm_no: apply.to_room_no,
      bed_no: toBed.bed_no,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    // 申请状态 → 已同意
    await tbl(db, DB, APPLY_TABLE, STAGE).where({ id: body.id }).update({
      apply_status: ApplyStatus.APPROVED,
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      is_item_intact: true,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '调宿',
      bizId: body.id,
      studentId: apply.student_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `调宿审批通过：${apply.from_room_no || ''} → ${apply.to_room_no} ${toBed.bed_no} 床`,
      beforeValue: { roomId: apply.from_room_id, bedId: apply.from_bed_id },
      afterValue: { roomId: apply.to_room_id, bedId: toBed.id },
    });

    res.json(ok(null, '调宿成功'));
  }),
);

/* ============================================================
 * 4. 调宿驳回
 *   POST /api/class/dormApply/reject
 * ============================================================ */

const rejectSchema = z.object({
  id: z.string().min(1, '必须传 id'),
  rejectReason: z.string().min(1, '驳回原因必填'),
});

dormApplyRouter.post(
  '/reject',
  checkPermission('class:dormApply:approve'),
  validate(rejectSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof rejectSchema>;
    const apply = await tbl(db, DB, APPLY_TABLE, STAGE).where({ id: body.id, is_deleted: false }).first();
    if (!apply) throw new BizError(BizCode.DORM_NOT_FOUND, '调宿申请不存在');
    if (apply.apply_status !== ApplyStatus.PENDING) {
      throw new BizError(BizCode.ILLEGAL_STATE_TRANSITION, '仅待审核的调宿申请可驳回');
    }

    await tbl(db, DB, APPLY_TABLE, STAGE).where({ id: body.id }).update({
      apply_status: ApplyStatus.REJECTED,
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: new Date(),
      reject_reason: body.rejectReason,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '调宿',
      bizId: body.id,
      studentId: apply.student_id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `调宿驳回：${body.rejectReason}`,
      afterValue: { applyStatus: ApplyStatus.REJECTED },
    });

    res.json(ok(null, '已驳回'));
  }),
);

export default dormApplyRouter;
