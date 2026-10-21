/**
 * 宿舍适配器（Adapter）
 * ============================================================
 *
 * 【与班级域的关键差异】
 *   ① **三学段共用一份仓储实现**（repo.uni.ts 的 makeRepo(stage)）
 *      —— 斌哥 2026-10-10 拍板：「初高中、大学、实训都在一个界面，
 *      那就都采用实训那套就行」。原先的 repo.classJh.ts（初高 varchar 状态机）、
 *      repo.class.ts（大学只读同步表）两份实现**已下线**，不再维护。
 *      「大学是教务同步的只读数据」这个设定作废：两张同步表实测均为 0 行，
 *      大学宿舍页面本来就是空的。现在三学段一样，数据自己录入，教务要读就读。
 *   ② **审批链统一用实训那套**（斌哥 2026-10-09 拍板，行为变更）：
 *      初高/大学原来的简易 3 态（apply_status 1待审核/2已同意/3已驳回）
 *      只用于**读旧单据**，新单据一律走 t_job_approval 通用审批链。
 *
 *
 * 【权限码 = 合并前各学段原页面的权限码，一个都没改】
 *   jh classjh:dorm:view / class class:dorm:view / job job:dorm:view
 */

import { BizCode, hasRole, RoleCode } from 'shared-types';
import { BizError } from '../../middleware/errorHandler';
import { makeRepo } from './repo.uni';
import type {
  DormAssignBody,
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
import { TEACHING_STAGES, TEACHING_STAGE_NAME, DORM_CATEGORY_NAME } from '../shared/dto';
import {
  DORM_BED_PER_ROOM_DEFAULT,
  DORM_BED_PER_ROOM_MAX,
  DORM_FLOOR_MAX,
  DORM_GEN_ROOM_MAX,
  DORM_ROOMS_PER_FLOOR_MAX,
} from '../shared/dto';
import { assertStageCode, visibleStagesBy } from '../shared/stageAccess';
import { USE_UNI_TABLE } from '../shared/uniTable';
import type { DormCandidateRow, DormRepo } from './types';

/**
 * ★★ 同一房间被多个学段查出来时，**保留哪个学段的行**（2026-10-19）
 *
 * 【症状】删掉「学段」筛选框之后，新增 1 个房间，列表里出现 3 个。
 *
 * 【根因】`mergedRows` 在没有指定 stage 时，会把「当前用户可见的每个学段」各查一遍；
 *   而宿舍域三学段**共用同一份仓储实现**（`repo.uni.ts` 的 `makeRepo(stage)`，
 *   `DORM_T` 恒为 `t_job_dorm`、库恒为 `sms_job`）——
 *   老表模式下 `tbl()` 一律落到 `sms_job.t_job_dorm`，三个学段查的是**同一批物理行**。
 *   以前前端默认带 `stage` 参数、只走一个学段，这个重复一直没暴露；
 *   学段筛选框一删 → `q.stage` 恒为空 → 三学段全查 → 房间 ×3。
 *
 * 【为什么保留 job】新增房间固定写 job 学段（DEFAULT_DORM_STAGE），
 *   保留 job 那行才能保证「编辑 / 删除回传的 stage」与「写入时的 stage」一致。
 */
const STAGE_KEEP_PRIORITY: TeachingStage[] = ['job', 'class', 'jh'];

/**
 * 按 dormId 去重（兜底）
 *
 * 【为什么不能只靠「少查几个学段」】切读打开后（TEACHING_UNI_TABLE=1）统一表靠
 *   `edu_stage` 区分学段，那时三学段是**不同数据**，必须都查再合并。
 *   → 保留「都查 + 去重」这条兜底路径：统一表模式下 dormId 是全球唯一 UUID，
 *     去重是幂等的，不会误伤。
 */
function dedupRooms(rows: DormRow[]): DormRow[] {
  const byId = new Map<string, DormRow>();
  for (const r of rows) {
    const cur = byId.get(r.dormId);
    if (!cur) {
      byId.set(r.dormId, r);
      continue;
    }
    if (STAGE_KEEP_PRIORITY.indexOf(r.stage) < STAGE_KEEP_PRIORITY.indexOf(cur.stage)) {
      byId.set(r.dormId, r);
    }
  }
  return [...byId.values()];
}

/**
 * 在住学生按「学生 + 房间 + 床位」去重（兜底，理由同 dedupRooms）
 *
 * 不去重的话，床位抽屉里同一个学生会被列出 3 遍。
 */
function dedupResidents(rows: DormResidentRow[]): DormResidentRow[] {
  const byKey = new Map<string, DormResidentRow>();
  for (const r of rows) {
    const key = `${r.studentId}|${r.dormId}|${r.bedId}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, r);
      continue;
    }
    if (STAGE_KEEP_PRIORITY.indexOf(r.stage) < STAGE_KEEP_PRIORITY.indexOf(cur.stage)) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}

/**
 * ★ 三学段各生成一个实例（只有 edu_stage 不同），但**实现是同一份代码**
 *   斌哥 2026-10-10 拍板：「初高中、大学、实训都在一个界面，那就都采用实训那套就行」
 */
const REPOS: Record<TeachingStage, DormRepo> = {
  jh: makeRepo('jh'),
  class: makeRepo('class'),
  job: makeRepo('job'),
};

const CODES: Record<TeachingStage, string> = {
  jh: 'classjh:dorm:view',
  class: 'class:dorm:view',
  job: 'job:dorm:view',
};

const LABEL = '宿舍管理';

export function assertStageView(user: any, stage: TeachingStage): Promise<void> {
  return assertStageCode(user, stage, CODES, LABEL);
}

export function visibleStages(user: any): Promise<TeachingStage[]> {
  return visibleStagesBy(user, CODES, LABEL);
}

function pick(stage: TeachingStage): DormRepo {
  const r = REPOS[stage];
  if (!r) throw new BizError(BizCode.PARAM_ERROR, `stage 只能是 jh / class / job`);
  return r;
}

export function assertStage(v: unknown): TeachingStage {
  if (v !== 'jh' && v !== 'class' && v !== 'job') {
    throw new BizError(BizCode.PARAM_ERROR, 'stage 只能是 jh / class / job');
  }
  return v;
}

/**
 * 写操作守卫：三学段现在都可写（`hasCreate` 恒为 true），
 * 这里保留是为了将来若某学段要设只读，只改 meta() 一处即可，不用改适配器。
 */
function assertWritable(stage: TeachingStage): void {
  if (!REPOS[stage].meta().hasCreate) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `${TEACHING_STAGE_NAME[stage]}的宿舍数据不允许在这里新增/修改/删除`,
    );
  }
}

/* ============================================================
 * 房间列表
 * ============================================================ */

/**
 * ★ 关键字匹配：把一行宿舍「拍平」成能搜的文本（2026-10-18）
 *
 * 取的是**列表上显示出来的值**，不是库里的原始列 —— 这样用户在屏幕上看到
 * 「男寝」「停用」就能搜「男寝」「停用」；看到「3/4」也能搜「3/4」。
 * 反过来若取原始列，dorm_gender=1、room_status=1 这种 int 码，
 * 用户搜「男寝」永远命中不了。
 *
 * 入住率两种写法都收（"50" 和 "50%"），因为列表里显示成「50%」，
 * 用户很可能连百分号一起复制进来搜。
 */
function searchTextOf(r: DormRow): string {
  /**
   * ★ 类别的取法必须和列表显示**完全一致**（前端 categoryName 是
   *   `DORM_CATEGORY_NAME[dormType] ?? dormTypeName`），否则列表显示「男寝」、
   *   后端却按「男生宿舍」建索引，用户搜「男寝」永远 0 条。
   */
  const category = DORM_CATEGORY_NAME[r.dormType] ?? r.dormTypeName ?? '不限';
  return [
    category,
    r.buildingName,
    r.roomNo,
    `${r.occupiedCount}/${r.bedCount}`,
    `${r.occupancyRate}%`,
    r.roomStatusName,
    r.remark ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/** 关键字 + 入住率：两个都是「算出来/翻译出来」的，只能内存过滤 */
function applyRowFilters(rows: DormRow[], q: DormListQuery): DormRow[] {
  let out = rows;
  const kw = String(q.keyword ?? '').trim().toLowerCase();
  if (kw) out = out.filter((r) => searchTextOf(r).includes(kw));
  if (q.occupancyRate !== undefined && q.occupancyRate !== null) {
    out = out.filter((r) => Number(r.occupancyRate) === Number(q.occupancyRate));
  }
  return out;
}

async function mergedRows(
  q: DormListQuery,
  user: any,
): Promise<{ rows: DormRow[]; stages: TeachingStage[] }> {
  let stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有宿舍管理的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  /**
   * ★★ 老表模式下只查一个学段（2026-10-19）
   *
   * 宿舍域三学段共用同一份实现，`tbl()` 在开关关闭时一律落到 `sms_job.t_job_dorm`
   * —— 查三次得到的是**同一批行**，查出来的房间会变成 3 份（见 STAGE_KEEP_PRIORITY 的说明）。
   * 这里直接只查一个学段：结果一致，还省掉 2/3 的 SQL。
   *
   * 【为什么切读打开时不能这么做】统一表 `t_uni_dorm_room` 靠 `edu_stage` 区分学段，
   *   那时三学段是不同数据，必须都查 —— 所以这个优化只在开关关闭时生效，
   *   开关打开时仍走「全查 + dedupRooms 兜底」。
   *
   * 【优先取 job】新增房间固定写 job 学段，列表行的 stage 与写入学段一致才不会错位。
   */
  if (!q.stage && !USE_UNI_TABLE && stages.length > 1) {
    stages = [STAGE_KEEP_PRIORITY.find((s) => stages.includes(s)) ?? stages[0]];
  }

  const parts = await Promise.all(stages.map((s) => REPOS[s].list(q, user)));
  let rows = dedupRooms(parts.flat());

  // ★ 关键字 / 入住率：在合并之后过滤（口径见 applyRowFilters）
  rows = applyRowFilters(rows, q);

  // 学段顺序固定（初高 → 大学 → 实训），再按楼栋 + 房间号排
  rows.sort((a, b) => {
    const sa = TEACHING_STAGES.indexOf(a.stage);
    const sb = TEACHING_STAGES.indexOf(b.stage);
    if (sa !== sb) return sa - sb;
    if (a.buildingName !== b.buildingName) {
      return a.buildingName.localeCompare(b.buildingName, 'zh-Hans-CN');
    }
    return a.roomNo.localeCompare(b.roomNo, 'zh-Hans-CN', { numeric: true });
  });
  return { rows, stages };
}

/**
 * ★ 入住率可选项：**实时从当前数据里算**，不写死档位
 *
 * 【为什么不写死 0/25/50/75/100 或「<50% / 50~80% / >80%」】
 *   入住率 = 已住/床位，取值完全取决于床位总数（4 床的房是 0/25/50/75/100，
 *   6 床的房是 0/17/33/50/67/83/100）。写死档位必然出现「选了 25% 却一条都没有」。
 *   → 直接从列表里去重：当前筛出来的房间有哪些入住率，下拉就给哪些。
 *
 * 【★ 为什么要先把 occupancyRate 摘掉再算】
 *   否则：先选 50% → 结果只剩 50% 的房 → 下拉里就只剩 50% 一项 →
 *   用户再也选不回其它值，等于把自己锁死在某个筛选里出不来。
 *   → 算选项时忽略「入住率」这个条件本身，但**保留楼栋/类别/状态/关键字**，
 *     于是选了「1号楼」之后，下拉只给 1号楼 真实存在的入住率 —— 这才是想要的联动。
 */
export async function listOccupancyRates(
  q: DormListQuery,
  user: any,
): Promise<Array<{ value: number; label: string }>> {
  const { rows } = await mergedRows({ ...q, occupancyRate: undefined }, user);
  const rates = [...new Set(rows.map((r) => Number(r.occupancyRate) || 0))].sort((a, b) => a - b);
  return rates.map((v) => ({ value: v, label: `${v}%` }));
}

export async function listDorms(
  q: DormListQuery,
  user: any,
): Promise<{ list: DormRow[]; total: number; page: number; size: number; stages: TeachingStage[] }> {
  const { rows, stages } = await mergedRows(q, user);
  const total = rows.length;
  const start = (q.page - 1) * q.size;
  return { list: rows.slice(start, start + q.size), total, page: q.page, size: q.size, stages };
}

export async function getDormDetail(
  stage: TeachingStage,
  id: string,
  user: any,
): Promise<DormRow | null> {
  await assertStageView(user, stage);
  return pick(stage).detail(id, user);
}

/** 床位（含在住学生） */
export async function listBeds(
  stage: TeachingStage,
  dormId: string,
  user: any,
): Promise<{ beds: Awaited<ReturnType<DormRepo['beds']>>; dorm: DormRow | null }> {
  await assertStageView(user, stage);
  const r = pick(stage);
  const [beds, dorm] = await Promise.all([r.beds(dormId, user), r.detail(dormId, user)]);
  return { beds, dorm };
}

/** 在住学生名单 */
export async function listResidents(
  q: DormListQuery,
  user: any,
): Promise<DormResidentRow[]> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有宿舍管理的访问权限');
  if (q.stage) await assertStageView(user, q.stage);

  // ★ 与 mergedRows 同理：老表模式下三学段查的是同一批行，只查一个学段（省 2/3 SQL）
  const scanStages =
    !q.stage && !USE_UNI_TABLE && stages.length > 1
      ? [STAGE_KEEP_PRIORITY.find((s) => stages.includes(s)) ?? stages[0]]
      : stages;

  const parts = await Promise.all(scanStages.map((s) => REPOS[s].residents(q, user)));
  return dedupResidents(parts.flat());
}

/** 办理入住的学生候选（按数据范围过滤；班主任只给自己的班） */
export async function listCandidates(
  stage: TeachingStage | undefined,
  keyword: string | undefined,
  user: any,
): Promise<DormCandidateRow[]> {
  const stages: TeachingStage[] = stage ? [stage] : await visibleStages(user);
  if (!stages.length) throw new BizError(BizCode.NO_OPERATION_PERMISSION, '没有宿舍管理的访问权限');
  if (stage) await assertStageView(user, stage);

  // 与 listResidents 同口径：老表模式三学段查同一批行，只扫一个学段
  const scanStages =
    !stage && !USE_UNI_TABLE && stages.length > 1
      ? [STAGE_KEEP_PRIORITY.find((s) => stages.includes(s)) ?? stages[0]]
      : stages;

  const parts = await Promise.all(scanStages.map((s) => REPOS[s].candidates({ keyword }, user)));
  const seen = new Set<string>();
  const out: DormCandidateRow[] = [];
  for (const r of parts.flat()) {
    const key = r.studentId || `${r.studentNo}|${r.studentName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.slice(0, 100);
}

/** 楼栋下拉（合并三学段，同名去重 —— 楼栋名只是个标签，不是实体） */
export async function listBuildings(
  stage: TeachingStage | undefined,
  user: any,
): Promise<Array<{ value: string; label: string }>> {
  const stages: TeachingStage[] = stage ? [stage] : await visibleStages(user);
  if (!stages.length) return [];
  if (stage) await assertStageView(user, stage);
  const parts = await Promise.all(stages.map((s) => REPOS[s].buildings(user)));
  const seen = new Set<string>();
  const out: Array<{ value: string; label: string }> = [];
  for (const p of parts) {
    for (const b of p) {
      if (!b.value || seen.has(b.value)) continue;
      seen.add(b.value);
      out.push(b);
    }
  }
  return out;
}

/** 元信息：只返回当前用户可见的学段 */
export async function listDormMeta(
  stage: TeachingStage | undefined,
  user: any,
): Promise<DormStageMeta[]> {
  const stages: TeachingStage[] = stage ? [stage] : await visibleStages(user);
  if (stage) await assertStageView(user, stage);
  return stages.map((s) => REPOS[s].meta());
}

/** 统计（口径与列表一致） */
export async function summaryDorms(q: DormListQuery, user: any): Promise<DormSummary[]> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) return [];
  if (q.stage) await assertStageView(user, q.stage);
  return Promise.all(stages.map((s) => REPOS[s].summary(q, user)));
}

/* ============================================================
 * 写操作
 * ============================================================ */

export async function saveDorm(body: DormSaveBody, user: any): Promise<{ id: string }> {
  await assertStageView(user, body.stage);
  assertWritable(body.stage);
  return pick(body.stage).save(body, user?.userId || '');
}

/* ============================================================
 * 按楼栋配置批量生成房间
 * ============================================================ */

/**
 * ★ 楼栋生成房间默认落到哪个学段
 *   统一表 `t_uni_dorm_room` 未启用（见 repo.uni.ts），实际在用的宿舍表是
 *   `sms_job.t_job_dorm`，与「宿舍管理 → 新增房间」写的是同一张表。
 *   → 楼栋设置里生成的房间，必须能在宿舍管理里看到、能编辑、能删。
 */
const DEFAULT_DORM_STAGE: TeachingStage = 'job';

export interface DormRoomGenBody {
  buildingName: string;
  /** 1 男寝 / 2 女寝（生成出来的房间 dorm_gender 就是这个值） */
  dormType: number;
  floorCount: number;
  roomsPerFloor: number;
  bedPerRoom?: number;
  stage?: TeachingStage;
}

/**
 * 由楼栋配置（楼层数 × 每层房间数 × 每间床位数）批量生成宿舍房间
 *
 * 【房号】楼层 + 两位序号 → 3 位数字（1 楼第 8 间 = 108、5 楼第 12 间 = 512）
 *
 * 【幂等】已存在 → 跳过；软删过 → 复活。所以「改配置后再保存」是安全的：
 *   楼从 5 层改成 6 层，只会补第 6 层，前 5 层原样不动。
 */
export async function generateRoomsForBuilding(
  body: DormRoomGenBody,
  user: any,
): Promise<{ created: number; revived: number; skipped: number; total: number }> {
  const stage = body.stage ?? DEFAULT_DORM_STAGE;
  /**
   * ★ 权限：有宿舍页权限的人按学段校验，纯「系统设置」入口的人放行
   *
   *   生成房间的入口是「系统设置 → 楼栋设置 → 新增楼栋」，那个页面的权限码是
   *   `classjh:setting:view`，**不一定有**宿舍管理的 `*:dorm:view`。
   *   如果这里无条件 assertStageView，管理员在设置页填完楼层点确定会被 403 挡住
   *   —— 而「新增楼栋自动生成房间」本来就是他在这个页面该做的事。
   *   → 所以：有宿舍权限的人仍按学段卡（防止跨学段乱写）；
   *     一个宿舍学段权限都没有的人 = 从设置页进来的，放行。
   */
  const visible = await visibleStages(user);
  if (visible.length && !visible.includes(stage)) {
    throw new BizError(
      BizCode.NO_OPERATION_PERMISSION,
      `没有${TEACHING_STAGE_NAME[stage]}宿舍管理的访问权限`,
    );
  }
  assertWritable(stage);

  const name = String(body.buildingName ?? '').trim();
  if (!name) throw new BizError(BizCode.PARAM_ERROR, '楼栋名称必填');

  const dormType = Number(body.dormType);
  if (dormType !== 1 && dormType !== 2) {
    throw new BizError(BizCode.PARAM_ERROR, '生成房间前必须先指定楼栋类别（男寝 / 女寝）');
  }

  const intOf = (v: unknown): number => {
    const n = Number(v);
    return Number.isInteger(n) ? n : NaN;
  };
  const floorCount = intOf(body.floorCount);
  const roomsPerFloor = intOf(body.roomsPerFloor);
  const bedPerRoom =
    body.bedPerRoom === undefined || body.bedPerRoom === null
      ? DORM_BED_PER_ROOM_DEFAULT
      : intOf(body.bedPerRoom);

  if (!Number.isInteger(floorCount) || floorCount < 1 || floorCount > DORM_FLOOR_MAX) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `楼层数必须是 1 ~ ${DORM_FLOOR_MAX} 之间的整数`,
    );
  }
  if (!Number.isInteger(roomsPerFloor) || roomsPerFloor < 1 || roomsPerFloor > DORM_ROOMS_PER_FLOOR_MAX) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `每层房间数必须是 1 ~ ${DORM_ROOMS_PER_FLOOR_MAX} 之间的整数`,
    );
  }
  if (!Number.isInteger(bedPerRoom) || bedPerRoom < 1 || bedPerRoom > DORM_BED_PER_ROOM_MAX) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `每间床位数必须是 1 ~ ${DORM_BED_PER_ROOM_MAX} 之间的整数`,
    );
  }
  const total = floorCount * roomsPerFloor;
  if (total > DORM_GEN_ROOM_MAX) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      `一次最多生成 ${DORM_GEN_ROOM_MAX} 间宿舍，当前配置会生成 ${total} 间；请分批配置`,
    );
  }

  const r = await pick(stage).generateRooms({
    buildingName: name,
    dormType,
    floorCount,
    roomsPerFloor,
    bedPerRoom,
    userId: user?.userId || '',
  });
  return { ...r, total };
}

