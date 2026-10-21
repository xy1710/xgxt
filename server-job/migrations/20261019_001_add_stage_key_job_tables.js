/**
 * 实训/就业共用表加「学段标识」列（2026-10-19 · 实训归属就业部）
 * ============================================================
 * 需求口径：实训与就业**都归「就业部」**（dept_code=3），两者只靠**学段**区分。
 *
 * 【为什么必须加这一列】
 *   t_job_class / t_student_base 原本没有「学段 key」列 ——
 *   表里的 `stage` 是**阶段码**（201/301），不是 jh/class/job/emp。
 *   上一版用 `dept_code=3` 隔离就业部，但现在实训也要 dept=3，
 *   部门已经无法区分两者，只能显式加一列。
 *
 * 【取值】
 *   stage_key = 'job'（实训，历史数据全部按此回填）
 *   stage_key = 'emp'（就业部，新建时写入）
 *
 * 涉及库：sms_job.t_job_class / sms_job.t_student_base
 */

exports.up = async function up(knex) {
  for (const table of ['t_job_class', 't_student_base']) {
    const has = await knex.schema.hasColumn(table, 'stage_key');
    if (!has) {
      await knex.schema.alterTable(table, (t) => {
        t.string('stage_key', 10)
          .notNullable()
          .defaultTo('job')
          .comment('学段标识：job 实训 / emp 就业部（2026-10-19 新增）');
        t.index(['stage_key'], `idx_${table}_stage_key`);
      });
    }
    // 历史数据：这两张表里的行都是实训阶段
    await knex(table).whereNull('stage_key').update({ stage_key: 'job' });
    // 实训也归就业部：原来挂在大学部(2)的行统一改到就业部(3)
    await knex(table).where('dept_code', 2).update({ dept_code: 3 });
  }
};

exports.down = async function down(knex) {
  for (const table of ['t_job_class', 't_student_base']) {
    const has = await knex.schema.hasColumn(table, 'stage_key');
    if (has) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn('stage_key');
      });
    }
  }
};
