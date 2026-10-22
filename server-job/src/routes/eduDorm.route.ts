/**
 * 宿舍管理路由
 *
 * 来源：教务管理原型 dorm.html
 *
 * 三个 Tab 对应的接口：
 *   1. 宿舍总名单  GET  /list           （每页按「间」分页，每间固定返回 8 个床位）
 *                  GET  /stats          （宿舍总数 / 男寝 / 女寝 / 空余床位）
 *                  POST /room/add
 *                  PUT  /room/info      （改类别/楼栋/房号/额定）
 *                  PUT  /room/occupants （改入住学生）
 *                  DELETE /room/delete/:id
 *   2. 申请审批     GET  /change/list、/quit/list
 *                  POST /change/approve、/change/reject
 *                  POST /quit/approve、/quit/reject
 *                  GET  /approval-stats
 *   3. 退宿名单     GET  /checkout/list、/checkout/export
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  BizCode,
  DormCategory,
  DORM_CATEGORY_NAME,
  ApplyStatus,
  APPLY_STATUS_NAME,
  BED_OPTIONS,
  ALL_CLASSES,
  DORM_PAGE_SIZE,
} from 'shared-types/edu';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
// ★ P3 切读层：本文件**跨域只读**的那几张老表已归一 → 走 tbl() / tblTrx()；
//   `sms_edu` 自己的 6 张表（ROOM / BED / ASSIGN / CHANGE / QUIT / CHECKOUT）
//   尚未归一（无统一表）→ 保持裸访问，见下方常量区的分组注释。
import { tbl, tblTrx } from '../teaching/shared/uniTable';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
// ★ 2026-10-03 合并：教务审批时要能"跨库回写"就业侧的申请单 + 床位
import { doApprove, doReject } from '../utils/approval';
import { afterApproved } from './dorm.route';
import { ApprovalStatus, GENDER_NAME } from 'shared-types';
// ★ 信息流转：教务分派/调整宿舍 → 推送班级管理（只读副本）
import { syncEduDormToClass } from '../services/dorm-sync.service';

export const dormRouter = Router();

/**
 * ★ 分组：以下 6 张常量是 **教务自己** 的表（sms_edu），
 *   全库**未归一**（sms_edu 域没有统一表）→ 保持裸访问 `db(常量)`。
 *   注：`CHANGE` / `QUIT` 这两张老表在 `_uni-readiness.mjs` 里是**空表**，
 *   但「申请单」由实训侧同步写入（`dormBridge`），不能想当然当成死表。
 */
const ROOM = 'sms_edu.t_edu_dorm_room';
const BED = 'sms_edu.t_edu_dorm_bed';
const CHANGE = 'sms_edu.t_edu_dorm_change_apply';
const QUIT = 'sms_edu.t_edu_dorm_quit_apply';
const CHECKOUT = 'sms_edu.t_edu_dorm_checkout';
const ASSIGN = 'sms_edu.t_edu_dorm_assignment';

/**
 * ★ 2026-10-03 合并：实训宿舍（在就业库，只读并进教务总名单）
 *
 * ★ P3 切读层：这 3 张表（外加下面的 `t_job_dorm_change`）**已归一** →
 *   读写一律走 `tbl(db, JOB_DB, 表名, JOB_STAGE)` / `tblTrx(trx, …)`，
 *   不能再直接 `db('t_job_dorm')`（开关开时会绕过统一表）。
 */
const JOB_DORM = 't_job_dorm';
const JOB_BED = 't_job_dorm_bed';
const JOB_STUDENT = 't_student_base';

/**
 * ★ 2026-10-05 大学部（sms_class）宿舍 —— 数据源是**学生表字段**，不是宿舍表
 *
 * 【为什么没有房间表/床位表】
 *   班级模块（8003）当初没建宿舍表，宿舍信息直接挂在 `t_class_student` 上：
 *     dorm_building → 宿舍楼（20261005 新加，靠 dorm_no 首位回填）
 *     dorm_no       → 房间号（201/301 这种三段式）
 *     bed_no        → 床位序号（纯数字 1/2/3/4）
 *   所以这里只能「按房间号动态分组」把它聚合成「间」——**只读，不反写**。
 *
 * 【床位号要转成「1-上/1-下」】
 *   大学部存的是纯序号，全项目约定是「奇上偶下」：1→1上 / 2→1下 / 3→2上 / 4→2下。
 *   ⚠️ 转换只在查询时做，**不改存量数据** —— 8003 那边也在读这个字段。
 *
 * ★ P3 切读层：老写法是「库.表」全限定字符串，`tbl()` 要把「库名 + 表名」分开传，
 *   所以拆成 CLASS_DB / CLASS_STUDENT 两个常量（与 `src/routes/dorm.route.ts` 同款）。
 */
const CLASS_STUDENT = 't_class_student';
const CLASS_DB = 'sms_class';
/** 大学部在统一表 `edu_stage` 里的取值 */
const CLASS_STAGE = 'class' as const;

/** ★ 实训/就业侧四张跨域只读表（与 eduDorm 同库：sms_job） */
const JOB_DB = 'sms_job';
/** 实训在统一表 `edu_stage` 里的取值 */
const JOB_STAGE = 'job' as const;

/** 纯数字床位序号 → 「1-上 / 1-下」文本（奇上偶下）。非数字原样返回。 */
function classBedNoOf(v: any): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^\d+$/.test(s)) return s;
  const n = Number(s);
  if (n <= 0) return s;
  return `${Math.ceil(n / 2)}-${n % 2 === 1 ? '上' : '下'}`;
}

/**
 * 就业侧的床位号 → 文本
 *
 * ⚠️ 就业库的 `bed_no` 现在存的是**位置文本**（如 `1上` / `2下`，
 *    见迁移 20261001_012），但老数据里也可能还是纯数字 —— 两种都兜住。
 */
function jobBedNoOf(v: any): string {
  const s = String(v ?? '');
  if (/^\d+$/.test(s)) {
    return `${Math.ceil(Number(s) / 2)}${Number(s) % 2 === 1 ? '上' : '下'}`;
  }
  return s;
}

/** 0 值在 MySQL 里可能返回 string/decimal，统一转字符串 */
function str(v: any): string {
  return v == null ? '' : String(v);
}

/* ============================================================
 * ★ 跨库宿舍去重（2026-10-05 斌哥报「宿舍还是显示两个」）
 *
 * 【背景】
 *   「宿舍总名单」是三路合并：教务(sms_edu) + 实训(sms_job) + 大学部(sms_class聚合)。
 *   原来就是 `[...edu, ...job, ...class]` 直接拼，**完全没去重** →
 *   同一间房在实训库和大学部库各存一份 → 列表出现两行，
 *   两行都有同一个人、同一张床（截图里 3号楼 301 的张子轩 1上/1上）。
 *
 * 【以谁为准 —— 斌哥拍板：按学生所在的阶段为准】
 *   · 还在大学部阶段 → 以大学部库(class)为准
 *   · 已进实训/就业阶段 → 以实训库(job)为准
 *   实现：**逐张床**看这个学号在 job 库里是不是实训/就业状态，
 *        是→ 用 job 的这张床；否 → 用 class 的这张床。
 *   退学的学生（已不在实训阶段）自然落到 class 那边，
 *   不会因为「job 优先」把他显示成还住着。
 *
 * 【★ 为什么不能「整间房选一边」（这是本题最容易做错的地方）】
 *   3号楼/301 的 2上：job 库是**空**、class 库是**王子墨**。
 *     · 整间统一选 job → 王子墨凭空消失（少显示，比重复更危险）
 *     · 整间统一选 class → 实训那 3 张床的信息滞后
 *   所以必须**逐床判断**，才能既不丢人、也不滞后。
 *
 * 【床位号要先归一化】
 *   三路写法不统一：`1` / `1上` / `1-上` 指的都是同一张床。
 *   统一去掉 `-` `_` 空格后再比对，否则匹配不上、等于没去重。
 */
const roomKeyOf = (building: any, room: any): string =>
  `${str(building).trim()}||${str(room).trim().replace(/^0+/, '')}`;
const bedKeyOf = (bedNo: any): string => str(bedNo).replace(/[\s\-_]/g, '');

