/**
 * ★ 账号权限校准脚本（sms_portal ↔ sms_perm 对齐）
 *
 * 用法：
 *    node scripts/fix-perm-accounts.mjs           # 校准（可重复执行，幂等）
 *    node scripts/fix-perm-accounts.mjs --dry     # 只看差异，不改
 *
 * ============================================================
 * 【它解决什么问题】
 *   门户账号（sms_portal.t_sys_account）与权限账号（sms_perm.t_perm_user）
 *   是两张表，靠 `account`（登录名）对齐。历史上出现三类不对应：
 *     ① 门户有账号、权限库没有对应人 → 登录得进，业务角色解析为空，
 *        表现是「菜单能出来，但列表一律空/操作一律 403」
 *     ② 权限库有账号、门户没有 → 僵尸账号，永远登录不了，
 *        却占着角色绑定的名额，看权限报表时对不上
 *     ③ 部门的部门（dept_id）挂错 → 「按部门」数据范围/统计口径落空
 *
 * 【口径】以门户的 16 个账号为唯一基准（2026-10-06 用户拍板；13 → 16：补 教员/助教/项目经理）：
 *   门户有什么人，权限库就该有什么人，且角色/部门与岗位一致。
 *   权威角色集见 PERM_ROLE，改这个表即可调整某人的角色。
 *
 * ⚠️ 只动 sms_perm 的 t_perm_user / t_perm_user_role 两张表，
 *    不碰 sms_portal（门户账号是登录入口，改它风险高）。
 * ⚠️ 僵尸账号用【软删】（is_deleted=1 + 状态置停用），不物理删除 ——
 *    历史审批日志/操作日志里还引用着它们的 user_id。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

function loadEnv() {
  const env = {};
  try {
    const raw = readFileSync(resolve(__dirname, '../.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 用默认 */ }
  return env;
}
const ENV = loadEnv();
const CONN = {
  host: ENV.DB_HOST || '127.0.0.1', port: Number(ENV.DB_PORT || 3306),
  user: ENV.DB_USER || 'root', password: ENV.DB_PASSWORD || '',
  charset: 'utf8mb4',
};
const DB_PERM = ENV.DB_NAME_PERM || 'sms_perm';
const DB_PORTAL = ENV.DB_NAME_PORTAL || 'sms_portal';

/* ============================================================
 * 目标状态（唯一事实来源）
 *
 *   account  = 门户登录名，必须与 t_sys_account.account 完全一致
 *   roles    = 该岗位应有的业务角色码（sms_perm.t_perm_role.role_code）
 *   dept     = 所属部门（sms_perm.t_perm_dept.id）
 *   title    = 岗位名（与门户 title 对齐，便于人工核对）
 * ============================================================ */

