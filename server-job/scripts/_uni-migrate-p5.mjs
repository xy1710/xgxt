/**
 * 阶段 4（P5 / 任务 #14）：老表 → 统一表 **数据搬迁**
 * ============================================================
 *
 * 【做什么】
 *   ① TRUNCATE 全部 42 张目标统一表（幂等：重跑从头；跑前必须已做备份 `_uni-p5-backup.mjs`）
 *   ② 按后端 UNI_MAP（75 条）逐源表搬运：shapeForUni（stage→stage_code、剔 src_*、注入 edu_stage、
 *      反补 room_id/room_no）+ buildRow（NOT NULL 无默认兜底）——复用 _e2e-lib 的镜像层，与套件同口径
 *   ③ 逐表对账「Σ老表行数 vs 统一表行数」，不一致退出码 1
 *   ④ 对账报告 → exports/p5-reconcile.md
 *
 * 【edu_stage 规则】
 *   sms_job→'job'、sms_class_jh→'jh'、sms_class→'class'；
 *   sms_common.t_class_fee_sync 跨学段（finance 推送）→ 按 class_id join 原生班级表推断，
 *   推断不出 → 直接报错（绝不猜）。
 *
 * 【本轮跳过（P6 拍板项，见任务清单 §3.2④''）】
 *   sms_common.t_class_dorm_room_sync / t_class_dorm_live_sync / t_class_urge_sync
 *   —— edu 外部推送落地表，building/学生不在任何原生表 → edu_stage 无法可靠推断。
 *
 * 跑法：node scripts/_uni-migrate-p5.mjs   （先跑 _uni-p5-backup.mjs！）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const mysql = require('mysql2/promise');
const { mirrorRow } = await import('./_e2e-lib.mjs');

/* ---------- 配置 ---------- */
// ★ 2026-10-16 P6 修正：三张 sync 表已确认归属——它们是 **class 班主任域的同步落地表**
//   （live_sync 学生 SC-U26001 即 class 域学生；room_sync 是 edu 推给班主任的宿舍），
//   edu_stage='class'。verify-live 的「宿舍 /room/list 空」就是跳过它们导致的（class 段 0 行）。
//   fee_sync 仍按 class_id join 推断（它跨 job/class 两域）。
const SKIP = new Set([]);
const STAGE_OF_DB = { sms_job: 'job', sms_class_jh: 'jh', sms_class: 'class' };

