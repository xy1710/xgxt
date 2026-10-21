#!/usr/bin/env node
/**
 * 职位归属调整：项目经理 挂到「就业部」条线下
 * ============================================================================
 *
 * 背景（2026-10-20）：
 *   用户在「部门管理 → 就业部 → 查看职位」截图里框住只有「就业老师」一行，
 *   同时框出「就业部 → 查看账号」里孙建龙的职位是「项目经理」，
 *   要求「项目经理和就业老师都归就业部」。
 *
 * 【现状】
 *   R10 就业老师  JOB_STAFF  → D_JOB    （就业管理，就业部的下级）✅ 已在就业部条线
 *   R11 项目经理  RM_PROJECT → D_ALL    （全部门）            ❌ 不在任何业务部门下
 *
 *   「全部门」是个虚拟根部门，职位挂在那里有三个副作用：
 *     · 「实训管理」职位数显示 0，可孙建龙明明就挂在实训管理；
 *     · 就业部下（含下级）只能看到就业老师 1 个职位；
 *     · 职位管理列表里它的部门列显示「全部门」，看不出归属。
 *
 * 【为什么落到 D_TRAIN（实训管理）而不是直接挂 D_EMP（就业部）】
 *   项目经理是实训条线的角色（带实训班、对接就业），
 *   而且孙建龙的账号「具体部门」就是实训管理 —— 职位与账号口径一致，
 *   实训管理也不会再是「0 个职位」的空部门。
 *   落到下级后，就业部的「查看职位」按「含下级」查询，两个职位照样都能看到。
 *   若业务上要让它在就业部直属，把 TARGET_DEPT 改成 'D_EMP' 重跑即可（幂等）。
 *
 * 【幂等】重复跑只是把同一行再写成同样的值；已经是目标值就跳过不写。
 *
 * 用法：
 *   node scripts/_migrate-role-to-emp.cjs            # 只看不改（dry-run）
 *   node scripts/_migrate-role-to-emp.cjs --apply    # 真正写库
 *
 * 回滚：
 *   UPDATE t_perm_role SET dept_id='D_ALL' WHERE id='R11';
 */

const path = require('path');
const { createRequire } = require('module');

const requireFromServer = createRequire(path.join(process.cwd(), 'package.json'));
requireFromServer('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = requireFromServer('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME_PERM || 'sms_perm';

/** 目标：角色 id → 期望部门 */
const TARGET_ROLE_ID = 'R11';
const TARGET_DEPT = 'D_TRAIN';

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'xueguan',
    password: process.env.DB_PASSWORD || 'xueguan123',
    database: DB,
  });

  console.log(`模式：${APPLY ? '★ 写库（--apply）' : 'dry-run（只看不改）'}`);
  console.log(`库：${DB}\n`);

  const [roleRows] = await c.query(
    'SELECT id, role_name, role_code, dept_id FROM t_perm_role WHERE id = ? AND is_deleted = 0',
    [TARGET_ROLE_ID],
  );
  if (!roleRows.length) {
    console.error(`✗ 找不到职位 ${TARGET_ROLE_ID}`);
    await c.end();
    process.exit(1);
  }
  const role = roleRows[0];

  const [deptRows] = await c.query(
    'SELECT id, dept_name, parent_id FROM t_perm_dept WHERE id IN (?, ?) AND is_deleted = 0',
    [role.dept_id, TARGET_DEPT],
  );
  const nameOf = (id) => (deptRows.find((d) => d.id === id) || {}).dept_name || null;

  console.log('【现状】');
  console.log(`  职位：${role.role_name}（${role.role_code} / ${role.id}）`);
  console.log(`  部门：${role.dept_id} ${nameOf(role.dept_id) || '（部门不存在）'}`);
  console.log('\n【目标】');
  console.log(`  部门：${TARGET_DEPT} ${nameOf(TARGET_DEPT) || '（部门不存在）'}`);

  if (!nameOf(TARGET_DEPT)) {
    console.error(`\n✗ 目标部门 ${TARGET_DEPT} 不存在，中止`);
    await c.end();
    process.exit(1);
  }

  if (role.dept_id === TARGET_DEPT) {
    console.log('\n✓ 已经是目标部门，无需改动');
    await c.end();
    return;
  }

  if (!APPLY) {
    console.log('\n（dry-run）将执行：');
    console.log(`  UPDATE t_perm_role SET dept_id='${TARGET_DEPT}' WHERE id='${TARGET_ROLE_ID}';`);
    console.log('\n加 --apply 才会真正写库。');
    await c.end();
    return;
  }

  const [res] = await c.query(
    'UPDATE t_perm_role SET dept_id = ?, update_time = NOW() WHERE id = ? AND is_deleted = 0',
    [TARGET_DEPT, TARGET_ROLE_ID],
  );
  console.log(`\n✓ 已更新 ${res.affectedRows} 行`);

  // 写一条操作日志（与界面上的改动留痕一致）
  await c
    .query(
      `INSERT INTO t_perm_log
        (id, create_time, create_by, update_time, update_by, is_deleted,
         log_time, operator_id, operator_name, operator_role, module_name, action_type,
         target_obj, before_value, after_value, ip, result)
       VALUES (UUID(), NOW(), 'system', NOW(), 'system', 0,
         NOW(), 'system', '系统维护', '系统管理员', '权限管理', '修改',
         ?, ?, ?, '127.0.0.1', '成功')`,
      [
        `职位 ${role.role_name} 的所属部门`,
        `${role.dept_id} ${nameOf(role.dept_id) || ''}`.trim(),
        `${TARGET_DEPT} ${nameOf(TARGET_DEPT)}`,
      ],
    )
    .catch((e) => console.log(`（日志未写入：${e.message}）`));

  const [after] = await c.query('SELECT dept_id FROM t_perm_role WHERE id = ?', [TARGET_ROLE_ID]);
  console.log(`校验：${role.role_name} 现在挂 ${after[0].dept_id} ${nameOf(after[0].dept_id)}`);

  await c.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
