/**
 * 宿舍管理路由（教学管理初高）
 *
 * 覆盖：building/room/resident list + room/detail + dispatch（分派床位）+ checkout（退宿）。
 * 表：t_class_building、t_class_room、t_class_bed、t_class_dorm_resident、t_class_checkout_apply。
 * 挂载：/api/class/dorm。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, DORM_TYPE_NAME, APPLY_STATUS_NAME, GENDER_NAME } from 'shared-types/class-jh';
import { DormType, ApplyStatus } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import { mobile } from '../utils/zodRules';
// ★ P4 切读层：本文件六张表（t_class_building / t_class_room / t_class_bed /
//   t_class_dorm_resident / t_class_checkout_apply / t_class_student）均已归一，
//   全部走 tbl()/tblIns()/tblTrx()/tblInsTrx() 路由；开关关时与原实现逐字节等价。
import { tbl, tblIns, tblInsTrx, tblTrx } from '../../teaching/shared/uniTable';

const DB = 'sms_class_jh';
const STAGE = 'jh' as const;

export const dormRouter = Router();

const BUILDING_TABLE = 't_class_building';
const ROOM_TABLE = 't_class_room';
const BED_TABLE = 't_class_bed';
const RESIDENT_TABLE = 't_class_dorm_resident';
const CHECKOUT_TABLE = 't_class_checkout_apply';
const STUDENT_TABLE = 't_class_student';

/** 楼栋行 → 实体（含派生统计） */
async function buildingToVO(b: any) {
  const rooms = await tbl(db, DB, ROOM_TABLE, STAGE).where({ building_id: b.id, is_deleted: false }).select('id', 'bed_count', 'occupied_count');
  const bedTotal = rooms.reduce((acc: number, r: any) => acc + (Number(r.bed_count) || 0), 0);
  const occupiedCount = rooms.reduce((acc: number, r: any) => acc + (Number(r.occupied_count) || 0), 0);
  return {
    buildingId: b.id,
    buildingName: b.building_name,
    campusName: b.campus_name,
    floorCount: b.floor_count,
    roomCount: rooms.length,
    occupiedCount,
    bedTotal,
    managerName: b.manager_name,
    managerPhone: b.manager_phone,
    deptName: b.dept_name,
    buildingStatus: b.building_status,
    dataSource: b.data_source,
  };
}

function roomToVO(r: any) {
  const bedCount = Number(r.bed_count) || 0;
  const occupied = Number(r.occupied_count) || 0;
  return {
    roomId: r.id,
    roomNo: r.room_no,
    buildingId: r.building_id,
    buildingName: r.building_name,
    floorNo: r.floor_no,
    dormType: r.dorm_type,
    dormTypeName: nameOf(DORM_TYPE_NAME, r.dorm_type),
    bedCount,
    occupiedCount: occupied,
    occupancyRate: bedCount > 0 ? Number(((occupied / bedCount) * 100).toFixed(2)) : 0,
    classId: r.class_id,
    className: r.class_name,
    ownerName: r.owner_name,
    dataSource: r.data_source,
    roomStatus: r.room_status,
  };
}

function residentToVO(v: any) {
  return {
    residentId: v.id,
    studentId: v.student_id,
    studentNo: v.student_no,
    studentName: v.student_name,
    classId: v.class_id,
    className: v.class_name,
    gender: v.gender,
    buildingId: v.building_id,
    buildingName: v.building_name,
    roomId: v.room_id,
    roomNo: v.room_no,
    bedId: v.bed_id,
    bedNo: v.bed_no,
    checkInDate: v.check_in_date,
    ownerName: v.owner_name,
    isActive: !!v.is_active,
  };
}

/** 重算房间已入住人数 */
async function recalcRoom(roomId: string, now: Date): Promise<void> {
  const rows = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ room_id: roomId, is_active: true, is_deleted: false }).select('id');
  await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: roomId }).update({ occupied_count: rows.length, update_time: now });
}

/* ============================================================
 * 1. 楼栋列表
 *   GET /api/class/dorm/building/list
 * ============================================================ */

