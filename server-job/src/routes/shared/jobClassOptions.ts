/**
 * 就业模块「班级下拉选项」共用接口（只读）
 * ============================================================
 *
 * 【为什么单开一个，而不是复用 /api/job/class/options】
 *   `/api/job/class` 整个路由被
 *     requireAnyPage(['job:class:view','job:classTransfer:view','job:attendance:view',
 *                      'job:exam:view','job:examScore:view','job:suspendApproval:view'])
 *   挡着，而**就业老师(JOB_STAFF) 的页面清单里一个都没有**
 *   （JOB_STAFF 只有 employmentLog / review / statistics / empDorm / empArchive）。
 *   → 就业日志、复盘填写两页去拉班级下拉会直接 403，前端弹「您没有该操作的权限」。
 *
 *   把页面码加进 `requireAnyPage` 也不合适：那等于把班级的增删改查
 *   （add/update/delete/seal/graduate…）一起对就业老师开放了。
 *
 *   → 所以单开一个只读、只返回 { id, className } 的接口，分别挂在
 *     `employmentLogRouter` / `reviewRouter` 下，沿用各自的页面权限
 *     （job:employmentLog:view / job:review:view）。
 *
 * ⚠️ 只 select `id, class_name` 两列：本环境的 `sms_job.t_job_class` 是精简表，
 *    没有 class_code / dept_code / stage / student_count 等列，多选会报 Unknown column。
 */

import { db } from '../../utils/db';
import { ok } from '../../utils/response';
import { wrap } from '../../utils/wrap';

const CLASS_TABLE = 't_job_class';

export const listJobClassOptions = wrap(async (_req, res) => {
  const rows = (await db(CLASS_TABLE)
    .where('is_deleted', 0)
    .select('id', 'class_name')
    .orderBy('class_name')) as Array<{ id: string; class_name: string }>;

  res.json(ok(rows.map((r) => ({ id: r.id, className: r.class_name }))));
});
