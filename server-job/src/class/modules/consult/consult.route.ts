import { Router } from 'express';
import { z } from 'zod';
import { ConsultStatus, PermAction, StudentStatus } from 'shared-types/class';
// ★ TransferType 在 shared-types 根导出（不在 /class 子路径下），与 student.route.ts 同口径
import { TransferType } from 'shared-types';
import { db } from '../../db';
import { Errors, ok, pageData } from '../../http/response';
import { pageQuerySchema, q, validate } from '../../lib/validate';
import { baseInsert, baseUpdate, maxStudentNo, notDeleted, paginate } from '../../lib/repo';
import { assertClassAccess } from '../../middleware/dataScope';
import { requirePerm } from '../../lib/permGuard';
import { isFullAccess } from '../../lib/authUser';
import { rowToCamel, rowsToCamel } from '../../lib/case';
import { now, uuid } from '../../lib/ids';
import { ConsultStatusName, DeptName, GenderName } from '../../lib/dict';
import { assertClassAcceptStudent } from '../../lib/classRule';
import { wrap } from '../../middleware/error';
import {
  tbl,
  tblTrx,
  tblIns,
  tblInsTrx,
  USE_UNI_TABLE,
} from '../../../teaching/shared/uniTable';
// ★ 2026-10-19：初高也走「待接收」—— 接收初高的推送单要调初高的建档口
import classSync from '../../../utils/classSync';
// ★ 2026-10-19：判断目标班到底在哪个库（初高的班只在 sms_class_jh 里）
import { db as jhDb } from '../../../class-jh/utils/db';
// ★ 2026-10-20：接收后要回写咨询侧状态（班主任 token 在咨询侧不认，走内部令牌通道）
import { consultClient } from '../../lib/consultClient';

/**
 * 咨询推送（需求 v1.2）
 *
 * 流程：咨询模块（8001）把学员信息推送到班主任 → 班主任在「待接收学员」页接收 →
 *      接收时补充信息（含宿舍床位）并建档 → 学生来源标记为「咨询同步」。
 *      驳回则必填原因，回传咨询模块。
 *
 * ── 第 4 期 · 第 6 批（2026-10-11 · 咨询域）：统一表切读 ──
 *   本文件 25 处裸访问全部改走 `uniTable.ts` 路由层，涉及 6 张表：
 *     t_class_consult_push     → t_uni_consult_push
 *     t_class_student          → t_uni_student
 *     t_class_info             → t_uni_class
 *     t_class_repeat           → t_uni_repeat
 *     t_class_grade            → t_uni_exam_score
 *     t_class_student_transfer → t_uni_class_transfer   ★ 与岗位交接/升学转班共表
 *
 *   ★ 与宿舍域第 5 批不同：6 张表实测**零缺列**，不需要补列迁移
 *     （但要跑 `20261011_003`：bed_no 类型对齐 + uk_consult_push 降级）。
 *
 *   ★★ **`t_uni_class_transfer` 被三件事共用，写入方必须自己说清是哪件**
 *     ① 班级域「岗位交接」   → transfer_type=1(调岗) + post_transfer_type=1/2/3
 *     ② 学生域「升学转班」   → transfer_type=6
 *     ③ 本文件「换班留痕」   → transfer_type=7（StudentClassChange）
 *     三者都写同一张表，靠 transfer_type 区分事件性质 —— 见 shared-types/enums.ts。
 *
 *   ★★ **本域写 `t_uni_class_transfer` 时绕开 `UNI_COL_RENAME`**
 *     翻译表里 `t_class_transfer` 有 `from_user_name → from_class_name` 等改名
 *     （为升学转班那条路径设的）。但 `t_class_student_transfer` **没有**登记翻译 ——
 *     它的 `from_class_name`/`to_class_name` 装的就是**班级名**，语义天然一致，
 *     不需要翻译也不该翻译。
 */
export const consultRouter = Router();

/* ---------------- 统一表路由助手（第 6 批新增） ---------------- */
const SRC = 'sms_class';
const STAGE = 'class' as const;

const PUSH_T = 't_class_consult_push';
const STU_T = 't_class_student';
const CLS_T = 't_class_info';
const REPEAT_T = 't_class_repeat';
const GRADE_T = 't_class_grade';
const XFER_T = 't_class_student_transfer';

const PUSH = () => tbl(db, SRC, PUSH_T, STAGE);
const STU = () => tbl(db, SRC, STU_T, STAGE);
const CLS = () => tbl(db, SRC, CLS_T, STAGE);
const STU_TRX = (trx: import('knex').Knex.Transaction) => tblTrx(trx, SRC, STU_T, STAGE);
const CLS_TRX = (trx: import('knex').Knex.Transaction) => tblTrx(trx, SRC, CLS_T, STAGE);
const PUSH_TRX = (trx: import('knex').Knex.Transaction) => tblTrx(trx, SRC, PUSH_T, STAGE);

/* ============================================================
 * ★ 2026-10-06 用户拍板：待接收学员的「谁看得到 / 谁能接收」
 *
 *   「接收班级是由咨询、初高中决定的，此界面不设班级的选择；
 *     对应班级的班主任可以接收学员，校长和学管也可以」
 *
 *   所以：
 *     · 能看到的范围 —— 班主任只看「意向班级是自己带的班」的推送单；
 *       校长 / 学管（学管主任）看全部。
 *     · 能接收 —— 同上口径（本班班主任 / 校长 / 学管），教员与助教不参与接收。
 *     · 接收班级 —— **只能**用推送单上的 intend_class_id，前端传什么都不认。
 * ============================================================ */

/** 只有「班主任」这一种角色能按班级接收（校长/学管走 isFullAccess 全量） */
const RECEIVE_ROLE_HEAD_TEACHER = 'TEACH_HEAD';

