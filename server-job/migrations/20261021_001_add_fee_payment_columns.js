/**
 * 迁移：t_job_fee_call（就业催费单）增加「登记缴费」五列
 * ============================================================
 * ★ 2026-10-21 用户要求：催费页里**就业**要和初高功能对齐 ——
 *   初高的行能「上传缴费凭证（登记缴费）」、能看到 实缴金额 / 缴费方式 / 缴费日期 / 备注；
 *   就业的催费单原来只有 call_status（1待催缴 2催缴中 3已缴清），
 *   钱「怎么交的、交了多少、哪天交的、有没有凭证」一概没有。
 *
 *   pay_method   缴费方式：1 微信支付 / 2 支付宝 / 3 现金（与初高 t_class_fee 同码）
 *   paid_amount  实缴金额（分），允许与应缴（fee_amount）不同（部分缴）
 *   pay_date     缴费日期
 *   voucher_url  缴费凭证图片（相对地址 /uploads/voucher/xxx.png）
 *   pay_remark   缴费备注
 *
 * 落库口径（见 routes/feeCall.route.ts 的 /voucher）：
 *   登记缴费成功后 `call_status` 置 3（已缴清），并写 handle_time / handle_remark 留痕；
 *   就业原来那套催缴状态码不变，只是补齐「钱怎么交的」这一层事实。
 *
 * ⚠️ up()/down() 都先判存在再改：可重复执行、可回滚（项目铁律：down 必须能用）。
 */

const TABLE = 't_job_fee_call';

/** 列名 → 建列函数（顺序即加列顺序） */
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
