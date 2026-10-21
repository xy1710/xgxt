/**
 * 自检：催费页「批量上传到财务缴费管理」（2026-10-20 用户要求）
 * ============================================================
 * 【需求（用户原话）】上传缴费金额默认为应缴金额；整体有一个「批量上传到财务缴费管理」的按钮，
 *   点开后有「全选」「只选未上传过」，也可以在序号前用复选框点选，把凭证信息转交给财务。
 *
 * 【落地口径】
 *   · 「转交」= 在财务 `sms_finance.t_finance_fee` 里**生成对应的缴费单**（凭证/实缴金额/缴费日期/备注），
 *     走财务自己的 `addFee()`，凭证唯一性等规则不在本模块重写；
 *   · 转交成功后回写 `t_class_fee.source_system='finance' + source_id`，
 *     既表示「已转交」（transferred），也保证财务后续同步不会多出一条；
 *   · 已转交 / 未登记缴费 / 非初高 的单会被**跳过**（返回 skip 原因），不算失败；
 *   · 实缴金额写进财务的 amount；缴费方式财务表没有列 → 拼进财务 remark（现金另外标注无凭证）。
 *
 * 【钉住什么】
 *   A. 静态：接口/校验/财务 addFee 复用/前端弹窗（全选、只选未上传过、selection 在序号前）
 *   B. live：造 2 行已登记夹具 → 转交 → 财务表真出现 2 条（金额/状态/凭证/备注对得上）、
 *      台账回写 source_id、重复转交被跳过、未登记单被跳过、空数组报错、候选项带 transferred
 *   C. 清理：逻辑删除台账夹具 + 财务侧新建单
 *
 * 【跑法】在 server-job 目录下（后端 8004 / 前端 5173 已运行）：
 *     node scripts/_test-fee-transfer-finance.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

/** 夹具前缀 */
const P = 'testtr-';
const FIX_A = `${P}a`; // 微信支付 + 有凭证
const FIX_B = `${P}b`; // 现金 + 无凭证
const FIX_C = `${P}c`; // 没登记缴费（应被跳过）

const dayOffset = (n) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const nowText = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 记录财务侧本次新建的单，收尾逻辑删除 */
const createdFinanceIds = [];

function baseRow(over = {}) {
  return {
    create_time: nowText(),
    is_deleted: 0,
    student_id: `${P}stu`,
    student_no: `${P}NO`,
    student_name: '转交测试生',
    class_id: null,
    class_name: null,
    dept_code: 1,
    fee_type: 1,
    fee_amount: 100000,
    pay_status: 2,
    pay_date: null,
    expire_date: dayOffset(-1),
    voucher_url: null,
    source_system: 'local',
    source_id: null,
    period: null,
    pay_method: null,
    paid_amount: null,
    pay_remark: null,
    ...over,
  };
}

