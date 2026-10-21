/**
 * 统一班级信息接口 · /api/teaching/class/*
 * ============================================================
 *
 * 取代合并前的 8 + 11 + 12 = 31 个班级接口（三个学段各一套，
 * 名字还都不一样：/list vs /page、/add vs /create…）。
 *
 * 【三个学段的入口是同一个，靠 stage 区分】
 *   jh 初高 / class 大学 / job 实训
 *
 * 【★ 状态流转统一走一张表】
 *   见 shared/dto.ts 的 CLASS_STATUS_TRANSITIONS（取初高那套，最完整）。
 *   非法流转在 service/仓储里抛错，前端不显示非法选项。
 *
 * 老接口（/api/job/class、/api/class/info、/api/class-jh/classInfo）
 * 一个都没删，随时可回退。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok, page as pageResp } from '../../utils/response';
import * as svc from './service';
// 升实训单独一个文件（跨库搬迁逻辑较重，且不参与班级仓储的适配器分发）
import * as trainingSvc from './training';
import type { ClassListQuery, ClassStage } from '../shared/dto';
import { CLASS_STATUS_NAME } from '../shared/dto';
import { normalizeClassroom } from '../shared/format';

export const teachingClassRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v);
}
function strOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v);
}
function int(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function reqStage(v: unknown): ClassStage {
  return svc.assertStage(v);
}
function optStage(v: unknown): ClassStage | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return svc.assertStage(v);
}
function dateStr(v: unknown): string | null | undefined {
  const s = strOrNull(v);
  if (s === undefined || s === null) return s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BizError(BizCode.PARAM_ERROR, '日期格式应为 YYYY-MM-DD');
  }
  return s;
}
function requireId(v: unknown): string {
  const s = str(v);
  if (!s) throw new BizError(BizCode.PARAM_ERROR, '缺少班级ID');
  return s;
}

/**
 * ★★ NOT NULL 列的空值处理（这是本域踩过的真实坑）
 *
 *   三张班级表的 `stage`（阶段码）、`dept_code`、`class_status` 都是 NOT NULL。
 *   而前端编辑弹窗**只提交用户改过的字段**，没填的会传 `null`（清空）或 `undefined`（没带）。
 *
 *   如果直接把 `null` 写进 update → 报 `ER_BAD_NULL_ERROR: Column 'stage' cannot be null`
 *   —— 表现为「改个教室名都改不了」，而且更糟：可能把已有阶段码悄悄抹成 0。
 *
 *   规则：**NOT NULL 列的 null 一律降级成 undefined（= 不修改）**，
 *        所以下面 deptCode / phaseCode / classStatus 都用 numOrUndef（它已经把 null 归成 undefined）。
 */
function buildSaveBody(b: Record<string, any>, stage: ClassStage) {
  // 三张表里这几列都是 NOT NULL，传 null 会炸库或抹数据 → null 一律转 undefined
  const deptCode = numOrUndef(b.deptCode);
  const phaseCode = numOrUndef(b.phaseCode);
  const classStatus = numOrUndef(b.classStatus);
  return {
    stage,
    id: str(b.id),
    className: String(b.className).trim(),
    classCode: strOrNull(b.classCode),
    deptCode,
    phaseCode,
    // ★ 2026-10-16：阶段方案三字段（可空 —— 老班级/不选方案时不传）
    schemeId: strOrNull(b.schemeId),
    schemeStageId: strOrNull(b.schemeStageId),
    schemeStageName: strOrNull(b.schemeStageName),
    headTeacherId: strOrNull(b.headTeacherId),
    headTeacherName: strOrNull(b.headTeacherName),
    teacherId: strOrNull(b.teacherId),
    teacherName: strOrNull(b.teacherName),
    assistantId: strOrNull(b.assistantId),
    assistantName: strOrNull(b.assistantName),
    projectManagerId: strOrNull(b.projectManagerId),
    projectManagerName: strOrNull(b.projectManagerName),
    employmentTeacherId: strOrNull(b.employmentTeacherId),
    employmentTeacherName: strOrNull(b.employmentTeacherName),
    universityNo: strOrNull(b.universityNo),
    // ★ 2026-10-19 教室统一成「楼栋-房间号」（A栋-102 / 教学楼 A-102 → A-102）
    classroom: normalizeClassroom(strOrNull(b.classroom)),
    openDate: dateStr(b.openDate),
    closeDate: dateStr(b.closeDate),
    classStatus,
    remark: strOrNull(b.remark),
  };
}

/** 从 query 组装列表查询 */
function queryOf(req: Request): ClassListQuery {
  return {
    stage: optStage(req.query.stage),
    deptCode: numOrUndef(req.query.deptCode),
    classStatus: numOrUndef(req.query.classStatus),
    phaseCode: numOrUndef(req.query.phaseCode),
    keyword: str(req.query.keyword),
    page: int(req.query.page, 1),
    size: Math.min(int(req.query.size, 20), 200),
  };
}

/** 1. 列表 */
teachingClassRouter.get(
  '/list',
  wrap(async (req, res) => {
    const r = await svc.listClasses(queryOf(req), req.user);
    // ★ page() 的第 3 参只接受 {page,size}，多余的字段塞不进去
    //   （前端要「本次合并了哪些学段」走 /meta 拿，这里保持与其它域一致）
    res.json(pageResp(r.list, r.total, { page: r.page, size: r.size }));
  }),
);

