/**
 * 统一宿舍接口 · /api/teaching/dorm/*
 * ============================================================
 *
 * 取代合并前的 10 + 11 + 19 = 44 个宿舍接口（三学段各一套，
 * 名字还都不一样：/building/list vs /room/page vs /page）。
 *
 * 【三个学段的入口是同一个，靠 stage 区分】
 *   jh 初高 / class 大学 / job 实训
 *
 * 【★★ 本域两个特殊约束（与前 7 个域不同）】
 *
 * ① **大学只读**（斌哥 2026-10-09 拍板）
 *    大学的房间/床位是从教务同步进 sms_common 两张表的，不是自己维护的。
 *    → /meta 下发 hasCreate=false，前端隐藏新建/编辑/删除按钮；
 *    → service.saveDorm / removeDorm / assignBed / checkoutBed 再抛一次，
 *      **双保险**（前端漏改也不会写脏数据）。
 *    → 但 /change/create（换宿/退宿申请）允许写。
 *
 * ② **审批链统一用实训那套**（同上拍板，行为变更）
 *    新单据的审批状态口径统一成 ApprovalStatus（1待提交/2待审批/4已通过/5已驳回/6已撤销）。
 *    初高/大学旧的 apply_status 三态只用于**读历史单据**，不再产生新数据。
 *
 * 老接口（/api/job/dorm、/api/class/dorm、/api/class-jh/dorm）
 * 一个都没删，随时可回退。
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { BizCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { ok, page as pageResp } from '../../utils/response';
import * as svc from './service';
import type { DormListQuery, TeachingStage } from '../shared/dto';
import { DORM_ROOM_NO_ANY_RE, UnifiedDormStatus } from '../shared/dto';

export const teachingDormRouter = Router();

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
/** null 与 undefined 都降级成 undefined（= 不修改），保护 NOT NULL 列 */
function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function reqStage(v: unknown): TeachingStage {
  return svc.assertStage(v);
}
function optStage(v: unknown): TeachingStage | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return svc.assertStage(v);
}
function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === true || v === 'true' || v === '1' || v === 1;
}
function dateStr(v: unknown): string {
  const s = str(v);
  if (!s) throw new BizError(BizCode.PARAM_ERROR, '日期必填');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BizError(BizCode.PARAM_ERROR, '日期格式应为 YYYY-MM-DD');
  }
  return s;
}
function requireId(v: unknown, label = '宿舍ID'): string {
  const s = str(v);
  if (!s) throw new BizError(BizCode.PARAM_ERROR, `缺少${label}`);
  return s;
}

/** 从 query 组装列表查询 */
function queryOf(req: Request): DormListQuery {
  return {
    stage: optStage(req.query.stage) as TeachingStage,
    building: str(req.query.building),
    dormType: numOrUndef(req.query.dormType),
    roomStatus: numOrUndef(req.query.roomStatus),
    keyword: str(req.query.keyword),
    occupancyRate: numOrUndef(req.query.occupancyRate),
    onlyVacant: bool(req.query.onlyVacant),
    page: int(req.query.page, 1),
    size: Math.min(int(req.query.size, 20), 200),
  };
}

/**
 * 14. 入住率可选项（实时从数据里去重，随其它筛选联动）
 *
 * 复用 queryOf 是为了让「楼栋=1号楼 → 只给 1号楼 真实存在的入住率」成立；
 * occupancyRate 本身会在 service 里被摘掉（见 listOccupancyRates 注释）。
 */
teachingDormRouter.get(
  '/occupancy-rates',
  wrap(async (req, res) => {
    res.json(ok(await svc.listOccupancyRates(queryOf(req), req.user), '查询成功'));
  }),
);

/** 1. 房间列表 */
teachingDormRouter.get(
  '/list',
  wrap(async (req, res) => {
    const r = await svc.listDorms(queryOf(req), req.user);
    res.json(pageResp(r.list, r.total, { page: r.page, size: r.size }));
  }),
);

/** 2. 房间详情 */
teachingDormRouter.get(
  '/detail',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = requireId(req.query.id);
    const d = await svc.getDormDetail(stage, id, req.user);
    if (!d) throw new BizError(BizCode.PARAM_ERROR, '宿舍不存在或无权访问');
    res.json(ok(d));
  }),
);

/** 3. 床位列表（含在住学生） */
teachingDormRouter.get(
  '/beds',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const dormId = requireId(req.query.dormId, '宿舍ID');
    res.json(ok(await svc.listBeds(stage, dormId, req.user), '查询成功'));
  }),
);

/** 4. 在住学生名单 */
teachingDormRouter.get(
  '/residents',
  wrap(async (req, res) => {
    res.json(ok(await svc.listResidents(queryOf(req), req.user), '查询成功'));
  }),
);

