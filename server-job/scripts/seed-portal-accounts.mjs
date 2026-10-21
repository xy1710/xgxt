/**
 * 业务角色门户账号种子（统一门户 → 就业 / 教务 / 班级）
 *
 * ============================================================
 * 【为什么需要它】2026-10-05 联调发现的「登录死锁」
 * ============================================================
 *   门户登录（server-job/src/portal/services/account.service.ts）要求
 *   `t_sys_account.modules` 里至少有一个**已注册**的模块，否则直接拒绝：
 *       「该账号未分配任何模块权限，请联系系统管理员」
 *
 *   而原来 sms_portal.t_sys_account 里只有
 *       admin / 咨询师张三李四 / 财务 / 权限管理员 —— 一个 就业/教务/班级
 *   的账号都没有。
 *   结果是：sms_perm.t_perm_user 里明明有 20 个业务用户（校长、学管主任、
 *   班主任、教务老师、就业老师…），但**没有任何一个人能登录门户**。
 *
 * 【方案 A（用户 2026-10-05 拍板）】
 *   把 就业(job) / 教务(edu) / 班级(class) 也纳入门户模块注册表
 *   （shared-types/src/portal/portal.ts 的 MODULES），
 *   再给这些业务角色建门户账号 —— 这样他们登录后能直接进对应模块。
 *
 * 【与权限模块的关系】
 *   门户账号只负责「能不能登录 + 能进哪几个模块」；
 *   进去之后能看哪些**页面**，由 sms_perm 的角色解析（见
 *   server-job/src/middleware/auth.ts 的 resolveBusinessRoles）。
 *   所以这里的 account 必须与 sms_perm.t_perm_user.account 一一对应，
 *   否则登录得进、进去是空菜单。
 *
 * 【用法】
 *   node scripts/seed-portal-accounts.mjs          # 造/更新账号（幂等）
 *   node scripts/seed-portal-accounts.mjs clean    # 只删本脚本造的账号
 *
 * 幂等：按 account 唯一键 upsert，重复执行不会产生重复账号。
 * ⚠️ 密码演示环境明文 123456（与其它演示账号一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 读 server-job/.env（不引第三方依赖） ---------- */
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv();
const CONN = {
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER || 'root',
  password: env.DB_PASSWORD || '',
  multipleStatements: false,
};

const PORTAL_DB = env.DB_NAME_PORTAL || 'sms_portal';
const PERM_DB = env.DB_NAME_PERM || 'sms_perm';
const PASSWORD = '123456';

/**
 * 业务角色门户账号
 *
 * modules 取值必须是 shared-types/src/portal/portal.ts 里 ModuleKey 的成员，
 * 且已在 MODULES 注册表中（2026-10-05 方案 A 把 job/edu/class 加了进去）。
 *
 *   就业老师 JOB_STAFF      → job
 *   教务老师 ACAD_STAFF     → edu + class-jh（初高只给宿舍/审批）
 *   班主任(大学部) TEACH_HEAD → class      （只看大学部，看不到初高）
 *   班主任(初高)   TEACH_HEAD → class-jh   （只看初高，看不到大学部）
 *   学管主任 TEACH_DEAN     → job + class + class-jh（催费/宿舍/两套班级审批）
 *   校长     RM_PRINCIPAL   → ★ 全部 7 个模块（2026-10-06 用户拍板「校长权限为全模块展示」）
 *   教员/助教              → class（大学部建班 5 岗位之二，可被选为班级师资）
 *   项目经理 RM_PROJECT    → job  （实训阶段接手带训，被选为升实训后的项目经理）
 *
 * ★ 2026-10-06 新增 教员 / 助教 / 项目经理 3 个账号：
 *   用户口径「所有涉及选择角色时，选项要来自系统内账户所对应的角色」——
 *   而系统里原来【没有】教员 / 助教 / 项目经理 这三个角色的账号，
 *   导致「班级管理·建班/升实训」弹窗的这 3 个下拉永远是空的。
 *   补账号后下拉即有真人可选，走的是「账户 → 角色」的真实口径，
 *   不再依赖已停跑的 8001 登录模块或班级表兜底。
 *
 * ★ 2026-10-05 新增 class-jh（教学管理·初高）：
 *   它与 class（大学部）用的是【同一批角色码】（都是 TEACH_HEAD 等），
 *   靠什么区分「大学部班主任」和「初高班主任」？—— 靠**模块授权**：
 *   两个班主任的 modules 不同（一个 ['class']、一个 ['class-jh']），
 *   前端菜单/守卫 + 后端模块门槛据此把两套模块隔开。
 *   所以下面 zhanght（大学部）与 sunmin（初高）**必须**分别只挂各自的模块。
 */