/** 该推送单当前用户能否接收 / 驳回 */
function canHandlePush(user: { roles: string[]; classIds: string[] }, push: Record<string, unknown>): boolean {
  if (isFullAccess(user as never)) return true; // 校长 / 学管 / 系统管理员
  if (!user.roles.includes(RECEIVE_ROLE_HEAD_TEACHER)) return false;
  const target = (push.intend_class_id as string) ?? null;
  return !!target && user.classIds.includes(target);
}

/**
 * 推送单行 → 前端展示结构
 *
 * ★ 2026-10-19：删掉「意向阶段」——
 *   需求「将接收学生的意向阶段删除」。库里的 `intend_stage` 列保留（历史数据不动），
 *   但接口不再下发；学生阶段一律取【目标班级】的 stage。
 *
 * `canReceive` 由后端算好给前端用：判定要看「目标班是不是我带的班」，
 * 而初高的班现在也并进了 user.classIds，前端自己算会漏。
 */
function toPushItem(
  row: Record<string, unknown>,
  user?: { roles: string[]; classIds: string[] },
): Record<string, unknown> {
  const c = rowToCamel<Record<string, unknown>>(row);
  delete c.intendStage;
  const st = Number(row.apply_status);
  const dept = row.intend_dept_code !== null && row.intend_dept_code !== undefined
    ? Number(row.intend_dept_code)
    : null;
  const isRepeatIn = Number(row.is_repeat_in) === 1;
  const isTransfer = row.source_system === 'transfer';
  const isUpgrade = row.source_system === 'upgrade';
  /** 目标学段：1 初高部 → 初高库；2 大学部 → 本库
   *  ⚠️ 只用于**前端展示**（接收弹窗里隐藏大学部才有的宿舍/床位）。
   *     真正的入库判定在 /receive 里按「这个班在不在初高库」做。 */
  const targetIsJh = dept === 1;
  return {
    ...c,
    genderName: row.gender ? (GenderName[Number(row.gender)] ?? '未知') : '—',
    applyStatusName: ConsultStatusName[st] ?? '未知',
    intendDeptName: dept === null ? '—' : (DeptName[dept] ?? '未知'),
    targetIsJh,
    isRepeatIn,
    isTransfer,
    isUpgrade,
    sourceKind: isRepeatIn ? '末班重修' : isTransfer ? '换班转入' : isUpgrade ? '初高升学' : '咨询新生',
    canReceive: user ? canHandlePush(user, row) : false,
  };
}

/* ------------------------------ 列表 ------------------------------ */

const listSchema = z.object({
  ...pageQuerySchema.shape,
  applyStatus: z.coerce.number().int().optional(),
  keyword: z.string().optional(),
});

/**
 * @openapi
 * /api/class/consult/list:
 *   get:
 *     tags: [咨询推送]
 *     summary: 咨询推送单列表（班主任看推给自己的；学管/校长看全部）
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: size, schema: { type: integer } }
 *       - { in: query, name: applyStatus, schema: { type: integer }, description: 1待接收 2已接收 3已驳回 }
 *     responses:
 *       200: { description: 分页列表 }
 */
consultRouter.get(
  '/list',
  validate({ query: listSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const query = q<z.infer<typeof listSchema>>(req);

    const base = PUSH();
    notDeleted(base);
    // ★ 2026-10-06：非校长/学管 → 只看「意向班级是自己带的班」的推送单
    //   （旧写法按旧角色码 ROLE_* 判断，那些码早已不存在 → 条件恒真，
    //    结果是任何人都能看到全部推送单。现在按新码 + 班级归属重新收敛。）
    if (!isFullAccess(user)) {
      base.whereIn('intend_class_id', user.classIds.length ? user.classIds : ['__no_class__']);
    }
    if (query.applyStatus) base.where('apply_status', query.applyStatus);
    if (query.keyword) base.where('student_name', 'like', `%${query.keyword}%`);
    base.orderBy('push_time', 'desc');

    const paged = await paginate(base, query, async (qb) =>
      (await qb as Array<Record<string, unknown>>).map((r) => toPushItem(r, user)),
    );
    return ok(res, pageData(paged.total, paged.page, paged.size, paged.list), '查询成功');
  }),
);

/**
 * @openapi
 * /api/class/consult/detail:
 *   get:
 *     tags: [咨询推送]
 *     summary: 咨询推送单详情
 */
