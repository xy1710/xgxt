/**
 * 统一宿舍接口封装 · /api/teaching/dorm/*
 * ============================================================
 *
 * 与 class.ts 同构。前端**只认这里的类型**，
 * 不关心数据来自初高 / 大学 / 实训哪个库。
 *
 * 【★ 大学的特殊性】
 *   `/meta` 下发的 `hasCreate=false` —— 大学的宿舍是教务同步来的，
 *   前端据此隐藏新建/编辑/删除/分派按钮（后端还会再拦一次，双保险）。
 */

import { http } from '@/api/request';

export type DormStage = 'jh' | 'class' | 'job';

export const CLASS_DORM_STAGES: DormStage[] = ['jh', 'class', 'job'];

// ★ 2026-10-22 部门口径统一：对外只有「初高中 / 大学部 / 就业部」三个部门。
//   「实训」是就业部下的一个阶段（班级 dept_code=3），不是并列部门。
export const DORM_STAGE_NAME: Record<DormStage, string> = {
  jh: '初高部',
  class: '大学部',
  job: '就业部',
};

/** 统一房间状态 1 使用中 / 2 空置 / 3 维修 / 4 停用 */
export const DORM_STATUS_NAME: Record<number, string> = {
  1: '使用中',
  2: '空置',
  3: '维修',
  4: '停用',
};

export const DORM_STATUS_TAG: Record<number, 'success' | 'info' | 'warning' | 'danger'> = {
  1: 'success',
  2: 'info',
  3: 'warning',
  4: 'danger',
};

/** 宿舍性别限制 0 不限 / 1 男 / 2 女 */
export const DORM_GENDER_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 1, label: '男生宿舍' },
  { value: 2, label: '女生宿舍' },
];

/**
 * ★ 宿舍「类别」（2026-10-16 改版）
 *
 * 列表和新增房间统一叫「类别」，只有两个取值：1 男寝 / 2 女寝。
 * 与上面 `DORM_GENDER_OPTIONS`（0 不限 / 1 男生宿舍 / 2 女生宿舍）的区别：
 *   · DORM_GENDER_OPTIONS 是**底层枚举的全集**，库里历史数据还有 0「不限」，
 *     筛选器用它才能把老数据筛全；
 *   · DORM_CATEGORY_OPTIONS 是**新增房间时的可选范围** —— 二选一，没有「不限」。
 *   → 别把两个混用：新增时给了 0，后端会报「类别只能选男寝或女寝」。
 */
export const DORM_CATEGORY_OPTIONS = [
  { value: 1, label: '男寝' },
  { value: 2, label: '女寝' },
];

/** 类别 → 显示名（列表列、抽屉标签都读它，保证三处口径一致） */
export const DORM_CATEGORY_NAME: Record<number, string> = {
  1: '男寝',
  2: '女寝',
};

/**
 * ★ 房间状态只剩两档（2026-10-16 改版）
 *   1 使用中 / 4 停用 —— 列表筛选与新增房间都只给这两项。
 *   「空置(2)」「维修(3)」是其它学段历史口径，本次不对外开放，
 *   但 DORM_STATUS_NAME 仍保留全集，老数据才不会显示成空。
 */
export const DORM_ROOM_STATUS_OPTIONS = [
  { value: 1, label: '使用中' },
  { value: 4, label: '停用' },
];

/** ★ 备注长度上限（汉字个数，后端同口径校验，改这里记得同步后端） */
export const DORM_REMARK_MAX = 50;

/**
 * ★ 新增房间默认落在哪个学段
 *
 * 弹窗里已经没有「学段」选项了（列表三学段合并展示，让用户选学段是暴露实现细节），
 * 但宿舍在后端是**按学段分表**存的，saveDorm 必须带 stage 才知道写哪张表。
 * → 固定写实训（sms_job.t_job_dorm），当前实际在用的也是这张表；
 *   编辑时不要套用这个值，要沿用房间自己的 stage，否则等于把房间搬到另一张表。
 */
export const DEFAULT_DORM_STAGE: DormStage = 'job';

/**
 * ★ 床位数取值范围：1 ~ 50（大于 0，小于等于 50）
 *   下限 1 —— 0 张床的房间入住率会出现除零，且没有意义；
 *   上限 50 —— 业务上单间宿舍不会超过这个量级。
 *   后端 route.ts 同口径校验，改这里记得同步后端。
 */
export const DORM_BED_COUNT_MIN = 1;
export const DORM_BED_COUNT_MAX = 50;