/**
 * 4.1 办理入住的学生候选（★ 2026-10-21）
 * 班主任只会拿到自己班、且还没入住的学生；教务/校长拿全量。
 */
teachingDormRouter.get(
  '/candidates',
  wrap(async (req, res) => {
    res.json(
      ok(
        await svc.listCandidates(optStage(req.query.stage), str(req.query.keyword) || undefined, req.user),
        '查询成功',
      ),
    );
  }),
);

/** 5. 楼栋下拉 */
teachingDormRouter.get(
  '/buildings',
  wrap(async (req, res) => {
    res.json(ok(await svc.listBuildings(optStage(req.query.stage), req.user), '查询成功'));
  }),
);

/** 6. 元信息（前端据此隐藏不适用按钮 —— 大学 hasCreate=false） */
teachingDormRouter.get(
  '/meta',
  wrap(async (req, res) => {
    res.json(ok(await svc.listDormMeta(optStage(req.query.stage), req.user), '查询成功'));
  }),
);

/** 7. 统计卡片 */
teachingDormRouter.get(
  '/summary',
  wrap(async (req, res) => {
    res.json(ok(await svc.summaryDorms(queryOf(req), req.user), '查询成功'));
  }),
);

/** 8. 保存（新增 / 修改）—— 大学会被 service 拦掉 */
teachingDormRouter.post(
  '/save',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    if (!String(b.buildingName ?? '').trim()) {
      throw new BizError(BizCode.PARAM_ERROR, '楼栋必填');
    }
    if (!String(b.roomNo ?? '').trim()) {
      throw new BizError(BizCode.PARAM_ERROR, '房间号必填');
    }
    /**
     * ★★ 新增房间的五条业务规则（和前端弹窗一一对应，后端必须再拦一次）
     *
     *   ① 宿舍号 = **3 位数字**，第 1 位是楼层、后 2 位是房号（如 308 = 3 楼 08 室）
     *      → 楼层不再单独存一列，房号本身就带楼层，改房号即改楼层，不会两处不一致。
     *   ② 类别（dorm_gender）只能是 **1 男寝 / 2 女寝**
     *      → 老数据的 0「不限」是历史遗留，新数据不允许再造（前端已经是二选一单选）。
     *   ③ 状态只能是 **1 使用中 / 4 停用**（统一码；实训原码 1/2 由 repo 翻译）
     *      → 「空置(2)」「维修(3)」不在本次口径内，传了直接拒，避免存进去显示不出来。
     *   ④ 备注 ≤ 50 个汉字（按**字符数**算，不是字节数 —— utf8mb4 下一个汉字是 1 个字符）
     *   ⑤ 床位数 1 ~ 50（大于 0、小于等于 50）—— 0 会让入住率除零
     *
     * 【为什么后端要重复校验】前端 el-form 的 rules 能被绕过（直接调接口 /
     *   改 DOM），而且 ① 这类规则一旦绕过，dorm_no 唯一键会存进「A-1-3O8」这种脏值。
     */
    const roomNo = String(b.roomNo ?? '').trim();
    /**
     * ★ 房号 = 楼层 + 两位序号，长度跟着楼层位数走（见 dto 的 `dormRoomNo()`）：
     *     ≤ 9 层 → 3 位（108）；≥ 10 层 → 4 位（1008）
     *   所以这里是 3~4 位，不是死板的 3 位。
     */
    if (!DORM_ROOM_NO_ANY_RE.test(roomNo)) {
      throw new BizError(
        BizCode.PARAM_ERROR,
        '宿舍号必须是 3~4 位数字：楼层 + 两位房号（如 308 = 3 楼 08 室，1008 = 10 楼 08 室）',
      );
    }
    const dormType = numOrUndef(b.dormType);
    if (dormType !== undefined && dormType !== 1 && dormType !== 2) {
      throw new BizError(BizCode.PARAM_ERROR, '类别只能选「男寝」或「女寝」');
    }
    // ★ 新建必须选（老数据的 0「不限」是历史遗留，新数据不允许再造）
    if (!b.id && dormType === undefined) {
      throw new BizError(BizCode.PARAM_ERROR, '请选择类别（男寝 / 女寝）');
    }
    const roomStatus = numOrUndef(b.roomStatus);
    if (
      roomStatus !== undefined &&
      roomStatus !== UnifiedDormStatus.IN_USE &&
      roomStatus !== UnifiedDormStatus.DISABLED
    ) {
      throw new BizError(BizCode.PARAM_ERROR, '房间状态只能选「使用中」或「停用」');
    }
    /**
     * ⑤ 床位数：1 ~ 50（大于 0、小于等于 50）
     *    → 0 会让入住率除零（入住率 = 已住 / 床位）；上限 50 是业务口径。
     *    → 前端 el-input-number 有 min/max，但那个能被绕过，后端必须再挡一次。
     */
    const bedCount = numOrUndef(b.bedCount);
    if (bedCount !== undefined && (!Number.isInteger(bedCount) || bedCount < 1 || bedCount > 50)) {
      throw new BizError(BizCode.PARAM_ERROR, '床位数必须是 1 ~ 50 之间的整数');
    }

    const remark = strOrNull(b.remark);
    if (remark !== undefined && remark !== null && [...remark].length > 50) {
      throw new BizError(BizCode.PARAM_ERROR, '备注不能超过 50 个字');
    }

    const r = await svc.saveDorm(
      {
        stage,
        id: str(b.id),
        buildingName: String(b.buildingName).trim(),
        roomNo,
        // ★ NOT NULL 列（floorNo / dormType / bedCount / roomStatus）一律 numOrUndef，
        //   传 null 会被降级成 undefined（= 不修改），避免 ER_BAD_NULL_ERROR
        floorNo: numOrUndef(b.floorNo),
        dormType: numOrUndef(b.dormType),
        bedCount: numOrUndef(b.bedCount),
        ownerName: strOrNull(b.ownerName),
        classId: strOrNull(b.classId),
        className: strOrNull(b.className),
        roomStatus: numOrUndef(b.roomStatus),
        remark: strOrNull(b.remark),
      },
      req.user,
    );
    res.json(ok(r, b.id ? '宿舍已更新' : '宿舍已创建'));
  }),
);

