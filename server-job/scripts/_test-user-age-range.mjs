/**
 * 自检：「账号管理 · 年龄范围 20-65」
 * ============================================================
 *
 * 【背景】
 *   用户要求把新建/编辑账号的年龄范围从 16-70 收紧为 **20-65**。
 *
 * 【为什么不能只改一个地方】
 *   年龄这个字段一共在 4 个位置各写了一遍口径，漏一处就会出现
 *   「前端拦住了、后端放进来」或者反过来的鬼故事：
 *     ① 前端输入框  min/max/placeholder   —— 挡住键盘/上下箭头
 *     ② 前端 validateForm()               —— 提交前的中文提示
 *     ③ 后端 zod addSchema.age            —— 真正的最后一道闸（前端可绕过）
 *     ④ swagger 文档                      —— 联调时别人照着写的依据
 *   本脚本把四处一起钉住：任何一处被改回旧口径，这里立刻报红。
 *
 * 【★ 怎么验「真的生效了」而不只是「文本写对了」】
 *   第二部分打**真实接口**（经 vite 代理 → 8004），用 4 个年龄值探边界：
 *       19 → 必须拒（低于下界）        66 → 必须拒（高于上界）
 *       20 → 必须放行                   65 → 必须放行
 *   「放行」怎么判？——故意把 所属部门 / 职位 填成不存在的值：
 *     校验通过 → 进业务层 → 返回「所属部门不存在」（40412）；
 *     校验没过 → 直接返回「参数「age」…」（40000）。
 *   两种返回码可区分，而且**这条请求永远不会写库**（部门不存在，
 *   插入动作在它之后），所以反复跑不会污染数据。
 *
 * 【第三部分】扫存量数据：收紧区间后不能把老账号卡死
 *   编辑账号走的是同一套 zod 校验，如果库里存在 < 20 或 > 65 的在用账号，
 *   那些人之后就再也改不了资料了。这里断言为 0。
 *
 * 跑法：cd server-job && node scripts/_test-user-age-range.mjs
 *      （需要本地 MySQL；第二、三部分需要 5173 / 8004 已启动）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conn, makeChecker, login, req, BASE } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

const FE = 'web-job/src/perm/views/UserManage.vue';
const BE = 'server-job/src/perm/routes/user.route.ts';
const SW_MODEL = 'server-job/src/perm/swagger/index.ts';
const SW_PATH = 'server-job/src/perm/swagger/paths/04-user.ts';

const { check, summary } = makeChecker();

/* ============================================================
 * 一、四处口径必须一致（纯静态，起不起服务都能跑）
 * ========================================================== */
console.log('===== 一、四处口径一致性 =====');

const fe = read(FE);
const be = read(BE);
const swModel = read(SW_MODEL);
const swPath = read(SW_PATH);

check(
  '① 前端输入框 min=20 / max=65 / placeholder=20-65',
  count(fe, 'min="20" max="65" placeholder="20-65"') === 1,
  `命中 ${count(fe, 'min="20" max="65" placeholder="20-65"')} 次`,
);

check(
  '② 前端 validateForm 区间为 20-65',
  count(fe, 'v.age < 20 || v.age > 65') === 1,
  `命中 ${count(fe, 'v.age < 20 || v.age > 65')} 次`,
);

check(
  '② 前端提示文案为「年龄需在 20-65 之间」',
  count(fe, '年龄需在 20-65 之间') === 1,
  `命中 ${count(fe, '年龄需在 20-65 之间')} 次`,
);

check(
  '① ② 前端已无 16 / 70 旧口径残留',
  count(fe, '16-70') === 0 &&
    count(fe, 'min="16"') === 0 &&
    count(fe, 'v.age < 16') === 0 &&
    count(fe, 'v.age > 70') === 0,
  `16-70=${count(fe, '16-70')} min="16"=${count(fe, 'min="16"')} ` +
    `age<16=${count(fe, 'v.age < 16')} age>70=${count(fe, 'v.age > 70')}`,
);

check(
  '③ 后端 zod min(20) / max(65)',
  count(be, ".min(20, '年龄不得小于 20').max(65, '年龄不得大于 65')") === 1,
  `命中 ${count(be, ".min(20, '年龄不得小于 20').max(65, '年龄不得大于 65')")} 次`,
);

check(
  '③ 后端已无「不得小于 16 / 不得大于 70」旧口径',
  count(be, '年龄不得小于 16') === 0 && count(be, '年龄不得大于 70') === 0,
  `小于16=${count(be, '年龄不得小于 16')} 大于70=${count(be, '年龄不得大于 70')}`,
);

