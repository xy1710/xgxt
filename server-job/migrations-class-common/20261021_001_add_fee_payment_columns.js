/**
 * 迁移：t_class_urge_sync（大学催缴副本）增加「登记缴费」五列
 * ============================================================
 * ★ 2026-10-21 用户要求：催费页里**大学**要和初高功能对齐 ——
 *   初高的行能「上传缴费凭证（登记缴费）」、能看到 实缴金额 / 缴费方式 / 缴费日期 / 备注，
 *   大学的催缴行原来这些全没有（表里只有 pay_status / expire_date / amount）。
 *
 *   pay_method   缴费方式：1 微信支付 / 2 支付宝 / 3 现金（与初高 t_class_fee 同码）
 *   paid_amount  实缴金额（分），允许与应缴不同（部分缴）
 *   pay_date     缴费日期（登记时用户选，默认当天，不能选未来）
 *   voucher_url  缴费凭证图片（相对地址 /uploads/voucher/xxx.png）
 *   pay_remark   缴费备注
 *
 * 为什么加列而不复用：
 *   · `fee_type` 是费用科目（学费/住宿费/餐费…），与「微信/支付宝/现金」不是一回事，
 *     混用会把财务对账口径搞乱 —— 所以叫「缴费方式」，单独一列。
 *   · 本表是**上游（财务）推来的只读副本**，这五列是「本模块登记的结果」，
 *     财务下次推同一张单时只写它自己管的那几列，不会冲掉登记信息。
 *
 * ⚠️ up()/down() 都先判存在再改：可重复执行、可回滚（项目铁律：down 必须能用）。
 */

const TABLE = 't_class_urge_sync';

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
    // 倒序删，与加列顺序相反
    for (const name of exist.reverse()) t.dropColumn(name);
  });
};
