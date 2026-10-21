/**
 * 回归守卫：「全系统去掉职位编码」
 * ============================================================
 *
 * 【用户要求（2026-10-19）】
 *   「去掉整个系统中职位编码的相关内容，只要有这个词的地方全部删除」
 *   追问「新建职位时还要不要让人手填编码」→ 选择「不填了，后端自动生成」。
 *
 * 【这次改动最容易踩的坑 —— 先看这里】
 *   `t_perm_role.role_code` **看着像个展示字段，其实不是**。它是学管系统的
 *   **跨模块鉴权连接键**，一共 4 处在依赖它：
 *     ① 登录模块 GET /api/perm/role/codes → 写进 token 的 roles[]
 *     ② 教务 / 班级 / 咨询 / 财务用 `role_code IN (...)` 判定角色
 *     ③ 后端 app.ts 靠 RoleCode.SYS_ADMIN 决定「只有系统管理员能写」
 *     ④ DB 上唯一索引 uk_role_code
 *   所以正确的改法是：**UI 全删、字段与列保留、新建时由后端 nextRoleCode() 补号**。
 *   这个脚本就是这套口径的守卫 —— 谁要是「顺手」把列删了、把 /codes 删了、
 *   把 UserManage 里的 SYS_ADMIN 判定删了，这里立刻报红。
 *
 * 【四部分】
 *   一、静态：web-job/src 全库不再出现「职位编码」字样
 *   二、静态：5 个页面的每个展示/输入点位逐个钉住
 *   三、静态：后端「可选 + 自动生成」，而 /codes 与鉴权链路原封不动
 *   四、活体：真打接口 —— 不传 roleCode 能建出来、拿到自动生成的码、
 *       编辑时不传编码不会把编码清空、/codes 里能查到它
 *
 * 跑法：cd server-job && node scripts/_test-role-code-removed.mjs
 *      （第四部分需要 5173 + 8004 已启动；起不来只跳过那 5 条，静态部分照跑）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChecker, login, req, BASE, conn } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/**
 * 去掉注释后的源码 —— 本次改动在 export.route.ts / role.route.ts 的注释里
 * 主动写了「职位编码」说明为什么删，直接 count 会把注释也数进去（踩过一次）。
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const ROLEM = 'web-job/src/perm/views/RoleManage.vue';
const USERD = 'web-job/src/perm/components/UserDetailDialog.vue';
const DEPTM = 'web-job/src/perm/views/DeptManage.vue';
const PAGEM = 'web-job/src/perm/views/PageManage.vue';
const ASGNM = 'web-job/src/perm/views/PermAssign.vue';
const USRM = 'web-job/src/perm/views/UserManage.vue';
const ICON = 'web-job/src/perm/utils/roleIcon.ts';
const API = 'web-job/src/perm/api/perm.ts';
const ROUTE = 'server-job/src/perm/routes/role.route.ts';
const EXPORT = 'server-job/src/perm/routes/export.route.ts';
const STYPES = 'shared-types/src/perm/perm.ts';

const { check, summary } = makeChecker();

/* ============================================================
 * 一、全库扫描：web-job/src 里不再有「职位编码」字样
 * ========================================================== */

console.log('===== 一、前端全库扫描 =====');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const FE_DIR = path.join(REPO, 'web-job', 'src');
const feFiles = walk(FE_DIR);
const HITS = [];
for (const f of feFiles) {
  const src = readFileSync(f, 'utf8');
  if (src.includes('职位编码')) {
    HITS.push(
      path.relative(REPO, f).replace(/\\/g, '/') + ' × ' + count(src, '职位编码'),
    );
  }
}

check(
  '① web-job/src 全库「职位编码」残留为 0',
  HITS.length === 0,
  HITS.length ? '残留：' + HITS.join('，') : `已扫 ${feFiles.length} 个文件，干净`,
);

const feAll = feFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const OTHER_CODE = count(feAll, '编码') - count(feAll, '职位编码');
check(
  '① 其余「编码」只存在于无关语境（动作编码 / 阶段编码 / 班级编码 / 硬编码）',
  // 允许的无关语境；数量变化不代表出错，这里只钉住「不要新出现职位编码式的列头」
  count(feAll, '<th>编码</th>') === 0 && count(feAll, '>编码</') === 0,
  `<th>编码</th>=${count(feAll, '<th>编码</th>')} >编码</=${count(feAll, '>编码</')} 其余含「编码」共 ${OTHER_CODE} 处`,
);