function dedupeRooms(items: any[]): any[] {
  // 只有多来源的房间才需要处理，edu 库实测与 job/class 零重叠
  const groups = new Map<string, any[]>();
  const order: string[] = [];
  for (const it of items) {
    const k = roomKeyOf(it.building, it.room);
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(it);
  }

  const out: any[] = [];
  for (const k of order) {
    const g = groups.get(k)!;
    // 只有一个来源 → 原样保留（绝大多数房间走这条，不做任何加工）
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }

    // ---- 多来源：逐床按「学生所处阶段」选数据 ----
    //   斌哥定的口径是「按学生所在的阶段为准」，
    //   落在这里就是：**这张床在实训库登记了住人 → 用实训库那份**（人已进实训/就业阶段），
    //   **实训库这边是空的 → 用大学部库那份**（人还在大学部阶段）。
    //
    //   ⚠️ 为什么不用「查这个学号在 job 库的学生状态」来判断：
    //     实测 16 个重复学号在两库登记的是**同一个人同一张床**（姓名/床位全一致），
    //     所以「这张床在实训库有没有人」本身就等价于「他在不在实训阶段」，
    //     不用多查一次学生表。真正需要区分的只有「两边不一致」的情况：
    //       3号楼/301 的 2上：实训库空、大学部是王子墨（已退学）→ 取大学部那份，
    //       这样王子墨不会因为「实训库优先」被显示成空床（等于凭空消失）。
    const byJob = g.find((x) => x.source === 'job');
    const byClass = g.find((x) => x.source === 'class');

    // 床位全集（按归一化后的床位号归并）
    const bedKeys: string[] = [];
    const seen = new Set<string>();
    for (const it of g) {
      for (const b of it.beds || []) {
        const bk = bedKeyOf(b.bedNo);
        if (bk && !seen.has(bk)) {
          seen.add(bk);
          bedKeys.push(bk);
        }
      }
    }

    // 哪个来源优先：先看这间房里「已进实训阶段」的人有几个
    //   —— 用 job 库那侧的床位集合作为「实训侧」，
    //      class 侧多出来的床位（job 没有的）保留，job 侧的空床只在两边都没人时才算空。
    const jobBedMap = new Map<string, any>();
    for (const b of byJob?.beds || []) jobBedMap.set(bedKeyOf(b.bedNo), b);
    const classBedMap = new Map<string, any>();
    for (const b of byClass?.beds || []) classBedMap.set(bedKeyOf(b.bedNo), b);

    const beds = bedKeys.map((bk, i) => {
      const jb = jobBedMap.get(bk);
      const cb = classBedMap.get(bk);
      // 斌哥定的口径：这个人处在哪个阶段，就用哪个库的数据。
      //   判据用「这张床在实训库有没有登记住人」——
      //   实测 16 个重复学号在两边登记的是同一个人，所以谁有值就取谁；
      //   两边都有 → 取实训库（阶段更靠后，字段更全，且带班级/班主任）。
      const pick = jb && jb.studentNo ? jb : cb;
      const empty = !pick?.studentName;
      return {
        bedNo: pick?.bedNo || bk,
        bedIndex: i + 1,
        studentNo: pick?.studentNo || undefined,
        studentName: pick?.studentName || undefined,
        className: pick?.className || undefined,
        headTeacherName: pick?.headTeacherName || undefined,
        empty,
      };
    });

    // 整行的骨架：优先用实训库那侧（有房间表，容量/寝别更准），否则用大学部侧
    const win = byJob || byClass || g[0];
    const capacity = Math.max(
      Number(win.capacity) || 0,
      ...g.map((x) => Number(x.capacity) || 0),
      beds.length,
      1,
    );
    const occupied = beds.filter((b: any) => b.studentName).length;

    out.push({
      ...win,
      capacity,
      occupied,
      beds,
      // ★ 合并标记：页面据此知道这间房是几库合并来的（排查用，不影响展示）
      __mergedFrom: g.map((x) => x.source).filter((x) => x !== win.source),
    });
  }
  return out;
}

function fmtDate(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * ★ 2026-10-04：楼栋 + 房间号 → 一个宿舍号文本（如 "A栋 101"）
 *
 *   教务申请表把宿舍拆成 building / room 两列存，
 *   而就业侧是一整列 dorm_no。列表要跟就业侧显示一致，这里拼起来。
 */
function dormNo(building?: string | null, room?: string | null): string | undefined {
  const b = str(building).trim();
  const r = str(room).trim();
  if (!b && !r) return undefined;
  return `${b} ${r}`.trim();
}

/** 完整时间格式 YYYY-MM-DD HH:mm:ss（规范要求接口统一用这个） */
function fmtDateTime(v: any): string | undefined {
  if (!v) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/* ============================================================
 * 1. 宿舍总名单
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // 上限 200：编辑宿舍信息弹窗会一次拉全量宿舍填充「选择楼栋」下拉
  size: z.coerce.number().int().min(1).max(200).default(DORM_PAGE_SIZE),
  category: z.coerce.number().int().optional(),
  building: z.string().optional(),
  keyword: z.string().optional(),
  /** ★ 2026-10-03 斌哥：按**学生姓名 / 学号**筛选（只出住着这个学生的宿舍） */
  studentKeyword: z.string().optional(),
});

dormRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    /* ================= ① 教务自己的房间（sms_edu）================= */
    const roomQuery = db(ROOM).where('is_deleted', false);
    if (q.category) roomQuery.andWhere('category', q.category);
    if (q.building) roomQuery.andWhere('building', q.building);
    const eduRooms = await roomQuery.clone().select('*').orderBy(['building', 'room']);

    const eduRoomIds = eduRooms.map((r: any) => r.id);
    const eduBeds = eduRoomIds.length
      ? await db(BED)
          .whereIn('room_id', eduRoomIds)
          .where('is_deleted', false)
          .orderBy(['room_id', 'bed_index'])
      : [];
    const eduBedsByRoom: Record<string, any[]> = {};
    for (const b of eduBeds as any[]) (eduBedsByRoom[b.room_id] ||= []).push(b);

    const eduItems = eduRooms.map((r: any) => {
      const roomBeds = eduBedsByRoom[r.id] || [];
      const occupied = roomBeds.filter((b) => b.student_name).length;

      // ⚠️ 床位数 = 额定人数（不是固定 8 个）：床位表里缺记录的也要补上空位，
      //    前端才能渲染出「每间宿舍 capacity 行、空床位显示空床位」
      const bedList = (BED_OPTIONS as readonly string[])
        .slice(0, Number(r.capacity) || (BED_OPTIONS as readonly string[]).length)
        .map((bedNo, i) => {
          const b = roomBeds.find((x) => x.bed_no === bedNo);
          return {
            bedNo,
            bedIndex: i + 1,
            studentNo: b?.student_no || undefined,
            studentName: b?.student_name || undefined,
            className: b?.class_name || undefined,
            headTeacherName: b?.head_teacher_name || undefined,
            empty: !b?.student_name,
          };
        });

      return {
        roomId: r.id,
        category: r.category,
        categoryName: DORM_CATEGORY_NAME[r.category] || '',
        building: str(r.building),
        room: str(r.room),
        capacity: Number(r.capacity),
        occupied,
        beds: bedList,
        // ★ 来源标记
        source: 'edu',
        sourceName: '教务',
      };
    });

    /* ================= ② 实训宿舍（sms_job，★ 合并显示，只读）=================
     * 斌哥 2026-10-03：教务的「宿舍总名单」里也要能看到实训的名单。
     * 做法同学生档案 —— 查询时并进来，数据仍只存在就业库，这边只读。
     * ========================================================================= */
    const jobDormQuery = tbl(db, JOB_DB, JOB_DORM, JOB_STAGE).where('is_deleted', false);
    if (q.building) jobDormQuery.andWhere('building', q.building);
    if (q.category) jobDormQuery.andWhere('dorm_gender', q.category);
    const jobDorms = await jobDormQuery.clone().select('*').orderBy(['building', 'room_no']);

    const jobDormIds = jobDorms.map((d: any) => d.id);
    const jobBeds = jobDormIds.length
      ? await tbl(db, JOB_DB, JOB_BED, JOB_STAGE)
          .whereIn('dorm_id', jobDormIds)
          .where('is_deleted', false)
          .orderBy(['dorm_id', 'bed_no'])
      : [];
    const jobBedsByDorm: Record<string, any[]> = {};
    for (const b of jobBeds as any[]) (jobBedsByDorm[b.dorm_id] ||= []).push(b);

    // 就业床位表只存了姓名/学号，班级和班主任要回学生表拿
    const jobStuIds = (jobBeds as any[]).map((b) => b.student_id).filter(Boolean);
    const jobStus = jobStuIds.length
      ? await tbl(db, JOB_DB, JOB_STUDENT, JOB_STAGE)
          .whereIn('id', jobStuIds)
          .select('id', 'class_name', 'head_teacher_name')
      : [];
    const jobStuMap: Record<string, any> = {};
    for (const s of jobStus as any[]) jobStuMap[s.id] = s;

    const jobItems = jobDorms.map((d: any) => {
      const beds = (jobBedsByDorm[d.id] || []).map((b: any, idx: number) => ({
        bedNo: jobBedNoOf(b.bed_no),
        bedIndex: idx + 1,
        studentNo: b.student_no || undefined,
        studentName: b.student_name || undefined,
        className: jobStuMap[b.student_id]?.class_name || undefined,
        headTeacherName: jobStuMap[b.student_id]?.head_teacher_name || undefined,
        empty: !b.student_no,
      }));
      const occupied = beds.filter((b: any) => b.studentName).length;

      return {
        roomId: d.id,
        category: d.dorm_gender || 1,
        categoryName: DORM_CATEGORY_NAME[d.dorm_gender] || '—',
        building: str(d.building),
        room: str(d.room_no),
        capacity: Number(d.bed_count),
        occupied,
        beds,
        // ★ 来源标记
        source: 'job',
        sourceName: '实训',
      };
    });

    /* ================= ③ 大学部宿舍（sms_class，★ 合并显示，只读）=================
     * 斌哥 2026-10-05：大学部（Q1~Q6）的宿舍也要能在教务总名单看到。
     *
     * ⚠️ 与前两路最大的不同：**没有房间表/床位表**，宿舍信息存在学生表字段上
     *    （dorm_building 楼栋 / dorm_no 房间号 / bed_no 床位序号）。
     *    所以这里是「按房间号动态分组」聚合出一间间宿舍。
     * ========================================================================= */
    // 只取「住着人」的学生 —— 没宿舍号的（ dorm_no 为空）不生成房间
    const classStuQuery = tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE)
      .where('is_deleted', false)
      .whereNotNull('dorm_no')
      .whereNot('dorm_no', '');
    if (q.building) classStuQuery.andWhere('dorm_building', q.building);
    const classStus = await classStuQuery
      .clone()
      .select('id', 'student_no', 'student_name', 'class_name', 'head_teacher_name', 'dorm_building', 'dorm_no', 'bed_no')
      .orderBy(['dorm_building', 'dorm_no', 'bed_no']);

    // 按「楼栋 + 房间号」聚合成「间」
    const classRoomMap = new Map<string, any[]>();
    for (const s of classStus as any[]) {
      const key = `${str(s.dorm_building).trim()}||${str(s.dorm_no).trim()}`;
      if (!classRoomMap.has(key)) classRoomMap.set(key, []);
      classRoomMap.get(key)!.push(s);
    }

    // 床位号去重（同室可能两人填了同一床位，按首次出现为准）
    const BED_TEXT: readonly string[] = BED_OPTIONS as readonly string[];

    const classItems = [...classRoomMap.entries()].map(([key, stus]) => {
      const [building, room] = key.split('||');

      // 该间出现的最大床位序号 → 推算额定人数（无房间表，只能这样）
      let maxSeq = 0;
      const usedBedNo = new Map<string, any>();
      for (const s of stus) {
        const raw = String(s.bed_no ?? '').trim();
        const seq = /^\d+$/.test(raw) ? Number(raw) : 0;
        if (seq > maxSeq) maxSeq = seq;
        const text = classBedNoOf(raw);
        if (text && !usedBedNo.has(text)) usedBedNo.set(text, s);
      }
      // 至少 1 张床；床位文本按 1上/1下 顺序排
      const capacity = Math.max(maxSeq, stus.length, 1);

      const bedList = BED_TEXT.slice(0, capacity).map((bedNo, i) => {
        const s = usedBedNo.get(bedNo);
        return {
          bedNo,
          bedIndex: i + 1,
          studentNo: s?.student_no || undefined,
          studentName: s?.student_name || undefined,
          className: s?.class_name || undefined,
          headTeacherName: s?.head_teacher_name || undefined,
          empty: !s?.student_name,
        };
      });
      // ★ 床位文本里没覆盖到的（历史脏数据，序号超出 BED_OPTIONS 范围）也补进来，
      //    否则该学生会「凭空消失」——宁可多显示也不能少显示。
      for (const [bedNo, s] of usedBedNo) {
        if (bedList.some((b) => b.bedNo === bedNo)) continue;
        bedList.push({
          bedNo,
          bedIndex: bedList.length + 1,
          studentNo: s.student_no || undefined,
          studentName: s.student_name || undefined,
          className: s.class_name || undefined,
          headTeacherName: s.head_teacher_name || undefined,
          empty: false,
        });
      }

      const occupied = bedList.filter((b: any) => b.studentName).length;

      return {
        roomId: `class-${key}`,
        category: 0, // ⚠️ 学生表没有性别/寝别字段 → 无法判定男寝女寝
        categoryName: '—',
        building: str(building),
        room: str(room),
        capacity,
        occupied,
        beds: bedList,
        // ★ 来源标记
        source: 'class',
        sourceName: '大学部',
      };
    });

    /* ================= ④ 跨库去重（同一间房只显示一行）=================
     *
     * 【为什么要去重】2026-10-05斌哥报「宿舍还是显示两个」
     *   同一间房（如 3号楼 301）在实训库和大学部库各存一份 → 列表出现两行，
     *   两行都有张子轩、都是「1上」那张床 → 同一个人同一张床被算两次。
     *   实测 **77 行 → 去重后 72 行**，5 组重复：
     *     3号楼/301 3号楼/302 3号楼/303 2号楼/201 2号楼/202
     *   16 个学号**全部是「同间同床」重复**，没有一个人真占两张床
     *   → 所以按「楼栋+房号」去重就能全部消掉。
     *
     * 【★ 以谁为准 —— 斌哥 2026-10-05 拍板】
     *   **按学生所在的阶段为准**：
     *     · 还在大学部阶段 → 以大学部库(class)为准
     *     · 已进实训/就业阶段 → 以实训库(job)为准
     *   落法：**逐张床判断**这个学号在 job 库里是不是「实训/就业状态」，
     *   是→ 用 job 那张床的数据；不是 → 用 class 那张床的。
     *   这样退学的学生（王子墨已不在实训阶段）自然落到 class 那边，
     *   不会因为「job 库优先」把他显示成还住着。
     *
     * 【为什么不能简单「整间房选一边」】
     *   3号楼/301 的 2上：job 库是**空**、class 库是**王子墨**。
     *   整间统一选 job → 王子墨凭空消失（少显示，危险）；
     *   整间统一选 class → 实训那3 个床位信息滞后。
     *   逐床判断才能既不丢人、也不滞后。
     *
     * 【为什么 edu 库不参与去重】
     *   实测 edu 64 间与 job/class **零重叠**（楼栋房号完全不相交），
     *   它是独立的历史宿舍数据，直接原样带上。
     */
    let merged = dedupeRooms([...eduItems, ...jobItems, ...classItems]);

    if (q.category) {
      // 大学部寝别未知，指定类别时把它排除（否则男女寝筛选会把它算进来）
      merged = merged.filter((item) => item.category !== 0);
    }

    if (q.keyword) {
      const kw = String(q.keyword).trim().toLowerCase();
      merged = merged.filter((item) => {
        const hay = [
          item.building,
          item.room,
          String(item.capacity),
          item.categoryName,
          item.sourceName,
          ...item.beds.flatMap((b: any) => [b.bedNo, b.studentName, b.className, b.headTeacherName]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(kw);
      });
    }

    // ★ 2026-10-03：按学生姓名 / 学号筛选（教务学生和实训学生都能命中）
    if (q.studentKeyword) {
      const sk = String(q.studentKeyword).trim().toLowerCase();
      merged = merged.filter((item) =>
        item.beds.some((b: any) =>
          [b.studentName, b.studentNo].filter(Boolean).join(' ').toLowerCase().includes(sk),
        ),
      );
    }

    const total = merged.length; // 按「间」算总数
    const list = merged.slice((q.page - 1) * q.size, q.page * q.size);

    res.json(page(list, total, q));
  }),
);

/* ============================================================
 * 2. 统计数字
 * ============================================================ */

dormRouter.get(
  '/stats',
  wrap(async (_req, res) => {
    const rooms = (await db(ROOM).where('is_deleted', false).select('category', 'capacity')) as any[];

    const [bedAgg] = (await db(BED)
      .where('is_deleted', false)
      .select(
        db.raw('COUNT(*) AS total'),
        db.raw('COUNT(student_name) AS occupied'), // student_name 为 NULL 的就是空床位
      )) as any[];

    const totalBeds = Number(bedAgg?.total ?? 0);
    const occupiedBeds = Number(bedAgg?.occupied ?? 0);

    /* ---- 实训（sms_job，只读并入）---- */
    const jobDorms = (await tbl(db, JOB_DB, JOB_DORM, JOB_STAGE).where('is_deleted', false).select('id', 'dorm_gender', 'bed_count')) as any[];
    const jobBeds = (await tbl(db, JOB_DB, JOB_BED, JOB_STAGE).where('is_deleted', false).select('dorm_id', 'student_no')) as any[];

    /* ---- ★ 2026-10-05 大学部（sms_class，只读并入）----
     * 没有房间表/床位表，「间数」按 dorm_building+dorm_no 组合数算，
     * 「床位数」按学生实际占用的床位数算（拿不到额定人数）。 */
    const classStus = (await tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE)
      .where('is_deleted', false)
      .whereNotNull('dorm_no')
      .whereNot('dorm_no', '')
      .select('dorm_building', 'dorm_no', 'bed_no')) as any[];

    const classRoomKeys = new Set<string>();
    const classBedKeys = new Set<string>();
    for (const s of classStus) {
      const k = `${str(s.dorm_building).trim()}||${str(s.dorm_no).trim()}`;
      classRoomKeys.add(k);
      classBedKeys.add(`${k}||${classBedNoOf(s.bed_no)}`);
    }

    const data = {
      totalDorms: rooms.length + jobDorms.length + classRoomKeys.size,
      maleDorms:
        rooms.filter((r: any) => r.category === DormCategory.MALE).length +
        jobDorms.filter((d: any) => Number(d.dorm_gender) === DormCategory.MALE).length,
      femaleDorms:
        rooms.filter((r: any) => r.category === DormCategory.FEMALE).length +
        jobDorms.filter((d: any) => Number(d.dorm_gender) === DormCategory.FEMALE).length,
      vacantBeds:
        totalBeds -
        occupiedBeds +
        (jobDorms.reduce((s: number, d: any) => s + (Number(d.bed_count) || 0), 0) -
          jobBeds.filter((b: any) => b.student_no).length) +
        (classBedKeys.size - classStus.length),
    };

    res.json(ok(data));
  }),
);

