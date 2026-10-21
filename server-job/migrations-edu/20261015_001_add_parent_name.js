/**
 * 学生档案改版（2026-10-15 · 教学管理 · 学生档案批注需求）：
 *   学生表新增「家长姓名」列（前端「手机号」后新增【家长姓名】字段）。
 *
 * 涉及库：sms_edu.t_student_base（教务学生表）
 * 同批：sms_job / sms_class / sms_class_jh / sms_common(t_uni_student) 各有一份同名迁移。
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('t_student_base', 'parent_name');
  if (!has) {
    await knex.schema.alterTable('t_student_base', (t) => {
      t.string('parent_name', 50).defaultTo(null).comment('家长姓名');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('t_student_base', 'parent_name');
  if (has) {
    await knex.schema.alterTable('t_student_base', (t) => {
      t.dropColumn('parent_name');
    });
  }
};