const PERM_ROLE = {
  admin: { name: '系统管理员', title: '系统管理员', dept: 'D_ADM', roles: ['SYS_ADMIN'] },
  // ★ 2026-10-06：校长 = 全模块（门户 modules 同步给 7 个），角色仍是 RM_PRINCIPAL
  qiansy: { name: '钱守义', title: '校长', dept: 'D_ALL', roles: ['RM_PRINCIPAL'] },
  congym: { name: '丛玉梅', title: '学管主任', dept: 'D_TEACH', roles: ['TEACH_DEAN', 'TEACH_QTY'] },
  zhanght: { name: '张海涛', title: '班主任（大学部）', dept: 'D_TEACH_U', roles: ['TEACH_HEAD'] },
  sunmin: { name: '孙敏', title: '班主任（初高）', dept: 'D_TEACH', roles: ['TEACH_HEAD'] },
  zhengym: { name: '郑一鸣', title: '教务老师', dept: 'D_ACAD', roles: ['ACAD_STAFF'] },
  zhouj: { name: '周杰', title: '就业老师', dept: 'D_JOB', roles: ['JOB_STAFF'] },
  zhoum: { name: '周铭', title: '财务负责人', dept: 'D_FIN', roles: ['FIN_STAFF'] },
  liukj: { name: '刘会计', title: '财务专员', dept: 'D_FIN', roles: ['FIN_STAFF'] },
  linx: { name: '林晓', title: '权限管理员', dept: 'D_ADM', roles: ['SYS_ADMIN'] },
  wangjl: { name: '王经理', title: '市场咨询经理', dept: 'D_MKT', roles: ['MKT_MANAGER'] },
  zhangls: { name: '张老师', title: '咨询师', dept: 'D_MKT', roles: ['MKT_CONSULT'] },
  lilx: { name: '李老师', title: '咨询师', dept: 'D_MKT', roles: ['MKT_CONSULT'] },
  /* ============================================================
   * ★ 2026-10-06 新增：建班 5 岗位里缺的 3 个角色
   *
   * 用户口径「选角色的地方，选项要来自系统内账户所对应的角色」。
   * 系统里原来没有 教员 / 助教 / 项目经理 的账号 → 这 3 个下拉是空的。
   * 补账号（gw_no / phone 一并给上，否则账号管理页那两列是空白）。
   * ============================================================ */
  chenxf: { name: '陈晓峰', title: '教员', dept: 'D_TEACH_U', roles: ['TEACH_TUTOR'], gwNo: 'GW1022', phone: '13800000141' },
  zhaomx: { name: '赵梦雪', title: '助教', dept: 'D_TEACH_U', roles: ['TEACH_ASSIST'], gwNo: 'GW1023', phone: '13800000142' },
  sunjl: { name: '孙建龙', title: '项目经理', dept: 'D_TRAIN', roles: ['RM_PROJECT'], gwNo: 'GW1024', phone: '13800000143' },
};

/** 门户里不存在的权限账号 —— 软删为僵尸（保留历史引用） */
const ZOMBIE_ACCOUNTS = [
  'chensy', 'fenglei', 'liuq', 'liwb', 'wangyj', 'wutong', 'xuqing', 'zhaogd',
];

/* ============================================================ */

const log = [];
const say = (m) => { log.push(m); console.log(m); };