dormRouter.get(
  '/building/list',
  checkPermission('class:dorm:view'),
  validate(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(100).default(20),
      keyword: z.string().optional(),
    }),
  ),
  wrap(async (req, res) => {
    const q = (req as any).validated as { page: number; size: number; keyword?: string };
    const query = tbl(db, DB, BUILDING_TABLE, STAGE).where('is_deleted', false);
    if (q.keyword) query.andWhere('building_name', 'like', `%${q.keyword}%`);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('building_name', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = await Promise.all(rows.map(buildingToVO));
    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 1.1 楼栋新增
 *   POST /api/class/dorm/building/add
 * ============================================================ */

const buildingSaveSchema = z.object({
  buildingId: z.string().optional(),
  buildingName: z.string().min(1, '楼栋名称必填').max(50),
  campusName: z.string().max(50).optional(),
  floorCount: z.coerce.number().int().min(0).optional(),
  managerName: z.string().max(50).optional(),
  managerPhone: mobile.optional(),
  deptName: z.string().max(50).optional(),
  buildingStatus: z.string().max(20).optional(),
});

dormRouter.post(
  '/building/add',
  checkPermission('class:dorm:add'),
  validate(buildingSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof buildingSaveSchema>;

    // ⚠️ 唯一性预检按「物理范围」查（含已逻辑删除的行）：uk_building_name 是物理唯一索引。
    const dup = await tbl(db, DB, BUILDING_TABLE, STAGE).where({ building_name: body.buildingName }).first();
    if (dup) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        dup.is_deleted
          ? `楼栋名称「${body.buildingName}」已被「已删除」的历史楼栋占用，不可复用`
          : `楼栋名称「${body.buildingName}」已存在`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    await tblIns(db, DB, BUILDING_TABLE, STAGE, {
      id,
      building_name: body.buildingName,
      campus_name: body.campusName ?? null,
      floor_count: body.floorCount ?? null,
      manager_name: body.managerName ?? null,
      manager_phone: body.managerPhone ?? null,
      dept_name: body.deptName ?? null,
      building_status: body.buildingStatus ?? '使用中',
      data_source: '手工录入',
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '楼栋',
      bizId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增楼栋 ${body.buildingName}`,
      afterValue: { buildingName: body.buildingName },
    });

    res.json(ok({ buildingId: id }, '新增成功'));
  }),
);

/* ============================================================
 * 1.2 楼栋修改
 *   PUT /api/class/dorm/building/update
 * ============================================================ */

dormRouter.put(
  '/building/update',
  checkPermission('class:dorm:edit'),
  validate(buildingSaveSchema.extend({ buildingId: z.string().min(1, '必须传 buildingId') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof buildingSaveSchema> & { buildingId: string };

    const exists = await tbl(db, DB, BUILDING_TABLE, STAGE).where({ id: body.buildingId, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.DORM_NOT_FOUND, '楼栋不存在');

    if (body.buildingName !== exists.building_name) {
      const dup = await tbl(db, DB, BUILDING_TABLE, STAGE).where({ building_name: body.buildingName }).whereNot('id', body.buildingId).first();
      if (dup) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `楼栋名称「${body.buildingName}」已被占用`);
    }

    const now = new Date();
    await tbl(db, DB, BUILDING_TABLE, STAGE).where({ id: body.buildingId }).update({
      building_name: body.buildingName,
      campus_name: body.campusName ?? null,
      floor_count: body.floorCount ?? null,
      manager_name: body.managerName ?? null,
      manager_phone: body.managerPhone ?? null,
      dept_name: body.deptName ?? null,
      building_status: body.buildingStatus ?? exists.building_status,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    // 楼栋名变更 → 同步房间的冗余楼栋名（床位表只存 building_id，无需同步）
    if (body.buildingName !== exists.building_name) {
      await tbl(db, DB, ROOM_TABLE, STAGE).where({ building_id: body.buildingId, is_deleted: false }).update({ building_name: body.buildingName, update_time: now });
    }

    await writeOpLog({
      module: 'dorm',
      bizType: '楼栋',
      bizId: body.buildingId,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `修改楼栋 ${body.buildingName}`,
      beforeValue: { buildingName: exists.building_name },
      afterValue: { buildingName: body.buildingName },
    });

    res.json(ok({ buildingId: body.buildingId }, '修改成功'));
  }),
);

/* ============================================================
 * 2. 房间列表
 *   GET /api/class/dorm/room/list
 * ============================================================ */

const roomListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  classId: z.string().optional(),
  dormType: z.coerce.number().int().optional(),
  roomStatus: z.string().optional(),
  occupiedCountMin: z.coerce.number().int().optional(),
});

dormRouter.get(
  '/room/list',
  checkPermission('class:dorm:view'),
  validate(roomListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof roomListSchema>;
    const query = tbl(db, DB, ROOM_TABLE, STAGE).where('is_deleted', false);
    if (q.classId) query.andWhere('class_id', q.classId);
    if (q.dormType) query.andWhere('dorm_type', q.dormType);
    if (q.roomStatus) query.andWhere('room_status', q.roomStatus);
    if (q.occupiedCountMin !== undefined) query.andWhere('occupied_count', '>=', q.occupiedCountMin);

    const [{ total }] = (await query.clone().count({ total: '*' })) as Array<{ total: number }>;
    const rows = await query
      .clone()
      .select('*')
      .orderBy('room_no', 'asc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map(roomToVO), Number(total), q));
  }),
);

/* ============================================================
 * 3. 房间详情（含床位）
 *   GET /api/class/dorm/room/detail?id=xxx
 * ============================================================ */

dormRouter.get(
  '/room/detail',
  checkPermission('class:dorm:view'),
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };
    const room = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id, is_deleted: false }).first();
    if (!room) throw new BizError(BizCode.DORM_NOT_FOUND, '房间不存在');

    const beds = await tbl(db, DB, BED_TABLE, STAGE).where({ room_id: id, is_deleted: false }).orderBy('bed_no', 'asc');
    res.json(
      ok({
        ...roomToVO(room),
        beds: beds.map((b: any) => ({
          bedId: b.id,
          roomId: b.room_id,
          roomNo: b.room_no,
          buildingId: b.building_id,
          bedNo: b.bed_no,
          dormType: b.dorm_type,
          bedStatus: b.bed_status,
          studentId: b.student_id,
        })),
      }),
    );
  }),
);

/* ============================================================
 * 3.1 房间新增
 *   POST /api/class/dorm/room/add
 * ============================================================ */

const roomSaveSchema = z.object({
  roomId: z.string().optional(),
  buildingId: z.string().min(1, '楼栋必填'),
  roomNo: z.string().min(1, '房间号必填').max(50),
  floorNo: z.coerce.number().int().min(0).optional(),
  dormType: z.coerce.number().int().min(1, '请选择宿舍类型').max(2, '宿舍类型只能是 1 男宿舍 / 2 女宿舍'),
  bedCount: z.coerce.number().int().min(1, '床位数至少 1').max(50, '床位数最多 50'),
  ownerName: z.string().max(50).optional(),
  roomStatus: z.string().max(20).optional(),
  classId: z.string().optional(),
  className: z.string().max(50).optional(),
});

/**
 * 生成 / 同步房间床位：保证 1..bedCount 号床位存在（逻辑删除的可复活），
 * 超出 bedCount 的床位逻辑删除（仅限空闲床位，占用中直接报错）。
 *
 * ⚠️ 床位的唯一索引 uk_room_bed = (room_id, bed_no) 是**物理索引**，
 *    因此这里对历史（逻辑删除）行做「复活」而非重新插入，避免撞索引。
 */
async function syncRoomBeds(
  client: any,
  roomId: string,
  roomNo: string,
  buildingId: string,
  dormType: number,
  bedCount: number,
  now: Date,
  userId: string,
): Promise<void> {
  // 含逻辑删除行
  const existing: any[] = await tblTrx(client, DB, BED_TABLE, STAGE).where({ room_id: roomId });
  const byIndex = new Map<number, any>();
  for (const b of existing) {
    const idx = parseInt(String(b.bed_no), 10);
    if (!Number.isNaN(idx)) byIndex.set(idx, b);
  }

  // 1) 超出 bedCount 的床位 → 逻辑删除（占用中则拒绝）
  for (const [idx, b] of byIndex) {
    if (idx <= bedCount || b.is_deleted) continue;
    if (b.student_id || (b.bed_status && b.bed_status !== '空闲')) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        `床位「${b.bed_no}」已占用，无法把床位数减少到 ${bedCount}（请先退宿）`,
      );
    }
    await tblTrx(client, DB, BED_TABLE, STAGE).where({ id: b.id }).update({ is_deleted: true, update_time: now, update_by: userId });
  }

  // 2) 保证 1..bedCount 号床位存在且字段同步
  for (let i = 1; i <= bedCount; i++) {
    const bedNo = `${i}号床`;
    const found = byIndex.get(i);
    if (found) {
      const patch: Record<string, any> = {
        is_deleted: false,
        room_no: roomNo,
        building_id: buildingId,
        dorm_type: dormType,
        update_time: now,
        update_by: userId,
      };
      // 复活历史床位：清空占用状态
      if (found.is_deleted) {
        patch.bed_status = '空闲';
        patch.student_id = null;
      }
      await tblTrx(client, DB, BED_TABLE, STAGE).where({ id: found.id }).update(patch);
    } else {
      await tblInsTrx(client, DB, BED_TABLE, STAGE, {
        id: randomUUID(),
        room_id: roomId,
        room_no: roomNo,
        building_id: buildingId,
        bed_no: bedNo,
        dorm_type: dormType,
        bed_status: '空闲',
        student_id: null,
        is_deleted: false,
        create_time: now,
        create_by: userId,
      });
    }
  }
}

dormRouter.post(
  '/room/add',
  checkPermission('class:dorm:add'),
  validate(roomSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof roomSaveSchema>;

    const bld = await tbl(db, DB, BUILDING_TABLE, STAGE).where({ id: body.buildingId, is_deleted: false }).first();
    if (!bld) throw new BizError(BizCode.DORM_NOT_FOUND, '楼栋不存在');

    // 房间号「楼栋内唯一」：uk_building_room_no=(building_id, room_no) 是物理索引 → 预检含逻辑删除行
    const dup = await tbl(db, DB, ROOM_TABLE, STAGE).where({ building_id: bld.id, room_no: body.roomNo }).first();
    if (dup) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        dup.is_deleted
          ? `「${bld.building_name}」下已有被删除的历史房间使用了房间号「${body.roomNo}」，不可复用`
          : `「${bld.building_name}」已存在房间号「${body.roomNo}」`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    const uid = req.user?.userId || 'system';
    // 房间行 + 床位生成放在同一事务，避免「房间建了、床位没建」的半截数据
    await db.transaction(async (trx) => {
      await tblInsTrx(trx, DB, ROOM_TABLE, STAGE, {
        id,
        building_id: bld.id,
        building_name: bld.building_name,
        floor_no: body.floorNo ?? null,
        room_no: body.roomNo,
        dorm_type: body.dormType,
        bed_count: body.bedCount,
        occupied_count: 0,
        occupancy_rate: 0,
        owner_name: body.ownerName ?? null,
        data_source: '手工录入',
        room_status: body.roomStatus ?? '使用中',
        class_id: body.classId ?? null,
        class_name: body.className ?? null,
        is_deleted: false,
        create_time: now,
        create_by: uid,
      });

      await syncRoomBeds(trx, id, body.roomNo, bld.id, body.dormType, body.bedCount, now, uid);
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '房间',
      bizId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增房间 ${bld.building_name} ${body.roomNo}（${nameOf(DORM_TYPE_NAME, body.dormType)} · ${body.bedCount} 床）`,
      afterValue: { roomNo: body.roomNo, dormType: body.dormType, bedCount: body.bedCount },
    });

    res.json(ok({ roomId: id }, '新增成功'));
  }),
);

/* ============================================================
 * 3.2 房间修改（含床位数同步）
 *   PUT /api/class/dorm/room/update
 * ============================================================ */

dormRouter.put(
  '/room/update',
  checkPermission('class:dorm:edit'),
  validate(roomSaveSchema.extend({ roomId: z.string().min(1, '必须传 roomId') })),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof roomSaveSchema> & { roomId: string };

    const exists = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: body.roomId, is_deleted: false }).first();
    if (!exists) throw new BizError(BizCode.DORM_NOT_FOUND, '房间不存在');

    const bld = await tbl(db, DB, BUILDING_TABLE, STAGE).where({ id: body.buildingId, is_deleted: false }).first();
    if (!bld) throw new BizError(BizCode.DORM_NOT_FOUND, '楼栋不存在');

    // 房间号或所属楼栋变化 → 按「目标楼栋 + 目标房间号」做楼栋内唯一预检
    if (body.roomNo !== exists.room_no || body.buildingId !== exists.building_id) {
      const dup = await tbl(db, DB, ROOM_TABLE, STAGE)
        .where({ building_id: bld.id, room_no: body.roomNo })
        .whereNot('id', body.roomId)
        .first();
      if (dup) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `「${bld.building_name}」已存在房间号「${body.roomNo}」`);
    }

    const occupied = Number(exists.occupied_count) || 0;
    if (occupied > 0 && Number(body.dormType) !== Number(exists.dorm_type)) {
      throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '房间已有学生入住，不可修改宿舍类型（请先退宿）');
    }
    if (occupied > 0 && body.buildingId !== exists.building_id) {
      throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '房间已有学生入住，不可更换楼栋（请先退宿）');
    }

    const now = new Date();
    const bedCount = Number(exists.bed_count) || 0;
    const uid = req.user?.userId || 'system';
    // 房间行 + 床位同步 + 冗余回写放在同一事务：
    // 若因「要删掉已占用床位」被拒，整个事务回滚，房间字段不会半截写入。
    await db.transaction(async (trx) => {
      await tblTrx(trx, DB, ROOM_TABLE, STAGE).where({ id: body.roomId }).update({
        building_id: bld.id,
        building_name: bld.building_name,
        floor_no: body.floorNo ?? null,
        room_no: body.roomNo,
        dorm_type: body.dormType,
        bed_count: body.bedCount,
        owner_name: body.ownerName ?? null,
        room_status: body.roomStatus ?? exists.room_status,
        class_id: body.classId ?? null,
        class_name: body.className ?? null,
        update_time: now,
        update_by: uid,
      });

      // 床位同步（可能增减床位；字段随之更新）
      await syncRoomBeds(trx, body.roomId, body.roomNo, bld.id, body.dormType, body.bedCount, now, uid);

      // 房间号变更 → 同步在住学生的房间号/入住记录
      if (body.roomNo !== exists.room_no) {
        await tblTrx(trx, DB, RESIDENT_TABLE, STAGE).where({ room_id: body.roomId, is_active: true, is_deleted: false }).update({ room_no: body.roomNo, update_time: now });
        await tblTrx(trx, DB, STUDENT_TABLE, STAGE).where({ dorm_id: body.roomId, is_deleted: false }).update({ dorm_no: body.roomNo, update_time: now });
      }
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '房间',
      bizId: body.roomId,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `修改房间 ${bld.building_name} ${body.roomNo}（${body.bedCount} 床${bedCount !== body.bedCount ? `，床位 ${bedCount} → ${body.bedCount}` : ''}）`,
      beforeValue: { roomNo: exists.room_no, dormType: exists.dorm_type, bedCount },
      afterValue: { roomNo: body.roomNo, dormType: body.dormType, bedCount: body.bedCount },
    });

    res.json(ok({ roomId: body.roomId }, '修改成功'));
  }),
);

