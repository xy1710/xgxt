/**
 * 迁移：阶段方案 t_class_stage_plan（P2 阶段字典 → 方案化）
 *
 * 背景：原来的「阶段字典」是一张平铺表（一行 = 一个阶段）。
 *      改版后一个「方案」可以包含多个「阶段」：
 *        方案（t_class_stage_plan）  1 ── N  阶段（t_class_stage.plan_id）
 *
 *      所以这里做两件事：
 *        ① 新建方案表 t_class_stage_plan
 *        ② 给 t_class_stage 加 plan_id 列（沿用原表，班级/学生的 stage 编码不用动）
 *
 * ⚠️ 用 hasTable / hasColumn 做了幂等保护：重复执行不会报错。
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasPlanTable = await knex.schema.hasTable('t_class_stage_plan');
  if (!hasPlanTable) {
    await knex.schema.createTable('t_class_stage_plan', (table) => {
      // ---- 公共字段 ----
      table.string('id', 36).primary().comment('主键UUID');
      table.datetime('create_time').notNullable().comment('创建时间');
      table.string('create_by', 36).comment('创建人ID');
      table.datetime('update_time').comment('修改时间');
      table.string('update_by', 36).comment('修改人ID');
      table.boolean('is_deleted').notNullable().defaultTo(false).comment('逻辑删除');

      // ---- 业务字段 ----
      table.string('plan_name', 50).notNullable().comment('方案名称');
      table.integer('dept_code').notNullable().comment('所属部门 1初高部 2大学部');
      table.integer('sort_no').defaultTo(0).comment('排序');

      table.index(['dept_code'], 'idx_stage_plan_dept');
      table.comment('阶段方案表（一个方案含多个阶段）');
    });
  }

  const hasPlanId = await knex.schema.hasColumn('t_class_stage', 'plan_id');
  if (!hasPlanId) {
    await knex.schema.alterTable('t_class_stage', (table) => {
      table.string('plan_id', 36).comment('所属方案ID（t_class_stage_plan.id）');
      table.index(['plan_id'], 'idx_stage_plan_id');
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasPlanId = await knex.schema.hasColumn('t_class_stage', 'plan_id');
  if (hasPlanId) {
    await knex.schema.alterTable('t_class_stage', (table) => {
      table.dropIndex(['plan_id'], 'idx_stage_plan_id');
      table.dropColumn('plan_id');
    });
  }
  await knex.schema.dropTableIfExists('t_class_stage_plan');
};