/**
 * ★ 宿舍号规则：楼层 + 两位序号
 *   ≤ 9 层 → 3 位（1 楼第 8 间 = 108、5 楼第 12 间 = 512）
 *   ≥ 10 层 → 4 位（10 楼第 8 间 = 1008、50 楼第 12 间 = 5012）
 *   → 楼层是一位数就是 3 位、两位数就是 4 位，与后端 `dormRoomNo()` 同口径。
 */
export const DORM_ROOM_NO_RE = /^\d{3,4}$/;

/** 床位状态 1 空闲 / 2 已占用 / 3 停用 */
export const DORM_BED_STATUS_NAME: Record<number, string> = {
  1: '空闲',
  2: '已占用',
  3: '停用',
};

export const DORM_CHANGE_NAME: Record<number, string> = {
  1: '调换宿舍',
  2: '退宿',
};

/** 统一审批状态（与审批域同一套口径） */
export const DORM_APPROVAL_NAME: Record<number, string> = {
  1: '待提交',
  2: '待审批',
  3: '待校长',
  4: '已通过',
  5: '已驳回',
  6: '已撤销',
};

export const DORM_APPROVAL_TAG: Record<number, 'success' | 'info' | 'warning' | 'danger'> = {
  1: 'info',
  2: 'warning',
  3: 'warning',
  4: 'success',
  5: 'danger',
  6: 'info',
};

export interface DormRow {
  stage: DormStage;
  stageName: string;
  dormId: string;
  buildingName: string;
  roomNo: string;
  floorNo: number | null;
  dormType: number;
  dormTypeName: string;
  bedCount: number;
  occupiedCount: number;
  occupancyRate: number;
  roomStatus: number;
  roomStatusName: string;
  ownerName: string | null;
  className: string | null;
  remark: string | null;
}

export interface DormBedRow {
  bedId: string;
  bedNo: string;
  bedLabel: string;
  bedStatus: number;
  bedStatusName: string;
  studentId: string | null;
  studentNo: string | null;
  studentName: string | null;
  gender: number | null;
  checkInDate: string | null;
  className: string | null;
}

export interface DormResidentRow {
  /** 所属学段 */
  stage: DormStage;
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  genderName: string;
  dormId: string;
  roomNo: string;
  bedId: string;
  bedNo: string;
  bedLabel: string;
  checkInDate: string | null;
  classId: string | null;
  className: string | null;
}

export interface DormChangeRow {
  stage: DormStage;
  stageName: string;
  changeId: string;
  bizType: number;
  bizTypeName: string;
  studentId: string;
  studentNo: string | null;
  studentName: string | null;
  gender: number | null;
  phone: string | null;
  classId: string | null;
  className: string | null;
  headTeacherName: string | null;
  oldDormId: string | null;
  oldDormNo: string | null;
  oldBedNo: string | null;
  newDormId: string | null;
  newDormNo: string | null;
  newBedNo: string | null;
  changeDate: string;
  changeReason: string;
  approvalStatus: number;
  approvalStatusName: string;
  canApprove: boolean;
  canCancel: boolean;
  createTime: string | null;
}

export interface DormStageMeta {
  stage: DormStage;
  stageName: string;
  /** ★ 该学段能否新建/编辑房间（大学=false） */
  hasCreate: boolean;
  hasFloor: boolean;
  hasOwner: boolean;
  hasClass: boolean;
  hasRemark: boolean;
  /** 是否有独立床位表（大学=false，床位是虚拟编号） */
  hasBedTable: boolean;
  roomStatusIsInt: boolean;
}

export interface DormSummary {
  stage: DormStage;
  stageName: string;
  roomCount: number;
  bedCount: number;
  occupiedCount: number;
  occupancyRate: number;
  vacantBeds: number;
}

export interface DormQuery {
  stage?: DormStage;
  building?: string;
  dormType?: number;
  roomStatus?: number;
  keyword?: string;
  /** ★ 入住率（整数百分比，精确匹配）；可选项由 /occupancy-rates 实时下发 */
  occupancyRate?: number;
  onlyVacant?: boolean;
  page?: number;
  size?: number;
}

const BASE = '/api/teaching/dorm';

function qs(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    usp.append(k, String(v));
  });
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** 1. 房间列表 */
export async function listDorms(q: DormQuery) {
  const r = await http.get(`${BASE}/list${qs(q as Record<string, unknown>)}`);
  return r as unknown as {
    list: DormRow[];
    total: number;
    page: number;
    size: number;
  };
}

