#!/usr/bin/env node
/**
 * 良志学管 · 统一门户版 —— 一键启动（Node 版启动器）
 *
 * 为什么用 Node 写而不是纯 .bat：
 *   .bat 在中文 Windows 上有硬伤 —— 脚本文件本身是 UTF-8，cmd 却按 GBK(936) 解析，
 *   于是中文标题/提示一律变成乱码（“鏂囦欢涓嶅瓨鍦?”），连 set 变量都可能被污染。
 *   Node 全程按 UTF-8 处理，输出稳定不乱码，跨机器也不用手改路径。
 *
 * 用法：
 *   双击根目录的  一键启动.bat   （它只是转手调用本文件）
 *   或者直接：node tools/start.mjs
 *
 * 参数：
 *   --no-install   跳过 npm install 检查
 *   --no-browser   不自动开浏览器
 *   --backend=8004 --frontend=5173   自定义端口
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 参数 & 输出
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getOpt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};

const NO_INSTALL = hasFlag('--no-install');
const NO_BROWSER = hasFlag('--no-browser');
const KEEP_PORTS = hasFlag('--keep-ports');
const FRONTEND_PORT = getOpt('frontend', 5173);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (c, s) => (process.env.NO_COLOR === '1' ? s : c + s + C.reset);
const step = (n, m) => console.log('\n' + paint(C.bold + C.cyan, `[${n}] ${m}`));
const ok = (m) => console.log('  ' + paint(C.green, '✔') + ' ' + m);
const warn = (m) => console.log('  ' + paint(C.yellow, '!') + ' ' + m);
const err = (m) => console.log('  ' + paint(C.red, '✘') + ' ' + m);
const note = (m) => console.log('    ' + paint(C.gray, m));

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function tcpAlive(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

async function waitPort(port, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  process.stdout.write(`    等待 ${label}（:${port}）就绪 `);
  let dots = 0;
  // 服务可能只绑 IPv4（127.0.0.1）或只绑 IPv6（::1）——两边都探，防止误报超时
  while (Date.now() < deadline) {
    if ((await tcpAlive('127.0.0.1', port)) || (await tcpAlive('::1', port))) {
      process.stdout.write(paint(C.green, ' 就绪\n'));
      return true;
    }
    if (dots++ % 2 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write(paint(C.yellow, ' 超时\n'));
  return false;
}

/**
 * 轮询等待一组端口全部空闲（taskkill 返回 ≠ 端口立刻空：
 * 进程退出要时间，TIME_WAIT 也要等）。全空闲返回 true，超时返回 false。
 */
async function waitPortsFree(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let anyAlive = false;
    for (const p of ports) {
      if ((await tcpAlive('127.0.0.1', p)) || (await tcpAlive('::1', p))) { anyAlive = true; break; }
    }
    if (!anyAlive) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 找占用某端口的 PID（Windows: netstat -ano；其它平台: lsof） */
function pidsOnPort(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        // TCP    0.0.0.0:8004    0.0.0.0:0    LISTENING    39120
        const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
      out.split(/\s+/).filter(Boolean).forEach((p) => pids.add(p));
    }
  } catch {
    /* 忽略 */
  }
  return [...pids];
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        spawnSync('kill', ['-9', pid], { stdio: 'ignore' });
      }
    } catch {
      /* 忽略 */
    }
  }
}

function which(cmd) {
  const exe = process.platform === 'win32' ? `${cmd}.cmd` : cmd;
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8', windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  } catch {
    /* 忽略 */
  }
  return exe;
}

/** 在 root/dir 下按当前平台的 npm 执行，实时透传输出 */
function runNpm(dir, args, label) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npmCmd, args, {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: false,
      env: { ...process.env, npm_config_yes: 'true' },
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ---------------------------------------------------------------------------
// .env 解析
// ---------------------------------------------------------------------------
function parseEnv(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    map.set(line.slice(0, eq).trim(), val);
  }
  return map;
}

// ===========================================================================
// 主流程
// ===========================================================================
console.log('');
console.log(paint(C.bold + C.cyan, '═'.repeat(62)));
console.log(paint(C.bold, '  良志学管系统 · 统一门户版   一键启动'));
console.log(paint(C.gray, '  市场咨询 + 财务 + 权限 + 就业 + 教务 + 班级 + 教学（初高）'));
console.log(paint(C.gray, '  一个后端 + 一个前端 + 一套统一登录'));
console.log(paint(C.bold + C.cyan, '═'.repeat(62)));
console.log(paint(C.gray, `  项目目录：${ROOT}`));

// ---- 0) Node 自检 --------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  err(`Node 版本过低：${process.versions.node}，需要 18 或更高。`);
  note('下载地址：https://nodejs.org  （选 LTS）');
  process.exit(1);
}
ok(`Node ${process.versions.node}`);

// ---- 0) 确保 MySQL 在跑（连不上就自动拉起）----------------------------------
// 为什么要这一段：本机 MySQL 常是 ZIP 免安装版，没有注册成 Windows 服务，
// 重启电脑或关掉后台窗口后就没人启动它。以前用户双击一键启动只看到
// 「连不上 MySQL :3306」然后退出，完全不知道要去手动开数据库。
// 现在：自检发现端口没监听 → 自动找 mysqld 拉起来，再继续后面的步骤。
step('0/6', '确保 MySQL 已启动（连不上会自动拉起）');

const DB_PORT_ENV = Number(parseEnv(path.join(ROOT, 'server-job', '.env')).get('DB_PORT') || 3306);

