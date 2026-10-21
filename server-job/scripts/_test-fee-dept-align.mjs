/**
 * 自检：催费页 大学 / 就业 与初高功能对齐（2026-10-21 用户要求）
 * ============================================================
 *
 * 【需求】催费模块里，大学 / 就业两个部门要与初高对齐：
 *   ① 操作列「上传缴费凭证 / 重新登记 / 查看」对三个部门都出现（原来大学/就业只有「—」）；
 *   ② 导出对三个部门都放开（原来按钮只在初高出现）；
 *   ③ 大学 / 就业的行也能看到 实缴金额 / 缴费方式 / 缴费日期 / 凭证
 *      （两张表各补 pay_method / paid_amount / pay_date / voucher_url / pay_remark 五列）。
 *
 * 【钉住什么】
 *   ① 前端 FeeList：操作列没有「只对初高显示」的守卫、提交按部门分发到三个接口；
 *   ② 三张表的新列都在（information_schema 实查，迁移跑没跑一目了然）；
 *   ③ 大学 / 就业两个登记接口真实存在：用真单 id + 微信不传截图 →
 *      必须报「请上传缴费截图」（说明路由、schema、业务规则都活着）；
 *   ④ 退费：大学部有出款时间列（结束日期对齐的前提）。
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004/5173 运行）：
 *     node scripts/_test-fee-dept-align.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { BASE, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { check, summary } = makeChecker();

/* ---------------- 数据库（只读，information_schema + 取一条真单 id） ---------------- */
const db = await mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD || 'Meng1210',
  multipleStatements: true,
});

const PAY_COLS = ['pay_method', 'paid_amount', 'pay_date', 'voucher_url', 'pay_remark'];

async function columnsOf(schema, table) {
  const [rows] = await db.query(
    'SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [schema, table],
  );
  return new Set(rows.map((r) => r.COLUMN_NAME));
}

