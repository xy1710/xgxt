import { Router } from 'express';
import { z } from 'zod';
import {
  ApplyStatus,
  DataScope,
  PermAction,
  SourceSystem,
  SyncMode,
  SyncResult,
  /**
   * ★ 2026-10-04 斌哥：床位号显示成「1-上 / 1-下」而不是「1 / 2」
   *
   *   规则与前端共用 `shared-types/class` 的 `bedLabel`（奇上偶下）。
   *   ⚠️ 单一数据源在 shared-types —— 原来后端和前端各写一份拼接，
   *      结果分叉成「301-1」和「1-上」两种显示。这里只转发，不再本地实现。
   *
   *   ⚠️ 只用于**显示**，不要拿它去改库存数据 ——
   *      `t_class_student.bed_no` / 同步过来的宿舍副本存的都是纯数字，
   *      8003 班级模块自己也在用那个字段，改了会破坏对方页面。
   */
  bedLabel,
} from 'shared-types/class';
import { commonDb, db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, maxApplyNo, notDeleted, paginate } from '../../lib/repo';
import { rowsToCamel } from '../../lib/case';
import { buildApplyNo, now, seqOfApplyNo, uuid } from '../../lib/ids';
import { ApplyStatusName, DormTypeName } from '../../lib/dict';
import { applySyncScope } from '../shared/syncScope';
import { resolveStudentId, resolveSyncStudentId } from '../shared/studentRef';
import { assertClassAccess } from '../../middleware/dataScope';
import { isFullAccess } from '../../lib/authUser';
import { requirePerm } from '../../lib/permGuard';
import { wrap } from '../../middleware/error';
import {
  tbl,
  tblTrx,
  tblIns,
  tblInsTrx,
  uniUpdCols,
} from '../../../teaching/shared/uniTable';

/**
 * ════════════════════════════════════════════════════════════════
 * ★ 第 5 批（2026-10-11 · 宿舍域）：统一表切读
 * ════════════════════════════════════════════════════════════════
 *
 * 【本文件 6 张表、27 处切读】
 *   sms_class.t_class_student       9 处 → t_uni_student
 *   sms_class.t_class_info          1 处 → t_uni_class
 *   sms_class.t_class_dorm_apply    6 处 → t_uni_dorm_apply（27 列零差异）
 *   sms_class.t_class_dorm_change_log 3 处 → t_uni_dorm_change_log（15 列零差异）
 *   sms_common.t_class_dorm_room_sync 9 处 → t_uni_dorm_room（★迁移 002 补了 7 列）
 *   sms_common.t_class_dorm_live_sync 5 处 → t_uni_dorm_resident（★迁移 002 补了 5 列）
 *
 * 【★ 两张同步表所在的库是 sms_common，不是 sms_class】
 *   这是本文件最容易搞错的一处：`commonDb` 和 `db` 是**两个不同的连接**。
 *   老代码里房间/住宿表一律走 `commonDb(...)`、学生/班级表走 `db(...)`。
 *   → 切读时必须按各自的真实库名传 `SRC_ROOM`/`SRC_LIVE`/`SRC`，
 *     传错库名在 UNI_MAP 里查不到映射 → `tbl()` 会**静默落回老表**，
 *     症状是「切读开关开了但数据还是老库的」，最难查的一种假绿。
 *
 * 【★ 迁移 20261011_002 补的 12 列里，`source_id` 是命门】
 *   老接口 `/sync` 的整个 upsert 建立在
 *     `where({ source_system, source_id })` + 老表唯一索引 uk_room_source 上。
 *   缺了 `source_id` → where 条件无法成立 → 每次都当新行插入 →
 *   教务重复推同一批数据会在宿舍表里堆出 N 份重复宿舍，**而接口返回 200**。
 *   → 归一建表时用 `data_source` 承载了「数据从哪来」，
 *     但「用哪个键去重」是**另一个字段**，不能拿一个顶替另一个。
 *
 * 【★★ 另一个必踩的雷：老代码从不写 `room_no`】
 *   统一表 `t_uni_dorm_room` 有 `uk_dorm_room(room_no, dorm_no, edu_stage)` 唯一索引
 *   （迁移 002 从 `(room_no, edu_stage)` 加宽而来 —— 老表只有非唯一 idx_room_no，
 *   凭空加的唯一索引会卡死「不同楼栋同房号」这种合法数据）。
 *   而老代码 `/room/add` 和 `/sync` 都只写 `dorm_no` → `room_no` 走 DEFAULT ''
 *     → 加宽前：第二间就`Duplicate entry 'class' for key 'uk_dorm_room'`
 *     → 加宽后：连开三间 OK、同房号不同楼栋 OK、真重复才拦（已实测验证）
 *   → 这就是为什么索引必须跟代码**同步**改，不能只改一边。
 */

/** 第 5 批：统一表切读 —— 大学学段宿舍域 */
const SRC = 'sms_class';
const STAGE = 'class' as const;
/** ★ 房间/住宿同步表原本就在 **sms_common**（学管项目先例：跨库共享表放 common） */
const SRC_ROOM = 'sms_common';
const SRC_LIVE = 'sms_common';

const ROOM_T = 't_class_dorm_room_sync';
const LIVE_T = 't_class_dorm_live_sync';
const APPLY_T = 't_class_dorm_apply';
const CHANGE_LOG_T = 't_class_dorm_change_log';
const STU_T = 't_class_student';
const CLS_T = 't_class_info';

/** 房间表（同步副本 / 本地新建共用一张） */
const ROOM = () => tbl(commonDb, SRC_ROOM, ROOM_T, STAGE);
const ROOM_TRX = (trx: import('knex').Knex) => tblTrx(trx, SRC_ROOM, ROOM_T, STAGE);
/** 住宿表（学员 ↔ 宿舍） */
const LIVE = () => tbl(commonDb, SRC_LIVE, LIVE_T, STAGE);
const LIVE_TRX = (trx: import('knex').Knex) => tblTrx(trx, SRC_LIVE, LIVE_T, STAGE);

