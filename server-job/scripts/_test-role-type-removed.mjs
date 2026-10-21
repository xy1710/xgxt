/**
 * 回归守卫：全界面去掉「职位类型」
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户给了两张截图：① 职位列表里框住「类型」这一列；② 新建职位弹窗里框住「职位类型」下拉。
 *   要求删除。做法与 2026-10-19 的「职位编码」完全一致：
 *
 *     **界面全部删除 / 字段与接口保留 / 数据一个字节不动**
 *
 *   为什么不能顺手把 t_perm_role.role_type 也删了：
 *     · 存量 14 个职位里 5 个是「管理职位」、其余是「业务职位」，删字段等于把分类信息丢掉；
 *     · 编辑职位时前端会把 roleType 原值带回再提交，一旦模型里去掉这个字段，
 *       后端 `body.roleType || exists.role_type` 之外的新增分支会按默认值写，
 *       存量分类会被悄悄重置成「业务职位」。
 *
 * 清掉的面（本脚本逐处钉住）：
 *   职位列表列 / 列表筛选「全部类型」/ 详情弹窗 / 新建编辑表单 / 保存确认框
 *   / 批量导入模板与预览与失败清单 / 部门下职位弹窗 / 权限分配「从其他职位复制」副标题 / 导出表
 *
 * 跑法：cd server-job && node scripts/_test-role-type-removed.mjs
 * （第三部分需要 5173 + 8004 已启动；未启动会自动跳过）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { login, req, conn, BASE } from './_e2e-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const P = (rel) => join(REPO, rel);
const read = (p) => readFileSync(p, 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

/** 注释里会引用旧写法做说明，统计前先剥掉 */
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

const ROLEM = P('web-job/src/perm/views/RoleManage.vue');
const DEPTM = P('web-job/src/perm/views/DeptManage.vue');
const ASGNM = P('web-job/src/perm/views/PermAssign.vue');
const EXPORT = P('server-job/src/perm/routes/export.route.ts');
const ROLE_ROUTE = P('server-job/src/perm/routes/role.route.ts');

const rolem = stripComments(read(ROLEM));
const deptm = stripComments(read(DEPTM));
const asgnm = stripComments(read(ASGNM));
const exp = stripComments(read(EXPORT));
const roleRoute = stripComments(read(ROLE_ROUTE));

/* ============================================================
 * 一、职位管理页：列 / 筛选 / 详情 / 表单 / 确认框 / 导入
 * ============================================================ */
lines.push('\n【一】职位管理（RoleManage.vue）');

check(
  '列表表头不再有「类型」列（7 列：职位名称/所属部门/关联人数/权限数/状态/创建时间/操作）',
  count(rolem, '>类型</th>') === 0 && count(rolem, '{{ r.roleType }}') === 0,
  `th=${count(rolem, '>类型</th>')} 单元格=${count(rolem, '{{ r.roleType }}')}`,
);
check('空状态 colspan 跟着减一（8 → 7）', count(rolem, '<td colspan="7">') === 1);
check(
  '类型标签配色函数 typeTag() 已无落点（连同定义一起删除）',
  count(rolem, 'typeTag(') === 0,
  `命中 ${count(rolem, 'typeTag(')} 次`,
);
check(
  '筛选区不再有「全部类型」下拉，query 里也不再保留 roleType',
  count(rolem, '全部类型') === 0 && count(rolem, 'query.roleType') === 0 && count(rolem, '  roleType: \'\',') === 0,
);
check(
  '详情弹窗不再有「职位类型」格子',
  count(rolem, '>职位类型</label>') === 0 && count(rolem, 'detail?.roleType') === 0,
);
check(
  '新建/编辑表单不再有「职位类型」下拉',
  count(rolem, '>职位类型 <span class="req">*</span></label>') === 0 &&
    count(rolem, 'v-model="form.roleType"') === 0,
);
check(
  '保存确认框改成「所属部门」（不再拼「类型 · 部门」）',
  count(rolem, "'类型 / 部门'") === 0 && count(rolem, "{ k: '所属部门', v: esc(deptNameOf(form.deptId)) }") === 1,
);

/* 反向断言：编辑时要把原值带回去，别把存量分类洗成默认值 */
check(
  '表单模型仍保留 roleType，编辑时从详情带回原值',
  count(rolem, 'roleType: d.roleType,') === 1,
  `带回=${count(rolem, 'roleType: d.roleType,')}`,
);
check(
  '保存时仍提交 roleType（不传就会被后端改成默认「业务职位」）',
  count(rolem, 'roleType: form.roleType as RoleType,') === 1,
  `提交=${count(rolem, 'roleType: form.roleType as RoleType,')}`,
);

/* 批量导入：模板 / 解析 / 预览 / 失败清单 / 请求体 */
check(
  '导入模板表头去掉类型（职位名称,所属部门,职位说明）',
  count(rolem, "const IMPORT_HEADER = '职位名称,所属部门,职位说明';") === 1 &&
    count(rolem, "'业务职位,实训管理'") === 0 &&
    count(rolem, '实训助教,实训管理,导入创建') === 1,
);
/* ⚠️ 不能直接数 '  roleType: string;' —— RoleForm 里也有一行同名（那是刻意保留的）。
   只截 ImportRow 这段大括号内的内容来判。 */
