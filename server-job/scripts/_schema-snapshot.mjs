/**
 * 数据库结构快照 + 基线对比
 * ============================================================
 * 用法：
 *   node scripts/_schema-snapshot.mjs                # 生成快照 + 对比 + 报告
 *   node scripts/_schema-snapshot.mjs --out docs/schema
 *
 * 产物：
 *   <out>/schema-YYYY-MM-DD.sql     全库 DDL（SHOW CREATE TABLE，可直接重建）
 *   <out>/schema-YYYY-MM-DD.json    结构化元数据（列/索引/行数），供下次 diff
 *   docs/数据库结构-YYYY-MM-DD.md    人读报告（概览 + 与基线对比）
 *
 * 基线来源：sql/init/*.sql（uni-tables / legacy-teaching / sms_*.sql）
 *   —— 这些文件本身就是「从权威库 SHOW CREATE TABLE 导出」，格式一致，可直接按列比对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = path.resolve(ROOT, outArg >= 0 ? argv[outArg + 1] : 'docs/schema');

/** 需要纳入快照的库（顺序即报告顺序） */
const SCHEMAS = [
  'sms_common',
  'sms_class',
  'sms_class_jh',
  'sms_job',
  'sms_edu',
  'sms_consult',
  'sms_finance',
  'sms_perm',
  'sms_portal',
];

/** 基线文件 → 它描述的库 */
const BASELINES = [
  { file: 'sql/init/uni-tables.sql', schema: 'sms_common', label: '统一表建表 SQL（2026-10-16）' },
  { file: 'sql/init/legacy-teaching.sql', schema: 'sms_class', label: '历史教学表（P8 前）' },
  { file: 'sql/init/legacy-teaching.sql', schema: 'sms_class_jh', label: '历史教学表（P8 前）' },
  { file: 'sql/init/legacy-teaching.sql', schema: 'sms_job', label: '历史教学表（P8 前）' },
  { file: 'sql/init/sms_consult.sql', schema: 'sms_consult', label: '咨询模块建表 SQL' },
  { file: 'sql/init/sms_finance.sql', schema: 'sms_finance', label: '财务模块建表 SQL' },
  { file: 'sql/init/sms_perm.sql', schema: 'sms_perm', label: '权限模块建表 SQL' },
  { file: 'sql/init/sms_portal.sql', schema: 'sms_portal', label: '门户建表 SQL' },
];

const today = new Date();
const DATE = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

/* ============================================================
 * 1. 采集
 * ============================================================ */

