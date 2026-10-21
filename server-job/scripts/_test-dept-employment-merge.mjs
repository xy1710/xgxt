/**
 * 回归守卫：部门结构「就业部（下设 实训管理 / 就业管理）」+ 层级口径
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户给「部门管理」截图，框住「实训教学部」「就业管理部」两行，要求：
 *     · 两者合并成一个「就业部」；
 *     · 就业部下设「实训管理」「就业管理」两个子部门；
 *     · 子部门的职位数 / 账号数沿用在用的那份数据（说明、「就业老师」职位、
 *       孙建龙 / 周杰 两个账号都不能丢）。
 *   「教学部 + 初中部 / 高中部 / 大学部」原本就是这种三层形态，这次是让就业部对齐它。
 *
 * 这个脚本钉住四类东西（任何一类回退都会报红）：
 *   ① 数据：树形结构对不对、旧部门名有没有复活、职位/账号有没有丢；
 *   ② 口径：「部门总数 / 下设子部门」按 dept_level 统计，不再硬编码学段 id；
 *   ③ 联动：父部门上的职位数（含子部门）必须能点开看到对应职位
 *      —— 职位列表按部门筛选默认含下级，否则「就业部」写着 1 个职位、弹窗却是空的；
 *   ④ 源码：改上级部门时 dept_level 要跟着重算（含下级平移），否则前端缩进错位。
 *
 * 跑法：cd server-job && node scripts/_test-dept-employment-merge.mjs
 * 依赖：5173 + 8004 已启动（走 _e2e-lib 的 login/req，不要自己拼 curl 带密码）。
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

/** 注释里也会引用旧写法和新变量名，统计前先剥掉 */
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

const SQL = P('server-job/sql/init/sms_perm.sql');
const SVC = P('server-job/src/perm/services/perm.service.ts');
const DEPT_ROUTE = P('server-job/src/perm/routes/dept.route.ts');
const ROLE_ROUTE = P('server-job/src/perm/routes/role.route.ts');
const VUE = P('web-job/src/perm/views/DeptManage.vue');

const sql = read(SQL);
const svc = stripComments(read(SVC));
const deptRoute = stripComments(read(DEPT_ROUTE));
const roleRoute = stripComments(read(ROLE_ROUTE));
const vue = stripComments(read(VUE));

/* ============================================================
 * 一、种子 SQL：新库初始化就得是三层结构
 * ============================================================ */
lines.push('\n【一】种子 SQL（sms_perm.sql）');
check(
  'D_EMP「就业部」挂在校级下、层级 2',
  /'D_EMP','[^']*','system',NULL,NULL,0,'就业部','就业','D_ALL',2,/.test(sql),
);
check(
  'D_TRAIN 已改名「实训管理」，挂 D_EMP、层级 3',
  /'D_TRAIN','[^']*','system',NULL,NULL,0,'实训管理','实训管理','D_EMP',3,/.test(sql),
);
check(
  'D_JOB 已改名「就业管理」，挂 D_EMP、层级 3',
  /'D_JOB','[^']*','system',NULL,NULL,0,'就业管理','就业管理','D_EMP',3,/.test(sql),
);
check(
  '种子数据里不再有『实训教学部』『就业管理部』',
  count(sql, "'实训教学部'") === 0 && count(sql, "'就业管理部'") === 0,
  `实训教学部 ${count(sql, "'实训教学部'")} 处 / 就业管理部 ${count(sql, "'就业管理部'")} 处`,
);

/* ============================================================
 * 二、口径：按层级统计，而不是硬编码学段 id
 * ============================================================ */
lines.push('\n【二】KPI 口径（perm.service.ts）');
check(
  '不再硬编码学段 id 名单（MERGED_STAGE_IDS 已移除）',
  count(svc, 'MERGED_STAGE_IDS') === 0,
  `命中 ${count(svc, 'MERGED_STAGE_IDS')} 次`,
);
check(
  '部门总数按 dept_level = 2 统计',
  count(svc, 'DEPT_LEVEL_DEPT = 2') === 1 && count(svc, 'dept_level: DEPT_LEVEL_DEPT') === 1,
);
check(
  '下设子部门按 dept_level = 3 统计',
  count(svc, 'DEPT_LEVEL_SUB = 3') === 1 && count(svc, 'dept_level: DEPT_LEVEL_SUB') === 1,
);

lines.push('\n【三】前端文案（DeptManage.vue）');
check('KPI 第 2 张卡标题改成「下设子部门」', count(vue, '>下设子部门<') === 1);
check('不再出现「下设学段（教学部）」', count(vue, '下设学段（教学部）') === 0);
check('KPI 提示里提到就业部的两个下设部门', count(vue, '就业部的 实训管理 / 就业管理') === 1);
check('新建部门占位文案不再引导用户建「实训教学部」', count(vue, '如：就业部') === 1);