/** 9. 删除（逻辑删除）—— 大学会被 service 拦掉 */
teachingDormRouter.delete(
  '/delete',
  wrap(async (req, res) => {
    const stage = reqStage(req.query.stage);
    const id = requireId(req.query.id);
    await svc.removeDorm(stage, id, req.user);
    res.json(ok(null, '已删除'));
  }),
);

/** 10. 分派床位（学生入住）—— 大学会被 service 拦掉 */
teachingDormRouter.post(
  '/assign',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    await svc.assignBed(
      {
        stage,
        dormId: requireId(b.dormId, '宿舍ID'),
        bedId: requireId(b.bedId, '床位ID'),
        studentId: requireId(b.studentId, '学生ID'),
        checkInDate: str(b.checkInDate),
      },
      req.user,
    );
    res.json(ok(null, '入住成功'));
  }),
);

/** 11. 退宿（直接生效，管理员纠错用；正式退宿走 /change/create 审批） */
teachingDormRouter.post(
  '/checkout',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    await svc.checkoutBed(
      stage,
      requireId(b.dormId, '宿舍ID'),
      requireId(b.bedId, '床位ID'),
      req.user,
    );
    res.json(ok(null, '已退宿'));
  }),
);

/** 12. 调宿/退宿申请列表 */
teachingDormRouter.get(
  '/change/list',
  wrap(async (req, res) => {
    res.json(ok(await svc.listDormChanges(queryOf(req), req.user), '查询成功'));
  }),
);

/** 13. 发起调宿/退宿申请（三学段都允许，包括大学） */
teachingDormRouter.post(
  '/change/create',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    const bizType = Number(b.bizType);
    if (bizType !== 1 && bizType !== 2) {
      throw new BizError(BizCode.PARAM_ERROR, '业务类型只能是 1 调换宿舍 / 2 退宿');
    }
    const r = await svc.createDormChange(
      {
        stage,
        bizType,
        studentId: requireId(b.studentId, '学生ID'),
        oldDormId: strOrNull(b.oldDormId),
        oldBedId: strOrNull(b.oldBedId),
        newDormId: strOrNull(b.newDormId),
        newBedId: strOrNull(b.newBedId),
        changeDate: dateStr(b.changeDate),
        changeReason: String(b.changeReason ?? '').trim(),
      },
      req.user,
    );
    res.json(ok(r, '申请已提交，等待审批'));
  }),
);

/**
 * 13.1 审批通过（★ 2026-10-21）
 * 通过时同步改床位与学生主档：调宿 = 放旧床 + 占新床；退宿 = 放旧床 + 清空宿舍。
 */
teachingDormRouter.post(
  '/change/approve',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    await svc.approveDormChange(stage, requireId(b.id, '申请ID'), req.user);
    res.json(ok(null, '已通过，床位与学生宿舍已更新'));
  }),
);

/** 13.2 审批驳回（只改状态，不动床位） */
teachingDormRouter.post(
  '/change/reject',
  wrap(async (req, res) => {
    const b = req.body || {};
    const stage = reqStage(b.stage);
    await svc.rejectDormChange(stage, requireId(b.id, '申请ID'), String(b.reason ?? ''), req.user);
    res.json(ok(null, '已驳回'));
  }),
);