/**
 * ★★ 住宿表的「指向哪个房间」列，切读时列名变了
 *
 * 老表 `t_class_dorm_live_sync`：`dorm_id` / `dorm_no`
 * 统一表 `t_uni_dorm_resident`：`room_id` / `room_no`
 *
 * 【为什么不能靠 uniTable 的列名翻译表解决】
 *   `UNI_COL_RENAME` 只在**写入**时生效（`toUniColumns` 里改名）。
 *   **查询条件里的列名不会翻译** —— 路由层不做业务列名改写，
 *   否则每张表都要维护别名，最终没人知道实际查的是哪列。
 *   → 所以读路径必须由业务代码自己按开关取列名，
 *     写路径已经由 `UNI_COL_RENAME` 兜住（见 uniTable.ts）。
 *
 * 【为什么这两列必须一起改】
 *   `dorm_id` 在住宿表里装的是**房间 id**（不是宿舍号），
 *   统一表把它正名为 `room_id` —— 与 `t_uni_dorm_bed.room_id` 同一口径，
 *   这是第 1 批「三学段采用实训模型」的成果。
 *   只改一个不改另一个，会出现「按房间查住宿查不到」的假象。
 */
const liveRoomIdCol = (): string => 'room_id';
const liveRoomNoCol = (): string => 'room_no';
/** 换宿/退宿申请单 */
const APPLY = () => tbl(db, SRC, APPLY_T, STAGE);
const APPLY_TRX = (trx: import('knex').Knex) => tblTrx(trx, SRC, APPLY_T, STAGE);
const CHANGE_LOG = () => tbl(db, SRC, CHANGE_LOG_T, STAGE);
/** 学生档案 / 班级档案 */
const STU = () => tbl(db, SRC, STU_T, STAGE);
const STU_TRX = (trx: import('knex').Knex) => tblTrx(trx, SRC, STU_T, STAGE);
const CLS = () => tbl(db, SRC, CLS_T, STAGE);

/**
 * 宿舍信息（需求四：同步教务管理的宿舍信息）
 *
 * 边界：
 *  - 宿舍房间 / 住宿主数据**同步自教务管理**，存共享库只读副本
 *  - 「换宿 / 退宿」申请**由本模块发起**（班主任），推给教务管理审批；
 *    审批结果回落到本模块后写一条调宿记录（详情 → 宿舍 → 调宿记录）
 */
export const dormRouter = Router();

/* ============================== 同步 ============================== */

const dormSyncSchema = z.object({
  sourceSystem: z.string().default(SourceSystem.EDU),
  syncMode: z.string().default(SyncMode.INCREMENT),
  batchNo: z.string().min(1, '批次号不能为空'),
  sourceUpdateTime: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        room: z.object({
          sourceId: z.string().min(1, '房间上游主键不能为空'),
          buildingId: z.string().optional().nullable(),
          buildingName: z.string().optional().nullable(),
          dormType: z.coerce.number().int().optional().nullable(),
          dormNo: z.string().min(1, '宿舍号不能为空'),
          bedCount: z.coerce.number().int().default(0),
          usedCount: z.coerce.number().int().default(0),
          leaderStudentId: z.string().optional().nullable(),
          leaderStudentName: z.string().optional().nullable(),
        }),
        residents: z
          .array(
            z.object({
              /**
               * 学生 ID —— ★ 2026-10-05 由【必填】改为【可选】
               *
               * ⚠️ 原因：上游（教务 sms_edu）只有**学号**，拿不到本模块的学生 ID
               *    （各库学生表主键是不同的 uuid，只有 student_no 三边都对得上）。
               *    没传时由收方按学号回查本模块 t_class_student —— 见 shared/studentRef.ts。
               */
              studentId: z.string().optional().nullable(),
              studentNo: z.string().optional().nullable(),
              studentName: z.string().optional().nullable(),
              classId: z.string().optional().nullable(),
              className: z.string().optional().nullable(),
              checkInDate: z.string().optional().nullable(),
            }),
          )
          .default([]),
      }),
    )
    .max(300, '单批最多 300 个宿舍'),
  /**
   * 本次「被取消分派」的房间（教务房间主键 sourceId）。
   * ⚠️ 默认空数组 = 不做任何删除，避免上游漏传时误删。
   */
  removedSourceIds: z.array(z.string().min(1)).max(300).default([]),
});

/**
 * @openapi
 * /api/class/dorm/sync:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 4.1 宿舍信息同步（教务管理 → 学管）
 *     description: |
 *       一次推送「房间 + 该房间当前住宿学员」。
 *       幂等键：房间 `(sourceSystem + room.sourceId)`，住宿 `(sourceSystem + room.sourceId##studentId)`。
 *       本次未出现的住宿学员会被标记为已删除（退宿）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [batchNo, items]
 *             properties:
 *               batchNo: { type: string }
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: 同步结果 }
 */
