/**
 * 升实训交接（大学 8003 → 实训 8004）
 *
 * ============================================================
 * 【业务背景】
 * ============================================================
 *   大学部班级在「班级管理」(8003) 读到第六阶段（206）后，学管点「升实训」，
 *   把班级 + 班内学员交接到实训模块（就是这个包）。
 *
 *   8003 那边只写了一张交接单（`t_class_training_handoff`，handoff_status=1），
 *   **没有通知我们**，而且交接单里只有 student_ids，没有学生详情。
 *
 *   所以这里补上「断掉的最后一米」，三条路都留着：
 *     · POST /receive —— 对方主动推（推荐，实时）
 *     · POST /pull    —— 我们主动去拉（兜底，防对方忘推）
 *     · GET  /list    —— 看历史交接记录
 *
 * ============================================================
 * 【数据继承规则】（斌哥 2026-10-04 拍板）
 * ============================================================
 *   ① 跨系统认人一律用 **学号 student_no**（三边都能对上）
 *   ② 数据「全带」：基础档案 + 出勤率 + 末班次数 + 成绩快照
 *   ③ 阶段映射：8003 的 206（六阶段）→ 我们的 13（实训）
 *   ④ 状态映射：8003 的 5（正式在读）→ 我们的 8（实训中）
 *   ⑤ **不退宿舍** —— 只有「实训转就业」才退宿（那是另一个流程，已实现）
 *   ⑥ 实训沿用大学部（dept_code=2），不新设部门
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ok, page as pageResp } from '../utils/response';
import { RoleCode, BizCode } from 'shared-types';
import { BizError } from '../middleware/errorHandler';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
// ★ 2026-10-14：跨服务调用统一走公共 axios 封装（技术选型表：跨服务调用 = axios）
import { remoteGet, isRemoteTimeout } from '../shared/http';
import { today } from '../utils/date';
// ★ 2026-10-05：内部服务令牌统一从 config 读（原来这里是第三个不同的默认值）
import { config } from '../config';
// ★ P3 切读层：本文件 6 张实训老表（t_job_training_handoff / t_student_base /
//   t_job_class / t_job_class_student / t_job_dorm / t_job_dorm_bed）都已归一，
//   读走 tbl()/tblTrx()、写走 tblIns()/tblInsTrx()；开关关时与原实现逐字节等价。
import { tbl, tblIns, tblInsTrx, tblTrx, phaseCodeCol } from '../teaching/shared/uniTable';

const router = Router();

/**
 * 服务间调用凭证（同班级管理 8003 的约定）
 *
 * `/receive` 是「对方推给我们」，对方没有用户登录态，所以走内部令牌而不是 Bearer token。
 * 令牌值双方对齐（见 .env 的 INTERNAL_TOKEN）。
 *
 * ★ 2026-10-05 合并：令牌与默认值统一为 `config.internalToken`。
 *   原来这里是 `'liangzhi-internal-dev-token'`，与班级模块的默认值不同 ——
 *   两边都漏配 .env 时，升实训交接会「凭证无效」且看不出原因。
 */
function internalAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.internalToken;
  const got = req.headers['x-internal-token'];
  if (!got || got !== expected) {
    res.json({ code: 40301, message: '内部服务凭证无效', data: null });
    return;
  }
  next();
}

/**
 * 本路由挂在 app.ts 的「管理员只读闸」**之前**
 *（因为 /receive 是服务间调用，没有用户登录态，过不了那道闸的 authMiddleware），
 * 所以写操作要在这里自己补一次「只读管理员」校验，别让闸形同虚设。
 */
function denyReadOnlyAdmin(req: Request, res: Response, next: NextFunction): void {
  const roles: string[] = (req as any).user?.roles || [];
  const isAdminOnly = roles.length > 0 && roles.every((r) => r === RoleCode.SYS_ADMIN);
  if (isAdminOnly) {
    res.status(403).json({
      code: 40302,
      message: '系统管理员是只读账号，不能执行新增/修改/删除',
      data: null,
    });
    return;
  }
  next();
}

const HANDOFF = 't_job_training_handoff';
const STU = 't_student_base';
const CLASS = 't_job_class';
const ROSTER = 't_job_class_student';
/** ★ 宿舍主档 / 床位表（2026-10-04：大学部宿舍跟着一起搬过来） */
const DORM = 't_job_dorm';
const BED = 't_job_dorm_bed';

/** ★ 统一表 edu_stage 取值（本路由只服务实训） */
const STAGE = 'job' as const;
const DB = 'sms_job';

