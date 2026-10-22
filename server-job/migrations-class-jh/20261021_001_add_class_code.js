/**
 * 迁移：初高班级表加「班级编号」列
 *
 * ★ 2026-10-21 用户口径：「班级管理 → 新增/编辑班级」三个部门都要有班级编号，
 *   且必填；留空时输入框给 Q17/J101/T101 的示例提示。
 *
 *   原来只有实训/就业部的 `t_job_class` 有 class_code，
 *   初高 / 大学两张 `t_class_info` 都没有这一列 —— 补齐，三部门口径一致。
 *
 * ⚠️ 列可空：历史班级先留空（编辑时再补），不阻塞迁移；
 *    唯一性在应用层校验（同表内编号不重复），这里只加普通索引便于按编号查。
 */

const TABLE = 't_class_info';
const COL = 'class_code';

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string(COL, 32).nullable().comment('班级编号，如 Q17 / J101 / T101');
      t.index([COL], `${TABLE}_${COL}_idx`);
    });
  }
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropIndex([COL], `${TABLE}_${COL}_idx`);
      t.dropColumn(COL);
    });
  }
};
