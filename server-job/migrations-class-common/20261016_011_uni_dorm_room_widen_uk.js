/**
 * 第 4 期 · 阶段 4（P5 搬迁配套，#21 正向档）：**`uk_dorm_room` 加宽回老表口径**
 * ============================================================
 *
 * 【实锤（2026-10-16，_uni-migrate-p5 首跑）】
 *   jh 老表 `t_class_room` 的房间唯一性是 **(building_id, room_no)** ——
 *   两栋楼各有 `2-01` 房。统一表 `uk_dorm_room(room_no, dorm_no, edu_stage)`
 *   把 building 维度弄丢了 → 两栋楼的 '2-01' 在 edu_stage=jh 下撞键
 *   → `Duplicate entry '2-01--jh'`，搬迁中断。
 *
 * 【修法：加宽（不是删）】
 *   老表三个源各有自己的唯一语义：
 *     jh  t_class_room  → (building_id, room_no)
 *     job t_job_dorm    → (dorm_no)
 *   统一侧 `(building_id, dorm_no, room_no, edu_stage)` 同时还原两者：
 *     jh 行：building_id 非空 → (楼,房号,学段) 唯一 ✓
 *     job 行：building_id 为 NULL（job 老表用 building 字符串列，无 id）→
 *             MySQL 唯一索引含 NULL 不参与去重 → job 行靠业务层保证（P6 可再补），
 *             但至少不会误拦。
 *
 * 【幂等】按新列集判断；旧 (room_no, dorm_no, edu_stage) 存在则先删再建。
 * 【回滚】down 恢复旧窄键（前提：无同楼同房号数据）。
 */

const TABLE = 't_uni_dorm_room';
const INDEX = 'uk_dorm_room';
const NEW_COLS = ['building_id', 'dorm_no', 'room_no', 'edu_stage'];
const OLD_COLS = ['room_no', 'dorm_no', 'edu_stage'];

const SCHEMA = (knex) => knex.client.config.connection.database || 'sms_common';

async function indexCols(knex) {
  const rows = await knex('information_schema.STATISTICS')
    .select('COLUMN_NAME as cn')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', TABLE)
    .where('INDEX_NAME', INDEX)
    .orderBy('SEQ_IN_INDEX');
  return rows.map((r) => r.cn || r.CN);
}

const up = async function (knex) {
  const cur = await indexCols(knex);
  if (cur.length && cur.join(',') === NEW_COLS.join(',')) {
    console.log(`  · ${INDEX} 已是新口径 (${cur.join(', ')})，跳过`);
    return;
  }
  if (cur.length) {
    console.log(`  · ${INDEX} 现为 (${cur.join(', ')}) → 删除后按新口径重建`);
    await knex.raw(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${INDEX}\``);
  }
  await knex.raw(
    `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`${INDEX}\` (${NEW_COLS.map((c) => `\`${c}\``).join(', ')})`,
  );
  const after = await indexCols(knex);
  if (after.join(',') !== NEW_COLS.join(',')) throw new Error('重建后自检失败，已中止');
  console.log(`  ✔ ${INDEX} 已加宽为 (${NEW_COLS.join(', ')})`);
};

const down = async function (knex) {
  const cur = await indexCols(knex);
  if (!cur.length) {
    console.log('  · 无需回滚');
    return;
  }
  if (cur.join(',') === OLD_COLS.join(',')) {
    console.log('  · 已是旧口径，跳过');
    return;
  }
  await knex.raw(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${INDEX}\``);
  await knex.raw(
    `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`${INDEX}\` (${OLD_COLS.map((c) => `\`${c}\``).join(', ')})`,
  );
  console.log(`  ✔ 已恢复旧口径 (${OLD_COLS.join(', ')})`);
};

module.exports = { up, down };