/** 升实训后：学习阶段 = 实训（13） */
const TRAINING_STAGE = 13;
/** 升实训后：学生状态 = 实训中（8） */
const TRAINING_STATUS = 8;
/** 实训没有独立部门，沿用大学部（2） */
const TRAINING_DEPT = 2;
/** 班级状态：正常（1） */
const CLASS_NORMAL = 1;
/** 花名册：在班（1） · 入班类型：正常入班（1） */
const ROSTER_IN = 1;
const JOIN_NORMAL = 1;
/** 床位状态：1空闲 2已占用 3停用 */
const BED_FREE = 1;
const BED_USED = 2;
/**
 * ★ 搬过来的宿舍，床位数固定按 4 建（上下铺两组）
 *
 *   为什么写死4：大学部 `t_class_student.bed_no` 是 1/2/3/4 的**序号**，
 *   没有"这间房一共几个床"的信息。而实训的 `t_job_dorm.bed_count` 是必填，
 *   建宿舍时必须给一个值 —— 4 是这类宿舍的常规容量，
 *   之后项目经理在宿舍管理页**只能调大不能调小**（`/update` 有这个校验），
 *   所以宁可给足也不给少。
 */
const DORM_BED_COUNT = 4;

/**
 * ★ 把上游传来的日期规整成 MySQL DATE 列能收的 `YYYY-MM-DD`
 *
 * 【为什么需要】2026-10-04 全流程回归实测发现：
 *   班级模块的 `lib/case.ts` 在**读**数据库时会把 DATE 列转成
 *   JavaScript 的 ISO 字符串（`2026-08-31T16:00:00.000Z`）。
 *   这个值再经我们接收侧写回 DATE 列时，MySQL 直接报
 *   `Incorrect date value` → **该学员整条 upsert 失败**。
 *
 *   典型触发路径：任何「先查库 → 改几个字段 → 再写回」的流程。
 *
 * 【怎么修】只取前 10 位（`2026-08-31T16:00:00.000Z` → `2026-08-31`）。
 *   ⚠️ 不能用 toISOString().slice() —— 那是 UTC，会差 8 小时（变成 08-31 而非 09-01）。
 *   这里用「字符串前 10 位」，保留发送方原本的日历日。
 */
