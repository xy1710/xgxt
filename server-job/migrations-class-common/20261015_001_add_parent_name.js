/**
 * 学生档案改版（2026-10-15 · 教学管理 · 学生档案批注需求）：
 *   学生统一表新增「家长姓名」列（前端「手机号」后新增【家长姓名】字段）。
 *
 * 涉及库：sms_common.t_uni_student（教学统一学生表，TEACHING_UNI_TABLE=1 时启用）
 * 同批：sms_job / sms_edu / sms_class / sms_class_jh 各有一份同名迁移。
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('t_uni_student', 'parent_name');
  if (!has) {
    await knex.schema.alterTable('t_uni_student', (t) => {
      t.string('parent_name', 50).defaultTo(null).comment('家长姓名');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('t_uni_student', 'parent_name');
  if (has) {
    await knex.schema.alterTable('t_uni_student', (t) => {
      t.dropColumn('parent_name');
    });
  }
};