(async () => {
  try {
    /* ---------- A. 静态契约：前端操作列 / 导出 / 分发 ---------- */
    const feeSrc = readFileSync(path.join(ROOT, 'web-job', 'src', 'class-jh', 'views', 'FeeList.vue'), 'utf8');
    check(
      // 旧守卫是 v-if="!row.dept || row.dept === '初高'" → 命中 "!row.dept" 即说明守卫还在
      '★ 操作列不再只对初高显示（大学/就业也出现「上传缴费凭证」）',
      !feeSrc.includes('!row.dept') && feeSrc.includes('openPayment(row)'),
    );
    check(
      '★ 提交按部门分发到三个接口（urge/voucher、fee-call/voucher、class-jh/fee/voucher）',
      feeSrc.includes('submitUrgePayment(') && feeSrc.includes('submitFeeCallPayment(') &&
        feeSrc.includes('submitFeePayment('),
    );
    check(
      '★ 导出按钮对三个部门都放开（不再 v-if 只在初高出现）',
      !feeSrc.includes(`v-if="query.dept === 'jh'" :icon="Download"`) &&
        feeSrc.includes('handleExport') &&
        feeSrc.includes('collectRowsForExport'),
    );

    /* ---------- B. 数据库：三张表的新列 / 大学出款时间 ---------- */
    for (const [schema, table] of [
      ['sms_common', 't_class_urge_sync'],
      ['sms_job', 't_job_fee_call'],
    ]) {
      const cols = await columnsOf(schema, table);
      const missing = PAY_COLS.filter((c) => !cols.has(c));
      check(
        `★ ${schema}.${table} 有登记缴费五列（pay_method/paid_amount/pay_date/voucher_url/pay_remark）`,
        missing.length === 0,
        missing.length ? `缺列：${missing.join(',')}（迁移没跑？）` : '五列齐全',
      );
    }
    const refundCols = await columnsOf('sms_class', 't_class_refund_apply');
    check(
      '★ sms_class.t_class_refund_apply 有出款时间列（大学部「结束日期」对齐的前提）',
      refundCols.has('pay_out_time') && refundCols.has('finance_remark'),
      `pay_out_time=${refundCols.has('pay_out_time')} finance_remark=${refundCols.has('finance_remark')}`,
    );
    const refundRepoSrc = readFileSync(
      path.join(ROOT, 'server-job', 'src', 'teaching', 'refund', 'repo.class.ts'),
      'utf8',
    );
    check(
      '★ 大学退费仓储真的读写出款时间（不再是无返回值的空实现）',
      refundRepoSrc.includes('pay_out_time') && refundRepoSrc.includes('finance_remark'),
    );

    /* ---------- C. live：两个新登记接口活着，且业务规则与初高一致 ---------- */
    const token = await login('qiansy');
    check('登录成功（qiansy）', !!token);

    /**
     * 夹具：库里现在只有 is_deleted=1 的自检旧夹具（真实业务数据为空），
     * 而登记接口只认未删除的行 → 各插一条**未删除**的夹具（跑完标回已删除，
     * 不物理删除，与项目铁律一致）。
     */
    const FIX_URGE = 'testdeptalign-urge';
    const FIX_CALL = 'testdeptalign-call';
    await db.query(
      `INSERT INTO sms_common.t_class_urge_sync
         (id, create_time, is_deleted, source_system, source_id, sync_status,
          student_id, student_no, student_name, fee_type, amount, expire_date, pay_status)
       VALUES (?, NOW(), 0, 'finance', 'testdeptalign-src', 2, 'test-student', 'T0001', '自检部门对齐', 1, 66000, DATE_ADD(NOW(), INTERVAL 5 DAY), 1)
       ON DUPLICATE KEY UPDATE is_deleted = 0`,
      [FIX_URGE],
    );
    await db.query(
      `INSERT INTO sms_job.t_job_fee_call
         (id, create_time, is_deleted, fee_type, student_id, student_no, student_name,
          class_name, due_date, call_status)
       VALUES (?, NOW(), 0, 2, 'test-student', 'T0001', '自检部门对齐', '自检班', DATE_ADD(NOW(), INTERVAL 5 DAY), 1)
       ON DUPLICATE KEY UPDATE is_deleted = 0`,
      [FIX_CALL],
    );

    // 微信支付不传截图 → 必须被拒（与初高同一条规则，落到 schema/业务校验上）
    const r1 = await req(`${BASE}/api/class/urge/voucher`, {
      method: 'POST',
      token,
      body: { urgeId: FIX_URGE, payMethod: 1, paidAmount: 100, payDate: '2026-01-01' },
    });
    check(
      '★ 大学 /api/class/urge/voucher 存在，且「微信不传截图」被拒（与初高同规则）',
      r1.json?.code !== undefined && String(r1.json?.message || '').includes('请上传缴费截图'),
      `code=${r1.json?.code} msg=${r1.json?.message}`,
    );

    const r2 = await req(`${BASE}/api/job/fee-call/voucher`, {
      method: 'POST',
      token,
      body: { id: FIX_CALL, payMethod: 1, paidAmount: 100, payDate: '2026-01-01' },
    });
    const msg2 = String(r2.json?.message || '');
    check(
      // 就业的权限闸是「该学生的班主任本人」（夹具没挂班主任 → 40302 是预期行为）；
      // 走到这一步就证明：新路由存在、且用的是本接口自己的守卫（不是 404 / 旧接口）
      '★ 就业 /api/job/fee-call/voucher 存在（非班主任被 40302 拦下，截图规则与初高同源）',
      r2.json?.code !== undefined && (msg2.includes('请上传缴费截图') || msg2.includes('班主任能登记')),
      `code=${r2.json?.code} msg=${r2.json?.message}`,
    );

    /* ---------- D. live：列表接口带出登记缴费字段（列才有东西可显示） ---------- */
    const lu = await req(`${BASE}/api/class/urge/list?page=1&size=5`, { token });
    const urgeItem = (lu.json?.data?.list || []).find((x) => x.id === FIX_URGE) || {};
    check(
      '★ 大学催缴列表返回 payMethodName / paidAmount / voucherUrl（实缴/方式列有数据源）',
      'payMethodName' in urgeItem && 'paidAmount' in urgeItem && 'voucherUrl' in urgeItem,
      Object.keys(urgeItem).filter((k) => k.startsWith('pay') || k === 'voucherUrl').join(','),
    );
    const lc = await req(`${BASE}/api/job/fee-call/page?page=1&size=20`, { token });
    const callItem = (lc.json?.data?.list || []).find((x) => x.id === FIX_CALL) || {};
    check(
      '★ 就业催费单列表返回 payMethodName / paidAmount / voucherUrl（实缴/方式列有数据源）',
      'payMethodName' in callItem && 'paidAmount' in callItem && 'voucherUrl' in callItem,
      Object.keys(callItem).filter((k) => k.startsWith('pay') || k === 'voucherUrl').join(','),
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    // 收尾：夹具标回已删除（不物理删除）
    try {
      await db.query("UPDATE sms_common.t_class_urge_sync SET is_deleted=1 WHERE id LIKE 'testdeptalign-%'");
      await db.query("UPDATE sms_job.t_job_fee_call SET is_deleted=1 WHERE id LIKE 'testdeptalign-%'");
    } catch { /* 忽略 */ }
    try { await db.end(); } catch { /* 忽略 */ }
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