function toDateOnly(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    // Date 对象：按本地时区取日历日（与项目约定 timezone '+08:00' 一致）
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  // ISO 字符串 / 带时间的时间戳，都取前 10 位（'2026-08-31T16:00:00.000Z' → '2026-08-31'）
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/* ============================================================
 * ★ 2026-10-04：宿舍跟着一起搬（斌哥要求）
 * ============================================================ */

/** 一间宿舍搬完的结果 */
interface DormCarryResult {
  dormId: string | null;
  dormNo: string | null;
  bedId: string | null;
  /** 已被别人占了 / 建不出来等，床位这一环没搬成功的原因 */
  reason?: string;
}

/**
 * 把「楼 + 房间号」这一间宿舍在实训库建出来，**已存在就复用**
 *
 * 【为什么要"建"而不是"搬"】
 *   大学部根本没有房间主档 —— 宿舍只以字段形式挂在学生行上
 *   （`t_class_student.dorm_building` + `dorm_no` + `bed_no`）。
 *   实训库要求一间宿舍一行主档 + 若干行床位（调换/退宿/空余床位都依赖它），
 *   所以只能**按需凭空建出来**，建完再把床位占上。
 *
 * 【宿舍编号沿用大学部的原值】（斌哥 2026-10-04 拍板）
 *   楼 = `dorm_building`（如 `3号楼`），号 = `dorm_no`（如 `301`），
 *   拼出来的 `dorm_no` 存 `301`（与大学部显示一致），
 *   楼栋信息放 `t_job_dorm.building`（这是实训表本来就有的字段）。
 *   ⚠️ `t_job_dorm.dorm_no` 有全局唯一索引，所以先查后建、**不碰已存在的**。
 *
 * 【幂等】同一个 roomKey 反复调用只会建一次，不会产生第二间同名房。
 */
async function ensureDormRoom(
  trx: any,
  roomKey: string,
  building: string,
  roomNo: string,
  gender: number | null,
  operator: HandoffOperator,
): Promise<string> {
  const existed = await tblTrx(trx, DB, DORM, STAGE).where({ dorm_no: roomNo, is_deleted: false }).first();
  if (existed) return existed.id as string;

  const dormId = randomUUID();
  const now = new Date();
  await tblInsTrx(trx, DB, DORM, STAGE, {
    id: dormId,
    create_time: now,
    create_by: operator.userId,
    is_deleted: false,
    dorm_no: roomNo,
    building: building || '未分楼栋',
    room_no: roomNo,
    bed_count: DORM_BED_COUNT,
    used_count: 0,
    // ★ 寝别：男寝1/女寝2/不限0。搬过来的宿舍默认「不限」——
    //   大学部宿舍没记寝别，写死成某种性别反而可能在分派时把异性学生挡掉。
    dorm_gender: 0,
    dept_code: TRAINING_DEPT,
    dorm_status: 1,
    facility: null,
    remark: `由大学部升实训自动带入（原宿舍 ${building} ${roomNo}）`,
  });

  // 建 4 个空床位（1上/1下/2上/2下，对应 bed_no = 1/2/3/4）
  for (let i = 1; i <= DORM_BED_COUNT; i += 1) {
    await tblInsTrx(trx, DB, BED, STAGE, {
      id: randomUUID(),
      create_time: now,
      create_by: operator.userId,
      is_deleted: false,
      dorm_id: dormId,
      dorm_no: roomNo,
      bed_no: i,
      bed_status: BED_FREE,
      student_id: null,
      student_no: null,
      student_name: null,
      student_gender: null,
      check_in_date: null,
      remark: null,
    });
  }
  return dormId;
}

/** 重算某宿舍的「已住人数」（宿舍主档上冗余一份，列表页不用每行去 count） */
async function recalcDormUsedCount(trx: any, dormId: string): Promise<void> {
  const row = await tblTrx(trx, DB, BED, STAGE)
    .where({ dorm_id: dormId, bed_status: BED_USED, is_deleted: false })
    .count({ c: '*' })
    .first();
  await tblTrx(trx, DB, DORM, STAGE).where({ id: dormId }).update({ used_count: Number((row as any)?.c) || 0 });
}

/**
 * 给一个学生安排床位：占床 + 回写学生主档的 dorm_id/dorm_no
 *
 * 【为什么要回写两张表】（与`dorm.route.ts` 的 `/assign` 同一套约定）
 *   `t_job_dorm_bed.student_id` 回答「这个床位住的是谁」
 *   `t_student_base.dorm_id/dorm_no` 回答「这个人住哪」
 *   两张表靠student_id 对应，只改一张会出现「床位有人住但学生没宿舍」这种脏数据。
 *
 * 【床位被占了怎么办】不报错、也不硬抢：
 *   `bed_status=USED` 说明这个床位已经有别人（可能是实训库里原有的住宿安排，
 *   那样更不能覆盖）。此时跳过这人的床位，让项目经理在宿舍管理页手工调，
 *   记一条 reason 带回结果里。**宁可少搬一个床位，也不要制造两人同床。**
 */
async function carryStudentBed(
  trx: any,
  stu: IncomingStudent,
  studentId: string,
  operator: HandoffOperator,
): Promise<DormCarryResult> {
  const dormNo = String(stu.dormNo ?? '').trim();
  // 没填房间号 = 没宿舍，直接跳过（不是错误）
  if (!dormNo) return { dormId: null, dormNo: null, bedId: null };

  const building = String(stu.dormBuilding ?? '').trim();
  // 床位序号：大学部存的是 1/2/3/4（奇上偶下）；容错——非数字就当没填
  const rawBed = Number(stu.bedNo);
  const bedNo = Number.isInteger(rawBed) && rawBed > 0 && rawBed <= DORM_BED_COUNT ? rawBed : null;

  const dormId = await ensureDormRoom(trx, `${building}|${dormNo}`, building, dormNo, stu.gender ?? null, operator);

  // 找这间宿舍里的目标床位
  const bed = await tblTrx(trx, DB, BED, STAGE)
    .where({ dorm_id: dormId, bed_no: bedNo ?? 1, is_deleted: false })
    .first();

  const now = new Date();
  if (!bed) {
    return { dormId, dormNo, bedId: null, reason: `床位不存在（bed_no=${bedNo}）` };
  }
  if (bed.bed_status === BED_USED && bed.student_id && bed.student_id !== studentId) {
    return {
      dormId,
      dormNo,
      bedId: null,
      reason: `床位已被其他学生占用（${bed.student_name || bed.student_no}），请项目经理手工调整`,
    };
  }

  // 占床
  await tblTrx(trx, DB, BED, STAGE).where({ id: bed.id }).update({
    bed_status: BED_USED,
    student_id: studentId,
    student_no: stu.studentNo || null,
    student_name: stu.studentName || null,
    student_gender: stu.gender ?? null,
    check_in_date: today(),
    update_time: now,
    update_by: operator.userId,
  });

  // 回写学生主档
  await tblTrx(trx, DB, STU, STAGE).where({ id: studentId }).update({
    dorm_id: dormId,
    dorm_no: dormNo,
    update_time: now,
    update_by: operator.userId,
  });

  await recalcDormUsedCount(trx, dormId);

  return { dormId, dormNo, bedId: bed.id };
}

/* ============================================================
 * 工具：跨模块调用（5 秒超时 + 兜底，不许白屏）
 * ============================================================ */

// ★ 2026-10-05：与 config.internalToken 同源，避免「推的人用 A、收的人认 B」
const INTERNAL_TOKEN = config.internalToken;

/**
 * 调班级模块（读接口）
 *
 * ★ 2026-10-14：底层从原生 fetch 换成公共 axios 封装（src/shared/http.ts）。
 *   语义逐条保持：
 *     · 地址不再手拼 `CLASS_URL`（那个兜底还写着独立进程时代的 8003），
 *       改由封装按 `config.services.class` 取（合并后已指向本进程端口）
 *     · **不抛错**，统一返回 `{ok, data?/message?}`，调用方按 ok 决定兜底
 *     · 超时提示文案不变（axios 超时应判 ECONNABORTED，用 isRemoteTimeout 统一判）
 */
async function callClass<T = any>(path: string): Promise<{ ok: boolean; data?: T; message?: string }> {
  let j: any;
  try {
    j = await remoteGet('class', path, {
      timeout: 5000,
      headers: { 'x-internal-token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      raw: true,
    });
  } catch (e: any) {
    return {
      ok: false,
      message: isRemoteTimeout(e) ? '班级管理接口超时（5秒）' : String(e?.message || e),
    };
  }
  if (j && j.code === 200) return { ok: true, data: j.data };
  return { ok: false, message: j?.message || `班级管理返回 code=${j?.code}` };
}

/* ============================================================
 * 核心：处理一张交接单（幂等）
 * ============================================================ */

/** 单个学员的档案字段（升实训时从大学侧带过来） */
export interface IncomingStudent {
  studentNo: string;
  studentName: string;
  gender?: number | null;
  age?: number | null;
  idCard?: string | null;
  phone?: string | null;
  parentPhone?: string | null;
  education?: string | null;
  enrollDate?: string | null;
  attendanceRate?: number | null;
  repeatCount?: number | null;
  remark?: string | null;
  /**
   * ★ 2026-10-04：宿舍跟着搬（斌哥要求）
   *   dormBuilding = 宿舍楼（如 3号楼）；dormNo = 房间号（如 301）
   *   bedNo = 床位**序号**（1/2/3/4，奇上偶下 → 显示成 1-上 / 1-下）
   *   ⚠️ 这三个字段在实训库要落到三张表上：
   *     t_job_dorm（间）· t_job_dorm_bed（床）· t_student_base.dorm_id/dorm_no
   */
  dormBuilding?: string | null;
  dormNo?: string | null;
  bedNo?: number | string | null;
}

/**
 * 一张交接单的载荷
 *
 * ★ 2026-10-04：升实训改成「点确认后自动接收」后，这个类型也被
 *   `class/modules/class/class.route.ts` 的 `/training/upgrade` 直接复用
 *   （同一进程同连接，不用绕 HTTP）。所以导出。
 */
export interface HandoffPayload {
  handoffNo: string;
  sourceClassId?: string | null;
  sourceClassName?: string | null;
  /** ★ 2026-10-04：统一班级号（Q+数字）。给了就用它，保证两库编号一致 */
  universityNo?: string | null;
  sourceStage?: number | null;
  headTeacherId?: string | null;
  headTeacherName?: string | null;
  /** ★ 交棒模型：项目经理 = 建班时安排的真人（必填，不默认回退班主任） */
  projectManagerId?: string | null;
  projectManagerName?: string | null;
  /**
   * ★ 2026-10-04斌哥要求：就业指导老师一起带过来
   *   （之前没带，升实训后 employmentTeacherName 是 null，
   *     项目经理在班级列表上看着像"这个班没人管就业"）
   */
  employmentTeacherId?: string | null;
  employmentTeacherName?: string | null;
  students: IncomingStudent[];
}

/** 操作人（发起升实训 / 接收交接单的人） */
export interface HandoffOperator {
  userId: string;
  userName: string;
}

/**
 * 核心：处理一张交接单（**幂等** —— 同一 handoffNo 只处理一次）
 *
 * ★ 2026-10-04：原来只给 `POST /receive` 用（对方推过来）。
 *   现在「点确认升实训」也在同一个进程里直接调它 —— 见
 *   `class/modules/class/class.route.ts` 的 `/training/upgrade`。
 *   合并版的好处：同库同连接，不用起 HTTP、不用管令牌、不用等对方。
 */
export async function processHandoff(payload: HandoffPayload, operator: HandoffOperator) {
  // ★ 交棒模型：项目经理必填（建班时安排的真人；漏了就打回，不造假数据）
  if (!payload.projectManagerId) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      '交接单未指定项目经理（应在大学建班时安排好），无法接收升实训',
    );
  }
  // ---------- 幂等：同一个交接单号只处理一次 ----------
  const existed = await tbl(db, DB, HANDOFF, STAGE).where({ handoff_no: payload.handoffNo, is_deleted: false }).first();
  if (existed) {
    return {
      handoffNo: payload.handoffNo,
      duplicated: true,
      targetClassId: existed.target_class_id,
      targetClassName: existed.target_class_name,
      total: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      errors: [],
      message: '该交接单已接收过（幂等跳过）',
    };
  }

  return db.transaction(async (trx) => {
    /* ---------- 1. 找 / 建实训班级 ----------
     * ★ 2026-10-04 斌哥拍板「班级统一」：
     *   实训班与大学班是【同一个班延续】—— 班级号（Q+数字）不变，
     *   只有【阶段】从 20x 变成 13。
     *   所以优先按「统一班级号 university_no」找，找到就复用那个班。
     */
    // 统一编号：优先用对方给的 universityNo；没有就从班级名里提取数字
    // ⚠️ 两个坑：
    //   1) 对方给的已经是「Q+数字」（如 Q985），**不能再套一层 Q** → 会得到 QNaN
    //   2) 从班级名提取时要先剥掉字母，只留数字；并且去前导零（Q06 → Q6）
    const rawSrc = String(payload.universityNo || payload.sourceClassName || '').trim();
    const digits = /(\d+)/.exec(rawSrc)?.[1] || '';
    const universityNo = digits
      ? `Q${Number(digits)}`
      : `Q${Number(payload.handoffNo.slice(-3)) || 0}`;

    const className = universityNo;
    // 先按统一编号找（这是"同一个班"的主键）
    let cls = await tblTrx(trx, DB, CLASS, STAGE)
      .where({ is_deleted: false })
      .andWhere((qb: any) => {
        qb.where('university_no', universityNo).orWhere('class_name', universityNo);
      })
      .first();
    let targetClassId: string;

    if (cls) {
      // ★ 复用已有班：只改阶段与项目经理，不新建
      targetClassId = cls.id;
      await tblTrx(trx, DB, CLASS, STAGE).where({ id: targetClassId }).update({
        [phaseCodeCol()]: TRAINING_STAGE,             // 阶段 20x → 13
        // ★ 交棒模型：项目经理 = 建班时安排的真人（不再默认写班主任）
        project_manager_id: payload.projectManagerId || null,
        project_manager_name: payload.projectManagerName || null,
        // ★ 2026-10-04：就业指导老师一起带（只在新值非空时覆盖，别把已有值抹成 null）
        ...(payload.employmentTeacherId
          ? {
              employment_teacher_id: payload.employmentTeacherId,
              employment_teacher_name: payload.employmentTeacherName || null,
            }
          : {}),
        update_time: new Date(),
        update_by: operator.userId,
      });
    } else {
      targetClassId = randomUUID();
      await tblInsTrx(trx, DB, CLASS, STAGE, {
        id: targetClassId,
        create_time: new Date(),
        create_by: operator.userId,
        is_deleted: false,
        class_name: className,
        class_code: universityNo,                   // ★ 不再是 TR-交接单号
        university_no: universityNo,               // ★ 统一编号（两库共用）
        dept_code: TRAINING_DEPT,
        [phaseCodeCol()]: TRAINING_STAGE,
        head_teacher_id: payload.headTeacherId || operator.userId,
        head_teacher_name: payload.headTeacherName || operator.userName,
        // ★ 交棒模型：项目经理 = 建班时安排的真人（不再默认写班主任）
        project_manager_id: payload.projectManagerId || null,
        project_manager_name: payload.projectManagerName || null,
        // ★ 2026-10-04：就业指导老师一起带（可选，没有就留空，后面转就业时再指定）
        employment_teacher_id: payload.employmentTeacherId || null,
        employment_teacher_name: payload.employmentTeacherName || null,
        open_date: today(),
        student_count: 0,
        class_status: CLASS_NORMAL,
        remark: `由大学升实训交接自动生成（来源交接单 ${payload.handoffNo}）`,
      });
    }

    // ---------- 2. 逐学员：按学号 upsert ----------
    const results: Array<{
      studentNo: string;
      studentName: string;
      action: string;
      reason?: string;
      dorm?: string;
    }> = [];
    const studentNos: string[] = [];

    for (const s of payload.students) {
      try {
        if (!s.studentNo) {
          results.push({ studentNo: '', studentName: s.studentName, action: 'failed', reason: '缺学号' });
          continue;
        }
        studentNos.push(s.studentNo);

        // 档案字段（全带）
        const archive: Record<string, any> = {
          student_name: s.studentName,
          gender: s.gender ?? 1,
          age: s.age ?? null,
          id_card: s.idCard ?? null,
          phone: s.phone ?? null,
          parent_phone: s.parentPhone ?? null,
          education: s.education ?? null,
          enroll_date: toDateOnly(s.enrollDate),
          attendance_rate: s.attendanceRate ?? null,
          repeat_count: s.repeatCount ?? 0,
          dept_code: TRAINING_DEPT,
          [phaseCodeCol()]: TRAINING_STAGE,
          student_status: TRAINING_STATUS,
          class_id: targetClassId,
          class_name: className,
          head_teacher_id: payload.headTeacherId || null,
          head_teacher_name: payload.headTeacherName || null,
          update_time: new Date(),
          update_by: operator.userId,
        };
        if (s.remark) archive.remark = s.remark;

        const old = await tblTrx(trx, DB, STU, STAGE).where({ student_no: s.studentNo, is_deleted: false }).first();
        let studentId: string;

        if (old) {
          // 已存在 → 更新（学生可能本来就在我们库里）
          studentId = old.id;
          // 备注：只在新有值时覆盖，避免把原来的人工备注冲掉
          if (!s.remark) delete archive.remark;
          await tblTrx(trx, DB, STU, STAGE).where({ id: studentId }).update(archive);
          results.push({ studentNo: s.studentNo, studentName: s.studentName, action: 'updated' });
        } else {
          // 新建
          studentId = randomUUID();
          await tblInsTrx(trx, DB, STU, STAGE, {
            id: studentId,
            create_time: new Date(),
            create_by: operator.userId,
            is_deleted: false,
            student_no: s.studentNo,
            ...archive,
          });
          results.push({ studentNo: s.studentNo, studentName: s.studentName, action: 'inserted' });
        }

        // ---------- 3. 花名册（在班唯一，已存在就不重复插） ----------
        const inRoster = await tblTrx(trx, DB, ROSTER, STAGE)
          .where({ class_id: targetClassId, student_id: studentId, is_deleted: false })
          .first();
        if (!inRoster) {
          await tblInsTrx(trx, DB, ROSTER, STAGE, {
            id: randomUUID(),
            create_time: new Date(),
            create_by: operator.userId,
            is_deleted: false,
            class_id: targetClassId,
            class_name: className,
            student_id: studentId,
            student_no: s.studentNo,
            student_name: s.studentName,
            join_date: today(),
            join_type: JOIN_NORMAL,
            status: ROSTER_IN,
            remark: `大学升实训（${payload.handoffNo}）`,
          });
        }

        // ---------- 3.5 宿舍跟着搬（2026-10-04 斌哥要求）----------
        //   大学部宿舍只以字段形式挂在学生行上，实训库要有房间主档 + 床位，
        //   这里按需建出来并占上原来的床位。
        //   ⚠️ 床位没搬成**不算失败** —— 人已经进班了，床位冲突让项目经理
        //     在宿舍管理页手工调，比在这里抛错把整个交接卡掉好。
        if (s.dormNo) {
          const bed = await carryStudentBed(trx, s, studentId, operator);
          // 把结果补到刚才那条记录上（最后一条就是这名学生）
          const last = results[results.length - 1];
          if (last && last.studentNo === s.studentNo) {
            last.dorm = bed.bedId ? `${bed.dormNo}` : undefined;
            if (bed.reason) last.reason = bed.reason;
          }
        }
      } catch (e: any) {
        results.push({ studentNo: s.studentNo, studentName: s.studentName, action: 'failed', reason: String(e?.message || e) });
      }
    }

    // ---------- 4. 回填班级人数 ----------
    const [{ c: realCount }] = (await tblTrx(trx, DB, ROSTER, STAGE)
      .where({ class_id: targetClassId, is_deleted: false, status: ROSTER_IN })
      .count({ c: '*' })) as any;
    await tblTrx(trx, DB, CLASS, STAGE).where({ id: targetClassId }).update({ student_count: Number(realCount) });

    // ---------- 5. 写交接单副本 ----------
    const failed = results.filter((r) => r.action === 'failed').length;
    await tblInsTrx(trx, DB, HANDOFF, STAGE, {
      id: randomUUID(),
      create_time: new Date(),
      create_by: operator.userId,
      is_deleted: false,
      handoff_no: payload.handoffNo,
      source_system: 'class',
      source_class_id: payload.sourceClassId ?? null,
      source_class_name: payload.sourceClassName ?? null,
      source_stage: payload.sourceStage ?? null,
      source_head_teacher_id: payload.headTeacherId ?? null,
      source_head_teacher_name: payload.headTeacherName ?? null,
      target_class_id: targetClassId,
      target_class_name: className,
      student_count: results.length,
      student_nos: JSON.stringify(studentNos),
      receive_status: failed ? 2 : 1,
      result_json: JSON.stringify(results),
      receive_time: new Date(),
      operator_id: operator.userId,
      operator_name: operator.userName,
    });

    return {
      handoffNo: payload.handoffNo,
      duplicated: false,
      targetClassId,
      targetClassName: className,
      total: results.length,
      inserted: results.filter((r) => r.action === 'inserted').length,
      updated: results.filter((r) => r.action === 'updated').length,
      failed,
      errors: results.filter((r) => r.action === 'failed'),
    };
  });
}

