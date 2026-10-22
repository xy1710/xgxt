/**
 * 迁移守卫审计：哪些「老表已 DROP 就跳过」的迁移，统一表那边其实还缺列？
 * ============================================================
 * 【为什么需要】
 *   P8 之后老表全 DROP，一批迁移靠
 *       if (!(await knex.schema.hasTable('t_xxx'))) return;
 *   跳过。跳过本身没问题 —— 但**只有当统一表 t_uni_* 已经有同样的列时**才安全。
 *   否则就是「迁移记成已执行、其实啥也没干」，等到运行期才炸
 *   （今天踩的 class_no / pay_remark 就是这么漏的）。
 *
 * 【怎么判】
 *   只做静态+库结构的交叉核对，不执行任何写操作：
 *     1. 扫 migrations-xxx/ 下所有 .js，找出「带守卫」的迁移 + 被守卫的老表
 *     2. 老表 → 统一表（读 src/teaching/shared/uniTable.ts 的 UNI_MAP）
 *     3. 从迁移文件里抽它想加的列名（hasColumn / t.xxx('col') / COLS 数组）
 *     4. 去库里查统一表有没有这些列
 *     5. 老表不存在 且 统一表缺列 → ⚠️ 报出来
 *
 * 用法：node scripts/_audit-migration-guards.mjs
 *       node scripts/_audit-migration-guards.mjs --verbose
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });
const VERBOSE = process.argv.includes('--verbose');

/* ---------- 1. UNI_MAP（老表 → 统一表） ---------- */
const uniSrc = fs.readFileSync(path.join(ROOT, 'src/teaching/shared/uniTable.ts'), 'utf8');
const UNI = new Map();
for (const m of uniSrc.matchAll(/'([a-z_]+)\.([a-z_0-9]+)':\s*'(t_uni_[a-z_]+)'/g)) {
  UNI.set(m[2], { db: m[1], uni: m[3] });
}

/* 老列名 → 统一表列名（只登记确实改过名的） */
const ALIAS = { stage: 'stage_code', class_type: 'class_type' };

/* ---------- 2. 扫迁移 ---------- */
const dirs = fs.readdirSync(ROOT).filter((d) => d.startsWith('migrations'));
const DB_OF_DIR = {
  migrations: 'sms_job',
  'migrations-edu': 'sms_edu',
  'migrations-class': 'sms_class',
  'migrations-class-common': 'sms_common',
  'migrations-class-jh': 'sms_class_jh',
};

const items = [];
for (const dir of dirs) {
  const full = path.join(ROOT, dir);
  if (!fs.statSync(full).isDirectory()) continue;
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(full, f), 'utf8');
    // 守卫写法一：if (!(await knex.schema.hasTable(X))) return/continue
    // 守卫表：字面量 或 常量名（const TABLE = 't_xxx'）
    const constMap = new Map();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([a-z_0-9]+)'/g)) constMap.set(m[1], m[2]);
    const guards = [
      ...new Set(
        [...src.matchAll(/hasTable\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*\)\s*\)\s*\)?\s*(?:return|continue);/g)].map(
          (m) => m[1] || constMap.get(m[2]) || m[2],
        ),
      ),
    ].filter((t) => t && t.startsWith('t_'));
    // 另一种写法：const hasX = await knex.schema.hasTable('t_xxx'); ... if (!hasX) return;
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+knex\.schema\.hasTable\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*\)/g)) {
      const t = m[2] || constMap.get(m[3]);
      if (!t) continue;
      const bail = new RegExp('if\\s*\\(\\s*!\\s*' + m[1] + '\\s*\\)\\s*(?:return|continue|\\{?)');
      if (bail.test(src)) guards.push(t);
    }
    const guardList = [...new Set(guards)].filter((t) => t && t.startsWith('t_'));
    if (!guardList.length) continue;

    /* 想改的列 —— 按「表归属」收集：顺序扫全文，记住最近一次出现的表名，
       alterTable/createTable 之后的 t.xxx('col') 归到那张表；
       hasColumn(T, 'col') 直接归到 T。这样同一文件里改多张表也不会串。 */
    const perTable = new Map(); // table → Set(col)
    const addCol = (t, c) => {
      if (!t || !c) return;
      if (!perTable.has(t)) perTable.set(t, new Set());
      perTable.get(t).add(c);
    };
    const tok = /(alterTable|createTable|hasColumn)\(\s*(?:'([^']+)'|([A-Za-z_$][\w$]*))|t\.\w+\(\s*'([a-z_0-9]+)'|hasColumn\(\s*[^,]+,\s*'([a-z_0-9]+)'|^\s*\['([a-z_0-9]+)',\s*\(t\)/gm;
    let cur = null;
    for (const m of src.matchAll(tok)) {
      if (m[1]) {
        cur = m[2] || constMap.get(m[3]) || m[3];
      } else if (m[4]) {
        addCol(cur, m[4]);
      } else if (m[5]) {
        addCol(cur, m[5]);
      } else if (m[6]) {
        // COLS 数组 → 归到文件级 TABLE 常量
        addCol(constMap.get('TABLE') || constMap.get('T'), m[6]);
      }
    }
    items.push({
      file: `${dir}/${f}`,
      db: DB_OF_DIR[dir] || null,
      guards,
      guardList,
      cols: [...new Set([...perTable.values()].flatMap((v) => [...v]))],
      perTable,
    });
  }
}

