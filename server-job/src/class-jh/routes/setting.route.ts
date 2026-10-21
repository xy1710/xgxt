/**
 * 系统设置 / 阶段字典 / 阶段方案 / 操作日志路由（教学管理初高）
 *
 * 挂载：settingRouter → /api/class/setting；stageRouter → /api/class/stage；
 *      stageSchemeRouter → /api/class/stage-scheme；opLogRouter → /api/class/opLog。
 * 表：t_class_setting、t_class_stage、（t_class_stage_scheme + t_class_stage_scheme_stage）、t_class_op_log。
 *
 * ★ 2026-10-16：「阶段字典」页签升级为「阶段方案」——
 *   原 stageRouter（单条阶段的增删）保留不动（老接口随时可回退），
 *   新需求（方案 = 方案名称 + 部门 + N 个阶段）走下面的 stageSchemeRouter。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { BizCode, STAGE_NAME, DEPT_NAME, FLOW_TYPE_NAME } from 'shared-types/class-jh';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
// ★ 2026-10-19 就业部接入阶段方案：判断阶段是否被「就业部 / 实训」的班级或学生占用，
//   这两张表在 sms_job（不是 sms_class_jh）
import { db as jobDb } from '../../utils/db';
import { wrap } from '../utils/wrap';
import { writeOpLog } from '../utils/opLog';
import { nameOf } from '../utils/enumName';
// ★ 2026-10-16 阶段方案：阶段的增删改后要刷新「阶段编码 → 名称」内存缓存
import { refreshStageDict } from '../utils/stageDict';
import { getAllSettings, SETTING_DEFAULTS } from '../utils/setting';
import { validate } from '../middleware/validate';
import { checkPermission } from '../middleware/auth';
import { BizError } from '../middleware/errorHandler';
import {
  listSchemes,
  getScheme,
  createScheme,
  updateScheme,
  removeScheme,
  type StageSchemeSaveInput,
} from '../utils/stageScheme';

export const settingRouter = Router();
export const stageRouter = Router();
export const stageSchemeRouter = Router();
export const opLogRouter = Router();

const SETTING_TABLE = 't_class_setting';
const STAGE_TABLE = 't_class_stage';
/** ★ 2026-10-16 阶段方案表（一个方案含多个阶段） */
const STAGE_PLAN_TABLE = 't_class_stage_plan';
const CLASS_TABLE = 't_class_info';
const OP_LOG_TABLE = 't_class_op_log';
const STUDENT_TABLE = 't_class_student';

/** 设置项中文名 */
const SETTING_NAME: Record<string, string> = {
  attendanceTargetRate: '出勤率目标（%）',
  attendanceScope: '出勤统计口径',
  feeRemindDays: '催费提前提醒天数',
  feeUrgeWindowDays: '催费列表窗口天数（到期日距今 ≤ N 天进列表，含已逾期）',
  refundThresholdAmount: '退费审批阈值（分）',
  closedClassIntakeTypes: '封班可转入类型',
  allowStudentAdd: '是否允许手动新增学生',
};

/* ============================================================
 * 1. 设置详情（KV 全量，缺失补默认）
 *   GET /api/class/setting/detail
 * ============================================================ */

settingRouter.get(
  '/detail',
  checkPermission('class:setting:view'),
  wrap(async (_req, res) => {
    const rows = await db(SETTING_TABLE).where('is_deleted', false).select('*');
    const byKey = new Map<string, any>(rows.map((r: any) => [r.setting_key, r]));

    const keys = new Set<string>([...Object.keys(SETTING_DEFAULTS), ...rows.map((r: any) => r.setting_key)]);
    const list = Array.from(keys).map((key) => {
      const r = byKey.get(key);
      return {
        settingKey: key,
        settingName: r?.setting_name ?? SETTING_NAME[key] ?? key,
        settingValue: r?.setting_value ?? SETTING_DEFAULTS[key] ?? '',
        remark: r?.remark ?? null,
      };
    });

    res.json(ok(list));
  }),
);

/* ============================================================
 * 2. 设置修改（KV upsert）
 *   PUT /api/class/setting/update
 * ============================================================ */