/* ============================================================
 * ① POST /receive —— 对方推给我们
 * ============================================================ */

const studentSchema = z.object({
  studentNo: z.string().min(1, '学号必传'),
  studentName: z.string().min(1, '姓名必传'),
  gender: z.coerce.number().int().optional().nullable(),
  age: z.coerce.number().int().optional().nullable(),
  idCard: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  attendanceRate: z.coerce.number().optional().nullable(),
  repeatCount: z.coerce.number().int().optional().nullable(),
  remark: z.string().optional().nullable(),
  // ★ 2026-10-04：宿舍跟着搬
  dormBuilding: z.string().optional().nullable(),
  dormNo: z.string().optional().nullable(),
  bedNo: z.coerce.number().int().optional().nullable(),
});

const receiveSchema = z.object({
  handoffNo: z.string().min(1, '交接单号必传'),
  sourceClassId: z.string().optional().nullable(),
  sourceClassName: z.string().optional().nullable(),
  /** ★ 2026-10-04：统一班级号（Q+数字），两库靠它关联同一个班 */
  universityNo: z.string().optional().nullable(),
  sourceStage: z.coerce.number().int().optional().nullable(),
  headTeacherId: z.string().optional().nullable(),
  headTeacherName: z.string().optional().nullable(),
  // ★ 交棒模型：项目经理 = 建班时安排的真人（必填校验在 processHandoff 里）
  projectManagerId: z.string().optional().nullable(),
  projectManagerName: z.string().optional().nullable(),
  // ★ 2026-10-04：就业指导老师一起带
  employmentTeacherId: z.string().optional().nullable(),
  employmentTeacherName: z.string().optional().nullable(),
  students: z.array(studentSchema).min(1, '交接单里没有学员'),
});

