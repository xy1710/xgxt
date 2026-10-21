/**
 * 修正存量【分期单】的费用项明细：让「合计行 = 子行金额之和」。
 *
 * ============================================================
 * 为什么要做
 * ============================================================
 * 用户口径（2026-10-19）：
 *   「分期的这里只需要上传一个总金额凭证，总金额下边包括小分支，其他项目金额。」
 *   「总金额就是子金额的总和。」
 *
 * 现象（学生档案 → 缴费单）：
 *   SK20261016-004  第1期  ¥11,000  ← 合计行
 *       学费    ¥28,000
 *       试学费  ¥5,000                  ← 子行加起来 ¥33,000，跟 ¥11,000 对不上
 *
 * 根因：分期每一期建单时，item_detail 直接抄了【整张计划】的费用构成
 *       （installment.service.payStage 里的 `item_detail: plan.item_detail`），
 *       而订单金额是「本期实缴」，两者口径不是一个东西。
 *
 * 修法：按计划各项占比，把【本期金额】分摊到各费用项（最大余额法，整数分），
 *       保证 Σ子项 === 本期金额。代码侧已同步修好（prorateItemDetail），
 *       本脚本只处理在此之前产生的存量单据。
 *
 * ============================================================
 * 跳过的单据（不动数据）
 * ============================================================
 *   · is_deleted = 1 的作废单
 *   · Σ子项 === 金额 的单（本来就是对的）
 *   · 没有 plan_id 的非分期单
 *
 * 用法：
 *   node scripts/fix-installment-item-detail.mjs            # 只看，不改
 *   node scripts/fix-installment-item-detail.mjs --apply    # 真正执行
 */

import mysql from 'mysql2/promise';

const DRY = !process.argv.includes('--apply');

/** 与 fee-order.service.prorateItemDetail 保持同一算法（最大余额法，整数分） */
function prorate(items, stageAmount) {
  const list = (items || []).filter((i) => Number(i?.amount) > 0);
  if (!list.length || !(stageAmount > 0)) return [];
  const total = list.reduce((s, i) => s + Number(i.amount), 0);
  if (total <= 0) return [];
  if (list.length === 1) {
    return [{ ...list[0], amount: stageAmount, standardAmount: stageAmount, discount: 0 }];
  }
  const raw = list.map((i) => (stageAmount * Number(i.amount)) / total);
  const base = raw.map((v) => Math.floor(v));
  let rest = stageAmount - base.reduce((s, v) => s + v, 0);
  const order = raw
    .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  for (const o of order) {
    if (rest <= 0) break;
    base[o.idx] += 1;
    rest -= 1;
  }
  return list.map((i, idx) => ({
    ...i,
    amount: base[idx],
    standardAmount: base[idx],
    discount: 0,
  }));
}

const parse = (raw) => {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};
const yuan = (c) => (Number(c || 0) / 100).toFixed(2);

const c = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '123456',
});

const [rows] = await c.query(`
  select o.id, o.order_no, o.amount, o.item_detail, o.plan_id, o.stage_no, o.status,
         p.item_detail as plan_detail, p.plan_no
  from sms_consult.t_consult_fee_order o
  left join sms_consult.t_consult_installment_plan p on p.id = o.plan_id
  where o.plan_id is not null and o.is_deleted = 0
  order by o.create_time asc`);

let fixed = 0;
let skipped = 0;

for (const r of rows) {
  const cur = parse(r.item_detail);
  const curSum = cur.reduce((s, i) => s + Number(i.amount || 0), 0);
  const amount = Number(r.amount);

  if (cur.length > 1 && curSum === amount) {
    skipped++;
    continue;
  }

  const src = parse(r.plan_detail).length ? parse(r.plan_detail) : cur;
  if (!src.length) {
    console.log(`  · ${r.order_no} 第${r.stage_no}期：没有可用的费用项来源，跳过`);
    skipped++;
    continue;
  }

  const next = prorate(src, amount);
  const nextSum = next.reduce((s, i) => s + Number(i.amount), 0);
  if (nextSum !== amount) {
    console.log(`  ! ${r.order_no}：分摊后合计 ${yuan(nextSum)} ≠ 金额 ${yuan(amount)}，跳过`);
    skipped++;
    continue;
  }

  console.log(
    `${DRY ? '[dry] ' : '[apply] '}${r.order_no} 第${r.stage_no}期 ¥${yuan(amount)}` +
      `\n        原：${cur.map((i) => `${i.feeTypeName} ¥${yuan(i.amount)}`).join(' + ') || '（空）'} = ¥${yuan(curSum)}` +
      `\n        新：${next.map((i) => `${i.feeTypeName} ¥${yuan(i.amount)}`).join(' + ')} = ¥${yuan(nextSum)}`,
  );

  if (!DRY) {
    await c.query('update sms_consult.t_consult_fee_order set item_detail = ? where id = ?', [
      JSON.stringify(next),
      r.id,
    ]);
  }
  fixed++;
}

console.log(
  `\n${DRY ? '预览' : '完成'}：需修正 ${fixed} 张，跳过 ${skipped} 张` +
    (DRY ? '（加 --apply 才会真正写入）' : ''),
);

await c.end();