settingRouter.put(
  '/update',
  checkPermission('class:setting:edit'),
  validate(z.record(z.union([z.string(), z.number(), z.boolean()]))),
  wrap(async (req, res) => {
    const body = (req as any).validated as Record<string, string | number | boolean>;
    const now = new Date();

    for (const [key, value] of Object.entries(body)) {
      const strVal = typeof value === 'boolean' ? String(value) : String(value);
      const existed = await db(SETTING_TABLE).where({ setting_key: key, is_deleted: false }).first();
      if (existed) {
        await db(SETTING_TABLE).where({ id: existed.id }).update({
          setting_value: strVal,
          update_time: now,
          update_by: req.user?.userId || 'system',
        });
      } else {
        await db(SETTING_TABLE).insert({
          id: randomUUID(),
          setting_key: key,
          setting_name: SETTING_NAME[key] ?? key,
          setting_value: strVal,
          remark: null,
          is_deleted: false,
          create_time: now,
          create_by: req.user?.userId || 'system',
        });
      }
    }

    await writeOpLog({
      module: 'setting',
      bizType: '系统设置',
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `修改系统设置：${Object.keys(body).join('、')}`,
      afterValue: body,
    });

    res.json(ok(null, '保存成功'));
  }),
);

/* ============================================================
 * 3. 阶段列表
 *   GET /api/class/stage/list?deptCode=
 * ============================================================ */

stageRouter.get(
  '/list',
  checkPermission('class:setting:view'),
  validate(z.object({ deptCode: z.coerce.number().int().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated as { deptCode?: number };
    const query = db(STAGE_TABLE).where('is_deleted', false);
    if (q.deptCode) query.andWhere('dept_code', q.deptCode);

    const rows = await query.select('*').orderBy('sort_no', 'asc').orderBy('stage_code', 'asc');
    res.json(
      ok(
        rows.map((s: any) => ({
          stageCode: s.stage_code,
          stageName: s.stage_name || nameOf(STAGE_NAME, s.stage_code),
          deptCode: s.dept_code,
          deptName: nameOf(DEPT_NAME, s.dept_code),
          studyMonths: s.study_months,
          sortNo: s.sort_no,
          id: s.id,
        })),
      ),
    );
  }),
);

/* ============================================================
 * 4. 阶段新增
 *   POST /api/class/stage/add
 * ============================================================ */

const stageAddSchema = z.object({
  stageCode: z.coerce.number().int(),
  stageName: z.string().min(1, '阶段名称必填'),
  deptCode: z.coerce.number().int().min(1).max(2),
  studyMonths: z.coerce.number().int().optional(),
  sortNo: z.coerce.number().int().optional(),
});

stageRouter.post(
  '/add',
  checkPermission('class:setting:edit'),
  validate(stageAddSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof stageAddSchema>;

    const dup = await db(STAGE_TABLE)
      .where({ stage_code: body.stageCode, dept_code: body.deptCode, is_deleted: false })
      .first();
    if (dup) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '该部门下阶段编码已存在');

    const id = randomUUID();
    const now = new Date();
    await db(STAGE_TABLE).insert({
      id,
      stage_code: body.stageCode,
      stage_name: body.stageName,
      dept_code: body.deptCode,
      study_months: body.studyMonths ?? null,
      sort_no: body.sortNo ?? 0,
      is_deleted: false,
      create_time: now,
      create_by: req.user?.userId || 'system',
    });
    await refreshStageDict();

    res.json(ok({ id }, '新增成功'));
  }),
);

/* ============================================================
 * 5. 阶段删除（仍有学生的阶段禁止删）
 *   DELETE /api/class/stage/delete/:id
 * ============================================================ */

