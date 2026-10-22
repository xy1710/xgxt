/**
 * 临时重建 / 清除「教学域历史表」（仅供演示数据脚本使用）
 * ============================================================
 *
 * 【为什么需要它】
 *   P8 之后教学域老表已 DROP，但三个演示脚本仍按老表列名写数据：
 *     · seed-all-demo.mjs   —— 全量演示数据
 *     · seed-demo.mjs       —— 实训/就业增量演示数据
 *     · reset-demo-data.cjs —— 重置演示数据
 *   它们的流程都是「临时建表 → 按老逻辑写 → 同步进统一表 → 清除」。
 *
 * 【DDL 从哪来（2026-10-19 修正）】
 *   以前只读 exports/p8-final-backup/*.sql —— 那个目录被 .gitignore 挡住，
 *   全新克隆的机器上根本不存在 → seed 第一步就断。
 *   现在权威来源是 **sql/init/legacy-teaching.sql**（75 张表的纯 DDL，随仓库分发）；
 *   只有当它不存在时才回退到 exports/ 备份（本机调试用）。
 *
 * 【范围】
 *   sms_class(23) + sms_class_jh(26) + sms_job(22) + sms_common 的 4 张 *_sync。
 *   绝不重建/清除 t_uni_*、t_teaching_conf、knex_migrations、sms_edu 及各保留域库。
 *
 * 用法：
 *   node scripts/_uni-recreate-legacy.mjs          # 重建（先 DROP 再 CREATE，保证结构与 DDL 一致）
 *   node scripts/_uni-recreate-legacy.mjs --drop   # 清除
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = require('mysql2/promise');

const DDL_FILE = path.join(process.cwd(), 'sql', 'init', 'legacy-teaching.sql');
const DROP_MODE = process.argv.includes('--drop');

const SYNC_TABLES = new Set([
  't_class_fee_sync',
  't_class_dorm_room_sync',
  't_class_dorm_live_sync',
  't_class_urge_sync',
]);
const BACKUP_DBS = ['sms_class', 'sms_class_jh', 'sms_job', 'sms_common'];

/* ---------- 来源 ①：sql/init/legacy-teaching.sql（权威，随仓库分发） ---------- */
function fromDdlFile() {
  if (!fs.existsSync(DDL_FILE)) return null;
  const sql = fs.readFileSync(DDL_FILE, 'utf8');
  const re = /CREATE TABLE IF NOT EXISTS `([a-z_]+)`\.`([a-z_0-9]+)` \(([\s\S]*?)\) ENGINE=([^;]+);/g;
  const out = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    out.push({
      db: m[1],
      table: m[2],
      // 重建时去掉 IF NOT EXISTS：我们已经先 DROP，语义更明确
      ddl: `CREATE TABLE \`${m[1]}\`.\`${m[2]}\` (${m[3]}) ENGINE=${m[4]};`,
    });
  }
  return out.length ? out : null;
}

/* ---------- 来源 ②：exports 备份（仅本机可用，后备） ---------- */
function fromBackup() {
  const dir = ['p8-final-backup', 'p5-backup']
    .map((d) => path.join(process.cwd(), 'exports', d))
    .find((d) => fs.existsSync(path.join(d, 'sms_common.sql')));
  if (!dir) return null;
  const out = [];
  for (const db of BACKUP_DBS) {
    const file = path.join(dir, `${db}.sql`);
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    const re = /CREATE TABLE `([a-z_0-9]+)` \(([\s\S]*?)\) ENGINE=([^;]+);/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1];
      if (table.startsWith('knex_')) continue;
      // sms_common 只认 4 张外部同步落地表，绝不碰 t_uni_* / t_teaching_conf
      if (db === 'sms_common' && !SYNC_TABLES.has(table)) continue;
      out.push({ db, table, ddl: `CREATE TABLE \`${db}\`.\`${table}\` (${m[2]}) ENGINE=${m[3]};` });
    }
  }
  return out.length ? out : null;
}

async function main() {
  const fromFile = fromDdlFile();
  const tables = fromFile || fromBackup();
  if (!tables) {
    throw new Error(
      '找不到 DDL 来源：既没有 sql/init/legacy-teaching.sql，也没有 exports/p8-final-backup/*.sql',
    );
  }
  console.log(`DDL 来源：${fromFile ? 'sql/init/legacy-teaching.sql' : 'exports 备份'}（${tables.length} 张）`);

  // 表名全部带库前缀 → 一个连接即可（无需先选库）
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: false,
  });

  const byDb = new Map();
  for (const t of tables) {
    if (!byDb.has(t.db)) byDb.set(t.db, { drop: 0, create: 0 });
    // 先删后建：保证结构与 DDL 完全一致（IF NOT EXISTS 会把旧结构留在原地）
    await conn.query(`DROP TABLE IF EXISTS \`${t.db}\`.\`${t.table}\``);
    byDb.get(t.db).drop += 1;
    if (!DROP_MODE) {
      await conn.query(t.ddl);
      byDb.get(t.db).create += 1;
    }
  }

  for (const [db, n] of byDb) {
    console.log(
      DROP_MODE
        ? `  ✔ ${db}: ${n.drop} 张已清除`
        : `  ✔ ${db}: ${n.drop} 张旧表已清 → ${n.create} 张已重建`,
    );
  }
  await conn.end();

  console.log(DROP_MODE ? '临时老表已清除，库里恢复「无老表」状态' : '临时老表已就绪（可灌数据）');
}

main().catch((e) => {
  console.error('✗ 失败：', e?.message || e);
  process.exit(1);
});
