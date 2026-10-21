/**
 * 迁移：阶段方案 t_class_stage_scheme + 阶段明细 t_class_stage_scheme_stage
 *
 * 【背景】原「阶段字典」（t_class_stage，一条记录 = 一个阶段）升级为「阶段方案」：
 *   一个方案 = 方案名称 + 所属部门 + N 个阶段（阶段名称 + 学制月数）。
 *   例：方案一（初高部）→ 一阶段 学制2月 / 二阶段 学制2月 / 三阶段 学制2月。
 *
 * 【为什么不直接改 t_class_stage】
 *   t_class_stage 的行被学生的 stage（阶段码）引用着，改结构会波及学生/班级的
 *   阶段码口径；方案是**新一层业务对象**，单开两张表、老表先原样留着。
 *
 * 【数据搬迁】老字典数据按部门各归拢成一个默认方案（仅当方案表为空时执行）：
 *   初高部阶段方案 / 大学部阶段方案 —— 让新页面和班级表单开箱就有数据可选。
 */

/** 阶段明细行（与老字典逐行对应） */
function stageRowsOf(dictRows, schemeId) {
  return dictRows.map((r, i) => ({
    id: `${schemeId}-s${i + 1}`,
    scheme_id: schemeId,
    stage_name: r.stage_name,
    study_months: r.study_months,
    sort_no: i,
    is_deleted: false,
    create_time: new Date(),
    create_by: 'MIGRATION',
  }));
}

/**
 * 用老字典给两个部门各生成一个默认方案
 * @param { import("knex").Knex } knex
 */
async function seedDefaultSchemes(knex) {
  const hasDict = await knex.schema.hasTable('t_class_stage');
  if (!hasDict) return;

  const dict = await knex('t_class_stage').where('is_deleted', false).orderBy('sort_no', 'asc');
  if (!dict.length) return; // 空字典（全新安装）→ 不造数据，由管理员自己建方案

  const groups = [
    { deptCode: 1, schemeId: 'seed-scheme-1', schemeName: '初高部阶段方案' },
    { deptCode: 2, schemeId: 'seed-scheme-2', schemeName: '大学部阶段方案' },
  ];

  for (const g of groups) {
    const rows = dict.filter((r) => Number(r.dept_code) === g.deptCode);
    if (!rows.length) continue;

    const dup = await knex('t_class_stage_scheme')
      .where({ scheme_name: g.schemeName, dept_code: g.deptCode, is_deleted: false })
      .first();
    if (dup) continue;

    const now = new Date();
    await knex('t_class_stage_scheme').insert({
      id: g.schemeId,
      scheme_name: g.schemeName,
      dept_code: g.deptCode,
      sort_no: g.deptCode,
      is_deleted: false,
      create_time: now,
      create_by: 'MIGRATION',
    });
    await knex('t_class_stage_scheme_stage').insert(stageRowsOf(rows, g.schemeId));
  }
}

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasScheme = await knex.schema.hasTable('t_class_stage_scheme');
  if (!hasScheme) {
    await knex.schema.createTable('t_class_stage_scheme', (table) => {
      // ---- 公共字段 ----
      table.string('id', 36).primary().comment('主键UUID');
      table.datetime('create_time').notNullable().comment('创建时间');
      table.string('create_by', 36).comment('创建人ID');
      table.datetime('update_time').comment('修改时间');
      table.string('update_by', 36).comment('修改人ID');
      table.boolean('is_deleted').notNullable().defaultTo(false).comment('逻辑删除');

      // ---- 业务字段 ----
      table.string('scheme_name', 50).notNullable().comment('方案名称');
      table.integer('dept_code').notNullable().comment('所属部门 1初高部 2大学部');
      table.integer('sort_no').defaultTo(0).comment('排序');

      // ---- 索引 ----
      table.index(['dept_code'], 'idx_scheme_dept');

      table.comment('阶段方案表');
    });
  }

  const hasStage = await knex.schema.hasTable('t_class_stage_scheme_stage');
  if (!hasStage) {
    await knex.schema.createTable('t_class_stage_scheme_stage', (table) => {
      // ---- 公共字段 ----
      table.string('id', 36).primary().comment('主键UUID');
      table.datetime('create_time').notNullable().comment('创建时间');
      table.string('create_by', 36).comment('创建人ID');
      table.datetime('update_time').comment('修改时间');
      table.string('update_by', 36).comment('修改人ID');
      table.boolean('is_deleted').notNullable().defaultTo(false).comment('逻辑删除');

      // ---- 业务字段 ----
      table.string('scheme_id', 36).notNullable().comment('所属方案ID');
      table.string('stage_name', 50).notNullable().comment('阶段名称，如一阶段');
      table.integer('study_months').comment('学制月数');
      table.integer('sort_no').defaultTo(0).comment('方案内排序（阶段顺序）');

      // ---- 索引 ----
      table.index(['scheme_id'], 'idx_scheme_stage_scheme');

      table.comment('阶段方案-阶段明细表');
    });
  }

  // 数据搬迁：老字典 → 两个默认方案（幂等：按方案名+部门查重）
  await seedDefaultSchemes(knex);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('t_class_stage_scheme_stage');
  await knex.schema.dropTableIfExists('t_class_stage_scheme');
};
