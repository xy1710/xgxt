/**
 * 定向同步：把「临时重建的老表」里的某一批行同步进统一表（不 TRUNCATE）
 * ============================================================
 *
 * 背景（P8 之后）：
 *   教学域老表已 DROP，但仍有几个**演示/运维脚本**按老表列名写数据
 *   （seed-demo.mjs、reset-demo-data.cjs）。它们的流程被包成：
 *     临时重建老表 → 按老逻辑写 → 【本脚本】定向同步 → 清除临时老表
 *
 * 为什么不直接用 `_uni-migrate-p5.mjs`：
 *   那个脚本会 **TRUNCATE 全部统一表** 再全量搬。定向同步只处理指定的行，
 *   不会碰其它数据（seed-demo 的语义是「只新增，不动现有数据」）。
 *
 * 用法：
 *   node scripts/_uni-sync-legacy.mjs --prefix=demo-                 # 按 id 前缀同步（upsert）
 *   node scripts/_uni-sync-legacy.mjs --prefix=demo- --delete        # 按前缀删除统一表里的演示行
 *   node scripts/_uni-sync-legacy.mjs --tables=sms_job.t_job_class,sms_job.t_student_base
 *
 * 说明：
 *   · 只处理 sms_job / sms_class / sms_class_jh 三个库（sms_common 的 sync 表要按班级推断学段，
 *     交由 _uni-migrate-p5.mjs 处理）；
 *   · upsert = 先按 id 删统一表里的同 id 行，再插入（避开唯一键残留冲突）；
 *   · 插入前用 buildRow 对着统一表兜底 NOT NULL 列（与 mirrorRow 同口径）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = require('mysql2/promise');
const { conn: knexConn, buildRow, shapeForUni } = await import('./_e2e-lib.mjs');

const argv = process.argv.slice(2);
const getArg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const PREFIX = getArg('prefix');
const ONLY = getArg('tables');
const DELETE_MODE = argv.includes('--delete');

const STAGE_OF_DB = { sms_job: 'job', sms_class: 'class', sms_class_jh: 'jh' };
const DBS = ['sms_job', 'sms_class', 'sms_class_jh'];

function parseUniMap() {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'teaching', 'shared', 'uniTable.ts'),
    'utf8',
  );
  const block = src.slice(
    src.indexOf('export const UNI_MAP'),
    src.indexOf('};', src.indexOf('export const UNI_MAP')),
  );
  const map = new Map();
  for (const m of block.matchAll(/'([a-z_]+\.t_[a-z_]+)'\s*:\s*'(t_uni_[a-z_]+)'/g)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** 统一表 → 源学段（同一统一表可能来自多学段，取先出现的即可：删除不区分学段） */
async function main() {
  const UNI_MAP = parseUniMap();
  const uniDb = knexConn('sms_common');

  const tables = ONLY
    ? ONLY.split(',').map((x) => x.trim()).filter(Boolean)
    : [...UNI_MAP.keys()].filter((k) => DBS.includes(k.split('.')[0]));

  /* ---------- 删除模式：清掉统一表里的演示行 ---------- */
  if (DELETE_MODE) {
    if (!PREFIX) throw new Error('--delete 必须配合 --prefix= 使用（防止误删全表）');
    const targets = [...new Set(tables.map((k) => UNI_MAP.get(k)).filter(Boolean))];
    let removed = 0;
    for (const t of targets) {
      try {
        const n = await uniDb(t).where('id', 'like', `${PREFIX}%`).del();
        removed += Number(n || 0);
      } catch (e) {
        console.log(`  ⚠ ${t}: 删除失败（${e.code || e.message}）`);
      }
    }
    console.log(`✔ 统一表已删除 ${removed} 行（id like '${PREFIX}%'，覆盖 ${targets.length} 张表）`);
    await uniDb.destroy();
    return;
  }

  /* ---------- 同步模式：按 id 前缀 upsert ---------- */
  let synced = 0;
  let skipped = 0;
  for (const key of tables) {
    const [dbName, table] = key.split('.');
    const uniTable = UNI_MAP.get(key);
    if (!uniTable) {
      skipped += 1;
      continue;
    }
    const stage = STAGE_OF_DB[dbName];
    if (!stage) {
      console.log(`  ⚠ ${key}: 该库需按班级推断学段，跳过（请用 _uni-migrate-p5.mjs）`);
      skipped += 1;
      continue;
    }
    const src = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: dbName,
    });
    let rows = [];
    try {
      const where = PREFIX ? 'where id like ?' : '';
      const args = PREFIX ? [`${PREFIX}%`] : [];
      [rows] = await src.query(`select * from \`${table}\` ${where}`, args);
    } catch (e) {
      console.log(`  ⚠ ${key}: 读取失败（${e.code || e.message}）`);
      skipped += 1;
      await src.end();
      continue;
    }
    await src.end();
    if (!rows.length) continue;

    for (const row of rows) {
      // 统一化：剔生成列 / stage→stage_code / 写 edu_stage / 剔除新表没有的列
      const uniRow = await shapeForUni(uniDb, dbName, table, row, stage, uniTable);
      const safe = await buildRow(uniDb, uniTable, uniRow);
      try {
        await uniDb(uniTable).where({ id: safe.id }).del();
        await uniDb(uniTable).insert(safe);
        synced += 1;
      } catch (e) {
        console.log(`  ⚠ ${key} 行 ${safe.id}: 写入失败（${e.code || e.message}）`);
        skipped += 1;
      }
    }
    console.log(`  ✔ ${key} → ${uniTable}：${rows.length} 行`);
  }
  console.log(`\n✔ 定向同步完成：${synced} 行${skipped ? `，跳过/失败 ${skipped}` : ''}`);
  await uniDb.destroy();
}

main().catch((e) => {
  console.error('✗ 同步失败：', e?.message || e);
  process.exit(1);
});
