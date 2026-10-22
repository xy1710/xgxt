/**
 * 数据范围中间件（教学管理初高）
 *
 * 作用：根据 req.user.dataScope 计算一个「班级过滤条件」，供列表接口叠加到 knex 查询上。
 *
 *   1 本人     —— 不过滤班级（由业务各自的「本人」语义处理，本模块暂不用于班级级过滤）
 *   2 本班级   —— head_teacher_id / teacher_id / assistant_id = 当前用户
 *   3 本部门   —— dept_code = 当前用户部门
 *   4 全部     —— 不过滤（DEV_MODE 假用户为 ALL）
 *
 * 用法：
 *   import { buildClassScope, applyClassScope } from '../middleware/dataScope';
 *   const scope = buildClassScope(req);
 *   const query = db(TABLE).where('is_deleted', false);
 *   applyClassScope(query, scope, 'class_id');   // 按班级维度过滤
 */

import { Request } from 'express';
import { DataScope } from 'shared-types/class-jh';
// ★ P4 切读层：`getScopedClassIds()` 原来是裸 `db(classTable)` ——
//   它被 `class-jh/routes/student.route.ts` 与 `teaching/student/repo.classJh.ts`
//   共用，而那两处**已经切读**（班级表 `sms_class_jh.t_class_info` 已归一）
//   → 这里若不切，开关打开后会绕过统一表、在白名单阶段就读老表。
//   旧签名不带库名，故新增可选参数（不传 = 保持原样，开关关时行为不变）。
import { tbl } from '../../teaching/shared/uniTable';
import type { TeachingStage } from '../../teaching/shared/dto';

/** 计算得到的班级数据范围 */
export interface ClassScope {
  /** 数据范围类型 */
  type: DataScope;
  /** 本班级：当前用户 ID（可能命中班主任/教员/助教任一字段） */
  userId?: string;
  /** 本部门：部门编码 */
  deptCode?: number;
  /** 是否为「本班级」范围（需要按班级表 join/子查询） */
  isClassScope: boolean;
}

/**
 * 根据当前登录用户计算班级数据范围。
 *
 * @param req Express 请求（需已过 authMiddleware）
 */
export function buildClassScope(req: Request): ClassScope {
  const user = req.user;
  // 未登录兜底：不过滤（正常不会走到，authMiddleware 已拦截）
  if (!user) return { type: DataScope.ALL, isClassScope: false };

  switch (user.dataScope) {
    case DataScope.CLASS:
      return { type: DataScope.CLASS, userId: user.userId, isClassScope: true };
    case DataScope.DEPT:
      return { type: DataScope.DEPT, deptCode: user.deptCode, isClassScope: false };
    case DataScope.SELF:
    case DataScope.ALL:
    default:
      return { type: user.dataScope ?? DataScope.ALL, isClassScope: false };
  }
}

/**
 * 把数据范围条件应用到 knex 查询上。
 *
 * @param query     knex 查询构造器（会被就地修改）
 * @param scope     由 buildClassScope 计算得出
 * @param classCol  班级字段列名（默认 class_id）
 * @param deptCol   部门字段列名（默认 dept_code）
 */
export function applyClassScope(
  query: any,
  scope: ClassScope,
  classCol = 'class_id',
  deptCol = 'dept_code',
): void {
  if (scope.type === DataScope.DEPT && scope.deptCode) {
    query.andWhere(deptCol, scope.deptCode);
  }
  // 「本班级」范围：需要按班级内角色过滤，交由具体路由用 classIds 子查询实现，
  // 这里仅做部门级过滤，班级级过滤通过 getScopedClassIds 获取白名单后叠加。
}

/**
 * 取「本班级」范围下当前用户可见的班级 ID 白名单。
 *
 * @param db        knex 实例
 * @param classTable 班级表名（老表名，如 `t_class_info`）
 * @param scope    由 buildClassScope 计算得出
 * @param dbName   ★ P4 切读层：班级表所在库（如 `sms_class_jh`）。
 *                 传了就走 `tbl()` → 开关打开时读统一表 `t_uni_class`；
 *                 不传 = 保持原样（开关关时两种写法产生同一条 SQL）。
 * @param stage    统一表 `edu_stage` 取值（传了 dbName 时必填），默认 `jh`
 * @returns 可见班级 ID 数组；范围为全部/部门时返回 null（表示不限制）
 */
export async function getScopedClassIds(
  db: any,
  classTable: string,
  scope: ClassScope,
  dbName?: string,
  stage: TeachingStage = 'jh',
): Promise<string[] | null> {
  if (!scope.isClassScope || !scope.userId) return null;
  const base = dbName
    ? tbl(db, dbName, classTable, stage)
    : db(classTable);
  const rows = await base
    .where('is_deleted', false)
    .andWhere((qb: any) => {
      qb.where('head_teacher_id', scope.userId)
        .orWhere('teacher_id', scope.userId)
        .orWhere('assistant_id', scope.userId);
    })
    .select('id');
  return rows.map((r: any) => r.id);
}
