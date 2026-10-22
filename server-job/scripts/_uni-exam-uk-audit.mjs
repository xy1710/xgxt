/**
 * #20 专项取证：t_uni_exam 的 uk_exam(exam_name, exam_date, edu_stage) 是否缺 class_id。
 *
 * 逻辑：统一表加了 uk_exam，但三张老表 t_class_exam（class/class_jh/job）都没有唯一键。
 *   → 若老表里已存在「同 edu_stage 内 exam_name+exam_date 相同但 class_id 不同」的记录，
 *     切读后这批数据一插入就撞唯一键（Duplicate entry），属真阻塞。
 *   → 若不存在，则只是「潜在风险」（未来两个班同日同名考试会撞）。
 *
 * 输出：
 *   A. 三张老表各自的行数 / 重复组数（按 exam_name+exam_date 分组且 class_id 不同）
 *   B. 统一表 t_uni_exam 的实际索引
 *   C. 结论建议
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

const COMMON = process.env.DB_NAME_COMMON || 'sms_common';
const STAGES = [
  { db: process.env.DB_NAME_CLASS || 'sms_class', table: 't_class_exam', stage: 'class' },
  { db: process.env.DB_NAME_CLASS_JH || 'sms_class_jh', table: 't_class_exam', stage: 'jh' },
  { db: process.env.DB_NAME || 'sms_job', table: 't_class_exam', stage: 'job' },
];

const conn = (d) =>
  knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: d,
      dateStrings: true,
    },
    pool: { min: 0, max: 2 },
  });

const instances = new Map();
const K = (d) => {
  if (!instances.has(d)) instances.set(d, conn(d));
  return instances.get(d);
};

async function cols(dbName, table) {
  const [rows] = await K(dbName).raw(
    `select column_name as name from information_schema.columns
      where table_schema=? and table_name=?`,
    [dbName, table],
  );
  return (rows || []).map((r) => r.name);
}

async function idx(dbName, table) {
  const [rows] = await K(dbName).raw(
    `select index_name as name, non_unique as nonUnique, group_concat(column_name order by seq_in_index) as cols
       from information_schema.statistics where table_schema=? and table_name=?
      group by index_name, non_unique order by non_unique, index_name`,
    [dbName, table],
  );
  return rows || [];
}

console.log('===== A. 三张老表：exam_name+exam_date 重复（不考虑 class_id）=====\n');
for (const s of STAGES) {
  const c = await cols(s.db, s.table);
  if (!c.length) {
    console.log(`  [skip] ${s.db}.${s.table} 不存在`);
    continue;
  }
  const hasClassId = c.includes('class_id');
  const [[cnt]] = await K(s.db).raw(`select count(*) as n from \`${s.db}\`.\`${s.table}\``);
  const [dups] = await K(s.db).raw(
    `select exam_name, exam_date, count(*) as n, count(distinct ${hasClassId ? 'ifnull(class_id,"")' : '""'}) as cls
       from \`${s.db}\`.\`${s.table}\`
      group by exam_name, exam_date
      having count(*) > 1
      order by n desc limit 20`,
  );
  console.log(`  ${s.db}.${s.table}  (edu_stage=${s.stage})  总行数=${cnt.n}  class_id列=${hasClassId ? '有' : '无'}`);
  if (!dups.length) {
    console.log('      → 无 exam_name+exam_date 重复组');
  } else {
    for (const d of dups) {
      const flag = d.cls > 1 ? '★ 跨班同名同日（切读会撞 uk_exam）' : '同名同日同班（切读会撞 uk_exam）';
      console.log(`      ${d.exam_date} | ${d.exam_name} | 行数=${d.n} | 不同class=${d.cls}   ${flag}`);
    }
  }
  console.log('');
}

console.log('===== A2. 关键列「有没有 / 什么类型」（决定查重 SQL 怎么写）=====\n');
{
  const REL = ['exam_name', 'exam_date', 'exam_time', 'class_id', 'class_ids', 'is_deleted'];
  const show = async (dbName, table, label) => {
    const c = await cols(dbName, table);
    if (!c.length) {
      console.log(`  ${label}  表不存在`);
      return;
    }
    const [rows] = await K(dbName).raw(
      `select column_name as name, column_type as ct from information_schema.columns
        where table_schema=? and table_name=? and column_name in (${REL.map(() => '?').join(',')})`,
      [dbName, table, ...REL],
    );
    const m = new Map((rows || []).map((r) => [r.name, r.ct]));
    console.log(`  ${label}`);
    for (const k of REL) console.log(`      ${k.padEnd(12)} ${m.get(k) ?? '—'}`);
  };
  await show(process.env.DB_NAME_CLASS || 'sms_class', 't_class_exam', 'sms_class.t_class_exam（大学老表）');
  await show(process.env.DB_NAME_CLASS_JH || 'sms_class_jh', 't_class_exam', 'sms_class_jh.t_class_exam（初高老表）');
  await show(process.env.DB_NAME || 'sms_job', 't_job_exam', 'sms_job.t_job_exam（实训老表）');
  await show(COMMON, 't_uni_exam', 'sms_common.t_uni_exam（统一表）');
  console.log('');
}

console.log('===== B. 统一表 t_uni_exam 的实际索引 =====\n');
for (const r of await idx(COMMON, 't_uni_exam')) {
  console.log(`  ${r.nonUnique === 1 ? 'KEY ' : 'UK  '} ${r.name} (${r.cols})`);
}
console.log('');

const [[uc]] = await K(COMMON).raw(
  `select count(*) as n from \`${COMMON}\`.\`t_uni_exam\``,
);
console.log(`  统一表行数 = ${uc.n}`);

for (const k of instances.values()) await k.destroy();