consultRouter.get(
  '/detail',
  validate({ query: z.object({ id: z.string().min(1, '缺少ID') }) }),
  wrap(async (req, res) => {
    const { id } = q<{ id: string }>(req);
    const row = (await notDeleted(PUSH()).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw Errors.param('咨询推送单不存在');
    return ok(res, toPushItem(row, req.user!), '查询成功');
  }),
);

/* ------------------------------ 咨询模块推送（入站） ------------------------------ */

const pushSchema = z.object({
  items: z.array(z.object({
    consultNo: z.string().min(1, '缺少咨询单号'),
    studentName: z.string().min(1, '缺少姓名'),
    gender: z.coerce.number().int().optional().nullable(),
    phone: z.string().optional().nullable(),
    parentPhone: z.string().optional().nullable(),
    age: z.coerce.number().int().optional().nullable(),
    education: z.string().optional().nullable(),
    origin: z.string().optional().nullable(),
    graduateSchool: z.string().optional().nullable(),
    homeAddress: z.string().optional().nullable(),
    intendDeptCode: z.coerce.number().int().optional().nullable(),
    intendStage: z.coerce.number().int().optional().nullable(),
    intendClassId: z.string().optional().nullable(),
    intendClassName: z.string().optional().nullable(),
    remark: z.string().optional().nullable(),
    pushTime: z.string().optional().nullable(),
    /** ★ 2026-10-05 来源标识：'consult'（咨询新生，默认）/ 'upgrade'（初高升学） */
    sourceSystem: z.string().optional().nullable(),
    /** ★ 初高升学：来源侧学生主键（sms_class_jh.t_class_student.id） */
    originStudentId: z.string().optional().nullable(),
    /** ★ 初高升学：原班级 */
    fromClassId: z.string().optional().nullable(),
    fromClassName: z.string().optional().nullable(),
  })).min(1, 'items 不能为空'),
});

/**
 * @openapi
 * /api/class/consult/push:
 *   post:
 *     tags: [咨询推送]
 *     summary: 咨询模块推送学员信息（入站，供 8001 调用 / 演示用）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: 推送结果 }
 */
consultRouter.post(
  '/push',
  validate({ body: pushSchema }),
  wrap(async (req, res) => {
    const b = req.body as z.infer<typeof pushSchema>;
    const t = now();
    let inserted = 0;
    let skipped = 0;
    let reopened = 0;
    /** ★ 2026-10-20 分班即入班：还没建档的单子改派到别的班（原地更新意向班级） */
    let reassigned = 0;

    for (const it of b.items) {
      const dup = (await notDeleted(PUSH())
        .where('consult_no', it.consultNo)
        .first()) as Record<string, unknown> | undefined;
      if (dup) {
        /**
         * ★ 2026-10-06 修：驳回后重新分派会被幂等去重「静默吞掉」
         *
         *   用户口径是「咨询把学生分班之后就不能再分派，**驳回之后可以**」。
         *   之前这里只要 consult_no 已存在就一律 skip —— 于是被班主任驳回的学生，
         *   咨询侧重新点「分班」时推送被丢掉：按钮亮了、后端也放行了，
         *   但班级侧那条单子永远停在「已驳回」，班主任的「待接收」里再也看不到他。
         *
         *   现在：**已驳回(3) → 原地重新激活为「待接收」并换到新的意向班级**；
         *   待接收(1) / 已接收(2) 仍然 skip（这才是「已分班不可再分派」）。
         */
        if (Number(dup.apply_status) === ConsultStatus.REJECTED) {
          await PUSH()
            .where({ id: dup.id })
            .update({
              student_name: it.studentName,
              gender: it.gender ?? dup.gender ?? null,
              phone: it.phone ?? dup.phone ?? null,
              parent_phone: it.parentPhone ?? dup.parent_phone ?? null,
              age: it.age ?? dup.age ?? null,
              education: it.education ?? dup.education ?? null,
              origin: it.origin ?? dup.origin ?? null,
              graduate_school: it.graduateSchool ?? dup.graduate_school ?? null,
              home_address: it.homeAddress ?? dup.home_address ?? null,
              intend_dept_code: it.intendDeptCode ?? dup.intend_dept_code ?? null,
              intend_stage: it.intendStage ?? dup.intend_stage ?? null,
              intend_class_id: it.intendClassId ?? null,
              intend_class_name: it.intendClassName ?? null,
              remark: it.remark ?? dup.remark ?? null,
              // 回到「待接收」并清掉上一次的驳回痕迹
              apply_status: ConsultStatus.PENDING,
              reject_reason: null,
              receiver_id: null,
              receiver_name: null,
              receive_time: null,
              student_id: null,
              student_no: null,
              push_time: it.pushTime ?? t,
              update_time: t,
            } as never);
          reopened += 1;
          continue;
        }

        /**
         * ★ 2026-10-20 分班即入班后新增：待建档(1) 期间允许改派班级
         *
         *   合并后 pending 只代表「推送了还没建学籍」的过渡态。老师这时如果
         *   重新选了一个班，必须把意向班级改掉 —— 否则 auto-receive 会按旧
         *   班级建档，学生被分到没人选的那个班。
         */
        if (Number(dup.apply_status) === ConsultStatus.PENDING && it.intendClassId
          && it.intendClassId !== dup.intend_class_id) {
          await PUSH()
            .where({ id: dup.id })
            .update({
              intend_class_id: it.intendClassId,
              intend_class_name: it.intendClassName ?? null,
              intend_dept_code: it.intendDeptCode ?? dup.intend_dept_code ?? null,
              intend_stage: it.intendStage ?? dup.intend_stage ?? null,
              update_time: t,
            } as never);
          reassigned += 1;
          continue;
        }

        skipped += 1;
        continue;
      }
      await tblIns(db, SRC, PUSH_T, STAGE, {
        ...baseInsert(undefined, uuid()),
        consult_no: it.consultNo,
        student_name: it.studentName,
        gender: it.gender ?? null,
        phone: it.phone ?? null,
        parent_phone: it.parentPhone ?? null,
        age: it.age ?? null,
        education: it.education ?? null,
        origin: it.origin ?? null,
        graduate_school: it.graduateSchool ?? null,
        home_address: it.homeAddress ?? null,
        intend_dept_code: it.intendDeptCode ?? null,
        intend_stage: it.intendStage ?? null,
        intend_class_id: it.intendClassId ?? null,
        intend_class_name: it.intendClassName ?? null,
        remark: it.remark ?? null,
        apply_status: ConsultStatus.PENDING,
        push_time: it.pushTime ?? t,
        // ★ 来源：咨询新生 = 'consult'；初高升学 = 'upgrade'（列表据此显示来源）
        source_system: it.sourceSystem || 'consult',
        origin_student_id: it.originStudentId ?? null,
        from_class_id: it.fromClassId ?? null,
        from_class_name: it.fromClassName ?? null,
      } as never);
      inserted += 1;
    }

    return ok(
      res,
      { inserted, skipped, reopened, reassigned },
      `已接收咨询推送 ${inserted} 条，重新激活驳回单 ${reopened} 条，改派 ${reassigned} 条，跳过重复 ${skipped} 条`,
    );
  }),
);

/* ------------------------------ 分班状态（内部只读，供咨询侧判定按钮可用性） ------------------------------ */

/**
 * @openapi
 * /api/class/consult/internal-status:
 *   get:
 *     tags: [咨询推送]
 *     summary: 按咨询单号批量查推送状态（内部服务调用，供咨询「分班」按钮判定）
 *     description: |
 *       ★ 2026-10-06 新增。用途：咨询「收款与缴费」页要按「是否已分班」决定
 *       「分班」按钮是否可用 —— 已推送/已接收的不允许重复分派，被驳回的可以重新分派。
 *       状态唯一权威源在班级侧（本表），所以由咨询侧带内部令牌来查，而不是在
 *       咨询库里维护一份可能失真的副本。
 *     parameters:
 *       - { in: query, name: nos, schema: { type: string }, description: 咨询单号，逗号分隔 }
 *     responses:
 *       200: { description: { [consultNo]: { applyStatus, intendClassId, intendClassName } } }
 */
consultRouter.get(
  '/internal-status',
  wrap(async (req, res) => {
    const raw = String(req.query.nos || '').trim();
    const nos = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!nos.length) return ok(res, {}, '查询成功');

    const rows = (await notDeleted(PUSH())
      .whereIn('consult_no', nos)
      .select('consult_no', 'apply_status', 'intend_class_id', 'intend_class_name')) as Array<
      Record<string, unknown>
    >;

    const map: Record<string, unknown> = {};
    for (const r of rows) {
      map[String(r.consult_no)] = {
        applyStatus: Number(r.apply_status),
        intendClassId: (r.intend_class_id as string) ?? null,
        intendClassName: (r.intend_class_name as string) ?? null,
      };
    }
    return ok(res, map, '查询成功');
  }),
);

