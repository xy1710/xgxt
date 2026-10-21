/**
 * 迁移：t_class_fee 增加「登记缴费」三列（★ 2026-10-20 催费页操作列）
 *
 *   pay_method   缴费方式：1 微信支付 / 2 支付宝 / 3 现金
 *   paid_amount  实缴金额（单位：分；与 fee_amount 应缴金额分开存，允许部分缴）
 *   pay_remark   缴费备注（家长转账单号、说明等，200 字够用）
 *
 * 为什么加列而不是复用：
 *   · `fee_type` 是**费用科目**（学费/住宿费/餐费…），跟「微信/支付宝/现金」不是一回事，
 *     混用会让财务对账口径彻底乱掉 —— 所以叫「缴费方式」，单独一列。
 *   · 表里原来只有 pay_date / voucher_url，缺"怎么交的、交了多少钱、备注"，
 *     登记缴费必须把这三项一起落库，否则事后没法对账。
 *
 * ⚠️ up()/down() 都先判存在再改，保证可重复执行、可回滚（项目铁律：down 必须能用）。
 * ⚠️ 财务侧 `sms_finance.t_finance_fee` **没有** pay_method 列，本次不加（跨模块改表风险大）；
 *    初高台账是登记缴费的写入方，财务那边只反写 voucher_url / pay_date / remark。
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasMethod = await knex.schema.hasColumn('t_class_fee', 'pay_method');
  const hasPaid = await knex.schema.hasColumn('t_class_fee', 'paid_amount');
  const hasRemark = await knex.schema.hasColumn('t_class_fee', 'pay_remark');

  if (!hasMethod || !hasPaid || !hasRemark) {
    await knex.schema.alterTable('t_class_fee', (t) => {
      if (!hasMethod) {
        t.integer('pay_method').comment('缴费方式 1微信支付2支付宝3现金');
      }
      if (!hasPaid) {
        t.integer('paid_amount').comment('实缴金额（分），允许与应缴金额不同（部分缴）');
      }
      if (!hasRemark) {
        t.string('pay_remark', 200).comment('缴费备注（转账单号/说明）');
      }
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const hasMethod = await knex.schema.hasColumn('t_class_fee', 'pay_method');
  const hasPaid = await knex.schema.hasColumn('t_class_fee', 'paid_amount');
  const hasRemark = await knex.schema.hasColumn('t_class_fee', 'pay_remark');

  await knex.schema.alterTable('t_class_fee', (t) => {
    if (hasRemark) t.dropColumn('pay_remark');
    if (hasPaid) t.dropColumn('paid_amount');
    if (hasMethod) t.dropColumn('pay_method');
  });
};
