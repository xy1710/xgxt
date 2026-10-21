#!/usr/bin/env node
/**
 * 部门结构调整：实训教学部 + 就业管理部 → 就业部（下设 实训管理 / 就业管理）
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户在「权限管理 → 部门管理」截图里框住「实训教学部」「就业管理部」两行，
 *   要求合并成一个「就业部」，就业部下设「实训管理」「就业管理」两个子部门，
 *   子部门的职位数 / 账号数沿用原有两个部门的数据（说明、「就业老师」职位、
 *   两个账号一个都不动）。教学部下面 初中部 / 高中部 / 大学部 已经是三层结构，
 *   这次是把它变成「同样的形态」的第二个父部门。
 *
 * 为什么是「改 id 的父子关系」而不是「删旧建新」：
 *   t_perm_dept.id 是职位（t_perm_role.dept_id）、账号（t_perm_user.dept_id）的
 *   外键值。若新建两个部门再把职位/账号挪过去，任何一步失败都会留下
 *   「职位挂在已删部门上」的脏数据（列表里部门列显示「—」，鉴权按部门过滤时查不到人）。
 *   所以：
 *     · D_TRAIN（实训教学部）就地改名为「实训管理」，挂到新的 D_EMP 下；
 *     · D_JOB  （就业管理部）就地改名为「就业管理」，挂到新的 D_EMP 下；
 *     · 新增 D_EMP「就业部」作为父级。
 *   这样一来 role / user 的引用一个字节都不用动。
 *
 * 幂等：重复跑只是把三行再写成同样的值（不会新增第二行）。
 *
 * 用法：
 *   node scripts/_migrate-dept-employment-merge.cjs            # 只看不改（dry-run）
 *   node scripts/_migrate-dept-employment-merge.cjs --apply    # 真正写库
 *
 * 库名取 .env 的 DB_NAME_PERM（默认 sms_perm），可用 DB_NAME_PERM 环境变量覆盖。
 */

const path = require('path');
const { createRequire } = require('module');

