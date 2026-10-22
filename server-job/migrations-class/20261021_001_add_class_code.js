/**
 * 迁移：大学班级表加「班级编号」列
 *
 * ★ 2026-10-21 用户口径：班级编号三部门统一（初高部 / 大学部 / 就业部），必填。
 *   与 migrations-class-jh 的同名迁移保持对称（字段名/类型完全一致）。
 *
 * ⚠️ 列可空：历史班级先留空（编辑时再补）。
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