/* ============================================================
 * 四、源码：改上级要重算层级 + 按部门筛职位默认含下级
 * ============================================================ */
lines.push('\n【四】后端联动（dept.route / role.route）');
check(
  '编辑部门时会重算 dept_level（levelDelta）',
  count(deptRoute, 'const levelDelta = nextLevel - Number(exists.dept_level);') === 1 &&
    count(deptRoute, 'dept_level: nextLevel,') === 1,
);
check(
  '下级部门随同一 delta 平移（不然父 2 子 3 会变父 2 子 4）',
  count(deptRoute, 'db.raw(\'dept_level + ?\', [levelDelta])') === 1,
);
check(
  '新建 / 编辑都拦第 4 层（MAX_DEPT_LEVEL）',
  count(deptRoute, 'const MAX_DEPT_LEVEL = 3;') === 1 &&
    count(deptRoute, '部门层级最多 ${MAX_DEPT_LEVEL} 级，不能再往下建') === 1 &&
    count(deptRoute, '部门层级最多 ${MAX_DEPT_LEVEL} 级，不能再往下挂') === 1,
);
check(
  '职位列表按部门筛选支持 withChild（默认含下级）',
  count(roleRoute, 'withChild: z.union') === 1 &&
    count(roleRoute, "query.whereIn('dept_id', collectDescendants(all, q.deptId));") === 1,
);

/* ============================================================
 * 五、真库 / 真接口
 * ============================================================ */