(async () => {
  let dbJh = null;
  let dbFin = null;
  try {
    /* ================= A. 静态契约 ================= */
    const route = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');
    const api = read('web-job', 'src', 'class-jh', 'api', 'fee.ts');
    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');
    const types = read('shared-types', 'src', 'class-jh', 'api', 'fee.api.ts');

    check(
      '① 后端：候选接口只取「已登记缴费」的初高单',
      /'\/transfer\/candidates'/.test(route) && /whereNotNull\('pay_method'\)\.orWhereNotNull\('paid_amount'\)/.test(route),
    );
    check(
      '① 后端：一次最多 200 条 + 空数组报「请先勾选」',
      /\.max\(200, '一次最多转交 200 条'\)/.test(route) && /\.min\(1, '请先勾选要转交的记录'\)/.test(route),
    );
    check(
      '① 后端：复用财务 addFee（凭证唯一性等规则不重写）',
      /import \{ addFee as financeAddFee \} from '\.\.\/\.\.\/finance\/services\/fee\.service'/.test(route) &&
        /await financeAddFee\(/.test(route),
    );
    check(
      '① 后端：跳过条件齐全（不存在 / 非初高 / 未登记 / 已转交）',
      ['缴费单不存在', '只有初高的缴费单能转交财务', '还没登记缴费', '已转交过财务'].every((m) => route.includes(m)),
    );
    check(
      '① 后端：转交后回写 source_system=finance + source_id（幂等、防重复建单）',
      /source_system: 'finance',\s*\n\s*source_id: financeFeeId/.test(route),
    );
    check(
      '① 后端：实体带 transferred（前端「只选未上传过」靠它）',
      /transferred: r\.source_system === 'finance' && !!r\.source_id/.test(route),
    );
    check('① 类型：FeeTransferPayload / FeeTransferResult 已定义', /interface FeeTransferPayload/.test(types) && /interface FeeTransferResult/.test(types));

    check(
      // 默认视图是「全部部门」，所以按钮不能只给初高显示（用户第一版就是因此看不见）
      '② 前端：筛选行（重置后面）有「批量上传到财务」，全部部门视图也可见',
      /批量上传到财务/.test(feeList) &&
        /@click="openTransfer"/.test(feeList) &&
        /v-if="query\.dept === 'jh' \|\| query\.dept === 'all'"/.test(feeList),
    );
    check(
      '② 前端弹窗：全选 / 只选未上传过 两个按钮都在',
      /selectAllTransfer/.test(feeList) && /只选未上传过/.test(feeList),
    );
    // 只看转交弹窗那一段（主列表也有 type="index"，全局下标比会误判）
    const tStart = feeList.indexOf('title="批量上传到财务缴费管理"');
    const transferBlock = tStart >= 0 ? feeList.slice(tStart, feeList.indexOf('</el-dialog>', tStart)) : '';
    check(
      '② 前端弹窗：复选框列在序号之前（type="selection" 早于 type="index"）',
      transferBlock.indexOf('type="selection"') > 0 &&
        transferBlock.indexOf('type="selection"') < transferBlock.indexOf('type="index"'),
    );
    check(
      '② 前端弹窗：有「转交状态 / 凭证」两列，能看出谁传过、谁转交过',
      /label="转交状态"/.test(feeList) && /label="凭证"/.test(feeList) && /row\.transferred/.test(feeList),
    );
    check(
      '② 前端：提交时自动跳过已转交的（不靠人眼）',
      /const targets = transferSelected\.value\.filter\(\(r\) => !r\.transferred\)/.test(feeList),
    );
    check(
      '③ 上传缴费金额默认带出「应缴金额」',
      /paymentForm\.amountYuan = Number\(\(row\.feeAmount \|\| 0\) \/ 100\)/.test(feeList),
    );
    check('③ 接口层：fetchTransferCandidates / transferFees 已挂上', /fetchTransferCandidates/.test(api) && /transferFees/.test(api));

    check(
      '块注释安全：改动的 4 个文件里没有 **/',
      [route, api, feeList, types].every((s) => !s.includes('**/')),
    );

    /* ================= B. live ================= */
    let token = '';
    let who = '';
    for (const acc of ['sunmin', 'qiansy']) {
      const t = await login(acc);
      if (!t) continue;
      const probe = await req(`${BASE}/api/class-jh/fee/transfer`, { method: 'POST', token: t, timeout: 15000, body: { feeIds: ['__probe__'] } });
      // 不存在的 id 会走「跳过」，说明权限已通过
      if (probe.json?.code === 200 || probe.json?.data?.skipped) {
        token = t;
        who = acc;
        break;
      }
    }
    check('拿到有转交权限的账号（live 前置）', !!token, who || 'sunmin / qiansy 都无权 → 下面必然红');
    if (!token) throw new Error('无可用账号，live 段无法继续');

    dbJh = conn('sms_class_jh');
    dbFin = conn('sms_finance');

    const rows = [
      baseRow({
        id: FIX_A,
        student_no: `${P}NOA`,
        pay_method: 1, // 微信支付
        paid_amount: 123456,
        pay_date: dayOffset(0),
        pay_remark: '自检-转账单号 WX999',
        voucher_url: `/uploads/voucher/${P}a.png`,
      }),
      baseRow({
        id: FIX_B,
        student_no: `${P}NOB`,
        pay_method: 3, // 现金
        paid_amount: 90000,
        pay_date: dayOffset(-1),
        pay_remark: null,
        voucher_url: null,
      }),
      baseRow({ id: FIX_C, student_no: `${P}NOC`, pay_method: null, paid_amount: null, pay_date: null }),
    ];
    for (const r of rows) {
      const exists = await dbJh('t_class_fee').where({ id: r.id }).first('id');
      if (exists) await dbJh('t_class_fee').where({ id: r.id }).update(r);
      else await dbJh('t_class_fee').insert(r);
    }
    check('★ 造了 3 行夹具（微信+凭证 / 现金无凭证 / 未登记）', true);

    const cand = await req(`${BASE}/api/class-jh/fee/transfer/candidates`, { token, timeout: 20000 });
    const candRows = cand.json?.data || [];
    const candIds = candRows.map((r) => r.feeId);
    check(
      '★ 候选列表：含已登记的 A/B，不含未登记的 C',
      cand.json?.code === 200 && candIds.includes(FIX_A) && candIds.includes(FIX_B) && !candIds.includes(FIX_C),
      `候选 ${candRows.length} 条`,
    );
    check(
      '★ 候选行带 transferred 标记（新夹具应为 false）',
      candRows.find((r) => r.feeId === FIX_A)?.transferred === false,
    );

    const res = await req(`${BASE}/api/class-jh/fee/transfer`, {
      method: 'POST',
      token,
      timeout: 40000,
      body: { feeIds: [FIX_A, FIX_B, FIX_C] },
    });
    const r1 = res.json?.data || {};
    check(
      '★ 转交：A/B 成功、C 被跳过（未登记缴费）',
      res.json?.code === 200 && r1.success === 2 && r1.failed?.length === 0 && r1.skipped?.some((x) => x.feeId === FIX_C),
      `success=${r1.success} skipped=${r1.skipped?.length} failed=${r1.failed?.length}` +
        (r1.failed?.length ? ` 原因：${r1.failed.map((x) => `${x.feeId.slice(-8)}=${x.reason}`).join('；')}` : ''),
    );

    const aRow = await dbJh('t_class_fee').where({ id: FIX_A }).first();
    const bRow = await dbJh('t_class_fee').where({ id: FIX_B }).first();
    check(
      '★ 台账回写：source_system=finance 且 source_id 有值（= 已转交）',
      aRow?.source_system === 'finance' && !!aRow?.source_id && bRow?.source_system === 'finance' && !!bRow?.source_id,
      `A=${aRow?.source_system}/${aRow?.source_id?.slice(0, 8)} B=${bRow?.source_system}/${bRow?.source_id?.slice(0, 8)}`,
    );
    if (aRow?.source_id) createdFinanceIds.push(String(aRow.source_id));
    if (bRow?.source_id) createdFinanceIds.push(String(bRow.source_id));

    const finA = await dbFin('t_finance_fee').where({ id: String(aRow?.source_id) }).first();
    const finB = await dbFin('t_finance_fee').where({ id: String(bRow?.source_id) }).first();
    check(
      '★ 财务侧真的生成了单据：金额=实缴、状态=待核对(2)、凭证带过去',
      Number(finA?.amount) === 123456 &&
        Number(finA?.pay_status) === 2 &&
        finA?.voucher_url === aRow?.voucher_url &&
        Number(finA?.dept_code) === 1,
      JSON.stringify({ amount: finA?.amount, status: finA?.pay_status, voucher: finA?.voucher_url }),
    );
    check(
      '★ 现金单：无凭证也转交成功，备注里写明「现金收取，无凭证」',
      Number(finB?.amount) === 90000 && String(finB?.remark || '').includes('现金') && String(finB?.remark || '').includes('无凭证'),
      `备注=${finB?.remark}`,
    );
    check(
      '★ 微信单备注带缴费方式（财务表没有 pay_method 列，方式只能写在备注里）',
      String(finA?.remark || '').includes('微信支付'),
      `备注=${finA?.remark}`,
    );
    check(
      '★ 财务单据带学号/姓名，财务能对上是谁交的',
      finA?.student_no === `${P}NOA` && finA?.student_name === '转交测试生',
      `${finA?.student_no} ${finA?.student_name}`,
    );

    /* ---- 重复转交：应被跳过，不会再建一张单 ---- */
    const res2 = await req(`${BASE}/api/class-jh/fee/transfer`, {
      method: 'POST',
      token,
      timeout: 30000,
      body: { feeIds: [FIX_A] },
    });
    const r2 = res2.json?.data || {};
    const finCount = await dbFin('t_finance_fee').where({ id: String(aRow?.source_id) }).count({ n: '*' });
    check(
      '★ 重复转交 → 跳过「已转交过财务」，财务侧不会多出一张单',
      r2.success === 0 && r2.skipped?.some((x) => x.reason.includes('已转交')),
      `success=${r2.success} skipped=${JSON.stringify(r2.skipped)}`,
    );
    check('★ 财务侧那条单仍是唯一一条', Number(finCount?.[0]?.n) === 1, `count=${finCount?.[0]?.n}`);

    /* ---- 入参校验 ---- */
    const empty = await req(`${BASE}/api/class-jh/fee/transfer`, { method: 'POST', token, timeout: 15000, body: { feeIds: [] } });
    check('★ 不勾任何行直接提交 → 被拒（请先勾选）', empty.json?.code !== 200, `code=${empty.json?.code} msg=${empty.json?.message || ''}`);

    /* ---- 前端编译产物 ---- */
    const fe = await req(`${BASE}/src/class-jh/views/FeeList.vue`, { timeout: 15000 });
    check(
      '★ 催费页编译通过，且产物里有「批量上传到财务」「只选未上传过」',
      fe.status === 200 && fe.raw.includes('批量上传到财务') && fe.raw.includes('只选未上传过'),
      `status=${fe.status} len=${fe.raw.length}`,
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    if (dbJh) {
      try {
        await dbJh('t_class_fee').whereIn('id', [FIX_A, FIX_B, FIX_C]).update({ is_deleted: 1 });
        console.log('（已逻辑删除 3 行初高夹具）');
      } catch (e) {
        console.log(`（初高夹具清理失败：${e?.message || e}）`);
      }
      await dbJh.destroy();
    }
    if (dbFin) {
      try {
        if (createdFinanceIds.length) {
          await dbFin('t_finance_fee').whereIn('id', createdFinanceIds).update({ is_deleted: 1 });
          console.log(`（已逻辑删除财务侧自检建的 ${createdFinanceIds.length} 条缴费单）`);
        }
      } catch (e) {
        console.log(`（财务单据清理失败：${e?.message || e}）`);
      }
      await dbFin.destroy();
    }
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
