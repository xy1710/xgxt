/**
 * 统一表「唯一键隐患」审计（T1 / 任务 #18 的常驻索引）
 *
 * 【为什么要这个脚本】
 *   P2 在 attendance 上踩到一个真缺陷：代码「先把旧行整体软删 is_deleted=1、再 insert 新行」。
 *   在老表上这写法一直"看起来正常"（老表只有普通索引）；
 *   但切读后的统一表有**唯一键**（软删行仍占唯一键）→ 必报 Duplicate entry。
 *
 *   → 凡是「统一表有唯一键、而其老表源表都没有等价唯一键」的表，
 *     都是同类隐患的**高危点**。本脚本把这份清单自动扫出来。
 *
 * 【两个方向都查】
 *   正向（T1/#18）：统一表多出唯一键 → 软删+插入 撞 Duplicate entry。
 *   反向（T3/#21）：老表唯一键在统一表侧丢失 → onConflict().merge() 静默退化为 INSERT。
 *
 * 【判据】
 *   1. 统一表的唯一索引（non_unique=0，排除 PRIMARY、排除含 edu_stage 的？——不排除，edu_stage 正是三学段兼容位）
 *   2. 逐个比对「映射到该统一表的所有老表源表」的唯一索引列集合
 *   3. 若统一表的某条唯一键在**所有**老表源表里都找不到等价（列集合相同或为其超集）→ 标为高危
 *
 * 用法：node scripts/_uni-uniquekey-audit.mjs
 */
import { readFileSync } from 'fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const knex = require('knex');

// ---- 解析 UNI_MAP ----
const src = readFileSync(path.join(process.cwd(), 'src/teaching/shared/uniTable.ts'), 'utf8');
const body = src
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

/** 老表全限定名(sms_class.t_class_grade) -> 统一表(t_uni_exam_score) */
const oldToUni = new Map(
  [...body.matchAll(/'([a-z_]+\.t_[a-z_]+)'\s*:\s*'(t_uni_[a-z_]+)'/g)].map((m) => [m[1], m[2]]),
);
/** 统一表 -> [老表全限定名] */
const uniToOlds = new Map();
for (const [o, u] of oldToUni) {
  if (!uniToOlds.has(u)) uniToOlds.set(u, []);
  uniToOlds.get(u).push(o);
}

const COMMON = process.env.DB_NAME_COMMON || 'sms_common';
const conn = (d) =>
  knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: d,
    },
    pool: { min: 0, max: 2 },
  });

const k = conn(COMMON);

/** 取一张表的唯一索引：[{ name, cols:[...] }]（排除 PRIMARY） */
async function uniqueKeys(dbName, table) {
  const [rows] = await k.raw(
    `select index_name ix, non_unique nu, column_name c, seq_in_index s
       from information_schema.statistics
      where table_schema=? and table_name=? and non_unique=0
      order by index_name, seq_in_index`,
    [dbName, table],
  );
  const map = new Map();
  for (const r of rows) {
    if (String(r.ix).toUpperCase() === 'PRIMARY') continue;
    if (!map.has(r.ix)) map.set(r.ix, []);
    map.get(r.ix).push(String(r.c));
  }
  return [...map.entries()].map(([name, cols]) => ({ name, cols }));
}

/** 列集合 A 是否包含 B（B 是 A 的子集） */
const covers = (a, b) => b.every((c) => a.includes(c));

const BAIL_ONLY = new Set(['is_deleted']); // 参与唯一键时通常是设计噪音，仍保留但不特殊处理

console.log('===== 统一表唯一键审计 =====\n');
console.log(`UNI_MAP 共 ${oldToUni.size} 条映射，覆盖 ${uniToOlds.size} 张统一表\n`);

const hazards = [];
const okList = [];
const noUniq = [];

for (const [uni, olds] of [...uniToOlds].sort((a, b) => a[0].localeCompare(b[0]))) {
  const uniKeys = await uniqueKeys(COMMON, uni);
  if (!uniKeys.length) {
    noUniq.push({ uni, olds });
    continue;
  }

  // 收集所有老表源表的唯一键列集合
  const oldKeySets = [];
  for (const o of olds) {
    const [db, t] = o.split('.');
    const ks = await uniqueKeys(db, t);
    for (const kk of ks) oldKeySets.push({ table: o, cols: kk.cols });
  }

  const risky = [];
  for (const uk of uniKeys) {
    // 统一表的唯一键去掉 edu_stage 后的业务列（edu_stage 是三学段兼容位，老表天然没有）
    const bizCols = uk.cols.filter((c) => c !== 'edu_stage');
    // 老表里有没有一条唯一键「覆盖」这组业务列（列集合相同或是其超集）
    const hasEquiv = oldKeySets.some((os) => covers(os.cols, bizCols));
    if (!hasEquiv) risky.push({ ...uk, bizCols });
  }

  if (risky.length) hazards.push({ uni, olds, risky, oldKeySets });
  else okList.push({ uni, olds, uniKeys });
}

