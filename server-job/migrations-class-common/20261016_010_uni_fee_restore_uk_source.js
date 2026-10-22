/**
 * 第 4 期 · 阶段 4（P5 搬迁配套，#21 分档执行）：**补回 `t_uni_fee.uk_fee_source`**
 * ============================================================
 *
 * 【背景 —— #21 拍板「并入 P5 按风险分档补唯一键」】
 *   老表 `sms_class_jh.t_class_fee.uk_fee_source(source_system, source_id)` 在统一表侧丢失，
 *   `finance/services/class-sync.ts::syncFeeToJh()` 的 `onConflict(['source_system','source_id']).merge()`
 *   靠它幂等 —— 没有它，upsert 静默退化成普通 INSERT → 财务推送重复时插出重复费用单。
 *   这是 19 处反向唯一键里**唯一有真实 `onConflict` 使用方**的一处 → 高档，本轮补。
 *
 * 【与老表键的差异：加了 edu_stage】
 *   统一表是多学段合一（jh/class/job），不同学段的理论上可能同 source_id；
 *   (source_system, source_id, edu_stage) 既保住「同学段内不重复」的原始语义，
 *   又不会跨学段误吞。（product 写入时 edu_stage 必填 NOT NULL，三元组总是完整。）
 *
 * 【另外 3 张 *_sync（dorm_room / dorm_live / urge）本轮不加】
 *   实测它们是 **edu 教务域外部推送**的落地表（room_sync.building_id EDU-BLD-* 不在任何原生楼栋表、
 *   live/urge 的学生不在任何学生表）→ 搬迁时 edu_stage 无法可靠推断（见 _uni-migrate-p5.mjs 的跳过清单），
 *   表没数据时加 uk 无验证价值 → 随 P6「外部同步缓冲去向」拍板一起补。
 *
 * 【幂等】索引已存在（不论唯一/普通）→ 跳过。
 * 【回滚】down 删除该索引。
 */

const TABLE = 't_uni_fee';
const INDEX = 'uk_fee_source';
const COLS = ['source_system', 'source_id', 'edu_stage'];

const SCHEMA = (knex) => knex.client.config.connection.database || 'sms_common';

async function indexInfo(knex) {
  const rows = await knex('information_schema.STATISTICS')
    .select('COLUMN_NAME as cn', 'NON_UNIQUE as nu')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', TABLE)
    .where('INDEX_NAME', INDEX)
    .orderBy('SEQ_IN_INDEX');
  if (!rows.length) return null;
  const list = rows.map((r) => ({ cn: r.cn || r.CN, nu: r.nu !== undefined ? r.nu : r.NU }));
  return { cols: list.map((x) => x.cn), unique: Number(list[0].nu) === 0 };
}

const up = async function (knex) {
  const cur = await indexInfo(knex);
  if (cur) {
    console.log(`  · ${INDEX} 已存在 (${cur.cols.join(', ')}，unique=${cur.unique})，跳过`);
    if (!cur.unique) {
      throw new Error(`${INDEX} 已存在但是普通索引，请人工确认后处理（不自动重建）`);
    }
    return;
  }
  await knex.raw(
    `ALTER TABLE \`${TABLE}\` ADD UNIQUE INDEX \`${INDEX}\` (${COLS.map((c) => `\`${c}\``).join(', ')})`,
  );
  const after = await indexInfo(knex);
  if (!after || !after.unique) throw new Error(`${INDEX} 建立后自检失败，已中止`);
  console.log(`  ✔ 已补 ${TABLE}.${INDEX}(${COLS.join(', ')})`);
};

const down = async function (knex) {
  const cur = await indexInfo(knex);
  if (!cur) {
    console.log(`  · ${INDEX} 不存在，无需回滚`);
    return;
  }
  await knex.raw(`ALTER TABLE \`${TABLE}\` DROP INDEX \`${INDEX}\``);
  console.log(`  ✔ 已删除 ${INDEX}`);
};

module.exports = { up, down };
