#!/usr/bin/env node
/**
 * 良志学管 · 统一门户版 —— 环境自检
 *
 * 零依赖（只用 Node 内置模块），不需要 npm install 就能跑。
 * 一键启动.bat 会先调它；也可以单独执行：
 *
 *     node tools/check-env.mjs
 *
 * 检查项：
 *   1. Node 版本（>= 18）
 *   2. server-job/.env 是否存在、DB_* 是否填全
 *   3. 三处 node_modules 是否已安装、shared-types 是否已编译
 *   4. MySQL 能不能连上、9 个库在不在、表齐不齐
 *   5. 8004 / 5173 端口有没有被别的进程占着
 *
 * 退出码：0 = 全部就绪 / 2 = 有致命问题（不要继续启动）/ 1 = 仅警告
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const noColor = process.env.NO_COLOR === '1';
const paint = (c, s) => (noColor ? s : c + s + C.reset);

let fatal = 0;
let warned = 0;

const ok = (m) => console.log('  ' + paint(C.green, '[OK]') + '   ' + m);
const bad = (m) => {
  fatal++;
  console.log('  ' + paint(C.red, '[错误]') + ' ' + m);
};
const warn = (m) => {
  warned++;
  console.log('  ' + paint(C.yellow, '[警告]') + ' ' + m);
};
const info = (m) => console.log('  ' + paint(C.gray, '       ' + m));
const head = (m) => console.log('\n' + paint(C.bold + C.cyan, m));

// ---------------------------------------------------------------------------
// 1) Node 版本
// ---------------------------------------------------------------------------
head('1/5  Node 运行时');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) {
  ok(`Node ${process.versions.node}`);
} else {
  bad(`Node 版本过低（${process.versions.node}），需要 18 或更高。下载：https://nodejs.org`);
}
info(`node 路径：${process.execPath}`);

// ---------------------------------------------------------------------------
// 2) .env
// ---------------------------------------------------------------------------
head('2/5  server-job/.env');

const ENV_PATH = path.join(ROOT, 'server-job', '.env');
const ENV_EXAMPLE = path.join(ROOT, 'server-job', '.env.example');

const REQUIRED_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD',
  'DB_NAME', 'DB_NAME_EDU', 'DB_NAME_CLASS', 'DB_NAME_COMMON',
  'DB_NAME_CLASS_JH', 'DB_NAME_PORTAL', 'DB_NAME_CONSULT',
  'DB_NAME_FINANCE', 'DB_NAME_PERM',
];

/** 极简 .env 解析：KEY=VALUE，忽略注释与空行，去掉值两侧引号 */
function parseEnv(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    map.set(key, val);
  }
  return map;
}

let env = new Map();
if (!fs.existsSync(ENV_PATH)) {
  if (fs.existsSync(ENV_EXAMPLE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    warn('原先没有 .env，已从 .env.example 自动生成一份');
    info('模板使用占位值。请先填写 MySQL 密码、JWT 密钥和内部令牌：');
    info(ENV_PATH);
  } else {
    bad('既没有 server-job/.env，也没有 server-job/.env.example，无法继续。');
  }
}
if (fs.existsSync(ENV_PATH)) {
  env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
  const missing = REQUIRED_KEYS.filter((k) => !env.get(k));
  if (missing.length === 0) {
    ok('.env 已就绪，13 项数据库配置齐全');
  } else {
    bad(`.env 缺少这些配置项：${missing.join(', ')}`);
    info('打开 server-job/.env 补齐即可（可对照 .env.example）');
  }

  // —— 指向本机之外的库地址，是最常见的“起不来”原因 ——
  const host = (env.get('DB_HOST') || '').toLowerCase();
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    warn(`DB_HOST = ${env.get('DB_HOST')}（不是本机）`);
    info('如果这台机器上没有那个地址的 MySQL，后端会卡在 ETIMEDOUT / ECONNREFUSED。');
    info('本机自带 MySQL 的话，把它改成 DB_HOST=localhost');
  }

  // —— 同名 key 重复定义：历史上真的踩过（FINANCE_URL 被覆盖） ——
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const seen = new Map();
  const dups = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    if (seen.has(k)) dups.add(k);
    seen.set(k, true);
  }
  if (dups.size) {
    warn(`.env 里有重复定义的 key：${[...dups].join(', ')}`);
    info('同名 key 后者生效，容易把正确值静默覆盖掉，建议删掉多余那行。');
  }
}

