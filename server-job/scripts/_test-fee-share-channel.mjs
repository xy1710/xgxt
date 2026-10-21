/**
 * 自检：催费推送「触达渠道 = 短信 / 微信」+「备注 → 发送内容」（2026-10-20 用户要求）
 * ============================================================
 * 【需求】
 *   催费页签（FeeList.vue）→ 催费推送弹窗：
 *     ① 「触达渠道」下拉原来有 站内消息 / 微信 / 短信 三个，改为**只留 短信 / 微信**；
 *     ② 「备注」改叫「发送内容」—— 就是实际发给家长的那段话。
 *
 * 【钉住什么】
 *   A. 静态契约
 *      ① 可选渠道只有一份口径（SHARE_CHANNEL_PUSH_OPTIONS / _CODES），
 *         且**不含站内消息**（码 1）；但 SHARE_CHANNEL_NAME 里必须留着它 ——
 *         历史催费记录里的渠道名不能变成空白；
 *      ② 前端下拉遍历的是 PUSH_OPTIONS，不是全量的 SHARE_CHANNEL_NAME；
 *      ③ 前端表单字段名 sendContent，界面文案「发送内容」，催费推送里不再有「备注」；
 *      ④ 后端校验与前端同源（PUSH_CODES），并给得出人话的错误提示；
 *      ⑤ 生成文案里不再出现「备注：」前缀 —— 叫发送内容就不是备注了。
 *   B. live（经 5173 代理，后端 8004）
 *      短信 / 微信都能推、站内消息 422/400 被拒、发送内容真的落库、
 *      不填发送内容时不产生空尾巴。
 *
 * 【跑法】在 server-job 目录下（后端 8004 / 前端 5173 已运行）：
 *     node scripts/_test-fee-share-channel.mjs
 *   live 段会写 2 条催费记录，测完按项目铁律**逻辑删除**（is_deleted=1），不物理删。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

/** 本脚本造出来的催费记录 id，测完逻辑删除 */
const createdNotifyIds = [];

