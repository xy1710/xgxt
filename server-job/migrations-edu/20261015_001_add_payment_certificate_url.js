/**
 * 缴费记录：新增「凭证截图地址」
 *
 * ============================================================
 * 背景（2026-10-15 用户反馈）
 * ============================================================
 *   教务侧「上传缴费截图」时，图片只被 OCR 用了一次就丢掉了 ——
 *   数据库里只留了一个 certificate_name（文件名占位，如「凭证-U26001.png」），
 *   图片既没有真正落盘，也没有回传给财务。
 *   结果：**财务在「缴费管理」核对时看不到任何教务上传的凭证**。
 *
 * 本列用来存截图落盘后的相对地址（如 /uploads/voucher/edu_xxx.png），
 * 与财务侧 t_finance_fee.voucher_url **同口径**，可直接互传。
 *
 * 说明：
 *   - 可为空（老数据、批量上传的记录都没有图）
 *   - 与 certificate_name 并存：name 是原始文件名（给人看），url 是实际地址（给页面用）
 */

const TABLE = 't_edu_payment';

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn(TABLE, 'certificate_url');
  if (!has) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('certificate_url', 255)
        .nullable()
        .comment('缴费截图相对地址（教务上传，回传财务核对）');
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn(TABLE, 'certificate_url');
  if (has) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn('certificate_url');
    });
  }
};
