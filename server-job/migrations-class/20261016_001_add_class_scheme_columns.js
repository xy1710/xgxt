/**
 * 迁移：大学部班级表加「阶段方案」三列
 *
 * 与 sms_class_jh 的 20261016_002、sms_job 的 20261016_001 对称 ——
 * 三张班级表结构保持一致，升实训/统一班级页表单才能一套字段走通。
 *
 *   scheme_id         选中的方案ID
 *   scheme_stage_id   选中的方案阶段明细ID
 *   scheme_stage_name 阶段名称（冗余，回显用）
 */

const TABLE = 't_class_info';

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
