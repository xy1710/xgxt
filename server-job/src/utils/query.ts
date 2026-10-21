/**
 * query string 参数解析工具（三学段共用）
 *
 * 只放「GET 查询参数」的通用解析，业务校验仍留在各自 route 的 schema 里。
 */

import { z } from 'zod';

/**
 * 布尔 query 参数
 *
 * ⚠️ 绝不能用 `z.coerce.boolean()` —— 它按 JS 真值判断，字符串 `"false"` 会被转成 `true`。
 *    前端 el-switch 关掉时序列化出来的就是 `flag=false`，后端却当成「开」，
 *    现象是「开关关掉后筛选依旧生效」，而且接口不报错 —— 静默的坏。
 *
 * 口径：只有 `true` / `1` / `on` / `yes`（大小写不敏感）算真，其余一律假。
 * 用法：`onlyOverdue: boolFlag.optional()`
 */
export const boolFlag = z.preprocess(
  (v) => (typeof v === 'string' ? ['true', '1', 'on', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
  z.boolean(),
);