/** 解析 SHOW CREATE TABLE 的正文 → { columns, indexes } */
export function parseCreateTable(ddl) {
  const columns = [];
  const indexes = [];
  const lines = String(ddl).split('\n');
  for (const raw of lines) {
    const line = raw.trim().replace(/,$/, '');
    if (line.startsWith('`')) {
      // `col` type ... [NOT NULL] [DEFAULT xxx] [COMMENT '...']
      const m = line.match(/^`([^`]+)`\s+(.+)$/);
      if (!m) continue;
      const [, name, rest] = m;
      const typeMatch = rest.match(/^([a-z]+(?:\([^)]*\))?(?:\s+unsigned)?)/i);
      const type = (typeMatch?.[1] || '').toLowerCase().replace(/\s+/g, ' ');
      const nullable = !/\bNOT NULL\b/i.test(rest);
      const defMatch = rest.match(/\bDEFAULT\s+('(?:[^'\\]|\\.)*'|[^\s]+)/i);
      const commentMatch = rest.match(/\bCOMMENT\s+'((?:[^'\\]|\\.)*)'/i);
      columns.push({
        name,
        type,
        nullable,
        default: defMatch?.[1] ?? null,
        comment: commentMatch?.[1] ?? '',
      });
      continue;
    }
    if (/^(PRIMARY KEY|UNIQUE KEY|KEY|INDEX|CONSTRAINT|FULLTEXT)/i.test(line)) {
      const km = line.match(/^(PRIMARY KEY|UNIQUE KEY|KEY|INDEX)\s*(?:`([^`]+)`)?\s*\(([^)]*)\)/i);
      if (km) {
        indexes.push({
          name: km[1].toUpperCase() === 'PRIMARY KEY' ? 'PRIMARY' : km[2] || '',
          kind: km[1].toUpperCase(),
          cols: km[3].replace(/`/g, '').replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  return { columns, indexes };
}

async function collect(conn) {
  const out = {};
  for (const schema of SCHEMAS) {
    const [tables] = await conn.query(
      `select table_name tn, table_comment tc from information_schema.tables
        where table_schema = ? and table_type = 'BASE TABLE' order by table_name`,
      [schema],
    );
    if (!tables.length) continue;
    out[schema] = [];
    for (const t of tables) {
      const [ddlRows] = await conn.query(`SHOW CREATE TABLE \`${schema}\`.\`${t.tn}\``);
      const ddl = ddlRows?.[0]?.['Create Table'] || '';
      const { columns, indexes } = parseCreateTable(ddl);
      let rows = null;
      try {
        const [[c]] = await conn.query(`select count(*) c from \`${schema}\`.\`${t.tn}\``);
        rows = Number(c.c);
      } catch {
        rows = null;
      }
      out[schema].push({
        name: t.tn,
        comment: t.tc || '',
        rows,
        columns,
        indexes,
        ddl,
      });
    }
  }
  return out;
}

/* ============================================================
 * 2. 基线解析
 * ============================================================ */

/** 从 sql/init/*.sql 里抽出 { 表名: {columns,indexes} }，只保留指定库的（按 USE 分段） */
export function parseBaseline(file, targetSchema) {
  if (!fs.existsSync(file)) return null;
  const sql = fs.readFileSync(file, 'utf8');
  const blocks = {};

  /* 两种写法都要支持：
     ① 带库名限定：CREATE TABLE `sms_class`.`t_xxx`  （legacy-teaching.sql）
     ② USE 分段：USE `sms_consult`; 之后裸表名        （sms_*.sql） */
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(?:`([^`]+)`\.)?`([^`]+)`\s*\(([\s\S]*?)\n\)\s*ENGINE/gi;
  const hasUse = /USE\s+`?[a-zA-Z0-9_]+`?\s*;/i.test(sql);
  let m;
  let scope = null;
  let lastIndex = 0;
  while ((m = re.exec(sql))) {
    // 这段 CREATE 之前最近的 USE 决定归属
    const head = sql.slice(lastIndex, m.index);
    const uses = [...head.matchAll(/USE\s+`?([a-zA-Z0-9_]+)`?\s*;/gi)];
    if (uses.length) scope = uses[uses.length - 1][1];
    lastIndex = m.index;

    const schemaOfTable = m[1] || scope;
    if (schemaOfTable) {
      if (schemaOfTable !== targetSchema) continue;
    } else if (hasUse) {
      continue; // 有 USE 但这条不在任何库段落里 → 跳过
    }
    blocks[m[2]] = parseCreateTable(m[3]);
  }
  return blocks;
}

/* ============================================================
 * 3. 对比
 * ============================================================ */

function diffTable(base, cur) {
  const out = { added: [], removed: [], changed: [], indexAdded: [], indexRemoved: [] };
  const bm = new Map((base?.columns || []).map((c) => [c.name, c]));
  const cm = new Map((cur?.columns || []).map((c) => [c.name, c]));
  for (const [n, c] of cm) if (!bm.has(n)) out.added.push(c);
  for (const [n, c] of bm) if (!cm.has(n)) out.removed.push(c);
  for (const [n, b] of bm) {
    const c = cm.get(n);
    if (!c) continue;
    const bits = [];
    if (b.type !== c.type) bits.push(`类型 ${b.type} → ${c.type}`);
    if (b.nullable !== c.nullable) bits.push(b.nullable ? '改为 NOT NULL' : '改为可空');
    if (String(b.default) !== String(c.default)) bits.push(`默认 ${b.default ?? '—'} → ${c.default ?? '—'}`);
    if (bits.length) out.changed.push({ name: n, detail: bits.join('；') });
  }
  const bi = new Map((base?.indexes || []).map((i) => [`${i.kind}:${i.cols}`, i]));
  const ci = new Map((cur?.indexes || []).map((i) => [`${i.kind}:${i.cols}`, i]));
  for (const [k, i] of ci) if (!bi.has(k)) out.indexAdded.push(i);
  for (const [k, i] of bi) if (!ci.has(k)) out.indexRemoved.push(i);
  const diffCount =
    out.added.length + out.removed.length + out.changed.length + out.indexAdded.length + out.indexRemoved.length;
  /* ⚠️ 不能写成 { ...out, changed }：会把 out.changed 这个「列变更数组」覆盖成数字 */
  return { ...out, diffCount };
}

/* ============================================================
 * 4. 输出
 * ============================================================ */

function buildSql(snap) {
  const lines = [
    '-- ============================================================',
    `-- 学管系统 · 数据库结构快照 ${DATE}`,
    '-- 生成方式：SHOW CREATE TABLE 逐表导出（不要手改）',
    '-- 覆盖库：' + Object.keys(snap).join(' / '),
    '-- ============================================================',
    'SET NAMES utf8mb4;',
    '',
  ];
  for (const schema of Object.keys(snap)) {
    lines.push(`CREATE DATABASE IF NOT EXISTS \`${schema}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    lines.push(`USE \`${schema}\`;`, '');
    for (const t of snap[schema]) {
      lines.push(`-- ---------- ${schema}.${t.name}（${t.rows ?? '?'} 行）${t.comment ? ' · ' + t.comment : ''} ----------`);
      lines.push(t.ddl.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS '), ';', '');
    }
  }
  return lines.join('\n');
}

function buildReport(snap, diffs) {
  const L = [];
  const totalTables = Object.values(snap).reduce((a, x) => a + x.length, 0);
  const totalCols = Object.values(snap).reduce((a, x) => a + x.reduce((b, t) => b + t.columns.length, 0), 0);
  const totalRows = Object.values(snap).reduce((a, x) => a + x.reduce((b, t) => b + (t.rows || 0), 0), 0);

  L.push(`# 数据库结构快照 · ${DATE}`, '');
  L.push('> 生成方式：`node scripts/_schema-snapshot.mjs`（`SHOW CREATE TABLE` 逐表导出，与 `sql/init/*.sql` 同一口径）', '');
  L.push('## 一、总体情况', '');
  L.push(`- 覆盖 **${Object.keys(snap).length} 个库 / ${totalTables} 张表 / ${totalCols} 个字段 / ${totalRows} 行数据**`);
  L.push(`- 完整 DDL：\`docs/schema/schema-${DATE}.sql\`（可直接重建）`);
  L.push(`- 结构化元数据：\`docs/schema/schema-${DATE}.json\`（列/索引/行数，供下次 diff）`, '');

  L.push('| 库 | 表数 | 字段数 | 行数 | 说明 |', '|---|---|---|---|---|');
  const desc = {
    sms_common: '统一表（教学域唯一真源）',
    sms_class: '大学（P8 后仅剩迁移表）',
    sms_class_jh: '初高（P8 后仅剩迁移表）',
    sms_job: '实训/就业（P8 后仅剩迁移表）',
    sms_edu: '教务对接',
    sms_consult: '咨询/招生',
    sms_finance: '财务',
    sms_perm: '权限',
    sms_portal: '门户账号',
  };
  for (const [schema, tables] of Object.entries(snap)) {
    const cols = tables.reduce((b, t) => b + t.columns.length, 0);
    const rows = tables.reduce((b, t) => b + (t.rows || 0), 0);
    L.push(`| ${schema} | ${tables.length} | ${cols} | ${rows} | ${desc[schema] || ''} |`);
  }
  L.push('');

  L.push('## 二、与基线的结构对比', '');
  L.push('基线 = 仓库里 `sql/init/*.sql` 的建表脚本（都是「从权威库导出」的 DDL，可逐列比对）。', '');

  /* 结论速览（自动生成） */
  L.push('**结论速览**', '');
  for (const d of diffs) {
    const onlyKnex = d.curCount > 0 && (snap[d.schema] || []).every((t) => t.name.startsWith('knex_'));
    if (d.baseCount > 0 && onlyKnex) {
      L.push(`- \`${d.schema}\`：基线 ${d.baseCount} 张老表**已全部 DROP**（P8 数据归一），只剩 knex 迁移表 —— 符合预期`);
    } else if (d.changed === 0) {
      L.push(`- \`${d.schema}\`：与基线**完全一致**，无任何结构改动`);
    } else {
      const bits = [];
      if (d.tablesAdded.length) bits.push(`新增表 ${d.tablesAdded.map((t) => '`' + t + '`').join('、')}`);
      if (d.tablesRemoved.length) bits.push(`消失表 ${d.tablesRemoved.length} 张`);
      if (d.changedTables.length)
        bits.push(`结构变更 ${d.changedTables.length} 张（${d.changedTables.map(([n]) => '`' + n + '`').join('、')}）`);
      L.push(`- \`${d.schema}\`：${bits.join('；')}`);
    }
  }
  const noBase = Object.keys(snap).filter((s) => !diffs.some((d) => d.schema === s));
  if (noBase.length) L.push(`- ${noBase.map((s) => '`' + s + '`').join('、')}：仓库里没有基线 SQL，本次只导出、未比对`);
  L.push('');

  for (const d of diffs) {
    const onlyKnex = d.curCount > 0 && (snap[d.schema] || []).every((t) => t.name.startsWith('knex_'));
    const droppedAsExpected = d.baseCount > 0 && onlyKnex;
    const sign = droppedAsExpected
      ? '✅ 符合预期（老表已 DROP，只剩迁移表）'
      : d.changed === 0
        ? '✅ 无差异'
        : `⚠️ 有差异`;
    L.push(`### ${d.schema} · ${sign}`, '');
    L.push(`基线：\`${d.file}\`（${d.label}）｜基线 ${d.baseCount} 张表，当前 ${d.curCount} 张表`, '');
    if (d.changed === 0) {
      L.push('结构与基线**完全一致**（列名/类型/可空/默认值/索引均未变化）。', '');
      continue;
    }
    L.push(
      `差异构成：新增表 **${d.tablesAdded.length}** · 消失表 **${d.tablesRemoved.length}** · 结构变更表 **${d.changedTables.length}**（列/索引明细 ${d.detailCount} 处）`,
      '',
    );
    if (droppedAsExpected) {
      L.push(
        `P8 阶段已把 ${d.tablesRemoved.length} 张老表全部 DROP（数据归一到 \`sms_common\`），` +
          `本库现在只剩框架的 \`knex_migrations*\`，**属于预期状态**。老表原始 DDL 仍保留在 \`sql/init/legacy-teaching.sql\`。`,
        '',
      );
    } else if (d.tablesRemoved.length) {
      L.push(
        `**基线有、当前已不存在（${d.tablesRemoved.length}）**：` +
          d.tablesRemoved.map((t) => '`' + t + '`').join('、'),
        '',
      );
    }
    if (d.tablesAdded.length) {
      L.push(`**新增表（${d.tablesAdded.length}）**：` + d.tablesAdded.map((t) => '`' + t + '`').join('、'), '');
    }
    for (const [tname, t] of d.changedTables) {
      L.push(`- **${tname}**`);
      if (t.added.length) L.push(`  - 新增列：` + t.added.map((c) => `\`${c.name}\` ${c.type}`).join('、'));
      if (t.removed.length) L.push(`  - 删除列：` + t.removed.map((c) => `\`${c.name}\` ${c.type}`).join('、'));
      if (t.changed.length) L.push(`  - 变更：` + t.changed.map((c) => `\`${c.name}\`（${c.detail}）`).join('；'));
      if (t.indexAdded.length) L.push(`  - 新增索引：` + t.indexAdded.map((i) => `${i.kind}(${i.cols})`).join('、'));
      if (t.indexRemoved.length) L.push(`  - 删除索引：` + t.indexRemoved.map((i) => `${i.kind}(${i.cols})`).join('、'));
    }
    L.push('');
  }

  L.push('## 三、当前全量表清单', '');
  for (const [schema, tables] of Object.entries(snap)) {
    L.push(`### ${schema}（${tables.length}）`, '');
    L.push('| 表 | 字段 | 行数 | 说明 |', '|---|---|---|---|');
    for (const t of tables) {
      L.push(`| \`${t.name}\` | ${t.columns.length} | ${t.rows ?? '?'} | ${t.comment || ''} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

/* ============================================================
 * main
 * ============================================================ */

const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
});

console.log(`连接 ${process.env.DB_HOST}:${process.env.DB_PORT} …`);
const snap = await collect(conn);
await conn.end();

const diffs = [];
for (const b of BASELINES) {
  const base = parseBaseline(path.join(ROOT, b.file), b.schema);
  const cur = snap[b.schema] || [];
  if (!base) continue;
  const baseNames = Object.keys(base);
  const curNames = cur.map((t) => t.name);
  const tables = {};
  let detailCount = 0;
  for (const t of cur) {
    if (!base[t.name]) continue; // 基线没有的表 = 新增表，单独统计（不能按列算差异）
    const d = diffTable(base[t.name], t);
    tables[t.name] = d;
    detailCount += d.diffCount;
  }
  const tablesAdded = curNames.filter((n) => !base[n] && !n.startsWith('knex_'));
  const tablesRemoved = baseNames.filter((n) => !curNames.includes(n));
  const changedTables = Object.entries(tables).filter(([, d]) => d.diffCount > 0);
  const changed = tablesAdded.length + tablesRemoved.length + changedTables.length;
  diffs.push({
    schema: b.schema,
    file: b.file,
    label: b.label,
    baseCount: baseNames.length,
    curCount: cur.length,
    tablesAdded,
    tablesRemoved,
    tables,
    changedTables,
    detailCount,
    changed,
  });
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `schema-${DATE}.sql`), buildSql(snap));
fs.writeFileSync(path.join(OUT, `schema-${DATE}.json`), JSON.stringify({ date: DATE, snapshot: snap }, null, 2));
/** 逐表逐列的明细（「完整表结构」的人读版本） */
function buildColumnsDoc(snap) {
  const L = [];
  L.push(`# 表结构明细 · ${DATE}`, '');
  L.push('> 与 `数据库结构-' + DATE + '.md` 配套；DDL 以 `docs/schema/schema-' + DATE + '.sql` 为准。', '');
  for (const [schema, tables] of Object.entries(snap)) {
    L.push(`## ${schema}`, '');
    for (const t of tables) {
      L.push(`### \`${t.name}\`${t.comment ? ' · ' + t.comment : ''}`, '');
      L.push(`行数 ${t.rows ?? '?'} · 字段 ${t.columns.length} · 索引 ${t.indexes.length}`, '');
      L.push('| 字段 | 类型 | 可空 | 默认 | 说明 |', '|---|---|---|---|---|');
      for (const c of t.columns) {
        L.push(
          `| \`${c.name}\` | ${c.type} | ${c.nullable ? '是' : '否'} | ${c.default ?? '—'} | ${c.comment || ''} |`,
        );
      }
      if (t.indexes.length) {
        L.push('', '索引：' + t.indexes.map((i) => `${i.kind}(${i.cols})`).join('、'));
      }
      L.push('');
    }
  }
  return L.join('\n');
}

const report = buildReport(snap, diffs);
fs.writeFileSync(path.join(ROOT, 'docs', `数据库结构-${DATE}.md`), report);
fs.writeFileSync(path.join(OUT, `表结构明细-${DATE}.md`), buildColumnsDoc(snap));

console.log(`\n快照已生成：`);
console.log(`  ${path.relative(ROOT, path.join(OUT, `schema-${DATE}.sql`))}`);
console.log(`  ${path.relative(ROOT, path.join(OUT, `schema-${DATE}.json`))}`);
console.log(`  docs/数据库结构-${DATE}.md`);
console.log(`\n对比结果：`);
for (const d of diffs) {
  const onlyKnex = d.curCount > 0 && (snap[d.schema] || []).every((t) => t.name.startsWith('knex_'));
  const ok = d.changed === 0 || (d.baseCount > 0 && onlyKnex);
  console.log(`  ${ok ? '✅' : '⚠️ '} ${d.schema.padEnd(14)} 差异 ${d.changed} 处（基线 ${d.baseCount} 表 / 当前 ${d.curCount} 表）`);
}
