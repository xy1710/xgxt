/**
 * ★ 阶段隔离 + 岗位责任人模型（斌哥 2026-10-04 拍板）
 *
 * ============================================================
 * 【责任人交棒模型】
 *   同一个班（编号不变），谁负责随阶段换人：
 *
 *     大学 1~6 阶段 → 班主任 + 教员 + 助教（sms_class.t_class_info 三岗）
 *     实训阶段      → 项目经理（t_job_class.project_manager，未结业的班）
 *     转就业后      → 就业指导老师（t_job_class.employment_teacher）
 *
 *   · 升实训 = 交棒①：原班主任三人组彻底看不见这个班
 *   · 转就业 = 交棒②：项目经理彻底交棒（已结业的班 PM 不再看）
 *   · 全程不受影响：学管（审批）、校长（全权）、管理员（全局只读）
 *
 * 【怎么判断"这是哪个阶段"】
 *   唯一依据是【班级所在的库】：
 *       大学阶段班级   → sms_class.t_class_info（阶段 201~206）
 *       实训/就业班级  → sms_job.t_job_class（阶段 13）
 *
 * 【角色怎么分】
 *   PROJECT_MANAGER（项目经理）→ 实训侧，只认自己 project_manager 的未结业班
 *   JOB_STAFF（就业指导老师）  → 实训侧，只认自己 employment_teacher 的班
 *   TEACH_HEAD / TEACH_TUTOR / TEACH_ASSIST → 大学侧，只认三岗是自己
 *   其他人（学管/校长/管理员/教务）→ 都能看（不隔离）
 */

import { RoleCode, ClassStatus, hasRole } from 'shared-types';
import { db } from './db';

/** 实训/就业阶段的班级 ID 前缀标记（我们库用 t_job_class） */
export type Stage = 'university' | 'training' | 'all';

/**
 * 判断某个角色属于哪一侧
 *
 * @returns 'training' = 项目经理/就业指导老师侧；'university' = 班主任侧；'all' = 不隔离
 */
export function stageOfRoles(roles: string[] | undefined): Stage {
  const r = roles || [];
  if (r.length === 0) return 'all';

  // ★ 万能测试号（SUPER_TEST）→ 一律「都看」。
  //   它是验证业务连通性用的，不该被数据范围挡住。
  //   （见 middleware/auth.ts 的 SUPER_TEST_USER）
  if (r.includes('SUPER_TEST')) return 'all';

  // 项目经理 / 就业指导老师 → 实训侧
  // ★ 2026-10-08：改用 hasRole（别名感知）—— 项目经理在权限库里是 RM_PROJECT
  if (hasRole(r, RoleCode.PROJECT_MANAGER) || hasRole(r, RoleCode.JOB_STAFF)) {
    return 'training';
  }

  // 班主任 / 教员 / 助教 → 大学侧
  // ⚠️ 只要带了这些角色，就按大学侧处理（不跟项目经理混）
  if (
    hasRole(r, RoleCode.TEACH_HEAD) ||
    hasRole(r, RoleCode.TEACH_TUTOR) ||
    hasRole(r, RoleCode.TEACH_ASSIST)
  ) {
    return 'university';
  }

  // 学管 / 校长 / 管理员 / 教务 → 都看
  return 'all';
}

/**
 * 取「我负责的实训/就业班级 ID 列表」（★ 岗位责任人模型）
 *
 *   项目经理       → project_manager 是我 且 班级未结业（转就业 = 彻底交棒）
 *   就业指导老师   → employment_teacher 是我（结业后归他管）
 *   班主任三人组   → 空（交棒后彻底看不见实训班）
 *   学管/校长等    → null（不限）
 */
export async function myTrainingClassIds(user: {
  userId: string;
  roles: string[];
}): Promise<string[] | null> {
  const stage = stageOfRoles(user.roles);
  if (stage === 'all') return null;
  if (stage === 'university') return [];   // 班主任不看实训 → 空
  if (!user.userId) return [];

  // ★ 2026-10-08：改用 hasRole（别名感知）—— 项目经理在权限库里是 RM_PROJECT，
  //   原来直接 includes(RoleCode.PROJECT_MANAGER) 恒 false，
  //   导致项目经理拿不到自己的实训班列表（isPM=false → isJob=false → 返回 []）。
  const isPM = hasRole(user.roles, RoleCode.PROJECT_MANAGER);
  const isJob = hasRole(user.roles, RoleCode.JOB_STAFF);
  if (!isPM && !isJob) return [];          // 其他角色不在实训侧兜任何数据

  try {
    const rows = (await db('t_job_class')
      .where('is_deleted', 0)
      .andWhere((q: any) => {
        if (isPM) {
          // 未结业的班归项目经理；已结业（转就业）= 已交棒给就业指导老师
          q.where('project_manager_id', user.userId)
            .andWhereNot('class_status', ClassStatus.GRADUATED);
        } else {
          q.where('employment_teacher_id', user.userId);
        }
      })
      .select('id')) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    // 查不到按「没有班」处理（数据范围最保守）
    return [];
  }
}

