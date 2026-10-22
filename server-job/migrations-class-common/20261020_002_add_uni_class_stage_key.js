/**
 * 迁移：统一班级表 t_uni_class 补 `stage_key`
 * ============================================================
 * 【为什么】
 *   远端 43bd8bf 把「实训 / 就业部」拆成两个学段，两者共用 t_uni_class
 *   （edu_stage 都是 job？不——拆分后实训仍是 job，就业部是 emp），
 *   班级仓储靠 `stage_key` 区分（'job' 实训 / 'emp' 就业部）。
 *   但那条提交**没有配套迁移**，统一表里没有这一列 →
 *   实训班级列表直接报「数据库字段不存在」。
 *
 * 【口径】
 *   · 已有行：edu_stage='job' → stage_key='job'；edu_stage='emp' → 'emp'
 *   · 其它学段留 NULL（不参与该过滤）
 *   · 索引：按 (edu_stage, stage_key) 过滤，建个联合索引
 */

const TABLE = 't_uni_class';

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;

  if (!(await knex.schema.hasColumn(TABLE, 'stage_key'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('stage_key', 16).nullable().comment('学段细分：实训=job / 就业部=emp（拆分后用于区分同表两类班级）');
    });
  }

  await knex(TABLE).where({ edu_stage: 'job' }).whereNull('stage_key').update({ stage_key: 'job' });
  await knex(TABLE).where({ edu_stage: 'emp' }).whereNull('stage_key').update({ stage_key: 'emp' });

  const hasIdx = await knex.raw(
    `select 1 from information_schema.statistics
      where table_schema = database() and table_name = ? and index_name = 'idx_uni_class_stage_key' limit 1`,
    [TABLE],
  );
  const rows = Array.isArray(hasIdx) ? hasIdx[0] : hasIdx;
  if (!rows || !rows.length) {
    await knex.raw(`alter table \`${TABLE}\` add index \`idx_uni_class_stage_key\` (\`edu_stage\`, \`stage_key\`)`);
  }
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable(TABLE);
  if (!exists) return;
  const cols = await knex.schema.hasColumn(TABLE, 'stage_key');
  if (cols) await knex.schema.alterTable(TABLE, (t) => t.dropColumn('stage_key'));
};
