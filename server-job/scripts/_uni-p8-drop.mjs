/**
 * P8（阶段 7 · 任务 #17）：**DROP 教学域老表**
 * ============================================================
 *
 * 【前置（全部已满足）】
 *   ① P3~P6：教学域后端 100% 读统一表（17 套件 + verify-live 开关开全绿）
 *   ② P5：数据已搬迁（377 行对账全绿）
 *   ③ 最终备份：exports/p8-final-backup/*.sql（5 库全量 DDL+数据，可整库回放）
 *   ④ seed 闭环：seed-all-demo 尾部「临时重建老表→灌→搬迁→清」已就绪
 *
 * 【DROP 清单】
 *   后端 UNI_MAP 的全部 distinct 源表：
 *     sms_class（23）+ sms_class_jh（26）+ sms_job（22）+ sms_common 的 4 张 *_sync（已搬迁，无读写方）
 *   【保留】
 *     sms_edu 全部（B 类不切域）、sms_common.t_teaching_conf、knex_migrations*（迁移系统）、
 *     finance/perm/consult/portal 各库（不在归一范围）
 *
 * 【安全机制】
 *   默认 dry-run（只打印清单与行数）；带 --execute 才真删。
 *   删除前逐表输出当前行数留痕（P6 后老表无写入方，行数应与 P5 搬迁时点一致；
 *   若明显变大说明存在隐藏写入方 → 人工核查）。
 *
 * 跑法：
 *   node scripts/_uni-p8-drop.mjs            # dry-run
 *   node scripts/_uni-p8-drop.mjs --execute  # 真删
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = require('mysql2/promise');

const EXECUTE = process.argv.includes('--execute');

function parseUniMap() {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'teaching', 'shared', 'uniTable.ts'),
    'utf8',
  );
  const block = src.slice(
    src.indexOf('export const UNI_MAP'),
    src.indexOf('};', src.indexOf('export const UNI_MAP')),
  );
  return [...block.matchAll(/'([a-z_]+\.t_[a-z_]+)'\s*:\s*'(t_uni_[a-z_]+)'/g)].map((x) => [x[1], x[2]]);
}

async function main() {
  const pairs = parseUniMap();
  const sources = [...new Set(pairs.map(([o]) => o))].sort();
  const byDb = {};
  for (const o of sources) {
    const [db, t] = o.split('.');
    (byDb[db] = byDb[db] || []).push(t);
  }

  console.log(`DROP 清单：${sources.length} 张源表（${EXECUTE ? '★ --execute 真删模式' : 'dry-run，加 --execute 才真删'}）\n`);
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: false,
  });

  let totalRows = 0;
  for (const [db, tables] of Object.entries(byDb)) {
    for (const t of tables) {
      const [[{ c }]] = await conn.query(`select count(*) c from \`${db}\`.\`${t}\``);
      totalRows += Number(c);
      console.log(`  ${EXECUTE ? '🗑' : '·'} ${db}.${t}  行数=${c}`);
      if (EXECUTE) {
        await conn.query(`DROP TABLE IF EXISTS \`${db}\`.\`${t}\``);
      }
    }
  }
  console.log(`\n合计 ${sources.length} 张 / ${totalRows} 行`);
  if (EXECUTE) {
    console.log('✔ 教学域老表已全部 DROP。备份留存于 exports/p8-final-backup/（可整库回放）');
    console.log('  ⚠ seed-all-demo.mjs 今后运行时会用备份 DDL 临时重建老表（灌完自动删），属正常现象');
  } else {
    console.log('（dry-run 结束。确认无误后加 --execute 执行）');
  }

  await conn.end();
}

main().catch((e) => {
  console.error('✗ 失败：', e?.message || e);
  process.exit(1);
});
