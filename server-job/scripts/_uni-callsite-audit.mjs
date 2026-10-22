/**
 * 切读层**调用点**审计：把每个 `tbl(连接, 库, 表, 学段)` 的实参解析出来，
 * 去真实库里核对「这个库 + 这张表」是否真的存在。
 *
 * ============================================================
 * 【为什么必须单独有这个检查 —— tsc 抓不到的那一类错】
 * ============================================================
 *   P3/P4 把几十处 `db('老表')` 改写成了 `tbl(db, 库, 表, 学段)`。
 *   改写时最容易犯、也最致命的错是**把库名或表名写错/写反**：
 *
 *     · 表名写错   → `tbl(db, 'sms_job', 't_class_student', 'job')`
 *     · 库名写错   → `tbl(db, 'sms_class', 't_job_dorm', 'class')`
 *
 *   这两种错 **TypeScript 全部查不出来**（都是字符串），
 *   而症状是运行时 `ER_NO_SUCH_TABLE` →
 *   errorHandler 把它翻译成「**数据表不存在（请先执行 npm run migrate）**」
 *   —— 极具误导：迁移全跑了，是调用点写错了库/表。
 *
 * 【为什么不能靠「跑一遍接口」代替】
 *   `src/routes/*`（P3 的 23 个文件）**没有任何自检套件覆盖**
 *   （`_e2e-*.mjs` 里 `/api/job/*` 与 `/api/edu/*` 命中数全是 0），
 *   跑套件根本触不到这些改写点。所以要在**静态层**把它们核干净。
 *
 * ============================================================
 * 检查内容
 * ============================================================
 *   ① 每个调用点的 `(库, 表)` 组合在真实库里存在吗？
 *   ② 该 `(库, 表)` 是否登记在 `UNI_MAP`？（没登记 = 开关开时会静默回退老表）
 *   ③ 实参无法解析成字面量时（用了变量/表达式）单独列出，人工复核
 *
 * 跑法：cd server-job && node scripts/_uni-callsite-audit.mjs
 *      （需要库连得上；只读 information_schema）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { UNI_MAP } from './_e2e-lib.mjs';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const knex = require('knex');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

/** 需要审计的切读函数：函数名 → [库名参数下标, 表名参数下标] */
const FN_ARGS = {
  tbl: [1, 2],
  tblTrx: [1, 2],
  tblIns: [1, 2],
  tblInsTrx: [1, 2],
  tblAs: [1, 2],
  tblRef: [0, 1],
};

/**
 * ★ 已人工核实的「动态实参」调用点白名单
 *
 * 这些位置的库名/表名在运行期才确定（走变量 / 对象字段 / 配置表），
 * 静态解析不了 —— 但**已经逐个核过**，写在这里让 ③ 只报「新增的未知项」。
 * 新增条目时必须写清「核对结论」，否则白名单就退化成了「眼不见为净」。
 */
const EXPECTED_DYNAMIC = new Map([
  ['src/class-jh/middleware/dataScope.ts', '调用方传 (sms_class_jh, t_class_info) —— 已核'],
  ['src/routes/auth.route.ts', '字面量来源清单 (sms_class,t_class_info)+(sms_job,t_job_class) —— 已核'],
  ['src/routes/notice.route.ts', "NOTICE_TABLE 来自 utils/notice，值 't_job_notice' —— 已核"],
  ['src/routes/refund.route.ts', "APPROVAL_TABLE 来自 utils/approval，值 't_job_approval' —— 已核"],
  ['src/routes/studentLeave.route.ts', "同上（APPROVAL_TABLE）—— 已核"],
  ['src/teaching/exam/uniExamUnique.ts', 'CONF 三对 (jh/class/job) 均已登记 —— 已核'],
  ['src/utils/stageScope.ts', 'refOf() 内部转调 tblRef，表名来自调用方 —— 见 applyTrainingScope'],
  ['src/teaching/shared/uniTable.ts', '函数**签名声明**本身，不是调用点（扫描器的固有噪声）'],
]);

/** 递归收集 src 下的 .ts（跳过声明文件） */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * ★ 去掉注释（行注释 + 块注释），但**保留字符串字面量里的内容**
 *
 * 【为什么必须去注释】
 *   本仓库的切读改造大量写在 JSDoc 里，例如
 *     `· 老写法：db('t_class_approval_log')`
 *     `· tbl(db, 'sms_class_jh', 'xxx', 'jh')`
 *   不去注释就会把这些**举例说明**当成真实调用点，
 *   于是报出一堆假阳性（第一版跑出 1298 个「调用点」，绝大部分是注释）。
 *   ⚠️ 去注释必须状态机化：不能简单 `src.replace(/\/\/.*$/gm,'')`，
 *      否则 `'http://x'` 这种字符串会被从中间截断。
 */
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 1; // 跳过结尾 '/'
      continue;
    }
    out += ch;
  }
  return out;
}

