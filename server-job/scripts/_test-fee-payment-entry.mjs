/**
 * 自检：催费页「登记缴费 / 上传缴费凭证」（2026-10-20 用户要求）
 * ============================================================
 * 【需求（用户原话）】操作列还是要有的，添加一个上传缴费凭证功能，要有
 *   缴费类型（微信支付/支付宝/现金）、缴费金额、缴费时间（默认当天，只能选当天之前）、
 *   备注、缴费截图（图片，能找本地文件夹上传）。
 *
 * 【落地口径】
 *   · 这三个选项本质是**缴费方式**（FeeType 是学费/住宿费，别混）→ 库里单开
 *     `t_class_fee.pay_method`（1微信 2支付宝 3现金）+ `paid_amount`（实缴，分）+ `pay_remark`。
 *   · 上传走 base64（与咨询/财务一致）：前端把本地图片读成 dataURL → 后端落盘
 *     `uploads/voucher/` → 返回相对地址 `/uploads/voucher/xxx.png`。
 *   · 登记成功 = 报缴：未结清（待缴 1 / 逾期 4）→ 已缴 2；已核对的单不动。
 *   · 缴费时间不能晚于今天：前端 disabled-date 拦，后端再兜一次（接口能被直接调）。
 *
 * 【钉住什么】
 *   A. 静态：枚举/迁移/后端校验/前端表单控件/静态代理 全在
 *   B. live：真传一张 1×1 PNG →
 *      ① 落库（way/金额/日期/备注/凭证 URL）② 状态从逾期变已缴
 *      ③ 列表能读回 ④ 图片能通过前端 5173 代理访问 ⑤ 未来日期/0 元/非图片 被拒
 *   C. 清理：逻辑删除夹具 + 删掉自检生成的图片文件
 *
 * 【跑法】在 server-job 目录下（后端 8004 / 前端 5173 已运行）：
 *     node scripts/_test-fee-payment-entry.mjs
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

/** 1×1 透明 PNG（最小的合法图片，避免自检造出大文件） */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/1wAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${PNG_1PX}`;

/** 夹具（初高台账里一行逾期未缴的单） */
const FIX_ID = 'testpay-voucher-01';
const FIX_NO = 'testpay-VNO1';

function dayOffset(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const nowText = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 记录本次上传的文件，收尾时删掉（自检产物，不是业务数据） */
const createdFiles = [];

(async () => {
  let db = null;
  try {
    /* ================= A. 静态契约 ================= */
    const enums = read('shared-types', 'src', 'class-jh', 'enums.ts');
    const migration = read('server-job', 'migrations-class-jh', '20261020_001_add_fee_payment_info.js');
    const route = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');
    const api = read('shared-types', 'src', 'class-jh', 'api', 'fee.api.ts');
    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');
    const viteCfg = read('web-job', 'vite.config.ts');

    check('① 缴费方式枚举：1微信支付 / 2支付宝 / 3现金', /enum PayMethod[\s\S]{0,200}?WECHAT = 1[\s\S]{0,120}?ALIPAY = 2[\s\S]{0,120}?CASH = 3/.test(enums));
    check("① 字典里有「微信支付」「支付宝」「现金」", ['微信支付', '支付宝', '现金'].every((n) => enums.includes(n)));
    check(
      '① 注释讲清「缴费方式 ≠ 缴费类型（学费/住宿费）」—— 别复用 fee_type',
      /FeeType[\s\S]{0,120}?怎么交的/.test(enums) && /不复用|绝不复用/.test(enums),
    );

    check(
      '② 迁移加了三列，且 up/down 都有 hasColumn 守卫（可重复执行、可回滚）',
      ['pay_method', 'paid_amount', 'pay_remark'].every((c) => migration.includes(c)) &&
        (migration.match(/hasColumn/g) || []).length >= 6,
    );

    check(
      '③ 后端校验：方式 1~3 / 金额为正 / 日期格式 / 备注 200 字（截图必填与否见 ⑥，现金可免）',
      /payMethod: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(3/.test(route) &&
        /paidAmount: z\.coerce\.number\(\)\.int\(\)\.positive/.test(route) &&
        /payDate: z\.string\(\)\.regex\(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(route) &&
        /remark: z\.string\(\)\.max\(200/.test(route) &&
        /dataUrl: z\.string\(\)\.optional\(\)/.test(route),
    );
    check(
      '③ 后端兜「缴费时间不能晚于今天」（前端 disabled 只是 UI，接口要自己挡）',
      /body\.payDate > todayStr\(\)/.test(route) && /不能晚于今天/.test(route),
    );
    check(
      '③ 落库写了方式/实缴金额/缴费日期/备注（凭证按需写，现金没有就不动原值）',
      ['pay_method: body.payMethod', 'paid_amount: body.paidAmount', 'pay_date: body.payDate', 'pay_remark: body.remark'].every(
        (f) => route.includes(f),
      ) && /if \(voucherUrl\) updateFields\.voucher_url = voucherUrl/.test(route),
    );
    check(
      '③ 登记即报缴：待缴/逾期 → 已缴，已核对不动',
      /rawStatus === PayStatus\.UNPAID \|\| rawStatus === PayStatus\.OVERDUE[\s\S]{0,120}?PayStatus\.PAID/.test(route),
    );
    check('③ 列表实体输出 payMethodName / paidAmount / payRemark', ['payMethodName', 'paidAmount: r.paid_amount', 'payRemark: r.pay_remark'].every((k) => route.includes(k)));

    check(
      '④ 前端操作列回来了，按钮叫「上传缴费凭证」（已登记过则「重新登记」）',
      /label="操作"/.test(feeList) && feeList.includes('上传缴费凭证') && feeList.includes('重新登记'),
    );
    check(
      '④ 操作列里**没有**催费推送 / 催费记录（这两个仍保持下线）',
      !feeList.includes('催费推送') || !/handleShare|openNotify/.test(feeList),
    );
    check(
      '⑤ 表单五项齐全：缴费方式 / 金额 / 时间 / 备注 / 截图',
      ['label="缴费方式"', 'label="缴费金额"', 'label="缴费时间"', 'label="备注"', 'label="缴费截图"'].every((l) => feeList.includes(l)),
    );
    check(
      '⑤ 缴费时间：默认当天 + 不能选未来（disabled-date）',
      feeList.includes(`paymentForm.payDate = todayStr()`) && feeList.includes(':disabled-date="disabledFutureDate"'),
    );
    check(
      '⑤ 截图是真的「本地选图片」：el-upload 不自动上传 + 只收图片 + 卡片预览',
      /:auto-upload="false"/.test(feeList) && /accept="image\/\*"/.test(feeList) && /list-type="picture-card"/.test(feeList),
    );
    check('⑤ 金额按元录入、两位小数（提交时 ×100 转分）', /:precision="2"/.test(feeList) && /Math\.round\(paymentForm\.amountYuan \* 100\)/.test(feeList));
    check('⑤ 接口类型定义（FeePaymentPayload / FeePaymentResult）', /interface FeePaymentPayload/.test(api) && /interface FeePaymentResult/.test(api));

    check(
      // ★ 2026-10-20 用户要求：点「查看」不只看图片，登记的每一项都要能看到
      '⑥ 查看弹窗展示全部登记信息（学生/项目/方式/金额/时间/备注）+ 截图',
      /el-dialog v-model="voucherViewVisible" title="缴费详情"/.test(feeList) &&
        /el-descriptions v-if="voucherViewRow"/.test(feeList) &&
        ['voucherViewRow.studentNo', 'voucherViewRow.feeTypeName', 'voucherViewRow.payMethodName', 'voucherViewRow.paidAmount', 'voucherViewRow.payDate', 'voucherViewRow.payRemark'].every(
          (f) => feeList.includes(f),
        ) &&
        /viewVoucher\(row\)/.test(feeList),
    );
    check(
      // ★ 2026-10-20 用户要求：现金可以不传截图（微信/支付宝必须传）
      '⑥ 后端：截图必填与否按缴费方式判（现金可不传）',
      /dataUrl: z\.string\(\)\.optional\(\)/.test(route) &&
        /body\.payMethod !== PayMethod\.CASH[\s\S]{0,160}?请上传缴费截图/.test(route) &&
        /if \(voucherUrl\) updateFields\.voucher_url = voucherUrl/.test(route),
    );
    check(
      // 现金可以没有截图，所以「重新登记 / 查看」不能按 voucherUrl 判，得按 hasPayment
      '⑥ 前端：现金登记后（无截图）仍能「查看」详情',
      /function hasPayment\(row: FeeRow\): boolean/.test(feeList) &&
        /hasPayment\(row\) \? '重新登记' : '上传缴费凭证'/.test(feeList) &&
        /v-if="hasPayment\(row\)"/.test(feeList),
    );
    check(
      '⑥ 前端：现金时截图的必填星号消失 + 提交校验放行 + 提示文案切换',
      /:required="paymentForm\.payMethod !== PayMethod\.CASH"/.test(feeList) &&
        /const isCash = paymentForm\.payMethod === PayMethod\.CASH/.test(feeList) &&
        /!isCash && !voucherFile\.value/.test(feeList) &&
        /现金可不传截图/.test(feeList),
    );
    check(
      '⑥ Vite 把 /uploads 代理到后端（否则凭证图片被当路由返回 index.html）',
      /'\/uploads': \{ target: 'http:\/\/localhost:8004'/.test(viteCfg),
    );

    check(
      '块注释安全：改动的 6 个文件里没有 **/',
      [enums, migration, route, api, feeList, viteCfg].every((s) => !s.includes('**/')),
    );

    /* ================= B. live ================= */
    /* 登记缴费走 class:fee:add —— admin 没有（403），用 学管主任 / 校长 */
    let token = '';
    let who = '';
    for (const acc of ['sunmin', 'qiansy']) {
      const t = await login(acc);
      if (!t) continue;
      const probe = await req(`${BASE}/api/class-jh/fee/voucher`, {
        method: 'POST',
        token: t,
        timeout: 15000,
        body: { feeId: '__probe__', payMethod: 1, paidAmount: 100, payDate: dayOffset(0), dataUrl: DATA_URL },
      });
      if (probe.json?.code === 40408 || probe.json?.message?.includes('缴费单不存在')) {
        token = t;
        who = acc;
        break;
      }
    }
    check('拿到有登记缴费权限的账号（live 前置）', !!token, who || 'sunmin / qiansy 都无权 → 下面必然红');
    if (!token) throw new Error('无可用账号，live 段无法继续');

    db = conn('sms_class_jh');
    const now = nowText();
    const fix = {
      id: FIX_ID,
      create_time: now,
      is_deleted: 0,
      student_id: 'testpay-voucher-stu',
      student_no: FIX_NO,
      student_name: '凭证测试生',
      class_id: null,
      class_name: null,
      dept_code: 1,
      fee_type: 2,
      fee_amount: 120000,
      pay_status: 1,
      pay_date: null,
      expire_date: dayOffset(-3),
      voucher_url: null,
      source_system: 'local',
      source_id: 'testpay-voucher-src',
      period: null,
      pay_method: null,
      paid_amount: null,
      pay_remark: null,
    };
    const exists = await db('t_class_fee').where({ id: FIX_ID }).first('id');
    if (exists) await db('t_class_fee').where({ id: FIX_ID }).update(fix);
    else await db('t_class_fee').insert(fix);
    check('★ 造了 1 行夹具（待缴 + 已逾期 3 天，金额 1200 元）', true);

    const url = `${BASE}/api/class-jh/fee/voucher`;
    const body = {
      feeId: FIX_ID,
      payMethod: 1, // 微信支付
      paidAmount: 123456, // 1234.56 元（故意与应缴不同，验证实缴单独存）
      payDate: dayOffset(0),
      remark: '自检-微信转账单号 WX123',
      dataUrl: DATA_URL,
    };
    const res = await req(url, { method: 'POST', token, timeout: 30000, body });
    check('★ 登记缴费 → 成功', res.json?.code === 200, `code=${res.json?.code} msg=${res.json?.message || ''}`);
    const voucherUrl = res.json?.data?.voucherUrl || '';
    if (voucherUrl) createdFiles.push(path.join(process.cwd(), voucherUrl.replace(/^\//, '')));

    const row = await db('t_class_fee').where({ id: FIX_ID }).first();
    check(
      '★ 五项都落库（方式/实缴金额/缴费日期/备注/凭证）',
      Number(row?.pay_method) === 1 &&
        Number(row?.paid_amount) === 123456 &&
        String(row?.pay_date).slice(0, 10) === body.payDate &&
        row?.pay_remark === body.remark &&
        !!row?.voucher_url,
      JSON.stringify({ pay_method: row?.pay_method, paid_amount: row?.paid_amount, pay_date: String(row?.pay_date).slice(0, 10), remark: row?.pay_remark, voucher: row?.voucher_url }),
    );
    check('★ 状态从「待缴(1)」推进到「已缴(2)」', Number(row?.pay_status) === 2, `pay_status=${row?.pay_status}`);
    check(
      '★ 图片文件真的写到 uploads/voucher/（不是只存了个字符串）',
      !!voucherUrl && existsSync(path.join(process.cwd(), voucherUrl.replace(/^\//, ''))),
      voucherUrl,
    );

    const listRes = await req(`${BASE}/api/class-jh/fee/list?keyword=${FIX_NO}&page=1&size=10`, { token, timeout: 20000 });
    const listed = (listRes.json?.data?.list || [])[0];
    check(
      '★ 列表能读回来（方式名「微信支付」、实缴金额、凭证地址）',
      listed?.payMethodName === '微信支付' &&
        Number(listed?.paidAmount) === 123456 &&
        !!listed?.voucherUrl &&
        listed?.payStatusName === '已缴',
      JSON.stringify({ 方式: listed?.payMethodName, 实缴: listed?.paidAmount, 状态: listed?.payStatusName }),
    );

    const imgRes = await req(`${BASE}${voucherUrl}`, { timeout: 15000 });
    check('★ 凭证图片能通过前端 5173 的 /uploads 代理访问', imgRes.status === 200, `status=${imgRes.status}`);

    /* ---- 反例 ---- */
    const future = await req(url, {
      method: 'POST',
      token,
      timeout: 15000,
      body: { ...body, payDate: dayOffset(1) },
    });
    check(
      '★ 缴费时间填明天 → 被拒（提示不能晚于今天）',
      future.json?.code !== 200 && String(future.json?.message || '').includes('不能晚于今天'),
      `code=${future.json?.code} msg=${future.json?.message || ''}`,
    );

    const zero = await req(url, { method: 'POST', token, timeout: 15000, body: { ...body, paidAmount: 0 } });
    check('★ 缴费金额 0 → 被拒', zero.json?.code !== 200, `code=${zero.json?.code} msg=${zero.json?.message || ''}`);

    const badType = await req(url, { method: 'POST', token, timeout: 15000, body: { ...body, payMethod: 9 } });
    check('★ 缴费方式 9 → 被拒', badType.json?.code !== 200, `code=${badType.json?.code} msg=${badType.json?.message || ''}`);

    const notImage = await req(url, { method: 'POST', token, timeout: 15000, body: { ...body, dataUrl: 'data:text/plain;base64,aGVsbG8=' } });
    check(
      '★ 非图片（txt）→ 被拒，提示只支持图片',
      notImage.json?.code !== 200 && String(notImage.json?.message || '').includes('图片'),
      `code=${notImage.json?.code} msg=${notImage.json?.message || ''}`,
    );

    const noFee = await req(url, { method: 'POST', token, timeout: 15000, body: { ...body, feeId: 'not-exist-id' } });
    check('★ 缴费单不存在 → 40408', noFee.json?.code === 40408, `code=${noFee.json?.code} msg=${noFee.json?.message || ''}`);

    /* ---- 现金：不带截图也能登记（用户 2026-10-20 要求） ---- */
    const cashRes = await req(url, {
      method: 'POST',
      token,
      timeout: 20000,
      body: { feeId: FIX_ID, payMethod: 3, paidAmount: 120000, payDate: dayOffset(0), remark: '自检-现金收据' },
    });
    check('★ 现金 + 不传截图 → 也能登记成功', cashRes.json?.code === 200, `code=${cashRes.json?.code} msg=${cashRes.json?.message || ''}`);
    const cashRow = await db('t_class_fee').where({ id: FIX_ID }).first();
    check(
      '★ 现金登记：方式变现金、实缴/备注更新，且原有截图不被清空',
      Number(cashRow?.pay_method) === 3 &&
        Number(cashRow?.paid_amount) === 120000 &&
        cashRow?.pay_remark === '自检-现金收据' &&
        cashRow?.voucher_url === voucherUrl,
      JSON.stringify({ 方式: cashRow?.pay_method, 实缴: cashRow?.paid_amount, 备注: cashRow?.pay_remark, 截图: cashRow?.voucher_url }),
    );

    const wxNoShot = await req(url, {
      method: 'POST',
      token,
      timeout: 15000,
      body: { feeId: FIX_ID, payMethod: 1, paidAmount: 100, payDate: dayOffset(0) },
    });
    check(
      '★ 微信支付 + 不传截图 → 仍然被拒（钱从账上走，必须有凭证）',
      wxNoShot.json?.code !== 200 && String(wxNoShot.json?.message || '').includes('请上传缴费截图'),
      `code=${wxNoShot.json?.code} msg=${wxNoShot.json?.message || ''}`,
    );

    /* ---- 留痕 ---- */
    const log = await db('t_class_op_log').where({ biz_id: FIX_ID, is_deleted: false }).first();
    check('★ 操作日志留痕（bizType=登记缴费）', !!log && String(log.biz_type).includes('登记缴费'), log ? log.biz_type : '没写日志');
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    if (db) {
      try {
        await db('t_class_fee').where({ id: FIX_ID }).update({ is_deleted: 1 });
        console.log('\n（已逻辑删除 1 行自检夹具）');
      } catch (e) {
        console.log(`\n（夹具清理失败，人工处理：${e?.message || e}）`);
      }
      await db.destroy();
    }
    for (const f of createdFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        /* 文件删不掉不影响结论 */
      }
    }
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