export async function removeDorm(stage: TeachingStage, id: string, user: any): Promise<void> {
  await assertStageView(user, stage);
  assertWritable(stage);
  return pick(stage).remove(id, user?.userId || '');
}

export async function assignBed(body: DormAssignBody, user: any): Promise<void> {
  await assertStageView(user, body.stage);
  // ★ 大学床位是同步来的，只能走申请
  assertWritable(body.stage);
  return pick(body.stage).assign(body, user?.userId || '');
}

export async function checkoutBed(
  stage: TeachingStage,
  dormId: string,
  bedId: string,
  user: any,
): Promise<void> {
  await assertStageView(user, stage);
  assertWritable(stage);
  return pick(stage).checkout(dormId, bedId, user?.userId || '');
}

/* ============================================================
 * 调宿 / 退宿申请
 * ============================================================ */

export async function listDormChanges(
  q: DormListQuery,
  user: any,
): Promise<DormChangeRow[]> {
  const stages: TeachingStage[] = q.stage ? [q.stage] : await visibleStages(user);
  if (!stages.length) return [];
  if (q.stage) await assertStageView(user, q.stage);

  /**
   * ★ 2026-10-21 修「同一条申请显示 3 遍」：
   *   老表模式下三学段读的是**同一张** t_job_dorm_change，
   *   按 stages 逐个查就会把同一行返回三次（和当初 listResidents 的问题一模一样）。
   *   → 未开统一表时只扫一个学段；开了统一表才按学段分开查。
   */
  const scanStages =
    !q.stage && !USE_UNI_TABLE && stages.length > 1
      ? [STAGE_KEEP_PRIORITY.find((s) => stages.includes(s)) ?? stages[0]]
      : stages;

  const parts = await Promise.all(scanStages.map((s) => REPOS[s].changeList(q, user)));
  const seen = new Set<string>();
  const rows: DormChangeRow[] = [];
  for (const r of parts.flat()) {
    if (seen.has(r.changeId)) continue;
    seen.add(r.changeId);
    rows.push(r);
  }
  rows.sort((a, b) => {
    const sa = TEACHING_STAGES.indexOf(a.stage);
    const sb = TEACHING_STAGES.indexOf(b.stage);
    if (sa !== sb) return sa - sb;
    return (a.createTime || '') < (b.createTime || '') ? 1 : -1;
  });
  return rows;
}