router.post(
  '/receive',
  internalAuth,
  validate(receiveSchema),
  wrap(async (req, res) => {
    const b = (req as any).validated as z.infer<typeof receiveSchema>;
    const result = await processHandoff(b as HandoffPayload, {
      userId: 'SYSTEM',
      userName: '大学升实训交接',
    });
    res.json(
      ok(
        result,
        result.duplicated
          ? '该交接单已接收过（幂等跳过）'
          : `已接收：新建 ${result.inserted} 人 / 更新 ${result.updated} 人` +
              (result.failed ? ` / 失败 ${result.failed} 人` : ''),
      ),
    );
  }),
);

/* ============================================================
 * ② GET /list —— 交接记录（留痕）
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  sourceClassName: z.string().optional(),
  receiveStatus: z.coerce.number().int().optional(),
});

router.get(
  '/list',
  authMiddleware,
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;
    const base = tbl(db, DB, HANDOFF, STAGE).where('is_deleted', false);
    if (q.sourceClassName) base.andWhere('source_class_name', 'like', `%${q.sourceClassName}%`);
    if (q.receiveStatus) base.andWhere('receive_status', q.receiveStatus);

    const [{ total }] = (await base.clone().count({ total: '*' })) as any;
    const rows = await base.clone().select('*').orderBy('receive_time', 'desc').limit(q.size).offset((q.page - 1) * q.size);

    const list = (rows as any[]).map((r) => ({
      id: r.id,
      handoffNo: r.handoff_no,
      sourceClassName: r.source_class_name,
      sourceStage: r.source_stage,
      targetClassId: r.target_class_id,
      targetClassName: r.target_class_name,
      studentCount: r.student_count,
      receiveStatus: r.receive_status,
      receiveStatusName: r.receive_status === 1 ? '已接收' : r.receive_status === 2 ? '部分失败' : '已回执',
      receiveTime: r.receive_time,
      remark: r.remark,
    }));

    res.json(pageResp(list, Number(total), q));
  }),
);

/* ============================================================
 * ③ POST /pull —— 我们主动去 8003 拉（兜底）
 * ============================================================ */

