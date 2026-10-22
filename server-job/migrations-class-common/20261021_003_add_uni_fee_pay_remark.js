/**
 * 迁移：统一缴费表 t_uni_fee 补 `pay_remark`
 * ============================================================
 * 【为什么】
 *   2026-10-21 的「催费单登记缴费」功能会写 pay_remark（缴费备注：转账单号 / 说明），
 *   但那一版迁移只改了老表 t_job_fee_call（`migrations/20261021_001`）。
 *   P8 之后读写都走 t_uni_fee（sms_common），缺这一列 → 登记缴费直接报
 *   「数据库字段不存在」。
 *
 * 【口径】
 *   t_uni_fee 已有的同义列别混用：
 *     · remark      → 催缴备注（call_reason/handle_remark 那一路）
 *     · pay_remark  → 缴费时的备注（本次新增，与老表同名同义）
 */

const TABLE = 't_uni_fee';

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, 'pay_remark')) return;
  await knex.schema.alterTable(TABLE, (t) => {
    t.string('pay_remark', 200).comment('缴费备注（转账单号 / 说明）');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'pay_remark'))) return;
  await knex.schema.alterTable(TABLE, (t) => t.dropColumn('pay_remark'));
};