dormRouter.post(
  '/sync',
  validate({ body: dormSyncSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof dormSyncSchema>;
    const sourceSystem = String(body.sourceSystem || SourceSystem.EDU);
    const result: SyncResult = {
      accepted: body.items.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      batchNo: body.batchNo,
      finishTime: '',
    };
    const t = now();

    await commonDb.transaction(async (trx) => {
      for (const item of body.items) {
        const room = item.room;
        try {
          // ① 房间 upsert
          const roomFields: Record<string, unknown> = {
            building_id: room.buildingId ?? null,
            building_name: room.buildingName ?? null,
            dorm_type: room.dormType ?? null,
            dorm_no: room.dormNo,
            // ★ 切读时必须同时写 room_no：统一表 uk_dorm_room(room_no, dorm_no, edu_stage)
            //   而 room_no 默认 '' → 只写 dorm_no 会让三元组退化成两列、连建第二间就撞。
            //   老表没有 room_no 列，tblIns 的 stripUniOnlyCols 会自动剔除（零影响）。
            room_no: room.dormNo,
            bed_count: room.bedCount,
            used_count: room.usedCount,
            leader_student_id: room.leaderStudentId ?? null,
            leader_student_name: room.leaderStudentName ?? null,
            source_system: sourceSystem,
            source_id: room.sourceId,
            source_batch_no: body.batchNo,
            source_update_time: body.sourceUpdateTime ?? t,
            sync_status: 2,
            is_deleted: 0,
          };
          const existRoom = (await ROOM_TRX(trx)
            .where({ source_system: sourceSystem, source_id: room.sourceId })
            .first()) as Record<string, unknown> | undefined;

          /**
           * ★ 房间的**本地主键 id** —— 下面写住宿记录 / 学生档案的 dorm_id 一律用它，
           *   不用 `room.sourceId`。
           *
           * 【★★ 2026-10-11 修一个既有 bug：两套 id 口径不一致】
           *   老代码这里写的是 `dorm_id = room.sourceId`（教务侧主键），
           *   但同文件里读学生宿舍的三处全都按**房间表本地 id** 查：
           *     `/bed/list`      `student.dorm_id = ?（房间表 id）`
           *     `/room/update`   统计在住人数 `student.dorm_id = ?（房间表 id）`
           *     `decorateRooms`  `byDorm` 用 `occupant.dorm_id` 去匹配 `row.id`
           *   而前端 `BedSelect.vue` 传的 `dormId` 也来自 `/room/list` 返回的 `id`。
           *   → 两边对不上：**同步过来的宿舍，床位视图恒为空、在住人数恒为 0**，
           *     而 `/room/list` 本身返回 200，看起来一切正常（最难查的一类）。
           *
           * 【为什么统一到「本地 id」而不是反过来改成 source_id】
           *   读侧三处 + 前端传参都已经用本地 id，改读侧要动 4 处；
           *   而本地 id 是房间表主键，本就是「本模块这条房间记录」的唯一身份，
           *   source_id 只是同步幂等用的外部键，不该进业务外键。
           */
          let roomLocalId = '';
          if (existRoom) {
            roomLocalId = String(existRoom.id ?? '');
            await ROOM_TRX(trx)
              .where({ id: existRoom.id as string })
              .update({ ...(await uniUpdCols(commonDb, SRC_ROOM, ROOM_T, roomFields)), update_time: t });
            result.updated += 1;
          } else {
            await tblInsTrx(trx, SRC_ROOM, ROOM_T, STAGE, { ...baseInsert(), ...roomFields } as never);
            result.inserted += 1;
            /**
             * ★ 必须回查拿本地 id，不能用 `insRes[0]`：
             *   两张表主键都是 `varchar(36)` 的 uuid，**没有 auto_increment**，
             *   mysql2 驱动返回的insertId恒为 0 → `roomLocalId` 变成 '0'
             *   → 住宿记录的 dorm_id 全写成 '0' → 床位视图查不到人，且不报错。
             */
            const inserted = (await ROOM_TRX(trx)
              .where({ source_system: sourceSystem, source_id: room.sourceId })
              .first()) as Record<string, unknown> | undefined;
            roomLocalId = String(inserted?.id ?? '');
          }
          if (!roomLocalId) {
            throw new Error(`房间「${room.dormNo}」写入后取不到本地主键`);
          }

          // ② 住宿学员 upsert
          /**
           * 本次推送里"还在住"的人 —— 用 step ③ 判定退宿。
           * ⚠️ 要同时收 3 种可能值：回查到的学生 ID、上游传的 ID、学号（降级占位值），
           *    因为 `student_id` 落库的可能是其中任意一个。
           */
          const presentIds = new Set<string>();
          for (const r of item.residents) {
            /**
             * ⚠️ 幂等键用【学号】优先，不用学生 ID —— 2026-10-05：
             *   学生 ID 是"回查"出来的（上游只给学号），在学生还没被班主任
             *   接收建档之前查不到、会退化成学号；等他建档后又变成真 ID。
             *   若把 ID 写进幂等键，同一个人会先后生成两行 → 入住人数重复计算。
             *   学号是跨系统稳定主键（升级交接也是这个口径），所以用它做键。
             */
            const liveKey = String(r.studentNo || r.studentId || '').trim();
            if (!liveKey) continue; // 既没学号也没 ID，无法定位，跳过
            const liveSourceId = `${room.sourceId}##${liveKey}`;
            const studentId = await resolveSyncStudentId(r);
            presentIds.add(studentId);
            if (r.studentId) presentIds.add(String(r.studentId));
            if (r.studentNo) presentIds.add(String(r.studentNo));
            const fields: Record<string, unknown> = {
              student_id: studentId,
              student_no: r.studentNo ?? '',
              student_name: r.studentName ?? '',
              class_id: r.classId ?? null,
              class_name: r.className ?? null,
              dorm_id: roomLocalId,
              dorm_no: room.dormNo,
              check_in_date: r.checkInDate ?? null,
              source_system: sourceSystem,
              source_id: liveSourceId,
              source_batch_no: body.batchNo,
              source_update_time: body.sourceUpdateTime ?? t,
              sync_status: 2,
              is_deleted: 0,
            };
            const existLive = (await LIVE_TRX(trx)
              .where({ source_system: sourceSystem, source_id: liveSourceId })
              .first()) as Record<string, unknown> | undefined;
            if (existLive) {
              // ★ 必须过uniUpdCols：update 路径没有列名翻译，dorm_id/dorm_no 会直接炸
              await LIVE_TRX(trx)
                .where({ id: existLive.id as string })
                .update({ ...(await uniUpdCols(commonDb, SRC_LIVE, LIVE_T, fields)), update_time: t });
            } else {
              await tblInsTrx(trx, SRC_LIVE, LIVE_T, STAGE, { ...baseInsert(), ...fields } as never);
            }

            // 学生档案例行更新宿舍号，便于花名册直接显示
            // ⚠️ 只有回查到了【本模块的真学生 ID】才更新，别拿学号去 update id
            const target = (await resolveStudentId(r.studentNo)) || r.studentId || '';
            if (target) {
              await STU_TRX(trx)
                .where({ id: target })
                .update({ dorm_id: roomLocalId, dorm_no: room.dormNo, update_time: t });
            }
          }

          // ③ 该房间本次未出现的住宿记录 → 退宿
          //
          // ★ 2026-10-05 加保护：本次没带住宿明细时【不清空】本房间的住宿记录。
          //
          // 【为什么】上游「教务 → 分派宿舍」是**班级 ↔ 房间**级别的动作，
          //   它推过来的是「这个班分到了这几间房」，不一定带得到住宿学员明细
          //   （宿位分配在教务那边是另一张表 t_edu_dorm_bed，允许为空）。
          //   原来的写法在 residents=[] 时会执行
          //     `update ... set is_deleted=1 where dorm_id=?`（没有 whereNotIn 兜底）
          //   → 把该房间所有住宿学员判成「已退宿」。
          //   这是**静默清数据**，比少同步更危险，所以宁可不退。
          //   （真要退宿，走本模块自己的「换宿/退宿申请」流程。）
          if (presentIds.size > 0) {
            const delQb = LIVE_TRX(trx)
              .where({ source_system: sourceSystem, is_deleted: 0 })
              .update({ is_deleted: 1, update_time: t });
            delQb.where(liveRoomIdCol(), roomLocalId);
            delQb.whereNotIn('student_id', [...presentIds]);
            await delQb;
          }
        } catch (e) {
          result.failed += 1;
          result.errors.push({
            sourceId: room.sourceId,
            reason: `宿舍「${room.dormNo}」写入失败：${(e as Error).message}`,
          });
        }
      }

      /**
       * ④ 取消分派：本次明确列出的房间 → 房间副本 + 其住宿副本一并标记删除。
       *
       * ★ 2026-10-05 新增，配合上游「教务 → 分派宿舍」的取消/清空动作：
       *   原来是只增不减，教务点了「取消分派」或「清空」，班级这边房间还留着。
       *   ⚠️ 只在**明确传了 removedSourceIds** 时才删（默认空数组 = 不动），
       *      并且跳过本次 items 里仍然存在的房间，避免自相矛盾。
       */
      const removed = [...new Set(body.removedSourceIds || [])].filter(Boolean);
      if (removed.length) {
        const keep = new Set(body.items.map((it) => it.room.sourceId));
        const toDrop = removed.filter((id) => !keep.has(id));
        if (toDrop.length) {
          const roomDel = await ROOM_TRX(trx)
            .where({ source_system: sourceSystem })
            .whereIn('source_id', toDrop)
            .where('is_deleted', 0)
            .update({ is_deleted: 1, update_time: t });
          result.updated += Number(roomDel || 0);
          await LIVE_TRX(trx)
            .where({ source_system: sourceSystem })
            .whereIn(liveRoomIdCol(), toDrop)
            .where('is_deleted', 0)
            .update({ is_deleted: 1, update_time: t });
        }
      }
    });

    result.finishTime = now();
    return ok(res, result, `宿舍同步完成：新增 ${result.inserted} 项，更新 ${result.updated} 项`);
  }),
);

