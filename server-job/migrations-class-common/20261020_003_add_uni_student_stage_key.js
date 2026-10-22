/**
 * 迁移：统一学生表 t_uni_student 补 `stage_key`
 * ============================================================
 * 【为什么】
 *   远端把「实训 / 就业部」拆成两个学段后，两个学段共用同一张 t_uni_student
 *   （edu_stage 都是 job，靠 stage_key 区分 job=实训 / emp=就业部）。
 *   学生仓储与班级下拉都按 `stage_key` 过滤，但统一表里没有这一列 →
 *   学生档案「实训」页签直接报「数据库字段不存在」。
 *
 * 【口径】
 *   · edu_stage='job' 的历史行一律回填 'job'（就业部的行由后续搬迁写入 'emp'）
 *   · 其它学段保持 NULL
 */

const TABLE = 't_uni_student';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;

  if (!(await knex.schema.hasColumn(TABLE, 'stage_key'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('stage_key', 16).nullable().comment('学段细分：实训=job / 就业部=emp');
    });
  }

  await knex(TABLE).where({ edu_stage: 'job' }).whereNull('stage_key').update({ stage_key: 'job' });

  const hasIdx = await knex.raw(
    `select 1 from information_schema.statistics
      where table_schema = database() and table_name = ? and index_name = 'idx_uni_student_stage_key' limit 1`,
    [TABLE],
  );
  const rows = Array.isArray(hasIdx) ? hasIdx[0] : hasIdx;
  if (!rows || !rows.length) {
    await knex.raw(`alter table \`${TABLE}\` add index \`idx_uni_student_stage_key\` (\`edu_stage\`, \`stage_key\`)`);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'stage_key')) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('stage_key'));
  }
};