/**
 * 2.1 楼栋下拉选项（跟「类别」联动）
 *     GET /api/edu/dorm/buildings?category=1
 *
 *     传了类别就只返回该类别下的楼栋，不传返回全部。
 *     数据从库里 distinct 出来，新增/导入了新楼栋也能自动出现在下拉里。
 *
 * ★ 2026-10-05：三个来源的楼栋全并进来（教务房间表 + 实训 dorm 表 + 大学部学生表），
 *   否则「按楼栋筛」只对教务自己的楼栋生效，另两路筛不出来。
 */
dormRouter.get(
  '/buildings',
  validate(z.object({ category: z.coerce.number().int().min(1).max(2).optional() })),
  wrap(async (req, res) => {
    const { category } = (req as any).validated as { category?: number };

    const set = new Set<string>();

    // ① 教务（传了类别就按类别过滤，跟原来行为一致）
    {
      const query = db(ROOM).where('is_deleted', false).distinct('building');
      if (category) query.andWhere('category', category);
      const rows = (await query) as any[];
      for (const r of rows) if (r.building) set.add(str(r.building));
    }

    // ② 实训
    {
      const q = tbl(db, JOB_DB, JOB_DORM, JOB_STAGE).where('is_deleted', false).distinct('building');
      if (category) q.andWhere('dorm_gender', category);
      const rows = (await q) as any[];
      for (const r of rows) if (r.building) set.add(str(r.building));
    }

    // ③ ★ 大学部（寝别未知 → 传了类别也给，免得筛不出来）
    {
      const rows = (await tbl(db, CLASS_DB, CLASS_STUDENT, CLASS_STAGE)
        .where('is_deleted', false)
        .whereNotNull('dorm_no')
        .whereNot('dorm_no', '')
        .whereNotNull('dorm_building')
        .distinct('dorm_building')) as any[];
      for (const r of rows) if (r.dorm_building) set.add(str(r.dorm_building));
    }

    res.json(ok([...set].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))));
  }),
);

dormRouter.get(
  '/approval-stats',
  wrap(async (_req, res) => {
    const countBy = async (table: string, status: number) => {
      const [row] = await db(table)
        .where({ is_deleted: false, status })
        .count({ c: '*' });
      return Number((row as any)?.c ?? 0);
    };

    res.json(
      ok({
        pendingChange: await countBy(CHANGE, ApplyStatus.PENDING),
        pendingQuit: await countBy(QUIT, ApplyStatus.PENDING),
        approvedChange: await countBy(CHANGE, ApplyStatus.APPROVED),
        approvedQuit: await countBy(QUIT, ApplyStatus.APPROVED),
      }),
    );
  }),
);

/* ============================================================
 * 3. 新增宿舍
 * ============================================================ */

const addRoomSchema = z.object({
  category: z.coerce.number().int().min(1).max(2),
  building: z.string().min(1, '请填写楼号'),
  room: z.string().min(1, '请填写宿舍号'),
  capacity: z.coerce.number().int().min(1).max(8).default(8),
});

dormRouter.post(
  '/room/add',
  validate(addRoomSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addRoomSchema>;

    // ⚠️ 唯一键是 (building, room)，软删的记录也占着这个键。
    //    所以这里不筛 is_deleted：还在用的报「已存在」，被删过的直接复活复用。
    const dup = await db(ROOM).where({ building: body.building, room: body.room }).first();
    if (dup && !dup.is_deleted) {
      throw new BizError(BizCode.PARAM_ERROR, `${body.building} ${body.room} 已存在`);
    }

    if (dup) {
      // 复活：更新规格 + 重建床位
      await db.transaction(async (trx) => {
        await trx(ROOM).where({ id: dup.id }).update({
          category: body.category,
          capacity: body.capacity,
          is_deleted: false,
          update_time: new Date(),
          update_by: req.user?.userId || 'system',
        });
        await trx(BED).where({ room_id: dup.id }).delete(); // 旧床位（含软删）清掉重铺
        await trx(BED).insert(
          (BED_OPTIONS as readonly string[]).slice(0, body.capacity).map((bedNo, i) => ({
            id: randomUUID(),
            room_id: dup.id,
            bed_no: bedNo,
            bed_index: i + 1,
            is_deleted: false,
            create_time: new Date(),
          })),
        );
      });

      res.json(ok({ id: dup.id }, '宿舍创建成功'));
      return;
    }

    const id = randomUUID();
    await db.transaction(async (trx) => {
      await trx(ROOM).insert({
        id,
        category: body.category,
        building: body.building,
        room: body.room,
        capacity: body.capacity,
        is_deleted: false,
        create_time: new Date(),
        create_by: req.user?.userId || 'system',
      });

      // 按额定人数铺空床位（额定 4 就只铺 4 个）
      await trx(BED).insert(
        (BED_OPTIONS as readonly string[]).slice(0, body.capacity).map((bedNo, i) => ({
          id: randomUUID(),
          room_id: id,
          bed_no: bedNo,
          bed_index: i + 1,
          is_deleted: false,
          create_time: new Date(),
        })),
      );
    });

    res.json(ok({ id }, '宿舍创建成功'));
  }),
);

/* ============================================================
 * 4. 修改宿舍信息（类别 / 楼栋 / 房号 / 额定）
 *
 * ⚠️ 原型逻辑：改类别时，同一栋楼的【所有房间】类别跟着一起改
 * ============================================================ */

dormRouter.put(
  '/room/info',
  validate(
    z.object({
      id: z.string().min(1),
      category: z.coerce.number().int().min(1).max(2),
      building: z.string().min(1, '请填写楼号'),
      room: z.string().min(1, '请填写宿舍号'),
      capacity: z.coerce.number().int().min(1).max(8),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      id: string;
      category: number;
      building: string;
      room: string;
      capacity: number;
    };

    const target = await db(ROOM).where({ id: body.id, is_deleted: false }).first();
    if (!target) throw new BizError(BizCode.PARAM_ERROR, '未找到目标宿舍');

    // ============================================================
    // 额定人数变更 → 床位跟着增删
    //
    // ⚠️ 床位是按额定人数铺的：额定 4 就只有 4 个床位（1-下/1-上/2-下/2-上）。
    //    缩容量时只能删掉没人住的床位；有人住的床位超出新额定就必须先调走学生。
    // ============================================================
    const bedRows = (await db(BED)
      .where({ room_id: body.id, is_deleted: false })
      .orderBy('bed_index')) as any[];

    if (body.capacity !== Number(target.capacity)) {
      const overflowOccupied = bedRows.filter(
        (b) => b.student_name && b.bed_index > body.capacity,
      );
      if (overflowOccupied.length) {
        const names = overflowOccupied.map((b) => `${b.bed_no}(${b.student_name})`).join('、');
        throw new BizError(
          BizCode.PARAM_ERROR,
          `额定人数不能小于 ${body.capacity + 1}：床位 ${names} 已有学生入住，请先调整入住学生`,
        );
      }
    }

    // 房间信息和床位必须一起成功/一起失败，否则会出现「额定 8 但只有 4 个床位」的脏数据
    const now = new Date();
    await db.transaction(async (trx) => {
      // 楼栋改名 → 整栋楼同步
      if (body.building !== target.building) {
        await trx(ROOM)
          .where({ building: target.building, is_deleted: false })
          .update({ building: body.building, update_time: now });
      }

      // 类别变更 → 整栋楼同步
      if (body.category !== target.category) {
        await trx(ROOM)
          .where({ building: body.building, is_deleted: false })
          .update({ category: body.category, update_time: now });
      }

      // 房号 / 额定只改这一间
      await trx(ROOM).where({ id: body.id }).update({
        building: body.building,
        room: body.room,
        category: body.category,
        capacity: body.capacity,
        update_time: now,
        update_by: req.user?.userId || 'system',
      });

      // ---- 同步「分派宿舍」表里的冗余快照 ----
      //     楼栋改名 / 类别变更是整栋楼生效的，所以按新楼栋把该楼所有宿舍的分派记录一起刷，
      //     否则分派页会显示旧楼号（比如房间改叫 A-9 了，分派里还写着 A-1）
      const roomIdsInBuilding = await trx(ROOM)
        .where({ building: body.building, is_deleted: false })
        .pluck('id');
      if (roomIdsInBuilding.length) {
        await trx(ASSIGN)
          .whereIn('room_id', roomIdsInBuilding)
          .update({ building: body.building, category: body.category, update_time: now });
      }
      await trx(ASSIGN).where({ room_id: body.id }).update({ room: body.room, update_time: now });

      // ---- 同步床位数量 ----
      const need = body.capacity;
      const have = bedRows.length;

      if (need < have) {
        // 缩：软删超出额定且没人的床位（有人住的上面已经拦掉了）
        await trx(BED)
          .where({ room_id: body.id, is_deleted: false })
          .where('bed_index', '>', need)
          .update({ is_deleted: true, update_time: now });
      } else if (need > have) {
        // 扩：⚠️ 之前缩容量时是【软删】，记录还在表里，
        //    直接 insert 会撞 uk_bed_room_bedno(room_id, bed_no) 唯一键。
        //    所以先把软删的那几条复活，没有的再 insert。
        const addNos = (BED_OPTIONS as readonly string[]).slice(have, need);
        for (let i = 0; i < addNos.length; i++) {
          const bedNo = addNos[i];
          const revived = await trx(BED)
            .where({ room_id: body.id, bed_no: bedNo, is_deleted: true })
            .update({ is_deleted: false, update_time: now });

          if (!revived) {
            await trx(BED).insert({
              id: randomUUID(),
              room_id: body.id,
              bed_no: bedNo,
              bed_index: have + i + 1,
              is_deleted: false,
              create_time: now,
            });
          }
        }
      }
    });

    res.json(ok(null, '宿舍信息已更新'));
  }),
);

