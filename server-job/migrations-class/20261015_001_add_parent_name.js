/**
 * 学生档案改版（2026-10-15 · 教学管理 · 学生档案批注需求）：
 *   学生表新增「家长姓名」列（前端「手机号」后新增【家长姓名】字段）。
 *
 * 涉及库：sms_class.t_class_student（大学学生表）
 * 同批：sms_job / sms_edu / sms_class_jh / sms_common(t_uni_student) 各有一份同名迁移。
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('t_class_student', 'parent_name');
  if (!has) {
    await knex.schema.alterTable('t_class_student', (t) => {
      t.string('parent_name', 50).defaultTo(null).comment('家长姓名');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('t_class_student', 'parent_name');
  if (has) {
    await knex.schema.alterTable('t_class_student', (t) => {
      t.dropColumn('parent_name');
    });
  }
};
