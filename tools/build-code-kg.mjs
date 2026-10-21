/**
 * build-code-kg.mjs —— 生成「学管系统代码知识图谱」数据
 *
 * 把整条链路跑通：
 *   页面 .vue → api 封装 → /api/xxx 后端路由 → 处理文件 → 数据库表
 *
 * 产出三个视图（写入 docs/code-kg/data.js）：
 *   1. domain —— 业务领域总览（领域之间的依赖强度）
 *   2. api    —— 接口链路：前端页面 → api 文件 → 后端路由
 *   3. table  —— 数据依赖：业务领域 → 数据表（区分读/写）
 *
 * 用法：
 *   node tools/build-code-kg.mjs            # 生成数据
 *   node tools/build-code-kg.mjs --stats    # 只打印统计，不写文件
 *
 * ⚠️ 纯静态正则分析，不依赖任何索引服务。结论用于「看结构」，
 *    精确引用仍需回到源码核对。
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'docs', 'code-kg');

/** 参与分析的源码根目录 */
const SOURCE_ROOTS = [
  { pkg: 'server-job', dir: join(ROOT, 'server-job', 'src') },
  { pkg: 'web-job', dir: join(ROOT, 'web-job', 'src') },
  { pkg: 'shared-types', dir: join(ROOT, 'shared-types', 'src') },
];

/** 扫描时跳过的目录 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-ssr', '.git', 'build', 'coverage',
  '__tests__', '__mocks__', '_p4-regress', '_p4-schema-dump',
]);

/** 参与分析的扩展名 */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue']);

/**
 * 业务领域划分
 * dirs：后端/前端目录特征；apis：接口前缀特征
 * ⚠️ 顺序即优先级 —— 先命中的生效
 */