/** 按「顶层逗号」切分实参串 */
function splitArgs(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 取 `名称 → 字符串字面量`（只认最朴素的 const X = 'xxx'） */
function constMapOf(src) {
  const m = new Map();
  const re = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*'([^']*)'\s*;/g;
  let hit;
  while ((hit = re.exec(src))) m.set(hit[1], hit[2]);
  return m;
}

/** 把实参表达式解析成字符串；解析不了返回 null */
function resolve(arg, consts) {
  if (!arg) return null;
  const lit = arg.match(/^'([^']*)'$/);
  if (lit) return lit[1];
  const lit2 = arg.match(/^"([^"]*)"$/);
  if (lit2) return lit2[1];
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) return consts.get(arg) ?? null;
  return null;
}

async function main() {
  const db = knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      charset: 'utf8mb4',
    },
  });

  const rows = await db('information_schema.TABLES').select(
    'TABLE_SCHEMA as s',
    'TABLE_NAME as t',
  );
  const exists = new Set(rows.map((r) => `${r.s}.${r.t}`));

  const bad = [];
  const unregistered = [];
  const unresolved = [];
  const allowlisted = [];
  let total = 0;

  for (const file of walk(SRC)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    if (!/\btbl(?:Trx|InsTrx|Ins|As|Ref)?\s*\(/.test(src)) continue;
    const consts = constMapOf(src);
    const rel = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');

    for (const [fn, [dbIdx, tbIdx]] of Object.entries(FN_ARGS)) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'g');
      let hit;
      while ((hit = re.exec(src))) {
        // 取到配对的右括号
        let i = hit.index + hit[0].length;
        let depth = 1;
        let quote = null;
        for (; i < src.length && depth > 0; i += 1) {
          const ch = src[i];
          if (quote) { if (ch === quote && src[i - 1] !== '\\') quote = null; continue; }
          if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
          if (ch === '(') depth += 1;
          else if (ch === ')') depth -= 1;
        }
        const argsStr = src.slice(hit.index + hit[0].length, i - 1);
        const args = splitArgs(argsStr);
        const dbName = resolve(args[dbIdx], consts);
        const table = resolve(args[tbIdx], consts);
        total += 1;

        if (!dbName || !table) {
          const known = EXPECTED_DYNAMIC.get(rel);
          if (!known) {
            unresolved.push(`${rel}  ${fn}(${argsStr.replace(/\s+/g, ' ').slice(0, 70)})`);
          } else {
            allowlisted.push(`${rel}  ${fn}(…)  —— ${known}`);
          }
          continue;
        }
        const key = `${dbName}.${table}`;
        if (!exists.has(key)) bad.push(`${rel}  ${fn} → ${key}  ❌ 库中不存在这张表`);
        else if (!UNI_MAP[key]) unregistered.push(`${rel}  ${fn} → ${key}  ⚠️ 未登记 UNI_MAP（开关开会静默回退老表）`);
      }
    }
  }

  console.log(`\n共审计 ${total} 个切读调用点\n`);

  console.log(`########## ① (库,表) 在真实库里不存在（★ 必修，否则运行时 ER_NO_SUCH_TABLE）##########`);
  console.log(bad.length ? bad.join('\n') : '  ✅ 无');

  console.log(`\n########## ② (库,表) 未登记 UNI_MAP（合规但要注意）##########`);
  console.log(unregistered.length ? unregistered.join('\n') : '  ✅ 无');

  console.log(`\n########## ③ 实参无法静态解析（★ 新增项需人工核实，核实后加进白名单）##########`);
  console.log(unresolved.length ? unresolved.join('\n') : '  ✅ 无（新增项为 0）');

  console.log(`\n########## ④ 白名单内的动态调用点（已核实，供复核）##########`);
  console.log(allowlisted.length ? allowlisted.join('\n') : '  —');

  console.log(
    `\n===== 结论：${total} 个调用点，致命 ${bad.length}，未登记 ${unregistered.length}，` +
      `待核实 ${unresolved.length}，白名单 ${allowlisted.length} =====`,
  );

  await db.destroy();
  process.exit(bad.length || unresolved.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