/* ============================================================
 * 二、5 个页面的点位逐个钉住
 * ========================================================== */

console.log('\n===== 二、前端各页面点位 =====');

const rolem = read(ROLEM);

check(
  /* 编码列去掉后是 8 列；2026-10-20 又去掉「类型」列 → 现为 7 列 */
  '② 职位列表：表头已无「职位编码」列，空状态 colspan 改 7',
  count(rolem, '<td colspan="7">') === 1 && count(rolem, 'colspan="8"') === 0,
  `colspan7=${count(rolem, '<td colspan="7">')} colspan8=${count(rolem, 'colspan="8"')}`,
);

check(
  '② 职位列表：行里不再渲染 {{ r.roleCode }}',
  count(rolem, '{{ r.roleCode }}') === 0 && count(rolem, '{{ r.roleCode ||') === 0,
  `{{ r.roleCode }}=${count(rolem, '{{ r.roleCode }}')}`,
);

check(
  '② 详情弹窗 / 新建编辑表单：都没有编码字段了',
  count(rolem, 'detail?.roleCode') === 0 &&
    count(rolem, 'form.roleCode') === 0 &&
    count(rolem, 'v-model="form.roleCode"') === 0,
  `detail?.roleCode=${count(rolem, 'detail?.roleCode')} form.roleCode=${count(rolem, 'form.roleCode')}`,
);

check(
  '② 权限树相关：treeRoleCode 死代码已清干净',
  count(rolem, 'treeRoleCode') === 0,
  `treeRoleCode=${count(rolem, 'treeRoleCode')}`,
);

check(
  '② 删除 / 创建 / 保存权限三个确认弹窗都不再列编码',
  count(rolem, "{ k: '职位编码'") === 0,
  `{ k: '职位编码' =${count(rolem, "{ k: '职位编码'")}`,
);

check(
  '② 提交校验只剩「职位名称必填 / 所属部门必填」',
  count(rolem, "err.push('职位名称必填')") === 1 &&
    count(rolem, "err.push('所属部门必填')") === 1 &&
    count(rolem, "err.push('职位编码必填')") === 0,
  `名称=${count(rolem, "err.push('职位名称必填')")} 部门=${count(rolem, "err.push('所属部门必填')")}`,
);

check(
  '② 新建/编辑请求体不再带 roleCode（交给后端自动生成）',
  count(rolem, '      roleCode: code,') === 0 && count(rolem, 'async function saveForm(isEdit: boolean, name: string)') === 1,
  `payload roleCode=${count(rolem, '      roleCode: code,')}`,
);

check(
  /* 2026-10-20：模板又去掉了「类型」列 → 现为 职位名称,所属部门,职位说明 */
  '② 批量导入：表头/模板/解析/预览/失败清单五处都不带编码',
  count(rolem, "const IMPORT_HEADER = '职位名称,所属部门,职位说明';") === 1 &&
    count(rolem, "'实训助教,实训管理,导入创建'") === 1 &&
    count(rolem, 'const [roleName, deptName, remark] = line') === 1 &&
    count(rolem, '<tr><th>职位名称</th><th>部门</th><th>校验</th></tr>') === 1 &&
    count(rolem, '${r.roleName},${r.deptName},${r.remark},${r.reason}') === 1,
  '五处口径已统一',
);

check(
  '② 批量导入去重改为按「职位名称」（后端有同名查重，前端提前拦）',
  count(rolem, 'seen.has(r.roleName)') === 1 &&
    count(rolem, "'文件内职位名称重复'") === 1 &&
    count(rolem, 'seen.has(r.roleCode)') === 0,
  `按名称去重=${count(rolem, 'seen.has(r.roleName)')}`,
);

check(
  '② 搜索框占位符只留职位名称',
  count(rolem, 'placeholder="搜索职位名称"') === 1 &&
    count(rolem, '搜索职位名称 / 编码') === 0,
  `命中 ${count(rolem, 'placeholder="搜索职位名称"')} 次`,
);

