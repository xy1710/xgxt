/**
 * 阶段名称查询（教学管理初高）· ★ 2026-10-16 阶段字典改「阶段方案」后新增
 *
 * 背景：
 *   以前阶段名直接查 shared-types 的 STAGE_NAME 常量（101~107 / 201~204 写死）。
 *   改成「阶段方案」后，用户自己新增的方案/阶段会拿到新的 stage_code（如 108、205），
 *   常量表里没有 → 班级/学生列表的「阶段」列会显示空白。
 *
 * 所以这里改成【优先读表 t_class_stage，常量表兜底】：
 *   - 进程启动时加载一次（模块顶层直接 refresh，失败静默）
 *   - 每次方案新增/修改/删除后由 setting.route 调 refreshStageDict() 重新加载
 *
 * ⚠️ 是内存缓存，如果绕过接口直接改库（例如跑 seed 脚本），需要重启后端才会生效。
 */

import { STAGE_NAME } from 'shared-types/class-jh';
import { db } from './db';

const STAGE_TABLE = 't_class_stage';

/** 当前生效的「阶段编码 → 阶段名称」映射 */
const map: Record<number, string> = { ...STAGE_NAME };

/** 阶段中文名（未知编码返回空串，与 nameOf 保持一致） */
export function resolveStageName(code: number | string | null | undefined): string {
  if (code === undefined || code === null || code === '') return '';
  return map[Number(code)] || '';
}

/** 重新从库里加载阶段字典（方案增删改后调用） */
export async function refreshStageDict(): Promise<void> {
  try {
    const rows = await db(STAGE_TABLE).where('is_deleted', false).select('stage_code', 'stage_name');
    for (const key of Object.keys(map)) delete map[Number(key)];
    Object.assign(map, STAGE_NAME);
    for (const r of rows) {
      if (r.stage_name) map[Number(r.stage_code)] = String(r.stage_name);
    }
  } catch {
    /* 表还没建好 / 库没起来：静默降级到常量表 */
  }
}

// 模块加载即预热一次（不阻塞、失败无妨）
void refreshStageDict();