/**
 * 取「我负责的大学部班级 ID 列表」
 *
 * 数据源：sms_class.t_class_info
 * 返回 null = 不限
 */
export async function myUniversityClassIds(user: {
  userId: string;
  roles: string[];
}): Promise<string[] | null> {
  const stage = stageOfRoles(user.roles);
  if (stage === 'all') return null;
  if (stage === 'training') return [];    // 项目经理不看大学 → 空
  if (!user.userId) return [];
  try {
    const rows = (await db('sms_class.t_class_info')
      .where('is_deleted', 0)
      .andWhere((q: any) => {
        q.where('head_teacher_id', user.userId)
          .orWhere('teacher_id', user.userId)
          .orWhere('assistant_id', user.userId);
      })
      .select('id')) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/* ============================================================
 * ★ 下面是给各列表接口直接用的便捷函数
 *
 * 用法（一行接入）：
 *   await applyStageScope(query, req, {
 *     table: 't_job_class', column: 'class_id',
 *   });
 *
 * 它做什么：
 *   · 校验这个接口属于哪一侧（training / university）
 *   · 按当前角色算出「我负责的班级 ID 列表」
 *   · 把 `class_id IN (...)` 拼到 query 上
 *   · 不该看的角色直接 `whereRaw('1 = 0')`（查不到任何数据）
 * ============================================================ */

/** 从 req 里取出 { userId, roles }（各路由都有 getOperator，形状一样） */
export function operatorOf(req: any): { userId: string; roles: string[] } {
  const u = req?.user || {};
  /**
   * ★ 2026-10-15 修复：业务表责任人列（t_job_class.employment_teacher_id、
   *   project_manager_id、t_class_info.head_teacher_id 等）存的是【权限库用户 id】
   *   （如 U009），而门户 token 的 userId 是【门户账号 UUID】。直接拿 userId 比
   *   永远比不中，表现就是「就业老师 / 项目经理 / 班主任进去什么都看不到」。
   *   auth 中间件已把映射结果放在 req.user.businessUserId，这里优先用它，
   *   缺失时退回 userId（保持兼容）。
   */
  const effectiveUserId = u.businessUserId || u.userId || '';
  return { userId: effectiveUserId, roles: u.roles || [] };
}

/** 学生主档表（唯一同时挂着 class_id / dorm_id / student_id 的表） */
const STUDENT_TABLE = 't_student_base';

/**
 * ★ 被查表怎么「绕」到班级？（2026-10-04 就业侧两页踩坑后加）
 *
 *   direct（默认）= 被查表自己就有 class_id 列
 *                   → 直接 whereIn(`${table}.class_id`, ids)
 *
 *   student       = 被查表存的是 student_id（就业日志：日志挂在学生身上）
 *                   → whereIn(`${table}.student_id`,
 *                       选('id').from(t_student_base).whereIn('class_id', ids))
 *
 *   dorm          = 被查表是「房间」，学生主档的 dorm_id 指向它的主键
 *                   → whereIn(`${table}.id`,
 *                       选('dorm_id').from(t_student_base)
 *                         .whereIn('class_id', ids).whereNotNull('dorm_id'))
 *
 * ⚠️ 踩过的坑：早先只有一个默认值 'class_id'，于是「就业日志」「就业基地宿舍」
 *   这两张**设计上就不该有 class_id** 的表直接报 50002 字段不存在。
 *   凡是新表接隔离，先确认它属于上面哪一种，别硬套 class_id。
 */
export type TrainingScopeVia = 'direct' | 'student' | 'dorm';

export interface TrainingScopeOpts {
  /** 被查的表（带别名就写别名，如 'cs'） */
  table: string;
  /**
   * 被查表里用来「挂住」目标的列名：
   *   via=direct  → 默认 class_id
   *   via=student → 默认 student_id
   *   via=dorm    → 默认 id（房间主键）
   */
  column?: string;
  /** 关联方式，默认 direct */
  via?: TrainingScopeVia;
  /**
   * ★ 2026-10-16：额外放行「本人创建」的记录（要求被查表有 `create_by` 列）。
   *
   *   背景：就业日志的姓名改成可直接手填 → 姓名匹配不到学生时 `student_id` 为 NULL。
   *   若只按 `student_id IN (我班学生)` 过滤，**建单人自己反而看不到自己建的记录**。
   *   开启后条件变成：`<关联列> IN (我班...) OR create_by = 本人`。
   */
  ownCreatedBy?: boolean;
}

/**
 * 给「实训侧」查询加阶段隔离
 *
 * @param query  knex query builder
 * @param req    express request
 * @param opts   见 TrainingScopeOpts
 */
export async function applyTrainingScope(
  query: any,
  req: any,
  opts: TrainingScopeOpts,
): Promise<void> {
  const op = operatorOf(req);
  const stage = stageOfRoles(op.roles);

  // 班主任 / 教员 / 助教 → 不该看实训数据
  if (stage === 'university') {
    query.whereRaw('1 = 0');
    return;
  }
  // 学管 / 校长 / 管理员 → 不限
  if (stage === 'all') return;

  // 项目经理 → 只看我负责的班
  const ids = await myTrainingClassIds(op);
  if (ids && ids.length === 0) {
    query.whereRaw('1 = 0');   // 没带班 → 什么都看不到
    return;
  }
  if (!ids) return;             // null = 不限，上面已 return，这里是防御

  const via = opts.via || 'direct';
  const col = `${opts.table}.${opts.column || defaultColumnOf(via)}`;

  /** 按关联方式把「我负责的范围」条件挂到给定的 query builder 上 */
  const applyReach = (b: any) => {
    if (via === 'student') {
      // 本表存 student_id → 换成一串「我班上的学生 id」
      b.whereIn(
        col,
        db(STUDENT_TABLE).select('id').whereIn('class_id', ids).where('is_deleted', 0),
      );
      return;
    }
    if (via === 'dorm') {
      // 本表是房间 → 用「我班学生住过的房间 id」反查
      b.whereIn(
        col,
        db(STUDENT_TABLE)
          .select('dorm_id')
          .whereIn('class_id', ids)
          .whereNotNull('dorm_id')
          .where('is_deleted', 0),
      );
      return;
    }
    b.whereIn(col, ids);
  };

  // ★ 2026-10-16：手填姓名、未关联学生的记录（关联列为 NULL）也要让建单人自己看到，
  //   否则建完就"消失"了。
  //   ⚠️ 只额外放行「**没挂到任何目标上**」的本人记录 —— 挂了别的班学生的记录，
  //      仍然不该被本人看到（口径：老师只能看自己的班级）。
  if (opts.ownCreatedBy) {
    // ⚠️ create_by 里存的是【门户账号 UUID】(req.user.userId)，
    //    而 op.userId 是【权限库 id】(businessUserId)——两套 id 都放行，避免写法不同漏掉记录。
    const raw = req?.user?.userId || '';
    const mine = Array.from(new Set([op.userId, raw].filter(Boolean)));
    if (mine.length) {
      query.where((b: any) => {
        applyReach(b);
        b.orWhere((b2: any) => {
          b2.whereNull(col).whereIn('create_by', mine);
        });
      });
      return;
    }
  }

  applyReach(query);
}

/** 各关联方式下，被查表默认用哪一列去挂目标 */
function defaultColumnOf(via: TrainingScopeVia): string {
  if (via === 'student') return 'student_id';
  if (via === 'dorm') return 'id';
  return 'class_id';
}

/**
 * 给「大学侧」查询加阶段隔离
 *
 * @param query  knex query builder
 * @param req    express request
 * @param opts   table = 被查的表；column = 关联大学班级的列
 *                （t_class_student 用 class_id；t_class_grade 用 class_id）
 *
 * ⚠️ 同 applyTrainingScope：大学侧目前所有表都自带 class_id，
 *   所以不需要 via 子查询模式。若将来出现不带的表，照 TrainingScopeVia 补。
 */
export async function applyUniversityScope(
  query: any,
  req: any,
  opts: { table: string; column?: string },
): Promise<void> {
  const op = operatorOf(req);
  const stage = stageOfRoles(op.roles);

  // 项目经理 → 不该看大学数据
  if (stage === 'training') {
    query.whereRaw('1 = 0');
    return;
  }
  if (stage === 'all') return;

  // 班主任 / 教员 / 助教 → 只看我负责的班
  const ids = await myUniversityClassIds(op);
  if (ids && ids.length === 0) {
    query.whereRaw('1 = 0');
    return;
  }
  if (ids) {
    query.whereIn(`${opts.table}.${opts.column || 'class_id'}`, ids);
  }
}