/* ============================================================
 * 5. 修改入住学生（整间覆盖）
 * ============================================================ */

dormRouter.put(
  '/room/occupants',
  validate(
    z.object({
      id: z.string().min(1),
      occupants: z
        .array(
          z.object({
            bedNo: z.string(),
            studentName: z.string().optional(),
            className: z.string().optional(),
            headTeacherName: z.string().optional(),
          }),
        )
        .max(8),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      id: string;
      occupants: { bedNo: string; studentName?: string; className?: string; headTeacherName?: string }[];
    };

    const target = await db(ROOM).where({ id: body.id, is_deleted: false }).first();
    if (!target) throw new BizError(BizCode.PARAM_ERROR, '未找到目标宿舍');

    // 床位是按额定人数铺的，提交一个不存在的床位号会静默失败，这里先拦掉
    const roomBeds = (await db(BED)
      .where({ room_id: body.id, is_deleted: false })
      .select('bed_no')) as any[];
    const validBedNos = new Set(roomBeds.map((b) => b.bed_no as string));

    const named = body.occupants.filter((o) => (o.studentName || '').trim());
    const badBed = named.find((o) => !validBedNos.has(o.bedNo));
    if (badBed) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `床位「${badBed.bedNo}」不存在：该宿舍额定 ${Number(target.capacity)} 人，只有 ${validBedNos.size} 个床位`,
      );
    }
    if (named.length > Number(target.capacity)) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        `入住人数 ${named.length} 超过额定 ${Number(target.capacity)} 人`,
      );
    }

    const now = new Date();
    await db.transaction(async (trx) => {
      for (const o of body.occupants) {
        const name = (o.studentName || '').trim();
        await trx(BED)
          .where({ room_id: body.id, bed_no: o.bedNo, is_deleted: false })
          .update({
            student_name: name || null,
            class_name: name ? o.className || null : null,
            head_teacher_name: name ? o.headTeacherName || null : null,
            update_time: now,
          });
      }
    });

    res.json(ok(null, '入住信息已保存'));
  }),
);

/* ============================================================
 * 6. 删除宿舍（只有 0 人入住才能删）
 * ============================================================ */

