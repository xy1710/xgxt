/**
 * 迁移：宿舍楼栋设置表增加「类别」列
 * ============================================================
 *
 * 业务含义
 *   category = 1 → 男寝
 *   category = 2 → 女寝
 *   NULL       → 老数据未分类，可通过「系统设置 → 楼栋设置」的编辑按钮补录
 *
 * 为什么允许 NULL
 *   历史楼栋（1号楼/2号楼/3号楼）在加这列之前没有类别概念；
 *   如果直接默认填 1 或 2，会把大量未知楼栋错误归类，反而误导后续筛选。
 *   → 交给用户在楼栋设置页编辑补全，最稳妥。
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = await knex.schema.hasColumn('t_dorm_building', 'category');
  if (!hasCol) {
    await knex.schema.table('t_dorm_building', (table) => {
      table
        .integer('category')
        .nullable()
        .comment('楼栋类别：1 男寝 / 2 女寝');
      table.index(['category'], 'idx_dorm_building_category');
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasCol = await knex.schema.hasColumn('t_dorm_building', 'category');
  if (hasCol) {
    await knex.schema.table('t_dorm_building', (table) => {
      table.dropColumn('category');
    });
  }
};