(async () => {
  let db = null;
  try {
    /* ================= A. 静态契约 ================= */

    const enums = read('shared-types', 'src', 'class-jh', 'enums.ts');
    const api = read('shared-types', 'src', 'class-jh', 'api', 'fee.api.ts');
    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');
    const route = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');

    check(
      '① 可选渠道常量存在，且只含 短信 / 微信',
      /SHARE_CHANNEL_PUSH_OPTIONS[\s\S]{0,400}?ShareChannel\.SMS[\s\S]{0,200}?ShareChannel\.WECHAT/.test(enums) &&
        !/SHARE_CHANNEL_PUSH_OPTIONS[\s\S]{0,400}?INNER_MESSAGE/.test(enums),
    );
    check(
      '① 站内消息仍留在 SHARE_CHANNEL_NAME 里（历史记录不能显示空白）',
      /SHARE_CHANNEL_NAME[\s\S]{0,200}?INNER_MESSAGE\]: '站内消息'/.test(enums),
    );
    check('① 后端校验用的码表由下拉派生（一处口径两处用，不会写歪）', /SHARE_CHANNEL_PUSH_CODES[^=\n]*=\s*SHARE_CHANNEL_PUSH_OPTIONS\.map/.test(enums));

    /**
     * ★ 2026-10-20 用户要求：催费推送 / 催费记录已下线，**操作列整列去掉**。
     *   接口（/fee/share、/fee/notify/list）与 t_class_fee_notify 表保留
     *   —— 将来接真实短信发送时直接复用这条链路，所以本脚本继续测接口契约；
     *   但页面上不能再有任何入口，否则等于没去掉。
     */
    check(
      '② 催费页已下线催费推送 / 记录入口（操作列改成了「上传缴费凭证」）',
      !feeList.includes('shareForm') &&
        !feeList.includes('SHARE_CHANNEL_PUSH_OPTIONS') &&
        !feeList.includes('shareFee') &&
        !feeList.includes('fetchFeeNotifyList') &&
        !feeList.includes('openNotify'),
      '检查 shareForm / shareFee / fetchFeeNotifyList / openNotify 均已消失',
    );
    check(
      '② 操作列保留但只放登记缴费；导出入口也在',
      /label="操作"/.test(feeList) && feeList.includes('上传缴费凭证') && feeList.includes('handleExport') && feeList.includes('导出'),
    );

    check(
      '④ 后端校验用 SHARE_CHANNEL_PUSH_CODES（不再是 1..3 硬编码）',
      route.includes('SHARE_CHANNEL_PUSH_CODES.includes(v)') && !/shareChannel: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(3/.test(route),
    );
    check('④ 渠道不合法时给得出人话（提示含「短信或微信」）', route.includes('仅支持短信或微信'));
    check(
      '⑤ 入参是 sendContent，落库列仍是 remark（不动库结构）',
      /sendContent: z\.string\(\)\.max\(500\)\.optional\(\)/.test(route) && /remark: sendContent \|\| null/.test(route),
    );
    // 只看 shareText 的拼接代码（注释里「不再带备注：前缀」这种说明不算违规）
    const textBlock = /const shareText =[\s\S]{0,600}?;\n/.exec(route)?.[0] || '';
    check(
      '⑤ 生成文案不再拼「备注：」前缀，而是原样附上发送内容',
      !!textBlock && !textBlock.includes('备注') && textBlock.includes('sendContent'),
      textBlock.replace(/\n/g, ' ⏎ ').slice(0, 160),
    );

    check('类型层入参同步改名（FeeSharePayload.sendContent）', /interface FeeSharePayload[\s\S]{0,400}?sendContent\?: string/.test(api));

    /* 块注释里加粗紧跟斜杠会提前闭合注释 → tsc 报一屏 Invalid character，先自查 */
    const noBoldSlash = [
      ['shared-types/src/class-jh/enums.ts', enums],
      ['shared-types/src/class-jh/api/fee.api.ts', api],
      ['web-job/src/class-jh/views/FeeList.vue', feeList],
      ['server-job/src/class-jh/routes/fee.route.ts', route],
    ].every(([, s]) => !s.includes('**/'));
    check('块注释安全：改动的 4 个文件里没有 **/ （否则注释被提前闭合）', noBoldSlash);

    /* ================= B. live ================= */

    /* 催费推送要 class:fee:add —— admin 没有这个权限（403），初高侧由 学管主任 / 校长 持有。
       探测用「不存在的学生」：过了权限关就会回 40401，且不会往库里写任何数据。 */
    let token = '';
    let who = '';
    for (const acc of ['sunmin', 'qiansy']) {
      const t = await login(acc);
      if (!t) continue;
      const probe = await req(`${BASE}/api/class-jh/fee/share`, {
        method: 'POST',
        token: t,
        timeout: 15000,
        body: { studentId: '__probe__', feeType: 1, shareChannel: 3 },
      });
      if (probe.json?.code === 40401) {
        token = t;
        who = acc;
        break;
      }
    }
    check('拿到有催费推送权限的账号（live 断言前置）', !!token, who || 'sunmin / qiansy 都无权 → 下面必然红');
    if (!token) throw new Error('无可用账号，live 段无法继续');

    const listRes = await req(`${BASE}/api/class-jh/fee/list?page=1&size=20`, { token, timeout: 15000 });
    const rows = listRes.json?.data?.list || [];
    check(
      '★ 先取一条初高缴费台账做夹具（live 断言前置）',
      listRes.status === 200 && rows.length > 0,
      `status=${listRes.status} rows=${rows.length}`,
    );
    if (!rows.length) throw new Error('催费台账无数据，live 段无法继续');
    const fix = rows[0];

    const shareUrl = `${BASE}/api/class-jh/fee/share`;
    const stamp = `自检发送内容${Date.now()}`;

    /* ---- B1. 短信（码 3）能推，且发送内容进文案 ---- */
    const sms = await req(shareUrl, {
      method: 'POST',
      token,
      timeout: 20000,
      body: { studentId: fix.studentId, feeType: fix.feeType, shareChannel: 3, sendContent: stamp },
    });
    const smsText = sms.json?.data?.shareText || '';
    if (sms.json?.data?.notifyId) createdNotifyIds.push(sms.json.data.notifyId);
    check(
      '★ 短信推送 → 成功，渠道名回「短信」',
      sms.json?.code === 200 && sms.json?.data?.shareChannelName === '短信',
      `code=${sms.json?.code} msg=${sms.json?.message || ''}`,
    );
    check(
      '★ 文案带自动催费信息 + 发送内容原文，且没有「备注：」前缀',
      smsText.includes(fix.studentName) && smsText.includes(stamp) && !smsText.includes('备注：'),
      smsText.replace(/\n/g, ' ⏎ '),
    );

    /* ---- B2. 微信（码 2）也能推 ---- */
    const wx = await req(shareUrl, {
      method: 'POST',
      token,
      timeout: 20000,
      body: { studentId: fix.studentId, feeType: fix.feeType, shareChannel: 2 },
    });
    if (wx.json?.data?.notifyId) createdNotifyIds.push(wx.json.data.notifyId);
    check(
      '★ 微信推送 → 成功，渠道名回「微信」',
      wx.json?.code === 200 && wx.json?.data?.shareChannelName === '微信',
      `code=${wx.json?.code} msg=${wx.json?.message || ''}`,
    );
    check(
      '★ 不填发送内容时，文案干净收尾（不留下空行/空后缀）',
      (wx.json?.data?.shareText || '').endsWith('请尽快完成缴费。'),
      wx.json?.data?.shareText || '',
    );

    /* ---- B3. 站内消息（码 1）必须被拒：界面不给选，接口也不能照收 ---- */
    const inner = await req(shareUrl, {
      method: 'POST',
      token,
      timeout: 20000,
      body: { studentId: fix.studentId, feeType: fix.feeType, shareChannel: 1 },
    });
    const innerMsg = inner.json?.message || '';
    check(
      '★ 站内消息（码 1）被拒，提示「仅支持短信或微信」',
      inner.json?.code !== 200 && innerMsg.includes('仅支持短信或微信'),
      `code=${inner.json?.code} msg=${innerMsg}`,
    );

    /* ---- B4. 发送内容真的落库，催费记录接口能读回来 ---- */
    const notifyRes = await req(`${BASE}/api/class-jh/fee/notify/list?page=1&size=10&studentId=${encodeURIComponent(fix.studentId)}`, {
      token,
      timeout: 15000,
    });
    const notifyRows = notifyRes.json?.data?.list || [];
    const mine = notifyRows.find((x) => x.remark === stamp);
    check(
      '★ 发送内容进了催费记录（remark 列 = 发送内容原文）',
      !!mine,
      mine ? `渠道=${mine.shareChannelName}` : `未找到；最近 remark=${notifyRows[0]?.remark ?? '—'}`,
    );

    /* ---- B5. 前端编译产物：走的是新常量，文案已生效 ---- */
    const fe = await req(`${BASE}/src/class-jh/views/FeeList.vue`, { timeout: 15000 });
    check(
      '★ 催费页 Vite 编译通过（200 且产出渲染函数）',
      fe.status === 200 && (fe.raw.includes('createVNode') || fe.raw.includes('render')),
      `status=${fe.status} len=${fe.raw.length}`,
    );
    check(
      // ⚠️ 只判「控件文案」：模板里的说明注释会被编译成 _createCommentVNode("...催费推送...")，
      //    那是注释不是按钮，用带引号的精确串避免误判。
      '★ 编译产物里确实没有「催费推送 / 发送内容」入口（不是只改了源码）',
      fe.status === 200 && !fe.raw.includes('"催费推送"') && !fe.raw.includes('"发送内容"') && fe.raw.includes('导出'),
      `status=${fe.status} len=${fe.raw.length}`,
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    /* ---- 清理：逻辑删除本脚本造的催费记录（禁止物理删除） ---- */
    if (createdNotifyIds.length) {
      try {
        db = conn('sms_class_jh');
        await db('t_class_fee_notify').whereIn('id', createdNotifyIds).update({ is_deleted: 1 });
        console.log(`\n（已逻辑删除自检造的 ${createdNotifyIds.length} 条催费记录）`);
      } catch (e) {
        console.log(`\n（清理失败，人工处理：${createdNotifyIds.join(', ')} — ${e?.message || e}）`);
      }
    }
    if (db) await db.destroy();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
