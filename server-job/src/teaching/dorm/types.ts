/**
 * 宿舍域 · 仓储契约
 * ============================================================
 *
 * 【第 4 期第 1 批（2026-10-10）· 三学段已合并成一份实现】
 *   斌哥拍板：「初高中、大学、实训都在一个界面，那就都采用实训那套就行」
 *   → 只剩 `repo.uni.ts` 一个文件，`makeRepo(stage)` 生成三份实例：
 *       jh    → makeRepo('jh')
 *       class → makeRepo('class')
 *       job   → makeRepo('job')
 *   → 旧的三份实现（repo.classJh / repo.class / repo.job）已下线，
 *     备份在 `_p4-b1-backup/*.ts.bak`（改名 .bak 是为了不被 tsc 扫到）。
 *
 *   三学段落同一张统一表（切读打开时）：
 *       房间   t_uni_dorm_room
 *       床位   t_uni_dorm_bed
 *       换宿单 t_uni_dorm_change
 *     靠 `edu_stage` 区分学段，字段完全一致 —— 所以本契约不再是「三种实现对齐」，
 *     而是「一份实现满足三份契约」，改动一处三学段同时生效。
 */

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

/**
 * ★ 2026-10-21：办理入住时的学生候选
 *
 * 数据范围与房间列表同源（班主任 = 自己的班），默认只给**还没入住**的学生，
 * 避免把已住学生的床位重复占用。
 */
export interface DormCandidateRow {
  stage: TeachingStage;
  studentId: string;
  studentNo: string;
  studentName: string;
  gender: number;
  classId: string | null;
  className: string | null;
  /** 已入住时的宿舍号（本次候选默认都是 null） */
  dormNo: string | null;
}

export interface DormRepo {
  readonly stage: TeachingStage;
  meta(): DormStageMeta;

  /**
   * 房间列表（**已按数据范围过滤**；分页由适配器统一做）
   *
   * ⚠️ 数据范围各学段原样保留：
   *   初高 → 班级 ID 白名单；大学 → applyDataScope；实训 → 角色判定
   */
  list(q: DormListQuery, user: any): Promise<DormRow[]>;
  detail(id: string, user: any): Promise<DormRow | null>;
  save(body: DormSaveBody, userId: string): Promise<{ id: string }>;
  remove(id: string, userId: string): Promise<void>;

  /**
   * ★ 按「楼层数 × 每层房间数」批量生成房间（2026-10-19）
   *   房号 = 楼层 + 两位序号（1 楼第 8 间 = 108）→ 与 /save 的 3 位数字校验同口径。
   *   幂等：已存在 → skipped；软删行 → 复活（uk_dorm_no 被软删行占着，不能重建）。
   */
  generateRooms(input: {
    buildingName: string;
    dormType: number;
    floorCount: number;
    roomsPerFloor: number;
    bedPerRoom: number;
    userId: string;
  }): Promise<{ created: number; revived: number; skipped: number }>;

  /** 床位列表（含在住学生）—— 三学段取数方式完全不同，见文件头说明 */
  beds(dormId: string, user: any): Promise<DormBedRow[]>;
  /** 在住学生名单（跨房间） */
  residents(q: DormListQuery, user: any): Promise<DormResidentRow[]>;
  /** 办理入住时的学生候选（按数据范围过滤，默认排除已入住） */
  candidates(q: { keyword?: string; limit?: number }, user: any): Promise<DormCandidateRow[]>;
  /** 分派床位（学生入住） */
  assign(body: DormAssignBody, userId: string): Promise<void>;
  /** 退宿（直接生效，管理员纠错用，不走审批） */
  checkout(dormId: string, bedId: string, userId: string): Promise<void>;

  /** 楼栋下拉（三学段各自聚合） */
  buildings(user: any): Promise<Array<{ value: string; label: string }>>;

  /** 调宿/退宿申请 */
  changeList(q: DormListQuery, user: any): Promise<DormChangeRow[]>;
  changeCreate(body: DormChangeCreateBody, userId: string): Promise<{ id: string }>;
  /** ★ 2026-10-21：审批通过 / 驳回（通过时同步床位与学生主档） */
  changeApprove(changeId: string, userId: string): Promise<void>;
  changeReject(changeId: string, reason: string, userId: string): Promise<void>;
  /** 审批通过后的落库动作（换床 / 释放床位），各学段表不同 */
  applyChangeOnApproved(changeId: string, userId: string): Promise<void>;

  summary(q: DormListQuery, user: any): Promise<DormSummary>;
}
