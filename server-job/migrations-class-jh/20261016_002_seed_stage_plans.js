/**
 * 数据迁移：把阶段字典里已有的阶段按部门归档成两个方案
 *
 *   初高部阶段方案（dept_code = 1）← 原 101~107
 *   大学部阶段方案（dept_code = 2）← 原 201~209
 *
 * 另外把「学生档案」的阶段 / 部门与所在班级对齐一次
 * （改版后学生档案的阶段、部门跟随班级；这里补一次历史数据）。
 *
 * ⚠️ 幂等：方案已存在就跳过，plan_id 只在为空时回填。
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('t_class_stage_plan'))) return;
  if (!(await knex.schema.hasColumn('t_class_stage', 'plan_id'))) return;

  const now = new Date();
  const PLANS = [
    { id: 'plan-jh-default', plan_name: '初高部阶段方案', dept_code: 1 },
    { id: 'plan-uni-default', plan_name: '大学部阶段方案', dept_code: 2 },
  ];

  for (const p of PLANS) {
    const existed = await knex('t_class_stage_plan').where({ id: p.id }).first();
    if (!existed) {
      await knex('t_class_stage_plan').insert({
        id: p.id,
        plan_name: p.plan_name,
        dept_code: p.dept_code,
        sort_no: 0,
        is_deleted: false,
        create_time: now,
        create_by: 'migration',
      });
    }
    // 把该部门下还没归入方案的阶段挂到这个方案上
    await knex('t_class_stage')
      .where({ dept_code: p.dept_code })
      .whereNull('plan_id')
      .update({ plan_id: p.id, update_time: now, update_by: 'migration' });
  }

  // 学生档案的阶段 / 部门跟随所在班级
  const classes = await knex('t_class_info').where('is_deleted', false).select('id', 'stage', 'dept_code');
  for (const c of classes) {
    await knex('t_class_student')
      .where({ class_id: c.id, is_deleted: false })
      .update({ stage: c.stage, dept_code: c.dept_code, update_time: now, update_by: 'migration' });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // 数据迁移，不做回滚（回滚会把方案归属清空，无意义）
};