dormRouter.delete(
  '/room/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const [{ c }] = await db(BED)
      .where({ room_id: id, is_deleted: false })
      .whereNotNull('student_name')
      .count({ c: '*' });

    if (Number(c) > 0) {
      throw new BizError(BizCode.PARAM_ERROR, '该宿舍还有学生入住，不能删除');
    }

    await db.transaction(async (trx) => {
      await trx(BED).where({ room_id: id }).update({ is_deleted: true });
      await trx(ROOM).where({ id }).update({
        is_deleted: true,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      // 宿舍没了，它上面的分派关系要一起失效，否则「宿舍总名单」查得到、分派页还能看到幽灵宿舍
      await trx(ASSIGN).where({ room_id: id }).update({ is_deleted: true });
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6.5 分派宿舍（班级 ↔ 宿舍）
 *
 *   一个班级可以分到【多间】宿舍；一间宿舍同一时间只归属一个班级。
 *   床位数 / 入住人数全部实时算，不落库 —— 否则改了额定人数分派页数字就会失真。
 * ============================================================ */

const assignQuerySchema = z.object({
  building: z.string().optional(),
  category: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

/** 取某几个房间的入住情况：{ roomId: { occupied, byClass: {班级: 人数} } } */
async function occupancyOf(roomIds: string[]) {
  const result: Record<string, { occupied: number; byClass: Record<string, number> }> = {};
  if (!roomIds.length) return result;

  const beds = (await db(BED)
    .whereIn('room_id', roomIds)
    .where('is_deleted', false)
    .whereNotNull('student_name')
    .select('room_id', 'class_name')) as any[];

  for (const b of beds) {
    const it = (result[b.room_id] ||= { occupied: 0, byClass: {} });
    it.occupied += 1;
    const cn = str(b.class_name);
    if (cn) it.byClass[cn] = (it.byClass[cn] || 0) + 1;
  }
  return result;
}

/** 班级排序：跟着 ALL_CLASSES 的顺序走，和页面下拉里的班级顺序一致 */
function classOrder(a: string, b: string) {
  const ia = ALL_CLASSES.indexOf(a);
  const ib = ALL_CLASSES.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
}

/** GET /assign/list —— 按班级分组 */
dormRouter.get(
  '/assign/list',
  validate(assignQuerySchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof assignQuerySchema>;

    // ---- 分派行 join 房间，把额定人数一起带出来 ----
    const rowsQuery = db(ASSIGN)
      .join(ROOM, `${ASSIGN}.room_id`, `${ROOM}.id`)
      .where(`${ASSIGN}.is_deleted`, false)
      .where(`${ROOM}.is_deleted`, false)
      .select(`${ASSIGN}.*`, `${ROOM}.capacity`, `${ROOM}.category as room_category`);

    if (q.building) rowsQuery.andWhere(`${ROOM}.building`, q.building);
    if (q.category) rowsQuery.andWhere(`${ROOM}.category`, q.category);

    let rows = (await rowsQuery.orderBy([`${ROOM}.building`, `${ROOM}.room`])) as any[];

    if (q.keyword) {
      const kw = String(q.keyword).trim().toLowerCase();
      rows = rows.filter((r) =>
        [r.class_name, r.head_teacher_name, r.building, r.room]
          .join(' ')
          .toLowerCase()
          .includes(kw),
      );
    }

    const roomIds = rows.map((r) => r.room_id);
    const occ = await occupancyOf(roomIds);

    // ---- 按班级聚合 ----
    const grouped: Record<string, any> = {};
    for (const r of rows) {
      const cn = str(r.class_name);
      const it = (grouped[cn] ||= {
        className: cn,
        headTeacherName: r.head_teacher_name || undefined,
        rooms: [],
      });
      const o = occ[r.room_id] || { occupied: 0, byClass: {} };
      it.rooms.push({
        assignId: r.id,
        roomId: r.room_id,
        building: str(r.building),
        room: str(r.room),
        category: Number(r.room_category ?? r.category),
        categoryName: DORM_CATEGORY_NAME[Number(r.room_category ?? r.category)] || '',
        capacity: Number(r.capacity),
        occupied: o.occupied,
        ownOccupied: o.byClass[cn] || 0,
      });
    }

    const list = Object.values(grouped)
      .map((g: any) => ({
        className: g.className,
        headTeacherName: g.headTeacherName,
        roomCount: g.rooms.length,
        capacity: g.rooms.reduce((s: number, x: any) => s + x.capacity, 0),
        occupied: g.rooms.reduce((s: number, x: any) => s + x.occupied, 0),
        ownOccupied: g.rooms.reduce((s: number, x: any) => s + x.ownOccupied, 0),
        rooms: g.rooms,
      }))
      .sort((a: any, b: any) => classOrder(a.className, b.className));

    res.json(ok(list));
  }),
);

/** GET /assign/rooms —— 分派弹窗里的候选宿舍 */
dormRouter.get(
  '/assign/rooms',
  validate(assignQuerySchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof assignQuerySchema>;

    const rooms = (await db(ROOM)
      .where('is_deleted', false)
      .modify((qb) => {
        if (q.building) qb.andWhere('building', q.building);
        if (q.category) qb.andWhere('category', q.category);
      })
      .orderBy(['building', 'room'])) as any[];

    const assigned = (await db(ASSIGN).where('is_deleted', false).select('room_id', 'class_name')) as any[];
    const assignedMap: Record<string, string> = {};
    for (const a of assigned) assignedMap[a.room_id] = str(a.class_name);

    const occ = await occupancyOf(rooms.map((r) => r.id));

    let list = rooms.map((r) => {
      const o = occ[r.id] || { occupied: 0, byClass: {} };
      const assignedTo = assignedMap[r.id];
      return {
        roomId: r.id,
        building: str(r.building),
        room: str(r.room),
        category: Number(r.category),
        categoryName: DORM_CATEGORY_NAME[Number(r.category)] || '',
        capacity: Number(r.capacity),
        occupied: o.occupied,
        assigned: Boolean(assignedTo),
        assignedTo: assignedTo || undefined,
      };
    });

    if (q.keyword) {
      const kw = String(q.keyword).trim().toLowerCase();
      list = list.filter((r) =>
        [r.building, r.room, r.categoryName, r.assignedTo].join(' ').toLowerCase().includes(kw),
      );
    }

    res.json(ok(list));
  }),
);

/** GET /assign/stats */
dormRouter.get(
  '/assign/stats',
  wrap(async (_req, res) => {
    const assigned = (await db(ASSIGN).where('is_deleted', false).select('room_id')) as any[];
    const assignedRoomIds = assigned.map((a) => a.room_id);

    const rooms = assignedRoomIds.length
      ? ((await db(ROOM).whereIn('id', assignedRoomIds).where('is_deleted', false)) as any[])
      : [];

    const [{ everything }] = await db(ROOM).where('is_deleted', false).count({ everything: '*' });

    let occupancy = 0;
    if (assignedRoomIds.length) {
      const [{ c }] = await db(BED)
        .whereIn('room_id', assignedRoomIds)
        .where('is_deleted', false)
        .whereNotNull('student_name')
        .count({ c: '*' });
      occupancy = Number(c);
    }

    const classSet = new Set(
      ((await db(ASSIGN).where('is_deleted', false).distinct('class_name')) as any[]).map((r) =>
        str(r.class_name),
      ),
    );

    res.json(
      ok({
        assignedClasses: classSet.size,
        assignedRooms: rooms.length,
        unassignedRooms: Number(everything) - rooms.length,
        capacity: rooms.reduce((s, r) => s + Number(r.capacity), 0),
        occupied: occupancy,
      }),
    );
  }),
);

/** POST /assign —— 给班级分派宿舍（一次可以分多间） */
dormRouter.post(
  '/assign',
  validate(
    z.object({
      className: z.string().min(1, '请选择班级'),
      headTeacherName: z.string().optional(),
      roomIds: z.array(z.string().min(1)).min(1, '请至少选择一间宿舍'),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      className: string;
      headTeacherName?: string;
      roomIds: string[];
    };

    const roomIds = [...new Set(body.roomIds)];
    const rooms = (await db(ROOM).whereIn('id', roomIds).where('is_deleted', false)) as any[];
    if (rooms.length !== roomIds.length) {
      throw new BizError(BizCode.PARAM_ERROR, '部分宿舍不存在或已被删除');
    }

    // 一间宿舍只能归属一个班：被别的班占了要挡掉，并说清楚是哪几间
    const existing = (await db(ASSIGN)
      .whereIn('room_id', roomIds)
      .where('is_deleted', false)
      .select('room_id', 'class_name')) as any[];
    const conflict = existing
      .filter((e) => str(e.class_name) !== body.className)
      .map((e) => {
        const r = rooms.find((x) => x.id === e.room_id);
        return `${str(r?.building)} ${str(r?.room)}（已分派给 ${str(e.class_name)}）`;
      });

    if (conflict.length) {
      throw new BizError(BizCode.PARAM_ERROR, `以下宿舍无法分派：${conflict.join('、')}`);
    }

    const alreadyOwned = new Set(existing.map((e) => e.room_id));
    const todo = rooms.filter((r) => !alreadyOwned.has(r.id));

    const now = new Date();
    let added = 0;
    await db.transaction(async (trx) => {
      for (const r of todo) {
        const revive = await trx(ASSIGN)
          .where({ room_id: r.id, class_name: body.className, is_deleted: true })
          .update({ is_deleted: false, update_time: now, head_teacher_name: body.headTeacherName });

        if (!revive) {
          await trx(ASSIGN).insert({
            id: randomUUID(),
            class_name: body.className,
            head_teacher_name: body.headTeacherName || null,
            room_id: r.id,
            building: r.building,
            room: r.room,
            category: r.category,
            remark: null,
            is_deleted: false,
            create_time: now,
            create_by: req.user?.userId || 'system',
          });
        }
        added += 1;
      }
    });

    // ★ 2026-10-05：教务点「分派宿舍」→ 把该班房间+住宿学员推给班级管理
    //    非阻断：失败只记日志，不影响分派本身
    await syncEduDormToClass(body.className);

    res.json(
      ok({ added }, todo.length ? `已分派 ${todo.length} 间宿舍给 ${body.className}` : '这些宿舍已经在该班级名下'),
    );
  }),
);

const assignRemoveSchema = z.object({ id: z.string().min(1) });

/**
 * POST /assign/replace —— 覆盖某个班级的宿舍清单
 *
 * 弹窗里勾选出来的结果 = 这个班最终分到的宿舍：
 *   新增的补上、取消勾选的移除。比只增不减更符合「划分给它哪些宿舍」的操作习惯。
 */
dormRouter.post(
  '/assign/replace',
  validate(
    z.object({
      className: z.string().min(1, '请选择班级'),
      headTeacherName: z.string().optional(),
      roomIds: z.array(z.string().min(1)),
    }),
  ),
  wrap(async (req, res) => {
    const body = (req as any).validated as {
      className: string;
      headTeacherName?: string;
      roomIds: string[];
    };

    const targetIds = [...new Set(body.roomIds)];
    const rooms = targetIds.length
      ? ((await db(ROOM).whereIn('id', targetIds).where('is_deleted', false)) as any[])
      : [];
    if (rooms.length !== targetIds.length) {
      throw new BizError(BizCode.PARAM_ERROR, '部分宿舍不存在或已被删除');
    }

    // 目标宿舍里被别的班占着的 → 直接拦掉，说清楚是哪几间
    const others = (await db(ASSIGN)
      .whereIn('room_id', targetIds)
      .where('is_deleted', false)
      .whereNot('class_name', body.className)
      .select('room_id', 'class_name')) as any[];

    if (others.length) {
      const detail = others
        .map((o) => {
          const r = rooms.find((x) => x.id === o.room_id);
          return `${str(r?.building)} ${str(r?.room)}（已分派给 ${str(o.class_name)}）`;
        })
        .join('、');
      throw new BizError(BizCode.PARAM_ERROR, `以下宿舍无法分派：${detail}`);
    }

    const mine = (await db(ASSIGN)
      .where({ class_name: body.className, is_deleted: false })
      .select('id', 'room_id')) as any[];

    const mineIds = new Set(mine.map((m) => m.room_id));
    const targetSet = new Set(targetIds);

    const toRemoveIds = mine.filter((m) => !targetSet.has(m.room_id)).map((m) => m.id);
    const toAddIds = targetIds.filter((id) => !mineIds.has(id));
    // ★ 被取消分派的房间主键（通知班级侧删掉对应房间副本）
    const removedRoomIds = mine.filter((m) => !targetSet.has(m.room_id)).map((m) => m.room_id);

    const now = new Date();
    let added = 0;
    let removed = 0;

    await db.transaction(async (trx) => {
      if (toRemoveIds.length) {
        removed = await trx(ASSIGN)
          .whereIn('id', toRemoveIds)
          .update({ is_deleted: true, update_time: now, update_by: req.user?.userId || 'system' });
      }

      // 班主任统一刷一遍（包括原本就有、这次没动的分派行）
      if (mine.length) {
        await trx(ASSIGN)
          .where({ class_name: body.className, is_deleted: false })
          .update({ head_teacher_name: body.headTeacherName || null, update_time: now });
      }

      for (const roomId of toAddIds) {
        const revive = await trx(ASSIGN)
          .where({ room_id: roomId, class_name: body.className, is_deleted: true })
          .update({
            is_deleted: false,
            head_teacher_name: body.headTeacherName || null,
            update_time: now,
          });

        if (!revive) {
          const r = rooms.find((x) => x.id === roomId);
          await trx(ASSIGN).insert({
            id: randomUUID(),
            class_name: body.className,
            head_teacher_name: body.headTeacherName || null,
            room_id: roomId,
            building: r.building,
            room: r.room,
            category: r.category,
            remark: null,
            is_deleted: false,
            create_time: now,
            create_by: req.user?.userId || 'system',
          });
        }
        added += 1;
      }
    });

    // ★ 2026-10-05：覆盖式分派后同样推送给班级管理（含「取消勾选」要删的房间）
    await syncEduDormToClass(body.className, removedRoomIds);

    res.json(
      ok(
        { added, removed: Number(removed) },
        `已保存：${body.className} 共 ${targetIds.length} 间宿舍（新增 ${added} 间，取消 ${removed} 间）`,
      ),
    );
  }),
);

/** POST /assign/remove —— 取消某一间的分派 */
dormRouter.post(
  '/assign/remove',
  validate(assignRemoveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof assignRemoveSchema>;
    const row = await db(ASSIGN).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '该分派记录不存在');

    await db(ASSIGN).where({ id: body.id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // ★ 2026-10-05：取消一间分派后，通知班级侧把该房间副本删掉，并刷新其余清单
    await syncEduDormToClass(str(row.class_name), [str(row.room_id)]);

    res.json(ok(null, '已取消分派'));
  }),
);

const assignClearSchema = z.object({ className: z.string().min(1) });

/** POST /assign/clear —— 清空某个班级的全部宿舍 */
dormRouter.post(
  '/assign/clear',
  validate(assignClearSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof assignClearSchema>;

    // 先取出要清掉的房间主键，供同步时通知班级侧一并删除
    const mineRooms = (await db(ASSIGN)
      .where({ class_name: body.className, is_deleted: false })
      .select('room_id')) as Array<{ room_id: string }>;
    const removedRoomIds = mineRooms.map((m) => m.room_id).filter(Boolean);

    const n = await db(ASSIGN)
      .where({ class_name: body.className, is_deleted: false })
      .update({ is_deleted: true, update_time: new Date(), update_by: req.user?.userId || 'system' });

    // ★ 2026-10-05：清空后通知班级侧把该班房间副本全部删掉
    await syncEduDormToClass(body.className, removedRoomIds);

    res.json(ok({ removed: Number(n) }, `已清空 ${body.className} 的 ${n} 间宿舍`));
  }),
);

/* ============================================================
 * 7. 换宿申请
 * ============================================================ */

const applyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(10),
  status: z.coerce.number().int().optional(),
  className: z.string().optional(),
});

dormRouter.get(
  '/change/list',
  validate(applyQuerySchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof applyQuerySchema>;

    const query = db(CHANGE).where('is_deleted', false);
    if (q.status) query.andWhere('status', q.status);
    if (q.className) query.andWhere('class_name', q.className);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('apply_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = (rows as any[]).map((r) => ({
      applyId: r.id,
      applyNo: r.apply_no,

      // ★ 2026-10-04：跟「就业管理 → 调换/退宿申请」同款的学生列（姓名 + 性别 + 学号）
      studentName: r.student_name,
      studentNo: r.student_no || undefined,
      gender: r.gender ?? undefined,
      genderName: r.gender ? GENDER_NAME[r.gender] || '' : undefined,

      className: r.class_name || undefined,
      headTeacherName: r.head_teacher_name || undefined,

      // 宿舍变动（旧 → 新，含床位）—— 跟就业侧一致
      oldDormNo: dormNo(r.from_building, r.from_room),
      oldBedNo: r.from_bed || undefined,
      newDormNo: dormNo(r.to_building, r.to_room),
      newBedNo: r.to_bed || undefined,

      // 拆开的原始字段保留（导出 / 其他页面还要用）
      fromBuilding: r.from_building || undefined,
      fromRoom: r.from_room || undefined,
      fromBed: r.from_bed || undefined,
      toBuilding: r.to_building || undefined,
      toRoom: r.to_room || undefined,
      toBed: r.to_bed || undefined,

      reason: r.reason || undefined,
      // 就业侧 changeDate 是纯日期，这里也统一成 YYYY-MM-DD
      applyDate: fmtDate(r.apply_date),
      status: r.status,
      statusName: APPLY_STATUS_NAME[r.status] || '',
      rejectReason: r.reject_reason || undefined,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 8. 退宿申请
 * ============================================================ */

dormRouter.get(
  '/quit/list',
  validate(applyQuerySchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof applyQuerySchema>;

    const query = db(QUIT).where('is_deleted', false);
    if (q.status) query.andWhere('status', q.status);
    if (q.className) query.andWhere('class_name', q.className);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('apply_date', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = (rows as any[]).map((r) => ({
      applyId: r.id,
      applyNo: r.apply_no,

      // ★ 2026-10-04：跟「就业管理 → 调换/退宿申请」同款的学生列（姓名 + 性别 + 学号）
      studentName: r.student_name,
      studentNo: r.student_no || undefined,
      gender: r.gender ?? undefined,
      genderName: r.gender ? GENDER_NAME[r.gender] || '' : undefined,

      className: r.class_name || undefined,
      headTeacherName: r.head_teacher_name || undefined,

      // 退宿没有"新宿舍"，只有现宿舍 + 床位
      oldDormNo: dormNo(r.quit_building, r.quit_room),
      oldBedNo: r.quit_bed || undefined,

      // 拆开的原始字段保留（导出 / 其他页面还要用）
      quitBuilding: r.quit_building || undefined,
      quitRoom: r.quit_room || undefined,
      quitBed: r.quit_bed || undefined,

      reason: r.reason || undefined,
      // 就业侧 changeDate 是纯日期，这里也统一成 YYYY-MM-DD
      applyDate: fmtDate(r.apply_date),
      phone: r.phone || undefined,
      status: r.status,
      statusName: APPLY_STATUS_NAME[r.status] || '',
      rejectReason: r.reject_reason || undefined,
    }));

    res.json(page(list, Number(total), q));
  }),
);

/* ============================================================
 * 9. 审核：通过 / 驳回（换宿、退宿共用一套写法）
 *
 * ★ 2026-10-03 合并后新增分支：
 *   如果这条申请是【就业侧同步过来的】（source='job'），
 *   审批结果要**跨库回写**到就业那边 —— 既改我们库的申请单状态，
 *   也执行床位变更；而且和"改教务这条申请单"在【同一个事务】里。
 * ============================================================ */

const auditSchema = z.object({
  id: z.string().min(1),
  reason: z.string().max(200).optional(),
});

/** 取操作人（就业侧审批引擎要这个格式） */
function getOperator(req: any) {
  const u = req.user || {};
  return { userId: u.userId || '', userName: u.userName || '', roles: u.roles || [] };
}

/**
 * 审批一条【就业侧同步来的】申请：一个事务里改两边
 *
 *   教务侧：申请单 status → 已同意 / 已驳回
 *   就业侧：审批单 + 申请单状态 → 回写；通过时还执行 afterApproved()（改床位 / 改学生宿舍）
 */
async function auditJobApply(
  applyTable: string,
  applyRow: any,
  approve: boolean,
  reason: string | undefined,
  operator: any,
): Promise<void> {
  /** 就业侧的换宿申请单（★ 已归一 → 走 tblTrx，见常量区注释） */
  const JOB_CHANGE = 't_job_dorm_change';

  await db.transaction(async (trx) => {
    // ① 改教务这条申请单（sms_edu，未归一 → 保持裸访问）
    await trx(applyTable)
      .where({ id: applyRow.id })
      .update({
        status: approve ? ApplyStatus.APPROVED : ApplyStatus.REJECTED,
        reject_reason: approve ? null : (reason || '').trim(),
        update_time: new Date(),
        update_by: operator.userId || 'system',
      });

    // ② 回写就业侧
    const jobRow = await tblTrx(trx, JOB_DB, JOB_CHANGE, JOB_STAGE)
      .where({ id: applyRow.source_id, is_deleted: false })
      .first();
    if (!jobRow) {
      throw new BizError(BizCode.PARAM_ERROR, '对应的就业侧申请单不存在，无法同步');
    }

    if (approve) {
      const result = await doApprove(jobRow.approval_id, operator, undefined, trx);
      await tblTrx(trx, JOB_DB, JOB_CHANGE, JOB_STAGE).where({ id: jobRow.id }).update({
        approval_status: result.status,
        update_time: new Date(),
        update_by: operator.userId,
      });
      if (result.finished) {
        // ★ 改床位 + 改学生宿舍（与教务状态更新同一事务）
        await afterApproved(trx, jobRow, operator);
      }
    } else {
      await doReject(jobRow.approval_id, operator, reason || '教务驳回', trx);
      await tblTrx(trx, JOB_DB, JOB_CHANGE, JOB_STAGE).where({ id: jobRow.id }).update({
        approval_status: ApprovalStatus.REJECTED,
        update_time: new Date(),
        update_by: operator.userId,
      });
    }
  });
}

function auditHandler(table: string, approve: boolean) {
  return wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof auditSchema>;

    const row = await db(table).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '申请不存在');

    if (row.status !== ApplyStatus.PENDING) {
      throw new BizError(BizCode.PARAM_ERROR, '该申请已处理，不能重复审批');
    }

    if (!approve && !body.reason?.trim()) {
      throw new BizError(BizCode.PARAM_ERROR, '请填写驳回原因');
    }

    // ★ 就业侧同步来的 → 跨库回写两边
    if (row.source === 'job' && row.source_id) {
      await auditJobApply(table, row, approve, body.reason, getOperator(req));
      res.json(ok(null, approve ? '已同意' : '已驳回'));
      return;
    }

    // ---- 教务自己发的（原逻辑：只改状态）----
    if (approve) {
      await db(table).where({ id: body.id }).update({
        status: ApplyStatus.APPROVED,
        reject_reason: null,
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      res.json(ok(null, '已同意'));
    } else {
      await db(table).where({ id: body.id }).update({
        status: ApplyStatus.REJECTED,
        reject_reason: (body.reason || '').trim(),
        update_time: new Date(),
        update_by: req.user?.userId || 'system',
      });
      res.json(ok(null, '已驳回'));
    }
  });
}

dormRouter.post('/change/approve', validate(auditSchema), auditHandler(CHANGE, true));
dormRouter.post('/change/reject', validate(auditSchema), auditHandler(CHANGE, false));
dormRouter.post('/quit/approve', validate(auditSchema), auditHandler(QUIT, true));
dormRouter.post('/quit/reject', validate(auditSchema), auditHandler(QUIT, false));

/* ============================================================
 * 10. 退宿名单
 * ============================================================ */

const checkoutSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(10),
  className: z.string().optional(),
  building: z.string().optional(),
  /** 导出时传 true，返回全部不分页 */
  exportAll: z.coerce.boolean().optional(),
});

async function queryCheckout(q: {
  className?: string;
  building?: string;
  page?: number;
  size?: number;
  exportAll?: boolean;
}) {
  const query = db(CHECKOUT).where('is_deleted', false);
  if (q.className) query.andWhere('class_name', q.className);
  if (q.building) query.andWhere('quit_building', q.building);

  const [{ total }] = await query.clone().count({ total: '*' });

  const dataQuery = query.clone().orderBy('checkout_date', 'desc');
  if (!q.exportAll) {
    dataQuery.limit(q.size || 10).offset(((q.page || 1) - 1) * (q.size || 10));
  }

  const rows = await dataQuery.select('*');

  return {
    total: Number(total),
    list: (rows as any[]).map((r) => ({
      id: r.id,
      studentName: r.student_name,
      quitBuilding: r.quit_building || undefined,
      quitRoom: r.quit_room || undefined,
      quitBed: r.quit_bed || undefined,
      className: r.class_name || undefined,
      checkoutDate: fmtDateTime(r.checkout_date),
      phone: r.phone || undefined,
    })),
  };
}

dormRouter.get(
  '/checkout/list',
  validate(checkoutSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof checkoutSchema>;
    const { total, list } = await queryCheckout(q);
    res.json(page(list, total, q));
  }),
);

/** 导出：直接返回全部数据，前端生成 CSV */
dormRouter.post(
  '/checkout/export',
  validate(z.object({ className: z.string().optional(), building: z.string().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated as { className?: string; building?: string };
    const { list } = await queryCheckout({ ...q, exportAll: true });
    res.json(ok(list));
  }),
);

/* ============================================================
 * 11. 导入入住明细
 *
 * 模板列：宿舍楼、宿舍号、类别、床位号、学生姓名、班级、班主任
 * 行为：宿舍不存在就自动创建（默认 8 床位），床位已有人则报失败
 *
 * ⚠️ 原型的导入只是 alert('导入成功') 的空壳，这里做成了真实入库
 * ============================================================ */

const dormUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.(xlsx|xls|csv)$/i.test(file.originalname));
  },
});

