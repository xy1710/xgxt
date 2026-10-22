/**
 * 临时脚本：P8（删老表）就绪度盘点。
 * 对每个业务库的每张表：是否已在 UNI_MAP（= 已归一）/ 是否有数据。
 * 输出：① 已归一但有数据的老表（= 需要搬迁）② 未归一且有数据的老表（= 删不掉）
 */
import { readFileSync } from 'fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const body = src
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const mapped = new Set([...body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((x) => x[1]));

const DBS = [
  process.env.DB_NAME || 'sms_job',
  process.env.DB_NAME_CLASS || 'sms_class',
  process.env.DB_NAME_CLASS_JH || 'sms_class_jh',
  process.env.DB_NAME_COMMON || 'sms_common',
  process.env.DB_NAME_EDU || 'sms_edu',
];

const conn = (d) =>
  knex({ client: 'mysql2', connection: { host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: d, dateStrings: true }, pool: { min: 0, max: 2 } });

const unifiable = []; // 已归一 + 有数据
const blocked = []; // 未归一 + 有数据
const emptyUnmapped = [];

for (const db of DBS) {
  const k = conn(db);
  let tables;
  try {
    const [rows] = await k.raw(
      `select table_name as t from information_schema.tables where table_schema=? and table_type='BASE TABLE' order by table_name`,
      [db],
    );
    tables = rows.map((r) => r.t);
  } catch (e) {
    console.log(`⚠️ ${db}: ${e.message}`);
    await k.destroy();
    continue;
  }
  for (const t of tables) {
    const key = `${db}.${t}`;
    let n = 0;
    try {
      const [r] = await k.raw(`select count(*) as n from \`${t}\``);
      n = Number(r[0].n);
    } catch { /* ignore */ }
    const isMapped = mapped.has(key);
    const isUniTable = t.startsWith('t_uni_');
    if (isUniTable) continue;
    if (isMapped && n > 0) unifiable.push({ key, n });
    else if (!isMapped && n > 0) blocked.push({ key, n });
    else if (!isMapped && n === 0) emptyUnmapped.push(key);
  }
  await k.destroy();
}

console.log('===== ① 已归一 + 有真实数据（P5 搬迁对象）=====\n');
unifiable.sort((a, b) => b.n - a.n).forEach((r) => console.log(`  ${r.key.padEnd(46)} ${String(r.n).padStart(6)} 行`));
console.log(`  小计 ${unifiable.length} 张，共 ${unifiable.reduce((a, b) => a + b.n, 0)} 行`);

console.log('\n===== ② 未归一 + 有真实数据（★删表前必须先归一，否则数据无处可去）=====\n');
blocked.sort((a, b) => b.n - a.n).forEach((r) => console.log(`  ${r.key.padEnd(46)} ${String(r.n).padStart(6)} 行`));
console.log(`  小计 ${blocked.length} 张，共 ${blocked.reduce((a, b) => a + b.n, 0)} 行`);

console.log('\n===== ③ 未归一 + 空表（无害，可随老表一起删）=====');
console.log(`  共 ${emptyUnmapped.length} 张：` + emptyUnmapped.join(', '));
process.exit(0);
