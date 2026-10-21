/**
 * 班级表单取消必填（2026-10-15 · 班级管理批注需求）：
 *   班主任 / 教员 / 助教 改为下拉选择权限管理用户，允许不选。
 *
 * 涉及库：sms_class_jh.t_class_info
 *   head_teacher_id / head_teacher_name / teacher_id / teacher_name
 *   原为 NOT NULL（建表时按「初高必须指定班主任」设计），放宽为可空。
 *   class_name / stage / dept_code 仍保持 NOT NULL（前端留空时由仓储生成占位名/默认值）。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('t_class_info', (t) => {
    t.string('head_teacher_id', 36).nullable().defaultTo(null).comment('班主任ID（20261015 放宽：可选）').alter();
    t.string('head_teacher_name', 50).nullable().defaultTo(null).comment('班主任姓名快照（可选）').alter();
    t.string('teacher_id', 36).nullable().defaultTo(null).comment('教员ID（可选）').alter();
    t.string('teacher_name', 50).nullable().defaultTo(null).comment('教员姓名快照（可选）').alter();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('t_class_info', (t) => {
    t.string('head_teacher_id', 36).notNullable().comment('班主任ID').alter();
    t.string('head_teacher_name', 50).notNullable().comment('班主任姓名').alter();
    t.string('teacher_id', 36).notNullable().comment('教员ID').alter();
    t.string('teacher_name', 50).notNullable().comment('教员姓名').alter();
  });
};
