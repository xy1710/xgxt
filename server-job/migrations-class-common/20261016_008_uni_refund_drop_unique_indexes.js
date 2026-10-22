/**
 * 第 4 期 · 阶段 2 收口（#24 适配退款套件时实锤）：**废弃 `t_uni_refund.uk_refund`
 * 与 `t_uni_refund_item.uk_refund_item` 两个凭空加的唯一索引**
 * ============================================================
 *
 * 【★★ 结论先行】
 *   把 `uk_refund(apply_no, edu_stage)` 与 `uk_refund_item(refund_id, fee_type, edu_stage)`
 *   **整个删掉**，不再补任何索引（现状普通索引已覆盖查询）。
 *
 * 【为什么要删 —— 违反铁律⑧「唯一索引不能凭空加」，且已产生真实故障】
 *   `scripts/_uni-uniquekey-audit.mjs`（正向高危清单）早已标注：
 *     ■ t_uni_refund          老表源（class_refund_apply / job_refund / class_jh.refund）
 *                             → **三张老表都只有 PRIMARY**，uk_refund 是凭空加的；
 *     ■ t_uni_refund_item     老表 t_class_refund_item 也只有 PRIMARY。
 *
 *   ★ 实锤复现（2026-10-16，`_e2e-refund-check` 开关开跑出 `ER_DUP_ENTRY`）：
 *     `apply_no` 只有大学部路径会生成（`repo.class.ts::buildApplyNo()`，注释自称「天然避重」）；
 *     **初高（repo.classJh.ts）与实训（repo.job.ts）路径根本不写 apply_no** → 落库默认 `''`。
 *     而 uk_refund 的第一列就是 apply_no → **同学段第二条初高/实训退费必撞键**，
 *     即：开关开模式下实训退费只能创建一条，第二条直接 500。
 *     （自检库里已经躺了两条撞出来的孤儿行，见迁移前的手工清理。）
 *
 *   `uk_refund_item(refund_id, fee_type, edu_stage)` 同理：
 *     老表允许同一张退费单里出现两个同 `fee_type` 的费用项（分两次退学费是正常业务），
 *     统一侧会被误拦。
 *
 * 【与 #20（uk_exam）同一判例】
 *   铁律⑧ + 「开关关/开关开行为不对称」：老表无约束 → 统一表也不能凭空加；
 *   行为一致性由应用层负责（apply_no 用 TF+日期+5 位随机，业务上够用；
 *   真要做强校验，应等 P5/P6 统一「三条写路径都生成单号」后再议）。
 *
 * 【幂等】索引不存在 → 打印一行直接返回。
 * 【回滚】down 能重建（前提是存量数据无分组重复）。
 */

const TARGETS = [
  { table: 't_uni_refund', index: 'uk_refund', cols: ['apply_no', 'edu_stage'] },
  { table: 't_uni_refund_item', index: 'uk_refund_item', cols: ['refund_id', 'fee_type', 'edu_stage'] },
];

const SCHEMA = (knex) => knex.client.config.connection.database || 'sms_common';

async function tableExists(knex, table) {
  const [rows] = await knex.raw(
    `select count(*) as n from information_schema.tables where table_schema=? and table_name=?`,
    [SCHEMA(knex), table],
  );
  const r = Array.isArray(rows) ? rows[0] : rows;
  return !!(r && Number(r.n) > 0);
}

async function indexInfo(knex, table, name) {
  const rows = await knex('information_schema.STATISTICS')
    .select('COLUMN_NAME as cn', 'NON_UNIQUE as nu')
    .where('TABLE_SCHEMA', SCHEMA(knex))
    .where('TABLE_NAME', table)
    .where('INDEX_NAME', name)
    .orderBy('SEQ_IN_INDEX');
  if (!rows.length) return null;
  return { cols: rows.map((r) => r.cn), unique: Number(rows[0].nu) === 0 };
}

async function up(knex) {
  for (const { table, index, cols } of TARGETS) {
    if (!(await tableExists(knex, table))) {
      console.log(`  · ${SCHEMA(knex)}.${table} 不存在，跳过`);
      continue;
    }
    const cur = await indexInfo(knex, table, index);
    if (!cur) {
      console.log(`  · ${table}.${index} 不存在，已是目标状态，跳过`);
      continue;
    }
    if (!cur.unique) {
      console.log(`  · ${table}.${index} 已是普通索引（Non_unique=1），跳过`);
      continue;
    }
    await knex.raw(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
    const after = await indexInfo(knex, table, index);
    if (after && after.unique) {
      throw new Error(`${table}.${index} 删除后仍为唯一索引，已中止`);
    }
    console.log(`  ✔ 已删除 ${table}.${index}(${cur.cols.join(', ')})`);
  }
}

async function down(knex) {
  for (const { table, index, cols } of TARGETS) {
    if (!(await tableExists(knex, table))) continue;
    const cur = await indexInfo(knex, table, index);
    if (cur) {
      console.log(`  · ${table}.${index} 已存在，无需回滚`);
      continue;
    }
    /* 回滚前确认无分组重复，否则唯一索引建不起来 */
    const dup = await knex
      .select(...cols, knex.raw('COUNT(*) AS n'))
      .from(table)
      .groupBy(...cols)
      .havingRaw('COUNT(*) >= 2');
    if (dup.length) {
      throw new Error(
        `${table} 存在 ${dup.length} 组分组重复数据，无法回滚重建唯一索引，请先清理`,
      );
    }
    await knex.raw(
      `ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${index}\` (${cols.map((c) => `\`${c}\``).join(', ')})`,
    );
    console.log(`  ✔ 已重建 ${table}.${index}(${cols.join(', ')})`);
  }
}

module.exports = { up, down };