/* ============================================================
 * 4. 入住列表
 *   GET /api/class/dorm/resident/list
 * ============================================================ */

const residentListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  roomId: z.string().optional(),
  classId: z.string().optional(),
  keyword: z.string().optional(),
});

dormRouter.get(
  '/resident/list',
  checkPermission('class:dorm:view'),
  validate(residentListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof residentListSchema>;
    const query = tbl(db, DB, RESIDENT_TABLE, STAGE).where({ is_deleted: false, is_active: true });
    if (q.roomId) query.andWhere('room_id', q.roomId);
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
      .orderBy('check_in_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    // 入住表只存 building_id，没有楼栋名 —— 这里批量补上楼栋号（A栋/B栋），
    // 否则前端「入住名单」只能显示一串 UUID。
    const bIds = [...new Set<string>(rows.map((r: any) => r.building_id as string).filter(Boolean))];
    const bRows = bIds.length
      ? await tbl(db, DB, BUILDING_TABLE, STAGE).whereIn('id', bIds).select('id', 'building_name')
      : [];
    const bMap = new Map(bRows.map((b: any) => [b.id, b.building_name]));

    res.json(
      page(
        rows.map((r: any) => residentToVO({ ...r, building_name: bMap.get(r.building_id) })),
        Number(total),
        q,
      ),
    );
  }),
);

