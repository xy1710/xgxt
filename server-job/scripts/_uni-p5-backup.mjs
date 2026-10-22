/**
 * P5 前置：搬迁前备份（mysqldump 不可用 → node 逐表导出 INSERT）
 *
 * 用法：node scripts/_uni-p5-backup.mjs
 * 输出：exports/p5-backup/<库名>.sql（含建表结构 + 全量 INSERT，可整库回放）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = require('mysql2/promise');

const DBS = ['sms_common', 'sms_class', 'sms_class_jh', 'sms_job', 'sms_edu'];
const OUT_DIR = path.join(process.cwd(), 'exports', 'p5-backup');

const q = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '')}'`;
};

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  for (const db of DBS) {
    const [tables] = await conn.query(
      `select table_name tn from information_schema.tables where table_schema=? and table_type='BASE TABLE' order by table_name`,
      [db],
    );
    let out = `-- P5 backup ${db} @ ${new Date().toISOString()}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n`;
    let rows = 0;
    for (const { tn: table } of tables) {
      const t = table.TN || table.tn || table;
      // 建表结构
      const [ddl] = await conn.query(`SHOW CREATE TABLE \`${db}\`.\`${t}\``);
      const createSql = ddl[0]['Create Table'] || ddl[0]['CREATE TABLE'];
      out += `\nDROP TABLE IF EXISTS \`${t}\`;\n${createSql};\n`;
      // 数据
      const [data] = await conn.query(`select * from \`${db}\`.\`${t}\``);
      for (const row of data) {
        const cols = Object.keys(row).map((k) => `\`${k}\``).join(', ');
        const vals = Object.values(row).map(q).join(', ');
        out += `INSERT INTO \`${t}\` (${cols}) VALUES (${vals});\n`;
        rows += 1;
      }
    }
    const file = path.join(OUT_DIR, `${db}.sql`);
    fs.writeFileSync(file, out, 'utf8');
    console.log(`  ✔ ${db}: ${tables.length} 表 / ${rows} 行 → ${file}`);
  }
  await conn.end();
  console.log('备份完成');
}

main().catch((e) => {
  console.error('备份失败：', e?.message || e);
  process.exit(1);
});
