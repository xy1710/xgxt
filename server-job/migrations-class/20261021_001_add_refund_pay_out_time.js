/**
 * 迁移：t_class_refund_apply（大学部退费申请）增加「出款」两列
 * ============================================================
 * ★ 2026-10-21 用户要求：退费模块里**大学**要和初高功能对齐 ——
 *   初高 / 就业的退费单在财务登记出款后有「结束日期（出款时间）」，
 *   大学部那张表原来连这一列都没有 → 前端只能显示「—」，而且
 *   `repo.class.setFinance()` 是个空实现（出款信息只留在审批备注里，等于没落库）。
 *
 *   pay_out_time    财务出款时间（列表「结束日期」列 = 这个字段）
 *   finance_remark  出款备注（财务填写）
 *
 * 对齐口径：
 *   初高用 `t_class_refund.pay_out_time`，就业用 `t_job_refund.refund_time`，
 *   大学本次补 `pay_out_time`，三个库从此同一语义（出款/结案时间）。
 *
 * ⚠️ up()/down() 都先判存在再改：可重复执行、可回滚（项目铁律：down 必须能用）。
 */

const TABLE = 't_class_refund_apply';

/** 列名 → 建列函数（顺序即加列顺序） */
const COLS = [
  ['pay_out_time', (t) => t.datetime('pay_out_time').comment('财务出款时间（列表「结束日期」）')],
  ['finance_remark', (t) => t.string('finance_remark', 500).comment('出款备注（财务填写）')],
];

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  /* ★ P8 之后这些老表已 DROP（统一表是 t_uni_*）：表不在就跳过，
     否则 npm run migrate 会断在 hasColumn 上。 */
  if (!(await knex.schema.hasTable(TABLE))) return;
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
