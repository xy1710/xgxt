/**
 * 宿舍仓储 · 三学段统一版（第 4 期 · 第 1 批）
 * ============================================================
 *
 * 【★★ 斌哥 2026-10-10 拍板：初高 / 大学 / 实训 全部采用实训那套模型】
 *   原文：「初高中、大学、实训都在一个界面，那就都采用实训那套就行」
 *   语义：三学段共用一套「房间 / 床位 / 换宿单」模型，数据统一落 `sms_common`
 *        的 `t_uni_dorm_room` / `t_uni_dorm_bed` / `t_uni_dorm_change`，
 *        靠 `edu_stage` 区分学段。由 `makeRepo(stage)` 生成三份实例。
 *   → 原先 repo.classJh.ts（初高 varchar 状态）、repo.class.ts（大学只读同步表）
 *      两份实现已下线，不再维护。
 *   → 「大学是教务同步的只读数据」这个设定**作废**：
 *     `t_class_dorm_room_sync` / `t_class_dorm_live_sync` 两张同步表实测均为 **0 行**，
 *     大学宿舍页面本来就是空的。现在三个学段一样，数据我们自己录入，教务要读就读。
 *
 * 【★ 为什么「实训那套」是标准答案】
 *   · 房间状态原生 int（dorm_status 1正常/2停用）→ 不用做 varchar 翻译
 *   · 床位表自带学生快照（student_no/student_name/gender）→ 不用 join 在住表
 *   · `dorm_gender` 有 0 不限（另两学段没有）→ 统一 DTO 用这套口径
 *
 * 【★ 状态映射：统一 dorm_status → 前端房间状态】
 *   1 正常 → UnifiedDormStatus.IN_USE(1)
 *   2 停用 → UnifiedDormStatus.DISABLED(4)   ★ 不是 2！
 *   （统一码的 2 是「空置」，本模型没有「空置房间」概念 —— 房间要么有人住要么有空床）
 *
 * 【★ 已住人数不信 used_count】
 *   used_count 是冗余列 → 实时数 t_uni_dorm_bed 里 bed_status=2 的条数。
 *
 * 【★ 所有表访问一律走 tbl()，不再出现裸 db(TABLE)】
 *   开关关 → tbl() 落回 sms_job 老表
 *   开关开 → 落 sms_common 的 t_uni_dorm_*，自动注入 edu_stage 过滤
 */

import { randomUUID } from 'crypto';
import { BizCode } from 'shared-types';
import { db } from '../../utils/db';
import { BizError } from '../../middleware/errorHandler';
import {
  DORM_BED_STATUS_NAME,
  DORM_GENDER_NAME,
  DORM_STATUS_NAME,
  TEACHING_STAGE_NAME,
  UnifiedDormStatus,
} from '../shared/dto';
import type {
  DormAssignBody,
  DormBedRow,
  DormChangeCreateBody,
  DormChangeRow,
  DormListQuery,
  DormResidentRow,
  DormRow,
  DormSaveBody,
  DormStageMeta,
  DormSummary,
  TeachingStage,
} from '../shared/dto';
import { fmtDate, fmtDateTime } from '../shared/format';
import type { DormCandidateRow, DormRepo } from './types';
import { bedNoText } from 'shared-types/class';
import { hasRole, RoleCode, StudentStatus } from 'shared-types';
import { tbl, tblIns, upd, uniDb } from '../shared/uniTable';
import { visibleClassIds } from '../shared/dataScope';
import { listBuildingNames as listDormBuildingNames } from './building.service';

const DORM_T = 't_job_dorm';
const BED_T = 't_job_dorm_bed';
const CHANGE_T = 't_job_dorm_change';
/** ★ 实训的学生主档是 `t_student_base`（**不是** t_job_student —— 那张表不存在） */
const STUDENT_T = 't_student_base';
const CLASS_T = 't_job_class';
/** ★ 班级分派关系（教务给班级分的房间）—— 班主任据此看到自己班的房间 */
const ASSIGN_T = 'sms_edu.t_edu_dorm_assignment';
/** ★ 学生主档的候选来源（本学段表 + 门户活数据），入住/候选都按这个顺序兜底 */
const PERM_STUDENT = 'sms_perm.t_student_base';
const STUDENT_SOURCES = [
  'sms_class_jh.t_class_student',
  'sms_class.t_class_student',
  'sms_job.t_student_base',
  'sms_edu.t_student_base',
  PERM_STUDENT,
];

/**
 * ★ 三学段共用同一套「老表名」，库名统一写 sms_job。
 *   切读打开时，表名由 UNI_MAP 换成统一表，库名只用于查映射表 → 三学段都落同一张。
 */
const SRC_DB = 'sms_job';



/** ★ 实训 dorm_status → 统一房间状态（必须写死，不能正向反推） */
const JOB_ROOM_STATUS: Record<number, number> = {
  1: UnifiedDormStatus.IN_USE,
  2: UnifiedDormStatus.DISABLED,
};

/**
 * ★ 可以住宿舍的学生状态（`t_student_base.student_status` 列名不是 `status`！）
 *   3 试学中 / 5 正式在读 / 8 实训中
 *   休学(6)/退学(7)/流失(11) 不该占着床位。
 */
const IN_SCHOOL_STATUS: number[] = [
  StudentStatus.TRIAL,
  StudentStatus.STUDYING,
  StudentStatus.TRAINING,
];

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function rate(occupied: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((occupied / total) * 1000) / 10;
}

