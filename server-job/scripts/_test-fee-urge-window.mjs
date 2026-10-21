/**
 * 自检：催费列表「到期日 → 20 天窗口」（2026-10-20 用户要求）
 * ============================================================
 * 【需求】催费/缴费 → 催费页签的列表内容来自**财务管理 · 缴费管理**，
 *   「到期日期到 20 天」才进催费列表。
 *
 * 【已确认的三个口径（用户逐条选择）】
 *   ① 窗口 = 到期日距今 **≤ 20 天（含已逾期）** —— 越逾期越该催，不能因为过期就不显示；
 *   ② **到期日为空的缴费单不进列表**（上游咨询建单没传 expireDate，无法判断「还差几天」）；
 *   ③ 阈值做成**独立设置项** `feeUrgeWindowDays`（默认 20），
 *      原来的 `feeRemindDays`（默认 7）继续只管「标红紧急」，两个天数互不干扰。
 *
 * 【钉住什么】
 *   A. 静态
 *      ① 设置项存在、默认 20，且注释里讲清「窗口 ≠ 标红」；
 *      ② 设置页把它当数字编辑（否则会存成字符串，读出来仍是字符串）；
 *      ③ 后端 list 与 export **都**按窗口过滤（只改一处 = 导出比列表多，用户会当 bug）；
 *      ④ 过滤判据是 remainDays !== null（空到期日天然排除），不是 expire_date >= 今天；
 *      ⑤ 列表响应带回 urgeWindowDays，前端有说明文案（否则用户以为数据丢了）。
 *   B. live（经 5173 代理，后端 8004）
 *      造 6 行夹具：逾期 / +19 / +20（边界，应进） · +21 / +45 / 到期日为空（不应进）；
 *      列表与导出的结果集合必须都恰好是前 3 行，且响应里 urgeWindowDays = 20。
 *
 * 【跑法】在 server-job 目录下（后端 8004 / 前端 5173 已运行）：
 *     node scripts/_test-fee-urge-window.mjs
 *   夹具测完按项目铁律**逻辑删除**（is_deleted=1），不物理删。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

/** 夹具前缀：一眼能看出是测试数据，方便日后清理 */
const P = 'testwin-';
/** 窗口天数（与设置默认值一致，写死便于断言） */
const WINDOW = 20;

/** 相对今天偏移 N 天 → YYYY-MM-DD */
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

/**
 * 夹具：offset = 相对今天的天数（null 表示不设到期日）
 * expect = 是否应该出现在催费列表里
 */
const FIXTURES = [
  { key: 'overdue', offset: -5, pay: 1, expect: true, label: '已逾期 5 天' },
  { key: 'near', offset: 19, pay: 1, expect: true, label: '还剩 19 天' },
  { key: 'edge20', offset: 20, pay: 1, expect: true, label: '还剩 20 天（边界，含）' },
  { key: 'edge21', offset: 21, pay: 1, expect: false, label: '还剩 21 天（边界外）' },
  { key: 'far', offset: 45, pay: 1, expect: false, label: '还剩 45 天' },
  { key: 'nodate', offset: null, pay: 1, expect: false, label: '到期日为空' },
];

/**
 * 夹具写入（可重复跑）
 * ⚠️ 不能「先 delete 再 insert」：主键还在 → 第二次跑直接 Duplicate entry；
 *    也不能物理删（项目铁律）。存在就把 is_deleted 归零 + 到期日刷回目标值。
 */
async function upsertRows(db, rows) {
  for (const row of rows) {
    const exists = await db('t_class_fee').where({ id: row.id }).first('id');
    if (exists) await db('t_class_fee').where({ id: row.id }).update({ ...row, is_deleted: 0 });
    else await db('t_class_fee').insert(row);
  }
}