const ACCOUNTS = [
  {
    account: 'qiansy',
    name: '钱守义',
    kind: 'module_owner',
    title: '校长',
    dept: '校长办公室',
    phone: '13800000077',
    modules: ['consult', 'finance', 'perm', 'job', 'edu', 'class', 'class-jh'],
    note: '校长 RM_PRINCIPAL：★ 全模块（2026-10-06 用户拍板「校长权限为全模块展示」）—— 与系统管理员同样看得到 7 个模块',
  },
  {
    account: 'congym',
    name: '丛玉梅',
    kind: 'module_owner',
    title: '学管主任',
    dept: '学管部',
    phone: '13800000088',
    modules: ['job', 'class', 'class-jh'],
    note: '学管主任 TEACH_DEAN + 教质经理 TEACH_QTY：催费 / 宿舍 / 两套班级审批 / 初高设置',
  },
  {
    account: 'zhanght',
    name: '张海涛',
    kind: 'module_owner',
    title: '班主任',
    dept: '大学部',
    phone: '13800000099',
    modules: ['class'],
    note: '班主任 TEACH_HEAD：只挂【大学部】(class)，看不到初高（class-jh）',
  },
  {
    account: 'sunmin',
    name: '孙敏',
    kind: 'module_owner',
    title: '班主任',
    dept: '初高中部',
    phone: '13800000132',
    modules: ['class-jh'],
    note: '初高班主任 TEACH_HEAD：只挂【教学管理（初高）】(class-jh)，看不到大学部',
  },
  {
    account: 'zhengym',
    name: '郑一鸣',
    kind: 'module_owner',
    title: '教务老师',
    dept: '教务部',
    phone: '13800000110',
    modules: ['edu', 'class-jh'],
    note: '教务老师 ACAD_STAFF：教务 3 页 + 初高模块的宿舍/审批（调宿审批在教务）',
  },
  {
    account: 'zhouj',
    name: '周杰',
    kind: 'module_owner',
    title: '就业老师',
    dept: '就业部',
    phone: '13800000121',
    modules: ['job'],
    note: '就业老师 JOB_STAFF：就业阶段页面',
  },
  /* ============================================================
   * ★ 2026-10-06 新增：大学部建班 5 岗位里缺的 3 个角色的账号
   *
   * 【为什么补】用户口径「所有选角色的地方，选项来自系统内账户对应的角色」。
   *   建班/升实训弹窗有 5 个岗位下拉：
   *     班主任(TEACH_HEAD) ✓已有 / 教员(TEACH_TUTOR) ✗ / 助教(TEACH_ASSIST) ✗
   *     项目经理(RM_PROJECT) ✗ / 就业指导老师(JOB_STAFF) ✓已有
   *   缺的 3 个角色没有账号 → 下拉空 → 只能靠班级表兜底（口径不对）。
   *   补上后，下拉直接来自 sms_perm 的「账号 → 角色」绑定。
   *
   * 【模块怎么给】
   *   教员/助教 属于大学部班级，给 class（他们也是升实训的发起人之一）；
   *   项目经理是实训阶段接手的人，给 job。
   * ============================================================ */
  {
    account: 'chenxf',
    name: '陈晓峰',
    kind: 'module_owner',
    title: '教员',
    dept: '大学部',
    phone: '13800000141',
    modules: ['class'],
    note: '教员 TEACH_TUTOR：大学部班级师资（建班 5 岗位之一）',
  },
  {
    account: 'zhaomx',
    name: '赵梦雪',
    kind: 'module_owner',
    title: '助教',
    dept: '大学部',
    phone: '13800000142',
    modules: ['class'],
    note: '助教 TEACH_ASSIST：大学部班级师资（建班 5 岗位之一）',
  },
  {
    account: 'sunjl',
    name: '孙建龙',
    kind: 'module_owner',
    title: '项目经理',
    dept: '实训管理',
    phone: '13800000143',
    modules: ['job'],
    note: '项目经理 RM_PROJECT：升实训后的接手人（升实训弹窗必选）',
  },
];

/** 清理：只删本脚本造的账号 */
const SEED_ACCOUNTS = ACCOUNTS.map((a) => a.account);