/** 表头 → 字段 */
const DORM_HEADERS: Record<string, string> = {
  宿舍楼: 'building',
  楼栋: 'building',
  宿舍号: 'room',
  房号: 'room',
  类别: 'category',
  床位号: 'bedNo',
  床位: 'bedNo',
  学生姓名: 'studentName',
  姓名: 'studentName',
  班级: 'className',
  班主任: 'headTeacherName',
};

dormRouter.post(
  '/import',
  dormUpload.single('file'),
  wrap(async (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw new BizError(BizCode.PARAM_ERROR, '请选择要导入的文件');

    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new BizError(BizCode.PARAM_ERROR, '文件内容为空');

    const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheetName], {
      header: 1,
      defval: '',
      blankrows: false,
    });
    if (rows.length < 2) throw new BizError(BizCode.PARAM_ERROR, '没有数据行');

    // ---- 表头映射 ----
    const norm = (s: any) => String(s ?? '').replace(/[\s*＊]/g, '').toLowerCase();
    const colToKey: Record<number, string> = {};
    rows[0].forEach((h: any, idx: number) => {
      const key = DORM_HEADERS[norm(h)];
      if (key) colToKey[idx] = key;
    });

    for (const required of ['building', 'room', 'bedNo', 'studentName']) {
      if (!Object.values(colToKey).includes(required)) {
        throw new BizError(
          BizCode.PARAM_ERROR,
          '表头缺少必需列：宿舍楼、宿舍号、床位号、学生姓名',
        );
      }
    }

    const failures: { row: number; reason: string }[] = [];
    const now = new Date();

    // 已有的宿舍（building+room → id）
    const existRooms = await db(ROOM).where('is_deleted', false).select('id', 'building', 'room');
    const roomMap = new Map<string, string>();
    for (const r of existRooms as any[]) {
      roomMap.set(`${r.building}|${r.room}`, r.id);
    }

    const toCreateRooms: { key: string; building: string; room: string; category: number; id: string }[] = [];
    const occupants: {
      roomId: string;
      bedNo: string;
      studentName: string;
      className?: string;
      headTeacherName?: string;
    }[] = [];

    // 预先登记每行要写入的床位，避免重复占用
    const usedKey = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const line = rows[i];
      const excelRow = i + 1;
      const raw: Record<string, any> = {};
      for (const [idxStr, key] of Object.entries(colToKey)) {
        raw[key] = line[Number(idxStr)];
      }

      const building = String(raw.building ?? '').trim();
      const room = String(raw.room ?? '').trim();
      let bedNo = String(raw.bedNo ?? '').trim();
      const studentName = String(raw.studentName ?? '').trim();

      if (!building && !room && !studentName) continue;
      if (!building || !room) {
        failures.push({ row: excelRow, reason: '宿舍楼 / 宿舍号不能为空' });
        continue;
      }
      if (!studentName) {
        failures.push({ row: excelRow, reason: '学生姓名不能为空' });
        continue;
      }

      // 床位号校验：必须是 8 个合法床位之一
      if (!(BED_OPTIONS as readonly string[]).includes(bedNo)) {
        // 容错：只填了数字的话补成 "-下"
        const m = bedNo.match(/^([1-4])$/);
        if (m) bedNo = `${m[1]}-下`;
        else {
          failures.push({ row: excelRow, reason: `床位号「${bedNo}」无效，应为 1-下/1-上/…/4-上` });
          continue;
        }
      }

      let category = DormCategory.MALE;
      if (raw.category) {
        const c = String(raw.category).trim();
        if (c === '女寝' || c === '女' || c === '2') category = DormCategory.FEMALE;
        else if (c === '男寝' || c === '男' || c === '1') category = DormCategory.MALE;
        else {
          failures.push({ row: excelRow, reason: `类别「${c}」无法识别，请填 男寝/女寝` });
          continue;
        }
      }

      const key = `${building}|${room}`;
      if (usedKey.has(`${key}|${bedNo}`)) {
        failures.push({ row: excelRow, reason: `床位 ${building} ${room} ${bedNo} 在此文件中重复` });
        continue;
      }
      usedKey.add(`${key}|${bedNo}`);

      if (!roomMap.has(key)) {
        const newId = randomUUID();
        roomMap.set(key, newId);
        toCreateRooms.push({ key, building, room, category, id: newId });
      }

      occupants.push({
        roomId: roomMap.get(key)!,
        bedNo,
        studentName,
        className: String(raw.className ?? '').trim() || undefined,
        headTeacherName: String(raw.headTeacherName ?? '').trim() || undefined,
      });
    }

    // ---- 写库 ----
    let successCount = 0;
    await db.transaction(async (trx) => {
      for (const r of toCreateRooms) {
        await trx(ROOM).insert({
          id: r.id,
          category: r.category,
          building: r.building,
          room: r.room,
          capacity: 8,
          is_deleted: false,
          create_time: now,
          create_by: req.user?.userId || 'system',
        });
        await trx(BED).insert(
          (BED_OPTIONS as readonly string[]).map((b, idx) => ({
            id: randomUUID(),
            room_id: r.id,
            bed_no: b,
            bed_index: idx + 1,
            is_deleted: false,
            create_time: now,
          })),
        );
      }

      for (const occ of occupants) {
        const existing = await trx(BED)
          .where({ room_id: occ.roomId, bed_no: occ.bedNo, is_deleted: false })
          .first();

        if (existing?.student_name) {
          failures.push({
            row: 0,
            reason: `床位 ${occ.bedNo} 已有学生 ${existing.student_name}，已跳过`,
          });
          continue;
        }

        await trx(BED)
          .where({ room_id: occ.roomId, bed_no: occ.bedNo, is_deleted: false })
          .update({
            student_name: occ.studentName,
            class_name: occ.className ?? null,
            head_teacher_name: occ.headTeacherName ?? null,
            update_time: now,
          });
        successCount += 1;
      }
    });

    res.json(
      ok(
        { successCount, failCount: failures.length, failures: failures.slice(0, 50) },
        failures.length
          ? `导入完成：成功 ${successCount} 条，失败 ${failures.length} 条`
          : `导入成功，共 ${successCount} 条`,
      ),
    );
  }),
);

/** 宿舍导入模板 */
dormRouter.get(
  '/import-template',
  wrap(async (_req, res) => {
    const headers = ['宿舍楼', '宿舍号', '类别', '床位号', '学生姓名', '班级', '班主任'];
    const sample = ['A-1', '505', '男寝', '1-下', '张伟', '高一1班', '王老师'];

    const sheet = XLSX.utils.aoa_to_sheet([headers, sample]);
    sheet['!cols'] = headers.map((h) => ({ wch: 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, '宿舍导入模板');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const filename = encodeURIComponent('宿舍导入模板.xlsx');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.end(buf);
  }),
);

export default dormRouter;