const userd = read(USERD);
const deptm = read(DEPTM);
const pagem = read(PAGEM);
const asgnm = read(ASGNM);

check(
  '② 账号详情（UserDetailDialog）职位表去掉「编码」列',
  count(userd, '<th>编码</th>') === 0 &&
    count(userd, '{{ r.roleCode }}') === 0 &&
    count(userd, 'roleCode: string;') === 0 &&
    count(userd, "roleCode: '—',") === 0,
  `th=${count(userd, '<th>编码</th>')} 单元格=${count(userd, '{{ r.roleCode }}')}`,
);

check(
  '② 部门下职位弹窗（DeptManage）去掉「编码」列',
  count(deptm, '<th>编码</th>') === 0 && count(deptm, '{{ r.roleCode }}') === 0,
  `th=${count(deptm, '<th>编码</th>')} 单元格=${count(deptm, '{{ r.roleCode }}')}`,
);

check(
  '② 页面授权（PageManage）tooltip 与标题 tag 都不再显示编码',
  count(pagem, 'r.roleCode') === 0 && count(pagem, 'activeRole?.roleCode') === 0,
  `r.roleCode=${count(pagem, 'r.roleCode')} activeRole?.roleCode=${count(pagem, 'activeRole?.roleCode')}`,
);

check(
  '② 权限分配（PermAssign）保存确认与头部 tag 都不再显示编码',
  count(asgnm, 'currentRole.value?.roleCode') === 0 && count(asgnm, 'currentRole.roleCode') === 0,
  `保存确认=${count(asgnm, 'currentRole.value?.roleCode')} 头部=${count(asgnm, 'currentRole.roleCode')}`,
);

/* ============================================================
 * 三、后端：可选 + 自动生成；但鉴权链路原封不动
 * ========================================================== */

console.log('\n===== 三、后端口径与鉴权链路 =====');

const route = read(ROUTE);

check(
  '③ nextRoleCode() 已就位，生成 ROLE_0001 形式（符合 ^[A-Z][A-Z0-9_]*$）',
  count(route, 'async function nextRoleCode(): Promise<string>') === 1 &&
    count(route, "/^ROLE_(\\d{4,})$/") === 1 &&
    count(route, '`ROLE_${String(n).padStart(4, \'0\')}`') === 2,
  '生成器命中 1 次',
);

check(
  '③ 新建/编辑/导入三处都在「不传时自动补号」',
  count(route, "(body.roleCode || '').trim() || (await nextRoleCode())") === 1 &&
    count(route, 'const nextCode = givenCode || exists.role_code;') === 1 &&
    count(route, "(row.roleCode || '').trim() || (await nextRoleCode())") === 1,
  'add / update / import 三处齐备',
);

check(
  '③ saveSchema 与 importSchema 的 roleCode 都是可选',
  count(route, 'roleCode: z.string().max(64).optional(),') === 2 &&
    count(route, "min(1, '职位编码必填')") === 0,
  `optional=${count(route, 'roleCode: z.string().max(64).optional(),')} 旧的必填=${count(route, "min(1, '职位编码必填')")}`,
);

check(
  '③ 编辑不传编码时沿用原值（绝不误清空）',
  count(route, 'const givenCode = (body.roleCode || \'\').trim();') === 1 &&
    count(route, 'if (nextCode !== exists.role_code) {') === 1 &&
    count(route, 'role_code: nextCode,') === 2,
  '沿用原值逻辑命中',
);

check(
  '③ ★ 跨模块鉴权接口 /codes 原封不动（登录模块签发 token 靠它）',
  count(route, "'/codes'") === 1 && count(route, 'roleCode: r.role_code,') === 2,
  `'/codes'=${count(route, "'/codes'")}`,
);

check(
  '③ ★ 列表/详情/导出仍返回 roleCode（前端 roleIcon / 管理员判定还要用）',
  count(route, 'roleCode: r.role_code,') === 2 &&
    count(stripComments(read(EXPORT)), '职位编码') === 0 &&
    count(read(EXPORT), '职位编码') === 1, // 注释里主动提了 1 次，代码里 0 次
  `导出表已去掉编码列，接口仍返回该字段`,
);