(async () => {
  let db = null;
  try {
    /* ================= A. 静态契约 ================= */
    const settingUtil = read('server-job', 'src', 'class-jh', 'utils', 'setting.ts');
    const settingRoute = read('server-job', 'src', 'class-jh', 'routes', 'setting.route.ts');
    const settingPage = read('web-job', 'src', 'class-jh', 'views', 'SettingList.vue');
    const feeRoute = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');
    const feeApi = read('web-job', 'src', 'class-jh', 'api', 'fee.ts');
    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');

    check(
      '① 设置项 feeUrgeWindowDays 存在且默认 20',
      /feeUrgeWindowDays:\s*'20'/.test(settingUtil),
    );
    check(
      '① 注释里把「窗口天数」和「标红天数」区分写清（两个数不能混）',
      /feeUrgeWindowDays[\s\S]{0,200}?窗口/.test(settingUtil) && /feeRemindDays[\s\S]{0,80}?标红/.test(settingUtil),
    );
    check('① 设置项有中文名（设置页直接展示）', /feeUrgeWindowDays:\s*'催费列表窗口天数/.test(settingRoute));
    check('② 前端设置页按数字编辑该键', /NUMBER_KEYS\s*=\s*\[[^\]]*'feeUrgeWindowDays'/.test(settingPage));

    const listBlock = /feeRouter\.get\(\s*'\/list'[\s\S]*?res\.json\(\{ \.\.\.page/.exec(feeRoute)?.[0] || '';
    const exportBlock = /feeRouter\.get\(\s*'\/export'[\s\S]*?res\.json\(ok\(withContact\)\)/.exec(feeRoute)?.[0] || '';
    check('③ /list 读取窗口天数并按窗口过滤', listBlock.includes("getNumberSetting('feeUrgeWindowDays')") && listBlock.includes('withinUrgeWindow(x, windowDays)'));
    check('③ /export 与列表同口径（导出不能比列表多）', exportBlock.includes("getNumberSetting('feeUrgeWindowDays')") && exportBlock.includes('withinUrgeWindow(x, windowDays)'));
    check(
      '④ 判据是 remainDays !== null（到期日为空的单天然不进列表）',
      /function withinUrgeWindow[^{]*\{[\s\S]{0,120}?remainDays !== null && row\.remainDays <= windowDays/.test(feeRoute),
    );
    check('④ 窗口口径写进注释（数据来源 = 财务缴费管理，避免后人改回同步侧）', /缴费管理[\s\S]{0,400}?syncFeeToJh/.test(feeRoute));
    check('⑤ 列表响应带回 urgeWindowDays', /res\.json\(\{ \.\.\.page\(withContact, total, q\), urgeWindowDays: windowDays \}\)/.test(feeRoute));
    check('⑤ 前端接口类型带上 urgeWindowDays', /urgeWindowDays\?: number/.test(feeApi));
    check(
      '⑤ 界面上说清「为什么比台账少」',
      /window-hint/.test(feeList) && /到期日距今 ≤ \{\{ urgeWindowDays \}\} 天/.test(feeList),
    );

    /* 块注释里加粗紧跟斜杠会提前闭合注释 → tsc 报一屏 Invalid character，先自查 */
    check(
      '块注释安全：改动的 6 个文件里没有 **/',
      [settingUtil, settingRoute, settingPage, feeRoute, feeApi, feeList].every((s) => !s.includes('**/')),
    );

    /* ================= B. live ================= */

    const token = await login('admin');
    check('管理员登录拿到 token（live 断言前置）', !!token, token ? 'ok' : '登录失败 → 下面必然红');
    if (!token) throw new Error('登录失败，live 段无法继续');

    db = conn('sms_class_jh');
    const now = nowText();
    await upsertRows(
      db,
      FIXTURES.map((f, i) => ({
        id: `${P}${f.key}`,
        create_time: now,
        create_by: 'selftest',
        is_deleted: 0,
        student_id: `${P}stu${i}`,
        student_no: `${P}${String(i + 1).padStart(2, '0')}`,
        student_name: `窗口测试${f.key}`,
        class_id: null,
        class_name: null,
        dept_code: 1,
        fee_type: 1,
        fee_amount: 100000,
        pay_status: f.pay,
        pay_date: null,
        expire_date: f.offset === null ? null : dayOffset(f.offset),
        voucher_url: null,
        source_system: 'local',
        source_id: `${P}src${f.key}`,
        period: null,
      })),
    );
    check(`★ 造了 ${FIXTURES.length} 行夹具（逾期 / +19 / +20 / +21 / +45 / 无到期日）`, true);

    const qs = `keyword=${P}&page=1&size=50`;
    const listRes = await req(`${BASE}/api/class-jh/fee/list?${qs}`, { token, timeout: 20000 });
    const rows = listRes.json?.data?.list || [];
    const gotNos = rows.map((r) => r.studentNo).sort();

    check('★ 列表接口 → 200', listRes.json?.code === 200, `code=${listRes.json?.code} msg=${listRes.json?.message || ''}`);
    check('★ 响应带回 urgeWindowDays = 20（前端据此写提示）', listRes.json?.urgeWindowDays === WINDOW, `urgeWindowDays=${listRes.json?.urgeWindowDays}`);
    check(
      '★ 只剩「≤20 天（含逾期）」的 3 行 —— +21 / +45 / 无到期日 都被挡在外面',
      JSON.stringify(gotNos) === JSON.stringify([`${P}01`, `${P}02`, `${P}03`]),
      `实际 ${gotNos.join(',') || '空'}`,
    );
    check('★ total 与行数一致（窗口是过滤，不是只切页）', listRes.json?.data?.total === 3, `total=${listRes.json?.data?.total}`);
    const overdueRow = rows.find((r) => r.studentNo === `${P}01`);
    check(
      '★ 逾期行 remainDays 为负但仍进列表，且未结清 → 标紧急',
      !!overdueRow && overdueRow.remainDays < 0 && overdueRow.isUrgent === true,
      overdueRow ? `remainDays=${overdueRow.remainDays} isUrgent=${overdueRow.isUrgent}` : '找不到逾期行',
    );

    /* ---- 导出与列表同口径 ---- */
    const expRes = await req(`${BASE}/api/class-jh/fee/export?${qs}`, { token, timeout: 30000 });
    const expNos = (expRes.json?.data || []).map((r) => r.studentNo).sort();
    check(
      '★ 导出与列表完全一致（3 行，不多不少）',
      expRes.json?.code === 200 && JSON.stringify(expNos) === JSON.stringify(gotNos),
      `导出 ${expNos.join(',') || '空'}`,
    );

    /* ---- 前端编译产物：提示文案真的进页面了 ---- */
    const fe = await req(`${BASE}/src/class-jh/views/FeeList.vue`, { timeout: 15000 });
    check(
      '★ 催费页 Vite 编译通过，且提示文案已生效',
      fe.status === 200 && fe.raw.includes('到期日距今') && fe.raw.includes('window-hint'),
      `status=${fe.status} len=${fe.raw.length}`,
    );

    /* ---- 设置项真的能读出来（不是只写在默认值里） ---- */
    const settingRes = await req(`${BASE}/api/class-jh/setting/detail`, { token, timeout: 15000 });
    const winSetting = (settingRes.json?.data || []).find((s) => s.settingKey === 'feeUrgeWindowDays');
    check(
      '★ 设置详情里能读到 feeUrgeWindowDays（值为 20 或库里已有值）',
      !!winSetting && Number(winSetting.settingValue) > 0,
      winSetting ? `${winSetting.settingName} = ${winSetting.settingValue}` : '设置详情里没有这个键',
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    /* ---- 清理：逻辑删除夹具（禁止物理删除） ---- */
    if (db) {
      try {
        await db('t_class_fee').whereIn('id', FIXTURES.map((f) => `${P}${f.key}`)).update({ is_deleted: 1 });
        console.log(`\n（已逻辑删除 ${FIXTURES.length} 行自检夹具）`);
      } catch (e) {
        console.log(`\n（清理失败，人工处理：${e?.message || e}）`);
      }
      await db.destroy();
    }
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
