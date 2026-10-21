#!/usr/bin/env node
/**
 * 函数扫描器 —— 扫出项目里所有函数/方法/箭头函数定义
 *
 * 用法：
 *   node tools/scan-functions.mjs              # 生成清单 + 打印统计
 *   node tools/scan-functions.mjs --stats       # 只打印统计
 *   node tools/scan-functions.mjs --top 30      # 统计里显示 Top N 文件
 *
 * 产出：
 *   docs/code-kg/functions.json   结构化清单（供浏览器/其它工具消费）
 *   docs/code-kg/functions.html   可搜索的函数浏览器（自绘，离线可开）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const rel = (p) => relative(ROOT, p).split(sep).join('/');

const SOURCE_ROOTS = [
  { pkg: 'server-job', dir: 'server-job/src' },
  { pkg: 'web-job', dir: 'web-job/src' },
  { pkg: 'shared-types', dir: 'shared-types/src' },
];

const EXTS = ['.ts', '.tsx', '.vue', '.js', '.mjs'];

/* ---------------- 收集文件 ---------------- */

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'build', 'coverage'].includes(name)) continue;
      walk(full, out);
    } else if (EXTS.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const s of SOURCE_ROOTS) {
  for (const f of walk(join(ROOT, s.dir))) {
    files.push({ abs: f, path: rel(f), pkg: s.pkg });
  }
}

const srcCache = new Map();
function source(file) {
  if (!srcCache.has(file.abs)) srcCache.set(file.abs, readFileSync(file.abs, 'utf8'));
  return srcCache.get(file.abs);
}

/* ---------------- 业务领域划分 ---------------- */