// ---------------------------------------------------------------------------
// 3) 依赖与编译产物
// ---------------------------------------------------------------------------
head('3/5  依赖安装与 shared-types 编译产物');

const dirs = [
  ['shared-types', 'shared-types'],
  ['server-job', 'server-job'],
  ['web-job', 'web-job'],
];
const missingDeps = [];
for (const [dir, label] of dirs) {
  const nm = path.join(ROOT, dir, 'node_modules');
  if (fs.existsSync(nm)) {
    ok(`${label}/node_modules 已安装`);
  } else {
    missingDeps.push(dir);
    warn(`${label}/node_modules 不存在 → 一键启动时会自动 npm install`);
  }
}

const SHARED_CJS = path.join(ROOT, 'shared-types', 'dist', 'cjs', 'index.js');
if (fs.existsSync(SHARED_CJS)) {
  ok('shared-types 已编译（dist/cjs/index.js 存在）');
} else {
  warn('shared-types 还没编译 → 一键启动时会自动 npm run build');
  info('⚠️ 漏了这步的症状：后端报 Cannot find module \'shared-types\'，或登录进去左侧菜单全空');
}

// ---------------------------------------------------------------------------
// 4) MySQL 连通性 + 9 个库 + 表
// ---------------------------------------------------------------------------
head('4/5  MySQL 连通性与 9 个库');

const EXPECT_DBS = [
  ['sms_job', '就业管理', 'migrate'],
  ['sms_edu', '教务管理', 'migrate'],
  ['sms_class', '班级管理（大学部）', 'migrate'],
  ['sms_common', '公共字典', 'migrate'],
  ['sms_class_jh', '教学管理（初高）', 'migrate'],
  ['sms_portal', '门户 / 登录', 'sql'],
  ['sms_consult', '市场咨询', 'sql'],
  ['sms_finance', '财务管理', 'sql'],
  ['sms_perm', '权限管理', 'sql'],
];