check(
  '④ swagger 模型 description = 20-65',
  count(swModel, "description: '20-65'") === 1,
  `命中 ${count(swModel, "description: '20-65'")} 次`,
);

check(
  '④ swagger 接口说明「年龄 20-65」',
  count(swPath, '年龄 20-65') === 1,
  `命中 ${count(swPath, '年龄 20-65')} 次`,
);

/* ============================================================
 * 二、真实接口边界（改的是真闸门，不是文本）
 * ========================================================== */
console.log('\n===== 二、真实接口边界 =====');

const token = await login('linx').catch(() => '');
let skipped = 0;

if (!token) {
  console.log('  ⚠️  跳过：拿不到门户 token（5173 / 8004 没起？）—— 静态部分已足够定位口径问题');
  skipped += 4;
} else {
  const PROBE_ACCOUNT = 'zzageprobe'; // 故意用固定名，跑完还会反查它是否误建
  const probe = (age) =>
    req(`${BASE}/api/perm/user/add`, {
      method: 'POST',
      token,
      body: {
        userName: '测试甲',
        account: PROBE_ACCOUNT,
        phone: '13900000000',
        gender: 1,
        age,
        deptId: '__NO_SUCH_DEPT__', // 不存在的部门 → 绝不写库
        roleIds: ['__NO_SUCH_ROLE__'],
        modules: ['perm'],
      },
    });

  const r19 = await probe(19);
  const r66 = await probe(66);
  const r20 = await probe(20);
  const r65 = await probe(65);

  const msg = (r) => String(r.json?.message || '');
  const code = (r) => Number(r.json?.code ?? -1);
  // 40000 = PARAM_ERROR（zod 拦下）；40412 = DEPT_NOT_FOUND（已进业务层 = 校验放行）
  const rejectedByAge = (r) => code(r) === 40000 && msg(r).includes('age');
  const passedValidation = (r) => code(r) !== 40000;

  check('19 岁被拒（低于下界 20）', rejectedByAge(r19), `${code(r19)} ${msg(r19)}`);
  check('66 岁被拒（高于上界 65）', rejectedByAge(r66), `${code(r66)} ${msg(r66)}`);
  check(
    '20 岁放行（下界本身合法）',
    passedValidation(r20),
    `${code(r20)} ${msg(r20)}`,
  );
  check(
    '65 岁放行（上界本身合法）',
    passedValidation(r65),
    `${code(r65)} ${msg(r65)}`,
  );
  check(
    '边界探测没有留下垃圾账号（两次「放行」也只停在部门校验）',
    msg(r20).includes('部门') && msg(r20) === msg(r65),
    `两次放行返回：${msg(r20)}`,
  );
}

/* ============================================================
 * 三、存量数据：收紧区间不能把老账号卡死
 * ========================================================== */
console.log('\n===== 三、存量账号回归 =====');

let db = null;
try {
  db = conn('sms_perm');
  const [rows] = await db.raw(
    'SELECT id, user_name, age FROM sms_perm.t_perm_user WHERE is_deleted = 0 ORDER BY age',
  );

  const bad = rows.filter((r) => r.age == null || r.age < 20 || r.age > 65);
  check(
    `在用账号年龄全部落在 20-65（共 ${rows.length} 个，实测 ${rows[0]?.age}~${rows[rows.length - 1]?.age}）`,
    bad.length === 0,
    bad.length
      ? `越界 ${bad.length} 个：${bad.map((r) => `${r.user_name}(${r.age})`).join('、')} —— 这些账号编辑时会报「年龄…」`
      : '收紧区间不会导致任何老账号编辑失败',
  );

  if (token) {
    const [probeRows] = await db.raw(
      "SELECT COUNT(*) AS n FROM sms_perm.t_perm_user WHERE account = 'zzageprobe'",
    );
    check(
      '接口探测确认没写库（zzageprobe 不存在）',
      Number(probeRows[0].n) === 0,
      `t_perm_user 里 zzageprobe 行数 = ${probeRows[0].n}`,
    );
  }
} catch (e) {
  console.log(`  ⚠️  跳过：读不到 sms_perm（${e.message}）`);
  skipped += 1;
} finally {
  if (db) await db.destroy();
}

if (skipped) console.log(`\n（本次有 ${skipped} 项因环境未就绪被跳过）`);

const ok = summary();
process.exit(ok ? 0 : 1);