/* ============================================================
 * 5. 分派床位（校验性别/床位占用）
 *   POST /api/class/dorm/dispatch/add
 * ============================================================ */

const dispatchSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  roomId: z.string().min(1, '房间必填'),
  bedId: z.string().min(1, '床位必填'),
  checkInDate: z.string().optional(),
});

dormRouter.post(
  '/dispatch/add',
  checkPermission('class:dorm:add'),
  validate(dispatchSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof dispatchSchema>;

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const room = await tbl(db, DB, ROOM_TABLE, STAGE).where({ id: body.roomId, is_deleted: false }).first();
    if (!room) throw new BizError(BizCode.DORM_NOT_FOUND, '房间不存在');

    const bed = await tbl(db, DB, BED_TABLE, STAGE).where({ id: body.bedId, is_deleted: false }).first();
    if (!bed) throw new BizError(BizCode.DORM_NOT_FOUND, '床位不存在');
    if (bed.room_id !== room.id) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '床位不属于该房间');

    // 性别与宿舍类型匹配
    const expectedDormType = stu.gender === 1 ? DormType.MALE_DORM : DormType.FEMALE_DORM;
    if (room.dorm_type !== expectedDormType) {
      throw new BizError(
        BizCode.BUSINESS_RULE_VIOLATION,
        `学生性别（${nameOf(GENDER_NAME, stu.gender)}）与房间类型（${nameOf(DORM_TYPE_NAME, room.dorm_type)}）不匹配`,
      );
    }

    // 床位占用校验
    if (bed.bed_status && bed.bed_status !== '空闲') {
      throw new BizError(BizCode.BED_OCCUPIED, `床位 ${bed.bed_no} 已被占用`);
    }
    if (bed.student_id) {
      throw new BizError(BizCode.BED_OCCUPIED, `床位 ${bed.bed_no} 已被占用`);
    }

    const now = new Date();
    const checkInDate = body.checkInDate || now.toISOString().slice(0, 10);

    // 若学生已在住其他床位 → 先释放旧床位
    const oldResident = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ student_id: stu.id, is_active: true, is_deleted: false }).first();
    if (oldResident) {
      await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ id: oldResident.id }).update({ is_active: false, update_time: now });
      await tbl(db, DB, BED_TABLE, STAGE).where({ id: oldResident.bed_id }).update({ bed_status: '空闲', student_id: null, update_time: now });
      await recalcRoom(oldResident.room_id, now);
    }

    const residentId = randomUUID();
    await tblIns(db, DB, RESIDENT_TABLE, STAGE, {
      id: residentId,
      student_id: stu.id,
      student_no: stu.student_no,
      student_name: stu.student_name,
      class_id: stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      gender: stu.gender,
      building_id: room.building_id,
      room_id: room.id,
      room_no: room.room_no,
      bed_id: bed.id,
      bed_no: bed.bed_no,
      check_in_date: checkInDate,
      owner_name: room.owner_name ?? null,
      is_active: true,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    // 占用床位 + 回写学生宿舍字段
    await tbl(db, DB, BED_TABLE, STAGE).where({ id: bed.id }).update({ bed_status: '已占用', student_id: stu.id, update_time: now });
    await recalcRoom(room.id, now);
    await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: stu.id }).update({
      dorm_id: room.id,
      dorm_no: room.room_no,
      bed_no: bed.bed_no,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '分派床位',
      bizId: residentId,
      studentId: stu.id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `学生 ${stu.student_name} 分派至 ${room.building_name} ${room.room_no} ${bed.bed_no} 床`,
      afterValue: { roomId: room.id, bedId: bed.id, bedNo: bed.bed_no },
    });

    res.json(ok({ residentId }, '分派成功'));
  }),
);