/** 三学段共用一份实现，只有 edu_stage 不同 */
export function makeRepo(stage: TeachingStage): DormRepo {

    /* ==========================================================
     * 表路由助手（三学段共用同一套「老表名」，由 UNI_MAP 决定落哪张统一表）
     *
     * 【为什么老表名统一用 sms_job 那套】
     *   初高/大学的老表（t_class_room / t_class_dorm_room_sync）在 UNI_MAP 里
     *   也映射到同一张统一表，切读打开后行为完全一致；
     *   开关关闭时统一表这套名字落到 sms_job 老表 —— 此时只有实训段的
     *   老数据能对上，初高/大学的数据需要种子脚本重灌（数据本来就是演示数据）。
     * ========================================================== */
    const T_DORM = () => tbl(db, SRC_DB, DORM_T, stage);
    const T_BED = () => tbl(db, SRC_DB, BED_T, stage);
    const T_CHANGE = () => tbl(db, SRC_DB, CHANGE_T, stage);
  
  const meta = (stage: TeachingStage): DormStageMeta => ({
    stage,
    stageName: TEACHING_STAGE_NAME[stage],
    hasCreate: true,
    hasFloor: false,
    // ★ 实训表没有负责人/宿舍长字段（宿舍长在 sync 表概念里，不在这张表）
    hasOwner: false,
    hasClass: false,
    hasRemark: true,
    hasBedTable: true,
    // ★ 原生就是 int
    roomStatusIsInt: true,
  });
  
/** ★ 班级表来源：三学段的班级表都要看（宿舍是合并页，班主任可能带别的学段的班） */
const CLASS_SOURCES = [
  'sms_class_jh.t_class_info',
  'sms_class.t_class_info',
  'sms_job.t_job_class',
];

/**
 * ★ 2026-10-21：解析「我的班」—— 同时兼容三种存法，别只认一种
 *
 * 现实里同一件事有三种数据：
 *   ① 班级表 `t_class_info.head_teacher_id` = 权限库用户 id（U008…）；
 *   ② 门户学生表 `t_student_base.head_teacher_id` = **门户账号 UUID**（token 里的 userId）；
 *   ③ 演示库干脆只填了 `head_teacher_name = '孙敏'`，id 列是 '123456' 这种脏值。
 * 只按 ① 查 → 班主任的班一个都找不到（宿舍页恒空、入住候选为空）。
 * → 这里把 id（业务 id / 门户 id）和姓名都作为命中条件，能查到哪种算哪种。
 *
 * ⚠️ 还要**跨学段**查班级表：合并页里「大学的班主任」也可能被安排带初高的班
 *   （实测 Q30 的班主任是 zhanght，但 Q30 在 sms_class_jh.t_class_info 里）。
 *   只查当前 stage 的班级表 → 分派给该班的房间永远看不到。
 */
async function myClasses(user: any): Promise<{ privileged: boolean; names: string[]; ids: string[] }> {
    const roles: string[] = user?.roles ?? [];
    const privileged =
      hasRole(roles, RoleCode.RM_PRINCIPAL) ||
      hasRole(roles, RoleCode.ACAD_STAFF) ||
      hasRole(roles, RoleCode.TEACH_DEAN) ||
      hasRole(roles, RoleCode.SYS_ADMIN);
    if (privileged) return { privileged: true, names: [], ids: [] };

    const portalUid = String(user?.businessUserId || user?.userId || user?.id || '');
    const userName = String(user?.userName || user?.name || '').trim();

    // 权限库业务 id（U008）：token 没带就按账号查一次
    let permUid = String(user?.businessUserId || '');
    if (!permUid && user?.account) {
      try {
        const u = (await db('sms_perm.t_perm_user').where({ account: String(user.account) }).first()) as any;
        permUid = u?.id ? String(u.id) : '';
      } catch {
        permUid = '';
      }
    }

    const names = new Set<string>();
    const ids = new Set<string>();

    const collect = (rows: any[]) => {
      for (const r of rows) {
        if (str(r.class_name)) names.add(String(r.class_name));
        if (r.id && str(r.class_name)) ids.add(String(r.id));
      }
    };

    // ① 班级表：班主任/教师/助理（业务 id 或姓名）—— **三学段班级表都查**
    for (const table of CLASS_SOURCES) {
      try {
        const rows = (await db(table)
          .where({ is_deleted: false })
          .andWhere((b: any) => {
            if (permUid) b.where('head_teacher_id', permUid).orWhere('teacher_id', permUid).orWhere('assistant_id', permUid);
            if (userName) {
              b.orWhere('head_teacher_name', userName).orWhere('teacher_name', userName).orWhere('assistant_name', userName);
            }
          })
          .select('id', 'class_name')) as any[];
        collect(rows);
      } catch {
        /* 表/列不存在 → 跳过 */
      }
    }

    // ② 门户学生表（活数据）：head_teacher_id 存的是门户 UUID
    try {
      const rows = (await db(PERM_STUDENT)
        .where({ is_deleted: false })
        .whereNotNull('class_name')
        .andWhere((b: any) => {
          if (portalUid) b.where('head_teacher_id', portalUid).orWhere('teacher_id', portalUid).orWhere('assistant_id', portalUid);
          if (userName) b.orWhere('head_teacher_name', userName);
        })
        .distinct('class_name')) as any[];
      collect(rows);
    } catch {
      /* 跳过 */
    }

    // ③ 本学段学生表（老数据）
    try {
      const rows = (await tbl(db, SRC_DB, STUDENT_T, stage)
        .where({ is_deleted: false })
        .whereNotNull('class_name')
        .andWhere((b: any) => {
          if (portalUid) b.where('head_teacher_id', portalUid).orWhere('teacher_id', portalUid).orWhere('assistant_id', portalUid);
          if (userName) b.orWhere('head_teacher_name', userName);
        })
        .distinct('class_name', 'class_id')) as any[];
      collect(rows);
    } catch {
      /* 跳过 */
    }

    return { privileged: false, names: [...names], ids: [...ids] };
  }

  /**
   * ★ 数据范围：沿用实训原有的角色判定口径
   *   校长 / 学管（学管主任·教质经理）/ 教务老师 / 系统管理员 → 全量
   *   班主任 / 教员 / 助教 → 只看自己班的宿舍（分派给本班的 + 本班学生住的）
   *
   * ⚠️ RoleCode 是**字符串枚举**（不是数字），别按数字写。
   *   实训没有「宿舍管理员」这个角色，教务老师（ACAD_STAFF）就是宿舍口的管理者。
   */
  async function scopedDormIds(user: any): Promise<string[] | null> {
    /* ★ 2026-10-19：统一走「交棒模型」的班级范围（与出勤/成绩/班级同口径）
         · 项目经理 → 自己负责且未结业的实训班
         · 就业老师 → 已结业（交棒）的班
         · 班主任三人组 → 自己带的班
         原来这里只按 head/teacher/assistant 查，项目经理/就业老师匹配不到 → 恒为空。 */
    const classIds = await visibleClassIds(stage, user);
    if (classIds === null) return null;
    if (!classIds.length) return [];

    const ids = new Set<string>();

    /**
     * ★ 2026-10-21（远端）：班主任要能看到**教务分派给本班的宿舍**，哪怕还没有学生入住 ——
     *   否则教务刚分派完、班主任还没填学生时，他看到的仍是「暂无数据」，分派等于白做。
     *   分派表只有 class_name 快照（没有 class_id），所以先按我的班取班名再匹配。
     */
    try {
      const myNames = (await uniDb('t_uni_class')
        .whereIn('id', classIds)
        .where({ is_deleted: 0 })
        .select('class_name')) as Array<{ class_name: string }>;
      const nameList = myNames.map((r) => String(r.class_name || '')).filter(Boolean);
      if (nameList.length) {
        const assigned = (await db(ASSIGN_T)
          .whereIn('class_name', nameList)
          .where({ is_deleted: false })
          .distinct('room_id')) as any[];
        for (const a of assigned) if (str(a.room_id)) ids.add(String(a.room_id));
      }
    } catch {
      /* 分派表不存在 → 跳过 */
    }

    /* ② 本班学生已经入住的房间（学生主档 dorm_id 是权威来源）
     *   统一表 sms_common.t_uni_student 为主，sms_perm.t_student_base 兜底老数据；
     *   两者都按 classIds 限定，不再用「班名」模糊匹配。 */
    const stayingSources: Array<() => any> = [
      () => tbl(db, SRC_DB, STUDENT_T, stage).whereIn('class_id', classIds),
      () => db(PERM_STUDENT).whereIn('class_id', classIds),
    ];
    for (const src of stayingSources) {
      try {
        const rows = (await src()
          .where({ is_deleted: false })
          .whereIn('student_status', IN_SCHOOL_STATUS)
          .whereNotNull('dorm_id')
          .andWhere('dorm_id', '<>', '')
          .distinct('dorm_id')) as any[];
        for (const r of rows) if (str(r.dorm_id)) ids.add(String(r.dorm_id));
      } catch {
        /* 表不存在 → 跳过 */
      }
    }
    return [...ids];
  }
  
  /** 房间列表 + 实时已住（数 t_job_dorm_bed 里 bed_status=2 的条数） */
  async function roomRows(q: DormListQuery, user: any): Promise<DormRow[]> {
    const qb = T_DORM().where({ is_deleted: false });
  
    const scope = await scopedDormIds(user);
    if (scope !== null) {
      if (!scope.length) return [];
      qb.whereIn('id', scope);
    }
  
    if (q.building) qb.andWhere('building', q.building);
    if (q.dormType !== undefined && q.dormType !== null) qb.andWhere('dorm_gender', q.dormType);
    if (q.roomStatus !== undefined && q.roomStatus !== null) {
      // ★ 反向：统一码 → 实训原码
      const jobCode = Object.keys(JOB_ROOM_STATUS).find(
        (k) => JOB_ROOM_STATUS[Number(k)] === q.roomStatus,
      );
      // 「空置(2)」实训没有 → 不加条件（别把整表筛空）
      if (jobCode) qb.andWhere('dorm_status', Number(jobCode));
    }
    /**
     * ★ 关键字**不在这里过滤**（2026-10-18 改）
     *
     * 旧实现在 SQL 里 like 了 room_no / building / dorm_no / facility 四个字段，
     * 但列表上真正展示的还有「类别（男寝/女寝）」「状态（使用中/停用）」「备注」——
     * 这些要么不在 like 范围内，要么是 int 码、得翻译成文字才搜得到。
     * 结果就是「列表上看得见、搜索框里搜不出来」。
     *
     * → 统一挪到 service.mergedRows()：三学段合并成 DormRow 之后再做内存匹配，
     *   匹配范围 = 列表全部可见列，且三学段口径天然一致（不用每个 repo 各写一遍）。
     *   这里保留注释说明「关键字故意不在此处理」，避免后人又加回来。
     */
  
    const rooms = await qb.select('*');
    if (!rooms.length) return [];
  
    const ids = rooms.map((r: any) => String(r.id));
    const beds = await T_BED().whereIn('dorm_id', ids).where({ is_deleted: false });
    const cntByDorm = new Map<string, number>();
    const bedTotal = new Map<string, number>();
    for (const b of beds) {
      const k = String(b.dorm_id);
      bedTotal.set(k, (bedTotal.get(k) ?? 0) + 1);
      if (Number(b.bed_status) === 2) cntByDorm.set(k, (cntByDorm.get(k) ?? 0) + 1);
    }

    /**
     * ★ 2026-10-12：已住人数以【学生主档的 dorm_id】为准
     *
     * 原来的口径只数床位表里 `bed_status=2` 的条数，但实测三学段 184 张床位
     * 的 bed_status **全部是 '1'（空闲）**，于是「已住」永远是 0 —— 明明有 18 个
     * 学生在住。学生主档的 `dorm_id` 才是「谁住哪」的权威来源（和入住/退宿
     * 流程写的是同一列）。床位表数字只作为兜底（房间没有任何学生指向它时）。
     */
    const staying = await tbl(db, SRC_DB, STUDENT_T, stage)
      .whereIn('dorm_id', ids)
      .where({ is_deleted: false })
      .whereIn('student_status', IN_SCHOOL_STATUS)
      .select('dorm_id');
    const occByDorm = new Map<string, number>();
    for (const s of staying) {
      const k = String((s as any).dorm_id ?? '');
      if (k) occByDorm.set(k, (occByDorm.get(k) ?? 0) + 1);
    }

    let rows = rooms.map((r: any) => {
      const total = bedTotal.get(String(r.id)) || Number(r.bed_count ?? 0);
      const occupied = occByDorm.get(String(r.id)) ?? cntByDorm.get(String(r.id)) ?? 0;
      const st = JOB_ROOM_STATUS[Number(r.dorm_status ?? 1)] ?? UnifiedDormStatus.IN_USE;
      const dt = numOrNull(r.dorm_gender) ?? 0;
      return {
        stage,
        stageName: TEACHING_STAGE_NAME[stage],
        dormId: String(r.id),
        buildingName: String(r.building ?? ''),
        roomNo: String(r.room_no ?? ''),
        floorNo: null,
        dormType: dt,
        dormTypeName: DORM_GENDER_NAME[dt] ?? '不限',
        bedCount: total,
        occupiedCount: occupied,
        occupancyRate: rate(occupied, total),
        roomStatus: st,
        roomStatusName: DORM_STATUS_NAME[st] ?? '使用中',
        ownerName: null,
        className: null,
        remark: str(r.remark),
      } satisfies DormRow;
    });
  
    if (q.onlyVacant) rows = rows.filter((r: DormRow) => r.occupiedCount < r.bedCount);
    return rows;
  }
  
  const repo: DormRepo = {
    stage,
    meta: () => meta(stage),
  
    async list(q, user) {
      return roomRows(q, user);
    },
  
    async detail(id, user) {
      const rows = await roomRows({ ...({ page: 1, size: 9999 } as any), stage }, user);
      return rows.find((r) => r.dormId === String(id)) ?? null;
    },
  
    async save(body: DormSaveBody, userId: string) {
      const id = body.id ? String(body.id) : randomUUID();
      // ★ 反向：统一码 → 实训 dorm_status
      const jobStatus =
        Object.keys(JOB_ROOM_STATUS).find(
          (k) => JOB_ROOM_STATUS[Number(k)] === (body.roomStatus ?? UnifiedDormStatus.IN_USE),
        ) ?? '1';
  
      const payload: Record<string, any> = {
        building: body.buildingName,
        room_no: body.roomNo,
        bed_count: body.bedCount ?? 4,
        dorm_gender: body.dormType ?? 0,
        dorm_status: Number(jobStatus),
        remark: body.remark ?? null,
        update_time: new Date(),
        update_by: userId,
      };
  
      if (body.id) {
        await T_DORM().where({ id: String(body.id), is_deleted: false }).update(payload);
        // 床位数变化时补齐/裁剪床位行（床位是独立表，房间表只存总数）
        await syncBeds(String(body.id), body.bedCount ?? 4, userId);
        return { id: String(body.id) };
      }
  
      // dorm_no 全局唯一（uk_dorm_no）：格式 楼栋-房号，如 `A栋-301`
      const dormNo = `${body.buildingName}-${body.roomNo}`;
      /**
       * ★★ 唯一性检查必须**把软删记录算进去**。
       *   `uk_dorm_no` 是数据库唯一索引，软删的记录行还在表里，索引还占着。
       *   如果这里只查 `is_deleted: 0`，会「查着不重复，插入却报
       *   ER_DUP_ENTRY / 50002 数据已存在」—— 用户看到的现象是
       *   「这个房间明明删了，却再也建不出来」，而且越删越死。
       *   → 所以这里**不带 is_deleted 条件**，让冲突提前在这里报友好提示。
       */
      const dup = await T_DORM().where({ dorm_no: dormNo }).first();
      if (dup) {
        if (Number(dup.is_deleted) === 1) {
          throw new Error(`宿舍编号 ${dormNo} 之前已删除过（记录仍在库中占唯一键），不能重复使用`);
        }
        throw new Error(`宿舍编号 ${dormNo} 已存在`);
      }
  
      payload.id = id;
      payload.dorm_no = dormNo;
      payload.used_count = 0;
      payload.create_time = new Date();
      payload.create_by = userId;
      payload.is_deleted = false;
      // ★ 必须用 tblIns：切读开启时它会补 edu_stage（统一表该列 NOT NULL 且无默认值）
      await tblIns(db, SRC_DB, DORM_T, stage, payload);
  
      // 新建即生成床位行（否则前端画不出格子）
      await syncBeds(id, body.bedCount ?? 4, userId);
      return { id };
    },
  
    /**
     * 删除房间（软删）
     *
     * ★★ 前置条件：房间里**没有入住学生**（2026-10-19 加严）
     *
     * 【为什么原来那条判据形同虚设】
     *   旧代码只看床位表 `bed_status = 2`。但「谁住哪」的权威来源是**学生主档
     *   的 dorm_id**（入住/退宿流程写的就是这一列，见本文件 roomRows 的注释），
     *   而床位表的 bed_status 常年全是 1（实测 184 行无一为 2）。
     *   → 结果：明明住着人的房间，旧判据说「没人」，照样删得掉。
     *
     * 【现在两条都查，任一命中就拒绝】
     *   ① 学生主档有在校学生指向本房间（权威口径）
     *   ② 床位表有床位处于「已住」状态（历史口径，兜底）
     *   宁可拦得多，也不能把住着人的房间删掉 —— 删了之后学生的 dorm_id
     *   指向一个软删房间，列表、入住率、换宿全部读到空。
     */
    async remove(id, userId) {
      const beds = await T_BED().where({ dorm_id: String(id), is_deleted: false });
      /**
       * ★ 抛 BizError 而不是普通 Error：
       *   普通 Error 会被 errorHandler 包装成 50001「服务器错误：…」，
       *   用户看到的是「系统坏了」；这是一条**业务规则**，应该是 40000 参数/业务错误。
       */
      if (beds.some((b: any) => Number(b.bed_status) === 2)) {
        throw new BizError(BizCode.PARAM_ERROR, '该宿舍还有学生入住，不能删除；请先办理退宿');
      }
      const [staying] = await tbl(db, SRC_DB, STUDENT_T, stage)
        .where({ dorm_id: String(id), is_deleted: false })
        .whereIn('student_status', IN_SCHOOL_STATUS)
        .count({ n: '*' });
      if (Number(staying?.n || 0) > 0) {
        throw new BizError(BizCode.PARAM_ERROR, '该宿舍还有学生入住，不能删除；请先办理退宿');
      }
      await T_DORM().where({ id: String(id) }).update({
        is_deleted: true,
        update_time: new Date(),
        update_by: userId,
      });
      await T_BED().where({ dorm_id: String(id) }).update({ is_deleted: true });
    },

    /**
     * ★★ 按「楼层数 × 每层房间数」批量生成房间（2026-10-19）
     *
     * 【房号规则：楼层 + 两位序号，长度跟着楼层位数走】
     *   1 楼第 1 间 = 101，1 楼第 12 间 = 112，5 楼第 8 间 = 508（3 位）
     *   10 楼第 8 间 = 1008，50 楼第 12 间 = 5012（4 位）
     *   与 dto 的 `dormRoomNo()` 和 /save 的 `DORM_ROOM_NO_ANY_RE`（3~4 位）同口径
     *   —— 生成的房间必须能被手工编辑那条链路再改一次，
     *     否则会出现「自动生成出来的房号，人工改不了」的怪事。
     *
     * 【★★ 幂等：已存在的房间跳过，软删的房间复活】
     *   ① 未删除的同 dorm_no 房间 → skipped（不重复建）
     *     场景：楼栋配置从 5 层改成 6 层，重跑只会补第 6 层，前 5 层原样不动。
     *   ② 软删的同 dorm_no 房间 → **复活**（不是新建）
     *     必须复活的原因：`uk_dorm_no` 是数据库唯一索引，**软删行仍占着这个键**，
     *     直接 insert 会撞 ER_DUP_ENTRY（本项目踩过同款坑，见 save() 注释）。
     *     用户视角：房间删过一次，再按楼栋配置生成，应该「回来了」而不是报错。
     *
     * 【为什么不做事务】
     *   生成是幂等的，中途失败再点一次确定就能补齐（已建好的会 skipped）。
     *   真要事务就得把跨库（sms_job 老表 ↔ sms_common 统一表）绑在一起，
     *   knex 做不到（见 uniTable.tblTrx 的注释）→ 不做假原子性，返回实际数量更诚实。
     */
    async generateRooms(input: {
      buildingName: string;
      dormType: number;
      floorCount: number;
      roomsPerFloor: number;
      bedPerRoom: number;
      userId: string;
    }): Promise<{ created: number; revived: number; skipped: number }> {
      let created = 0;
      let revived = 0;
      let skipped = 0;

      for (let f = 1; f <= input.floorCount; f += 1) {
        for (let s = 1; s <= input.roomsPerFloor; s += 1) {
          const roomNo = `${f}${String(s).padStart(2, '0')}`;
          const dormNo = `${input.buildingName}-${roomNo}`;
          // ★ 故意不带 is_deleted：软删行也占着 uk_dorm_no，必须看见它（见上）
          const exist = await T_DORM().where({ dorm_no: dormNo }).first();
          let id: string;

          if (exist) {
            if (Number(exist.is_deleted) === 0) {
              skipped += 1;
              continue;
            }
            id = String(exist.id);
            await T_DORM().where({ id }).update({
              building: input.buildingName,
              room_no: roomNo,
              bed_count: input.bedPerRoom,
              dorm_gender: input.dormType,
              dorm_status: 1,
              used_count: 0,
              remark: null,
              is_deleted: false,
              update_time: new Date(),
              update_by: input.userId,
            });
            /**
             * 房间被删时它名下的床位被整批软删了 → 一起复活。
             * 床位数可能与上次不同，交给下面的 syncBeds 补齐 / 裁剪。
             */
            await T_BED().where({ dorm_id: id }).update({ is_deleted: false, bed_status: 1 });
            revived += 1;
          } else {
            id = randomUUID();
            const now = new Date();
            await tblIns(db, SRC_DB, DORM_T, stage, {
              id,
              dorm_no: dormNo,
              building: input.buildingName,
              room_no: roomNo,
              bed_count: input.bedPerRoom,
              dorm_gender: input.dormType,
              dorm_status: 1,
              used_count: 0,
              remark: null,
              is_deleted: false,
              create_time: now,
              create_by: input.userId,
              update_time: now,
              update_by: input.userId,
            });
            created += 1;
          }

          // 新建即生成床位行（否则前端画不出格子）
          await syncBeds(id, input.bedPerRoom, input.userId);
        }
      }
      return { created, revived, skipped };
    },
  
    async beds(dormId) {
      const list = await T_BED()
        .where({ dorm_id: String(dormId), is_deleted: false })
        .orderBy('bed_no', 'asc');
      return list.map((b: any) => {
        const st = Number(b.bed_status ?? 1);
        return {
          bedId: String(b.id),
          bedNo: String(b.bed_no ?? ''),
          bedLabel: bedNoText(b.bed_no),
          bedStatus: st,
          bedStatusName: DORM_BED_STATUS_NAME[st] ?? '空闲',
          // ★ 床位表自带快照，不用 join
          studentId: str(b.student_id),
          studentNo: str(b.student_no),
          studentName: str(b.student_name),
          gender: numOrNull(b.student_gender),
          checkInDate: fmtDate(b.check_in_date),
          className: null,
        };
      });
    },
  
    async residents(q, user) {
      const rows = await roomRows({ ...q, page: 1, size: 9999 }, user);
      const byId = new Map(rows.map((r) => [r.dormId, r]));
      const beds = await T_BED().where({ is_deleted: false, bed_status: 2 });
      const out: DormResidentRow[] = [];
      for (const b of beds) {
        const room = byId.get(String(b.dorm_id));
        if (!room) continue;
        const g = numOrNull(b.student_gender) ?? 0;
        out.push({
          stage,
          studentId: String(b.student_id ?? ''),
          studentNo: String(b.student_no ?? ''),
          studentName: String(b.student_name ?? ''),
          gender: g,
          genderName: g === 1 ? '男' : g === 2 ? '女' : '未知',
          dormId: room.dormId,
          roomNo: room.roomNo,
          bedId: String(b.id),
          bedNo: String(b.bed_no ?? ''),
          bedLabel: bedNoText(b.bed_no),
          checkInDate: fmtDate(b.check_in_date),
          classId: null,
          className: null,
        });
      }
      return out;
    },
  
    /**
     * ★ 办理入住的学生候选（2026-10-21）
     *
     * 数据范围：
     *   · 校长 / 教务 / 学管 / 管理员 → 全量学生；
     *   · 班主任 / 教员 / 助教 → 只列自己班的学生（与房间列表同一套「我的班」判定）。
     * 只返回**还没入住**的学生（学生主档 dorm_id 为空，且床位表里没有占床记录），
     * 避免把已住学生的床位重复占用。
     *
     * 取数：本学段学生表 + 门户学生表（演示库只有后者有活数据），按学号去重。
     */
    async candidates(q, user): Promise<DormCandidateRow[]> {
      const mine = await myClasses(user);
      if (!mine.privileged && !mine.names.length && !mine.ids.length) return [];

      const kw = str(q.keyword)?.trim();
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
      const sources = ['stage', PERM_STUDENT]; // 本学段学生表 + 门户活数据
      const rows: any[] = [];

      for (const table of sources) {
        try {
          // 本学段表名映射（tbl 会按 stage 换成 sms_class_jh / sms_class）
          const base = table === PERM_STUDENT ? db(PERM_STUDENT) : tbl(db, SRC_DB, STUDENT_T, stage);
          const qb = base
            .where({ is_deleted: false })
            .whereIn('student_status', IN_SCHOOL_STATUS)
            // 未入住：dorm_id 为空（老数据可能是空串）
            .andWhere((b: any) => b.whereNull('dorm_id').orWhere('dorm_id', ''));
          if (!mine.privileged) {
            qb.andWhere((b: any) => {
              if (mine.ids.length) b.whereIn('class_id', mine.ids);
              if (mine.names.length) b.orWhereIn('class_name', mine.names);
            });
          }
          if (kw) {
            qb.andWhere((b: any) =>
              b.where('student_name', 'like', `%${kw}%`).orWhere('student_no', 'like', `%${kw}%`),
            );
          }
          rows.push(
            ...((await qb
              .select('id', 'student_no', 'student_name', 'gender', 'class_id', 'class_name', 'dorm_no')
              .limit(limit)) as any[]),
          );
        } catch {
          /* 表不存在 → 跳过 */
        }
      }

      // 按学号去重（同一学生在多张表里是投影）
      const byNo = new Map<string, any>();
      for (const r of rows) {
        const key = str(r.student_no) || String(r.id);
        if (!byNo.has(key)) byNo.set(key, r);
      }
      const picked = [...byNo.values()].slice(0, limit);

      // 兜底：床位表里已占床的（学生主档可能没回写 dorm_id）不算候选
      const ids = picked.map((r) => String(r.id));
      const nos = picked.map((r) => str(r.student_no)).filter(Boolean) as string[];
      const usedIds = new Set<string>();
      const usedNos = new Set<string>();
      if (ids.length || nos.length) {
        const beds = (await T_BED()
          .where({ is_deleted: false, bed_status: 2 })
          .andWhere((b: any) => {
            if (ids.length) b.whereIn('student_id', ids);
            if (nos.length) b.orWhereIn('student_no', nos);
          })
          .select('student_id', 'student_no')) as any[];
        for (const b of beds) {
          if (str(b.student_id)) usedIds.add(String(b.student_id));
          if (str(b.student_no)) usedNos.add(String(b.student_no));
        }
      }

      return picked
        .filter((r) => !usedIds.has(String(r.id)) && !usedNos.has(str(r.student_no) || ''))
        .map((r) => {
          const g = numOrNull(r.gender) ?? 0;
          return {
            stage,
            studentId: String(r.id),
            studentNo: str(r.student_no) || '',
            studentName: str(r.student_name) || '',
            gender: g,
            classId: str(r.class_id),
            className: str(r.class_name),
            dormNo: str(r.dorm_no),
          } satisfies DormCandidateRow;
        });
    },

    async assign(body: DormAssignBody, userId: string) {
      /**
       * ★ 2026-10-21：学生主档兜底（与本文件 changeCreate 同口径）
       *   部分环境（演示库 / 门户投影）里本学段学生表没有在读学生，
       *   活数据在 `sms_perm.t_student_base`。只查前者会直接「学生不存在」。
       */
      let st: any = await tbl(db, SRC_DB, STUDENT_T, stage)
        .where({ id: String(body.studentId), is_deleted: false })
        .first();
      if (!st) {
        st = await db(PERM_STUDENT)
          .where({ id: String(body.studentId), is_deleted: false })
          .first();
      }
      if (!st) throw new Error('学生不存在');
      if (!IN_SCHOOL_STATUS.includes(numOrNull(st.student_status) ?? 0)) {
        throw new Error('该学生不是在读状态，不能办理入住');
      }
  
      const dorm = await T_DORM().where({ id: String(body.dormId), is_deleted: false }).first();
      if (!dorm) throw new Error('宿舍不存在');
      if (Number(dorm.dorm_status) === 2) throw new Error('该宿舍已停用，不能入住');
  
      const bed = await T_BED().where({ id: String(body.bedId), is_deleted: false }).first();
      if (!bed) throw new Error('床位不存在');
      if (Number(bed.bed_status) === 2) throw new Error('该床位已被占用');
      if (Number(bed.bed_status) === 3) throw new Error('该床位已停用，不能入住');
  
      // ★ 性别校验：dorm_gender 0=不限，另两学段没这个概念
      const dormGender = Number(dorm.dorm_gender ?? 0);
      const sGender = numOrNull(st.gender) ?? 0;
      if (dormGender !== 0 && sGender !== 0 && dormGender !== sGender) {
        throw new Error(
          `性别不匹配：该宿舍是${DORM_GENDER_NAME[dormGender]}，学生是${sGender === 1 ? '男生' : '女生'}`,
        );
      }
  
      const genderName = sGender === 1 ? '男' : sGender === 2 ? '女' : '未知';
  
      // ★ 先释放该学生可能已占的旧床位（换寝场景兜底）
      const oldBeds = await T_BED()
        .where({ student_id: String(body.studentId), is_deleted: false, bed_status: 2 });
      for (const ob of oldBeds) {
        await T_BED().where({ id: String(ob.id) }).update({
          bed_status: 1,
          student_id: null,
          student_no: null,
          student_name: null,
          student_gender: null,
          check_in_date: null,
        });
      }
  
      await T_BED().where({ id: String(body.bedId) }).update({
        bed_status: 2,
        student_id: String(body.studentId),
        student_no: str(st.student_no),
        student_name: str(st.student_name),
        student_gender: sGender,
        check_in_date: body.checkInDate || new Date().toISOString().slice(0, 10),
        update_time: new Date(),
        update_by: userId,
      });
  
      await refreshUsedCount(String(body.dormId));
      // 学生主档同步宿舍号（合并前的页面也是这么做的）
      const synced = await tbl(db, SRC_DB, STUDENT_T, stage).where({ id: String(body.studentId) }).update({
        dorm_id: dorm.id,
        dorm_no: dorm.dorm_no,
      });
      // ★ 学生来自门户表时，本学段表 update 影响 0 行 → 回写门户表
      if (!synced) {
        await db(PERM_STUDENT).where({ id: String(body.studentId) }).update({
          dorm_id: dorm.id,
          dorm_no: dorm.dorm_no,
        });
      }
      void genderName;
    },
  
    async checkout(dormId, bedId, userId) {
      const bed = await T_BED().where({ id: String(bedId), is_deleted: false }).first();
      if (!bed) throw new Error('床位不存在');
      if (Number(bed.bed_status) !== 2) throw new Error('该床位没有学生入住');
  
      const sid = bed.student_id;
      await T_BED().where({ id: String(bedId) }).update({
        bed_status: 1,
        student_id: null,
        student_no: null,
        student_name: null,
        student_gender: null,
        check_in_date: null,
        update_time: new Date(),
        update_by: userId,
      });
      if (sid) {
        const cleared = await tbl(db, SRC_DB, STUDENT_T, stage)
          .where({ id: String(sid) })
          .update({ dorm_id: null, dorm_no: null });
        if (!cleared) {
          await db(PERM_STUDENT).where({ id: String(sid) }).update({ dorm_id: null, dorm_no: null });
        }
      }
      await refreshUsedCount(String(dormId));
    },
  
    /**
     * ★ 楼栋下拉 = **只取「系统设置 → 楼栋设置」里维护的楼栋**（2026-10-18 改）
     *
     * 【旧口径为什么被推翻】
     *   之前是「设置表 ∪ 房间表已在用楼栋」的并集，理由是怕历史楼栋丢。
     *   但并集带来一个更难收拾的问题：库里躺着 BB-1 / A-1 这类**只在房间表出现、
     *   设置页根本没有**的脏楼栋，它们会混在下拉里 —— 用户以为这是系统认的楼，
     *   选它、照它建房间，脏数据就越滚越多。
     *
     * 【现在的口径】设置表是**唯一权威**：
     *   · 设置页没有的楼栋 = 系统不认 → 下拉里不出现，也不该再被选用；
     *   · 顺序由设置表的 sort_no 决定（见 building.service.listBuildings）。
     *
     * 【存量数据怎么办】房间表里的历史楼栋**不会被改写**（本函数只读），
     *   只是下拉筛不到它们。要清理的话在设置页把它们加回来、或改房间的楼栋，
     *   属于数据治理动作，不该由下拉的取数逻辑悄悄兜着。
     */
    async buildings(_user) {
      const names = await listDormBuildingNames();
      return names
        .map((n) => String(n ?? '').trim())
        .filter(Boolean)
        .map((v) => ({ value: v, label: v }));
    },
  
    async changeList(q, user) {
      const qb = T_CHANGE().where({ is_deleted: false });
      if (q.keyword) {
        const kw = `%${q.keyword}%`;
        qb.andWhere((b: any) => {
          b.where('student_name', 'like', kw)
            .orWhere('student_no', 'like', kw)
            .orWhere('old_dorm_no', 'like', kw)
            .orWhere('new_dorm_no', 'like', kw);
        });
      }
      const list = await qb.orderBy('create_time', 'desc');
      const uid = String(user?.userId ?? user?.id ?? '');
      const roles: string[] = user?.roles ?? [];

      /**
       * ★ 2026-10-21：床位号兜底
       *
       * 早期单据只存了 old_bed_id / new_bed_id，*_bed_no 是 NULL ——
       * 审批表就会显示「1号楼-303」却看不到床位。这里按 id 回查床位表补上，
       * 老数据也不用洗。
       */
      const bedIds = [
        ...new Set(
          list
            .flatMap((a: any) => [str(a.old_bed_id), str(a.new_bed_id)])
            .filter(Boolean) as string[],
        ),
      ];
      const bedMap = new Map<string, string>();
      if (bedIds.length) {
        const beds = (await T_BED().whereIn('id', bedIds).select('id', 'bed_no')) as any[];
        for (const b of beds) bedMap.set(String(b.id), bedNoText(b.bed_no));
      }

      return list.map((a: any) => {
        const st = Number(a.approval_status ?? 1);
        const isPending = st === 2 || st === 3;
        // 教务老师 / 校长 / 系统管理员可批；发起人只能撤回自己那条
        const canApprove =
          isPending &&
          (hasRole(roles, RoleCode.ACAD_STAFF) ||
            hasRole(roles, RoleCode.RM_PRINCIPAL) ||
            hasRole(roles, RoleCode.SYS_ADMIN));
        const canCancel =
          (st === 1 || st === 2 || st === 3) && String(a.create_by ?? '') === uid;
        return {
          stage,
          stageName: TEACHING_STAGE_NAME[stage],
          changeId: String(a.id),
          bizType: Number(a.biz_type ?? 1),
          bizTypeName: Number(a.biz_type) === 2 ? '退宿' : '调换宿舍',
          studentId: String(a.student_id ?? ''),
          studentNo: str(a.student_no),
          studentName: str(a.student_name),
          gender: numOrNull(a.gender),
          phone: str(a.phone),
          classId: str(a.class_id),
          className: str(a.class_name),
          headTeacherName: str(a.head_teacher_name),
          oldDormId: str(a.old_dorm_id),
          oldDormNo: str(a.old_dorm_no),
          oldBedNo: str(a.old_bed_no) || bedMap.get(str(a.old_bed_id) || '') || null,
          newDormId: str(a.new_dorm_id),
          newDormNo: str(a.new_dorm_no),
          newBedNo: str(a.new_bed_no) || bedMap.get(str(a.new_bed_id) || '') || null,
          changeDate: fmtDate(a.change_date) ?? '',
          changeReason: String(a.change_reason ?? ''),
          approvalStatus: st,
          approvalStatusName:
            st === 1 ? '待提交' : st === 2 ? '待审批' : st === 4 ? '已通过' : st === 5 ? '已驳回' : st === 6 ? '已撤销' : '未知',
          canApprove,
          canCancel,
          createTime: fmtDateTime(a.create_time),
        } satisfies DormChangeRow;
      });
    },
  
    async changeCreate(body: DormChangeCreateBody, userId: string) {
      const isCheckout = Number(body.bizType) === 2;
      if (!isCheckout && !body.newDormId) throw new Error('调换宿舍必须选择目标宿舍');
      if (!isCheckout && !body.newBedId) throw new Error('调换宿舍必须选择目标床位');
  
      /**
       * ★ 学生主档兜底（2026-10-20）
       *
       * 宿舍域的学生快照取自 `t_student_base`，但部分环境（演示库 / 门户投影）
       * 里这张表没有在读学生，学生实际在 `sms_perm.t_student_base`。
       * 调宿申请若只认前者会直接「学生不存在」，所以补一层门户学生表兜底 ——
       * 单子仍写本学段的 t_job_dorm_change，快照列用兜底表的姓名/学号/性别。
       */
      let st: any = await tbl(db, SRC_DB, STUDENT_T, stage)
        .where({ id: String(body.studentId), is_deleted: false })
        .first();
      if (!st) {
        st = await db('sms_perm.t_student_base')
          .where({ id: String(body.studentId), is_deleted: false })
          .first();
      }
      if (!st) throw new Error('学生不存在');
  
      let oldDorm: any = null;
      let newDorm: any = null;
      if (body.oldDormId) oldDorm = await T_DORM().where({ id: String(body.oldDormId) }).first();
      if (body.newDormId) newDorm = await T_DORM().where({ id: String(body.newDormId) }).first();
  
      // 目标床位必须空闲（退宿不需要）
      if (!isCheckout && body.newBedId) {
        const bed = await T_BED().where({ id: String(body.newBedId), is_deleted: false }).first();
        if (!bed) throw new Error('目标床位不存在');
        if (Number(bed.bed_status) === 2) throw new Error('目标床位已被占用，请换一个');
        if (Number(bed.bed_status) === 3) throw new Error('目标床位已停用');
      }
  
      /**
       * 班级名：优先用学生快照里的 class_name（门户/教务学生表只有班级名、没有 class_id），
       * 没有才回班级表按 class_id 反查。
       */
      let className: string | null = str(st.class_name);
      if (!className && st.class_id) {
        const c = await tbl(db, SRC_DB, CLASS_T, stage).where({ id: String(st.class_id) }).first();
        className = c ? str(c.class_name) : null;
      }

      /**
       * ★ 2026-10-21：床位号也要落库（审批页与审批通过后的释放/占用都靠它）
       *   老实现把 old_bed_no / new_bed_no 写死 null，导致审批通过时
       *   退宿释放不了旧床位、调宿也说不清换到哪张床。
       */
      let oldBedNo: string | null = null;
      let newBedNo: string | null = null;
      if (body.oldBedId) {
        const ob = await T_BED().where({ id: String(body.oldBedId) }).first();
        if (ob) oldBedNo = bedNoText(ob.bed_no);
      }
      if (!isCheckout && body.newBedId) {
        const nb = await T_BED().where({ id: String(body.newBedId) }).first();
        if (nb) newBedNo = bedNoText(nb.bed_no);
      }

      /**
       * ★ 2026-10-21：防重复提交
       *   同一学生、同一类型、同一目标床位已有一条「待审批」时直接拦下 ——
       *   否则审批表会出现多条一模一样的单子，批一条还留两条。
       */
      const dupQb = T_CHANGE()
        .where({ is_deleted: false, student_id: String(body.studentId), approval_status: 2 })
        .andWhere('biz_type', isCheckout ? 2 : 1);
      if (!isCheckout && body.newBedId) dupQb.andWhere('new_bed_id', String(body.newBedId));
      const dupRow = await dupQb.first();
      if (dupRow) throw new Error('该学生已有相同的待审批申请，请勿重复提交');

      const id = randomUUID();
      await tblIns(db, SRC_DB, CHANGE_T, stage, {
        id,
        create_time: new Date(),
        create_by: userId,
        is_deleted: false,
        biz_type: isCheckout ? 2 : 1,
        student_id: String(body.studentId),
        student_no: str(st.student_no),
        student_name: str(st.student_name),
        gender: numOrNull(st.gender),
        phone: str(st.phone),
        class_id: str(st.class_id),
        class_name: className,
        head_teacher_id: null,
        head_teacher_name: null,
        old_dorm_id: body.oldDormId ? String(body.oldDormId) : null,
        old_dorm_no: oldDorm ? str(oldDorm.dorm_no) : null,
        old_bed_id: body.oldBedId ? String(body.oldBedId) : null,
        old_bed_no: oldBedNo,
        new_dorm_id: isCheckout ? null : body.newDormId ? String(body.newDormId) : null,
        new_dorm_no: isCheckout ? null : newDorm ? str(newDorm.dorm_no) : null,
        new_bed_id: isCheckout ? null : body.newBedId ? String(body.newBedId) : null,
        new_bed_no: newBedNo,
        change_date: body.changeDate,
        change_reason: body.changeReason,
        approval_status: 2, // 直接进「待审批」，避免还要再点一次提交
      });
      return { id };
    },
  
    async applyChangeOnApproved(changeId, userId) {
      const a = await T_CHANGE().where({ id: String(changeId), is_deleted: false }).first();
      if (!a) throw new Error('调宿单不存在');

      /**
       * ① 释放旧床位
       *
       * 老单据可能没记 `old_bed_id`（上一版 changeCreate 写死 null），
       * 这时按「学生 id + 已住」反查一次，避免退宿批了床位还占着。
       */
      let oldBedId = a.old_bed_id ? String(a.old_bed_id) : '';
      if (!oldBedId && a.student_id) {
        const ob = await T_BED()
          .where({ is_deleted: false, bed_status: 2, student_id: String(a.student_id) })
          .first();
        if (ob) oldBedId = String(ob.id);
      }
      if (oldBedId) {
        await T_BED().where({ id: oldBedId }).update({
          bed_status: 1,
          student_id: null,
          student_no: null,
          student_name: null,
          student_gender: null,
          check_in_date: null,
          update_time: new Date(),
          update_by: userId,
        });
      }
      // ② 占用新床位
      if (a.new_bed_id) {
        await T_BED().where({ id: String(a.new_bed_id) }).update({
          bed_status: 2,
          student_id: a.student_id,
          student_no: a.student_no,
          student_name: a.student_name,
          student_gender: a.gender,
          check_in_date: a.change_date,
          update_time: new Date(),
          update_by: userId,
        });
      }
      // ③ 学生主档同步（本学段表没有该学生时，退回门户学生表，见 changeCreate 的兜底说明）
      const synced = await tbl(db, SRC_DB, STUDENT_T, stage)
        .where({ id: String(a.student_id) })
        .update({
          dorm_id: a.new_dorm_id ?? null,
          dorm_no: a.new_dorm_no ?? null,
        });
      if (!synced) {
        await db('sms_perm.t_student_base').where({ id: String(a.student_id) }).update({
          dorm_id: a.new_dorm_id ?? null,
          dorm_no: a.new_dorm_no ?? null,
        });
      }
      // ④ 两端 used_count 重算
      if (a.old_dorm_id) await refreshUsedCount(String(a.old_dorm_id));
      if (a.new_dorm_id) await refreshUsedCount(String(a.new_dorm_id));
    },

    /** ★ 2026-10-21：审批通过 —— 先落库（换床/退宿），再把单据置为已通过 */
    async changeApprove(changeId, userId) {
      const a = await T_CHANGE().where({ id: String(changeId), is_deleted: false }).first();
      if (!a) throw new Error('申请不存在或已删除');
      const st = Number(a.approval_status ?? 0);
      if (st !== 2 && st !== 3) throw new Error('该申请不是「待审批」状态，不能重复审批');
      await repo.applyChangeOnApproved(changeId, userId);
      await T_CHANGE().where({ id: String(changeId) }).update({
        approval_status: 4, // 已通过
        update_time: new Date(),
        update_by: userId,
      });
    },

    /** ★ 2026-10-21：审批驳回 —— 只改状态，不动床位/学生 */
    async changeReject(changeId, reason, userId) {
      const a = await T_CHANGE().where({ id: String(changeId), is_deleted: false }).first();
      if (!a) throw new Error('申请不存在或已删除');
      const st = Number(a.approval_status ?? 0);
      if (st !== 2 && st !== 3) throw new Error('该申请不是「待审批」状态，不能重复审批');
      await T_CHANGE().where({ id: String(changeId) }).update({
        approval_status: 5, // 已驳回
        remark: reason || null,
        update_time: new Date(),
        update_by: userId,
      });
    },
  
    async summary(q, user) {
      const rows = await roomRows({ ...q, page: 1, size: 9999 }, user);
      const bedCount = rows.reduce((s, r) => s + r.bedCount, 0);
      const occupied = rows.reduce((s, r) => s + r.occupiedCount, 0);
      return {
        stage,
        stageName: TEACHING_STAGE_NAME[stage],
        roomCount: rows.length,
        bedCount,
        occupiedCount: occupied,
        occupancyRate: rate(occupied, bedCount),
        vacantBeds: bedCount - occupied,
      } satisfies DormSummary;
    },
  };
  
  /** 实时重算 used_count（冗余列，但原表有这个列，别让它长期失真） */
  async function refreshUsedCount(dormId: string): Promise<void> {
    const beds = await T_BED().where({ dorm_id: dormId, is_deleted: false });
    const used = beds.filter((b: any) => Number(b.bed_status) === 2).length;
    await T_DORM().where({ id: dormId }).update({ used_count: used, update_time: new Date() });
  }
  
  /** 按 bed_count 补齐 / 裁剪床位行（床位是独立表，房间表只存总数） */
  async function syncBeds(dormId: string, target: number, userId: string): Promise<void> {
    const beds = await T_BED().where({ dorm_id: dormId, is_deleted: false });
    const used = beds.filter((b: any) => Number(b.bed_status) === 2).length;
  
    if (beds.length > target) {
      // 只裁剪空闲床，已住的不动（否则会踢人）
      const free = beds.filter((b: any) => Number(b.bed_status) !== 2);
      const surplus = beds.length - target;
      for (const b of free.slice(0, surplus)) {
        await T_BED().where({ id: String(b.id) }).update({ is_deleted: true });
      }
      return;
    }
    if (beds.length < target) {
      const dorm = await T_DORM().where({ id: dormId }).first();
      /**
       * ★★ 续号必须把**软删床位**也算进来（否则撞 uk_dorm_bed）
       *
       * 【原来为什么错】
       *   上面 `beds` 是 `is_deleted: false` 的活跃床位，`start` 取它们的最大 bed_no。
       *   但裁剪时删掉的是 `free.slice(0, surplus)`（**无 orderBy，顺序不保证**）——
       *   完全可能删掉编号最大的那几张。
       *   于是「4 张床 → 裁到 2 张（删了 3/4 床）→ 再扩到 4 张」时：
       *     active = [1,2] → start = 2 → 新增 bed_no 3、4
       *   → 与「已软删但仍在表里、且占着 uk_dorm_bed(room_id, bed_no, edu_stage)」的
       *     3/4 号床**撞唯一键**。老表 `t_job_dorm_bed` 无此唯一索引，一直掩盖着。
       *
       * 【改法】取号范围改用**全量**（含软删）床位的最大 bed_no。
       *   软删的号段从此不再复用 —— 与「唯一键永久占位」的语义保持一致。
       */
      const allBeds = (await T_BED().where({ dorm_id: dormId }).select('bed_no')) as Array<Record<string, any>>;
      const start = allBeds.reduce((mx: number, b: any) => Math.max(mx, Number(b.bed_no ?? 0)), 0);
      const rows = [];
      for (let i = start + 1; i <= target; i += 1) {
        rows.push({
          id: randomUUID(),
          create_time: new Date(),
          create_by: userId,
          is_deleted: false,
          dorm_id: dormId,
          dorm_no: dorm?.dorm_no ?? '',
          /**
           * ★★ `room_id` / `room_no` 是 **t_uni_dorm_bed 才有**的列，
           *   而 `uk_dorm_bed(room_id, bed_no, edu_stage)` 是带 room_id 的唯一索引。
           *   只写 dorm_id → 切读时 room_id 落空串 → 建第 2 个床位就
           *   `Duplicate entry '''-1-job' for key 'uk_dorm_bed'`（实测踩过）。
           *   → 切读时必须同时写 room_id（语义与 dorm_id 完全相同）。
           *   开关关闭时这两个字段老表没有，tblIns 会原样透传 →
           *   会报 Unknown column，所以由 tblIns 之后按开关剔除。
           */
          room_id: dormId,
          room_no: dorm?.room_no ?? dorm?.dorm_no ?? '',
          bed_no: String(i),
          bed_status: 1,
        });
      }
      // ★ 床位是批量插，逐条走 tblIns 才能补 edu_stage
      if (rows.length) {
        for (const r of rows) await tblIns(db, SRC_DB, BED_T, stage, r);
      }
    }
      void used;
    }

    return repo;
  }