async function main() {
  const conn = await mysql.createConnection(CONN);
  say('════════════════════════════════════════════');
  say('  账号权限校准：sms_portal ↔ sms_perm');
  say(DRY ? '  ⚠️ --dry：只报差异，不写库' : '');
  say('════════════════════════════════════════════');

  const [portalRows] = await conn.query(
    `SELECT account, user_name, title, kind, modules, active FROM \`${DB_PORTAL}\`.t_sys_account WHERE is_deleted = 0`,
  );
  const portal = new Map(portalRows.map((r) => [r.account, r]));
  say(`\n门户账号 ${portal.size} 个：${[...portal.keys()].join(', ')}`);

  const [roleRows] = await conn.query(
    `SELECT id, role_code, role_name FROM \`${DB_PERM}\`.t_perm_role WHERE is_deleted = 0`,
  );
  const roleId = new Map(roleRows.map((r) => [r.role_code, r.id]));

  const [deptRows] = await conn.query(`SELECT id FROM \`${DB_PERM}\`.t_perm_dept WHERE is_deleted = 0`);
  const depts = new Set(deptRows.map((r) => r.id));

  const [userRows] = await conn.query(
    `SELECT id, account, user_name, dept_id, user_status, is_deleted FROM \`${DB_PERM}\`.t_perm_user`,
  );
  const permUsers = userRows;

  /* ---------- 1. 目标账号：门户有、权限库对齐 ---------- */
  say('\n【1】对齐 16 个门户账号');
  for (const [account, want] of Object.entries(PERM_ROLE)) {
    const p = portal.get(account);
    if (!p) { say(`  ✗ ${account} 门户里不存在，跳过（先建门户账号）`); continue; }

    // 找账号（含被改名的历史行：zhoum#DEL#xxx）
    const candidates = permUsers.filter(
      (u) => u.account === account || u.account.startsWith(`${account}#DEL#`),
    );
    let target = candidates.find((u) => u.is_deleted === 0) ?? candidates[0];

    for (const r of want.roles) {
      if (!roleId.has(r)) say(`  ⚠ 角色码 ${r} 在 sms_perm.t_perm_role 里不存在！`);
    }
    if (!depts.has(want.dept)) say(`  ⚠ 部门 ${want.dept} 不存在！`);

    if (!target) {
      // 门户有、权限库完全没有 → 新建
      // ★ 2026-10-06：gw_no / phone 一并写入（否则账号管理页「工号 / 手机号」两列空白）
      const id = `U_${account}`;
      say(`  + ${account}（${want.title}）权限库缺失 → 新建 ${id}`);
      if (!DRY) {
        await conn.query(
          `INSERT INTO \`${DB_PERM}\`.t_perm_user
             (id, create_time, create_by, update_time, update_by, is_deleted,
              user_name, gw_no, account, phone, gender, age, dept_id, password, pwd_algo, user_status, need_change_pwd, pwd_error_count)
           VALUES (?, NOW(), 'FIX', NOW(), 'FIX', 0, ?, ?, ?, ?, ?, ?, ?, '123456', 'plain', '正常', 0, 0)`,
          [id, want.name, want.gwNo ?? null, account, want.phone ?? null, want.gender ?? 1, want.age ?? 30, want.dept],
        );
      }
      target = { id, is_deleted: 1, account: `${account}#NEW` };
    } else if (target.account !== account || target.is_deleted !== 0
      || target.user_name !== want.name || target.dept_id !== want.dept || target.user_status !== '正常') {
      say(`  ~ ${account}（${want.title}）修正：account=${target.account}→${account}，`
        + `姓名=${target.user_name}→${want.name}，部门=${target.dept_id}→${want.dept}，状态→正常`);
      if (!DRY) {
        await conn.query(
          `UPDATE \`${DB_PERM}\`.t_perm_user
             SET account = ?, user_name = ?, dept_id = ?, user_status = '正常',
                 -- ⚠️ 软删时会把 gw_no / phone 改名成「xxx#DEL#时间戳」占位，
                 --    恢复后必须一并还原，否则账号管理页的「工号 / 手机号」会带着 #DEL# 尾巴
                 gw_no = SUBSTRING_INDEX(gw_no, '#DEL#', 1),
                 phone = SUBSTRING_INDEX(phone, '#DEL#', 1),
                 is_deleted = 0, update_time = NOW(), update_by = 'FIX'
           WHERE id = ?`,
          [account, want.name, want.dept, target.id],
        );
      }
    } else {
      say(`  = ${account}（${want.title}）已对齐`);
    }

    // 无论走哪个分支，都把软删期留下的「#DEL#时间戳」占位还原掉
    // （软删时 gw_no / phone 会被改名占位；只改 account 不还原这两个字段，
    //   账号管理页就会显示 GW1016#DEL#179103354 这种工号）
    // 顺带把 need_change_pwd 归零：演示账号是共享密码，不该被标记「首次登录强制改密」，
    // 否则账号管理页会出现无意义的「待激活 / 需改密」角标。
    if (!DRY) {
      await conn.query(
        `UPDATE \`${DB_PERM}\`.t_perm_user
           SET gw_no = SUBSTRING_INDEX(gw_no, '#DEL#', 1),
               phone = SUBSTRING_INDEX(phone, '#DEL#', 1),
               need_change_pwd = 0
         WHERE id = ? AND (gw_no LIKE '%#DEL#%' OR phone LIKE '%#DEL#%' OR need_change_pwd <> 0)`,
        [target.id],
      );
      // ★ 2026-10-06：工号 / 手机号为空的历史账号补上（PERM_ROLE 里给了 gwNo/phone 的）
      if (want.gwNo || want.phone) {
        await conn.query(
          `UPDATE \`${DB_PERM}\`.t_perm_user
             SET gw_no = COALESCE(gw_no, ?), phone = COALESCE(phone, ?)
           WHERE id = ?`,
          [want.gwNo ?? null, want.phone ?? null, target.id],
        );
      }
    }

    // 角色绑定：先把该用户的绑定全部置删，再按目标角色逐条 upsert
    if (!DRY) {
      await conn.query(
        `UPDATE \`${DB_PERM}\`.t_perm_user_role SET is_deleted = 1, update_time = NOW(), update_by = 'FIX'
           WHERE user_id = ?`,
        [target.id],
      );
      for (const r of want.roles) {
        const rid = roleId.get(r);
        if (!rid) continue;
        const [exist] = await conn.query(
          `SELECT id FROM \`${DB_PERM}\`.t_perm_user_role WHERE user_id = ? AND role_id = ?`,
          [target.id, rid],
        );
        if (exist.length) {
          await conn.query(
            `UPDATE \`${DB_PERM}\`.t_perm_user_role SET is_deleted = 0, update_time = NOW(), update_by = 'FIX' WHERE id = ?`,
            [exist[0].id],
          );
        } else {
          await conn.query(
            `INSERT INTO \`${DB_PERM}\`.t_perm_user_role (id, create_time, create_by, update_time, update_by, is_deleted, user_id, role_id)
             VALUES (?, NOW(), 'FIX', NOW(), 'FIX', 0, ?, ?)`,
            [`${target.id}_${rid}`, target.id, rid],
          );
        }
      }
    }
  }

  /* ---------- 2. 僵尸账号：权限库有、门户没有 ---------- */
  say('\n【2】清理僵尸权限账号（门户里不存在的）');
  const portalAccounts = new Set(portal.keys());
  const zombies = permUsers.filter(
    (u) => u.is_deleted === 0
      && !portalAccounts.has(u.account)
      && !Object.keys(PERM_ROLE).includes(u.account),
  );
  if (!zombies.length) {
    say('  = 没有需要清理的账号');
  } else {
    for (const z of zombies) {
      const extra = ZOMBIE_ACCOUNTS.includes(z.account) ? '' : '（不在预置僵尸名单，但仍无门户账号）';
      say(`  - 软删 ${z.id} ${z.account} ${z.user_name}${extra}`);
      if (!DRY) {
        await conn.query(
          `UPDATE \`${DB_PERM}\`.t_perm_user
             SET is_deleted = 1, user_status = '已停用', update_time = NOW(), update_by = 'FIX'
           WHERE id = ?`,
          [z.id],
        );
        await conn.query(
          `UPDATE \`${DB_PERM}\`.t_perm_user_role SET is_deleted = 1, update_time = NOW(), update_by = 'FIX'
             WHERE user_id = ?`,
          [z.id],
        );
      }
    }
  }

  /* ---------- 3. 校准结果 ---------- */
  say('\n【3】校准结果（有效账号 → 角色 / 部门）');
  const [final] = await conn.query(
    `SELECT u.id, u.account, u.user_name, u.dept_id, d.dept_name,
            GROUP_CONCAT(r.role_code ORDER BY r.sort_no) AS roles
       FROM \`${DB_PERM}\`.t_perm_user u
       LEFT JOIN \`${DB_PERM}\`.t_perm_dept d ON d.id = u.dept_id
       LEFT JOIN \`${DB_PERM}\`.t_perm_user_role ur ON ur.user_id = u.id AND ur.is_deleted = 0
       LEFT JOIN \`${DB_PERM}\`.t_perm_role r ON r.id = ur.role_id AND r.is_deleted = 0
      WHERE u.is_deleted = 0
      GROUP BY u.id, u.account, u.user_name, u.dept_id, d.dept_name
      ORDER BY u.id`,
  );
  say('  账号        姓名      部门        角色');
  for (const r of final) {
    const p = portal.get(r.account);
    const flag = p ? '✓' : '✗ 无门户账号';
    say(`  ${String(r.account).padEnd(10)} ${String(r.user_name).padEnd(6)} ${String(r.dept_name ?? '-').padEnd(10)} ${r.roles ?? '(无角色)'}  ${flag}`);
  }
  const orphan = final.filter((r) => !portal.get(r.account));
  if (orphan.length) say(`\n  ⚠ 仍有 ${orphan.length} 个权限账号没有对应门户账号`);

  say('\n════════════════════════════════════════════');
  say(DRY ? '  --dry 结束（未写库）' : '  ✓ 校准完成');
  say('════════════════════════════════════════════');

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
