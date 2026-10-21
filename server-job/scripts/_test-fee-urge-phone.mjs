/**
 * 自检：催费列表补「手机号 / 家长手机号」（2026-10-20 用户要求）
 * ============================================================
 * 【需求】催费/缴费模块 → 催费页签（= 原初高缴费台账页 FeeList 改名）的列表，
 *   在「姓名」后面加两列：手机号、家长手机号（催费主要打家长号）。
 *
 * 【三个数据源的口径必须都覆盖 —— 这是本自检的重点】
 *   ① 初高：`sms_class_jh.t_class_fee` 是缴费流水表，**21 列里没有任何电话列**
 *      （已核 information_schema），电话只在 `t_class_student` 上
 *      → 后端必须按 studentId 批量补（不是左连：两表同名列太多，左连不加前缀必 ambiguous）；
 *   ② 大学：催缴副本 `t_class_urge_sync` / 统一表 `t_uni_urge` 自带 phone / parent_phone
 *      → 前端 urgeToRow() 必须把它们搬进台账行形状（原来漏搬 = 列空白）；
 *   ③ 就业：催费单 `t_job_fee_call` 存的是发起时电话快照
 *      → 前端 callToRow() 同样必须搬。
 *   三源里**任意一处漏搬**，前端那一列就是「—」，且接口不报错 —— 静默的坏。
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004 / 5173 运行）：
 *     node scripts/_test-fee-urge-phone.mjs
 *   静态段不依赖服务；live 段需要 5173（经 Vite 代理打到 8004）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, makeChecker, req, login } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');

const { check, summary } = makeChecker();

(async () => {
  try {
    /* ================= A. 静态契约 ================= */

    /* ---- A1. 共享类型：FeeRecord 要有 phone / parentPhone（否则 vue-tsc 过不去） ---- */
    const feeRecordBlock = (() => {
      const src = read('shared-types', 'src', 'class-jh', 'class.ts');
      const i = src.indexOf('export interface FeeRecord');
      return src.slice(i, src.indexOf('}', i));
    })();
    check(
      '★ 共享类型 FeeRecord 已加 phone（学生手机号）+ parentPhone（家长手机号）',
      /\bphone\??:/.test(feeRecordBlock) && /\bparentPhone\??:/.test(feeRecordBlock),
      feeRecordBlock.includes('parentPhone') ? 'ok' : '缺字段',
    );

    /* ---- A2. 后端初高：返回结构带两个字段 ---- */
    const feeRoute = read('server-job', 'src', 'class-jh', 'routes', 'fee.route.ts');
    check(
      '★ 后端初高 fee.list 出参带 phone / parentPhone（toFee 里透传）',
      /phone:\s*r\.phone\s*\?\?\s*null/.test(feeRoute) && /parentPhone:\s*r\.parent_phone\s*\?\?\s*null/.test(feeRoute),
    );
    check(
      '★ 后端初高按 studentId 批量补联系方式（t_class_fee 本身无电话列，必须关联学生表）',
      // ★ 2026-10-20：select 从 3 列扩到「联系方式 + 学生属性」，
      //   因为同一个函数现在还负责把姓名/班级对齐到档案最新值，
      //   断言改为「取了 phone 和 parent_phone 两列」而不是死磕整串。
      feeRoute.includes('fetchStudentContacts') &&
        /\.select\([^)]*'phone'[^)]*'parent_phone'/.test(feeRoute),
    );
    check(
      '★ 补齐逻辑按 500 分片 + 去重剔空（导出上千行不会撞 max_allowed_packet / NULL 恒不成立）',
      feeRoute.includes('i += 500') && feeRoute.includes('new Set(') && feeRoute.includes('filter((x): x is string => !!x)'),
    );
    check(
      '★ 导出与列表同口径补电话（导出的 CSV 也是同一份数据，不能只有列表有）',
      (feeRoute.match(/fetchStudentContacts\(/g) || []).length >= 2,
    );

    /* ---- A3. 前端催费页：两列存在 + 三源都搬 ---- */
    const feeList = read('web-job', 'src', 'class-jh', 'views', 'FeeList.vue');
    check(
      '★ 催费列表加了「手机号」「家长手机号」两列',
      feeList.includes('label="手机号"') && feeList.includes('label="家长手机号"'),
    );
    check(
      '★ 初高行直接取接口字段（dash(row.phone) / dash(row.parentPhone)，空值显示 —）',
      feeList.includes('dash(row.phone)') && feeList.includes('dash(row.parentPhone)'),
    );
    check(
      '★ 大学催缴行（urgeToRow）搬 phone / parentPhone —— 副本自带列，原来漏搬就空白',
      /function urgeToRow[\s\S]*?parentPhone: r\.parentPhone \?\? null[\s\S]*?\n}/.test(feeList),
    );
    check(
      '★ 就业催费单行（callToRow）搬 phone / parentPhone —— 走的是电话快照',
      /function callToRow[\s\S]*?parentPhone: r\.parentPhone \?\? null[\s\S]*?\n}/.test(feeList),
    );
    check(
      // 表头格式变了（2026-10-20 加实缴/方式/缴费日期/备注列后拆成多行），
      // 断言改成「学号 → 手机号 → 家长手机号 依次出现」，不再依赖一行内的字面串。
      '★ 导出 CSV 表头也含手机号 / 家长手机号（与列表列一致）',
      /'学号'[\s\S]{0,80}'手机号'[\s\S]{0,40}'家长手机号'/.test(feeList),
    );

    /* ================= B. live ================= */

    const token = await login('admin');
    check('★ 管理员登录拿到 token（live 断言前置）', !!token, token ? 'ok' : '登录失败 → 下面必然红');
    if (!token) throw new Error('登录失败，live 段无法继续');

    /* ---- B1. 初高列表：字段真的被读出来了（不是只加了个 null 壳） ---- */
    const r1 = await req(`${BASE}/api/class-jh/fee/list?page=1&size=20`, { token, timeout: 15000 });
    const list = r1.json?.data?.list || [];
    check(
      '★ GET /api/class-jh/fee/list → 200 且有数据',
      r1.status === 200 && r1.json?.code === 200 && list.length > 0,
      `status=${r1.status} total=${r1.json?.data?.total} rows=${list.length}`,
    );
    check(
      '★ 返回行里确实有 phone / parentPhone 两个键（字段名与前端一致）',
      list.length > 0 && list.every((x) => 'phone' in x && 'parentPhone' in x),
      list.length ? Object.keys(list[0]).join(',') : '无数据',
    );
    const withPhone = list.filter((x) => x.phone || x.parentPhone);
    check(
      '★ 至少一行的手机号/家长手机号**非空**（证明关联查到了学生表，不是全空壳）',
      withPhone.length > 0,
      `非空 ${withPhone.length}/${list.length}；样例 ${withPhone[0]?.studentNo || ''} → ${withPhone[0]?.phone || '—'} / ${withPhone[0]?.parentPhone || '—'}`,
    );
    check(
      '★ 补字段没破坏原有派生列（remainDays / isUrgent / urgeCount 仍在）',
      list.length > 0 && 'remainDays' in list[0] && 'isUrgent' in list[0] && 'urgeCount' in list[0],
    );

    /* ---- B2. 导出接口同一口径 ---- */
    const r2 = await req(`${BASE}/api/class-jh/fee/export?page=1&size=20`, { token, timeout: 20000 });
    const exp = r2.json?.data || [];
    check(
      '★ GET /api/class-jh/fee/export → 200 且每行都有 phone / parentPhone 键',
      r2.status === 200 && exp.length > 0 && exp.every((x) => 'phone' in x && 'parentPhone' in x),
      `status=${r2.status} rows=${exp.length}`,
    );
    check(
      '★ 导出行也有非空电话（导出与列表同口径，不是只有列表补了）',
      exp.some((x) => x.phone || x.parentPhone),
      `非空 ${exp.filter((x) => x.phone || x.parentPhone).length}/${exp.length}`,
    );

    /* ---- B3. 前端编译 + 文案落进渲染函数 ---- */
    const fe = await req(`${BASE}/src/class-jh/views/FeeList.vue`, { timeout: 15000 });
    check(
      '★ 催费页 Vite 编译通过（200 且产出渲染函数）',
      fe.status === 200 && (fe.raw.includes('createVNode') || fe.raw.includes('render')),
      `status=${fe.status} len=${fe.raw.length}`,
    );
    check(
      '★ 编译产物里含「手机号」「家长手机号」列文案（不是只改了源码没生效）',
      fe.raw.includes('家长手机号') && fe.raw.includes('手机号'),
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
