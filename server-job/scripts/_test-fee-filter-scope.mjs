/**
 * 自检：催费页三个筛选「对所有部门生效」（2026-10-20 用户要求）
 * ============================================================
 * 【需求】催费页签（FeeList.vue）的三个筛选原来按部门各自禁用：
 *   缴费状态 → 就业禁用；仅看紧急 → 就业禁用；应缴日期 → 大学禁用。
 *   用户要求：**三者都对全部部门（初高 / 大学 / 就业）生效**。
 *
 * 【钉住什么】
 *   ① 前端不再按部门禁用这三项，且三个数据源都要把参数传下去 ——
 *      只去掉 disabled 不传参 = 界面能点、点了没反应（最容易漏的一步）；
 *   ② 就业的「缴费状态」是另一套码（1 待催缴 / 2 催缴中 / 3 已缴清），
 *      与初高/大学（1 待缴 / 2 已缴 / 3 已核对 / 5 冻结）**语义与码位都不同**，
 *      所以下拉选项必须随部门切换，否则「选已缴出来的是催缴中」；
 *   ③ 「仅看紧急」在三源的口径都是**未结清且已过应缴日**，已缴/已缴清不算紧急；
 *   ④ ★ 布尔入参不能用 z.coerce.boolean()：字符串 "false" 会被当成 true，
 *      开关关掉后仍按开过滤 —— 接口不报错，静默的坏。三处都已改显式解析。
 *
 * 【跑法】在 server-job 目录下（后端 8004 / 前端 5173 已运行）：
 *     node scripts/_test-fee-filter-scope.mjs
 *   静态段不依赖服务；live 段会临时造 6 行夹具数据（测完逻辑删除，不物理删）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, conn, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

/** 夹具 id 前缀：一眼看不出是测试数据的话，日后清理会很麻烦 */
const P = 'testfilter-';
const URGE_FIX = {
  overdue: `${P}urge-overdue`,
  paid: `${P}urge-paid`,
  future: `${P}urge-future`,
};
const CALL_FIX = {
  overdue: `${P}call-overdue`,
  paid: `${P}call-paid`,
  future: `${P}call-future`,
};
const DATE_OLD = '2020-01-01';
const DATE_FAR = '2099-12-31';

const nowText = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * 夹具写入（可重复跑）
 * ⚠️ 不能用「先 delete 再 insert」：主键仍在 → 第二次跑直接 Duplicate entry。
 *    也不能物理删（本项目铁律：禁止物理删除）。存在就 update 回来。
 */
async function upsertRows(knexInst, table, rows) {
  for (const row of rows) {
    const exists = await knexInst(table).where({ id: row.id }).first('id');
    if (exists) await knexInst(table).where({ id: row.id }).update({ ...row, is_deleted: 0 });
    else await knexInst(table).insert(row);
  }
}

