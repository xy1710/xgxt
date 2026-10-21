/**
 * 班级管理 · 交接记录（2026-10-19 批注需求）
 * ============================================================
 * 校长批注：班级管理操作列加【交接】，一次交接要同时记 5 个岗位的
 * 原/新负责人（班主任 / 教员 / 助教 / 项目经理 / 就业老师），
 * 并在班级详情里能看到这条记录。
 *
 * 【为什么新建一张统一表，而不是复用三张老表】
 *   老表各缺一半字段：
 *     sms_class.t_class_transfer      —— 只有一对 from/to（单岗位）
 *     sms_class_jh.t_class_handover   —— 一行一个岗位（要拆 5 行才对得上一次交接）
 *     sms_job.t_job_class_transfer    —— 只有班主任/教员/助教，没有项目经理/就业老师
 *   而「一次交接 = 一个班 5 个岗位同时换人」是跨部门同一个动作，
 *   所以放 sms_common 建一张统一表，靠 stage 区分初高 / 大学 / 实训。
 *
 * ⚠️ 老表和老页面（/api/job/class-transfer、班级交接菜单）都不动，
 *    保留回退能力；本表只服务「教学管理 → 班级管理 → 交接」。
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('t_uni_class_handover');
  if (has) return;

  await knex.schema.createTable('t_uni_class_handover', (t) => {
    t.string('id', 36).primary().comment('主键');
    t.string('class_id', 40).notNullable().comment('班级ID（三个学段的原表主键）');
    t.string('class_name', 80).notNullable().defaultTo('').comment('班级名称快照');
    t.string('stage', 10).notNullable().comment('学段 jh / class / job');
    t.string('stage_name', 20).notNullable().defaultTo('').comment('学段中文名');
    t.integer('dept_code', 4).nullable().comment('部门 1 初高 / 2 大学');

    // 5 个岗位的原/新负责人（初高只有前 3 个，另外两列为空）
    t.string('old_head_teacher_id', 40).nullable();
    t.string('old_head_teacher_name', 50).nullable();
    t.string('new_head_teacher_id', 40).nullable();
    t.string('new_head_teacher_name', 50).nullable();
    t.string('old_teacher_id', 40).nullable();
    t.string('old_teacher_name', 50).nullable();
    t.string('new_teacher_id', 40).nullable();
    t.string('new_teacher_name', 50).nullable();
    t.string('old_assistant_id', 40).nullable();
    t.string('old_assistant_name', 50).nullable();
    t.string('new_assistant_id', 40).nullable();
    t.string('new_assistant_name', 50).nullable();
    t.string('old_project_manager_id', 40).nullable();
    t.string('old_project_manager_name', 50).nullable();
    t.string('new_project_manager_id', 40).nullable();
    t.string('new_project_manager_name', 50).nullable();
    t.string('old_employment_teacher_id', 40).nullable();
    t.string('old_employment_teacher_name', 50).nullable();
    t.string('new_employment_teacher_id', 40).nullable();
    t.string('new_employment_teacher_name', 50).nullable();

    t.date('handover_date').nullable().comment('交接日期');
    t.string('reason', 255).nullable().comment('交接原因');
    t.string('operator_id', 40).nullable().comment('操作人ID');
    t.string('operator_name', 50).nullable().comment('操作人姓名');

    t.tinyint('is_deleted', 1).notNullable().defaultTo(0);
    t.string('create_by', 40).nullable();
    t.datetime('create_time').notNullable().defaultTo(knex.fn.now());
    t.string('update_by', 40).nullable();
    t.datetime('update_time').nullable();

    t.index(['class_id', 'handover_date'], 'idx_handover_class_date');
    t.index(['stage'], 'idx_handover_stage');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('t_uni_class_handover');
};