/* ============================== 房间列表 ============================== */

const roomListSchema = z.object({
  ...pageQuerySchema.shape,
  buildingId: z.string().optional(),
  dormType: z.coerce.number().int().optional(),
  onlyAvailable: z.coerce.boolean().optional(),
  keyword: z.string().optional(),
});

/**
 * 把「房间 + 该房间入住学员」组装成原型「分派宿舍」表要的一组字段。
 *
 * 一次性批量查询，避免按房间逐个查床位造成 N+1：
 *  - `beds`      床位号明细（宿舍号-床位号 + 入住人）
 *  - `className` 由入住学员的班级推导（房间主数据里没有班级字段）
 *  - `teacherName` 由入住学员所在班级的班主任推导
 */
async function decorateRooms(
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = rows.map((r) => String(r.id));
  const occupants = ids.length
    ? ((await notDeleted(STU())
        .whereIn('dorm_id', ids)
        .select(
          'id',
          'dorm_id',
          'student_no',
          'student_name',
          'class_id',
          'class_name',
          'bed_no',
        )) as Array<Record<string, unknown>>)
    : [];

  const byDorm = new Map<string, Array<Record<string, unknown>>>();
  for (const o of occupants) {
    const k = String(o.dorm_id ?? '');
    if (!byDorm.has(k)) byDorm.set(k, []);
    byDorm.get(k)!.push(o);
  }

  const classIds = Array.from(
    new Set(occupants.map((o) => String(o.class_id ?? '')).filter(Boolean)),
  );
  const classes = classIds.length
    ? ((await notDeleted(CLS())
        .whereIn('id', classIds)
        .select('id', 'head_teacher_name', 'teacher_name')) as Array<Record<string, unknown>>)
    : [];
  const teacherOf = new Map(
    classes.map((c) => [
      String(c.id),
      ((c.head_teacher_name as string) || (c.teacher_name as string) || '') as string,
    ]),
  );

  return rows.map((r) => {
    const c = rowsToCamel<Record<string, unknown>>([r])[0];
    const bed = Number(r.bed_count ?? 0);
    const used = Number(r.used_count ?? 0);
    const dormNo = String(r.dorm_no ?? '');
    const list = byDorm.get(String(r.id)) ?? [];

    const byBed = new Map<number, Record<string, unknown>>();
    for (const o of list) {
      const n = o.bed_no === null || o.bed_no === undefined ? null : Number(o.bed_no);
      if (n) byBed.set(n, o);
    }

    const beds: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= bed; i += 1) {
      const o = byBed.get(i);
      beds.push({
        bedNo: i,
        label: bedLabel(dormNo, i),
        occupied: !!o,
        studentId: o ? String(o.id) : null,
        studentNo: o ? ((o.student_no as string) ?? null) : null,
        studentName: o ? ((o.student_name as string) ?? null) : null,
        className: o ? ((o.class_name as string) ?? null) : null,
      });
    }

    const classNames = Array.from(
      new Set(list.map((o) => String(o.class_name ?? '')).filter(Boolean)),
    );
    const teachers = Array.from(
      new Set(list.map((o) => teacherOf.get(String(o.class_id ?? '')) ?? '').filter(Boolean)),
    );

    return {
      ...c,
      dormTypeName: DormTypeName[r.dorm_type as number] ?? '未知',
      isFull: bed > 0 && used >= bed,
      className: classNames.join('、') || null,
      teacherName: teachers.join('、') || null,
      beds,
    };
  });
}

