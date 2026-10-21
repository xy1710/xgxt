/**
 * 统一学生档案接口 · /api/teaching/student/*
 * ============================================================
 *
 * 取代合并前的 6 + 8 + 14 + 5 = 33 个学生接口（四个学段各一套，
 * 名字还不一样：/list vs /page、/add vs /create…）。
 *
 * 【四个学段的入口是同一个，靠 stage 区分】
 *   jh   初高 / class 大学 / job 就业 / edu 教务
 *
 * 【「全部」的语义】不传 stage = 合并当前账号可见的学段并按学号去重。
 *   这正是原来「教务」页提供的「全校总台账」能力（见 repo.edu.ts 头部说明）。
 *
 * 老接口（/api/job/student、/api/class/student、/api/class-jh/student、
 * /api/edu/student）一个都没删，随时可回退。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok, page as pageResp } from '../../utils/response';
import * as svc from './service';
import type { StudentStage } from '../shared/dto';
import { isStudentStage } from '../shared/dto';

export const teachingStudentRouter = Router();

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
function boolTrue(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}
function reqStage(v: unknown): StudentStage {
  if (!isStudentStage(v)) {
    throw new BizError(BizCode.PARAM_ERROR, 'stage 必填（jh / class / job / emp / edu）');
  }
  return v;
}
function optStage(v: unknown): StudentStage | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (!isStudentStage(v)) {
    throw new BizError(BizCode.PARAM_ERROR, 'stage 只能是 jh / class / job / emp / edu');
  }
  return v;
}
function dateStr(v: unknown): string | null | undefined {
  const s = strOrNull(v);
  if (s === undefined || s === null) return s;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BizError(BizCode.PARAM_ERROR, '日期格式应为 YYYY-MM-DD');
  }
  return s;
}

/** 1. 列表 */
teachingStudentRouter.get(
  '/list',
  wrap(async (req, res) => {
    const q = {
      stage: optStage(req.query.stage),
      classId: str(req.query.classId),
      deptCode: numOrUndef(req.query.deptCode),
      studentStatus: numOrUndef(req.query.studentStatus),
      phaseCode: numOrUndef(req.query.phaseCode),
      keyword: str(req.query.keyword),
      unassigned: boolTrue(req.query.unassigned),
      page: int(req.query.page, 1),
      size: Math.min(int(req.query.size, 20), 200),
    };
    const r = await svc.listStudents(q, req.user);
    res.json(pageResp(r.list, r.total, { page: r.page, size: r.size }));
  }),
);

/** 2. 详情 */
teachingStudentRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少学生ID');
    res.json(ok(await svc.getStudentDetail(stage, id, req.user)));
  }),
);

/** 3. 详情扩展区块（考试信息 / 调宿记录 / 宿舍长 —— 2026-10-15 详情分签改版） */
teachingStudentRouter.get(
  '/extras',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少学生ID');
    res.json(ok(await svc.getStudentExtras(stage, id, req.user)));
  }),
);