/** 2. 详情（含花名册 + 可流转状态） */
teachingClassRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = requireId(req.query.id);
    const d = await svc.getClassDetail(stage, id, req.user);
    if (!d) throw new BizError(BizCode.CLASS_NOT_FOUND, '班级不存在或无权访问');
    res.json(ok(d));
  }),
);

/** 3. 花名册 */
teachingClassRouter.get(
  '/roster',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = requireId(req.query.id);
    res.json(ok(await svc.listClassRoster(stage, id, req.user), '查询成功'));
  }),
);

/** 4. 保存（新增 / 修改） */
teachingClassRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    if (!String(b.className ?? '').trim()) {
      throw new BizError(BizCode.PARAM_ERROR, '班级名称必填');
    }
    // 状态值校验必须在入仓储前 —— 否则非法值会静默落库
    if (b.classStatus !== undefined && b.classStatus !== null && b.classStatus !== '') {
      const st = Number(b.classStatus);
      if (!CLASS_STATUS_NAME[st]) {
        throw new BizError(BizCode.PARAM_ERROR, '班级状态取值非法');
      }
    }
    const r = await svc.saveClass(
      // ⚠️ NOT NULL 列（deptCode / phaseCode / classStatus）用 skipIfNull：
      //    传 null = 「清空」→ 对 NOT NULL 列会直接报 ER_BAD_NULL_ERROR，
      //    而且更危险 —— 可能把已有的阶段/部门悄悄抹掉。这里一律当「不修改」。
      buildSaveBody(b, stage),
      req.user,
    );
    res.json(ok(r, b.id ? '班级已更新' : '班级已创建'));
  }),
);

/** 5. 删除（逻辑删除） */
teachingClassRouter.delete(
  '/delete',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = requireId(req.query.id);
    await svc.removeClass(stage, id, req.user);
    res.json(ok(null, '已删除'));
  }),
);

/** 6. 改状态（走统一状态机） */
teachingClassRouter.post(
  '/change-status',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const id = requireId(b.id);
    const to = Number(b.classStatus);
    if (!Number.isFinite(to) || !CLASS_STATUS_NAME[to]) {
      throw new BizError(BizCode.PARAM_ERROR, '目标状态取值非法');
    }
    await svc.changeClassStatus(stage, id, to, req.user);
    res.json(ok(null, `已变更为「${CLASS_STATUS_NAME[to]}」`));
  }),
);

/* ============================================================
 * 8/9. 班级交接（2026-10-19 批注）
 *   一次交接 = 5 个岗位（班主任/教员/助教/项目经理/就业老师）同时换人，
 *   提交即生效（不走审批），并在详情抽屉里留一条记录。
 * ============================================================ */

/** 8. 某班的交接记录 */
teachingClassRouter.get(
  '/handover/list',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const classId = requireId(req.query.classId);
    res.json(ok(await svc.listClassHandovers(stage, classId, req.user), '查询成功'));
  }),
);

/** 9. 提交交接（只带「要换的新人」，没带的岗位视为不变） */
teachingClassRouter.post(
  '/handover',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const classId = requireId(b.classId);
    const row = await svc.handoverClass({ ...b, stage, classId }, req.user);
    res.json(ok(row, '交接已生效'));
  }),
);

/** 7. 元信息（各学段特性：有无编号 / 有无结业日期 / 阶段码选项） */
teachingClassRouter.get(
  '/meta',
  wrap(async (req, res) => {
    res.json(ok(await svc.listClassMeta(req.user), '查询成功'));
  }),
);

/** 7b. 阶段方案选项（★ 2026-10-16：班级表单的「阶段方案 / 阶段」两个下拉用） */
teachingClassRouter.get(
  '/scheme-options',
  wrap(async (req, res) => {
    res.json(ok(await svc.listSchemeOptions(req.user), '查询成功'));
  }),
);

/** 8. 统计卡片（口径与列表完全一致） */
teachingClassRouter.get(
  '/summary',
  wrap(async (req, res) => {
    res.json(ok(await svc.summaryClasses(queryOf(req), req.user), '查询成功'));
  }),
);

/** 9. 班级下拉（选班建班 / 转班用；已结业的班不返回） */
teachingClassRouter.get(
  '/options',
  wrap(async (req, res) => {
    res.json(ok(await svc.listClassOptions(req.user), '查询成功'));
  }),
);

/** 10. 生成班级编号（只有实训有；其它学段返回 null，前端应隐藏入口） */
teachingClassRouter.get(
  '/gen-code',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    res.json(ok({ classCode: await svc.genClassCodeFor(stage) }));
  }),
);

/* ============================================================
 * 11. 升实训（2026-10-20 批注）
 *   大学部的班 → 就业部（实训）：可选新班级名 / 就业部阶段方案 /
 *   项目经理 / 就业老师；不再有班主任、教员、助教；整班学生一起转过去。
 *   口径与实现细节见 class/training.ts 头部。
 * ============================================================ */
teachingClassRouter.post(
  '/training-upgrade',
  wrap(async (req, res) => {
    const b = req.body || {};
    const r = await trainingSvc.upgradeClassToTraining(
      {
        classId: requireId(b.classId),
        className: str(b.className),
        phaseCode: numOrUndef(b.phaseCode),
        projectManagerId: str(b.projectManagerId),
        projectManagerName: str(b.projectManagerName),
        employmentTeacherId: str(b.employmentTeacherId),
        employmentTeacherName: str(b.employmentTeacherName),
        remark: strOrNull(b.remark) ?? null,
      },
      req.user,
    );
    res.json(ok(r, `已升实训：${r.targetClassName}（${r.classCode}），转入 ${r.moved} 人`));
  }),
);