/* ---------- 3. 查库 ---------- */
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const tableExists = async (db, t) =>
  !!(await conn.query(
    'select 1 from information_schema.tables where table_schema=? and table_name=? limit 1',
    [db, t],
  ))[0].length;

const colsOf = async (db, t) =>
  new Set(
    (
      await conn.query(
        'select column_name from information_schema.columns where table_schema=? and table_name=?',
        [db, t],
      )
    )[0].map((r) => r.COLUMN_NAME),
  );

const risky = [];
const okSkip = [];
const notSkip = [];

for (const it of items) {
  for (const guardTable of it.guards) {
    // 守卫表是不是统一表本身？（那种守卫是「统一表还没建」，不属于本审计范围）
    if (guardTable.startsWith('t_uni_')) continue;
    const mapped = UNI.get(guardTable);
    const exists = it.db ? await tableExists(it.db, guardTable) : true;

    if (exists) {
      notSkip.push({ ...it, guardTable, note: '老表还在 → 迁移会真正执行' });
      continue;
    }

    if (!mapped) {
      // 没有统一表映射 → 可能是「别的库里的老表还在」（如 sms_consult.t_consult_student）
      const found = (
        await conn.query(
          'select table_schema from information_schema.tables where table_name=?',
          [guardTable],
        )
      )[0].map((r) => r.TABLE_SCHEMA);
      if (!found.length) {
        risky.push({ ...it, guardTable, miss: ['(全库都找不到这张表，改动无处落地)'] });
        continue;
      }
      let missInOther = [];
      for (const schema of found) {
        const have = await colsOf(schema, guardTable);
        const want0 = [...((it.perTable && it.perTable.get(guardTable)) || [])];
        const miss = want0.filter((c) => !have.has(ALIAS[c] || c));
        if (!miss.length) { missInOther = []; break; }
        missInOther = miss;
      }
      if (missInOther.length) {
        risky.push({ ...it, guardTable, uni: found.join('/'), miss: missInOther });
      } else {
        okSkip.push({ ...it, guardTable, uni: found.join('/') });
      }
      continue;
    }

    const uniCols = await colsOf('sms_common', mapped.uni);
    const miss = [];
    const want = [...((it.perTable && it.perTable.get(guardTable)) || [])];
    for (const c of want) {
      const target = ALIAS[c] || c;
      if (!uniCols.has(target)) miss.push(`${c}${target !== c ? `→${target}` : ''}`);
    }
    if (miss.length) risky.push({ ...it, guardTable, uni: mapped.uni, miss });
    else okSkip.push({ ...it, guardTable, uni: mapped.uni });
  }
}

/* ---------- 4. 输出 ---------- */
console.log(`扫到带守卫的迁移 ${items.length} 个／守卫点 ${notSkip.length + okSkip.length + risky.length} 处\n`);

if (risky.length) {
  console.log('⚠️  危险：老表已删、迁移会跳过，但统一表缺列（运行期会报「字段不存在」）');
  for (const r of risky) {
    console.log(`  · ${r.file}`);
    console.log(`      守卫老表 ${r.guardTable} → 统一表 ${r.uni || '?'}  缺: ${r.miss.join(', ')}`);
  }
  console.log('');
} else {
  console.log('✅ 没有「跳过但统一表缺列」的情况\n');
}

if (VERBOSE) {
  console.log('—— 会真正执行（老表还在）——');
  for (const r of notSkip) console.log(`  · ${r.file}  [${r.guardTable}]`);
  console.log('\n—— 安全跳过（统一表已有这些列）——');
  for (const r of okSkip) console.log(`  · ${r.file}  [${r.guardTable} → ${r.uni}]`);
}

await conn.end();
process.exitCode = risky.length ? 1 : 0;