/* ---------- 工具 ---------- */
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
  const conn = async (db) =>
    mysql.createConnection({
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: db,
      multipleStatements: false,
    });

  // ★ 统一侧必须用 lib 的 knex 连接（uniColumnsOf/buildRow 依赖 .raw / knex 查询构造器）
  const { conn: knexConn } = await import('./_e2e-lib.mjs');
  const uniDb = knexConn('sms_common');
  const dbClass = await conn('sms_class');
  const dbJh = await conn('sms_class_jh');
  const dbJob = await conn('sms_job');

  /* 0. 备份检查
        ★ 2026-10-19：P8 时备份目录从 p5-backup 改名为 p8-final-backup，
          本脚本原先只认旧名 → seed 链路的「搬迁」步骤一直静默失败（数据没进统一表）。
          现在两个名字都认，优先新名。 */
  const backupCandidates = ['p8-final-backup', 'p5-backup'].map((d) =>
    path.join(process.cwd(), 'exports', d),
  );
  const backupDir = backupCandidates.find((d) => fs.existsSync(path.join(d, 'sms_common.sql')));
  if (!backupDir) {
    console.error(
      '✗ 未找到备份（exports/p8-final-backup 或 exports/p5-backup）—— 先跑 node scripts/_uni-p5-backup.mjs',
    );
    process.exit(1);
  }
  console.log(`备份目录：${path.relative(process.cwd(), backupDir)}\n`);

  const pairs = parseUniMap();
  const uniTables = [...new Set(pairs.map(([, u]) => u))];
  console.log(`映射 ${pairs.length} 条 / 目标表 ${uniTables.length} 张\n`);

  /* 0.5 ★ 破坏性预检（P8 后老表已 DROP，本脚本会 TRUNCATE 全部统一表）
         —— 必须在清空之前确认「源表都还在、且确实有数据可搬」，
            否则「先清空、再发现没数据」= 直接丢数据。
         预期用法：seed 链路「临时重建老表 → 灌数据 → 本脚本 → 清除老表」；
         手动跑若源表为空/缺失，一律中止；确实要清空请显式加 --force。 */
  const FORCE = process.argv.includes('--force');
  const sources = [...new Set(pairs.map(([o]) => o))];
  const missing = [];
  let totalRows = 0;
  for (const key of sources) {
    const [dbName, table] = key.split('.');
    try {
      const [[r]] = await dbJob.query(`select count(*) c from \`${dbName}\`.\`${table}\``);
      totalRows += Number(r.c);
    } catch (e) {
      missing.push(`${key}（${e.code || e.message}）`);
    }
  }
  if (missing.length) {
    console.error(
      `✗ 中止：${missing.length}/${sources.length} 张源表不存在，未做任何清空。\n` +
        missing.slice(0, 8).map((x) => `   · ${x}`).join('\n') +
        (missing.length > 8 ? `\n   …等 ${missing.length} 张` : '') +
        '\n  P8 之后老表已 DROP —— 若要重灌演示数据请跑 `node scripts/seed-all-demo.mjs`（它会临时重建老表）。',
    );
    process.exit(1);
  }
  if (totalRows === 0 && !FORCE) {
    console.error(
      `✗ 中止：${sources.length} 张源表全部为 0 行，而本脚本会先 TRUNCATE 全部统一表（当前 ${uniTables.length} 张）——` +
        '\n  继续执行只会把统一表清空。\n' +
        '  · 想灌演示数据：node scripts/seed-all-demo.mjs\n' +
        '  · 确认要在这个状态下强制执行：加 --force',
    );
    process.exit(1);
  }
  console.log(`源表预检通过：${sources.length} 张 / 共 ${totalRows} 行${FORCE ? '（--force）' : ''}\n`);


  /* 1.5 清理历轮自检套件的夹具残留（备份已做；「自检-」/「【冒烟】」开头的班/学生
         在老表无唯一约束下跨轮共存，合并进统一表会撞 uk_class —— 本就不该搬迁） */
  const FIXTURE_LIKE = ["'自检%'", "'【冒烟】%'"];
  const likeSql = (col) => `\`${col}\` like ${FIXTURE_LIKE.join(` or \`${col}\` like `)}`;
  const removedIds = { class: [], student: [], dorm: [] };
  for (const [dbName, table, col, kind] of [
    ['sms_class', 't_class_info', 'class_name', 'class'],
    ['sms_class_jh', 't_class_info', 'class_name', 'class'],
    ['sms_job', 't_job_class', 'class_name', 'class'],
    ['sms_class', 't_class_student', 'student_name', 'student'],
    ['sms_class_jh', 't_class_student', 'student_name', 'student'],
    ['sms_job', 't_student_base', 'student_name', 'student'],
    ['sms_class_jh', 't_student_base', 'student_name', 'student'],
    ['sms_job', 't_job_class_student', 'student_name', 'student'],
    ['sms_job', 't_job_dorm', 'dorm_no', 'dorm'],
  ]) {
    const db = await conn(dbName);
    const [rows] = await db.query(`select id from \`${table}\` where ${likeSql(col)}`);
    const ids = rows.map((x) => x.id);
    if (ids.length) {
      if (kind === 'class') removedIds.class.push(...ids);
      else if (kind === 'dorm') removedIds.dorm.push(...ids);
      else removedIds.student.push(...ids);
      await db.query(`delete from \`${table}\` where id in (${ids.map((x) => `'${x}'`).join(',')})`);
    }
    await db.end();
  }
  // 关联明细：任何源表只要有 class_id / student_id / student_no / student_name / class_name 列，
  // 引用了被删 id（或名字带夹具特征）的行一并删（避免统一表出现孤儿引用）
  let detRemoved = 0;
  for (const dbName of ['sms_class', 'sms_class_jh', 'sms_job']) {
    const db = await conn(dbName);
    const [tbls] = await db.query(
      "select table_name tn from information_schema.tables where table_schema=? and table_type='BASE TABLE' and table_name like 't\\_%'",
      [dbName],
    );
    for (const x of tbls) {
      const t = x.tn || x.TN || x;
      if (/knex|_sync$/.test(t)) continue;
      const [cols] = await db.query(
        'select column_name cn from information_schema.columns where table_schema=? and table_name=?',
        [dbName, t],
      );
      const colSet = new Set(cols.map((y) => y.cn || y.CN));
      const conds = [];
      const inOr = (arr) => arr.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
      if (colSet.has('class_id') && removedIds.class.length) conds.push(`class_id in (${inOr(removedIds.class)})`);
      if (colSet.has('student_id') && removedIds.student.length) conds.push(`student_id in (${inOr(removedIds.student)})`);
      if (colSet.has('dorm_id') && removedIds.dorm.length) conds.push(`dorm_id in (${inOr(removedIds.dorm)})`);
      if (colSet.has('room_id') && removedIds.dorm.length) conds.push(`room_id in (${inOr(removedIds.dorm)})`);
      if (colSet.has('dorm_no')) conds.push(likeSql('dorm_no'));
      if (colSet.has('student_name')) conds.push(likeSql('student_name'));
      if (colSet.has('class_name')) conds.push(likeSql('class_name'));
      // 主表自身不再重复删（已被 id 删除；此处条件按名字再兜一次也无害）
      if (!conds.length) continue;
      const [res] = await db.query(`delete from \`${t}\` where ${conds.join(' or ')}`);
      detRemoved += res.affectedRows;
    }
    await db.end();
  }
  console.log(
    `已清理夹具残留：班 ${removedIds.class.length} / 学生 ${removedIds.student.length} / 宿舍 ${removedIds.dorm.length} / 关联明细 ${detRemoved} 行\n`,
  );

  /* 1. TRUNCATE（幂等） */
  for (const t of uniTables) {
    await uniDb.raw(`TRUNCATE TABLE \`${t}\``);
  }
  console.log(`已清空 ${uniTables.length} 张统一表\n`);

  /* 2. fee_sync 学段推断用的班级 id 集 */
  const [clsClass] = await dbClass.query("select id from t_class_info where is_deleted=0");
  const [clsJob] = await dbJob.query("select id from t_job_class where is_deleted=0");
  const classIdsOfClass = new Set(clsClass.map((x) => x.id));
  const classIdsOfJob = new Set(clsJob.map((x) => x.id));

  /** 每源表的 edu_stage 决定器 */
  function stageOf(dbName, table, row) {
    if (dbName !== 'sms_common') return STAGE_OF_DB[dbName];
    if (table === 't_class_fee_sync') {
      if (classIdsOfClass.has(row.class_id)) return 'class';
      if (classIdsOfJob.has(row.class_id)) return 'job';
      throw new Error(`fee_sync 行 ${row.id} 的 class_id=${row.class_id} 无法推断学段`);
    }
    // t_class_dorm_room_sync / t_class_dorm_live_sync / t_class_urge_sync：
    // class 班主任域的同步落地表（消费方是班主任域；live_sync 学生即 class 域学生）
    return 'class';
  }

  /* 2.5 预载目标表数值列（类型口径清洗用：老表 bed_no 存 '1号床'，统一表是 int） */
  const numericCols = {}; // uniTable → Set(数值列名)
  for (const t of uniTables) {
    const [cols] = await uniDb.raw(
      "select column_name cn, data_type dt from information_schema.columns where table_schema='sms_common' and table_name=?",
      [t],
    );
    numericCols[t] = new Set(
      cols.filter((x) => /int|decimal|double|float/i.test(x.dt || x.DT)).map((x) => x.cn || x.CN),
    );
  }
  function coerceNumeric(uniTable, row) {
    const set = numericCols[uniTable];
    for (const k of Object.keys(row)) {
      // 数组/对象（老表 json 列被 mysql2 解析）→ 统一 stringify，否则 mysql2 拼 SQL 会错位
      if (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date)) {
        console.log(`  ⚠ ${uniTable}.${k} JSON 序列化: ${JSON.stringify(row[k]).slice(0, 80)}`);
        row[k] = JSON.stringify(row[k]);
        continue;
      }
      if (!set || !set.has(k)) continue;
      if (typeof row[k] === 'string' && row[k].trim() !== '') {
        const m = row[k].match(/^[-+]?\d+(\.\d+)?/);
        const v = m ? Number(m[0]) : null;
        console.log(`  ⚠ ${uniTable}.${k} 数值清洗: '${row[k]}' → ${v}`);
        row[k] = v;
      }
    }
  }

  /* 3. 搬运 */
  const reconcile = new Map(); // uniTable → { src: Map(源表→行数), uni: 行数 }
  let migrated = 0;
  for (const [oldKey, uniTable] of pairs) {
    if (SKIP.has(oldKey)) {
      console.log(`  ⊘ 跳过 ${oldKey}（edu_stage 不可推断，P6 拍板）`);
      continue;
    }
    const dbName = oldKey.split('.')[0];
    const table = oldKey.split('.')[1];
    const db = await conn(dbName);
    const [rows] = await db.query(`select * from \`${table}\``);
    let ok = 0;
    for (const row of rows) {
      const stage = stageOf(dbName, table, row);
      coerceNumeric(uniTable, row);
      // mirrorRow：shapeForUni + buildRow + insert；reg 传 noop（老表保留，无需清理登记）
      const r = await mirrorRow(uniDb, dbName, table, row, stage, () => {});
      if (r === null) throw new Error(`${oldKey} 镜像返回 null（UNI_MAP 不一致？）`);
      ok += 1;
      migrated += 1;
    }
    const rec = reconcile.get(uniTable) || { src: new Map(), uni: 0 };
    rec.src.set(oldKey, rows.length);
    reconcile.set(uniTable, rec);
    console.log(`  ✔ ${oldKey} → ${uniTable}: ${ok}/${rows.length} 行`);
  }

  /* 4. 对账 */
  console.log('\n===== 对账 =====');
  const lines = [
    '# P5 搬迁对账（' + new Date().toISOString() + '）\n',
    '| 统一表 | Σ老表行数 | 统一表行数 | 结果 |',
    '|---|---|---|---|',
  ];
  let bad = 0;
  for (const [uniTable, rec] of reconcile) {
    const srcTotal = [...rec.src.values()].reduce((a, b) => a + b, 0);
    const [[{ c }]] = await uniDb.raw(`select count(*) c from \`${uniTable}\``);
    const okFlag = Number(c) === srcTotal;
    if (!okFlag) bad += 1;
    lines.push(
      `| ${uniTable} | ${srcTotal} | ${c} | ${okFlag ? '✅' : '❌'} |`,
    );
    if (!okFlag) console.error(`  ❌ ${uniTable}: 老表合计 ${srcTotal} ≠ 统一表 ${c}`);
  }
  // 未出现在对账里的目标表（无源或全跳过）＝ 保持空表
  const emptyTargets = uniTables.filter((t) => !reconcile.has(t));
  lines.push('', `保持空表（无源/跳过）：${emptyTargets.join(', ') || '（无）'}`);
  lines.push('', `跳过清单：${[...SKIP].join(', ')}`);
  fs.writeFileSync(path.join(process.cwd(), 'exports', 'p5-reconcile.md'), lines.join('\n'), 'utf8');

  /* 5. fee_sync 学段分布抽查 */
  const [dist] = await uniDb.raw(
    "select edu_stage, count(*) c from t_uni_fee where source_system='finance' and source_id like 'FEE-%' group by edu_stage",
  );
  console.log('\nfee_sync 搬入后学段分布:', JSON.stringify(dist));

  console.log(`\n搬运 ${migrated} 行；对账 ${bad === 0 ? '✅ 全部一致' : `❌ ${bad} 张不一致`}`);
  console.log('对账报告 → exports/p5-reconcile.md');

  await uniDb.destroy();
  await dbClass.end();
  await dbJh.end();
  await dbJob.end();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('✗ 搬迁失败：', e?.message || e);
  process.exit(1);
});
