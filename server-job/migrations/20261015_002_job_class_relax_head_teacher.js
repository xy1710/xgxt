/**
 * 班级表单取消必填（2026-10-15 · 班级管理批注需求）：
 *   实训班级 head_teacher_id 原为 NOT NULL，放宽为可空（班主任改下拉选人、可不选）。
 *
 * 涉及库：sms_job.t_job_class
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('t_job_class', (t) => {
    t.string('head_teacher_id', 36).nullable().defaultTo(null).comment('班主任ID（20261015 放宽：可选）').alter();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('t_job_class', (t) => {
    t.string('head_teacher_id', 36).notNullable().comment('班主任ID').alter();
  });
};
