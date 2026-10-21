/**
 * 一次性结构修复：给 t_perm_role 补上缺失的 equiv_role_code 列
 *
 * 【为什么会有这个脚本】
 *   排查「全系统去掉职位编码」时，用真实接口做验证，POST /api/perm/role/add
 *   一直返回：
 *       { "code": 50002, "message": "数据库字段不存在（可能是迁移脚本没跑）" }
 *
 *   定位结论：**与本次「职位编码」改动无关**，是一个更早就存在的缺陷 ——
 *     ① 2026-10-08 代码里加了「等价内置职位」equiv_role_code
 *        （见 src/utils/roleEquiv.ts、src/perm/routes/role.route.ts），
 *        新建职位的 INSERT 里**无条件**写这一列；
 *     ② 但仓库里**从来没有任何**创建这一列的迁移脚本
 *        （`git ls-files | grep create_role_table` 为空，
 *          sms_perm 的迁移目录在本仓里根本不存在，
 *          knex_migrations 里只留下 14 条历史记录）；
 *     ③ 本机 sms_perm.t_perm_role 因此缺这一列 → 新建职位 100% 报 50002。
 *
 *   表现：演示库里 14 个职位是迁移种子数据，所以列表看着正常；
 *        但点「＋ 新建职位」永远失败（编辑职位不受影响 —— 前端不传该字段）。
 *
 * 【这个脚本做什么】
 *   `ALTER TABLE t_perm_role ADD COLUMN equiv_role_code VARCHAR(64) NULL`
 *   —— 纯新增、可空、无默认值，对现有数据零影响；已经存在则跳过（幂等）。
 *
 * 用法：node scripts/_fix-perm-role-equiv-column.cjs          # 只看，不改
 *      node scripts/_fix-perm-role-equiv-column.cjs --apply  # 真改
 *      DB=某个库名 node scripts/... --apply                  # 指定库（默认 sms_perm）
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB || process.env.DB_NAME_PERM || 'sms_perm',
    charset: 'utf8mb4',
    timezone: '+08:00',
  },
});

const TABLE = 't_perm_role';
const COLUMN = 'equiv_role_code';
const APPLY = process.argv.includes('--apply');

async function main() {
  const [[{ db: dbName }]] = await knex.raw('SELECT DATABASE() AS db');
  console.log(`目标库：${dbName}  表：${TABLE}  列：${COLUMN}`);

  const [[exists]] = await knex.raw(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, COLUMN],
  );

  if (exists.n > 0) {
    console.log('✅ 该列已存在，无需处理。');
    return;
  }

  console.log('❌ 缺列。新建职位会一直报 50002「数据库字段不存在」。');
  const [[before]] = await knex.raw(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  console.log(`   当前 ${TABLE} 共 ${before.n} 行（不会被动到）。`);

  if (!APPLY) {
    console.log('\n（预览模式）要真正执行，请加 --apply：');
    console.log(`   ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(64) NULL;`);
    return;
  }

  await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(64) NULL`);
  console.log('✅ 已执行 ALTER TABLE ... ADD COLUMN equiv_role_code VARCHAR(64) NULL');

  const [[after]] = await knex.raw(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, COLUMN],
  );
  const [[rows]] = await knex.raw(`SELECT COUNT(*) AS n FROM ${TABLE}`);
  console.log(`   复核：列数命中 ${after.n}，表行数 ${rows.n}（与改动前 ${before.n} 一致）`);
}

main()
  .catch((e) => {
    console.error('执行失败：', e.message);
    process.exitCode = 1;
  })
  .finally(() => knex.destroy());