const importRowBody = (rolem.match(/interface ImportRow \{([\s\S]*?)\}/) || [])[1] || '';
check(
  '导入解析按三列走，ImportRow 不再有 roleType',
  count(rolem, 'const [roleName, deptName, remark] = line') === 1 &&
    count(rolem, 'roleType: roleType || ') === 0 &&
    !/roleType/.test(importRowBody),
  `ImportRow 内 roleType 命中 ${(importRowBody.match(/roleType/g) || []).length} 次`,
);
check(
  '导入预览表 3 列（职位名称/部门/校验），失败清单也不带类型',
  count(rolem, '<tr><th>职位名称</th><th>部门</th><th>校验</th></tr>') === 1 &&
    count(rolem, '${r.roleName},${r.deptName},${r.remark},${r.reason}') === 1,
);
check(
  '导入请求体不再带 roleType（后端按默认值兜底）',
  count(rolem, '        roleType: r.roleType,') === 0,
);

/* ============================================================
 * 二、其它页面与导出
 * ============================================================ */
lines.push('\n【二】其它落点');
check(
  '部门下职位弹窗（DeptManage）去掉「类型」列',
  count(deptm, '<th>类型</th>') === 0 && count(deptm, '{{ r.roleType }}') === 0,
);
check(
  '权限分配「从其他职位复制」副标题只剩「N 项权限」',
  count(asgnm, 'r.roleType') === 0 && count(asgnm, '{{ r.permCount }} 项权限') === 1,
);
check(
  '导出表列头去掉「职位类型」，行映射也不再有该字段',
  count(exp, "'职位类型'") === 0 && count(exp, '职位类型: r.role_type,') === 0,
  `列头=${count(exp, "'职位类型'")} 映射=${count(exp, '职位类型: r.role_type,')}`,
);

/* ============================================================
 * 三、后端：字段保留、默认值兜底（不删列）
 * ============================================================ */
lines.push('\n【三】后端保留口径');
check(
  'roleType 仍是可选入参，不传按「业务职位」落库',
  count(roleRoute, 'roleType: z.string().optional(),') >= 2 &&
    count(roleRoute, "role_type: body.roleType || '业务职位',") === 1,
  `optional=${count(roleRoute, 'roleType: z.string().optional(),')}`,
);
check(
  '编辑时「不传即保持原值」',
  count(roleRoute, 'role_type: body.roleType || exists.role_type,') === 1,
);

/* ============================================================
 * 四、真库 / 真接口
 * ============================================================ */
lines.push('\n【四】真库 + 真接口');
const db = conn(process.env.DB_NAME_PERM || 'sms_perm');
let apiOk = false;
try {
  const dist = await db('t_perm_role')
    .where('is_deleted', false)
    .select('role_type')
    .count({ n: '*' })
    .groupBy('role_type');
  const distStr = dist.map((d) => `${d.role_type}=${d.n}`).join(' / ');
  check('存量职位类型数据原样保留（至少两类共存）', dist.length >= 2, distStr);
  check(
    '没有因为界面删除而把分类洗成单一值',
    dist.every((d) => d.role_type !== null && d.role_type !== ''),
    distStr,
  );

  const token = await login('linx');
  if (!token) {
    lines.push('  ⚠️ 未取到登录态（5173 / 8004 没起？）—— 接口部分跳过');
  } else {
    apiOk = true;

    const list = await req(`${BASE}/api/perm/role/list?page=1&size=5`, { token });
    const first = (list.json?.data?.list || [])[0];
    check('接口响应里仍返回 roleType（字段保留）', first && 'roleType' in first, first?.roleType);

    /* 探针：新建职位不传 roleType → 应按默认「业务职位」落库，用完物理删除 */
    const probeName = `类型探针${Date.now() % 100000}`;
    const add = await req(`${BASE}/api/perm/role/add`, {
      method: 'POST',
      token,
      body: { roleName: probeName, deptId: 'D_ADM', roleStatus: '启用' },
    });
    const probeId = add.json?.data?.id || '';
    const row = probeId ? await db('t_perm_role').where({ id: probeId }).first() : null;
    check(
      '不传类型的职位按默认「业务职位」建出来',
      row?.role_type === '业务职位',
      `code=${add.json?.code} role_type=${row?.role_type}`,
    );

    if (probeId) {
      await req(`${BASE}/api/perm/role/delete/${probeId}`, { method: 'DELETE', token });
      await db('t_perm_role_perm').where('role_id', probeId).del();
      await db('t_perm_user_role').where('role_id', probeId).del();
      await db('t_perm_role').where({ id: probeId }).del();
    }
    const left = await db('t_perm_role').where('role_name', 'like', '类型探针%');
    check('探针职位已物理清除（不留脏数据）', left.length === 0, `${left.length} 行`);
  }
} finally {
  await db.destroy();
}

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「全界面去掉职位类型」回归 =====');
for (const l of lines) console.log(l);
if (!apiOk) console.log('\n⚠️ 接口相关断言未执行（服务未启动）');
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
