/**
 * 迁移：初高班级表加「阶段方案」三列
 *
 * 班级新增/编辑时选择 阶段方案 + 方案里的阶段，落库三列：
 *   scheme_id         选中的方案ID（t_class_stage_scheme.id）
 *   scheme_stage_id   选中的方案阶段明细ID（t_class_stage_scheme_stage.id）
 *   scheme_stage_name 阶段名称（冗余存一份，列表/花名册直接回显，方案改名不影响历史班）
 *
 * ⚠️ 三列都可空：老班级没有方案（还走已有 stage 阶段码），互不影响。
 *    与 sms_class / sms_job 两库的同名迁移保持对称（字段名/类型一致）。
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