lines.push('\n【五】真库 + 真接口');
const db = conn(process.env.DB_NAME_PERM || 'sms_perm');
let apiOk = false;
try {
  const depts = await db('t_perm_dept').where('is_deleted', false).select('*');
  const byId = new Map(depts.map((d) => [d.id, d]));

  check(
    '库里已无活跃的「实训教学部」「就业管理部」',
    !depts.some((d) => ['实训教学部', '就业管理部'].includes(d.dept_name)),
  );

  const emp = byId.get('D_EMP');
  check(
    '就业部：父级 = 校级、层级 2',
    !!emp && emp.dept_name === '就业部' && emp.parent_id === 'D_ALL' && Number(emp.dept_level) === 2,
    emp ? `${emp.dept_name} parent=${emp.parent_id} L${emp.dept_level}` : '不存在',
  );

  const kids = depts.filter((d) => d.parent_id === 'D_EMP').map((d) => d.dept_name).sort();
  check(
    '就业部下恰好两个子部门：实训管理 / 就业管理',
    /* ⚠️ sort() 按 UTF-16 码位排：「实」(5B9E) 在「就」(5C31) 前面。
       这里按排完的结果断言，别照抄界面上的顺序 */
    kids.length === 2 && kids.join('/') === '实训管理/就业管理',
    kids.join(' / ') || '（空）',
  );

  const train = byId.get('D_TRAIN');
  const job = byId.get('D_JOB');
  check(
    '实训管理 / 就业管理 都在层级 3',
    Number(train?.dept_level) === 3 && Number(job?.dept_level) === 3,
    `D_TRAIN L${train?.dept_level} / D_JOB L${job?.dept_level}`,
  );

  // 数据不能丢：职位与账号仍挂在原来的部门 id 上（就地改名，不是删旧建新）
  const role = await db('t_perm_role').where({ role_name: '就业老师', is_deleted: false }).first();
  check('「就业老师」职位仍在，且挂 就业管理', !!role && role.dept_id === 'D_JOB', role?.dept_id);
  const u1 = await db('t_perm_user').where({ user_name: '孙建龙', is_deleted: false }).first();
  const u2 = await db('t_perm_user').where({ user_name: '周杰', is_deleted: false }).first();
  check('孙建龙（原实训教学部的账号）挂 实训管理', u1?.dept_id === 'D_TRAIN', u1?.dept_id);
  check('周杰（原就业管理部的账号）挂 就业管理', u2?.dept_id === 'D_JOB', u2?.dept_id);

  /* ---------- 接口 ---------- */
  const token = await login('linx');
  if (!token) {
    lines.push('  ⚠️ 未取到登录态（5173 / 8004 没起？）—— 接口部分跳过');
  } else {
    apiOk = true;

    const ov = await req(`${BASE}/api/perm/dept/overview`, { token });
    check(
      '部门 KPI：一级部门 6 个 / 下设子部门 5 个',
      ov.json?.data?.deptTotal === 6 && ov.json?.data?.stageTotal === 5,
      `deptTotal=${ov.json?.data?.deptTotal} stageTotal=${ov.json?.data?.stageTotal}`,
    );

    const tree = await req(`${BASE}/api/perm/dept/tree`, { token });
    const flat = [];
    const walk = (ns) => ns.forEach((n) => (flat.push(n), walk(n.children || [])));
    walk(tree.json?.data || []);
    const empNode = flat.find((n) => n.id === 'D_EMP');
    check(
      '部门树：就业部显示「含 2 个下级」',
      !!empNode && (empNode.children || []).length === 2,
      `children=${(empNode?.children || []).length}`,
    );
    check(
      /* ★ 2026-10-20 追加需求：项目经理 归入就业部条线 → 职位数 1 → 2 */
      '部门树：就业部职位数 2 / 账号数 2（含下级聚合）',
      empNode?.roleCount === 2 && empNode?.userCount === 2,
      `roleCount=${empNode?.roleCount} userCount=${empNode?.userCount}`,
    );
    check(
      '部门树：实训管理 职位 1 账号 1 / 就业管理 职位 1 账号 1',
      flat.find((n) => n.id === 'D_TRAIN')?.roleCount === 1 &&
        flat.find((n) => n.id === 'D_TRAIN')?.userCount === 1 &&
        flat.find((n) => n.id === 'D_JOB')?.roleCount === 1 &&
        flat.find((n) => n.id === 'D_JOB')?.userCount === 1,
    );

    const rolesOfEmp = await req(`${BASE}/api/perm/role/list?deptId=D_EMP&page=1&size=100`, { token });
    const empRoleNames = (rolesOfEmp.json?.data?.list || []).map((r) => r.roleName);
    /* ★ 2026-10-20 追加需求：项目经理 也归就业部（原断言只认 就业老师 一个） */
    check(
      '「查看职位」能点出就业部下的职位（= 就业老师 + 项目经理）',
      empRoleNames.length === 2 &&
        empRoleNames.includes('就业老师') &&
        empRoleNames.includes('项目经理'),
      empRoleNames.join('、') || '（空）',
    );

    const rolesOfTeach = await req(`${BASE}/api/perm/role/list?deptId=D_TEACH&page=1&size=100`, { token });
    check(
      '教学部的职位数没有被「含下级」改坏（仍是 4 个）',
      (rolesOfTeach.json?.data?.list || []).length === 4,
      String((rolesOfTeach.json?.data?.list || []).length),
    );

    const usersOfEmp = await req(`${BASE}/api/perm/user/list?deptId=D_EMP&page=1&size=100`, { token });
    check(
      '「查看账号」能点出就业部下的 2 个账号',
      (usersOfEmp.json?.data?.list || []).length === 2,
      String((usersOfEmp.json?.data?.list || []).length),
    );

    /* ---------- 层级重算：临时部门探针（跑完物理删除，不留脏数据） ---------- */
    const probeName = `层级探针${Date.now() % 100000}`;
    const addP = await req(`${BASE}/api/perm/dept/add`, {
      method: 'POST',
      token,
      body: { deptName: probeName, parentId: 'D_EMP' },
    });
    const probeId = addP.json?.data?.id || '';
    let probe = probeId ? await db('t_perm_dept').where({ id: probeId }).first() : null;
    check('探针：挂到就业部下建出来的是层级 3', Number(probe?.dept_level) === 3, `L${probe?.dept_level}`);

    const badMove = await req(`${BASE}/api/perm/dept/update`, {
      method: 'PUT',
      token,
      body: { id: probeId, deptName: probeName, parentId: 'D_TRAIN' },
    });
    check(
      '探针：挂到层级 3 的部门下被拒（不会建出第 4 层）',
      badMove.json?.code === 40000,
      `code=${badMove.json?.code}`,
    );

    const upMove = await req(`${BASE}/api/perm/dept/update`, {
      method: 'PUT',
      token,
      body: { id: probeId, deptName: probeName, parentId: 'D_ALL' },
    });
    probe = probeId ? await db('t_perm_dept').where({ id: probeId }).first() : null;
    check(
      '探针：改挂到校级下 → 层级自动重算成 2',
      upMove.json?.code === 200 && Number(probe?.dept_level) === 2,
      `code=${upMove.json?.code} L${probe?.dept_level}`,
    );

    await req(`${BASE}/api/perm/dept/delete/${probeId}`, { method: 'DELETE', token });
    if (probeId) await db('t_perm_dept').where({ id: probeId }).del();
    const leftovers = await db('t_perm_dept').where('dept_name', 'like', '层级探针%');
    check('探针部门已清掉（物理删除，不留脏数据）', leftovers.length === 0, `${leftovers.length} 行`);
  }
} finally {
  await db.destroy();
}

/* ============================================================
 * 输出
 * ============================================================ */
console.log('\n===== 「部门管理 · 就业部合并」回归 =====');
for (const l of lines) console.log(l);
if (!apiOk) console.log('\n⚠️ 接口相关断言未执行（服务未启动）');
console.log(`\n===== 结果：${pass}/${pass + fail} 通过 =====`);
process.exit(fail === 0 ? 0 : 1);