/** 发起申请（三个学段都写自己的申请表，但状态口径统一成「待审批」） */
export async function createDormChange(
  body: DormChangeCreateBody,
  user: any,
): Promise<{ id: string }> {
  /**
   * ★ 2026-10-20：合并页的调宿弹窗已去掉「学段」选择。
   *
   * 请求里的 stage 只用于决定落哪套表；三学段共用同一批宿舍表（切读关闭时
   * 更是同一张物理表），所以**不能因为账号没有该学段权限就拒绝**。
   * → 优先用请求的学段；没权限时退回该账号**可见的第一个宿舍学段**；
   *   一个都没有才真正拒绝。
   */
  let stage = body.stage;
  try {
    await assertStageView(user, stage);
  } catch (e) {
    const list = await visibleStages(user);
    if (!list.length) throw e;
    stage = list[0];
    body = { ...body, stage };
  }
  if (body.bizType !== 1 && body.bizType !== 2) {
    throw new BizError(BizCode.PARAM_ERROR, '业务类型只能是 1 调换宿舍 / 2 退宿');
  }
  if (!body.changeReason || !body.changeReason.trim()) {
    throw new BizError(BizCode.PARAM_ERROR, '原因必填');
  }
  // ★ 2026-10-20：原因长度按字符数卡 100（前端 textarea 的 maxlength 能被绕过）
  if ([...body.changeReason.trim()].length > 100) {
    throw new BizError(BizCode.PARAM_ERROR, '原因不能超过 100 个字符');
  }
  if (!body.changeDate) {
    throw new BizError(BizCode.PARAM_ERROR, '日期必填');
  }
  // 换宿/退宿申请三学段都可提交（ rooms 可写，申请当然也可写）
  try {
    return await pick(stage).changeCreate(body, user?.userId || '');
  } catch (e) {
    // 仓储抛的业务错误（重复提交 / 床位被占 / 学生不存在）转成可读 40000
    if (e instanceof BizError) throw e;
    throw new BizError(BizCode.PARAM_ERROR, (e as Error).message || '提交失败');
  }
}

