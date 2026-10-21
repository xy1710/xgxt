/**
 * 数据迁移：给「就业部」补一套默认阶段方案（★ 2026-10-19）
 *
 * 【为什么】
 *   改造前阶段方案只支持初高部（1）/ 大学部（2），就业部的阶段是仓储里写死的
 *   一阶段 / 二阶段 / 三阶段，页面上改不了。本次让就业部与另外两个部门一致：
 *   阶段统一由「系统设置 → 阶段方案」维护。
 *
 * 【编码口径】
 *   阶段码按部门分段：初高部 1xx / 大学部 2xx / **就业部 3xx**。
 *   历史数据里就业部/实训学生的 stage 已经是 301，所以这里从 301 起排，
 *   一阶段 = 301 正好对上，不产生孤儿编码。
 *
 * 【实训】
 *   实训班与就业部班级共用 `sms_job.t_job_class`（dept_code 都是 3，靠 stage_key 区分），
 *   所以这一套方案对「实训 / 就业」两个学段同时生效。
 *
 * ⚠️ 幂等：
 *   - 该部门已有未删除的方案 → 直接跳过，绝不覆盖用户自己配的方案
 *   - 阶段码已存在 → 跳过，不重复插
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('t_class_stage_plan'))) return;
  if (!(await knex.schema.hasColumn('t_class_stage', 'plan_id'))) return;

  const DEPT = 3;
  const PLAN_ID = 'plan-emp-default';
  const now = new Date();

  const existed = await knex('t_class_stage_plan')
    .where({ dept_code: DEPT, is_deleted: false })
    .first();
  if (existed) return;

  await knex('t_class_stage_plan').insert({
    id: PLAN_ID,
    plan_name: '就业部阶段方案',
    dept_code: DEPT,
    sort_no: 0,
    is_deleted: false,
    create_time: now,
    create_by: 'migration',
  });

  /** 默认阶段（可从系统设置里改名 / 增删 / 学制月） */
  const PHASES = [
    { code: 301, name: '一阶段', months: null },
    { code: 302, name: '二阶段', months: null },
    { code: 303, name: '三阶段', months: null },
  ];

  let sortNo = 0;
  for (const p of PHASES) {
    const dup = await knex('t_class_stage')
      .where({ stage_code: p.code, dept_code: DEPT, is_deleted: false })
      .first();
    if (!dup) {
      await knex('t_class_stage').insert({
        id: require('crypto').randomUUID(),
        stage_code: p.code,
        stage_name: p.name,
        dept_code: DEPT,
        plan_id: PLAN_ID,
        study_months: p.months,
        sort_no: sortNo,
        is_deleted: false,
        create_time: now,
        create_by: 'migration',
      });
    }
    sortNo += 1;
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // 数据迁移，不自动回滚（回滚会把班级/学生的阶段指向空方案）
};