/** 4. 保存（新增 / 修改） */
teachingStudentRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const r = await svc.saveStudent(
      {
        stage,
        id: str(b.id),
        studentNo: str(b.studentNo),
        studentName: String(b.studentName ?? ''),
        gender: Number(b.gender ?? 0),
        birthDate: dateStr(b.birthDate),
        age: numOrUndef(b.age) ?? null,
        nativePlace: strOrNull(b.nativePlace),
        deptCode: numOrUndef(b.deptCode) ?? null,
        classId: strOrNull(b.classId),
        className: strOrNull(b.className),
        phaseCode: numOrUndef(b.phaseCode) ?? null,
        studentStatus: numOrUndef(b.studentStatus),
        education: strOrNull(b.education),
        graduateSchool: strOrNull(b.graduateSchool),
        enrollDate: dateStr(b.enrollDate),
        phone: strOrNull(b.phone),
        parentName: strOrNull(b.parentName),
        parentPhone: strOrNull(b.parentPhone),
        homeAddress: strOrNull(b.homeAddress),
        idCard: strOrNull(b.idCard),
        recruitTeacherName: strOrNull(b.recruitTeacherName),
        recruitTeacherPhone: strOrNull(b.recruitTeacherPhone),
        consultTeacherName: strOrNull(b.consultTeacherName),
        consultTeacherPhone: strOrNull(b.consultTeacherPhone),
        dormId: strOrNull(b.dormId),
        dormNo: strOrNull(b.dormNo),
        bedNo: strOrNull(b.bedNo),
        netAccount: strOrNull(b.netAccount),
        netInitPassword: strOrNull(b.netInitPassword),
        remark: strOrNull(b.remark),
        extra: b.extra && typeof b.extra === 'object' ? b.extra : null,
        syncFreeze: b.syncFreeze === undefined ? undefined : boolTrue(b.syncFreeze),
      },
      req.user,
    );
    // 教务学段的冻结联动要如实回报（原实现就把这个条数写进了提示语）
    let tip = b.id ? '学生已更新' : '学生已创建';
    if (r.frozenCount) tip += `，已同步冻结 ${r.frozenCount} 条缴费记录`;
    else if (r.unfrozenCount) tip += `，已同步解冻 ${r.unfrozenCount} 条缴费记录`;
    res.json(ok(r, tip));
  }),
);

/** 4. 删除（逻辑删除） */
teachingStudentRouter.delete(
  '/delete',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = str(req.query.id);
    if (!id) throw new BizError(BizCode.PARAM_ERROR, '缺少学生ID');
    await svc.removeStudent(stage, id, req.user);
    res.json(ok(null, '已删除'));
  }),
);

/** 5. 元信息（各学段阶段码选项 / 特有区块） */
teachingStudentRouter.get(
  '/meta',
  wrap(async (req, res) => {
    res.json(ok(await svc.listStageMeta(req.user), '查询成功'));
  }),
);

/** 6. 统计卡片（口径与列表完全一致：同一套筛选 + 同一套去重） */
teachingStudentRouter.get(
  '/summary',
  wrap(async (req, res) => {
    const q = {
      stage: optStage(req.query.stage),
      classId: str(req.query.classId),
      deptCode: numOrUndef(req.query.deptCode),
      studentStatus: numOrUndef(req.query.studentStatus),
      phaseCode: numOrUndef(req.query.phaseCode),
      keyword: str(req.query.keyword),
      unassigned: boolTrue(req.query.unassigned),
      page: 1,
      size: 20,
    };
    res.json(ok(await svc.summaryStudents(q, req.user), '查询成功'));
  }),
);

/** 7. 班级下拉（四学段合并；教务的班级来自学生表去重） */
teachingStudentRouter.get(
  '/classes',
  wrap(async (req, res) => {
    res.json(ok(await svc.listStudentClasses(req.user), '查询成功'));
  }),
);

/** 8. 升云 · 目标班级（大学部 + 状态=开放；2026-10-20 批注） */
teachingStudentRouter.get(
  '/upgrade-targets',
  wrap(async (req, res) => {
    res.json(ok(await svc.listUpgradeTargets(req.user), '查询成功'));
  }),
);

/**
 * 9. 升云（初高部 → 大学部开放班级，批量）
 *
 * body: { studentIds: string[], targetClassId: string, remark?: string }
 * 只适用于初高部学生 → 前端按钮只在该场景出现；后端仍按两个学段权限 + 班级状态兜底校验。
 */
teachingStudentRouter.post(
  '/upgrade-cloud',
  wrap(async (req, res) => {
    const b = req.body || {};
    const studentIds = Array.isArray(b.studentIds) ? b.studentIds.map((x: unknown) => String(x)) : [];
    const r = await svc.upgradeToUniversity(
      {
        studentIds,
        targetClassId: str(b.targetClassId),
        remark: strOrNull(b.remark) ?? null,
      },
      req.user,
    );
    const tip = `已升云 ${r.moved} 人 → ${r.toClassName}`;
    res.json(ok(r, r.skipped.length ? `${tip}，${r.skipped.length} 人未处理` : tip));
  }),
);