/* ------------------------------ 班主任接收并建档 ------------------------------ */

function buildStudentNo(seq: number): string {
  return `S${new Date().getFullYear()}${String(seq).padStart(4, '0')}`;
}

function seqOfStudentNo(no: string | null | undefined): number {
  if (!no) return 0;
  const m = /(\d{4})$/.exec(no);
  return m ? Number(m[1]) : 0;
}

const receiveSchema = z.object({
  id: z.string().min(1, '缺少咨询单ID'),
  classId: z.string().optional().nullable(),
  studentNo: z.string().optional().nullable(),
  age: z.coerce.number().int().optional().nullable(),
  phone: z.string().optional().nullable(),
  parentPhone: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  enrollDate: z.string().optional().nullable(),
  studentStatus: z.coerce.number().int().optional().nullable(),
  dormId: z.string().optional().nullable(),
  dormNo: z.string().optional().nullable(),
  bedNo: z.coerce.number().int().optional().nullable(),
  remark: z.string().optional().nullable(),
  /**
   * 是否为「末班 / 重修」转来的接收（成绩管理「末班」→ 待接收学员 → 入班）。
   * 为 true 时，即使目标班级已封班也允许接收。
   */
  repeatIn: z.coerce.boolean().optional(),
});

/**
 * @openapi
 * /api/class/consult/receive:
 *   post:
 *     tags: [咨询推送]
 *     summary: 班主任接收咨询推送并补充信息建档（含宿舍床位）
 *     description: |
 *       接收后：① 生成学生档案（来源=咨询同步）；② 推送单状态 → 已接收；
 *      ③ 若选了床位则占用该床位。
 *     responses:
 *       200: { description: 接收成功 }
 */
/**
 * ★ 2026-10-20：接收建档逻辑抽成函数，供两个入口复用
 *   ① POST /receive        —— 班主任点「接收」（要权限校验）
 *   ② POST /auto-receive   —— 咨询侧直接入班（内部调用，跳过权限校验；存量/兼容用）
 *
 * 【两个学段统一口径（用户 2026-10-20）】
 *   咨询侧推送后只停在「待接收」，班主任点「接收」这一刻做两件事：
 *     1. 建档（初高 → sms_class_jh；大学部 → sms_class）
 *     2. **回写咨询侧状态**（待分班 4 → 试学中 5 / 正式在读 7，看钱交到哪一步）
 *   所以本函数在接收前后各问一次咨询侧：
 *     · 建档前 `receive-plan` → 学籍该落「试学中」还是「正式在读」
 *     · 建档后 `receive-ack`  → 把咨询状态推进掉（失败只记日志，不影响已建的学籍）
 */

