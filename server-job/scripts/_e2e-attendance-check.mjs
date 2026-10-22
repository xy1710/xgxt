/**
 * 第 2 期「出勤管理」端到端验证（启动 → 造夹具 → 断言 → 清理 → 关闭）
 * ============================================================
 *
 * 为什么必须有这个脚本：
 *   本期最大的风险是**状态码翻译写错导致数据静默错乱** ——
 *   页面不报错，但初高的「迟到」被当成「缺勤」，统计全废且事后极难发现。
 *   所以专门做**双向断言**：
 *     ① 读：库里的初高原码 → 接口返回的统一状态名 必须对得上
 *     ② 写：接口传统一码 → 落到库里的初高原码 必须对得上
 *
 * ⚠️ 当前演示库里班级/学生表是空的，所以脚本**自己造夹具**（测试班 + 3 个学生），
 *    跑完按 ID 精确删除，不留垃圾。测的是新建的独立数据，不碰任何真实数据。
 *
 * 跑法：cd server-job && node scripts/_e2e-attendance-check.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

// ★ 第 4 期步骤 1：复用脚手架的「统一表镜像写入」与 NOT NULL 兜底
//   本脚本是第 2 期独立写法（自带 conn），所以用 mirrorRow(复用连接) 版本
// ★ 2026-10-16（P2 出勤归一）：补 `probe` —— 断言侧的表路由。
//   本脚本原来所有明细断言都直接 `jhDb(...)` 读**老表**，
//   切读打开后仓储写的是统一表 → 会出现「断言读老表、产品写新表」的
//   假绿/假红。改用 probe 后，同一份断言在两种模式下都成立。
import { mirrorRow, buildRow as libBuildRow, probe } from './_e2e-lib.mjs';

const ROOT = path.resolve(process.cwd(), '..');
const NODE = process.execPath;
const PASS = '123456';
const API = 'http://127.0.0.1:5173/api/teaching/attendance';
const TEST_DATE = '1999-01-01';
/**
 * ★ 夹具前缀 —— **必须每轮随机**。
 *   `t_class_info.class_name` 上有唯一索引 `uk_class_name`，
 *   而软删的行还占着索引 → 上一轮跑剩的记录会让这一轮直接
 *   `Duplicate entry ... for key 'uk_class_name'` 失败。
 *   现象是「第一次能跑，第二次就跑不了」，很容易误判成代码 bug。
 */
const TAG = '【自检】' + Math.random().toString(36).slice(2, 6) + ' ';

/** ★ 标准答案：初高原始码 → 统一状态名（本脚本独立于被测代码，人工核对过的对照表） */
const JH_RAW_TO_NAME = { 1: '出勤', 2: '迟到', 3: '病假', 4: '事假', 5: '缺勤' };
/** ★ 标准答案：统一码 → 初高原始码（写路径反向） */
const UNIFIED_TO_JH_RAW = { 1: 1, 3: 2, 7: 3, 6: 4, 2: 5 };

const procs = [];
function launch(cwd, args, tag, envOverride = null) {
  const p = spawn(NODE, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(envOverride ? { env: envOverride } : {}),
  });
  let out = '';
  let err = '';
  // ⚠️ 必须把 stdout 也消费掉：管道缓冲写满后子进程会**卡死在启动阶段**，
  //    现象是「服务怎么都起不来」，但单独手动起又完全正常 —— 极难排查。
  p.stdout.on('data', (c) => (out += c.toString()));
  p.stderr.on('data', (c) => (err += c.toString()));
  p.on('error', (e) => (err += 'SPAWN ERROR: ' + e.message));
  procs.push({ p, tag, out: () => out, err: () => err });
  return p;
}

/**
 * 前端专用环境变量
 * ★ 必须清掉 PORT：本脚本 `dotenv.config()` 会把 .env 的 PORT=8004 灌进 process.env，
 *   而 vite.config.ts 的端口是 `FRONTEND_PORT || PORT || 5173` ——
 *   子进程继承后会把**前端起在后端端口上**，现象是「后端就绪 true、前端 false、接口全挂」。
 */
