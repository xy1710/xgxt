/**
 * 迁移：t_uni_urge（大学催缴副本的统一表）补「登记缴费」五列
 * ============================================================
 * ★ 2026-10-21 用户要求：催费页里大学要和初高功能对齐（同 20261021_001）。
 *
 * 【为什么统一表也要补】
 *   催缴仓储走 `teaching/shared/uniTable.ts` 的路由层：
 *   `TEACHING_UNI_TABLE=1` 时 `t_class_urge_sync` 会映射成统一表 `t_uni_urge`。
 *   只给老表加列的话，一切到统一表模式，登记缴费的五列会被
 *   `uniUpdCols()`（按目标表现有列过滤）**静默丢掉** —— 界面看着成功、库里没写。
 *   现在两张表都补齐，切换开关时行为一致。
 *
 * ⚠️ up()/down() 都先判表/列存在再改：可重复执行、可回滚（项目铁律：down 必须能用）。
 */

const TABLE = 't_uni_urge';

/** 列名 → 建列函数（与 20261021_001 的老表完全同名同义） */
const COLS = [
  ['pay_method', (t) => t.integer('pay_method').comment('缴费方式 1微信支付2支付宝3现金')],
  ['paid_amount', (t) => t.bigint('paid_amount').comment('实缴金额（分），允许与应缴金额不同')],
  ['pay_date', (t) => t.date('pay_date').comment('缴费日期')],
  ['voucher_url', (t) => t.string('voucher_url', 255).comment('缴费凭证图片地址')],
  ['pay_remark', (t) => t.string('pay_remark', 200).comment('缴费备注（转账单号/说明）')],
];

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 统一表可能还没建（老环境）→ 没有表就跳过，别把迁移卡死
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const pending = [];
  for (const [name, def] of COLS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await knex.schema.hasColumn(TABLE, name))) pending.push(def);
  }
  if (!pending.length) return;
  await knex.schema.alterTable(TABLE, (t) => {
    for (const def of pending) def(t);
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const exist = [];
  for (const [name] of COLS) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn(TABLE, name)) exist.push(name);
  }
  if (!exist.length) return;
  await knex.schema.alterTable(TABLE, (t) => {
    for (const name of exist.reverse()) t.dropColumn(name);
  });
};
