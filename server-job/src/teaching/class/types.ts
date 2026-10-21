/**
 * 班级信息域 · 仓储契约
 * ============================================================
 *
 * 【为什么要有这个文件】
 *   和学生档案域同构：适配器（service.ts）要把三个学段当成同一个东西调度，
 *   所以每个仓储必须提供**同一组签名**。签名写在契约里，
 *   哪个仓储少实现一个方法，`tsc` 立刻报错 —— 不靠人肉记。
 *
 * 【三个仓储各自的库 / 表】
 *   repo.classJh.ts → sms_class_jh.t_class_info  （class-jh 的 db）
 *   repo.class.ts   → sms_class.t_class_info     （class 的 db）
 *   repo.job.ts     → sms_job.t_job_class        （主 db）
 *
 * 【★ 「班级↔学生」的关联方式三套不同（本域第二个坑）】
 *   实训 t_job_class_student ：**独立花名册表**（有入班方式/离班日期/在班状态）
 *   大学 t_class_student    ：学生表上直接挂 class_id，按 class_id 查即可
 *   初高 t_class_student    ：同上（但初高花名册在 student.route 里另有逻辑）
 *   → 统一成同一个 `roster()` 契约，各仓储自己实现取数方式。
 */

import type {
  ClassListQuery,
  ClassRosterRow,
  ClassRow,
  ClassSaveBody,
  ClassStageMeta,
  ClassSummary,
  ClassStage,
} from '../shared/dto';

export interface ClassRepo {
  /** 本仓储对应的学段 */
  readonly stage: ClassStage;
  /** 学段内阶段码可选项 */
  phaseOptions(): Promise<Array<{ value: number; label: string }>>;
  /** 该学段的特性（有没有编号 / 结业日期 / 封班按钮） */
  meta(): ClassStageMeta;

  /**
   * 列表（**已按数据范围过滤**；分页由适配器统一做，这里返回全量）
   *
   * ⚠️ 数据范围逻辑**各学段原样保留**（口径不一致 = 数据越权）：
   *    · 实训 → 角色判定（校长/学管/管理员全量；项目经理限自己带的班）
   *    · 大学 → applyDataScope（dataScope: ALL/DEPT/CLASS/SELF）
   *    · 初高 → buildClassScope + getScopedClassIds（班主任/教员/助教命中任一岗位列）
   */
  list(q: ClassListQuery, user: any): Promise<ClassRow[]>;
  /** 详情（含花名册 + 可执行动作） */
  detail(id: string, user: any): Promise<ClassDetail | null>;
  /** 新增 / 修改 */
  save(body: ClassSaveBody, userId: string): Promise<{ id: string }>;
  /** 逻辑删除 */
  remove(id: string, userId: string): Promise<void>;
  /** 花名册（统一结构） */
  roster(id: string, user: any): Promise<ClassRosterRow[]>;
  /** 改状态（走统一状态机校验） */
  changeStatus(id: string, to: number, userId: string): Promise<void>;
  /** 统计（口径与列表一致） */
  summary(q: ClassListQuery, user: any): Promise<ClassSummary>;
}

/** 详情 = 班级行 + 花名册 + 可执行动作 */
export interface ClassDetail {
  base: ClassRow;
  roster: ClassRosterRow[];
  /** 当前状态下允许流转到的目标状态（前端据此渲染下拉） */
  allowedStatus: number[];
  /** 该学段特有列（本域暂无，三个仓储都返回 null；留给后续扩展） */
  extra: Record<string, unknown> | null;
}