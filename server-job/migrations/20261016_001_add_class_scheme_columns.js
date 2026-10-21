/**
 * 迁移：实训班级表 t_job_class 加「阶段方案」三列
 *
 * 与 sms_class_jh / sms_class 两个库的同名迁移对称 ——
 * 统一班级页（初高 / 大学 / 实训）三张班级表结构一致，
 * 表单里的「阶段方案 + 阶段」一套字段三端通用。
 *
 *   scheme_id         选中的方案ID
 *   scheme_stage_id   选中的方案阶段明细ID
 *   scheme_stage_name 阶段名称（冗余，回显用）
 */

const TABLE = 't_job_class';

const SCHEME_FIELDS = [
  ['scheme_id', '阶段方案ID'],
  ['scheme_stage_id', '方案阶段明细ID'],
  ['scheme_stage_name', '方案阶段名称'],
];

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;

  for (const [col, comment] of SCHEME_FIELDS) {
    if (await knex.schema.hasColumn(TABLE, col)) continue;
    await knex.schema.alterTable(TABLE, (t) => {
      t.string(col, 50).nullable().comment(comment);
    });
  }
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;
  for (const [col] of SCHEME_FIELDS.slice().reverse()) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(col));
    }
  }
};