/** 用 mysql2（若装了）连库；没装就退回 TCP 探活 */
async function probeMysql() {
  const host = env.get('DB_HOST') || 'localhost';
  const port = Number(env.get('DB_PORT') || 3306);
  const user = env.get('DB_USER') || 'root';
  const password = env.get('DB_PASSWORD') || '';

  // 先探端口
  const portAlive = await tcpAlive(host === 'localhost' ? '127.0.0.1' : host, port);
  if (!portAlive) {
    bad(`连不上 MySQL：${host}:${port} 没有在监听`);
    info('请确认 MySQL 服务已启动（Windows 服务里找 MySQL / mysql57 / mysql80）');
    info('若 MySQL 装了但没启动，在“服务”里手动启动，或管理员 cmd 执行：net start mysql57');
    return;
  }
  ok(`MySQL 端口 ${host}:${port} 可以连接`);

  // 优先用项目自带的 mysql2 做真实登录
  let mysql = null;
  try {
    const modPath = path.join(ROOT, 'server-job', 'node_modules', 'mysql2', 'promise.js');
    if (fs.existsSync(modPath)) {
      mysql = (await import('file://' + modPath.replace(/\\/g, '/'))).default;
    }
  } catch {
    mysql = null;
  }

  if (!mysql) {
    warn('server-job/node_modules 还没装，跳过后端账号校验（依赖装完重跑一次即可）');
    return;
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user, password, charset: 'utf8mb4', timezone: '+08:00',
      connectTimeout: 8000,
    });
  } catch (e) {
    bad(`MySQL 登录失败：${e.code || e.message}`);
    if (e.code === 'ER_ACCESS_DENIED_ERROR') {
      info(`账号或密码不对。当前用的是 ${user} / ${password ? '******' : '(空)'}`);
      info('打开 server-job/.env，把 DB_PASSWORD 改成本机 MySQL 的 root 密码。');
    } else {
      info('确认 server-job/.env 里的 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD 四项。');
    }
    return;
  }

  try {
    const [[ver]] = await conn.query('SELECT VERSION() AS v');
    ok(`MySQL 登录成功，服务端版本 ${ver.v}`);

    const [rows] = await conn.query(
      `SELECT table_schema AS db, COUNT(*) AS n
         FROM information_schema.tables
        WHERE table_schema LIKE 'sms\\_%'
        GROUP BY table_schema`,
    );
    const have = new Map(rows.map((r) => [r.db, Number(r.n)]));

    const absent = [];
    const empty = [];
    for (const [db, label] of EXPECT_DBS) {
      const n = have.get(db);
      if (n === undefined) {
        absent.push(`${db}（${label}）`);
      } else if (n === 0) {
        empty.push(`${db}（${label}）`);
      }
    }

    if (absent.length === 0 && empty.length === 0) {
      ok(`9 个库全部就位，表结构完整`);
      for (const [db, label] of EXPECT_DBS) {
        info(`${db.padEnd(14)} ${String(have.get(db)).padStart(3)} 张表   ${label}`);
      }
    } else {
      if (absent.length) {
        warn(`缺少 ${absent.length} 个库（一键启动会自动建）：`);
        absent.forEach((x) => info('· ' + x));
      }
      if (empty.length) {
        warn(`有 ${empty.length} 个库是空的（一键启动会自动建表 / 导数据）：`);
        empty.forEach((x) => info('· ' + x));
      }
    }

    // 演示账号
    if (have.has('sms_portal')) {
      try {
        const [[acc]] = await conn.query('SELECT COUNT(*) AS n FROM sms_portal.t_sys_account');
        if (Number(acc.n) > 0) {
          ok(`统一账号表 sms_portal.t_sys_account 有 ${acc.n} 个账号`);
          info('演示密码统一 123456；登录页右侧点账号名可自动填入');
        } else {
          warn('sms_portal.t_sys_account 是空表 → 登录页没有账号可用');
          info('跑一次：cd server-job && npm run seed:portal');
        }
      } catch {
        /* 表结构可能不同，忽略 */
      }
    }
  } finally {
    await conn.end().catch(() => {});
  }
}

// ★ 真正去连一次数据库（之前只定义没调用，MySQL 那一段会整段静默跳过）
await probeMysql();

function tcpAlive(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// 5) 端口占用
// ---------------------------------------------------------------------------
head('5/5  启动端口占用情况');

const BACKEND_PORT = Number(env.get('PORT') || process.env.BACKEND_PORT || 8004);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 5173);

for (const [port, label] of [
  [BACKEND_PORT, '后端'],
  [FRONTEND_PORT, '前端'],
]) {
  // IPv4 / IPv6 都探，防止服务只绑 ::1 时误判「空闲」
  const alive = (await tcpAlive('127.0.0.1', port)) || (await tcpAlive('::1', port));
  if (alive) {
    warn(`端口 ${port}（${label}）已被占用`);
    info(`启动脚本接下来会自动结束这些旧进程，然后确认端口真正释放。`);
    info(`手动排查：netstat -ano | findstr :${port}`);
  } else {
    ok(`端口 ${port}（${label}）空闲`);
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
console.log(paint(C.bold, '─'.repeat(58)));
if (fatal === 0 && warned === 0) {
  console.log('  ' + paint(C.green + C.bold, '环境检查全部通过，可以启动。'));
} else if (fatal === 0) {
  console.log('  ' + paint(C.yellow + C.bold, `检查通过，但有 ${warned} 条提示（多半会自动处理）。`));
} else {
  console.log('  ' + paint(C.red + C.bold, `发现 ${fatal} 个必须先解决的问题（上面标 [错误] 的行）。`));
}
console.log(paint(C.bold, '─'.repeat(58)));
console.log('');

process.exit(fatal > 0 ? 2 : warned > 0 ? 1 : 0);