/**
 * ★ 2026-10-21：宿舍申请审批
 *
 * 谁能批：教务老师 / 校长 / 学管主任（学管主任本身就是审批角色）。
 * 班主任只发起，不审批 —— 前端「申请审批」页签也不会给班主任。
 */
function assertDormApprover(user: any): void {
  const roles: string[] = user?.roles ?? [];
  const ok =
    hasRole(roles, RoleCode.ACAD_STAFF) ||
    hasRole(roles, RoleCode.RM_PRINCIPAL) ||
    hasRole(roles, RoleCode.TEACH_DEAN);
  if (!ok) {
    throw new BizError(BizCode.NO_OPERATION_PERMISSION, '只有教务老师 / 校长 / 学管主任可以审批宿舍申请');
  }
}

export async function approveDormChange(
  stage: TeachingStage,
  changeId: string,
  user: any,
): Promise<void> {
  await assertStageView(user, stage);
  assertDormApprover(user);
  try {
    await pick(stage).changeApprove(changeId, user?.userId || 'system');
  } catch (e) {
    // 仓储抛的是普通 Error（申请不存在 / 不是待审批）→ 转成可读的参数错误
    throw new BizError(BizCode.PARAM_ERROR, (e as Error).message || '审批失败');
  }
}

export async function rejectDormChange(
  stage: TeachingStage,
  changeId: string,
  reason: string,
  user: any,
): Promise<void> {
  await assertStageView(user, stage);
  assertDormApprover(user);
  if (!reason || !reason.trim()) throw new BizError(BizCode.PARAM_ERROR, '驳回原因必填');
  try {
    await pick(stage).changeReject(changeId, reason.trim(), user?.userId || 'system');
  } catch (e) {
    throw new BizError(BizCode.PARAM_ERROR, (e as Error).message || '驳回失败');
  }
}
