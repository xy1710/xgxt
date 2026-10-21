/**
 * 把「一张凭证挂了多张单据」的存量数据，合并成一张合计单。
 *
 * ============================================================
 * 为什么要做
 * ============================================================
 * 用户口径（2026-10-19）：
 *   「只要一张凭证就是交的总金额，只不过总金额下边列了小列，包括的是什么。」
 *
 * 改造前有两条路径会按「一个费用类型一张单」建单：
 *   ① 合并单改造之前的老数据（学费/住宿费/押金/… 各一张，共用一张截图）
 *   ② 「转正式 · 一次性缴清」（已改为 createCombinedFees，代码侧不会再产生）
 *
 * 这种结构下，家长只转了一笔钱，系统里却是 6 条记录、6 个凭证位置，
 * 学生档案看起来像「缴了好几次」，财务也要核 6 次。
 *
 * 本脚本按 (student_id, voucher_url) 找共用凭证的分组，合并成：
 *   1 张单 · 金额 = 各项之和（= 凭证金额）· item_detail = 各项明细
 *
 * ============================================================
 * 安全约束（任何一条不满足就跳过该组，不动数据）
 * ============================================================
 *   · 组内已核对 / 已入账 → 跳过（不能改已入账凭证）
 *   · 只有 1 张单 → 不用合
 *   · 全部在同一个学生名下（分组键已保证）
 *
 * 用法：
 *   node scripts/merge-voucher-fee-groups.mjs --dry-run   # 只看，不改
 *   node scripts/merge-voucher-fee-groups.mjs --apply     # 真正执行
 */

import mysql from 'mysql2/promise';

const DRY = !process.argv.includes('--apply');

const FEE_TYPE_NAME = {
  1: '学费',
  2: '住宿费',
  3: '餐费',
  4: '保险费',
  5: '试学费',
  6: '押金',
  7: '校服',
};
const PAY_STATUS_PAID = 2; // 待核对（= PayStatus.PAID，见 shared-types/finance/enums.ts）

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456',
  charset: 'utf8mb4',
};

const yuan = (cent) => (Number(cent) / 100).toFixed(2);

async function main() {
  const conn = await mysql.createConnection(DB);
  console.log(DRY ? '=== DRY RUN（不会改数据）===' : '=== APPLY（会改数据）===');

  const [groups] = await conn.query(
    `select student_id, student_name, voucher_url, count(*) cnt, sum(amount) total
       from sms_finance.t_finance_fee
      where is_deleted = 0 and voucher_url is not null and voucher_url <> ''
      group by student_id, student_name, voucher_url
     having cnt > 1
      order by cnt desc`,
  );

  if (!groups.length) {
    console.log('没有需要合并的分组（一张凭证只挂一张单）。');
    await conn.end();
    return;
  }

  console.log(`发现 ${groups.length} 组共用凭证的缴费单\n`);

  for (const g of groups) {
    const [rows] = await conn.query(
      `select * from sms_finance.t_finance_fee
        where is_deleted = 0 and student_id = ? and voucher_url = ?
        order by amount desc, create_time asc, id asc`,
      [g.student_id, g.voucher_url],
    );

    console.log('--------------------------------------------------');
    console.log(`${g.student_name}  ${g.voucher_url}`);
    rows.forEach((r) =>
      console.log(
        `   · ${FEE_TYPE_NAME[r.fee_type] || r.fee_type}  ¥${yuan(r.amount)}  ` +
          `ps=${r.pay_status} 核对=${r.is_verified} 入账=${r.is_in_bill}`,
      ),
    );

    // ---- 安全校验 ----
    if (rows.some((r) => r.is_verified || r.is_in_bill)) {
      console.log('   ⏭  跳过：组内已有核对/入账的单据，不能合并');
      continue;
    }
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    if (total !== Number(g.total)) {
      console.log('   ⏭  跳过：金额汇总异常');
      continue;
    }

    const main = rows[0];
    const others = rows.slice(1);
    const items = rows.map((r) => ({
      feeType: Number(r.fee_type),
      feeTypeName: FEE_TYPE_NAME[r.fee_type] || '',
      amount: Number(r.amount),
      standardAmount: Number(r.amount),
      discount: 0,
    }));
    const detailText = items.map((i) => `${i.feeTypeName}${yuan(i.amount)}`).join('/');

    console.log(
      `   → 合并为 1 张：主单 ${
        FEE_TYPE_NAME[main.fee_type] || main.fee_type
      }，金额 ¥${yuan(total)}，含 ${items.length} 项`,
    );
    console.log(`     分项：${detailText}`);
    console.log(`     作废其余 ${others.length} 张`);

    if (DRY) continue;

    /* ================= 财务侧 ================= */
    await conn.beginTransaction();
    try {
      await conn.query(
        `update sms_finance.t_finance_fee
            set amount = ?, item_detail = ?, pay_status = ?, update_time = now(),
                remark = concat(coalesce(remark,''), ?)
          where id = ?`,
        [
          total,
          JSON.stringify(items),
          // 有凭证、未核对 → 待核对（历史数据里有 ps=2 未核对的，核对台点不了，一并修正）
          PAY_STATUS_PAID,
          ` · 已合并为合计单（含 ${items.length} 项：${detailText}）`,
          main.id,
        ],
      );

      await conn.query(
        `update sms_finance.t_finance_fee
            set is_deleted = 1, update_time = now(),
                remark = concat(coalesce(remark,''), ?)
          where id in (?)`,
        [` · 已合并进合计单（${main.id}）`, others.map((r) => r.id)],
      );

      /* ================= 咨询侧 ================= */
      const allFinanceIds = rows.map((r) => r.id);
      const [orders] = await conn.query(
        `select id, order_no, finance_fee_id, amount, status
           from sms_consult.t_consult_fee_order
          where is_deleted = 0 and finance_fee_id in (?)`,
        [allFinanceIds],
      );

      const mainOrder = orders.find((o) => o.finance_fee_id === main.id);
      const otherOrders = orders.filter((o) => o.finance_fee_id !== main.id);

      if (mainOrder) {
        await conn.query(
          `update sms_consult.t_consult_fee_order
              set amount = ?, item_detail = ?
            where id = ?`,
          [total, JSON.stringify(items), mainOrder.id],
        );
      }
      if (otherOrders.length) {
        await conn.query(
          `update sms_consult.t_consult_fee_order
              set is_deleted = 1
            where id in (?)`,
          [otherOrders.map((o) => o.id)],
        );
      }

      await conn.commit();
      console.log(
        `   ✅ 完成：财务 1 张 / 咨询 ${
          mainOrder ? '1' : '0'
        } 张；作废财务 ${others.length} 张 / 咨询 ${otherOrders.length} 张`,
      );
    } catch (e) {
      await conn.rollback();
      console.log('   ❌ 失败已回滚：', e.message);
    }
  }

  await conn.end();
  console.log('\n结束。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