/** 问咨询侧：这个学生收进来该是什么学籍状态（只读，失败返回 null 由调用方给默认值） */
async function consultReceivePlan(consultNo: string): Promise<number | null> {
  const r = await consultClient.receivePlan(consultNo);
  if (!r.ok) {
    console.warn(`[consult receive] 取学籍落点失败（按试学中处理）：${r.message}`);
    return null;
  }
  const v = Number((r.data as Record<string, unknown>)?.studentStatus);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 建档成功后回写咨询侧状态（幂等；失败只记日志——人已经入班了，不能因此回滚） */
async function consultReceiveAck(
  consultNo: string,
  className: string | null,
  operatorName: string,
  operatorTitle = '班主任',
): Promise<void> {
  if (!consultNo) return;
  const r = await consultClient.receiveAck({
    consultNo,
    className,
    operatorName,
    operatorTitle,
  });
  if (!r.ok) {
    console.warn(`[consult receive] 回写咨询状态失败（${consultNo}）：${r.message}`);
  }
}

async function doReceive(
  req: any,
  res: any,
  opts: { internal?: boolean } = {},
): Promise<any> {
    const user = req.user!;
    const b = req.body as z.infer<typeof receiveSchema>;

    const push = (await notDeleted(PUSH()).where('id', b.id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!push) throw Errors.param('咨询推送单不存在');
    if (Number(push.apply_status) === ConsultStatus.RECEIVED) {
      throw Errors.param('该咨询单已接收，无需重复接收');
    }
    if (Number(push.apply_status) === ConsultStatus.REJECTED) {
      throw Errors.param('该咨询单已驳回，不能直接接收');
    }

    // ★ 2026-10-06：接收权限 = 本班班主任 / 校长 / 学管（用户拍板）
    // ★ 2026-10-20：分班即入班走内部入口时，操作人是咨询老师，不做班主任归属校验
    if (!opts.internal && !canHandlePush(user, push)) {
      throw Errors.noOperationPermission('只有该班班主任、校长或学管可以接收学员');
    }

    // ★ 2026-10-06：接受班级**只能**取推送单上的意向班级
    //   （用户拍板：接收班级由咨询 / 初高在推送时决定，本界面不设班级选择）
    //   老逻辑是「前端传什么就用什么，没传就用老师负责的第一个班」——
    //   那等于把「分到哪个班」的决定权交给了接收人，与需求相反。
    const classId = (push.intend_class_id as string) ?? null;
    if (!classId) {
      throw Errors.param('该推送单未指定接受班级，请让咨询 / 教学管理（初高）重新分班后再接收');
    }
    // ★ 2026-10-20：内部入口（分班即入班）不做班级可见范围校验 ——
    //   班级已经在咨询侧选定，这里只执行建档
    if (!opts.internal) assertClassAccess(user, classId, '该班级');

    /**
     * ★ 2026-10-19：目标班在【初高】
     *
     *   需求：「接收权限放宽到初高中、大学，初高中、大学接收来自咨询的学生」——
     *   初高不再「分班即入班」，也走推送 → 班主任在这里接收。
     *   初高的学生档案在另一个库（sms_class_jh），本模块不能直写，
     *   所以调初高的内部建档口 `POST /api/class-jh/student/from-consult`（幂等键=咨询单号）。
     *
     *   ⚠️ 判定用「这个班在不在初高库」，**不用 intend_dept_code**：
     *      末班 / 换班推来的单子里 dept 取的是学生自己的部门，学生部门与目标班
     *      不一致时（例如初高部的学生被放到大学班）会把单子导错库 →
     *      「目标班级不存在」。班的归属才是权威。
     */
    /**
     * ★ 2026-10-20：接收后学籍落「试学中」还是「正式在读」，由咨询侧按缴费情况回答
     *   （钱和费用单都在咨询库，班级侧看不到；口径与「补费转正」同源）
     *   拿不到就返回 null，建档时按各库默认值处理，不影响接收动作本身。
     */
    const planStatus = await consultReceivePlan(String(push.consult_no || ''));

    const jhCls = (await jhDb('t_class_info')
      .where({ id: classId, is_deleted: 0 })
      .first()) as Record<string, unknown> | undefined;
    if (jhCls) {
      // 学号 / 学历 / 入学日期 / 学生状态按接收弹窗填的带过去；
      // 宿舍床位是大学部宿舍表的 ID，初高用不上，这里不透传。
      const r = await classSync.consultCreateJh({
        consultNo: push.consult_no,
        studentName: push.student_name,
        gender: push.gender ?? undefined,
        phone: b.phone ?? push.phone ?? null,
        parentPhone: b.parentPhone ?? push.parent_phone ?? null,
        age: b.age ?? push.age ?? null,
        school: push.graduate_school ?? null,
        address: push.home_address ?? null,
        classId,
        remark: b.remark ?? push.remark ?? null,
        studentNo: b.studentNo ?? null,
        education: b.education ?? push.education ?? null,
        enrollDate: b.enrollDate ?? null,
        studentStatus: b.studentStatus ?? planStatus ?? null,
      });
      if (!r.ok) throw Errors.param(`接收失败：${r.message}`);

      const sid = String((r.data as Record<string, unknown>)?.id ?? '');
      const sno = String((r.data as Record<string, unknown>)?.studentNo ?? '');
      const dupJh = Boolean((r.data as Record<string, unknown>)?.duplicate);

      await PUSH()
        .where({ id: b.id })
        .update({
          apply_status: ConsultStatus.RECEIVED,
          receiver_id: user.userId,
          receiver_name: user.userName,
          receive_time: now(),
          student_id: sid,
          student_no: sno,
          ...baseUpdate(user),
        });

      /* ★ 2026-10-20：初高建档成功后回写咨询侧状态（待分班 → 试学中 / 正式在读） */
      await consultReceiveAck(
        String(push.consult_no || ''),
        (push.intend_class_name as string) ?? null,
        user.userName,
        opts.internal ? '系统' : '班主任',
      );

      return ok(
        res,
        { studentId: sid, studentNo: sno },
        dupJh
          ? `「${String(push.student_name)}」已在初高班级「${String(push.intend_class_name ?? '')}」里（未重复建档）`
          : `已接收「${String(push.student_name)}」并建档到初高班级「${String(push.intend_class_name ?? '')}」，学号 ${sno}`,
      );
    }

    let className: string | null = null;
    let deptCode = (push.intend_dept_code as number) ?? null;
    let headTeacherId: string | null = null;
    let headTeacherName: string | null = null;
    let teacherId: string | null = null;
    let teacherName: string | null = null;
    let assistantId: string | null = null;
    let assistantName: string | null = null;
    /** 阶段一律取目标班级的（「意向阶段」已删除，不再由推送单带过来） */
    let stage: number | null = null;

    if (classId) {
      const cls = (await notDeleted(CLS()).where('id', classId).first()) as
        | Record<string, unknown>
        | undefined;
      if (!cls) throw Errors.classNotFound('所选班级不存在');
      // 封班规则：非末班 / 重修的咨询新生，封班班级不收
      assertClassAcceptStudent(cls, !!b.repeatIn || Number(push.is_repeat_in) === 1);
      className = cls.class_name as string;
      deptCode = cls.dept_code as number;
      headTeacherId = (cls.head_teacher_id as string) ?? null;
      headTeacherName = (cls.head_teacher_name as string) ?? null;
      teacherId = (cls.teacher_id as string) ?? null;
      teacherName = (cls.teacher_name as string) ?? null;
      assistantId = (cls.assistant_id as string) ?? null;
      assistantName = (cls.assistant_name as string) ?? null;
      stage = (cls.stage as number) ?? null;
    }
    if (deptCode === null) {
      throw Errors.param('请选择要归入的班级（用于确定部门与学习阶段）');
    }

    /* ---------- 已建档学生转入（末班重修 / 换班）：不新建档案，只转班 ---------- */
    const isRepeatIn = Number(push.is_repeat_in) === 1;
    const isTransfer = push.source_system === 'transfer';
    if (push.origin_student_id && (isRepeatIn || isTransfer)) {
      const sid = push.origin_student_id as string;
      const stu = (await notDeleted(STU()).where('id', sid).first()) as
        | Record<string, unknown>
        | undefined;
      if (!stu) throw Errors.studentNotFound();

      const fromClassId = (stu.class_id as string) ?? null;
      const fromClassName = (stu.class_name as string) ?? null;
      const nextRepeat = isRepeatIn ? Number(stu.repeat_count ?? 0) + 1 : Number(stu.repeat_count ?? 0);

      // 末班记录需要带「成绩管理末班时的成绩」，接收时取该学员最近一次成绩快照
      const latestGrade = isRepeatIn
        ? ((await notDeleted(tbl(db, SRC, GRADE_T, STAGE))
            .where('student_id', sid)
            .orderBy('create_time', 'desc')
            .first()) as Record<string, unknown> | undefined)
        : undefined;

      await db.transaction(async (trx) => {
        const patch: Record<string, unknown> = {
          class_id: classId,
          class_name: className,
          head_teacher_id: headTeacherId,
          head_teacher_name: headTeacherName,
          teacher_id: teacherId,
          teacher_name: teacherName,
          assistant_id: assistantId,
          assistant_name: assistantName,
          dept_code: deptCode,
          ...baseUpdate(user),
        };
        if (isRepeatIn) patch.repeat_count = nextRepeat;
        if (stage !== null && stage !== undefined) patch.stage = stage;
        if (b.studentStatus) patch.student_status = b.studentStatus;
        if (b.dormId) {
          patch.dorm_id = b.dormId;
          patch.dorm_no = b.dormNo ?? null;
          patch.bed_no = b.bedNo ?? null;
        }
        await STU_TRX(trx).where({ id: sid }).update(patch);

        if (isRepeatIn) {
          // 末班记录（成绩管理 → 末班 → 班主任接收后回班重修，带成绩快照）
          await tblInsTrx(trx, SRC, REPEAT_T, STAGE, {
            ...baseInsert(user),
            student_id: sid,
            student_no: stu.student_no as string,
            student_name: stu.student_name as string,
            repeat_time: now(),
            repeat_reason: (push.transfer_reason as string) || '成绩管理末班，班主任接收后回到班级重修',
            from_class_id: fromClassId,
            from_class_name: fromClassName,
            to_class_id: classId,
            to_class_name: className,
            repeat_count: nextRepeat,
            exam_name: (latestGrade?.exam_name as string) ?? null,
            written_score: latestGrade?.written_score ?? null,
            interview_score: latestGrade?.interview_score ?? null,
            comp_score: latestGrade?.comp_score ?? null,
          } as never);
        } else {
          // 学生换班留痕
          // ★★ 统一表 `t_uni_class_transfer` 被三件事共用（岗位交接 / 升学转班 / 本域换班留痕），
          //   靠 `transfer_type` 区分事件性质；老表 `t_class_student_transfer` **压根没这列**，
          //   切读时必须显式给 7=学生换班，否则会落成默认 0=字典外的未知值。
          //   ⚠️ `t_class_student_transfer` 未登记 `UNI_COL_RENAME` —— 它的
          //   from_class_name / to_class_name 装的就是班级名，语义天然一致，不翻译。
          //   （对比 `t_class_transfer` 登记了 from_user_name → from_class_name 改名，
          //     那条路径的 from_user_name 装的是**人名**，两者语义不同、不能混用。）
          await tblInsTrx(trx, SRC, XFER_T, STAGE, {
            ...baseInsert(user),
            student_id: sid,
            student_no: stu.student_no as string,
            student_name: stu.student_name as string,
            from_class_id: fromClassId,
            from_class_name: fromClassName,
            to_class_id: classId,
            to_class_name: className,
            transfer_reason: (push.transfer_reason as string) || '班级信息管理发起换班',
            consult_no: push.consult_no as string,
            transfer_time: now(),
            // ↓ 以下 4 个键统一表有、老表没有 → tblIns 会按老表列清单自动剔除
            class_id: classId,
            transfer_type: TransferType.STUDENT_CLASS_CHANGE,
            transfer_date: (push.push_time as string ?? '').slice(0, 10) || now().slice(0, 10),
            remark: `咨询单${String(push.consult_no ?? '')}接收转入`,
          } as never);
        }

        // 班级人数：跨班时原班 -1、目标班 +1；同班不变
        if (fromClassId && fromClassId !== classId && classId) {
          await CLS_TRX(trx).where({ id: fromClassId }).decrement('student_count', 1);
          await CLS_TRX(trx).where({ id: classId }).increment('student_count', 1);
        }

        await PUSH_TRX(trx).where({ id: b.id }).update({
          apply_status: ConsultStatus.RECEIVED,
          receiver_id: user.userId,
          receiver_name: user.userName,
          receive_time: now(),
          student_id: sid,
          student_no: stu.student_no as string,
          ...baseUpdate(user),
        });
      });

      if (isTransfer) {
        return ok(
          res,
          { studentId: sid, studentNo: stu.student_no as string },
          `已接收「${String(stu.student_name)}」的换班申请，学员转入班级「${String(className ?? '')}」`,
        );
      }
      return ok(
        res,
        { studentId: sid, studentNo: stu.student_no as string },
        `已接收「${String(stu.student_name)}」，学员回到班级「${String(className ?? '')}」重修（末班第 ${nextRepeat} 次）`,
      );
    }

    // 学号
    let studentNo = b.studentNo?.trim() || '';
    if (!studentNo) {
      // ★ 第 4 期第 3 批：`maxStudentNo` 签名改为收「已路由的 builder」，
      //   原代码这里传的是写死的 `db('t_class_student')`（切读时会读老表 → 新建的学号
      //   会和种子数据撞号）。第 6 批（咨询域）起改为传 `STU()`，跟着开关走。
      const max = await maxStudentNo(STU(), `S${new Date().getFullYear()}%`);
      studentNo = buildStudentNo(seqOfStudentNo(max) + 1);
    } else {
      const dup = await notDeleted(STU()).where('student_no', studentNo).first();
      if (dup) throw Errors.studentNoExists(studentNo);
    }

    // 床位占用校验
    if (b.dormId && b.bedNo) {
      const taken = (await notDeleted(STU())
        .where({ dorm_id: b.dormId, bed_no: b.bedNo })
        .first()) as Record<string, unknown> | undefined;
      if (taken) {
        throw Errors.param(
          `床位 ${b.dormNo ?? ''}-${b.bedNo} 已被 ${String(taken.student_name)}（${String(taken.student_no)}）占用，请更换床位`,
        );
      }
    }

    const studentId = uuid();
    await db.transaction(async (trx) => {
      await tblInsTrx(trx, SRC, STU_T, STAGE, {
        ...baseInsert(user, studentId),
        source_system: 'consult',
        source_id: push.consult_no as string,
        source_batch_no: 'CONSULT',
        source_update_time: now(),
        sync_status: 2,
        student_no: studentNo,
        student_name: push.student_name as string,
        gender: (push.gender as number) ?? 1,
        age: (b.age as number) ?? ((push.age as number) ?? null),
        dept_code: deptCode,
        student_status: b.studentStatus ?? planStatus ?? StudentStatus.TRIAL,
        stage,
        phone: b.phone ?? ((push.phone as string) ?? null),
        parent_phone: b.parentPhone ?? ((push.parent_phone as string) ?? null),
        education: b.education ?? ((push.education as string) ?? null),
        enroll_date: b.enrollDate ?? null,
        repeat_count: 0,
        remark: b.remark ?? ((push.remark as string) ?? null),
        class_id: classId,
        class_name: className,
        head_teacher_id: headTeacherId,
        head_teacher_name: headTeacherName,
        teacher_id: teacherId,
        teacher_name: teacherName,
        assistant_id: assistantId,
        assistant_name: assistantName,
        dorm_id: b.dormId ?? null,
        dorm_no: b.dormNo ?? null,
        bed_no: b.bedNo ?? null,
        origin: (push.origin as string) ?? null,
        graduate_school: (push.graduate_school as string) ?? null,
        home_address: (push.home_address as string) ?? null,
      } as never);

      await PUSH_TRX(trx).where({ id: b.id }).update({
        apply_status: ConsultStatus.RECEIVED,
        receiver_id: user.userId,
        receiver_name: user.userName,
        receive_time: now(),
        student_id: studentId,
        student_no: studentNo,
        ...baseUpdate(user),
      });

      if (classId) {
        await CLS_TRX(trx).where({ id: classId }).increment('student_count', 1);
      }
    });

    /* ★ 2026-10-20：大学部建档成功后同样回写咨询侧状态（与初高完全一致） */
    await consultReceiveAck(
      String(push.consult_no || ''),
      className,
      user.userName,
      opts.internal ? '系统' : '班主任',
    );

    return ok(
      res,
      { studentId, studentNo, className },
      `已接收「${String(push.student_name)}」并建档，学号 ${studentNo}`,
    );
}

consultRouter.post(
  '/receive',
  // ★ 2026-10-06：改用审批类资源码 —— 学管主任（审批人）必须能接收，
  //   而他在 student 写白名单里已被移除，挂 student:ADD 会把他误拦。
  requirePerm('consultApprove', PermAction.APPROVE),
  validate({ body: receiveSchema }),
  wrap((req, res) => doReceive(req, res)),
);

/**
 * POST /api/class/consult/auto-receive （★ 2026-10-20 分班即入班）
 *
 * 用户口径：「缴费结束之后，直接给他分配班级……入班和分班合并」。
 *
 * 咨询侧在「学生管理 → 分配班级」选完班级后立刻调本接口：
 *   推送单已经由 /push 建好（`intend_class_id` = 所选班级），这里直接走
 *   「接收 + 建档」，学生当场落到目标班级，学部（初中部 / 高中部 / 大学部）
 *   不需要再到「待接收学员」点一次接收。
 *
 * ⚠️ 内部接口：只接受 x-internal-token（见 middleware/auth.ts 的 authAllowSync 白名单），
 *    操作人固定记为 system，不做班主任归属 / 班级可见范围校验 —— 班级本身
 *    已由咨询侧在推送时确定，这里只是执行建档。
 */
consultRouter.post(
  '/auto-receive',
  validate({
    body: z.object({
      consultNo: z.string().min(1, '缺少咨询单号'),
      studentStatus: z.coerce.number().int().optional().nullable(),
    }),
  }),
  wrap(async (req: any, res) => {
    const { consultNo, studentStatus } = req.body as {
      consultNo: string;
      studentStatus?: number | null;
    };

    const push = (await notDeleted(PUSH()).where('consult_no', consultNo).first()) as
      | Record<string, unknown>
      | undefined;
    if (!push) throw Errors.param(`未找到咨询单「${consultNo}」的推送记录，请先分班`);

    const status = Number(push.apply_status);
    if (status === ConsultStatus.RECEIVED) {
      // 幂等：已入班的直接返回，不重复建档
      return ok(
        res,
        {
          already: true,
          studentId: push.student_id ?? null,
          studentNo: push.student_no ?? null,
          className: push.intend_class_name ?? null,
        },
        `「${String(push.student_name)}」已在班级「${String(push.intend_class_name ?? '')}」中`,
      );
    }
    if (status === ConsultStatus.REJECTED) {
      throw Errors.param('该推送单已被驳回，请让咨询重新分班后再入班');
    }

    // 复用接收建档逻辑：仅把 body 收窄成「只带学生状态」
    req.body = { id: push.id, studentStatus: studentStatus ?? null };
    req.user = { userId: 'system', userName: '咨询分班', roles: [], permissions: [], token: '' };
    return doReceive(req, res, { internal: true });
  }),
);

/* ------------------------------ 接收弹窗 · 学籍落点默认值 ------------------------------ */

/**
 * GET /api/class/consult/receive-plan?id=<pushId>
 *
 * ★ 2026-10-20：接收弹窗打开时问一次「这个学生该落试学中还是正式在读」。
 *
 * 学生只交了试学费 → 试学中；学费等全款已到账 → 正式在读。
 * 判断依据在咨询库（钱和费用单都在那边），本模块只做转发，不自己算，
 * 免得两边口径打架（接收时还会按同一份判断再校正一次）。
 */
consultRouter.get(
  '/receive-plan',
  requirePerm('consultApprove', PermAction.APPROVE),
  validate({ query: z.object({ id: z.string().min(1, '缺少咨询单ID') }) }),
  wrap(async (req, res) => {
    const { id } = q<{ id: string }>(req);
    const push = (await notDeleted(PUSH()).where('id', id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!push) throw Errors.param('咨询推送单不存在');
    if (!canHandlePush(req.user!, push)) {
      throw Errors.noOperationPermission('只有该班班主任、校长或学管可以接收学员');
    }

    const r = await consultClient.receivePlan(String(push.consult_no || ''));
    if (!r.ok) {
      // 咨询侧不可用不该挡住接收动作 —— 返回空，前端用兜底默认值
      return ok(res, { studentStatus: null, fullSettled: null }, `取缴费进度失败：${r.message}`);
    }
    return ok(res, r.data, '查询成功');
  }),
);

/* ------------------------------ 驳回 ------------------------------ */

const rejectSchema = z.object({
  id: z.string().min(1, '缺少咨询单ID'),
  /**
   * 驳回原因：语义上必填，但这里放宽为可选，改在 handler 里用 Errors.required 显式抛「必填缺失 40002」。
   * 若用 z.string().min(1)，zod 校验失败会被错误中间件统一归到 40000（参数错），
   * 与「驳回必须填原因」这一业务语义的 40002 不一致（对齐 suspend/refund 驳回的既有写法）。
   */
  rejectReason: z.string().optional().nullable(),
});

/**
 * @openapi
 * /api/class/consult/reject:
 *   post:
 *     tags: [咨询推送]
 *     summary: 班主任驳回咨询推送（必填原因，回传咨询模块）
 */
consultRouter.post(
  '/reject',
  // ★ 2026-10-06：同「接收」—— 驳回也是审批动作，学管要能办
  requirePerm('consultApprove', PermAction.APPROVE),
  validate({ body: rejectSchema }),
  wrap(async (req, res) => {
    const user = req.user!;
    const b = req.body as z.infer<typeof rejectSchema>;
    const push = (await notDeleted(PUSH()).where('id', b.id).first()) as
      | Record<string, unknown>
      | undefined;
    if (!push) throw Errors.param('咨询推送单不存在');
    if (Number(push.apply_status) !== ConsultStatus.PENDING) {
      throw Errors.param('只有「待接收」的咨询单可以驳回');
    }
    // ★ 2026-10-06：与「接收」同口径 —— 本班班主任 / 校长 / 学管
    if (!canHandlePush(user, push)) {
      throw Errors.noOperationPermission('只有该班班主任、校长或学管可以驳回');
    }
    // 驳回必填原因 → 40002（必填缺失），与 suspend / refund 的驳回保持一致
    if (!b.rejectReason || !b.rejectReason.trim()) throw Errors.required('驳回原因');
    await PUSH().where({ id: b.id }).update({
      apply_status: ConsultStatus.REJECTED,
      receiver_id: user.userId,
      receiver_name: user.userName,
      receive_time: now(),
      reject_reason: b.rejectReason.trim(),
      ...baseUpdate(user),
    });
    return ok(res, { id: b.id }, '已驳回，原因将回传咨询模块');
  }),
);
