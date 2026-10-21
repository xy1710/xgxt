/**
 * 一次性排查脚本：转储权限目录三张表的结构 + 样本数据
 * 用法：node scripts/_dump-perm-tables.cjs
 */
const path = require('path');
process.chdir(__dirname + '/..');
require('dotenv').config();
const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME_PERM || 'sms_perm',
  },
});

const TABLES = ['t_perm_menu', 't_perm_menu_action', 't_perm_role_perm'];

(async () => {
  for (const t of TABLES) {
    const [cols] = await knex.raw(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?`,
      ['sms_perm', t],
    );
    console.log('\n===== ' + t + ' =====');
    if (!cols.length) { console.log('  (表不存在)'); continue; }
    cols.forEach((c) =>
      console.log(
        '  ' + c.COLUMN_NAME.padEnd(22) + c.COLUMN_TYPE.padEnd(24) +
        ' null=' + c.IS_NULLABLE + ' key=' + c.COLUMN_KEY + '  ' + (c.COLUMN_COMMENT || ''),
      ),
    );
    const [[{ n }]] = await knex.raw(`SELECT COUNT(*) n FROM \`${t}\``);
    const [[{ nd }]] = await knex.raw(`SELECT COUNT(*) nd FROM \`${t}\` WHERE is_deleted = 0`);
    console.log(`  rows = ${n} (其中未删除 ${nd})`);
  }

  console.log('\n===== t_perm_menu 全部模块（去重） =====');
  const mods = await knex('t_perm_menu')
    .where('is_deleted', 0)
    .select('module_key', 'module_name', 'module_icon', 'module_sort')
    .groupBy('module_key', 'module_name', 'module_icon', 'module_sort')
    .orderBy('module_sort');
  mods.forEach((m) => console.log('  ' + JSON.stringify(m)));

  console.log('\n===== t_perm_menu 功能点样本（每模块 3 条） =====');
  for (const m of mods) {
    const rows = await knex('t_perm_menu')
      .where({ is_deleted: 0, module_key: m.module_key })
      .orderBy('item_sort').limit(3);
    rows.forEach((r) =>
      console.log('  ' + JSON.stringify({
        mk: r.module_key, item: r.item_name, parent: r.parent_item_name,
        isort: r.item_sort, remark: r.remark, id: r.id,
      })),
    );
  }

  console.log('\n===== t_perm_menu_action 样本（前 15 条） =====');
  const acts = await knex('t_perm_menu_action').where('is_deleted', 0).orderBy('action_sort').limit(15);
  acts.forEach((a) =>
    console.log('  ' + JSON.stringify({
      menuId: a.menu_id, code: a.action_code, name: a.action_name,
      base: a.base_action, sort: a.action_sort, remark: a.remark,
    })),
  );

  console.log('\n===== t_perm_role_perm 样本（前 5 条） =====');
  const rps = await knex('t_perm_role_perm').limit(5);
  rps.forEach((r) => console.log('  ' + JSON.stringify(r)));

  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
