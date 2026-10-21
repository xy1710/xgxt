/**
 * 迁移：统一班级表 t_uni_class 加「阶段方案」三列（sms_common）
 *
 * 与三张老班级表（sms_class_jh / sms_class / sms_job）的 20261016 迁移对称 ——
 * 第 4 期切读（TEACHING_UNI_TABLE=1）后班级表改读 t_uni_class，
 * 结构不对齐的话，方案字段会在切读模式下静默丢失（不报错、只是读不到）。
 *
 *   scheme_id / scheme_stage_id / scheme_stage_name
 */

const TABLE = 't_uni_class';

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