console.log('########## ★ 高危：统一表有唯一键，老表源表全都没有等价唯一键 ##########\n');
if (!hazards.length) console.log('  （无）');
for (const h of hazards) {
  console.log(`■ ${h.uni}`);
  console.log(`   老表源表：${h.olds.join(' , ')}`);
  console.log(`   老表现有唯一键：${h.oldKeySets.length ? h.oldKeySets.map((x) => `[${x.cols.join(',')}]`).join(' ') : '（无）'}`);
  for (const r of h.risky) {
    console.log(`   ⚠️ 新表唯一键 ${r.name}(${r.cols.join(', ')})  → 业务列 [${r.bizCols.join(', ')}] 在老表侧无一唯一约束`);
  }
  console.log('');
}
console.log(`  小计 ${hazards.length} 张\n`);

console.log('########## 已对齐：新老两侧都有等价唯一键 ##########\n');
if (!okList.length) console.log('  （无）');
for (const o of okList) {
  console.log(`   ${o.uni}  ← ${o.olds.join(' , ')}`);
  console.log(`      统一表唯一键：${o.uniKeys.map((x) => `${x.name}(${x.cols.join(',')})`).join('  ')}`);
}
console.log('');

console.log('########## 无唯一键的统一表（天然无此隐患）##########');
console.log(`  共 ${noUniq.length} 张：${noUniq.map((x) => x.uni).join(', ')}\n`);

// ============================================================================
// ★ 反向检查（T3 / 任务 #21）：老表有唯一键，统一表侧无任何唯一键覆盖它
//
// 【为什么要这个方向】
//   上面的检查问的是「统一表多了唯一键吗」（→ 软删+插入 会撞 Duplicate）。
//   反向问的是「老表有唯一键，统一表却丢了」——这类老键常被业务当成
//     upsert 的幂等锚点（knex: .onConflict([...]).merge([...])）。
//   切读后：老表唯一键在统一表侧不存在 → onConflict 定位不到索引 →
//     MySQL 直接报错，或更糟：静默退化成普通 INSERT，产生重复行。
//   实证：sms_class_jh.t_class_fee.uk_fee_source(source_system,source_id)
//         → t_uni_fee 只剩 PK(id)，finance/services/class-sync.ts 的
//           .onConflict(['source_system','source_id']).merge() 已退化为 INSERT。
//
// 【判据】
//   老表唯一键 lu（排除 PRIMARY）；若统一表的所有唯一键里
//   不存在一条 uk 使 uk.cols ⊇ lu.cols（超集）→ 视为「未覆盖」。
//   例：jh.t_class_student.uk_student_no(student_no)
//       被 t_uni_student.uk_student(student_no, edu_stage) 覆盖 → 不算。
// ============================================================================

const revHazards = [];
const revOk = [];

for (const [oldFq, uni] of [...oldToUni].sort((a, b) => a[0].localeCompare(b[0]))) {
  const [db, t] = oldFq.split('.');
  const oldKeys = await uniqueKeys(db, t);
  if (!oldKeys.length) continue; // 老表本身无唯一键 → 无可丢
  const uniKeys = await uniqueKeys(COMMON, uni);
  const lost = [];
  for (const lu of oldKeys) {
    // 统一表侧存在一条唯一键是 lu 的超集 → 已覆盖
    const hasCover = uniKeys.some((uk) => covers(uk.cols, lu.cols));
    if (!hasCover) lost.push({ oldKey: lu, uniKeys });
  }
  if (lost.length) revHazards.push({ oldFq, uni, lost, uniKeys });
  else revOk.push({ oldFq, uni });
}

console.log('########## ★ 反向高危：老表有唯一键、统一表侧无任何唯一键覆盖它 ##########\n');
console.log('  （这类老键常被 onConflict().merge() 当幂等锚点，切读后会静默退化为 INSERT）\n');
if (!revHazards.length) console.log('  （无）');
for (const h of revHazards) {
  console.log(`■ ${h.oldFq}  →  ${h.uni}`);
  console.log(`   统一表唯一键：${h.uniKeys.length ? h.uniKeys.map((x) => `${x.name}(${x.cols.join(',')})`).join('  ') : '（仅 PK）'}`);
  for (const l of h.lost) {
    console.log(`   ⚠️ 老表唯一键 ${l.oldKey.name}(${l.oldKey.cols.join(', ')})  → 统一表侧无一唯一键覆盖`);
  }
  console.log('');
}
console.log(`  小计 ${revHazards.length} 处（老表×唯一键 粒度）；已覆盖 ${revOk.length} 张老表\n`);

console.log('===== 结论 =====');
console.log(`【正向】高危 ${hazards.length} 张需逐一核对「软删+插入」写法：${hazards.map((h) => h.uni).join(', ') || '（无）'}`);
console.log(`【反向】共 ${revHazards.length} 处老表唯一键在统一表侧未被覆盖（T3 / #21）：`);
for (const h of revHazards) {
  for (const l of h.lost) console.log(`        · ${h.oldFq}  ${l.oldKey.name}(${l.oldKey.cols.join(',')})  →  ${h.uni}`);
}

await k.destroy();
process.exit(0);