/** 2. 房间详情 */
export async function getDormDetail(stage: DormStage, id: string) {
  const r = await http.get(`${BASE}/detail${qs({ stage, id })}`);
  return r as unknown as DormRow;
}

/** 3. 床位列表（含在住学生） */
export async function getDormBeds(stage: DormStage, dormId: string) {
  const r = await http.get(`${BASE}/beds${qs({ stage, dormId })}`);
  return r as unknown as { beds: DormBedRow[]; dorm: DormRow | null };
}

/** 4. 在住学生名单 */
export async function listDormResidents(q: DormQuery) {
  const r = await http.get(`${BASE}/residents${qs(q as Record<string, unknown>)}`);
  return r as unknown as DormResidentRow[];
}

/**
 * 4.1 办理入住的学生候选（★ 2026-10-21）
 *
 * 后端按数据范围过滤：班主任只拿到自己班、且还没入住的学生；
 * 教务/校长拿全量。关键字对姓名 / 学号前后模糊。
 */
export interface DormCandidateRow {
  stage: DormStage;
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  classId: string | null;
  className: string | null;
  dormNo: string | null;
}

export async function listDormCandidates(q: { stage?: DormStage; keyword?: string }) {
  const r = await http.get(`${BASE}/candidates${qs(q)}`);
  return r as unknown as DormCandidateRow[];
}

/** 5. 楼栋下拉 */
export async function listDormBuildings(stage?: DormStage) {
  const r = await http.get(`${BASE}/buildings${qs({ stage })}`);
  return r as unknown as Array<{ value: string; label: string }>;
}

/** 6. 元信息 —— 前端靠它隐藏不适用按钮 */
export async function getDormMeta(stage?: DormStage) {
  const r = await http.get(`${BASE}/meta${qs({ stage })}`);
  return r as unknown as DormStageMeta[];
}

/** 7. 统计卡片 */
export async function getDormSummary(q: DormQuery) {
  const r = await http.get(`${BASE}/summary${qs(q as Record<string, unknown>)}`);
  return r as unknown as DormSummary[];
}

/** 8. 保存（新增/修改）—— 大学后端会拦 */
export async function saveDorm(body: Record<string, unknown>) {
  return http.post(`${BASE}/save`, body);
}

/** 9. 删除 —— 大学后端会拦 */
export async function deleteDorm(stage: DormStage, id: string) {
  return http.delete(`${BASE}/delete${qs({ stage, id })}`);
}

/** 10. 分派床位 —— 大学后端会拦 */
export async function assignBed(body: Record<string, unknown>) {
  return http.post(`${BASE}/assign`, body);
}

/** 11. 退宿（直接生效）—— 大学后端会拦 */
export async function checkoutBed(body: Record<string, unknown>) {
  return http.post(`${BASE}/checkout`, body);
}

/** 12. 调宿/退宿申请列表 */
export async function listDormChanges(q: DormQuery) {
  const r = await http.get(`${BASE}/change/list${qs(q as Record<string, unknown>)}`);
  return r as unknown as DormChangeRow[];
}

/** 13. 发起调宿/退宿申请（三学段都允许，含大学） */
export async function createDormChange(body: Record<string, unknown>) {
  return http.post(`${BASE}/change/create`, body);
}

/**
 * 13.1 审批通过（★ 2026-10-21）
 * 后端会同步改床位与学生主档：调宿 = 放旧床 + 占新床；退宿 = 放旧床 + 清宿舍。
 */
export async function approveDormChange(body: { stage: DormStage; id: string }) {
  return http.post(`${BASE}/change/approve`, body);
}

/** 13.2 审批驳回（只改状态，理由写 remark） */
export async function rejectDormChange(body: { stage: DormStage; id: string; reason: string }) {
  return http.post(`${BASE}/change/reject`, body);
}

/**
 * 14. 入住率可选项
 *
 * ★ 选项是**后端从当前数据里去重算出来的**，前端不写死档位。
 *   入住率 = 已住/床位，4 床房只会出 0/25/50/75/100，6 床房又是另一套 ——
 *   写死必然出现「选了却一条都没有」。
 *   每次 load 都重拉一次 → 改了床位、换了楼栋，下拉跟着变（需求要的「实时更新」）。
 */
export async function listDormOccupancyRates(q: DormQuery) {
  const r = await http.get(`${BASE}/occupancy-rates${qs(q as Record<string, unknown>)}`);
  return (r as unknown as Array<{ value: number; label: string }>) || [];
}