const requireFromServer = createRequire(path.join(process.cwd(), 'package.json'));
requireFromServer('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = requireFromServer('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME_PERM || 'sms_perm';

/** 目标结构：id → 期望值（parent / level / sort 全部写死，便于人工核对） */
const TARGET = {
  D_EMP: {
    name: '就业部',
    short: '就业',
    parent: 'D_ALL',
    level: 2,
    sort: 6,
    remark: '实训管理与就业管理',
    action: '新增',
  },
  D_TRAIN: {
    name: '实训管理',
    short: '实训管理',
    parent: 'D_EMP',
    level: 3,
    sort: 6,
    remark: '实训带班与出勤管理',
    action: '原「实训教学部」改名并下沉',
  },
  D_JOB: {
    name: '就业管理',
    short: '就业管理',
    parent: 'D_EMP',
    level: 3,
    sort: 7,
    remark: '就业老师、换班交接',
    action: '原「就业管理部」改名并下沉',
  },
};

/** 合并后不该再出现的（活跃）部门名 */
const GONE = ['实训教学部', '就业管理部'];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: DB,
    charset: 'utf8mb4',
    timezone: '+08:00',
  });

  try {
    console.log(`\n===== 部门结构合并 · ${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（只看不改）'} · 库 ${DB} =====\n`);

    const [before] = await conn.query(
      'SELECT id, dept_name, dept_short, parent_id, dept_level, sort_no, remark FROM t_perm_dept WHERE is_deleted = 0 ORDER BY dept_level, sort_no',
    );
    console.log('--- 改动前 ---');
    before.forEach((r) =>
      console.log(
        `  ${r.id.padEnd(38)} ${String(r.dept_name).padEnd(8)} parent=${String(r.parent_id || '-').padEnd(10)} L${r.dept_level} sort=${r.sort_no}`,
      ),
    );

    /* ---------- 前置校验：别在数据已经不对的库上静默改 ---------- */
    const byId = new Map(before.map((r) => [r.id, r]));
    if (!byId.has('D_ALL')) throw new Error('找不到校级部门 D_ALL，库可能不是权限库');
    if (!byId.has('D_TRAIN') || !byId.has('D_JOB')) {
      throw new Error('找不到 D_TRAIN / D_JOB —— 本库可能已合并过，或不是预期的权限库');
    }
    const dupEmp = before.find((r) => r.dept_name === '就业部' && r.id !== 'D_EMP');
    if (dupEmp) {
      throw new Error(
        `库里已存在另一个活跃的「就业部」（id=${dupEmp.id}）。请先在页面上删掉它再跑本脚本，避免出现两个同名部门`,
      );
    }
    for (const [id, t] of Object.entries(TARGET)) {
      const other = before.find((r) => r.dept_name === t.name && r.id !== id);
      if (other) throw new Error(`部门名「${t.name}」已被 ${other.id} 占用，先处理它`);
    }

    /* ---------- 写入 ---------- */
    const now = new Date();
    for (const [id, t] of Object.entries(TARGET)) {
      const exists = byId.has(id);
      const sql = exists
        ? `UPDATE t_perm_dept
              SET dept_name = ?, dept_short = ?, parent_id = ?, dept_level = ?, sort_no = ?, remark = ?, update_time = ?
            WHERE id = ?`
        : `INSERT INTO t_perm_dept
              (id, dept_name, dept_short, parent_id, dept_level, sort_no, remark, is_deleted, create_time, create_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'dept-merge-2026-10-20')`;
      const params = exists
        ? [t.name, t.short, t.parent, t.level, t.sort, t.remark, now, id]
        : [id, t.name, t.short, t.parent, t.level, t.sort, t.remark, now];

      console.log(`\n[${t.action}] ${id}`);
      console.log(`  ${sql.replace(/\s+/g, ' ').trim()}`);
      console.log(`  参数 = ${JSON.stringify(params)}`);
      if (APPLY) await conn.query(sql, params);
    }

    if (!APPLY) {
      console.log('\n（DRY-RUN 结束，未写库。确认无误后加 --apply 执行）\n');
      return;
    }

    /* ---------- 改动后核对 ---------- */
    const [after] = await conn.query(
      'SELECT id, dept_name, dept_short, parent_id, dept_level, sort_no, remark FROM t_perm_dept WHERE is_deleted = 0 ORDER BY dept_level, sort_no',
    );
    console.log('\n--- 改动后 ---');
    after.forEach((r) =>
      console.log(
        `  ${r.id.padEnd(38)} ${String(r.dept_name).padEnd(8)} parent=${String(r.parent_id || '-').padEnd(10)} L${r.dept_level} sort=${r.sort_no}`,
      ),
    );

    const left = after.filter((r) => GONE.includes(r.dept_name));
    console.log(
      left.length
        ? `\n❌ 仍有残留的旧部门名：${left.map((r) => r.dept_name).join('、')}`
        : `\n✅ 已无「${GONE.join('」「')}」活跃行`,
    );

    const [refs] = await conn.query(
      `SELECT d.dept_name, r.id AS role_id, r.role_name, u.id AS user_id, u.user_name
         FROM t_perm_dept d
         LEFT JOIN t_perm_role r ON r.dept_id = d.id AND r.is_deleted = 0
         LEFT JOIN t_perm_user u ON u.dept_id = d.id AND u.is_deleted = 0
        WHERE d.id IN ('D_EMP','D_TRAIN','D_JOB')
        ORDER BY d.dept_level, d.sort_no`,
    );
    console.log('\n--- 职位 / 账号引用（应原样保留）---');
    refs.forEach((r) =>
      console.log(`  ${r.dept_name.padEnd(6)} 职位=${r.role_name || '—'} 账号=${r.user_name || '—'}`),
    );

    console.log('\n--- 回滚语句（万一要还原，逐条执行）---');
    console.log(
      [
        `UPDATE t_perm_dept SET dept_name='实训教学部', dept_short='实训教学', parent_id='D_ALL', dept_level=2, sort_no=6, remark='实训带班与出勤管理' WHERE id='D_TRAIN';`,
        `UPDATE t_perm_dept SET dept_name='就业管理部', dept_short='就业管理', parent_id='D_ALL', dept_level=2, sort_no=7, remark='就业老师、换班交接' WHERE id='D_JOB';`,
        `UPDATE t_perm_dept SET is_deleted=1 WHERE id='D_EMP';`,
      ].join('\n'),
    );
    console.log('');
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('\n❌ 失败：', e.message, '\n');
  process.exit(1);
});