stageRouter.delete(
  '/delete/:id',
  checkPermission('class:setting:edit'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const stage = await db(STAGE_TABLE).where({ id, is_deleted: false }).first();
    if (!stage) throw new BizError(BizCode.SETTING_NOT_FOUND, '阶段不存在');

    const used = await db(STUDENT_TABLE).where({ stage: stage.stage_code, is_deleted: false }).first();
    if (used) throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, '该阶段下仍有学生，禁止删除');

    await db(STAGE_TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });
    await refreshStageDict();

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 5.5 ★ 2026-10-16 阶段方案（一个方案 = 多个阶段）
 *
 *   表：t_class_stage_plan（方案） 1 ── N t_class_stage（阶段，plan_id 关联）
 *
 *   规则：
 *     - 方案名称在同一部门内不可重复
 *     - 阶段编码由后端自动生成：初高部 1xx / 大学部 2xx / 就业部 3xx，
 *       取同部门当前最大值 +1
 *       （软删除的行仍占号，避免编码复用把历史数据指到别的阶段上）
 *     - 已被班级 / 学生使用的阶段，不允许删除，也不允许通过改「所属部门」换号
 *
 *   ★ 2026-10-19：部门扩到 3 个（就业部）。
 *     实训班与就业部班级共用 `sms_job.t_job_class`（dept_code=3，靠 stage_key 区分），
 *     所以「就业部」这一套方案对实训 / 就业两个学段同时生效。
 * ============================================================ */

/** 生成同部门的下一个阶段编码（1xx / 2xx / 3xx，与部门编码对齐） */
async function nextStageCode(deptCode: number): Promise<number> {
  const base = deptCode === 2 ? 200 : deptCode === 3 ? 300 : 100;
  const row: any = await db(STAGE_TABLE).where('dept_code', deptCode).max({ m: 'stage_code' }).first();
  const max = Number(row?.m);
  return (Number.isFinite(max) && max > base ? max : base) + 1;
}

/** 阶段编码是否已被班级 / 学生使用 */
async function stageInUse(stageCode: number): Promise<boolean> {
  const byClass = await db(CLASS_TABLE).where({ stage: stageCode, is_deleted: false }).first();
  if (byClass) return true;
  const byStudent = await db(STUDENT_TABLE).where({ stage: stageCode, is_deleted: false }).first();
  if (byStudent) return true;
  // ★ 就业部（含实训）：班级 / 学生都在 sms_job，阶段码同样存在 stage 列
  const byEmpClass = await jobDb('t_job_class')
    .where({ stage: stageCode, dept_code: 3, is_deleted: false })
    .first();
  if (byEmpClass) return true;
  const byEmpStudent = await jobDb('t_student_base')
    .where({ stage: stageCode, dept_code: 3, is_deleted: false })
    .first();
  return !!byEmpStudent;
}

const planPhaseSchema = z.object({
  /** 编辑时带上的已有阶段 ID；新增的阶段不带 */
  id: z.string().optional(),
  stageName: z.string().min(1, '阶段名称必填'),
  studyMonths: z.coerce.number().int().min(0).optional(),
});

const planSaveSchema = z.object({
  planName: z.string().min(1, '方案名称必填'),
  /** 1 初高部 / 2 大学部 / 3 就业部（实训与就业共用 3） */
  deptCode: z.coerce.number().int().min(1).max(3),
  phases: z.array(planPhaseSchema).min(1, '至少需要一个阶段'),
});