function frontendEnv() {
  const env = { ...process.env, FRONTEND_PORT: '5173' };
  delete env.PORT;
  return env;
}

/** 启动失败时把两个服务的日志打出来，避免"只看到 ❌ 不知道为什么" */
function dumpLogs() {
  for (const { tag, out, err } of procs) {
    const o = out().trim();
    const e = err().trim();
    if (o) console.log(`--- ${tag} stdout(尾) ---\n${o.split('\n').slice(-12).join('\n')}`);
    if (e) console.log(`--- ${tag} stderr(尾) ---\n${e.split('\n').slice(-12).join('\n')}`);
  }
}

function req(url, { method = 'GET', body = null, token = null, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(d);
          } catch {
            /* HTML（说明代理没转发） */
          }
          resolve({ status: res.statusCode, json, raw: d });
        });
      },
    );
    r.on('error', (e) => resolve({ status: 0, json: null, raw: 'ERR ' + e.message }));
    r.setTimeout(timeout, () => r.destroy());
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitFor(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req(url, { timeout: 3000 });
    if (r.status >= 200 && r.status < 400) return true;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return false;
}

function killAll() {
  for (const { p } of procs) {
    if (!p.pid) continue;
    try {
      spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
}

/**
 * 清掉 8004 / 5173 上的残留监听进程
 * ⚠️ 踩过的坑：上一轮自检异常退出会留下孤儿进程占着端口，
 *    下一轮 waitFor 会连到那个旧进程上 → 表现为「服务就绪但接口全挂」。
 */
function freePorts(ports = [8004, 5173]) {
  const out = spawnSync('C:/Windows/System32/netstat.exe', ['-ano'], { encoding: 'utf8' }).stdout || '';
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    if (!ports.some((pt) => line.includes(`:${pt} `) || line.endsWith(`:${pt}`))) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  return [...pids];
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 把 [table,id][] 聚成 {table: [ids]}，便于一次 whereIn 删干净 */
function groupByTable(pairs) {
  const m = new Map();
  for (const [t, id] of pairs) {
    if (!t || !id) continue;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(id);
  }
  return m;
}

function conn(dbName) {
  return knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: dbName,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true,
    },
    pool: { min: 0, max: 3 },
  });
}

