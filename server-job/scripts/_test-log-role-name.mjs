/**
 * 回归守卫：「操作日志 → 所属职位」必须是中文名，不能是英文编码
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户给两张截图：图一是操作日志列表，「所属职位」整列显示 `SYS_STAFF` / `—`；
 *   图二是账号管理的同一列，是中文胶囊（教员 / 项目经理 / 财务 …）。
 *   要求「按图二的样子显示，不要显示英文」。
 *
 * 【根因（分两层，都要钉住）】
 *   ① 门户登录签发的 token 里 `roles` **只有粗粒度身份** SYS_ADMIN / SYS_STAFF
 *      （见 class/middleware/auth.ts 注释），而 SYS_STAFF 在 t_perm_role 里根本没有对应行
 *      → 老的 `map.get(p) || p` 把它原样留成英文；
 *   ② 日志的 `operator_id` 是**门户账号 id**（t_sys_account.id，UUID），
 *      而权限库账号主键是 U001 / U_chenxf —— **两套不是一张表**，
 *      按 t_perm_user 查 id 一行都查不到（第一版就踩了这个，表现为「兜底不生效」）。
 *
 * 【现在的口径】resolveLogRoleLabels：中文原样 → 编码查名 → 权限库职位（按 id）
 *   → 权限库职位（按姓名，与账号管理页对齐）→ 门户账号 title → 中文兜底。
 *   写日志（addLog）与读日志（list/detail/export/overview）共用同一套。
 *
 * 跑法：cd server-job && node scripts/_test-log-role-name.mjs
 * （第二部分需要 5173 + 8004 已启动；未启动自动跳过）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { login, req, BASE } from './_e2e-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

let pass = 0;
let fail = 0;
const lines = [];
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    lines.push(`  ✅ ${label}${extra ? '  —— ' + extra : ''}`);
  } else {
    fail++;
    lines.push(`  ❌ ${label}${extra ? '  —— ' + extra : ''}`);
  }
};

/** 「像英文编码」：连续 3 个以上大写字母/下划线（中文名里不会出现） */
const hasEnglishCode = (s) => /[A-Z_]{3,}/.test(s || '');

/* ============================================================
 * 一、静态：四处都走同一个解析层
 * ============================================================ */

const SVC = P('server-job/src/perm/services/perm.service.ts');
const LOG = P('server-job/src/perm/routes/log.route.ts');
const OVW = P('server-job/src/perm/routes/overview.route.ts');
const EXP = P('server-job/src/perm/routes/export.route.ts');
const VIEW = P('web-job/src/perm/views/LogQuery.vue');
const CSS = P('web-job/src/shared-ui/shared-ui.css');

const svc = stripComments(read(SVC));
const logSrc = stripComments(read(LOG));
const viewSrc = stripComments(read(VIEW));
const cssSrc = read(CSS);

check('服务层导出 resolveLogRoleLabels', /export async function resolveLogRoleLabels/.test(svc));
check('服务层有门户账号 title 兜底（operator_id 是 t_sys_account.id，不是 t_perm_user.id）',
  /portalTitleByAccountIds/.test(svc) && /t_sys_account/.test(svc));
check('服务层有按姓名兜底（门户 id 与权限库 id 对不上时用姓名连）',
  /roleNamesByUserNames/.test(svc) && /user_name/.test(svc));
check('服务层有门户级编码的中文兜底表（SYS_ADMIN / SYS_STAFF / ROLE_SERVICE）',
  /PORTAL_LEVEL_ROLE_LABELS/.test(svc) && count(svc, 'SYS_STAFF') >= 1);
check('写日志也走同一套口径（toRoleNames 带 operatorId + operatorName）',
  /toRoleNames\(input\.operatorRole \|\| '', input\.operatorId, input\.operatorName\)/.test(svc));

check('日志列表：toLogItem 接受解析后的 roleLabel', /function toLogItem\(r: any, roleLabel\?: string\)/.test(logSrc));
check('日志列表：批量解析（toLogItems），不逐行查库', /await toLogItems\(rows\)/.test(logSrc));
check('日志详情：也解析（不能列表中文、详情英文）',
  /resolveLogRoleLabels\(\[row\]\)/.test(logSrc));
check('日志导出：也解析', /resolveLogRoleLabels\(rows as any\[\]\)/.test(stripComments(read(EXP))));
check('权限总览最近日志：也解析', /resolveLogRoleLabels\(recentLogs as any\[\]\)/.test(stripComments(read(OVW))));