/* ============================================================
 * 6. 退宿（释放床位 + 生成退宿申请记录）
 *   POST /api/class/dorm/checkout
 * ============================================================ */

const checkoutSchema = z.object({
  studentId: z.string().min(1, '学生必填'),
  roomId: z.string().optional(),
  bedId: z.string().optional(),
  checkoutReason: z.string().max(500).optional(),
});

dormRouter.post(
  '/checkout',
  checkPermission('class:dorm:edit'),
  validate(checkoutSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof checkoutSchema>;

    const stu = await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: body.studentId, is_deleted: false }).first();
    if (!stu) throw new BizError(BizCode.STUDENT_NOT_FOUND, '学生不存在');

    const resident = await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ student_id: stu.id, is_active: true, is_deleted: false }).first();
    if (!resident) throw new BizError(BizCode.DORM_NOT_FOUND, '该学生当前无在住床位');

    const now = new Date();

    // 释放床位 + 结束入住
    await tbl(db, DB, RESIDENT_TABLE, STAGE).where({ id: resident.id }).update({ is_active: false, update_time: now });
    await tbl(db, DB, BED_TABLE, STAGE).where({ id: resident.bed_id }).update({ bed_status: '空闲', student_id: null, update_time: now });
    await recalcRoom(resident.room_id, now);
    await tbl(db, DB, STUDENT_TABLE, STAGE).where({ id: stu.id }).update({
      dorm_id: null,
      dorm_no: null,
      bed_no: null,
      update_time: now,
      update_by: req.user?.userId || 'system',
    });

    const checkoutId = randomUUID();
    await tblIns(db, DB, CHECKOUT_TABLE, STAGE, {
      id: checkoutId,
      student_id: stu.id,
      student_no: stu.student_no,
      student_name: stu.student_name,
      class_id: stu.class_id ?? null,
      class_name: stu.class_name ?? null,
      room_id: resident.room_id,
      room_no: resident.room_no,
      bed_id: resident.bed_id,
      bed_no: resident.bed_no,
      checkout_reason: body.checkoutReason ?? null,
      apply_user_id: req.user?.userId ?? null,
      apply_user_name: req.user?.userName ?? null,
      apply_time: now,
      apply_status: ApplyStatus.APPROVED,
      approve_user_id: req.user?.userId ?? null,
      approve_user_name: req.user?.userName ?? null,
      approve_time: now,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });

    await writeOpLog({
      module: 'dorm',
      bizType: '退宿',
      bizId: checkoutId,
      studentId: stu.id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `学生 ${stu.student_name} 退宿（${resident.room_no} ${resident.bed_no} 床）`,
      beforeValue: { roomId: resident.room_id, bedId: resident.bed_id },
      afterValue: { applyStatus: ApplyStatus.APPROVED, applyStatusName: nameOf(APPLY_STATUS_NAME, ApplyStatus.APPROVED) },
    });

    res.json(ok({ checkoutId }, '退宿成功'));
  }),
);

export default dormRouter;
