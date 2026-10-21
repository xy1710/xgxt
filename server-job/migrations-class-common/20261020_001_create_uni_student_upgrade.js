/**
 * 学生档案 · 升云记录（2026-10-20 批注需求）
 * ============================================================
 * 校长批注（学生档案页）：「增加【升云】功能：点击升云可以批量选择人员进行升云，
 * 只适用于初高中，选择人员后再进行大学部要升入班级的选择，
 * 只能选择班级状态为开放的。」+「增加升云的记录，在学生档案详情中显示，
 * 在基础信息页面增加升云记录，记录信息包括原班主任、原班级、操作人，
 * 同时升云只改变班级的相关内容，其余不变，尤其是学号不更改」
 *
 * 【这张表只做留痕】
 *   升云 = 初高部学生档案整体搬到大学部某个「开放」班级：
 *     · 大学库（sms_class.t_class_student）新建一条，学号原样保留
 *     · 初高库（sms_class_jh.t_class_student）原记录逻辑删除（= 移动）
 *     · 本表记一条流水：原班级 / 原班主任 / 升入班级 / 操作人 / 时间
 *
 * 【为什么放 sms_common】
 *   与班级交接记录（t_uni_class_handover）、阶段方案同库 ——
 *   升云是**跨学段**动作（初高库 + 大学库），记录不属于任何一侧，
 *   放公共库才能既不被哪个模块的库删表带走，也方便两个学段的详情页读同一份。
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('t_uni_student_upgrade');
  if (has) return;

  await knex.schema.createTable('t_uni_student_upgrade', (t) => {
    t.string('id', 36).primary().comment('主键');
    t.string('student_no', 32).notNullable().comment('学号（升云后不变）');
    t.string('student_name', 50).notNullable().defaultTo('').comment('姓名快照');

    /* —— 来源（初高部） —— */
    t.string('from_stage', 10).notNullable().defaultTo('jh').comment('来源学段固定 jh');
    t.string('from_student_id', 40).nullable().comment('初高库学生ID（已逻辑删除）');
    t.string('from_class_id', 40).nullable().comment('原班级ID');
    t.string('from_class_name', 80).nullable().comment('原班级名称快照');
    t.string('from_head_teacher_id', 40).nullable().comment('原班主任ID');
    t.string('from_head_teacher_name', 50).nullable().comment('原班主任姓名快照');

    /* —— 目标（大学部） —— */
    t.string('to_stage', 10).notNullable().defaultTo('class').comment('目标学段固定 class');
    t.string('to_student_id', 40).nullable().comment('大学库新建的学生ID');
    t.string('to_class_id', 40).nullable().comment('升入班级ID');
    t.string('to_class_name', 80).nullable().comment('升入班级名称快照');
    t.string('to_head_teacher_name', 50).nullable().comment('升入班级班主任快照');

    t.datetime('upgrade_time').notNullable().defaultTo(knex.fn.now()).comment('升云时间');
    t.string('operator_id', 40).nullable().comment('操作人ID');
    t.string('operator_name', 50).nullable().comment('操作人姓名');
    t.string('remark', 255).nullable().comment('备注');

    t.tinyint('is_deleted', 1).notNullable().defaultTo(0);
    t.string('create_by', 40).nullable();
    t.datetime('create_time').notNullable().defaultTo(knex.fn.now());
    t.string('update_by', 40).nullable();
    t.datetime('update_time').nullable();

    t.index(['student_no'], 'idx_upgrade_student_no');
    t.index(['from_student_id'], 'idx_upgrade_from_student');
    t.index(['to_student_id'], 'idx_upgrade_to_student');
    t.index(['upgrade_time'], 'idx_upgrade_time');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('t_uni_student_upgrade');
};