/* ============================================================
 * 二、前端：必须是 .tag.b 胶囊，不能是裸文本
 * ============================================================ */

check('日志列表：所属职位渲染成 .tag.b 胶囊（与账号管理同款）',
  /class="tag b"[\s\S]{0,160}?\{\{ n \}\}/.test(viewSrc));
check('日志列表：不再有裸的 {{ l.operatorRole }} 文本输出',
  !/\{\{\s*l\.operatorRole\s*\}\}/.test(viewSrc));
check('日志详情：空职位不再输出空胶囊', /v-if="cur\.operatorRole"/.test(viewSrc));

/* ---- 胶囊与表头必须左对齐（2026-10-20 用户第三次反馈：「不要歪着」）----
   【踩过的坑】胶囊盒子在 14px（与表头文字同起点）看着是齐的，
   但 .tag 自带 8px 内边距 → 胶囊**里的文字**落在 22px，肉眼就是表头偏左 8px。
   → 容器 .tags 统一 -8px，盒子 6px / 文字 14px = 表头文字。
   守卫：① 模板必须用 .tags 容器（不能直接平铺 .tag）；② CSS 必须有 -8px 抵消。 */
check('日志列表：胶囊包在 .tags 容器里（-8px 抵消内边距，与表头文字对齐）',
  /class="tags"/.test(viewSrc));
check('日志列表：胶囊不再用行内 margin 硬调（那样多职位时会叠在一起）',
  !/class="tag b"\s+style="margin/.test(viewSrc));
check('CSS：.tb .tags 用 margin-left:-8px 抵消胶囊内边距',
  /\.tb\s+\.tags\s*\{[^}]*margin-left:\s*-8px/.test(cssSrc));
check('CSS：.tb .tags 是 inline-flex + gap（多职位胶囊按 2px 间距排，不叠）',
  /\.tb\s+\.tags\s*\{[^}]*display:\s*inline-flex/.test(cssSrc) &&
    /\.tb\s+\.tags\s*\{[^}]*gap:\s*2px/.test(cssSrc));

/* ============================================================
 * 三、真接口：两页全量扫一遍，不允许出现英文编码
 * ============================================================ */

const token = await login('linx');
if (!token) {
  lines.push('  ⏭  跳过真接口校验（服务未启动或登录失败）');
} else {
  let all = [];
  for (const page of [1, 2]) {
    const r = await req(`${BASE}/api/perm/log/list?page=${page}&size=100`, { token });
    const list = r.json?.data?.list || [];
    all = all.concat(list);
  }
  check('日志列表能取到数据', all.length > 0, `${all.length} 条`);

  const bad = all.filter((x) => hasEnglishCode(x.operatorRole));
  check('列表：没有任何一行显示英文编码', bad.length === 0,
    bad.slice(0, 3).map((x) => `${x.operatorName}:${x.operatorRole}`).join(', ') || '0 条');

  const empty = all.filter((x) => !x.operatorRole);
  check('列表：所属职位不再为空（老日志也能按操作人补出来）', empty.length === 0,
    empty.length ? `${empty.length} 条为空，例：${empty[0].operatorName}` : '0 条');

  // 与「账号管理」同一口径：「林晓」在两个页面都应是「系统管理员」
  const linx = all.find((x) => x.operatorName === '林晓');
  check('林晓的所属职位与账号管理页一致（系统管理员）',
    linx?.operatorRole === '系统管理员', `实际 = ${JSON.stringify(linx?.operatorRole)}`);

  if (all[0]) {
    const d = await req(`${BASE}/api/perm/log/detail?id=${encodeURIComponent(all[0].id)}`, { token });
    const detailRole = d.json?.data?.operatorRole;
    check('详情与列表同一口径（同一条日志两处一致）', detailRole === all[0].operatorRole,
      `${JSON.stringify(all[0].operatorRole)} vs ${JSON.stringify(detailRole)}`);
  }

  const ov = await req(`${BASE}/api/perm/overview/get`, { token });
  const recent = ov.json?.data?.recentLogs || [];
  check('权限总览最近日志：也没有英文编码',
    recent.every((x) => !hasEnglishCode(x.operatorRole)),
    recent.slice(0, 3).map((x) => x.operatorRole).join(' / ') || '无数据');
}

console.log(lines.join('\n'));
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
if (fail) {
  lines.filter((l) => l.startsWith('  ❌')).forEach((l) => console.log('  失败：' + l.trim()));
  process.exit(1);
}