/**
 * @openapi
 * /api/class/dorm/room/list:
 *   get:
 *     tags: [宿舍信息]
 *     summary: 4.2 宿舍房间列表（同步自教务管理）
 *     description: |
 *       数据范围：班主任 / 教员 / 助教只看到<b>本班学员所住的宿舍</b>
 *       （即「住宿信息里出现过自己班级学员的房间」），学管 / 校长看全部。
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: onlyAvailable, schema: { type: boolean }, description: 只看未满员 }
 *     responses:
 *       200: { description: 分页列表 }
 */
dormRouter.get(
  '/room/list',
  validate({ query: roomListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof roomListSchema>>(req);
    const base = ROOM();
    notDeleted(base);
    // 班主任（本班级范围）只看到本班学员住过的宿舍；学管 / 校长不受限
    if (!isFullAccess(user) && user.dataScope === DataScope.CLASS) {
      const myClasses = user.classIds.length ? user.classIds : ['__none__'];
      // ★ 住宿表的房间指向列切读后叫 room_id（见 liveRoomIdCol 的说明）
      const ridCol = liveRoomIdCol();
      const lived = (await notDeleted(LIVE())
        .whereIn('class_id', myClasses)
        .select(ridCol)) as Array<Record<string, string | null>>;
      const dormIds = Array.from(
        new Set(lived.map((r) => r[ridCol]).filter((x): x is string => !!x)),
      );
      // live 的房间指向列存的是**房间表本地 id**（与 /sync 写入口径一致，2026-10-11 修）
      base.whereIn('id', dormIds.length ? dormIds : ['__none__']);
    }
    if (query.buildingId) base.where('building_id', query.buildingId);
    if (query.dormType) base.where('dorm_type', query.dormType);
    if (query.keyword) {
      const k = query.keyword;
      // 原型搜索框口径是「宿舍号 / 姓名 / 学号」，后两个落在入住学员表上 → 先取出命中的房间
      const hit = (await notDeleted(STU())
        .where(function (this: import('knex').Knex.QueryBuilder) {
          this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
        })
        .select('dorm_id')) as Array<Record<string, unknown>>;
      const hitIds = Array.from(
        new Set(hit.map((h) => String(h.dorm_id ?? '')).filter(Boolean)),
      );
      base.where(function (this: import('knex').Knex.QueryBuilder) {
        this.where('dorm_no', 'like', `%${k}%`);
        if (hitIds.length) this.orWhereIn('id', hitIds);
      });
    }
    if (query.onlyAvailable) base.whereRaw('used_count < bed_count');
    base.orderBy('dorm_no', 'asc');

    const paged = await paginate(base, query, async (qb) =>
      decorateRooms((await qb) as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ============================== 新建宿舍（原型「新建宿舍分配」） ============================== */

const roomAddSchema = z.object({
  buildingName: z.string().optional().nullable(),
  dormNo: z.string().min(1, '宿舍号不能为空'),
  bedCount: z.coerce.number().int().min(1, '床位总数至少 1 个'),
  dormType: z.coerce.number().int().optional().nullable(),
  leaderStudentId: z.string().optional().nullable(),
  leaderStudentName: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/dorm/room/add:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 4.2.1 新建宿舍分配（原型「＋ 新建宿舍分配」）
 *     description: |
 *       正式环境下宿舍主数据由教务管理同步；本接口供原型演示直接落一条房间记录，
 *       落库位置与同步副本同一张表，`source_system` 标记为 `class`（本地新建）。
 *     responses:
 *       200: { description: 新建成功 }
 */
dormRouter.post(
  '/room/add',
  requirePerm('dorm', PermAction.ADD),
  validate({ body: roomAddSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof roomAddSchema>;

    const dup = (await notDeleted(ROOM())
      .where({ dorm_no: b.dormNo })
      .first()) as Record<string, unknown> | undefined;
    if (dup) throw Errors.param(`宿舍号「${b.dormNo}」已存在，请换一个`);

    const id = uuid();
    const t = now();
    /**
     * ★ 必须走 tblIns：切读时它补edu_stage（统一表该列 NOT NULL 且无默认值）。
     *
     * 【★★ 老代码只写 `dorm_no`、从不写 `room_no` —— 这是本批最隐蔽的一处】
     *   统一表 `t_uni_dorm_room` 有唯一索引
     *     `uk_dorm_room(room_no, dorm_no, edu_stage)`（迁移 002 从两列加宽而来）
     *   而`room_no` 的列默认值是 `''` →
     *     加宽前：第二间宿舍就 `Duplicate entry 'class' for key 'uk_dorm_room'`
     *     加宽后：room_no/dorm_no 都为空串，三元组全等 → **仍然会撞**
     *   → 所以切读时必须**同时写 room_no**，让三元组靠 dorm_no 区分开。
     *   （实测验证：老代码模式下连开三间 OK、同房号不同楼栋 OK、真重复才拦。）
     *
     * 【为什么不在路由层统一补 room_no】
     *   房间号在这套模型里是「楼栋-房号」（dorm_no）而 room_no 是纯房号，
     *   两列语义不同源。切读时 room_no 取 dorm_no 全值，
     *   与 `t_uni_dorm_bed.room_no` 的口径一致，且不改变 dorm_no 的老行为。
     */
    await tblIns(commonDb, SRC_ROOM, ROOM_T, STAGE, {
      ...baseInsert(user, id),
      building_id: null,
      building_name: b.buildingName ?? 'A栋',
      dorm_type: b.dormType ?? 1,
      dorm_no: b.dormNo,
      room_no: b.dormNo,
      bed_count: b.bedCount,
      used_count: 0,
      leader_student_id: b.leaderStudentId ?? null,
      leader_student_name: b.leaderStudentName ?? null,
      source_system: SourceSystem.CLASS,
      source_id: id,
      source_batch_no: `LOCAL-${t.slice(0, 10)}`,
      source_update_time: t,
      sync_status: 2,
      is_deleted: 0,
    } as never);

    return ok(
      res,
      { dormId: id, dormNo: b.dormNo, bedCount: b.bedCount },
      `已新建宿舍 ${b.dormNo}（${b.bedCount} 个床位，床位号 ${bedLabel(b.dormNo, 1)} ~ ${bedLabel(b.dormNo, b.bedCount)}）`,
    );
  }),
);

const roomUpdateSchema = z.object({
  dormId: z.string().min(1, '缺少宿舍ID'),
  buildingName: z.string().optional().nullable(),
  dormType: z.coerce.number().int().optional().nullable(),
  bedCount: z.coerce.number().int().min(1, '床位总数至少 1 个').optional(),
});

/**
 * @openapi
 * /api/class/dorm/room/update:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 4.2.2 编辑宿舍（原型「分派宿舍 → 操作 → 编辑」）
 *     description: |
 *       只允许改**本地可控**的三项：楼栋、宿舍类型、床位总数。
 *       床位总数不能小于在住人数；宿舍号是同步主键的一部分，不在这里改。
 *     responses:
 *       200: { description: 保存成功 }
 */
dormRouter.post(
  '/room/update',
  requirePerm('dorm', PermAction.EDIT),
  validate({ body: roomUpdateSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof roomUpdateSchema>;

    const room = (await notDeleted(ROOM()).where('id', b.dormId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!room) throw Errors.param('宿舍不存在');

    const patch: Record<string, unknown> = { ...baseUpdate(user) };
    if (b.buildingName !== undefined) patch.building_name = b.buildingName;
    if (b.dormType !== undefined) patch.dorm_type = b.dormType;
    if (b.bedCount !== undefined) {
      const used = await notDeleted(STU())
        .where('dorm_id', b.dormId)
        .count({ c: '*' })
        .first();
      const usedCount = Number((used as Record<string, unknown> | undefined)?.c ?? 0);
      if (b.bedCount < usedCount) {
        throw Errors.param(`床位总数不能小于在住人数（${usedCount}）`);
      }
      patch.bed_count = b.bedCount;
    }

    // ★ 不要自己再写 edu_stage：tbl() 开关开时已自带，关时老表没这列会报错
    await ROOM().where({ id: b.dormId }).update(patch as never);
    return ok(res, { dormId: b.dormId }, '宿舍信息已保存');
  }),
);

/* ============================== 住宿列表 ============================== */

const liveListSchema = z.object({
  ...pageQuerySchema.shape,
  dormId: z.string().optional(),
  studentId: z.string().optional(),
  classId: z.string().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/dorm/live/list:
 *   get:
 *     tags: [宿舍信息]
 *     summary: 4.3 住宿信息列表（学员 ↔ 宿舍）
 *     description: 数据范围自动过滤：老师只看自己负责班级的学员住宿情况。
 *     responses:
 *       200: { description: 分页列表 }
 */
dormRouter.get(
  '/live/list',
  validate({ query: liveListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof liveListSchema>>(req);
    const base = LIVE();
    notDeleted(base);
    await applySyncScope(base, user);
    if (query.dormId) base.where(liveRoomIdCol(), query.dormId);
    if (query.studentId) base.where('student_id', query.studentId);
    if (query.classId) base.where('class_id', query.classId);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: import('knex').Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy(liveRoomNoCol(), 'asc');

    const paged = await paginate(base, query, async (qb) =>
      rowsToCamel(await qb as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/* ============================== 床位明细（需求 v1.2） ============================== */

/**
 * @openapi
 * /api/class/dorm/bed/list:
 *   get:
 *     tags: [宿舍信息]
 *     summary: 某间宿舍的床位明细（床位号 + 入住学员）
 *     description: |
 *       床位号展示规则：`宿舍号-床位号`（如 301-1，301 为宿舍号）。
 *       「谁住哪个床位」以学生表的 dorm_id + bed_no 为唯一真源。
 *     parameters:
 *       - { in: query, name: dormId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: 床位列表 }
 */
dormRouter.get(
  '/bed/list',
  validate({ query: z.object({ dormId: z.string().min(1, '缺少宿舍ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const { dormId } = q<{ dormId: string }>(req);
    const room = (await notDeleted(ROOM()).where('id', dormId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!room) throw Errors.param('宿舍不存在');

    const bedCount = Number(room.bed_count ?? 0);
    const dormNo = String(room.dorm_no ?? '');
    const occupants = (await notDeleted(STU())
      .where('dorm_id', dormId)
      .select(
        'id',
        'student_no',
        'student_name',
        'class_id',
        'class_name',
        'phone',
        'bed_no',
      )) as Array<Record<string, unknown>>;

    // 班主任只能看本班学员所住宿舍的床位（学管 / 校长不受限）
    if (!isFullAccess(user) && user.dataScope === DataScope.CLASS) {
      const mine = new Set(user.classIds);
      const hasOwn = occupants.some((o) => mine.has(String(o.class_id ?? '')));
      if (!hasOwn) throw Errors.noOperationPermission('您只能查看本班学员所住宿舍的床位信息');
    }

    const byBed = new Map<number, Record<string, unknown>>();
    for (const o of occupants) {
      const n = o.bed_no === null || o.bed_no === undefined ? null : Number(o.bed_no);
      if (n) byBed.set(n, o);
    }

    const beds: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= bedCount; i += 1) {
      const o = byBed.get(i);
      beds.push({
        bedNo: i,
        label: bedLabel(dormNo, i),
        occupied: !!o,
        studentId: o ? String(o.id) : null,
        studentNo: o ? (o.student_no as string) : null,
        studentName: o ? (o.student_name as string) : null,
        classId: o ? ((o.class_id as string) ?? null) : null,
        className: o ? ((o.class_name as string) ?? null) : null,
        phone: o ? ((o.phone as string) ?? null) : null,
      });
    }

    // 住在本宿舍但没填床位号的历史数据，单独列出，方便补齐
    const unassigned = occupants
      .filter((o) => o.bed_no === null || o.bed_no === undefined)
      .map((o) => ({
        studentId: String(o.id),
        studentNo: o.student_no as string,
        studentName: o.student_name as string,
        className: (o.class_name as string) ?? null,
      }));

    return ok(
      res,
      {
        dormId,
        dormNo,
        buildingName: (room.building_name as string) ?? null,
        bedCount,
        usedCount: beds.filter((b) => b.occupied).length,
        beds,
        unassigned,
      },
      '查询成功',
    );
  }),
);

/**
 * @openapi
 * /api/class/dorm/bed/out:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 退宿（释放该学员占用的床位）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId]
 *             properties:
 *               studentId: { type: string }
 *     responses:
 *       200: { description: 退宿成功 }
 */
dormRouter.post(
  '/bed/out',
  requirePerm('dormApply', PermAction.EDIT),
  validate({ body: z.object({ studentId: z.string().min(1, '缺少学生ID') }) }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as { studentId: string };
    const stu = (await notDeleted(STU()).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, (stu.class_id as string) ?? null, '该学员');
    if (!stu.dorm_id && !stu.bed_no) throw Errors.param('该学员当前没有宿舍床位');

    await STU().where({ id: b.studentId }).update({
      dorm_id: null,
      dorm_no: null,
      bed_no: null,
      ...baseUpdate(user),
    });
    return ok(res, { studentId: b.studentId }, '已退宿，床位已释放');
  }),
);

/* ============================== 换宿 / 退宿申请 ============================== */

const applyAddSchema = z.object({
  applyCategory: z.coerce.number().int('申请类别不能为空'),
  studentId: z.string().min(1, '缺少学生ID'),
  toDormId: z.string().optional().nullable(),
  toDormNo: z.string().optional().nullable(),
  applyReason: z.string().min(1, '申请原因不能为空'),
});

/**
 * @openapi
 * /api/class/dorm/apply/add:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 4.4 发起换宿 / 退宿申请
 *     description: |
 *       本模块发起（班主任可操作），推给教务管理审批；申请单先落到本模块的
 *       `t_class_dorm_apply`，审批结果回来后更新状态并写调宿记录。
 *       - applyCategory = 1 换宿：必须给 `toDormId`
 *       - applyCategory = 2 退宿：不需要目标宿舍
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [applyCategory, studentId, applyReason]
 *             properties:
 *               applyCategory: { type: integer, enum: [1, 2] }
 *               studentId: { type: string }
 *               toDormId: { type: string }
 *               applyReason: { type: string }
 *     responses:
 *       200: { description: 申请已提交，返回申请单号 }
 */
dormRouter.post(
  '/apply/add',
  validate({ body: applyAddSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof applyAddSchema>;

    const stu = (await notDeleted(STU()).where('id', b.studentId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!stu) throw Errors.studentNotFound();
    assertClassAccess(user, stu.class_id as string | null, '该学生');

    if (b.applyCategory === 1 && !b.toDormId) {
      throw Errors.required('换宿申请必须选择目标宿舍');
    }

    const fromLive = (await notDeleted(LIVE())
      .where('student_id', b.studentId)
      .first()) as Record<string, unknown> | undefined;

    let toDormNo: string | null = b.toDormNo ?? null;
    if (b.toDormId && !toDormNo) {
      /**
       * ★ 2026-10-11 与 `/sync` 同一个 bug 的另一半：这里按 `source_id` 查房间，
       *   而前端传的 `toDormId` 来自 `/room/list` 的 `id`（房间表本地主键）
       *   → 换宿申请必然报「目标宿舍不存在或尚未同步」。
       * 统一到本地 id。
       */
      const room = (await notDeleted(ROOM())
        .where({ id: b.toDormId })
        .first()) as Record<string, unknown> | undefined;
      if (!room) throw Errors.param('目标宿舍不存在或尚未同步');
      toDormNo = room.dorm_no as string;
      const bed = Number(room.bed_count ?? 0);
      const used = Number(room.used_count ?? 0);
      if (bed > 0 && used >= bed) throw Errors.param(`目标宿舍「${toDormNo}」已满员，请另选`);
    }

    const prefixKey = b.applyCategory === 1 ? 'DORM_SWAP' : 'DORM_OUT';
    const prefix = prefixKey === 'DORM_SWAP' ? 'HS' : 'TS';
    const ymd = now().slice(0, 10).replace(/-/g, '');
    const maxNo = await maxApplyNo(APPLY(), APPLY_T, prefix, ymd);
    const applyNo = buildApplyNo(prefixKey, seqOfApplyNo(maxNo) + 1);

    const id = uuid();
    await tblIns(db, SRC, APPLY_T, STAGE, {
      ...baseInsert(user, id),
      apply_no: applyNo,
      apply_category: b.applyCategory,
      student_id: b.studentId,
      student_no: stu.student_no as string,
      student_name: stu.student_name as string,
      class_id: (stu.class_id as string) ?? null,
      class_name: (stu.class_name as string) ?? null,
      from_dorm_id: ((fromLive?.[liveRoomIdCol()] as string) ?? (stu.dorm_id as string) ?? null),
      from_dorm_no: ((fromLive?.[liveRoomNoCol()] as string) ?? (stu.dorm_no as string) ?? null),
      to_dorm_id: b.toDormId ?? null,
      to_dorm_no: toDormNo,
      apply_reason: b.applyReason,
      apply_status: ApplyStatus.PENDING,
      has_goods_checked: 0,
      applicant_id: user.userId,
      applicant_name: user.userName,
      apply_time: now(),
    } as never);

    return ok(
      res,
      { applyId: id, applyNo },
      b.applyCategory === 1 ? '换宿申请已提交，等待教务管理审核' : '退宿申请已提交，等待教务管理审核',
    );
  }),
);

const applyListSchema = z.object({
  ...pageQuerySchema.shape,
  applyCategory: z.coerce.number().int().optional(),
  applyStatus: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/dorm/apply/list:
 *   get:
 *     tags: [宿舍信息]
 *     summary: 4.5 宿舍申请列表（换宿 / 退宿）
 *     description: 老师只看到自己负责班级的申请。
 *     responses:
 *       200: { description: 分页列表 }
 */
dormRouter.get(
  '/apply/list',
  validate({ query: applyListSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof applyListSchema>>(req);
    const base = APPLY();
    notDeleted(base);
    await applySyncScope(base, user);
    if (query.applyCategory) base.where('apply_category', query.applyCategory);
    if (query.applyStatus) base.where('apply_status', query.applyStatus);
    if (query.keyword) {
      const k = query.keyword;
      base.where(function (this: import('knex').Knex.QueryBuilder) {
        this.where('student_no', 'like', `%${k}%`).orWhere('student_name', 'like', `%${k}%`);
      });
    }
    base.orderBy('apply_time', 'desc');

    const paged = await paginate(base, query, async (qb) => {
      const rows = (await qb) as Array<Record<string, unknown>>;
      return rows.map((r) => {
        const c = rowsToCamel<Record<string, unknown>>([r])[0];
        const st = r.apply_status as number;
        return {
          ...c,
          applyCategoryName: (r.apply_category as number) === 1 ? '换宿' : '退宿',
          applyStatusName: ApplyStatusName[st] ?? '未知',
        };
      });
    });
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

const applyApproveSchema = z.object({
  applyId: z.string().min(1, '缺少申请单ID'),
  action: z.enum(['approve', 'reject'], { errorMap: () => ({ message: '审批动作只能是 approve / reject' }) }),
  opinion: z.string().optional().nullable(),
  /** 审批通过前需确认宿舍物品完好（原型要求） */
  hasGoodsChecked: z.coerce.boolean().optional(),
});

/**
 * @openapi
 * /api/class/dorm/apply/approve:
 *   post:
 *     tags: [宿舍信息]
 *     summary: 4.6 宿舍申请审批结果落地
 *     description: |
 *       由**教务管理**审批后回调（本模块也提供同签名接口便于本地演示）。
 *       通过时：学生宿舍号更新 + 写调宿记录；驳回时：必须给原因。
 *       通过前必须确认「宿舍物品完好」（hasGoodsChecked = true），否则拒绝。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [applyId, action]
 *             properties:
 *               applyId: { type: string }
 *               action: { type: string, enum: [approve, reject] }
 *               opinion: { type: string, description: 驳回时必填 }
 *               hasGoodsChecked: { type: boolean }
 *     responses:
 *       200: { description: 处理结果 }
 */
dormRouter.post(
  '/apply/approve',
  validate({ body: applyApproveSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof applyApproveSchema>;

    const apply = (await notDeleted(APPLY()).where('id', b.applyId).first()) as
      | Record<string, unknown>
      | undefined;
    if (!apply) throw Errors.applyNotFound('宿舍申请单不存在');
    if ((apply.apply_status as number) !== ApplyStatus.PENDING) {
      throw Errors.param('该申请单已处理过，不能重复审批');
    }

    const fromStatus = apply.apply_status as number;

    if (b.action === 'reject') {
      if (!b.opinion || !b.opinion.trim()) throw Errors.required('驳回原因');
      await APPLY().where({ id: b.applyId }).update({
        apply_status: ApplyStatus.REJECTED,
        reject_reason: b.opinion,
        approver_id: user.userId,
        approver_name: user.userName,
        approve_time: now(),
        ...baseUpdate(user),
      } as never);
      return ok(res, { applyId: b.applyId, applyStatus: ApplyStatus.REJECTED }, '已驳回该宿舍申请');
    }

    if (!b.hasGoodsChecked) {
      throw Errors.param('通过前请先确认宿舍物品完好');
    }

    await db.transaction(async (trx) => {
      await APPLY_TRX(trx).where({ id: b.applyId }).update({
        apply_status: ApplyStatus.APPROVED,
        has_goods_checked: 1,
        approver_id: user.userId,
        approver_name: user.userName,
        approve_time: now(),
        ...baseUpdate(user),
      } as never);

      // 写调宿记录（详情 → 宿舍 → 调宿记录）
      await tblInsTrx(trx, SRC, CHANGE_LOG_T, STAGE, {
        ...baseInsert(user),
        student_id: apply.student_id as string,
        student_no: apply.student_no as string,
        student_name: apply.student_name as string,
        from_dorm_id: (apply.from_dorm_id as string) ?? null,
        from_dorm_no: (apply.from_dorm_no as string) ?? null,
        to_dorm_id: (apply.to_dorm_id as string) ?? null,
        to_dorm_no: (apply.to_dorm_no as string) ?? null,
        change_time: now(),
        change_reason: (apply.apply_reason as string) ?? '',
      } as never);

      // 更新学生档案上的宿舍号
      const patch: Record<string, unknown> = { ...baseUpdate(user) };
      if ((apply.apply_category as number) === 1) {
        patch.dorm_id = apply.to_dorm_id ?? null;
        patch.dorm_no = apply.to_dorm_no ?? null;
      } else {
        patch.dorm_id = null;
        patch.dorm_no = null;
      }
      await STU_TRX(trx).where({ id: apply.student_id as string }).update(patch);
    });

    return ok(res, { applyId: b.applyId, applyStatus: ApplyStatus.APPROVED }, '审批通过，已更新宿舍信息');
  }),
);

/**
 * @openapi
 * /api/class/dorm/change/list:
 *   get:
 *     tags: [宿舍信息]
 *     summary: 4.7 调宿记录（详情 → 宿舍 → 调宿记录）
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: studentId, schema: { type: string } }
 *     responses:
 *       200: { description: 分页列表 }
 */
dormRouter.get(
  '/change/list',
  validate({ query: z.object({ ...pageQuerySchema.shape, studentId: z.string().optional() }) }),
  wrap(async (req, res) => {
    const query = q<{ page: number; size: number; studentId?: string }>(req);
    const base = CHANGE_LOG();
    notDeleted(base);
    if (query.studentId) base.where('student_id', query.studentId);
    base.orderBy('change_time', 'desc');

    const paged = await paginate(base, query, async (qb) =>
      rowsToCamel(await qb as Array<Record<string, unknown>>),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);