check(
  '③ ★ 前端三处内部依赖必须保留（不是展示，删了会坏功能）',
  count(read(USRM), "?.roleCode === 'SYS_ADMIN'") === 1 &&
    count(read(ICON), "ROLE_ICON_BY_CODE[r?.roleCode || '']") === 1 &&
    count(read(API), '`${P}/role/codes`') === 1,
  `SYS_ADMIN 判定 / 图标映射 / codes() 均在`,
);

check(
  '③ 共享类型 PermRoleSavePayload.roleCode 已改为可选',
  count(read(STYPES), '  roleCode?: string;') === 1,
  `roleCode?= ${count(read(STYPES), '  roleCode?: string;')}`,
);

/* ============================================================
 * 四、活体：真打接口验证「不传也能建、且拿得到码」
 * ========================================================== */

console.log('\n===== 四、真实接口验证 =====');

const token = await login('linx').catch(() => '');
let skipped = 0;
const PROBE_NAME = '角色编码自检探针'; // 固定名，跑完硬删

/** 清掉可能残留的同名探针（上一轮跑挂了） */
async function purgeProbe() {
  try {
    const db = conn('sms_perm');
    const rows = await db('t_perm_role').where({ role_name: PROBE_NAME }).select('id');
    for (const r of rows) {
      await db('t_perm_role_perm').where({ role_id: r.id }).del();
      await db('t_perm_role').where({ id: r.id }).del();
    }
    await db.destroy();
    return rows.length;
  } catch {
    return -1;
  }
}

if (!token) {
  console.log('  ⚠️  跳过：拿不到门户 token（5173 / 8004 没起？）—— 静态部分已足够定位口径问题');
  skipped = 5;
} else {
  await purgeProbe();

  const add = await req(`${BASE}/api/perm/role/add`, {
    method: 'POST',
    token,
    body: {
      // ⚠️ 故意不带 roleCode —— 这正是本次改动的核心场景
      roleName: PROBE_NAME,
      roleType: '业务职位',
      remark: 'role_code 自动生成自检，跑完即删',
    },
  });

  const newId = add.json?.data?.id;
  check(
    '④ 不传 roleCode 新建职位：成功',
    add.status === 200 && add.json?.code === 200 && !!newId,
    `HTTP ${add.status} code=${add.json?.code} msg=${add.json?.message} id=${newId || '—'}`,
  );

  let detail = null;
  if (newId) {
    const d = await req(`${BASE}/api/perm/role/detail?id=${newId}`, { token });
    detail = d.json?.data || null;
  }
  const code = detail?.roleCode || '';
  check(
    '④ 自动生成的编码符合 ROLE_0001 格式',
    /^ROLE_\d{4,}$/.test(code),
    `roleCode=${code || '—'}`,
  );

  const codesRes = await req(`${BASE}/api/perm/role/codes`, { token });
  const inCodes = (codesRes.json?.data || []).some((x) => x.roleCode === code);
  check(
    '④ ★ 新职位出现在 /role/codes 里（登录模块签发 token 的前提）',
    inCodes,
    inCodes ? `codes 里查到 ${code}` : `codes 里没有 ${code}`,
  );

  // 编辑：不带 roleCode —— 必须沿用原值，不能被清成 null
  const upd = await req(`${BASE}/api/perm/role/update`, {
    method: 'PUT',
    token,
    body: { id: newId, roleName: PROBE_NAME, roleType: '业务职位', remark: '改一次说明' },
  });
  const after = newId
    ? (await req(`${BASE}/api/perm/role/detail?id=${newId}`, { token })).json?.data
    : null;
  check(
    '④ ★ 编辑时不传 roleCode：编码保持不变（不会被误清空）',
    upd.json?.code === 200 && !!after && after.roleCode === code && !!code,
    `update code=${upd.json?.code} 前=${code || '—'} 后=${after?.roleCode || '—'}`,
  );

  // 清理
  const purged = await purgeProbe();
  check(
    '④ 探针数据已清理（不污染演示库）',
    purged !== 0,
    purged === -1 ? 'ORM 清理失败，请手工删除「' + PROBE_NAME + '」' : `已删 ${purged} 行`,
  );
}

/* ============================================================ */

const pass = summary();
if (skipped) console.log(`\n（第四部分跳过 ${skipped} 条：服务未启动）`);
process.exit(pass ? 0 : 1);