(async () => {
  /**
   * ★ 第 4 期步骤 1：夹具双写
   *   老表照写（喂未切读的仓储）+ 镜像写统一表（喂已切读的仓储）
   *   → 切读开关前后各跑一次，结果必须完全一致
   *   ⚠️ t_class_attendance_detail（出勤明细）本轮不在 UNI_MAP 里，
   *      它属于第 4 期步骤 5「出勤明细归一」，这里不镜像。
   */
  const mirror = async (dbName, table, row, stage) => {
    await mirrorRow(uniDb, dbName, table, row, stage, (_d, t, id) =>
      made.uni.push([t, id]),
    );
  };

  const jhDb = conn(process.env.DB_NAME_CLASS_JH || 'sms_class_jh');
  // ★ 第 4 期步骤 1：统一表连接（双写夹具用）
  const uniDb = conn('sms_common');
  const now = new Date();
  /** 本次自检创建的所有 id（用于精确清理） */
  const made = { classes: [], students: [], attendance: [], details: [], uni: [] };
  let tokenAdmin = '';
  let tokenJh = '';

  try {
    console.log('== 启动后端 8004 / 前端 5173 ==');
    const freed = freePorts();
    if (freed.length) console.log(`  已清掉占用端口的残留进程：${freed.join(', ')}`);
    launch(`${ROOT}/server-job`, ['node_modules/tsx/dist/cli.mjs', 'src/app.ts'], 'backend');
    launch(`${ROOT}/web-job`, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], 'frontend', frontendEnv());
    const okBe = await waitFor('http://127.0.0.1:8004/health');
    const okFe = await waitFor('http://127.0.0.1:5173/');
    check('服务就绪（后端 8004 + 前端 5173）', okBe && okFe, `后端=${okBe} 前端=${okFe}`);
    if (!okBe || !okFe) dumpLogs();

    /* ---------- 登录 ---------- */
    const login = async (acc) => {
      const r = await req('http://127.0.0.1:5173/api/portal/account/login', {
        method: 'POST',
        body: { account: acc, password: PASS },
      });
      return r.json?.data?.token || '';
    };
    tokenAdmin = await login('admin');
    tokenJh = await login('sunmin'); // 初高账号
    /** ★ 数据范围按「责任人列」过滤后，夹具班必须挂在 sunmin 名下，否则她读不到详情 */
    const jhHeadId = (() => {
      try { return JSON.parse(Buffer.from(String(tokenJh).split('.')[1], 'base64').toString()).userId || ''; } catch { return ''; }
    })();
    const tokenJob = await login('zhouj'); // 实训账号
    check(
      '登录 admin / sunmin(初高) / zhouj(实训)',
      !!tokenAdmin && !!tokenJh && !!tokenJob,
      `admin=${!!tokenAdmin} sunmin=${!!tokenJh} zhouj=${!!tokenJob}`,
    );

    /* ---------- 造夹具：初高一个测试班 + 3 个学生 ---------- */
    const classId = randomUUID();
    made.classes.push(classId);
    await jhDb('t_class_info').insert({
      id: classId,
      create_time: now,
      class_name: `${TAG}出勤自检班`,
      stage: 201,
      head_teacher_id: jhHeadId || 'test-head',
      head_teacher_name: '自检班主任',
      teacher_id: 'test-teacher',
      teacher_name: '自检教员',
      is_deleted: 0,
    });
    // ★ 双写：t_uni_class
    {
      const cRow = await jhDb('t_class_info').where({ id: classId }).first();
      await mirror('sms_class_jh', 't_class_info', cRow, 'jh');
    }
    const studentIds = [];
    /* ★ 4 个在班学生，但只有前 3 人有出勤明细 —— 第 4 人用来验证
       「详情要返回该班全部学生」（无明细的按出勤显示，2026-10-19 需求） */
    for (let i = 1; i <= 4; i++) {
      const sid = randomUUID();
      studentIds.push(sid);
      made.students.push(sid);
      await jhDb('t_class_student').insert({
        id: sid,
        create_time: now,
        class_id: classId,
        class_name: `${TAG}出勤自检班`,
        student_no: `${TAG}A-${i}`,
        student_name: `${TAG}学生${i}`,
        gender: 1,
        student_status: 3, // 在读 —— 命中初高应到口径 [3,4,5]
        is_deleted: 0,
      });
      // ★ 双写：t_uni_student
      const sRow = await jhDb('t_class_student').where({ id: sid }).first();
      await mirror('sms_class_jh', 't_class_student', sRow, 'jh');
    }
    console.log(`  已造夹具：1 个测试班 + 4 个在班学生（含统一表镜像；前 3 人有出勤明细）`);

    /* ---------- A. 班级下拉 ---------- */
    const cls = await req(`${API}/classes`, { token: tokenAdmin });
    const clsList = cls.json?.data || [];
    check(
      'GET /classes 能取到班级',
      cls.json?.code === 200 && clsList.some((c) => c.id === classId),
      `共 ${clsList.length} 个班`,
    );

    /* ---------- B. 列表 / 统计 ---------- */
    for (const s of ['', 'jh', 'class', 'job']) {
      const r = await req(`${API}/list${s ? `?stage=${s}` : ''}`, { token: tokenAdmin });
      check(`GET /list${s ? `?stage=${s}` : '（全部）'} 返回 200`, r.json?.code === 200, `total=${r.json?.data?.total}`);
    }
    const sum = await req(`${API}/summary?stage=jh`, { token: tokenAdmin });
    check('GET /summary?stage=jh 返回 200', sum.json?.code === 200,
      (sum.json?.data || []).map((x) => `${x.stageName} 平均${x.avgRate}%`).join(' / '));

    /* ---------- C. ★ 读路径断言：初高原码 → 统一状态名 ---------- */
    const attId = randomUUID();
    made.attendance.push(attId);
    await jhDb('t_class_attendance').insert({
      id: attId,
      class_id: classId,
      class_name: `${TAG}出勤自检班`,
      attendance_date: TEST_DATE,
      should_count: 3,
      actual_count: 1,
      attendance_rate: 33.33,
      is_deleted: 0,
      create_time: now,
    });
    // ★ 双写：t_uni_attendance
    {
      const aRow = await jhDb('t_class_attendance').where({ id: attId }).first();
      await mirror('sms_class_jh', 't_class_attendance', aRow, 'jh');
    }
    // 故意用**初高原码**写：2=迟到 / 3=病假 / 5=缺勤
    const rawCodes = [2, 3, 5];
    for (let i = 0; i < 3; i++) {
      const did = randomUUID();
      made.details.push(did);
      await jhDb('t_class_attendance_detail').insert({
        id: did,
        attendance_id: attId,
        class_id: classId,
        attendance_date: TEST_DATE,
        student_id: studentIds[i],
        student_no: `${TAG}A-${i + 1}`,
        student_name: `${TAG}学生${i + 1}`,
        attendance_status: rawCodes[i],
        absent_reason: '自检原因',
        is_deleted: 0,
        create_time: now,
      });
      // ★ 双写：t_uni_attendance_detail（切读模式下仓储读的是这张）
      {
        const dRow = await jhDb('t_class_attendance_detail').where({ id: did }).first();
        await mirror('sms_class_jh', 't_class_attendance_detail', dRow, 'jh');
      }
    }

    const d = await req(`${API}/detail?stage=jh&id=${attId}`, { token: tokenAdmin });
    const details = d.json?.data?.details || [];
    const pairs = [];
    /** 有明细的 3 人：校验原码 → 统一状态名 */
    let readOk = details.length >= 3;
    for (const row of details) {
      const rawRow = await probe(jhDb, 'sms_class_jh', 't_class_attendance_detail', 'jh')
        .where({ attendance_id: attId, student_id: row.studentId, is_deleted: 0 })
        .first();
      if (!rawRow) continue; // 第 4 人没有明细 → 由下面的「全班学生」断言单独覆盖
      const expect = JH_RAW_TO_NAME[Number(rawRow.attendance_status)];
      pairs.push(`${rawRow?.student_name?.replace(TAG, '')}: 原码${rawRow?.attendance_status}→${row.statusName}(应${expect})`);
      if (row.statusName !== expect) readOk = false;
    }
    check('★ 读路径：初高原码 → 统一状态名 全对', readOk, pairs.join(' | '));

    /* ★ 新增需求（2026-10-19）：详情要看到该班**全部**学生，
       没有明细的在班学生按「出勤」显示（此前只返回有明细的行）。 */
    const noRec = details.find((x) => x.studentId === studentIds[3]);
    check(
      '★ 详情返回该班全部学生（无明细的在班学生按「出勤」显示）',
      details.length === 4 && noRec?.statusName === '出勤',
      `明细 ${details.length} 行；第 4 人=${noRec?.statusName ?? '缺失'}`,
    );

    /* ---------- D. ★ 写路径断言：统一码 → 初高原码 ---------- */
    // 用初高账号（sunmin）写：学生1=迟到(3) 学生2=病假(7) 学生3=出勤(1)
    const writeRes = await req(`${API}/save`, {
      method: 'POST',
      token: tokenJh,
      body: {
        stage: 'jh',
        classId,
        attendanceDate: TEST_DATE,
        rows: [
          { studentId: studentIds[0], status: 3, reason: '自检-迟到' },
          { studentId: studentIds[1], status: 7, reason: '自检-病假' },
          { studentId: studentIds[2], status: 1, reason: null },
        ],
      },
    });
    if (writeRes.json?.code === 200) {
      const rows = await probe(jhDb, 'sms_class_jh', 't_class_attendance_detail', 'jh')
        .where({ attendance_id: attId, is_deleted: 0 })
        .orderBy('student_no');
      const expectRaw = [2, 3, 1]; // 统一码 3/7/1 → 初高原码 2/3/1
      const got = rows.map((r) => Number(r.attendance_status));
      check(
        '★ 写路径：统一码 → 初高原码 全对',
        JSON.stringify(got) === JSON.stringify(expectRaw),
        `提交[迟到3,病假7,出勤1] → 落库原码[${got}](应[${expectRaw}])`,
      );
      // 再读回来确认状态名
      const d2 = await req(`${API}/detail?stage=jh&id=${attId}`, { token: tokenJh });
      const names = (d2.json?.data?.details || []).map((x) => x.statusName);
      check('★ 往返一致：写完读回状态名正确', names.includes('迟到') && names.includes('病假'), names.join('/'));
    } else {
      check('★ 写路径：统一码 → 初高原码 全对', false,
        `save 被拒 code=${writeRes.json?.code} ${writeRes.json?.message || ''}`);
    }

    /* ---------- E. 学段隔离 ---------- */
    const cross = await req(`${API}/list?stage=job`, { token: tokenJh });
    check('学段隔离：初高账号查实训数据被拒(40302)', cross.json?.code === 40302,
      `${cross.json?.message || ''}`);
    const cross2 = await req(`${API}/detail?stage=job&id=${attId}`, { token: tokenJh });
    check('学段隔离：初高账号查实训详情被拒', cross2.json?.code === 40302, `${cross2.json?.message || ''}`);
    const own = await req(`${API}/list?stage=jh`, { token: tokenJh });
    check('学段隔离：初高账号查自己学段正常', own.json?.code === 200, `total=${own.json?.data?.total}`);

    /* ---------- F. 登录/只读闸 ---------- */
    const anon = await req(`${API}/list`);
    check('未登录访问被拒(401/40101)', anon.status === 401 && anon.json?.code === 40101,
      `status=${anon.status} code=${anon.json?.code}`);
    const wAdmin = await req(`${API}/save`, {
      method: 'POST',
      token: tokenAdmin,
      body: { stage: 'jh', classId, attendanceDate: TEST_DATE, shouldCount: 1, actualCount: 1 },
    });
    check('系统管理员写请求被拦(只读 40302)', wAdmin.json?.code === 40302,
      `${wAdmin.json?.message || ''}`);
  } catch (e) {
    console.log('  ❌ 异常：' + (e?.stack || e));
    results.push({ name: '异常', ok: false });
  } finally {
    /* ---------- 精确清理自检夹具 ---------- */
    try {
      if (made.details.length) await jhDb('t_class_attendance_detail').whereIn('id', made.details).del();
      if (made.attendance.length) await jhDb('t_class_attendance').whereIn('id', made.attendance).del();
      if (made.students.length) await jhDb('t_class_student').whereIn('id', made.students).del();
      if (made.classes.length) await jhDb('t_class_info').whereIn('id', made.classes).del();
      // ★ 第 4 期：清理统一表镜像行（按表分组，避免逐条删）
      for (const [t, ids] of groupByTable(made.uni)) {
        await uniDb(t).whereIn('id', ids).del();
      }
      console.log(`  🧹 已删除本次全部自检夹具（含统一表镜像 ${made.uni.length} 条）`);
      await uniDb.destroy();
      await jhDb.destroy();
    } catch (e) {
      console.log('  清理失败：' + e.message);
    }
    killAll();

    const pass = results.filter((r) => r.ok).length;
    console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`  失败：${r.name}`));
    console.log('DONE');
    process.exit(0);
  }
})();