async function main() {
  const mode = (process.argv[2] || '').toLowerCase();
  const conn = await mysql.createConnection(CONN);
  try {
    await conn.changeUser({ database: PORTAL_DB });
    const T = 't_sys_account';

    if (mode === 'clean') {
      const [r] = await conn.query(`DELETE FROM \`${T}\` WHERE account IN (?)`, [SEED_ACCOUNTS]);
      console.log(`🧹 已删除 ${r.affectedRows} 个业务角色门户账号：${SEED_ACCOUNTS.join(', ')}`);
      return;
    }

    // ① 前置检查：这些账号在权限模块必须有对应角色，否则登录得进、菜单是空的
    const [permRows] = await conn.query(
      `SELECT u.account, u.user_name, GROUP_CONCAT(r.role_code) AS roles
         FROM \`${PERM_DB}\`.t_perm_user u
         LEFT JOIN \`${PERM_DB}\`.t_perm_user_role ur ON ur.user_id = u.id
         LEFT JOIN \`${PERM_DB}\`.t_perm_role r ON r.id = ur.role_id
        WHERE u.account IN (?) AND u.is_deleted = 0
        GROUP BY u.account, u.user_name`,
      [SEED_ACCOUNTS],
    );
    const permMap = new Map(permRows.map((r) => [r.account, r]));
    const missing = SEED_ACCOUNTS.filter((a) => !permMap.has(a));
    if (missing.length) {
      console.warn(
        `⚠️ 权限模块(sms_perm.t_perm_user)里找不到这些账号：${missing.join(', ')}\n` +
          '   它们能登录门户，但进去会是空菜单 —— 请先在权限管理里建用户。',
      );
    } else {
      console.log('✅ 权限模块角色核对：');
      for (const a of SEED_ACCOUNTS) {
        const r = permMap.get(a);
        console.log(`   · ${a}（${r.user_name}）→ ${r.roles || '（无角色）'}`);
      }
    }

    // ② upsert 门户账号
    let created = 0;
    let updated = 0;
    for (const a of ACCOUNTS) {
      const [exist] = await conn.query(`SELECT id FROM \`${T}\` WHERE account = ? LIMIT 1`, [a.account]);
      const modulesJson = JSON.stringify(a.modules);
      if (exist.length) {
        await conn.query(
          `UPDATE \`${T}\`
              SET user_name = ?, kind = ?, title = ?, dept = ?, phone = ?,
                  modules = ?, password = ?, active = 1, is_deleted = 0
            WHERE account = ?`,
          [a.name, a.kind, a.title, a.dept, a.phone, modulesJson, PASSWORD, a.account],
        );
        updated += 1;
      } else {
        await conn.query(
          `INSERT INTO \`${T}\`
             (id, create_time, create_by, create_by_name, update_time, update_by,
              is_deleted, account, password, user_name, kind, title, dept, phone, modules, active)
           VALUES (?, NOW(), 'seed', '门户账号种子', NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [randomUUID(), a.account, PASSWORD, a.name, a.kind, a.title, a.dept, a.phone, modulesJson],
        );
        created += 1;
      }
      console.log(`   ${exist.length ? '↻ 更新' : '＋ 新建'} ${a.account}（${a.name} / ${a.title}）→ [${a.modules.join(', ')}]  —— ${a.note}`);
    }

    // ③ 顺手把 admin 补上 job/edu/class/class-jh（系统管理员应看到全部模块卡片）
    const [admin] = await conn.query(`SELECT id, modules FROM \`${T}\` WHERE account = 'admin' LIMIT 1`);
    if (admin.length) {
      let mods = [];
      try {
        mods = JSON.parse(admin[0].modules || '[]');
      } catch {
        mods = [];
      }
      const want = ['consult', 'finance', 'perm', 'job', 'edu', 'class', 'class-jh'];
      const merged = [...new Set([...mods, ...want])];
      if (merged.length !== mods.length) {
        await conn.query(`UPDATE \`${T}\` SET modules = ? WHERE id = ?`, [JSON.stringify(merged), admin[0].id]);
        console.log(`   ↻ admin 模块已补齐 → [${merged.join(', ')}]`);
      }
    }

    console.log(`\n🎉 完成：新建 ${created} 个，更新 ${updated} 个。默认密码 ${PASSWORD}。`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('❌ 种子执行失败：', e.message);
  process.exit(1);
});