const DOMAINS = [
  {
    id: 'perm', name: '权限管理', color: '#7c3aed',
    dirs: [/server-job\/src\/perm\//, /web-job\/src\/perm\//],
    apis: [/\/api\/perm\//],
  },
  {
    id: 'finance', name: '财务管理', color: '#dc2626',
    dirs: [/server-job\/src\/finance\//, /web-job\/src\/finance\//],
    apis: [/\/api\/finance\//],
  },
  {
    id: 'consult', name: '招生咨询', color: '#0891b2',
    dirs: [/server-job\/src\/consult\//, /web-job\/src\/consult\//],
    apis: [/\/api\/consult\//],
  },
  {
    id: 'class-jh', name: '教学管理·初高', color: '#ea580c',
    dirs: [/class-jh\//],
    apis: [/\/api\/class-jh\//],
  },
  {
    id: 'class', name: '班级管理·大学', color: '#2563eb',
    dirs: [/server-job\/src\/class\//, /web-job\/src\/class\//],
    apis: [/\/api\/class\//],
  },
  {
    id: 'job', name: '就业管理', color: '#059669',
    dirs: [/server-job\/src\/routes\//, /web-job\/src\/api\//],
    apis: [/\/api\/job\//],
  },
  {
    id: 'teaching', name: '教务管理', color: '#16a34a',
    dirs: [/server-job\/src\/teaching\//, /web-job\/src\/teaching\//],
    apis: [/\/api\/edu\//],
  },
  {
    id: 'portal', name: '门户/首页', color: '#db2777',
    dirs: [/server-job\/src\/portal\//, /web-job\/src\/portal\//],
    apis: [/\/api\/portal\//],
  },
];
const SHARED = { id: 'shared', name: '公共/共享', color: '#64748b' };
const ALL_DOMAIN_IDS = [...DOMAINS.map((d) => d.id), SHARED.id];

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(name.slice(name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

const rel = (abs) => relative(ROOT, abs).split(sep).join('/');
const posix = (p) => String(p).split(sep).join('/');

/** 归一化 URL：/:id、${id}、/{id} 统一成 :param */
function normalizeUrl(u) {
  const s = String(u)
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/\/:[A-Za-z0-9_]+/g, '/:param')
    .replace(/\/\{[^}]*\}/g, '/:param')
    .replace(/\/+$/, '');
  return s || '/';
}

function joinPath(prefix, sub) {
  const p = String(prefix || '').replace(/\/+$/, '');
  const s = String(sub || '').replace(/^\/+/, '');
  if (!p) return '/' + s;
  if (!s) return p;
  return p + '/' + s;
}

/** 领域判定：先按接口前缀，再按目录 */
function domainOfPath(p) {
  const f = posix(p);
  for (const d of DOMAINS) {
    if (d.apis.some((re) => re.test(f))) return d.id;
  }
  for (const d of DOMAINS) {
    if (d.dirs.some((re) => re.test(f))) return d.id;
  }
  return SHARED.id;
}

// ─────────────────────────────────────────────────────────────
// 1. 收集源码
// ─────────────────────────────────────────────────────────────

const files = [];
for (const { pkg, dir } of SOURCE_ROOTS) {
  for (const abs of walk(dir)) {
    const path = rel(abs);
    files.push({ pkg, abs, path, domain: domainOfPath(path) });
  }
}
const fileByPath = new Map(files.map((f) => [f.path, f]));

const cache = new Map();
function source(f) {
  const abs = typeof f === 'string' ? join(ROOT, f) : f.abs;
  if (!cache.has(abs)) {
    try {
      cache.set(abs, readFileSync(abs, 'utf8'));
    } catch {
      cache.set(abs, '');
    }
  }
  return cache.get(abs);
}

// ─────────────────────────────────────────────────────────────
// 2. 解析路由挂载前缀
//
//    本项目有三套挂载写法，全都覆盖：
//      a) app.use('/api/finance/student', financeAuth, financeStudentRouter)
//      b) 路由表数组：{ path: '/api/class/student', router: studentRouter }
//      c) 文件头注释：接口前缀：/api/job/attendance
//                    挂载：flowRouter → /api/class/flow；repeatRouter → /api/class/repeat
// ─────────────────────────────────────────────────────────────

/** 「文件::原变量名」 → 挂载前缀（最准） */
const prefixByFileVar = new Map();
/** 变量名 → 挂载前缀（跨文件回退） */
const routerPrefix = new Map();

function addPrefix(file, varName, prefix) {
  if (!varName || !prefix) return;
  const k = `${file}::${varName}`;
  if (!prefixByFileVar.has(k)) prefixByFileVar.set(k, prefix);
  if (!routerPrefix.has(varName)) routerPrefix.set(varName, prefix);
}

/** 解析单个文件的 import：本地名 → { orig, from, isDefault } */
const IMPORT_NAMED_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_DEFAULT_RE = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g;

function buildImportMap(file) {
  const map = new Map();
  const src = source(file);
  let m;

  IMPORT_NAMED_RE.lastIndex = 0;
  while ((m = IMPORT_NAMED_RE.exec(src))) {
    const from = m[2];
    for (const raw of m[1].split(',')) {
      const t = raw.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      map.set((as[1] || as[0]).trim(), { orig: as[0].trim(), from, isDefault: false });
    }
  }

  // 默认导入：import X from './y.route'
  IMPORT_DEFAULT_RE.lastIndex = 0;
  while ((m = IMPORT_DEFAULT_RE.exec(src))) {
    if (!map.has(m[1])) map.set(m[1], { orig: null, from: m[2], isDefault: true });
  }

  return map;
}

const importMaps = new Map();
for (const file of files) {
  if (file.pkg !== 'server-job') continue;
  importMaps.set(file.path, buildImportMap(file));
}

/**
 * 把「某文件里用到的本地变量名」还原成「定义它的文件 + 原名」
 * 支持具名导入（含 as 别名）与默认导入（追到目标文件的 export default）
 */
function resolveVar(useFile, localName, depth = 0) {
  if (depth > 3) return null;
  const map = importMaps.get(useFile);
  if (!map || !map.has(localName)) return null;
  const { orig, from, isDefault } = map.get(localName);
  if (!from.startsWith('.')) return null;
  const target = resolveImport({ abs: join(ROOT, useFile), pkg: 'server-job' }, from);
  if (!target) return null;

  if (isDefault) {
    const defVar = defaultExports.get(target);
    if (defVar) return { file: target, varName: defVar };
    // 目标文件只 export 了一个 Router 变量 —— 就当它是
    const vars = routerVarsByFile.get(target);
    if (vars && vars.size === 1) return { file: target, varName: [...vars][0] };
    return null;
  }
  return { file: target, varName: orig };
}

/** 每个文件：export default 的变量名 */
const defaultExports = new Map();
/** 每个文件：由 Router() 创建的变量名集合 */
const routerVarsByFile = new Map();

for (const file of files) {
  if (file.pkg !== 'server-job') continue;
  const src = source(file);
  const vars = new Set(
    (src.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Router\(\)/g) || []).map(
      (s) => s.replace(/(?:const|let|var)\s+/, '').replace(/\s*=\s*Router\(\)/, '')
    )
  );
  routerVarsByFile.set(file.path, vars);

  const dm = src.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;/);
  if (dm) defaultExports.set(file.path, dm[1]);
}

/** (c) 文件头注释兜底：接口前缀 / 挂载 */
function commentPrefixes(src) {
  const out = [];
  const head = src.slice(0, 3000);
  let m;
  const re1 = /接口前缀[：:]\s*([^\s，。；\n*]+)/g;
  while ((m = re1.exec(head))) out.push({ path: m[1] });
  const re2 = /挂载[：:]\s*([^\n*]+)/g;
  while ((m = re2.exec(head))) {
    for (const part of m[1].split(/[；;，,]/)) {
      const mm = part.match(/([A-Za-z_$][\w$]*)\s*(?:→|->|=>)\s*([^\s，。；\n*]+)/);
      if (mm) out.push({ varName: mm[1], path: mm[2] });
      else {
        const only = part.match(/(\/api\/[^\s，。；\n*]+)/);
        if (only) out.push({ path: only[1] });
      }
    }
  }
  return out;
}

const fileDefaultPrefix = new Map();
for (const file of files) {
  if (file.pkg !== 'server-job') continue;
  const ps = commentPrefixes(source(file));
  const plain = ps.filter((p) => !p.varName).map((p) => p.path);
  if (plain.length) fileDefaultPrefix.set(file.path, plain[0]);
}

// (a) app.use('前缀', ... , XRouter)
// (b) { path: '...', router: X } / { router: X, path: '...' }
for (const file of files) {
  if (file.pkg !== 'server-job') continue;
  const src = source(file);
  let m;

  // ⚠️ 挂载点里出现的未必是本名（可能 import 时起了别名，或走 export default），
  //    所以对本语句里的每个标识符都尝试还原一次，能对上就算数
  const NOISE = new Set([
    'app', 'use', 'express', 'cors', 'path', 'authMiddleware', 'classAuthAllowSync',
    'denyApprovalOnlyWrite', 'requirePage', 'checkPermission', 'checkRole', 'r', 'router',
    'Router', 'expressStatic', 'static', 'json', 'urlencoded', 'swaggerUi',
  ]);

  const useRe = /app\.use\(\s*['"]([^'"]+)['"]/g;
  while ((m = useRe.exec(src))) {
    const stmt = src.slice(m.index, m.index + 300);
    const end = stmt.indexOf(');');
    const seg = end > -1 ? stmt.slice(0, end) : stmt;
    for (const id of seg.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (NOISE.has(id)) continue;
      const r = resolveVar(file.path, id);
      if (r) addPrefix(r.file, r.varName, m[1]);
      else if (/Router$|Routes$/.test(id)) addPrefix(null, id, m[1]);
    }
  }

  const tblRe = /\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*router:\s*([A-Za-z_$][\w$]*)\s*\}/g;
  while ((m = tblRe.exec(src))) {
    const r = resolveVar(file.path, m[2]);
    if (r) addPrefix(r.file, r.varName, m[1]);
    else addPrefix(null, m[2], m[1]);
  }

  const tblRe2 = /\{\s*router:\s*([A-Za-z_$][\w$]*)\s*,\s*path:\s*['"]([^'"]+)['"]\s*\}/g;
  while ((m = tblRe2.exec(src))) {
    const r = resolveVar(file.path, m[1]);
    if (r) addPrefix(r.file, r.varName, m[2]);
    else addPrefix(null, m[1], m[2]);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. 后端路由节点
// ─────────────────────────────────────────────────────────────

const ROUTE_DEF_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;

const routeMap = new Map();      // id → route
const edgeRouteDefine = [];      // 文件 → route

for (const file of files) {
  if (file.pkg !== 'server-job') continue;
  const src = source(file);
  if (!src) continue;

  // 本文件里由 Router() 赋值的变量名
  const routerVars = new Set(
    (src.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Router\(\)/g) || []).map(
      (s) => s.replace(/(?:const|let|var)\s+/, '').replace(/\s*=\s*Router\(\)/, '')
    )
  );
  // 仅处理「本文件确实创建了 Router」的文件，避免把 db.get('key') 之类的误判成路由
  if (routerVars.size === 0) continue;

  const defaultPrefix = fileDefaultPrefix.get(file.path) || null;

  ROUTE_DEF_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_DEF_RE.exec(src))) {
    const [, varName, methodRaw, rawPath] = m;
    if (!routerVars.has(varName)) continue;      // 不是本文件的 router 变量
    if (!rawPath.startsWith('/')) continue;      // 不是路径字面量

    const method = methodRaw.toUpperCase();
    const byFile = prefixByFileVar.get(`${file.path}::${varName}`);
    let fullPath;
    if (rawPath.startsWith('/api')) {
      fullPath = rawPath;                         // 已写全路径
    } else if (byFile) {
      fullPath = joinPath(byFile, rawPath);       // 按「文件+变量名」精确还原
    } else if (routerPrefix.get(varName)) {
      fullPath = joinPath(routerPrefix.get(varName), rawPath);
    } else if (defaultPrefix) {
      fullPath = joinPath(defaultPrefix, rawPath);
    } else {
      fullPath = rawPath;                         // 兜底：保留子路径
    }

    const line = src.slice(0, m.index).split('\n').length;
    const id = `route:${method} ${normalizeUrl(fullPath)}`;
    if (!routeMap.has(id)) {
      routeMap.set(id, {
        id, method, path: normalizeUrl(fullPath), raw: fullPath,
        file: file.path, line, domain: domainOfPath(fullPath) !== SHARED.id
          ? domainOfPath(fullPath)
          : domainOfPath(file.path),
      });
    }
    edgeRouteDefine.push({ source: file.path, target: id, type: 'DEFINES', line });
  }
}
const routeList = [...routeMap.values()];

// ─────────────────────────────────────────────────────────────
// 4. 前端 API 调用点
// ─────────────────────────────────────────────────────────────

const HTTP_CALL_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]*\/api\/[^'"`]*)['"`]/g;

const frontendCalls = [];
for (const file of files) {
  if (file.pkg !== 'web-job') continue;
  const src = source(file);
  if (!src) continue;

  HTTP_CALL_RE.lastIndex = 0;
  let m;
  while ((m = HTTP_CALL_RE.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    frontendCalls.push({
      file: file.path,
      line,
      method: m[2].toUpperCase(),
      url: normalizeUrl(m[3]),
      raw: m[3],
    });
  }
}

/** 前端页面(.vue) → api 文件的引用关系 */
const pageApiEdges = [];
for (const file of files) {
  if (!file.path.endsWith('.vue')) continue;
  const src = source(file);
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!/api/i.test(spec)) continue;
    const target = resolveImport(file, spec);
    if (target) pageApiEdges.push({ source: file.path, target, type: 'USES_API' });
  }
}

function resolveImport(file, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(ROOT, file.pkg, 'src', spec.slice(2));
  else if (spec.startsWith('shared-types')) {
    base = join(ROOT, 'shared-types', 'src', spec.replace(/^shared-types\/?/, ''));
  } else base = join(file.abs, '..', spec);

  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.vue`, join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return rel(c);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 5. 数据库表
//
//    表名来源（本项目以动态拼接为主）：
//      · tbl(db, SRC, 't_xxx', STAGE)   —— 路由层统一封装
//      · const TABLE = 't_xxx' 然后 db(TABLE)
//      · SQL 文件里的 `sms_xxx` / `t_xxx`
// ─────────────────────────────────────────────────────────────

const TABLE_LITERAL_RE = /['"`]((?:t|sms|uni|v)_[a-z][a-z0-9_]{2,})['"`]/g;
const CONST_TABLE_RE =
  /(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=\s*['"`]((?:t|sms|uni|v)_[a-z][a-z0-9_]{2,})['"`]/g;
const WRITE_STMT_RE = /\b(insert\s+into|update|delete\s+from)\b/i;

const tableDefs = new Map();
const fileTables = [];

function addTable(name, file, isWrite, line) {
  if (!name) return;
  if (!tableDefs.has(name)) {
    tableDefs.set(name, { name, files: new Set(), writes: new Set(), reads: 0, writesN: 0 });
  }
  const t = tableDefs.get(name);
  t.files.add(file);
  if (isWrite) {
    t.writes.add(file);
    t.writesN++;
  } else {
    t.reads++;
  }
  fileTables.push({ source: file, target: `table:${name}`, type: isWrite ? 'WRITES' : 'READS', line });
}

for (const file of files) {
  if (file.pkg === 'shared-types') continue;
  const src = source(file);
  if (!src) continue;

  // 先扫本文件的表名常量：const TABLE = 't_xxx'
  const constMap = new Map();
  CONST_TABLE_RE.lastIndex = 0;
  let m;
  while ((m = CONST_TABLE_RE.exec(src))) constMap.set(m[1], m[2]);

  // 逐行判断读写：语句里出现 insert/update/delete 视为写
  const lines = src.split('\n');
  lines.forEach((text, idx) => {
    const isWrite = WRITE_STMT_RE.test(text);
    TABLE_LITERAL_RE.lastIndex = 0;
    let mm;
    while ((mm = TABLE_LITERAL_RE.exec(text))) {
      addTable(mm[1], file.path, isWrite, idx + 1);
    }
    // db(TABLE) / tbl(db, SRC, TABLE, STAGE) 形式
    const identRe = /(?:\bdb\(|\btbl\([^,]*,\s*[^,]*,\s*)([A-Z][A-Z0-9_]{2,})/g;
    while ((mm = identRe.exec(text))) {
      const name = constMap.get(mm[1]);
      if (name) addTable(name, file.path, isWrite, idx + 1);
    }
  });
}

const tableList = [...tableDefs.values()]
  .map((t) => ({
    id: `table:${t.name}`,
    name: t.name,
    files: t.files.size,
    reads: t.reads,
    writes: t.writes.size,
    domain: domainOfPath([...t.files][0] || ''),
  }))
  .sort((a, b) => b.reads + b.writes - (a.reads + a.writes));

// ─────────────────────────────────────────────────────────────
// 6. 文件 import 依赖
// ─────────────────────────────────────────────────────────────

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

const imports = [];
for (const file of files) {
  const src = source(file);
  if (!src) continue;
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('shared-types')) continue;
    const target = resolveImport(file, spec);
    if (target) imports.push({ source: file.path, target, spec });
  }
}

// ─────────────────────────────────────────────────────────────
// 7. 组装视图
// ─────────────────────────────────────────────────────────────

/** 视图 1：领域依赖 */
function buildDomainView() {
  const counts = new Map(ALL_DOMAIN_IDS.map((id) => [id, 0]));
  for (const f of files) counts.set(f.domain, (counts.get(f.domain) || 0) + 1);

  const meta = [...DOMAINS, SHARED];
  const nodes = meta
    .map((d) => ({ id: `domain:${d.id}`, label: d.name, type: 'domain', color: d.color, files: counts.get(d.id) || 0 }))
    .filter((n) => n.files > 0);

  const agg = new Map();
  for (const e of imports) {
    const a = fileByPath.get(e.source)?.domain;
    const b = fileByPath.get(e.target)?.domain;
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    agg.set(key, (agg.get(key) || 0) + 1);
  }

  const edges = [...agg.entries()]
    .map(([k, weight]) => {
      const [a, b] = k.split('->');
      return { source: `domain:${a}`, target: `domain:${b}`, type: 'DEPENDS', weight };
    })
    .filter((e) => e.weight >= 3)
    .sort((x, y) => y.weight - x.weight);

  return { nodes, edges };
}

/**
 * 视图 2：接口链路
 *   页面.vue --USES_API--> api 文件 --HTTP_CALLS--> 后端路由
 *   未精确匹配上的调用走「段级模糊匹配」
 */
function buildApiView() {
  const byExact = new Map();
  for (const r of routeList) byExact.set(`${r.method} ${r.path}`, r);

  const edges = [];
  const usedRoutes = new Set();
  const usedFeFiles = new Set();
  const unmatched = [];
  let fuzzyCount = 0;

  for (const c of frontendCalls) {
    let hit = byExact.get(`${c.method} ${c.url}`);
    if (hit) {
      edges.push({ source: `file:${c.file}`, target: hit.id, type: 'HTTP_CALLS', method: c.method, line: c.line, exact: true });
    } else {
      // 模糊：同 method、段数相同、静态段一致，:param 视为通配
      const segs = c.url.split('/').filter(Boolean);
      const cands = routeList.filter((r) => {
        if (r.method !== c.method) return false;
        const rs = r.path.split('/').filter(Boolean);
        if (rs.length !== segs.length) return false;
        return segs.every((s, i) => s === ':param' || rs[i] === ':param' || s === rs[i]);
      });
      if (cands.length) {
        fuzzyCount++;
        for (const r of cands) {
          edges.push({ source: `file:${c.file}`, target: r.id, type: 'HTTP_CALLS', method: c.method, line: c.line, exact: false });
        }
      } else {
        unmatched.push(c);
      }
    }
    if (hit) {
      usedRoutes.add(hit.id);
      usedFeFiles.add(c.file);
    } else {
      for (const e of edges) {
        if (e.line === c.line && e.source === `file:${c.file}`) {
          usedRoutes.add(e.target);
          usedFeFiles.add(c.file);
        }
      }
    }
  }

  // 页面 → api 文件
  const pageEdges = pageApiEdges.filter((e) => usedFeFiles.has(e.target));
  const pages = new Set(pageEdges.map((e) => e.source));

  const nodes = [
    ...[...pages].map((p) => ({
      id: `page:${p}`,
      label: p.replace(/^web-job\/src\//, '').replace(/\.vue$/, ''),
      type: 'page',
      path: p,
      domain: fileByPath.get(p)?.domain || SHARED.id,
    })),
    ...[...usedFeFiles].map((f) => ({
      id: `file:${f}`,
      label: f.replace(/^web-job\/src\//, ''),
      type: 'apifile',
      path: f,
      domain: fileByPath.get(f)?.domain || SHARED.id,
    })),
    ...routeList.filter((r) => usedRoutes.has(r.id)).map((r) => ({
      id: r.id,
      label: `${r.method} ${r.path}`,
      type: 'route',
      method: r.method,          // 给前端按 HTTP 方法着色
      path: r.file,
      line: r.line,
      domain: r.domain,
    })),
  ];

  return {
    nodes,
    edges: [
      ...pageEdges.map((e) => ({ source: `page:${e.source}`, target: `file:${e.target}`, type: 'USES_API' })),
      ...edges,
    ],
    unmatched,
    fuzzyCount,
  };
}

/** 视图 3：领域 → 数据表 */
function buildTableView() {
  const used = new Set(fileTables.map((e) => e.target));
  const tables = tableList.filter((t) => used.has(t.id));

  const domainsInvolved = new Set(tables.map((t) => t.domain));
  const meta = [...DOMAINS, SHARED].filter((d) => domainsInvolved.has(d.id));

  const agg = new Map();
  for (const e of fileTables) {
    const dom = fileByPath.get(e.source)?.domain || SHARED.id;
    const key = `${dom}->${e.target}`;
    const prev = agg.get(key) || { source: `domain:${dom}`, target: e.target, weight: 0, write: 0, read: 0 };
    prev.weight++;
    if (e.type === 'WRITES') prev.write++; else prev.read++;
    agg.set(key, prev);
  }

  const nodes = [
    ...meta.map((d) => ({ id: `domain:${d.id}`, label: d.name, type: 'domain', color: d.color })),
    ...tables.map((t) => ({
      id: t.id, label: t.name, type: 'table',
      reads: t.reads, writes: t.writes, files: t.files, domain: t.domain,
    })),
  ];

  const edges = [...agg.values()].map((e) => ({
    source: e.source,
    target: e.target,
    type: e.write > 0 ? 'WRITES' : 'READS',
    weight: e.weight,
  }));

  return { nodes, edges };
}

const domainView = buildDomainView();
const apiView = buildApiView();
const tableView = buildTableView();

const stats = {
  files: files.length,
  routes: routeList.length,
  frontendCalls: frontendCalls.length,
  apiEdges: apiView.edges.filter((e) => e.type === 'HTTP_CALLS').length,
  apiExact: apiView.edges.filter((e) => e.type === 'HTTP_CALLS' && e.exact).length,
  apiFuzzyCalls: apiView.fuzzyCount,
  apiUnmatched: apiView.unmatched.length,
  tables: tableList.length,
  imports: imports.length,
  pages: apiView.nodes.filter((n) => n.type === 'page').length,
  domainNodes: domainView.nodes.length,
  domainEdges: domainView.edges.length,
};

// ─────────────────────────────────────────────────────────────
// 8. 输出
// ─────────────────────────────────────────────────────────────

if (process.argv.includes('--stats')) {
  console.log(JSON.stringify(stats, null, 2));
  console.log('\n--- 领域分布 ---');
  for (const n of domainView.nodes) console.log(`  ${n.label}: ${n.files} 文件`);
  console.log('\n--- 领域依赖边 ---');
  for (const e of domainView.edges) console.log(`  ${e.source} → ${e.target}  (${e.weight})`);
  console.log('\n--- Top 25 表 ---');
  for (const t of tableList.slice(0, 25)) {
    console.log(`  ${t.name}  reads=${t.reads} writes=${t.writes} files=${t.files} [${t.domain}]`);
  }
  console.log('\n--- 未匹配前端调用（前 25）---');
  for (const u of apiView.unmatched.slice(0, 25)) {
    console.log(`  ${u.method} ${u.raw}   (${u.file}:${u.line})`);
  }
  const noApi = routeList.filter((r) => !r.path.startsWith('/api'));
  console.log(`\n--- 未拼上前缀的后端路由: ${noApi.length}/${routeList.length}（前 25）---`);
  for (const r of noApi.slice(0, 25)) {
    console.log(`  ${r.method} ${r.path}   [${r.file}:${r.line}]`);
  }
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

/** 明细关系（供详情面板做「点击一条路由，看它最终碰了哪些表」） */
const fileTableAgg = new Map();
for (const e of fileTables) {
  const k = `${e.source}|${e.target}|${e.type}`;
  const prev = fileTableAgg.get(k) || { source: e.source, target: e.target, type: e.type, weight: 0 };
  prev.weight++;
  fileTableAgg.set(k, prev);
}

const payload = {
  generatedAt: new Date().toISOString(),
  root: ROOT.split(sep).join('/'),
  stats,
  views: {
    domain: { nodes: domainView.nodes, edges: domainView.edges },
    api: { nodes: apiView.nodes, edges: apiView.edges },
    table: { nodes: tableView.nodes, edges: tableView.edges },
  },
  relations: {
    fileTables: [...fileTableAgg.values()],
    pageApi: pageApiEdges,
  },
  meta: {
    packages: SOURCE_ROOTS.map((s) => s.pkg),
    domains: [...DOMAINS, SHARED].map((d) => ({ id: d.id, name: d.name, color: d.color })),
  },
};

writeFileSync(
  join(OUT_DIR, 'data.js'),
  `/* 自动生成，请勿手改 —— 由 tools/build-code-kg.mjs 产出 */\nwindow.KG_DATA = ${JSON.stringify(payload)};\n`,
  'utf8'
);
console.log('已生成 docs/code-kg/data.js');
console.log(JSON.stringify(stats, null, 2));