/** 方案列表（含阶段明细） GET /api/class-jh/stage/plan/list?deptCode= */
stageRouter.get(
  '/plan/list',
  checkPermission('class:setting:view'),
  validate(z.object({ deptCode: z.coerce.number().int().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated as { deptCode?: number };

    const planQuery = db(STAGE_PLAN_TABLE).where('is_deleted', false);
    if (q.deptCode) planQuery.andWhere('dept_code', q.deptCode);
    const plans = await planQuery.select('*').orderBy('sort_no', 'asc').orderBy('create_time', 'asc');

    const stageQuery = db(STAGE_TABLE).where('is_deleted', false);
    if (q.deptCode) stageQuery.andWhere('dept_code', q.deptCode);
    const stages = await stageQuery.select('*').orderBy('sort_no', 'asc').orderBy('stage_code', 'asc');

    const byPlan = new Map<string, any[]>();
    for (const s of stages) {
      const key = s.plan_id || '';
      if (!byPlan.has(key)) byPlan.set(key, []);
      byPlan.get(key)!.push(s);
    }

    res.json(
      ok(
        plans.map((p: any) => ({
          id: p.id,
          planName: p.plan_name,
          deptCode: p.dept_code,
          deptName: nameOf(DEPT_NAME, p.dept_code),
          sortNo: p.sort_no,
          phases: (byPlan.get(p.id) || []).map((s: any) => ({
            id: s.id,
            stageCode: s.stage_code,
            stageName: s.stage_name || nameOf(STAGE_NAME, s.stage_code),
            studyMonths: s.study_months,
            sortNo: s.sort_no,
          })),
        })),
      ),
    );
  }),
);

/** 方案新增 POST /api/class-jh/stage/plan/add */
stageRouter.post(
  '/plan/add',
  checkPermission('class:setting:edit'),
  validate(planSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof planSaveSchema>;
    const dup = await db(STAGE_PLAN_TABLE)
      .where({ plan_name: body.planName, dept_code: body.deptCode, is_deleted: false })
      .first();
    if (dup) throw new BizError(BizCode.DATA_DUPLICATE, '该部门下方案名称已存在');

    const now = new Date();
    const uid = req.user?.userId || 'system';
    const planId = randomUUID();

    await db(STAGE_PLAN_TABLE).insert({
      id: planId,
      plan_name: body.planName,
      dept_code: body.deptCode,
      sort_no: 0,
      is_deleted: false,
      create_time: now,
      create_by: uid,
    });

    let sortNo = 0;
    for (const p of body.phases) {
      const stageCode = await nextStageCode(body.deptCode);
      await db(STAGE_TABLE).insert({
        id: randomUUID(),
        stage_code: stageCode,
        stage_name: p.stageName,
        dept_code: body.deptCode,
        plan_id: planId,
        study_months: p.studyMonths ?? null,
        sort_no: sortNo,
        is_deleted: false,
        create_time: now,
        create_by: uid,
      });
      sortNo += 1;
    }

    await refreshStageDict();
    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增阶段方案：${body.planName}（${body.phases.length} 个阶段）`,
      afterValue: body,
    });

    res.json(ok({ id: planId }, '新增成功'));
  }),
);

/** 方案编辑 PUT /api/class-jh/stage/plan/update */
stageRouter.put(
  '/plan/update',
  checkPermission('class:setting:edit'),
  validate(planSaveSchema.extend({ id: z.string().min(1) })),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof planSaveSchema> & { id: string };
    const plan = await db(STAGE_PLAN_TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!plan) throw new BizError(BizCode.SETTING_NOT_FOUND, '方案不存在');

    const dup = await db(STAGE_PLAN_TABLE)
      .where({ plan_name: body.planName, dept_code: body.deptCode, is_deleted: false })
      .whereNot('id', body.id)
      .first();
    if (dup) throw new BizError(BizCode.DATA_DUPLICATE, '该部门下方案名称已存在');

    const now = new Date();
    const uid = req.user?.userId || 'system';
    const deptChanged = Number(plan.dept_code) !== body.deptCode;
    const existing: any[] = await db(STAGE_TABLE).where({ plan_id: plan.id, is_deleted: false });

    // 改部门 = 换编码，被使用的阶段不允许（否则班级/学生的阶段会指错）
    if (deptChanged) {
      for (const s of existing) {
        if (await stageInUse(s.stage_code)) {
          throw new BizError(
            BizCode.BUSINESS_RULE_VIOLATION,
            `阶段「${s.stage_name}」已被班级或学生使用，不能修改方案的所属部门`,
          );
        }
      }
    }

    const existingById = new Map<string, any>(existing.map((s) => [s.id, s]));
    const keepIds = new Set(body.phases.filter((p) => p.id).map((p) => p.id as string));

    /**
     * ★ 2026-10-19：把「要删的阶段是否在用」**提前**到写库之前统一校验。
     *   原来这段判断在下面的删除循环里，而方案名 / 阶段明细已经先更新了 ——
     *   一旦后面抛错，库里会留下「改了一半」的数据（实测踩到过）。
     */
    for (const s of existing) {
      if (keepIds.has(s.id)) continue;
      if (await stageInUse(s.stage_code)) {
        throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `阶段「${s.stage_name}」已被班级或学生使用，不能删除`);
      }
    }

    await db(STAGE_PLAN_TABLE).where({ id: plan.id }).update({
      plan_name: body.planName,
      dept_code: body.deptCode,
      update_time: now,
      update_by: uid,
    });

    // 1) 逐条更新 / 新增
    let sortNo = 0;
    for (const p of body.phases) {
      const old = p.id ? existingById.get(p.id) : null;
      if (old) {
        const patch: Record<string, any> = {
          stage_name: p.stageName,
          study_months: p.studyMonths ?? null,
          sort_no: sortNo,
          update_time: now,
          update_by: uid,
        };
        if (deptChanged) {
          patch.stage_code = await nextStageCode(body.deptCode);
          patch.dept_code = body.deptCode;
        }
        await db(STAGE_TABLE).where({ id: old.id }).update(patch);
      } else {
        const stageCode = await nextStageCode(body.deptCode);
        await db(STAGE_TABLE).insert({
          id: randomUUID(),
          stage_code: stageCode,
          stage_name: p.stageName,
          dept_code: body.deptCode,
          plan_id: plan.id,
          study_months: p.studyMonths ?? null,
          sort_no: sortNo,
          is_deleted: false,
          create_time: now,
          create_by: uid,
        });
      }
      sortNo += 1;
    }

    // 2) 被移除的阶段：软删除（在用的禁止删）
    for (const s of existing) {
      if (keepIds.has(s.id)) continue;
      if (await stageInUse(s.stage_code)) {
        throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `阶段「${s.stage_name}」已被班级或学生使用，不能删除`);
      }
      await db(STAGE_TABLE).where({ id: s.id }).update({ is_deleted: true, update_time: now, update_by: uid });
    }

    await refreshStageDict();
    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `修改阶段方案：${body.planName}`,
      afterValue: body,
    });

    res.json(ok(null, '保存成功'));
  }),
);

/** 方案删除 DELETE /api/class-jh/stage/plan/delete/:id */
stageRouter.delete(
  '/plan/delete/:id',
  checkPermission('class:setting:edit'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const plan = await db(STAGE_PLAN_TABLE).where({ id, is_deleted: false }).first();
    if (!plan) throw new BizError(BizCode.SETTING_NOT_FOUND, '方案不存在');

    const stages: any[] = await db(STAGE_TABLE).where({ plan_id: id, is_deleted: false });
    for (const s of stages) {
      if (await stageInUse(s.stage_code)) {
        throw new BizError(BizCode.BUSINESS_RULE_VIOLATION, `阶段「${s.stage_name}」已被班级或学生使用，不能删除该方案`);
      }
    }

    const now = new Date();
    const uid = req.user?.userId || 'system';
    await db(STAGE_TABLE).where({ plan_id: id, is_deleted: false }).update({ is_deleted: true, update_time: now, update_by: uid });
    await db(STAGE_PLAN_TABLE).where({ id }).update({ is_deleted: true, update_time: now, update_by: uid });
    await refreshStageDict();

    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `删除阶段方案：${plan.plan_name}`,
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 5b. 阶段方案（★ 2026-10-16）
 *
 * 【与上面「阶段字典」的区别】
 *   阶段字典：一条记录 = 一个阶段（平铺）。
 *   阶段方案：一个方案 = 方案名称 + 所属部门 + N 个阶段明细（阶段名称 + 学制月数）。
 *   例：方案一（初高部）→ 一阶段 学制2月 / 二阶段 学制2月 / 三阶段 学制2月。
 *
 * 【接口】
 *   GET    /api/class/stage-scheme/list?deptCode=   方案列表（含阶段明细）
 *   POST   /api/class/stage-scheme/add              新增方案（含阶段明细）
 *   PUT    /api/class/stage-scheme/update/:id       修改方案（阶段明细整体覆盖）
 *   DELETE /api/class/stage-scheme/delete/:id       删除方案（被班级引用时拒绝）
 * ============================================================ */

/** 方案保存校验（新增 / 修改共用） */
const schemeSaveSchema = z.object({
  schemeName: z.string().trim().min(1, '方案名称必填').max(50),
  deptCode: z.coerce.number().int().min(1, '所属部门必填').max(2),
  stages: z
    .array(
      z.object({
        stageName: z.string().trim().min(1, '阶段名称必填').max(50),
        studyMonths: z.coerce.number().int().min(1, '学制（月）必填'),
      }),
    )
    .min(1, '至少添加一个阶段'),
});

stageSchemeRouter.get(
  '/list',
  checkPermission('class:setting:view'),
  validate(z.object({ deptCode: z.coerce.number().int().optional() })),
  wrap(async (req, res) => {
    const q = (req as any).validated as { deptCode?: number };
    res.json(ok(await listSchemes(q.deptCode)));
  }),
);

stageSchemeRouter.post(
  '/add',
  checkPermission('class:setting:edit'),
  validate(schemeSaveSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as StageSchemeSaveInput;
    const { id } = await createScheme(body, req.user?.userId || 'system');

    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      bizId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `新增阶段方案「${body.schemeName}」（${nameOf(DEPT_NAME, body.deptCode)}，${body.stages.length} 个阶段）`,
      afterValue: body as any,
    });

    res.json(ok({ id }, '新增成功'));
  }),
);

stageSchemeRouter.put(
  '/update/:id',
  checkPermission('class:setting:edit'),
  validate(schemeSaveSchema),
  wrap(async (req, res) => {
    const { id } = req.params;
    const body = (req as any).validated as StageSchemeSaveInput;
    const before = await getScheme(id);

    await updateScheme(id, body, req.user?.userId || 'system');

    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      bizId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `修改阶段方案「${body.schemeName}」（${nameOf(DEPT_NAME, body.deptCode)}，${body.stages.length} 个阶段）`,
      beforeValue: before as any,
      afterValue: body as any,
    });

    res.json(ok({ id }, '保存成功'));
  }),
);

stageSchemeRouter.delete(
  '/delete/:id',
  checkPermission('class:setting:edit'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const before = await getScheme(id);

    await removeScheme(id, req.user?.userId || 'system');

    await writeOpLog({
      module: 'setting',
      bizType: '阶段方案',
      bizId: id,
      opUserId: req.user?.userId,
      opUserName: req.user?.userName,
      opDesc: `删除阶段方案「${before?.schemeName ?? id}」`,
      beforeValue: before as any,
    });

    res.json(ok(null, '删除成功'));
  }),
);

/* ============================================================
 * 6. 操作日志列表
 *   GET /api/class/opLog/list
 * ============================================================ */

const opLogListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  bizType: z.string().optional(),
  studentId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

opLogRouter.get(
  '/list',
  checkPermission('class:opLog:view'),
  validate(opLogListSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof opLogListSchema>;
    const query = db(OP_LOG_TABLE).where('is_deleted', false);
    if (q.bizType) query.andWhere('biz_type', q.bizType);
    if (q.studentId) query.andWhere('student_id', q.studentId);
    if (q.startDate) query.andWhere('op_time', '>=', `${q.startDate} 00:00:00`);
    if (q.endDate) query.andWhere('op_time', '<=', `${q.endDate} 23:59:59`);

    const [{ total }] = await query.clone().count({ total: '*' });
    const rows = await query
      .clone()
      .select('*')
      .orderBy('op_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    const list = rows.map((r: any) => ({
      logId: r.id,
      module: r.module,
      bizType: r.biz_type,
      bizId: r.biz_id,
      studentId: r.student_id,
      classId: r.class_id,
      opUserId: r.op_user_id,
      opUserName: r.op_user_name,
      opTime: r.op_time,
      opDesc: r.op_desc,
      beforeValue: parseJson(r.before_value),
      afterValue: parseJson(r.after_value),
    }));

    res.json(page(list, Number(total), q));
  }),
);

function parseJson(v: any): any {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export default settingRouter;

/** 供 dashboard 复用：待审批流程类型中文名 */
export const _flowTypeName = FLOW_TYPE_NAME;