const DOMAINS = [
  { id: 'dorm', name: '宿舍', match: [/dorm/i, /bed/i, /room/i, /building/i] },
  { id: 'student', name: '学生档案', match: [/student/i, /archive/i, /档案/] },
  { id: 'leave', name: '请假/异动', match: [/leave/i, /异动/, /changetrack/i, /transfer/i] },
  { id: 'class', name: '班级', match: [/class/i, /班级/] },
  { id: 'course', name: '课程/排课', match: [/course/i, /schedule/i, /排课/, /课程/] },
  { id: 'score', name: '成绩', match: [/score/i, /grade/i, /成绩/] },
  { id: 'exam', name: '考试', match: [/exam/i, /考试/] },
  { id: 'attendance', name: '考勤', match: [/attendance/i, /考勤/] },
  { id: 'finance', name: '财务/缴费', match: [/finance/i, /fee/i, /pay/i, /缴费/, /收费/] },
  { id: 'perm', name: '权限', match: [/perm/i, /role/i, /auth/i, /权限/] },
  { id: 'portal', name: '门户/账号', match: [/portal/i, /account/i, /login/i, /user/i] },
  { id: 'consult', name: '招生咨询', match: [/consult/i, /咨询/, /招生/] },
  { id: 'teaching', name: '教务合并域', match: [/teaching\//i] },
  { id: 'edu', name: '教务板块', match: [/\/edu\//i, /edu[A-Z]/] },
];

const domainCache = new Map();
function domainOf(path) {
  if (domainCache.has(path)) return domainCache.get(path);
  let id = 'shared';
  for (const d of DOMAINS) {
    if (d.match.some((re) => re.test(path))) { id = d.id; break; }
  }
  domainCache.set(path, id);
  return id;
}

/** 代码角色：这个函数在架构里干什么活（按顺序命中，越靠前越优先） */
const ROLES = [
  { id: 'route', name: '后端路由 handler', match: [/\.route\.ts$/, /\/routes\//] },
  { id: 'middleware', name: '中间件/守卫', match: [/middleware/, /guard/i, /auth/i] },
  { id: 'service', name: '后端 service', match: [/\.service\.ts$/, /\/services?\//] },
  { id: 'repo', name: '数据访问 repo', match: [/repo\./, /\.repo\.ts$/, /db\.ts$/, /\/db\//] },
  { id: 'view', name: '前端页面 .vue', match: [/\.vue$/, /\/views\//] },
  { id: 'api', name: '前端 API 封装', match: [/\/api\//, /^web-job\/src\/api\//] },
  { id: 'store', name: '状态 store', match: [/\/store\//, /store\.ts$/] },
  { id: 'composable', name: '组合式 hook', match: [/\/composables?\//, /\/hooks?\//, /use[A-Z]/] },
  { id: 'config', name: '配置/常量', match: [/config/, /menu\.ts$/, /domainConfig/, /constants?/] },
  { id: 'test', name: '测试', match: [/\.spec\.ts$/, /\.test\.ts$/, /\/__tests__\//] },
  { id: 'util', name: '工具函数', match: [/\/utils?\//, /\/lib\//, /\/shared\//, /helpers?/] },
];

const roleCache = new Map();
function roleOf(path) {
  if (roleCache.has(path)) return roleCache.get(path);
  let id = 'other';
  for (const r of ROLES) {
    if (r.match.some((re) => re.test(path))) { id = r.id; break; }
  }
  roleCache.set(path, id);
  return id;
}

/* ---------------- 解析函数 ---------------- */

/** 去掉注释（保留长度，避免行号错位） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
            .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, ' '));
}

const FUNCS = [];

function push(entry) {
  if (!entry.name || entry.name.length > 80) return;
  if (/^[A-Z][A-Z0-9_]*$/.test(entry.name)) return;   // 常量
  FUNCS.push(entry);
}

/** 从「(」开始读完整参数列表，返回签名里的参数串 */
function readParams(src, open) {
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    else if (c === '\n' && depth === 0) break;
  }
  return src.slice(open, Math.min(i + 1, open + 120));
}

/** 判断某行是否导出行（往上回溯 3 行找 export） */
function isExported(lines, idx) {
  for (let k = idx; k >= Math.max(0, idx - 3); k--) {
    const t = lines[k].trim();
    if (/^export\s/.test(t)) return true;
    if (/^(async\s+)?function\b/.test(t) && k === idx) continue;
  }
  // export 与定义同行
  return /^export\s/.test(lines[idx].trim());
}

function scanTs(file, src) {
  const cleaned = stripComments(src);
  const lines = cleaned.split('\n');

  // 1) function 声明： [export] [async] function name(
  const declRe = /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = declRe.exec(cleaned))) {
    const line = cleaned.slice(0, m.index).split('\n').length;
    const params = readParams(cleaned, m.index + m[0].length - 1);
    push({
      name: m[5], kind: 'function', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path),
      async: !!m[4], exported: !!m[2] || isExported(lines, line - 1),
      signature: `${m[4] ? 'async ' : ''}${m[5]}${params}`,
    });
  }

  // 2) 变量赋值的函数： const/let/var name = [async] (args) => | function
  const arrowRe = /^(\s*)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]+)?=>/gm;
  while ((m = arrowRe.exec(cleaned))) {
    if (m[1].length > 0 && !/^\s{0,2}$/.test(m[1])) continue;   // 只看顶层（缩进≤2）
    const line = cleaned.slice(0, m.index).split('\n').length;
    push({
      name: m[3], kind: 'arrow', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path),
      async: !!m[4], exported: !!m[2],
      signature: `${m[4] ? 'async ' : ''}${m[3]} = (${m[5] ?? m[6]}) =>`,
    });
  }

  const fnExprRe = /^(\s*)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?function\s*\*?\s*\(([^)]*)\)/gm;
  while ((m = fnExprRe.exec(cleaned))) {
    if (m[1].length > 2) continue;
    const line = cleaned.slice(0, m.index).split('\n').length;
    push({
      name: m[3], kind: 'function-expr', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path),
      async: !!m[4], exported: !!m[2],
      signature: `${m[4] ? 'async ' : ''}${m[3]} = function(${m[5] ?? ''})`,
    });
  }

  // 3) 类方法（含 async / static / get / set / private）
  const methodRe = /^(\s{2,6})(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:\?)?\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/gm;
  while ((m = methodRe.exec(cleaned))) {
    const name = m[2];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor'].includes(name)) continue;
    const line = cleaned.slice(0, m.index).split('\n').length;
    // 只在 class 体内才算方法：往上找最近的 class 声明，且中间没有顶层结束
    let inClass = false;
    for (let k = line - 1; k >= Math.max(0, line - 80); k--) {
      if (/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w/.test(lines[k - 1] ?? '')) { inClass = true; break; }
      if (/^\}/.test(lines[k - 1] ?? '')) break;
    }
    if (!inClass) continue;
    push({
      name, kind: 'method', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path),
      async: /async\s+/.test(m[0]) || /async\s/.test(lines[line - 1]),
      exported: false,
      signature: `${name}(${m[3]})`,
    });
  }
}

function scanVue(file, src) {
  const cleaned = stripComments(src);
  // <script setup> 里的顶层函数（含 Vue SFC 全量 script）
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let sm;
  while ((sm = scriptRe.exec(src))) {
    const body = sm[1];
    const offsetLine = src.slice(0, sm.index).split('\n').length - 1;
    scanTsOffset(file, stripComments(body), offsetLine);
  }
}

function scanTsOffset(file, cleaned, offsetLine) {
  const lines = cleaned.split('\n');
  const declRe = /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = declRe.exec(cleaned))) {
    const line = cleaned.slice(0, m.index).split('\n').length + offsetLine;
    const params = readParams(cleaned, m.index + m[0].length - 1);
    push({
      name: m[5], kind: 'function', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path), async: !!m[4], exported: !!m[2],
      signature: `${m[4] ? 'async ' : ''}${m[5]}${params}`,
    });
  }
  const arrowRe = /^(\s*)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]+)?=>/gm;
  while ((m = arrowRe.exec(cleaned))) {
    const line = cleaned.slice(0, m.index).split('\n').length + offsetLine;
    push({
      name: m[3], kind: 'arrow', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path), async: !!m[4], exported: !!m[2],
      signature: `${m[4] ? 'async ' : ''}${m[3]} = (${m[5] ?? m[6]}) =>`,
    });
  }
  // Vue 组件 methods / composable 返回的键： name(...) {
  const vueMethodRe = /^(\s{2,8})([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm;
  while ((m = vueMethodRe.exec(cleaned))) {
    const name = m[2];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor'].includes(name)) continue;
    const line = cleaned.slice(0, m.index).split('\n').length + offsetLine;
    push({
      name, kind: 'vue-method', file: file.path, pkg: file.pkg, line,
      domain: domainOf(file.path), async: /async\s/.test(lines[line - 1 - offsetLine] ?? ''),
      exported: false, signature: `${name}(${m[3]})`,
    });
  }
}

for (const file of files) {
  const src = source(file);
  if (file.path.endsWith('.vue')) scanVue(file, src);
  else scanTs(file, src);
}

/* ---------------- 去重（同文件同名同行的） ---------------- */

const seen = new Set();
const funcs = FUNCS.filter((f) => {
  const k = `${f.file}:${f.line}:${f.name}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
})
  .map((f) => ({ ...f, role: roleOf(f.file) }))
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

/* ---------------- 统计 ---------------- */

const topN = Number((process.argv.find((a) => a === '--top') && process.argv[process.argv.indexOf('--top') + 1]) || 15);

const by = (key) => {
  const m = new Map();
  for (const f of funcs) m.set(f[key], (m.get(f[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const stats = {
  total: funcs.length,
  files: files.length,
  byPkg: by('pkg'),
  byKind: by('kind'),
  byDomain: by('domain'),
  byRole: by('role'),
  asyncCount: funcs.filter((f) => f.async).length,
  exportedCount: funcs.filter((f) => f.exported).length,
  topFiles: (() => {
    const m = new Map();
    for (const f of funcs) m.set(f.file, (m.get(f.file) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  })(),
  topNames: (() => {
    const m = new Map();
    for (const f of funcs) m.set(f.name, (m.get(f.name) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  })(),
};

console.log('=== 函数扫描统计 ===');
console.log(`扫描文件 ${stats.files} 个，检出函数 ${stats.total} 个`);
console.log(`  异步 ${stats.asyncCount}   导出 ${stats.exportedCount}`);
console.log('\n--- 按包 ---');
for (const [k, v] of stats.byPkg) console.log(`  ${k.padEnd(14)} ${v}`);
console.log('\n--- 按种类 ---');
const KIND_LABEL = { function: 'function 声明', arrow: '箭头函数', 'function-expr': '函数表达式', method: '类方法', 'vue-method': 'Vue 方法/回调' };
for (const [k, v] of stats.byKind) console.log(`  ${(KIND_LABEL[k] || k).padEnd(14)} ${v}`);
console.log('\n--- 按代码角色 ---');
const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.name]));
ROLE_LABEL.other = '其它';
for (const [k, v] of stats.byRole) console.log(`  ${(ROLE_LABEL[k] || k).padEnd(18)} ${v}`);
console.log('\n--- 按业务领域 ---');
const DOMAIN_LABEL = Object.fromEntries(DOMAINS.map((d) => [d.id, d.name]));
DOMAIN_LABEL.shared = '通用/未归类';
for (const [k, v] of stats.byDomain) console.log(`  ${(DOMAIN_LABEL[k] || k).padEnd(18)} ${v}`);
console.log(`\n--- 函数最多的 ${topN} 个文件 ---`);
for (const [f, v] of stats.topFiles) console.log(`  ${String(v).padStart(4)}  ${f}`);
console.log(`\n--- 重名最多的 ${topN} 个函数名 ---`);
for (const [n, v] of stats.topNames) console.log(`  ${String(v).padStart(4)}  ${n}()`);

if (process.argv.includes('--stats')) process.exit(0);

/* ---------------- 产出 ---------------- */

const OUT_DIR = join(ROOT, 'docs', 'code-kg');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const payload = {
  generatedAt: new Date().toISOString(),
  stats,
  labels: { kind: KIND_LABEL, role: ROLE_LABEL, domain: DOMAIN_LABEL },
  funcs,
};

const json = JSON.stringify(payload);
writeFileSync(join(OUT_DIR, 'functions.json'), json, 'utf8');
// 同时写成 JS 赋值，让 HTML 双击（file://）也能读到，不受 fetch 跨域限制
writeFileSync(join(OUT_DIR, 'functions.js'), 'window.FUNC_DATA = ' + json + ';\n', 'utf8');
console.log(`\n✅ 已写出 docs/code-kg/functions.json（${(json.length / 1024).toFixed(0)} KB）`);
console.log(`✅ 已写出 docs/code-kg/functions.js（供 HTML 离线读取）`);
console.log(`👉 浏览器打开 docs/code-kg/functions.html 可搜索浏览`);