/** 在本机找 mysqld.exe：PATH → 常见安装位置（含 D:\mysql 免安装版） */
function findMysqldExe() {
  const hits = [];
  const push = (p) => { if (p && fs.existsSync(p)) hits.push(p); };
  try {
    const r = spawnSync('where', ['mysqld'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) hits.push(r.stdout.trim().split(/\r?\n/)[0].trim());
  } catch { /* PATH 里没有就往下找 */ }
  for (const base of [
    'D:/mysql', 'D:/MySQL', 'C:/mysql', 'C:/MySQL',
    'C:/Program Files/MySQL', 'C:/Program Files (x86)/MySQL',
    path.join(ROOT, '..', 'mysql'),
  ]) {
    push(path.join(base, 'server', 'bin', 'mysqld.exe'));
    push(path.join(base, 'bin', 'mysqld.exe'));
    try {
      if (fs.existsSync(base)) {
        for (const e of fs.readdirSync(base)) push(path.join(base, e, 'bin', 'mysqld.exe'));
      }
    } catch { /* 目录读不了就跳过 */ }
  }
  return hits[0];
}

/** 找 my.ini：优先 mysqld 同盘的安装目录，再找几个常见位置 */
function findMyIni(mysqldPath) {
  const cands = [
    path.resolve(path.dirname(mysqldPath), '..', '..', 'my.ini'), // <base>/server/bin/mysqld.exe → <base>/my.ini
    path.resolve(path.dirname(mysqldPath), '..', 'my.ini'),
    'D:/mysql/my.ini', 'D:/MySQL/my.ini', 'C:/mysql/my.ini', 'C:/MySQL/my.ini',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

let mysqlReady = await tcpAlive('127.0.0.1', DB_PORT_ENV);
if (mysqlReady) {
  ok(`MySQL 已在运行（:${DB_PORT_ENV}）`);
} else {
  note(`MySQL（:${DB_PORT_ENV}）没在监听，尝试自动启动 ...`);
  const mysqld = findMysqldExe();
  if (!mysqld) {
    err('本机没找到 mysqld.exe，无法自动启动 MySQL');
    note('请先启动 MySQL（或安装 MySQL 服务），再双击本文件。');
  } else {
    const ini = findMyIni(mysqld);
    const args = ini ? [`--defaults-file=${ini}`, '--console'] : ['--console'];
    note(`启动：${mysqld}${ini ? ` --defaults-file=${ini}` : ''}`);
    try {
      // detached：不占住本窗口，关掉启动窗口 MySQL 继续跑
      const child = spawn(mysqld, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch (e) {
      err(`启动 mysqld 失败：${e.message}`);
    }
    mysqlReady = await waitPort(DB_PORT_ENV, 30, 'MySQL');
    if (mysqlReady) ok('MySQL 已自动启动并就绪');
    else {
      err('MySQL 自动启动超时（30 秒）');
      note('可双击 D:\\mysql\\2-后台启动MySQL.bat 手动启动，或查看 D:\\mysql\\logs\\error.log');
    }
  }
}
if (!mysqlReady) warn('MySQL 仍未就绪，后面的数据库步骤可能失败（仍会继续尝试）');

// ---- 1) 环境自检（调 check-env.mjs）--------------------------------------
step('1/6', '环境自检');
const checkRes = spawnSync(process.execPath, [path.join(__dirname, 'check-env.mjs')], {
  stdio: 'inherit',
  windowsHide: true,
});
if (checkRes.status === 2) {
  // 致命问题：给出明确指引后停下，不要继续（继续只会弹一堆看不懂的报错）
  console.log('');
  err('环境自检发现必须先解决的问题，已停止启动。');
  note('按上面标 [错误] 的行改完，重新双击本文件即可。');
  console.log('');
  process.exit(1);
}

// ---- 2) 端口处理 ---------------------------------------------------------
step('2/6', '检查启动端口');

const envMap = parseEnv(path.join(ROOT, 'server-job', '.env'));
const BACKEND_PORT = Number(envMap.get('PORT') || 8004);

const busy = [];
for (const [port, label] of [[BACKEND_PORT, '后端'], [FRONTEND_PORT, '前端']]) {
  if (await tcpAlive('127.0.0.1', port)) busy.push({ port, label, pids: pidsOnPort(port) });
}

if (busy.length === 0) {
  ok(`端口 ${BACKEND_PORT} / ${FRONTEND_PORT} 都空闲`);
} else if (KEEP_PORTS) {
  // 高级用法：--keep-ports 才走交互（给想手动确认的人留着）
  for (const b of busy) {
    warn(`端口 ${b.port}（${b.label}）已被占用${b.pids.length ? `  PID: ${b.pids.join(', ')}` : ''}`);
  }
  note('常见原因：之前开过的黑窗口没关干净，或另一个项目副本正在跑。');
  note('如果直接启动，你很可能看到「接口不存在，请检查路径」或 EADDRINUSE。');
  const ans = await ask('\n  要现在把这些旧进程关掉吗？输入 Y 回车=关掉，直接回车=不动：');
  if (/^y/i.test(ans)) {
    for (const b of busy) {
      if (b.pids.length) {
        killPids(b.pids);
        ok(`已结束 ${b.label} 端口 ${b.port} 上的进程（PID ${b.pids.join(', ')}）`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    warn('已跳过。之后若出现「接口不存在」，先跑 stop-all.bat 再重来。');
  }
} else {
  // ★ 2026-10-15：双击场景改成【自动清理，不再等人按键】
  //   原来这里会停下问「要关掉旧进程吗？Y/回车」，双击打开的黑窗口前
  //   没有任何人盯着看，用户只看到窗口停住不动 → 以为打不开，直接关掉。
  //   现在默认自动结束占用端口的旧进程（占着 8004/5173 的几乎一定是
  //   本项目上次启动的残留，MySQL 和其它项目不受影响），
  //   想手动确认的人才用 --keep-ports。
  for (const b of busy) {
    warn(`端口 ${b.port}（${b.label}）已被占用${b.pids.length ? `  PID: ${b.pids.join(', ')}` : ''}`);
  }
  note('常见原因：上次启动的窗口没关干净。现在自动结束这些旧进程。');
  for (const b of busy) {
    if (b.pids.length) {
      killPids(b.pids);
      ok(`已结束 ${b.label} 端口 ${b.port} 上的进程（PID ${b.pids.join(', ')}）`);
    }
  }
  // 清理后轮询等端口【真正】释放（taskkill 返回 ≠ 端口立刻空：进程退出要时间、
  // TIME_WAIT 也要等。固定睡 2 秒经常没释放干净 → Vite 起来撞见 "port in use"
  // 自动漂到 5174，启动器却还在傻等 5173 —— 2026-10-15 双击实测的坑）
  await waitPortsFree([BACKEND_PORT, FRONTEND_PORT], 15000);
  // 清理后再确认一次：还占着就明说，别让后面 EADDRINUSE 把用户搞懵
  const still = [];
  for (const [port, label] of [[BACKEND_PORT, '后端'], [FRONTEND_PORT, '前端']]) {
    if (await tcpAlive('127.0.0.1', port)) still.push(label);
  }
  if (still.length) warn(`清理后 ${still.join(' / ')} 端口仍被占用，稍后启动可能失败（可先跑 stop-all.bat）`);
  else ok('端口已全部释放');
}

// ---- 3) 依赖 ------------------------------------------------------------
step('3/6', '检查依赖');

if (NO_INSTALL) {
  note('（--no-install）跳过依赖安装');
} else {
  for (const dir of ['shared-types', 'server-job', 'web-job']) {
    const nm = path.join(ROOT, dir, 'node_modules');
    if (fs.existsSync(nm)) {
      ok(`${dir} 依赖已在，跳过`);
      continue;
    }
    console.log(`    正在安装 ${dir} 依赖（首次比较慢，请耐心等）...`);
    const done = await runNpm(path.join(ROOT, dir), ['install', '--no-audit', '--no-fund'], dir);
    if (done) ok(`${dir} 依赖安装完成`);
    else {
      err(`${dir} 依赖安装失败`);
      note('常见原因：网络问题。可在该目录手动执行 npm install 看详细报错。');
      note('如果公司网络需要镜像，试试：npm config set registry https://registry.npmmirror.com');
      process.exit(1);
    }
  }
}

// ---- 4) 编译 shared-types -----------------------------------------------
step('4/6', '编译 shared-types');
const SHARED_CJS = path.join(ROOT, 'shared-types', 'dist', 'cjs', 'index.js');
if (NO_INSTALL) {
  note('（--no-install）跳过编译');
} else {
  // 每次都编一遍：这步很快，但漏了会导致「登录进去菜单全空」这种诡异问题
  const done = await runNpm(path.join(ROOT, 'shared-types'), ['run', 'build'], 'shared-types');
  if (done) ok('shared-types 编译完成');
  else {
    err('shared-types 编译失败');
    process.exit(1);
  }
}
if (!fs.existsSync(SHARED_CJS)) {
  err('shared-types/dist/cjs/index.js 仍然不存在，前后端都会报找不到模块。');
  process.exit(1);
}

// ---- 5) 建库 / 建表 / 导数据（交给已有的 npm scripts）-------------------
step('5/6', '准备数据库（建库 · 建表 · 导演示数据）');

await ensureDatabases();

async function ensureDatabases() {
  const mysql2Path = path.join(ROOT, 'server-job', 'node_modules', 'mysql2', 'promise.js');
  if (!fs.existsSync(mysql2Path)) {
    warn('缺少 mysql2 模块，跳过数据库准备（依赖装好后重跑即可）');
    return;
  }
  const mysql = (await import('file://' + mysql2Path.replace(/\\/g, '/'))).default;

  const host = envMap.get('DB_HOST') || 'localhost';
  const port = Number(envMap.get('DB_PORT') || 3306);
  const user = envMap.get('DB_USER') || 'root';
  const password = envMap.get('DB_PASSWORD') || '';

  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user, password, charset: 'utf8mb4', timezone: '+08:00', connectTimeout: 8000,
    });
  } catch (e) {
    err(`连不上 MySQL：${e.code || e.message}`);
    note('确认 MySQL 已启动，且 server-job/.env 里的密码正确。');
    process.exit(1);
  }

  try {
    // 5a) 建 9 个库
    const DB_KEYS = [
      ['DB_NAME', 'sms_job'], ['DB_NAME_EDU', 'sms_edu'],
      ['DB_NAME_CLASS', 'sms_class'], ['DB_NAME_COMMON', 'sms_common'],
      ['DB_NAME_CLASS_JH', 'sms_class_jh'], ['DB_NAME_PORTAL', 'sms_portal'],
      ['DB_NAME_CONSULT', 'sms_consult'], ['DB_NAME_FINANCE', 'sms_finance'],
      ['DB_NAME_PERM', 'sms_perm'],
    ];
    let created = 0;
    for (const [key, dflt] of DB_KEYS) {
      const db = envMap.get(key) || dflt;
      const [[row]] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [db],
      );
      if (Number(row.n) === 0) {
        await conn.query(
          `CREATE DATABASE \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        );
        created++;
      }
    }
    ok(created ? `新建了 ${created} 个库，9 个库现已齐全` : '9 个库已存在，跳过建库');
  } finally {
    await conn.end().catch(() => {});
  }

  /**
   * 5b) ★ 先导入「权威统一表 SQL」—— 必须排在 migrate 之前
   *
   * 【为什么把顺序反过来】
   *   class-common 里有 7 个迁移是改**统一表**的
   *   （026 改 `t_uni_dorm_bed`、20261011_001~005 各改一张 `t_uni_*`、
   *     20261012_006 改 `t_uni_attendance_detail`），
   *   而 8 张统一主表的**建表职责**已经从迁移 010 移交给
   *   `server-job/sql/init/uni-tables.sql`（从权威库导出的 43 张，结构 100% 与生产一致）。
   *
   *   所以正确顺序是：**先把统一表建好 → 再跑 migrate**。
   *   反过来（先 migrate）会出两种坏情况：
   *     ① 010 按第 3 期旧约定建表（带 src_* 溯源列）→ 与权威库结构分叉，
   *        而 uni-tables.sql 是 IF NOT EXISTS，见表已存在就跳过 → 结构永远修不回来；
   *     ② 就算跳过 010，那 7 个迁移也会因「表不存在」直接报错。
   *
   *   SQL 全篇 `CREATE TABLE IF NOT EXISTS`、不含 DROP/INSERT，重复跑安全。
   */
  const sqlDirs = [
    path.join(ROOT, 'server-job', 'sql', 'init'), // 随仓库分发（推荐）
    path.join(ROOT, '数据库导出'),                  // 本机导出（回退）
  ];
  const findSql = (name) => sqlDirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));

  const uniSql = findSql('uni-tables.sql');
  if (uniSql) {
    console.log('    正在导入统一表（sms_common 的 43 张 t_uni_*，幂等）...');
    const uOk = await importSql(uniSql, 'sms_common');
    if (uOk) ok('统一表已就绪');
    else warn('统一表导入失败（各业务页会缺表，可手动导入 sql/init/uni-tables.sql）');
  } else {
    warn('没找到 uni-tables.sql —— 跳过统一表导入，后面的 migrate 会因缺表报错');
  }

  // 5c) migrate：建 5 个库的表（job / edu / class / class-common / class-jh）
  console.log('    正在建表（knex migrate，覆盖就业/教务/班级/公共/初高 5 个库）...');
  const mOk = await runNpm(path.join(ROOT, 'server-job'), ['run', 'migrate'], 'migrate');
  if (mOk) ok('表结构已就绪');
  else warn('建表有报错，请看上面的原文。');

  // 5d) 导入 4 个模块库的演示数据
  //      ★ 2026-10-15 修正判空口径（老口径坑过人）：
  //      原来是「这个库里已经有任何一张表就跳过导入」，但 5c 的 knex migrate
  //      会先给 sms_perm 建出 3 张迁移表（t_perm_page / t_perm_role_page /
  //      t_perm_role_perm_baseline），于是 sms_perm 的演示数据永远导不进去 →
  //      权限管理的部门/角色/用户/菜单/日志全是空的（表都不存在）。
  //      现在按「签名表」判断：签名表不存在、或一行数据都没有 → 导入；
  //      签名表已有数据 → 认为是真实环境，跳过（导出文件含 DROP，别冲掉数据）。
  const DEMO = [
    ['sms_portal', 't_sys_account'],
    ['sms_consult', 't_consult_account'],
    ['sms_finance', 't_finance_bill'],
    ['sms_perm', 't_perm_dept'],
  ];

  for (const [db, signTable] of DEMO) {
    const sqlFile = findSql(`${db}.sql`);
    if (!sqlFile) {
      warn(`没找到 ${db}.sql（找过 server-job/sql/init/ 与 数据库导出/），跳过`);
      continue;
    }
    const rows = await tableRowCount(db, signTable);
    if (rows === null) { warn(`${db} 状态未知，跳过导入`); continue; }
    if (rows > 0) { ok(`${db} 已有数据（${signTable} ${rows} 行），跳过导入`); continue; }

    console.log(`    正在导入 ${db} 演示数据 ...`);
    const imported = await importSql(sqlFile, db);
    if (imported) ok(`${db} 导入完成`);
    else warn(`${db} 导入失败（不影响其它模块，可稍后手动导入）`);
  }

  // 5e) 教学/教务/就业数据重建（seed-all-demo.mjs）
  //      ★ 2026-10-15 新增（老启动器坑过人）：教学管理板块（大学部班级 class /
  //      初高 class-jh / 教务 edu / 就业 job / 同步副本 common）的演示数据
  //      **不在** sql/init 的导出文件里，而是由 server-job/scripts/seed-all-demo.mjs
  //      现场生成；启动器以前只导 4 个 SQL 库、从不跑 seed → 这几个库的业务表
  //      全是空表 → 班主任/教务/就业老师进系统看到的所有列表都是空的。
  //      另外 seed 的班级负责人要挂门户账号真实 ID，账号不全会挂空，
  //      所以先按需补门户账号（seed:portal 幂等），再按需重建业务数据。
  //      判空口径同 5d：签名表有数据就认为是真实环境，跳过（seed 会先清空业务表）。
  {
    const SJ = path.join(ROOT, 'server-job');
    const runNodeScript = (script) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join('scripts', script)], {
        cwd: SJ, stdio: 'inherit', shell: false,
        env: { ...process.env, NO_COLOR: '1' },
      });
      c.on('error', (e) => { warn(`跑 ${script} 失败：${e.message}`); resolve(false); });
      c.on('close', (code) => resolve(code === 0));
    });

    // e1) 门户岗位账号：少于 13 个才补（seed:portal 幂等，重复跑只会更新不会重复建）
    const acctRows = await tableRowCount('sms_portal', 't_sys_account');
    if (acctRows !== null && acctRows > 0 && acctRows < 13) {
      console.log(`    门户账号 ${acctRows} 个，补齐岗位账号（seed:portal）...`);
      if (await runNodeScript('seed-portal-accounts.mjs')) ok('门户账号已补齐');
      else warn('seed:portal 没跑成功（教学数据的负责人可能挂空，可手动 npm run seed:portal）');
    } else if (acctRows !== null && acctRows >= 13) {
      ok(`门户账号 ${acctRows} 个，已齐全`);
    }

    // e2) 教学数据：签名表 sms_class.t_class_info 为空才重建
    const clsRows = await tableRowCount('sms_class', 't_class_info');
    if (clsRows === null) {
      warn('sms_class 状态未知，跳过教学数据重建');
    } else if (clsRows > 0) {
      ok(`教学数据已存在（sms_class.t_class_info ${clsRows} 行），跳过重建`);
    } else {
      console.log('    正在重建全系统演示数据（seed:all，约 1 分钟）...');
      if (await runNodeScript('seed-all-demo.mjs')) ok('教学/教务/就业演示数据重建完成');
      else warn('seed-all-demo 没跑成功（教学板块可能仍为空，可手动 npm run seed:all）');
    }
  }

  /** 签名表的数据行数；表不存在返回 0，查不了返回 null */
  async function tableRowCount(db, table) {
    const mysql2Path2 = path.join(ROOT, 'server-job', 'node_modules', 'mysql2', 'promise.js');
    const m = (await import('file://' + mysql2Path2.replace(/\\/g, '/'))).default;
    let c;
    try {
      c = await m.createConnection({
        host, port, user, password, charset: 'utf8mb4', timezone: '+08:00', connectTimeout: 8000,
      });
      const [[exists]] = await c.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [db, table],
      );
      if (Number(exists.n) === 0) return 0;
      const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${table}\``);
      return Number(r.n);
    } catch {
      return null;
    } finally {
      if (c) await c.end().catch(() => {});
    }
  }

  /**
   * 导入 .sql 到指定库。
   *
   * ★ 2026-10-09 加固：加了「mysql2 驱动」回退通道。
   *
   * 【为什么必须回退】
   *   原来只找系统 `mysql` 命令行客户端。而「统一门户版」的目标场景是
   *   **只装了 MySQL/MariaDB 服务、没装客户端工具**的机器（本机就是这样）。
   *   于是这 4 个库（portal/consult/finance/perm）永远建不出来 →
   *   门户登录查 t_sys_account 报 50002「数据表不存在」→
   *   浏览器上只看到 Network Error。而启动器给的原因却是
   *   「找不到 mysql 命令行客户端，无法自动导入演示数据」——
   *   用户根本不知道这就是登录失败的原因。
   *
   *   现在：客户端找不到（或执行失败）→ 自动改用项目自带的 mysql2 驱动导入
   *   （server-job/node_modules/mysql2 本来就随包分发），并顺手做
   *   MySQL 8 → MariaDB 的兼容净化。启动器从此自给自足，换机器不必先装客户端。
   */
  async function importSql(sqlFile, db) {
    const candidates = [];
    // 1) PATH 里的 mysql
    candidates.push('mysql');
    // 2) 常见安装位置
    for (const base of [
      'C:/Program Files/MySQL',
      'C:/Program Files (x86)/MySQL',
      'D:/mysql', 'C:/mysql',
      path.join(ROOT, '..', 'mysql'),
    ]) {
      if (!fs.existsSync(base)) continue;
      let entries = [];
      try { entries = fs.readdirSync(base); } catch { continue; }
      for (const e of entries) {
        const p = path.join(base, e, 'bin', 'mysql.exe');
        if (fs.existsSync(p)) candidates.push(p);
      }
      const direct = path.join(base, 'bin', 'mysql.exe');
      if (fs.existsSync(direct)) candidates.push(direct);
    }

    for (const exe of candidates) {
      const r = spawnSync(
        exe,
        ['-h127.0.0.1', `-P${port}`, `-u${user}`, '--default-character-set=utf8mb4'],
        {
          input: fs.readFileSync(sqlFile),
          env: { ...process.env, MYSQL_PWD: password },
          stdio: ['pipe', 'ignore', 'pipe'],
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (r.error && r.error.code === 'ENOENT') continue; // 这个候选不存在，试下一个
      if (r.status === 0) return true;
      const stderr = (r.stderr || '').toString().slice(0, 400);
      if (stderr) note(stderr.split('\n')[0]);
      break; // 找到客户端但执行失败 → 不再试别的路径，转 mysql2 回退
    }

    // ★ 回退：项目自带的 mysql2 驱动（不需要任何外部客户端）
    return await importSqlViaMysql2(sqlFile, db);
  }

  /**
   * 用 mysql2 驱动导入 .sql（启动器的回退通道）。
   *
   * ⚠️ 必须做 MySQL 8 → MariaDB 兼容净化，否则在 MariaDB 上建表会直接失败：
   *   ① `utf8mb4_0900_ai_ci` —— MySQL 8.0 专属排序规则，MariaDB 完全不认
   *      → 换成 `utf8mb4_unicode_ci`
   *   ② 80016 版本注释里的 DEFAULT ENCRYPTION 子句 —— MariaDB 不认；
   *      且 MariaDB 的版本号比较会把 10.4 当作大于 8.0.16，于是真的去执行它
   *      → 整段删掉
   */
  async function importSqlViaMysql2(sqlFile, db) {
    const mysql2Path = path.join(ROOT, 'server-job', 'node_modules', 'mysql2', 'promise.js');
    if (!fs.existsSync(mysql2Path)) {
      warn('既没有 mysql 命令行客户端，也找不到 server-job/node_modules/mysql2，无法导入。');
      note('可以手动导入：数据库导出/*.sql 用 Navicat 之类的工具跑一遍即可。');
      return false;
    }
    note('未找到可用的 mysql 客户端，改用项目自带 mysql2 驱动导入 ...');
    const m = (await import('file://' + mysql2Path.replace(/\\/g, '/'))).default;
    const sql = fs
      .readFileSync(sqlFile, 'utf8')
      .replace(/utf8mb4_0900_ai_ci/g, 'utf8mb4_unicode_ci')
      .replace(/\/\*!80016[\s\S]*?\*\//g, '');
    let c;
    try {
      c = await m.createConnection({
        host, port, user, password,
        charset: 'utf8mb4', multipleStatements: true, connectTimeout: 15000,
      });
      await c.query(sql);
      return true;
    } catch (e) {
      note(`mysql2 导入 ${db} 失败：${e.code || ''} ${e.message}`);
      return false;
    } finally {
      if (c) await c.end().catch(() => {});
    }
  }
}

// ---- 6) 起前后端 --------------------------------------------------------
step('6/6', '启动前后端服务');

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function launch(title, dir, args, extraEnv = {}) {
  /**
   * ★★★ 2026-10-12 修复「服务启动后自己消失」
   *
   * 【原 bug】原来是 `detached: false` + 继承父进程 stdio：
   *   `一键启动.bat` 跑完 `node tools/start.mjs` 就 `exit /b 0`，
   *   cmd 窗口关闭 → 附着在该控制台上的前后端子进程被一起终止。
   *   现象：启动成功、浏览器能打开、能登录能操作，然后服务凭空消失，
   *   前端所有请求 15s 超时（"timeout of 15000ms exceeded"），
   *   刷新回登录页、点任何页面都是「加载失败」。
   *   而脚本打印的却是「本窗口可以关掉，不影响已经起来的服务」—— 承诺是假的。
   *
   * 【修法】三件事一起做，缺一不可：
   *   ① `detached: true` —— 子进程进自己的进程组，不随父进程退出而死
   *   ② `child.unref()` —— 父进程不必等它，start.mjs 可以正常退出
   *   ③ `stdio: 'ignore'` —— 不继承父进程 stdio。父进程的控制台一关，
   *      附着在该控制台（继承 stdio）的子进程会收到 CTRL_CLOSE_EVENT 被终止；
   *      断开 stdio 则彻底脱离控制台。
   *      （试过把 fd 传进去写 logs/backend.log，实测子进程什么都没写进去、
   *        服务也没起来，所以用 'ignore' 最稳，代价是看不到子进程输出）
   *
   * 【验证】`node tools/start.mjs` 跑完退出后，端口必须仍在 LISTENING。
   */
  const child = spawn(npmCmd, args, {
    cwd: dir,
    shell: isWin,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv, FORCE_COLOR: '1' },
  });
  child.unref();
  return child;
}

/**
 * ★ 2026-10-16 修复「启动完cmd窗口里刷出一堆网址，还要用户自己选一个打开」
 *
 * 原来用 npm.cmd 起 `npm run dev`。问题是 stdio:'ignore' 在
 * Node 24 + npm 11 这条链路上按不住（npm.cmd → npm-cli.js → node → vite，
 * 中间还夹一个 predev）：vite 检测到 TTY，就把 Local/Network 四个网址
 * 刷到用户双击 .bat 的那个 cmd 窗口里，用户以为要自己选一个复制打开。
 *
 * 现在改用【当前 node 直接跑工具链入口】：
 *   node web-job/node_modules/vite/bin/vite.js                  （前端）
 *   node server-job/node_modules/tsx/dist/cli.mjs watch src/app.ts （后端）
 * 纯 node.exe 进程 + 下面三件套，才能保证：
 *   ① detached     —— 不随启动器退出而死、关窗口不影响服务
 *   ② windowsHide  —— 不弹窗口
 *   ③ stdio → 日志 fd —— 不继承控制台：vite 看不到 TTY，不会刷网址；
 *      同时日志落 logs/*.log，出问题有据可查（比 'ignore' 只丢日志好）
 */
function launchDirect(logName, dir, scriptPath, scriptArgs, extraEnv = {}) {
  const logsDir = path.join(ROOT, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* 建不了目录就退回 ignore */ }
  let stdio = 'ignore';
  try {
    const fd = fs.openSync(path.join(logsDir, `${logName}.log`), 'a');
    stdio = ['ignore', fd, fd];
  } catch { /* 打不开日志文件就 ignore，服务照样起 */ }
  const child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
    cwd: dir,
    detached: true,
    windowsHide: true,
    stdio,
    env: { ...process.env, ...extraEnv, FORCE_COLOR: '1' },
  });
  child.unref();
  return child;
}

// ---- 起服务前最后复查一次端口 ---------------------------------------------
// [2/6] 到现在隔了好几轮编译/迁移（好几分钟），期间完全可能又有东西占上来，
// 或旧进程其实没退干净。后端被占会直接 EADDRINUSE 退出，绝不放过。
{
  const busyNow = [];
  for (const [port, label] of [[BACKEND_PORT, '后端'], [FRONTEND_PORT, '前端']]) {
    if (await tcpAlive('127.0.0.1', port)) busyNow.push({ port, label, pids: pidsOnPort(port) });
  }
  if (busyNow.length) {
    for (const b of busyNow) warn(`端口 ${b.port}（${b.label}）又被占用，再清理一次 ...`);
    for (const b of busyNow) if (b.pids.length) killPids(b.pids);
    await waitPortsFree([BACKEND_PORT, FRONTEND_PORT], 15000);
  }
}

// ---- shared-types 同步构建 --------------------------------------------------
// 原来前后端的 predev 各构建一次（重复且不可控）。现在服务由启动器直起，
// predev 不再自动跑，必须在这里先构建一次，否则 web/server 引用的类型是旧的。
{
  console.log('    构建 shared-types（类型与常量）...');
  const st = spawnSync(npmCmd, ['run', 'build'], {
    cwd: path.join(ROOT, 'shared-types'),
    shell: isWin,
    windowsHide: true,
    stdio: 'ignore',
    encoding: 'utf8',
  });
  if (st.status === 0) ok('shared-types 构建完成');
  else warn(`shared-types 构建失败（退出码 ${st.status}），先用已有的 dist 继续`);
}

// ---- 起服务：node 直跑 vite / tsx，脱离控制台（见 launchDirect 注释）--------
const TSX_CLI = path.join(ROOT, 'server-job', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_BIN = path.join(ROOT, 'web-job', 'node_modules', 'vite', 'bin', 'vite.js');
const canDirect = fs.existsSync(TSX_CLI) && fs.existsSync(VITE_BIN);

console.log(`    启动后端（端口 ${BACKEND_PORT}）...`);
const backend = canDirect
  ? launchDirect('backend', path.join(ROOT, 'server-job'), TSX_CLI, ['watch', 'src/app.ts'])
  : launch('后端', path.join(ROOT, 'server-job'), ['run', 'dev']);

console.log(`    启动前端（端口 ${FRONTEND_PORT}）...`);
const frontend = canDirect
  ? launchDirect('frontend', path.join(ROOT, 'web-job'), VITE_BIN, [], {
      // vite.config.ts 会读这两个变量决定监听端口（优先 FRONTEND_PORT）
      FRONTEND_PORT: String(FRONTEND_PORT),
      PORT: String(FRONTEND_PORT),
    })
  : launch('前端', path.join(ROOT, 'web-job'), ['run', 'dev'], {
      FRONTEND_PORT: String(FRONTEND_PORT),
      PORT: String(FRONTEND_PORT),
    });
if (canDirect) note('服务以无窗口后台方式运行，日志写在 logs/ 目录');

console.log('');
console.log(paint(C.gray, '  ✔ 服务已在后台独立运行，本窗口可以关掉，不影响使用'));
console.log(paint(C.gray, '  要停服务：双击根目录 stop-all.bat（MySQL 会保留运行）'));
console.log(paint(C.gray, '  首次启动要编译，大约 1 分钟，请耐心等 ...'));

const beOk = await waitPort(BACKEND_PORT, 180, '后端');
if (beOk) {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/health`);
    const j = await res.json();
    if (j && j.code === 200) ok(`后端健康检查通过（${JSON.stringify(j.data)}）`);
    else warn('后端 /health 返回异常，可能跑的是旧版本后端。');
  } catch {
    warn('后端 /health 没响应。');
  }
}

// ---- 探测前端实际端口 -------------------------------------------------------
// Vite 的 strictPort 默认 false：目标端口被占就自动顺延（5173→5174→…）。
// 所以不能傻等 FRONTEND_PORT——要把候选端口都探一遍，后续的复核、开浏览器、
// 显示网址全部用【实际落地】的那个端口。
// （2026-10-15 用户双击实测：前端漂到 5174，启动器却等 5173、浏览器开 5173，
//   用户看到的就是「网址没打开 / 打不开」）
async function detectFePort(timeoutMs = 120000) {
  const candidates = [FRONTEND_PORT, FRONTEND_PORT + 1, FRONTEND_PORT + 2, FRONTEND_PORT + 3];
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`    等待 前端（:${FRONTEND_PORT}）就绪 `);
  let dots = 0;
  while (Date.now() < deadline) {
    for (const p of candidates) {
      if ((await tcpAlive('127.0.0.1', p)) || (await tcpAlive('::1', p))) {
        process.stdout.write(paint(C.green, ` 就绪（:${p}）\n`));
        return p;
      }
    }
    if (dots++ % 2 === 0) process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write(paint(C.yellow, ' 超时\n'));
  return 0;
}
const ACTUAL_FE_PORT = await detectFePort(120000);
const feOk = ACTUAL_FE_PORT > 0;
if (ACTUAL_FE_PORT && ACTUAL_FE_PORT !== FRONTEND_PORT) {
  warn(`端口 ${FRONTEND_PORT} 被其它程序占用，前端自动改用了 ${ACTUAL_FE_PORT}`);
  note(`请用这个地址访问：http://localhost:${ACTUAL_FE_PORT}（浏览器也会打开这个）`);
}
const url = `http://localhost:${feOk ? ACTUAL_FE_PORT : FRONTEND_PORT}`;

/**
 * ★ 2026-10-12：防「假成功」
 *
 * 原来只等端口通就宣布启动成功。但端口通 ≠ 服务能活：
 * 本机实测过一次「端口就绪、健康检查通过、脚本退出，3 秒后两个端口全消失」。
 * 所以这里在宣布成功前，隔几秒再确认一次端口还在。
 */
let aliveOk = beOk && feOk;
if (aliveOk) {
  console.log(paint(C.gray, '  等待 4 秒后复核服务是否仍在运行 ...'));
  await new Promise((r) => setTimeout(r, 4000));
  const beAgain = (await tcpAlive('127.0.0.1', BACKEND_PORT)) || (await tcpAlive('::1', BACKEND_PORT));
  const feAgain = (await tcpAlive('127.0.0.1', ACTUAL_FE_PORT)) || (await tcpAlive('::1', ACTUAL_FE_PORT));
  if (!beAgain || !feAgain) {
    aliveOk = false;
    console.log('');
    warn('服务起来后又消失了（通常是启动方式导致子进程被连带终止）。');
    console.log(paint(C.gray, '  可用「手动启动」兜底，开两个终端分别跑：'));
    console.log(paint(C.gray, '    终端1: cd server-job && npm run dev'));
    console.log(paint(C.gray, '    终端2: cd web-job && npm run dev'));
  } else {
    ok('复核通过：服务在独立运行，关掉本窗口不影响使用');
  }
}

console.log('');
console.log(paint(C.bold + C.cyan, '═'.repeat(62)));
if (aliveOk) {
  console.log(paint(C.green + C.bold, '  启动成功'));
  console.log('');
  console.log(`  页面地址：  ${paint(C.bold, url)}`);
  console.log(`  后端自检：  http://localhost:${BACKEND_PORT}/health`);
  console.log('');
  console.log(paint(C.bold, '  演示账号（密码统一 123456，登录页右侧点一下自动填入）'));
  console.log(paint(C.gray, '    qiansy   钱守义 · 校长        → 全部 7 个模块，可改数据'));
  console.log(paint(C.gray, '    admin    系统管理员          → 全部 7 个模块，页面级只读'));
  console.log(paint(C.gray, '    zhangls  张老师 · 咨询师      → 只看得到「市场咨询」'));
  console.log(paint(C.gray, '    liukj    刘会计 · 财务专员    → 只看得到「财务管理」'));
  console.log(paint(C.gray, '    linx     林晓 · 权限管理员    → 只看得到「权限管理」'));
  console.log('');
  console.log(paint(C.gray, '  看不到某个模块是正常的：左侧菜单按你的账号被授权的模块渲染。'));
} else {
  console.log(paint(C.yellow + C.bold, '  服务没有在等待时间内全部就绪'));
  console.log('');
  if (!beOk) console.log(paint(C.red, `    ✘ 后端 :${BACKEND_PORT} 没起来 —— 服务是无窗口后台运行的，看不了输出；可开终端手动跑看报错：cd server-job && npm run dev`));
  if (!feOk) console.log(paint(C.red, `    ✘ 前端没起来 —— 可开终端手动跑看报错：cd web-job && npm run dev`));
  if (beOk && feOk && !aliveOk) {
    console.log(paint(C.red, '    ✘ 端口就绪过但又消失了（子进程被连带终止）'));
  }
  console.log('');
  console.log(paint(C.gray, `    也可以手动用浏览器打开： ${url}`));
}
console.log(paint(C.bold + C.cyan, '═'.repeat(62)));
console.log('');

// 把实际访问地址落盘，.bat 结尾显示的 Website 用真实端口（可能被 vite 顺延过）
try { fs.writeFileSync(path.join(__dirname, '.last-url'), url); } catch { /* 写不了就算了 */ }

if (!NO_BROWSER && feOk) {
  // 多等一拍：start 是异步消息，立刻退出可能导致浏览器还没完成创建
  await new Promise((r) => setTimeout(r, 600));
  let opened = false;
  if (isWin) {
    // 方式1：cmd /c start（title 参数必须是空串，否则 URL 会被当成窗口标题）
    try {
      const r1 = spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true, timeout: 8000 });
      if (!r1.error) opened = true;
    } catch { /* 方式1 失败，试方式2 */ }
    // 方式2：explorer 兜底（默认浏览器没注册 / start 失败时；
    //         explorer 打开 URL 成功也返回退出码 1，所以只判断有没有 spawn 报错）
    if (!opened) {
      try {
        const r2 = spawnSync('explorer.exe', [url], { windowsHide: true, timeout: 8000 });
        if (!r2.error) opened = true;
      } catch { /* 方式2 也失败，交给下面的手动提示 */ }
    }
  } else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const r = spawnSync(openCmd, [url], { windowsHide: true, timeout: 8000 });
      if (!r.error) opened = true;
    } catch { /* 打不开 */ }
  }
  if (opened) ok(`已在浏览器中打开 ${url}`);
  else warn(`没能自动打开浏览器，请手动访问： ${url}`);
}

if (aliveOk) {
  console.log(paint(C.gray, '  本窗口可以关掉，不影响已经起来的服务。'));
}
console.log(paint(C.gray, '  要停服务：双击根目录 stop-all.bat（MySQL 会保留运行）。'));
console.log('');
