/**
 * 迁移脚本：给 sms_consult.t_consult_fee_order 加 item_detail 列
 *
 * ============================================================
 * 【为什么要改】（2026-10-15）
 * ============================================================
 *   用户口径：「缴费直接缴合计的，交一次就行」。
 *
 *   原来一次「发起收费」勾选 6 项 → 建 6 张单据（学费 28000 / 住宿 2700 / …），
 *   老师眼里明明只交了一笔 32400，系统里却是 6 笔各自带状态、财务要核 6 次。
 *
 *   改成：一次缴清只建【一张合计单】（amount = 各项之和），
 *   勾选了哪些费用、各自多少钱，存进 item_detail（JSON）。
 *   展示时这仍然是一笔钱，点「查看」能展开看到包含哪些项。
 *
 * ============================================================
 * 【改哪些】
 * ============================================================
 *   sms_consult.t_consult_fee_order  + item_detail text NULL
 *
 *   ⚠️ 同时已同步到 server-job/sql/init/sms_consult.sql（全新初始化时用得上）
 *
 * ============================================================
 * 【幂等保护】
 * ============================================================
 *   先查 information_schema，列已存在就跳过 —— 可以反复跑。
 *
 * 用法：node tools/add-fee-item-detail.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 读 .env（不引第三方库，避免多装依赖） ---------- */
function loadEnv(file) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const env = loadEnv(resolve(ROOT, 'server-job/.env'));
const HOST = env.DB_HOST || '127.0.0.1';
const PORT = env.DB_PORT || '3306';
const USER = env.DB_USER || 'root';
const PASS = env.DB_PASS || env.DB_PASSWORD || '';
const DB = env.DB_NAME_CONSULT || 'sms_consult';

/* ---------- 找 mysql 客户端 ---------- */
const CANDIDATES = [
  env.MYSQL_BIN,
  'D:/mysql/bin/mysql.exe',
  'C:/Program Files/MySQL/MySQL Server 5.7/bin/mysql.exe',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe',
].filter(Boolean);

let MYSQL = null;
for (const c of CANDIDATES) {
  try {
    execFileSync(c, ['--version'], { stdio: 'ignore' });
    MYSQL = c;
    break;
  } catch {
    /* 试下一个 */
  }
}
if (!MYSQL) {
  console.error('✖ 找不到 mysql.exe，请在 server-job/.env 里配 MYSQL_BIN 指向它');
  process.exit(1);
}

function sql(statement) {
  return execFileSync(
    MYSQL,
    ['-h', HOST, '-P', String(PORT), '-u', USER, `-p${PASS}`, '-N', '-B', '-e', statement],
    { encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

console.log(`▶ 目标库：${DB} @ ${HOST}:${PORT}`);

const exists = sql(
  `SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='t_consult_fee_order' AND COLUMN_NAME='item_detail';`,
);

if (Number(exists[0] || 0) > 0) {
  console.log('✔ item_detail 已存在，跳过（幂等）');
} else {
  sql(`ALTER TABLE ${DB}.t_consult_fee_order ADD COLUMN item_detail text NULL COMMENT '合并缴费的明细 JSON' AFTER batch_no;`);
  console.log('✔ 已添加 item_detail');
}

const cols = sql(
  `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='t_consult_fee_order' AND COLUMN_NAME='item_detail';`,
);
console.log('  当前定义：', cols.join(' | '));
console.log('✅ 完成');