(async () => {
  const db = { jh: null, common: null, job: null };
  try {
    /* ================= A. 静态契约 ================= */

    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');

    /* ---- A1. 筛选区不再按部门禁用 ---- */
    const formStart = feeList.indexOf('<el-form :model="query" inline>');
    const formSection = feeList.slice(formStart, feeList.indexOf('</el-form>', formStart));
    check(
      '★ 筛选区没有任何 :disabled（三个筛选对全部部门开放）',
      formSection.length > 0 && !formSection.includes(':disabled'),
      formSection.includes(':disabled') ? '仍有禁用：' + formSection.slice(formSection.indexOf(':disabled') - 60, formSection.indexOf(':disabled') + 60) : 'ok',
    );

    /* ---- A2. 缴费状态下拉：三部门统一一套（2026-10-20 用户要求「就业采用初高中大学的」） ---- */
    check(
      '★ 缴费状态下拉改用 payStatusOptions（不再直接遍历 PAY_STATUS_NAME）',
      formSection.includes('payStatusOptions') && !formSection.includes('v-for="(name, value) in PAY_STATUS_NAME"'),
    );
    check(
      '★ 三个部门共用一套缴费状态（不再按部门切到 FEE_CALL_STATUS_NAME）',
      !/FEE_CALL_STATUS_NAME/.test(feeList) &&
        /Object\.entries\(PAY_STATUS_NAME\)\.map/.test(feeList),
    );
    check(
      '★ 就业催费单状态折算成缴费状态（已缴清→已缴，待催缴/催缴中→待缴）',
      /function callStatusToPayStatus[\s\S]{0,200}?PayStatus\.PAID[\s\S]{0,120}?PayStatus\.UNPAID/.test(feeList),
    );

    /* ---- A3. 三源都把三个参数传下去（去 disabled 不传参 = 点了没反应） ---- */
    const urgeCall = feeList.slice(feeList.indexOf('urgeList({'), feeList.indexOf('});', feeList.indexOf('urgeList({')));
    check(
      '★ 大学 urgeList 传 payStatus / onlyOverdue / startDate / endDate',
      ['payStatus', 'onlyOverdue', 'startDate', 'endDate'].every((k) => urgeCall.includes(k)),
      urgeCall.replace(/\s+/g, ' ').slice(0, 160),
    );
    const callBlock = feeList.slice(feeList.indexOf('fetchFeeCallList({'), feeList.indexOf('});', feeList.indexOf('fetchFeeCallList({')));
    check(
      // 2026-10-20：缴费状态统一后，就业不再前端折算 callStatus，直接传统一 payStatus 给后端翻译
      '★ 就业 fetchFeeCallList 传 payStatus / onlyOverdue / startDate / endDate',
      ['payStatus', 'onlyOverdue', 'startDate', 'endDate'].every((k) => callBlock.includes(k)),
      callBlock.replace(/\s+/g, ' ').slice(0, 160),
    );
    check(
      '★ 全部部门合并视图也带筛选（三源都带，不是只有单部门视图）',
      (feeList.match(/onlyOverdue: query\.isUrgent/g) || []).length >= 2,
      `出现 ${(feeList.match(/onlyOverdue: query\.isUrgent/g) || []).length} 次`,
    );
    const feeCallRoute = read('server-job', 'src', 'routes', 'feeCall.route.ts');
    check(
      '★ 选「已核对 / 冻结」时就业无对应状态 → 后端翻译成 1=0 / 该源不出数据（不静默忽略筛选）',
      /payStatus: query\.payStatus/.test(feeList) && /whereRaw\('1 = 0'\)/.test(feeCallRoute),
    );
    check(
      '★ 页面提示文案同步（三个筛选对全部部门生效）',
      feeList.includes('对全部部门（初高/大学/就业）生效'),
    );

    /* ---- A4. 后端布尔入参：三处都改显式解析 ---- */
    const feeRoute = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');
    const urgeRoute = read('server-job', 'src', 'class', 'modules', 'urge', 'urge.route.ts');
    const callRoute = read('server-job', 'src', 'routes', 'feeCall.route.ts');
    const queryUtil = read('server-job', 'src', 'utils', 'query.ts');
    check(
      '★ 公共 boolFlag 只认 true/1/on/yes（"false" 不会被当成 true）',
      queryUtil.includes("['true', '1', 'on', 'yes']"),
    );
    check(
      '★ 初高 fee.list 的 isUrgent 用 boolFlag（原来 z.coerce.boolean 把 "false" 当 true）',
      /isUrgent:\s*boolFlag\.optional\(\)/.test(feeRoute) && !/isUrgent:\s*z\.coerce\.boolean/.test(feeRoute),
    );
    check(
      '★ 大学 urge.list 的 onlyOverdue 用 boolFlag',
      /onlyOverdue:\s*boolFlag\.optional\(\)/.test(urgeRoute) && !/onlyOverdue:\s*z\.coerce\.boolean/.test(urgeRoute),
    );
    check(
      '★ 就业 fee-call.page 的 onlyOverdue 用 boolFlag（新加参数）',
      /onlyOverdue:\s*boolFlag\.optional\(\)/.test(callRoute) && !/onlyOverdue:\s*z\.coerce\.boolean/.test(callRoute),
    );

    /* ---- A5. 就业「紧急」= 逾期且未缴清（与 decorate 的 overdue 同口径） ---- */
    check(
      '★ 就业 onlyOverdue 过滤：due_date < 今天 且 call_status ≠ 已缴清',
      /q\.onlyOverdue[\s\S]{0,200}whereNot\('call_status',\s*FeeCallStatus\.PAID\)[\s\S]{0,80}due_date/.test(callRoute),
    );

    /* ---- A6. 初高导出与列表同口径（导出补了应缴日期） ---- */
    const exportBlock = feeRoute.slice(feeRoute.indexOf("feeRouter.get(\n  '/export'"));
    check(
      '★ 初高导出也按应缴日期过滤（列表筛完导出却是全量 = 用户以为筛选没生效）',
      /if \(q\.startDate\)[\s\S]{0,200}if \(q\.endDate\)/.test(exportBlock.slice(0, 3000)),
    );

    /* ================= B. live ================= */

    const token = await login('admin');
    check('★ 管理员登录拿到 token（live 断言前置）', !!token, token ? 'ok' : '登录失败');
    if (!token) throw new Error('登录失败，live 段无法继续');

    /* ---- B1. 初高：仅看紧急 开/关 真的不同 ---- */
    // ⚠️ 初高 fee.list 的 size 上限是 100（schema 卡死），传 200 会 400 → 全部断言显示 -1
    const jh = async (qs) => {
      const r = await req(`${BASE}/api/class-jh/fee/list?page=1&size=100${qs}`, { token, timeout: 20000 });
      return { total: r.json?.data?.total ?? -1, list: r.json?.data?.list ?? [], status: r.status };
    };
    const jhAll = await jh('');
    const jhUrgent = await jh('&isUrgent=true');
    const jhNot = await jh('&isUrgent=false');
    check(
      '★ 初高 isUrgent=true 返回的行确实全为紧急',
      jhUrgent.list.length > 0 && jhUrgent.list.every((x) => x.isUrgent === true),
      `rows=${jhUrgent.list.length}`,
    );
    check(
      // ⚠️ 2026-10-20：逾期(4) 已算未结清后，初高这 18 行可能**全部**紧急，
      //   所以「关掉开关」得到 0 行是正确结果 —— 断言只要「没有一行是紧急的」，
      //   不能要求非空（否则数据一变化就误报）。
      '★ 初高 isUrgent=false 返回的行没有一行是紧急（"false" 没被当成 true）',
      jhNot.list.every((x) => x.isUrgent === false),
      `rows=${jhNot.list.length}（0 行也算正常：当前数据可能全部紧急）`,
    );
    check(
      '★ 初高 开+关 = 全量（两个口径互斥且完整）',
      jhUrgent.total + jhNot.total === jhAll.total && jhAll.total > 0,
      `${jhUrgent.total} + ${jhNot.total} = ${jhAll.total}`,
    );

    /* ---- B2. 初高：应缴日期区间过滤真的生效 ---- */
    const d1 = jhAll.list.map((x) => x.expireDate).filter(Boolean).sort()[0];
    if (d1) {
      const jhDate = await jh(`&startDate=${d1}&endDate=${d1}`);
      check(
        '★ 初高应缴日期区间过滤生效（返回行的 expireDate 全在区间内）',
        jhDate.list.length > 0 && jhDate.list.every((x) => !x.expireDate || (x.expireDate >= d1 && x.expireDate <= d1)),
        `区间 ${d1} ~ ${d1} → ${jhDate.list.length} 行`,
      );
    } else {
      check('★ 初高应缴日期区间过滤生效（返回行的 expireDate 全在区间内）', false, '库里没有带 expireDate 的数据');
    }

    /* ---- B3. 大学：夹具 3 行（逾期未缴 / 逾期已缴 / 未来未缴） ---- */
    db.common = conn('sms_common');
    const t = nowText();
    await upsertRows(db.common, 't_class_urge_sync', [
      {
        id: URGE_FIX.overdue, create_time: t, is_deleted: 0, source_system: 'test', source_id: `${P}src-1`,
        sync_status: 2, student_id: `${P}stu-1`, student_no: `${P}NO1`, student_name: '自检逾期未缴',
        fee_type: 1, amount: 100000, expire_date: DATE_OLD, pay_status: 1, urge_count: 0, phone: '13700000001',
      },
      {
        id: URGE_FIX.paid, create_time: t, is_deleted: 0, source_system: 'test', source_id: `${P}src-2`,
        sync_status: 2, student_id: `${P}stu-2`, student_no: `${P}NO2`, student_name: '自检逾期已缴',
        fee_type: 1, amount: 100000, expire_date: DATE_OLD, pay_status: 2, urge_count: 1, phone: '13700000002',
      },
      {
        id: URGE_FIX.future, create_time: t, is_deleted: 0, source_system: 'test', source_id: `${P}src-3`,
        sync_status: 2, student_id: `${P}stu-3`, student_no: `${P}NO3`, student_name: '自检未来未缴',
        fee_type: 1, amount: 100000, expire_date: DATE_FAR, pay_status: 1, urge_count: 0, phone: '13700000003',
      },
    ]);

    const urge = async (qs) => {
      const r = await req(`${BASE}/api/class/urge/list?page=1&size=200${qs}`, { token, timeout: 20000 });
      return { total: r.json?.data?.total ?? -1, list: r.json?.data?.list ?? [], status: r.status, code: r.json?.code };
    };
    const urgeAll = await urge('');
    const ids = (x) => x.list.map((r) => r.id);
    check(
      '★ 大学 /urge/list 正常返回（夹具已可见）',
      urgeAll.status === 200 && Object.values(URGE_FIX).every((id) => ids(urgeAll).includes(id)),
      `status=${urgeAll.status} total=${urgeAll.total}`,
    );

    const urgeUrgent = await urge('&onlyOverdue=true');
    check(
      '★ 大学「仅看紧急」：只出逾期未缴（已缴的逾期不算紧急、未来的不算）',
      ids(urgeUrgent).includes(URGE_FIX.overdue) &&
        !ids(urgeUrgent).includes(URGE_FIX.paid) &&
        !ids(urgeUrgent).includes(URGE_FIX.future) &&
        urgeUrgent.list.every((r) => r.isOverdue === true),
    );
    const urgeNot = await urge('&onlyOverdue=false');
    check(
      '★ 大学 onlyOverdue=false 等于不过滤（"false" 没被当成 true —— 原 bug 的回归点）',
      urgeNot.total === urgeAll.total,
      `false→${urgeNot.total} / 不过滤→${urgeAll.total}`,
    );

    const urgePaid = await urge('&payStatus=1');
    check(
      // 2026-10-20：逾期改为按到期日派生后，「待缴」= 未缴清且**没过**应缴日，
      // 夹具里那条过期的（pay_status=1 + 2020 年到期）归到「逾期」，不再算待缴。
      '★ 大学「缴费状态」= 待缴 → 只出未过应缴日的未缴行（过期那条算逾期）',
      urgePaid.list.length > 0 &&
        urgePaid.list.every((r) => r.payStatus === 1) &&
        ids(urgePaid).includes(URGE_FIX.future) &&
        !ids(urgePaid).includes(URGE_FIX.overdue),
      `rows=${urgePaid.list.length}`,
    );
    const urgeOverdue = await urge('&payStatus=4');
    check(
      '★ 大学「缴费状态」= 逾期 → 出「待缴 + 已过应缴日」的行（库里还是 1，按到期日派生）',
      urgeOverdue.list.length === 1 &&
        ids(urgeOverdue).includes(URGE_FIX.overdue) &&
        urgeOverdue.list.every((r) => r.payStatus === 4),
      `rows=${urgeOverdue.list.length}`,
    );

    const urgeDate = await urge(`&startDate=${DATE_OLD}&endDate=${DATE_OLD}`);
    check(
      '★ 大学「应缴日期」筛选生效（只出该区间内的应缴行）',
      ids(urgeDate).includes(URGE_FIX.overdue) && ids(urgeDate).includes(URGE_FIX.paid) && !ids(urgeDate).includes(URGE_FIX.future),
      `rows=${urgeDate.list.length}`,
    );

    /* ---- B4. 就业：夹具 3 行 ---- */
    db.job = conn('sms_job');
    await upsertRows(db.job, 't_job_fee_call', [
      {
        id: CALL_FIX.overdue, create_time: t, is_deleted: 0, fee_type: 3, student_id: `${P}jstu-1`,
        student_no: `${P}JNO1`, student_name: '自检待催缴', fee_amount: 50000, due_date: DATE_OLD,
        call_status: 1, phone: '13700000011',
      },
      {
        id: CALL_FIX.paid, create_time: t, is_deleted: 0, fee_type: 3, student_id: `${P}jstu-2`,
        student_no: `${P}JNO2`, student_name: '自检已缴清', fee_amount: 50000, due_date: DATE_OLD,
        call_status: 3, phone: '13700000012',
      },
      {
        id: CALL_FIX.future, create_time: t, is_deleted: 0, fee_type: 3, student_id: `${P}jstu-3`,
        student_no: `${P}JNO3`, student_name: '自检未到期', fee_amount: 50000, due_date: DATE_FAR,
        call_status: 2, phone: '13700000013',
      },
    ]);

    const call = async (qs) => {
      const r = await req(`${BASE}/api/job/fee-call/page?page=1&size=200${qs}`, { token, timeout: 20000 });
      return { total: r.json?.data?.total ?? r.json?.total ?? -1, list: r.json?.data?.list ?? r.json?.list ?? [], status: r.status };
    };
    const callAll = await call('');
    check(
      '★ 就业 /fee-call/page 正常返回（夹具已可见）',
      callAll.status === 200 && Object.values(CALL_FIX).every((id) => ids(callAll).includes(id)),
      `status=${callAll.status} total=${callAll.total} rows=${callAll.list.length}`,
    );

    const callUrgent = await call('&onlyOverdue=true');
    check(
      '★ 就业「仅看紧急」：只出逾期未缴清（已缴清/未到期不算）',
      ids(callUrgent).includes(CALL_FIX.overdue) &&
        !ids(callUrgent).includes(CALL_FIX.paid) &&
        !ids(callUrgent).includes(CALL_FIX.future) &&
        callUrgent.list.every((r) => r.overdue === true),
      `rows=${callUrgent.list.length}`,
    );
    const callNot = await call('&onlyOverdue=false');
    check(
      '★ 就业 onlyOverdue=false 等于不过滤（"false" 没被当成 true）',
      callNot.total === callAll.total,
      `false→${callNot.total} / 不过滤→${callAll.total}`,
    );

    const callPaid = await call('&callStatus=1');
    check(
      '★ 就业「缴费状态」筛选生效（callStatus=1 待催缴 只出待催缴行）',
      callPaid.list.length > 0 && callPaid.list.every((r) => r.callStatus === 1) && ids(callPaid).includes(CALL_FIX.overdue),
      `rows=${callPaid.list.length}`,
    );

    const callDate = await call(`&startDate=${DATE_OLD}&endDate=${DATE_OLD}`);
    check(
      '★ 就业「应缴日期」筛选生效（只出该区间内的到期行）',
      ids(callDate).includes(CALL_FIX.overdue) && ids(callDate).includes(CALL_FIX.paid) && !ids(callDate).includes(CALL_FIX.future),
      `rows=${callDate.list.length}`,
    );

    /* ---- B5. 前端编译 + 文案落地 ---- */
    const fe = await req(`${BASE}/src/class-jh/views/FeeList.vue`, { timeout: 15000 });
    check(
      '★ 催费页 Vite 编译通过（200 且产出渲染函数）',
      fe.status === 200 && (fe.raw.includes('createVNode') || fe.raw.includes('render')),
      `status=${fe.status} len=${fe.raw.length}`,
    );
    check(
      '★ 编译产物里含新提示文案（不是只改了源码没生效）',
      fe.raw.includes('对全部部门') && fe.raw.includes('催缴中'),
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    /* ---- 清理：逻辑删除夹具（禁止物理删除） ---- */
    try {
      if (db.common) await db.common('t_class_urge_sync').whereIn('id', Object.values(URGE_FIX)).update({ is_deleted: 1 });
      if (db.job) await db.job('t_job_fee_call').whereIn('id', Object.values(CALL_FIX)).update({ is_deleted: 1 });
    } catch (e) {
      console.log('⚠️ 夹具清理失败，请手动处理 testfilter-* 记录：', e?.message || e);
    }
    await Promise.all([db.common?.destroy(), db.job?.destroy()].filter(Boolean));

    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