router.post(
  '/pull',
  authMiddleware,
  denyReadOnlyAdmin,
  wrap(async (req, res) => {
    const operator = (req as any).user || { userId: 'SYSTEM', userName: '手动拉取' };

    // ---- 1. 拿对方的交接单列表 ----
    const listRes = await callClass<any>('/api/class/info/training/list?page=1&size=50');
    if (!listRes.ok) {
      res.json(ok(null, `拉取失败：${listRes.message}`));
      return;
    }
    const handoffs: any[] = listRes.data?.list || [];
    if (!handoffs.length) {
      res.json(ok({ pulled: 0, list: [] }, '对方没有交接单'));
      return;
    }

    // ---- 2. 过滤掉已接收过的 ----
    const nos = handoffs.map((h) => h.handoffNo).filter(Boolean);
    const existedRows = nos.length
      ? await tbl(db, DB, HANDOFF, STAGE).whereIn('handoff_no', nos).where('is_deleted', false).select('handoff_no')
      : [];
    const existedSet = new Set((existedRows as any[]).map((r) => r.handoff_no));
    const todo = handoffs.filter((h) => h.handoffNo && !existedSet.has(h.handoffNo));

    if (!todo.length) {
      res.json(ok({ pulled: 0, list: [] }, '没有新的交接单（都已接收过）'));
      return;
    }

    // ---- 3. 逐张处理：先拉该班学员，再走同一套接收逻辑 ----
    const out: any[] = [];
    for (const h of todo) {
      const stuRes = await callClass<any>(
        `/api/class/student/list?page=1&size=200&classId=${encodeURIComponent(h.classId)}`,
      );
      if (!stuRes.ok) {
        out.push({ handoffNo: h.handoffNo, ok: false, message: `拉学员失败：${stuRes.message}` });
        continue;
      }
      const students = (stuRes.data?.list || []).map((s: any) => ({
        studentNo: s.studentNo,
        studentName: s.studentName,
        gender: s.gender,
        age: s.age,
        idCard: s.idCard,
        phone: s.phone,
        parentPhone: s.parentPhone,
        education: s.education,
        enrollDate: s.enrollDate,
        attendanceRate: s.attendanceRate,
        repeatCount: s.repeatCount,
        remark: s.remark,
        // ★ 2026-10-04：宿舍跟着搬（班级侧 /student/list 已带这三个字段）
        dormBuilding: s.dormBuilding,
        dormNo: s.dormNo,
        bedNo: s.bedNo,
      }));

      try {
        const r = await processHandoff(
          {
            handoffNo: h.handoffNo,
            sourceClassId: h.classId,
            sourceClassName: h.className,
            sourceStage: h.stage,
            headTeacherId: h.headTeacherId,
            headTeacherName: h.headTeacherName,
            // ★ 交棒模型：/training/list 已把建班安排的项目经理和统一编号带出来
            universityNo: h.universityNo,
            projectManagerId: h.projectManagerId,
            projectManagerName: h.projectManagerName,
            // ★ 2026-10-04：就业指导老师一起带
            employmentTeacherId: h.employmentTeacherId,
            employmentTeacherName: h.employmentTeacherName,
            students,
          },
          { userId: operator.userId || 'SYSTEM', userName: operator.userName || '手动拉取' },
        );
        out.push({ handoffNo: h.handoffNo, ok: true, result: r });
      } catch (e: any) {
        out.push({ handoffNo: h.handoffNo, ok: false, message: String(e?.message || e) });
      }
    }

    const okCount = out.filter((x) => x.ok).length;
    res.json(ok({ pulled: out.length, success: okCount, list: out }, `拉取完成：成功 ${okCount} / 共 ${out.length} 张`));
  }),
);

export default router;
