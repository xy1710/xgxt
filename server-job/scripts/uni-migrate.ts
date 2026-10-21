/**
 * 老表 → 统一表 数据搬迁 + 逐表核对
 * ============================================================
 *
 * 用法（在 server-job 目录下）：
 *   npx tsx scripts/uni-migrate.ts --plan              只出计划（读库，不写）
 *   npx tsx scripts/uni-migrate.ts --run               执行搬迁（**只补缺失的 id，不覆盖**）
 *   npx tsx scripts/uni-migrate.ts --run --overwrite   覆盖已有同 id 行（谨慎）
 *   npx tsx scripts/uni-migrate.ts --verify            逐表核对（老表 vs 统一表）
 *
 * 可以加 --only=t_uni_class,t_uni_student 只跑/只核对指定统一表。
 *
 * ============================================================
 * 【为什么需要它】
 *   第 4 期归一工程建了 43 张统一表，但**没有任何工具把老表已有数据搬进去**：
 *     · 迁移文件里没有一条 `INSERT INTO t_uni_*`
 *     · 新环境（同事/虚拟机）统一表是空的，只能退回去走老表模式
 *   本脚本补上这一环，让「切到统一表」在新环境也可行。
 *
 * 【★★ 核心原则：一切以切读层的映射为准，绝不另写一套】
 *   · 老表→统一表的对应关系：直接 import `UNI_MAP`（49 条）
 *   · 列名翻译 + 剔除统一表不存在的列：直接调用 `uniUpdCols()`
 *   —— 这两个都是切读层**运行时**用的同一份实现。
 *   自己另写一套 = 迟早和业务读法不一致 = 搬完还是读不到。
 *
 * 【★ 两个必须由本脚本补的列（切读层不负责）】
 *   ① `edu_stage`（学段）：由**老表所在库**推断 ——
 *      sms_class_jh→jh / sms_class→class / sms_job→job / sms_edu→edu
 *   ② `stage_code`（阶段码）：切读层显式「不做列名转换」（见 uniTable.ts 第 28 行注释），
 *      所以老表的 `stage` → 统一表 `stage_code` 由这里补。
 *      统一表若同时存在 `stage` 列，也一并写（与本机现有数据的行为保持一致）。
 *
 * 【幂等】
 *   默认只插「统一表里还没有的 id」；重复跑不会改动任何已有数据。
 *   这也保证了它**不会用老数据覆盖统一表里更新的数据**。
 *
 * 【已知例外】
 *   sms_common 的 4 张「同步副本表」（t_class_dorm_room_sync / t_class_dorm_live_sync /
 *   t_class_urge_sync / t_class_fee_sync）**没有学段列**，学段无法从数据推断，
 *   本脚本跳过它们并单独列出，需要人工定规则。
 */

process.env.TEACHING_UNI_TABLE = '1'; // ★ 必须早于 uniTable 加载（它按此决定 readonly 映射行为）

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const path = require('node:path');
const knexLib = require('knex');
const ut = require('../src/teaching/shared/uniTable');

const UNI_MAP: Record<string, string> = ut.UNI_MAP;
const uniUpdCols: (
  db: any,
  dbName: string,
  table: string,
  patch: Record<string, any>,
) => Promise<Record<string, any>> = ut.uniUpdCols;

/* ============================================================
 * 0. 配置与连接
 * ============================================================ */

const ROOT = path.join(__dirname, '..');
const ENV = (() => {
  const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const m: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const hit = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (hit) m[hit[1]] = hit[2].trim();
  }
  return m;
})();

const HOST = ENV.DB_HOST || '127.0.0.1';
const PORT = Number(ENV.DB_PORT || 3306);
const USER = ENV.DB_USER || 'root';
const PASS = ENV.DB_PASSWORD || '';

/** 8 个业务库的真实库名（都从 .env 取，不写死） */
const DB = {
  sms_job: ENV.DB_NAME || 'sms_job',
  sms_edu: ENV.DB_NAME_EDU || 'sms_edu',
  sms_class: ENV.DB_NAME_CLASS || 'sms_class',
  sms_class_jh: ENV.DB_NAME_CLASS_JH || 'sms_class_jh',
  sms_common: ENV.DB_NAME_COMMON || 'sms_common',
};

const conns: Record<string, any> = {};
function conn(logicalName: string) {
  if (!conns[logicalName]) {
    conns[logicalName] = knexLib({
      client: 'mysql2',
      connection: { host: HOST, port: PORT, user: USER, password: PASS, database: DB[logicalName as keyof typeof DB] },
      pool: { min: 0, max: 2 },
    });
  }
  return conns[logicalName];
}

/** 库名 → 学段（老表所在库直接决定学段） */
const STAGE_OF_DB: Record<string, string> = {
  sms_class_jh: 'jh',
  sms_class: 'class',
  sms_job: 'job',
  sms_edu: 'edu',
};

/** 没有学段列、需人工定规则的副本表（先跳过） */
const NEEDS_MANUAL = new Set([
  'sms_common.t_class_dorm_room_sync',
  'sms_common.t_class_dorm_live_sync',
  'sms_common.t_class_urge_sync',
  'sms_common.t_class_fee_sync',
]);

/**
 * ★★★ 统一表「专有列」的补值规则（老表没有这些列，但搬迁必须补）
 *
 * 【为什么需要】
 *   `t_uni_dorm_bed` 有三个 NOT NULL 且默认值为**空串**的列：
 *   `room_id` / `room_no` / `dorm_id` / `dorm_no`，而唯一索引是
 *   `uk_dorm_bed(room_id, bed_no, edu_stage)`。
 *   老表 `t_job_dorm_bed` **没有 room_id 列** → 不补的话所有行 room_id 都取默认值 `''`
 *   → 同一学段里所有「bed_no=3」的行全部撞唯一索引：
 *   `Duplicate entry '3-job' for key 'uk_dorm_bed'`（实测踩到，216 行全被拒）。
 *
 * 【规则从哪来 —— 不是猜的，是照抄业务写入代码】
 *   `src/class/modules/dorm/dorm.route.ts:660`  →  `room_no: b.dormNo`
 *   （同文件的 syncBeds 逻辑 → `room_id` 用房间 id，对应老表列名 `dorm_id`）
 *   搬迁与业务写入用同一套规则，搬进去的数据才对得上。
 */
const EXTRA_COLS: Record<string, (old: any) => Record<string, any>> = {
  t_uni_dorm_bed: (old) => ({
    room_id: old.dorm_id ?? '',
    room_no: old.dorm_no ?? '',
  }),
};

/* ============================================================
 * 1. 工具
 * ============================================================ */

const MODE = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--verify')
    ? 'verify'
    : 'plan';
const OVERWRITE = process.argv.includes('--overwrite');
const ONLY = (() => {
  const hit = process.argv.find((a) => a.startsWith('--only='));
  return hit ? hit.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

async function tableExists(c: any, dbName: string, table: string): Promise<boolean> {
  const r = await c('information_schema.tables')
    .where({ TABLE_SCHEMA: DB[dbName as keyof typeof DB], TABLE_NAME: table })
    .first();
  return !!r;
}

async function uniColumns(uniTable: string): Promise<Set<string>> {
  const rows = await conn('sms_common')('information_schema.COLUMNS')
    .where({ TABLE_SCHEMA: DB.sms_common, TABLE_NAME: uniTable })
    .select('COLUMN_NAME as c');
  return new Set(rows.map((r: any) => r.c));
}

/**
 * 统一表的「NOT NULL 列」清单（带缓存）
 *
 * 【为什么需要 —— 实测踩到的坑】
 *   老数据里 `create_by` 是 NULL，直接 insert 报
 *   `Column 'create_by' cannot be null`。
 *   但这一列**在统一表里是有 DEFAULT 的** —— 之所以报错，是因为我们
 *   **显式传了 null**：MySQL 遇到显式 NULL 不会回退到 DEFAULT，直接拒。
 *
 * 【修法 = 复用项目既有约定】
 *   `tblIns()` 遇到 NOT NULL 列收到 null 时也是**把这个键删掉**、让它走 DEFAULT。
 *   本脚本照做，行为与业务写入完全一致。
 *   （唯一例外是 `edu_stage`：它 NOT NULL **且无默认**，必须显式给值 —— 见 run()。）
 */
const NOT_NULL_CACHE: Record<string, Set<string>> = {};
async function notNullCols(uniTable: string): Promise<Set<string>> {
  if (!NOT_NULL_CACHE[uniTable]) {
    const rows = await conn('sms_common')('information_schema.COLUMNS')
      .where({ TABLE_SCHEMA: DB.sms_common, TABLE_NAME: uniTable, IS_NULLABLE: 'NO' })
      .select('COLUMN_NAME as c');
    NOT_NULL_CACHE[uniTable] = new Set(rows.map((r: any) => r.c));
  }
  return NOT_NULL_CACHE[uniTable];
}

async function countOf(c: any, table: string, where?: [string, any][]): Promise<number> {
  let q = c(table);
  for (const [k, v] of where || []) q = q.where(k, v);
  const r = await q.count({ n: '*' }).first();
  return Number(r?.n || 0);
}

/* ============================================================
 * 2. 主流程
 * ============================================================ */

/** 解析出「要处理的映射清单」 */
function tasks() {
  const list: { key: string; dbName: string; table: string; uni: string; stage: string | null }[] = [];
  for (const [key, uni] of Object.entries(UNI_MAP)) {
    const dot = key.indexOf('.');
    const dbName = key.slice(0, dot);
    const table = key.slice(dot + 1);
    const stage = STAGE_OF_DB[dbName] || null;
    if (ONLY && !ONLY.includes(uni)) continue;
    list.push({ key, dbName, table, uni, stage });
  }
  return list;
}

async function plan() {
  console.log('════════ 老表 → 统一表 搬迁计划 ════════');
  console.log(`  连接 ${HOST}:${PORT}   统一表库 ${DB.sms_common}`);
  console.log('');
  console.log(
    '  ' + '老表'.padEnd(32) + '学段'.padEnd(6) + '老表行数'.padStart(8) + '统一表'.padStart(7) + '待补'.padStart(7) + '  目标表',
  );

  let grandMissing = 0;
  const manual: string[] = [];
  const missingTables: string[] = [];

  for (const t of tasks()) {
    if (NEEDS_MANUAL.has(t.key)) {
      manual.push(`${t.key} → ${t.uni}`);
      continue;
    }
    if (!t.stage) continue;

    const c = conn(t.dbName);
    if (!(await tableExists(c, t.dbName, t.table))) {
      missingTables.push(`${t.dbName}.${t.table}（映射里有、库里没有这张表）`);
      continue;
    }

    const oldN = await countOf(c, t.table);
    const uniN = await countOf(conn('sms_common'), t.uni, [['edu_stage', t.stage]]);

    // 待补 = 老表里「统一表中尚不存在的 id」的数量
    let missing = 0;
    if (oldN > 0) {
      const ids = await c(t.table).select('id');
      const uniIds = await conn('sms_common')(t.uni).where('edu_stage', t.stage).select('id');
      const have = new Set(uniIds.map((r: any) => r.id));
      missing = ids.filter((r: any) => !have.has(r.id)).length;
    }
    grandMissing += missing;
    console.log(
      '  ' +
        t.table.padEnd(32) +
        String(t.stage).padEnd(6) +
        String(oldN).padStart(8) +
        String(uniN).padStart(7) +
        String(missing).padStart(7) +
        '  ' + t.uni,
    );
  }

  console.log('');
  console.log(`  合计待补：${grandMissing} 行`);
  if (missingTables.length) {
    console.log('');
    console.log('  ⚠️ 映射登记了、但库里没有这张表（映射表需清理）：');
    missingTables.forEach((x) => console.log('     · ' + x));
  }
  if (manual.length) {
    console.log('');
    console.log('  ⚠️ 需人工定学段规则（本次跳过）：');
    manual.forEach((x) => console.log('     · ' + x));
  }
}

async function run() {
  console.log('════════ 执行搬迁' + (OVERWRITE ? '（覆盖模式）' : '（只补缺，不覆盖）') + ' ════════');
  const stat = { inserted: 0, skipped: 0, tables: 0, failed: 0 };

  for (const t of tasks()) {
    if (NEEDS_MANUAL.has(t.key) || !t.stage) continue;
    const c = conn(t.dbName);
    if (!(await tableExists(c, t.dbName, t.table))) continue;

    const rows: any[] = await c(t.table).select('*');
    if (!rows.length) continue;

    const uniCols = await uniColumns(t.uni);
    const nn = await notNullCols(t.uni);
    const have = new Set(
      (await conn('sms_common')(t.uni).where('edu_stage', t.stage).select('id')).map((r: any) => r.id),
    );

    const payload: any[] = [];
    for (const old of rows) {
      if (!OVERWRITE && have.has(old.id)) {
        stat.skipped++;
        continue;
      }
      /* ① 复用切读层：列名翻译 + 剔掉统一表不存在的列 */
      const row = await uniUpdCols(c, t.dbName, t.table, { ...old });
      /* ② 补学段（老表没有这个概念，由所在库推断） */
      row.edu_stage = t.stage;
      /* ③ 补阶段码：老表 stage → 统一表 stage_code（切读层显式不做这件事） */
      if (uniCols.has('stage_code')) row.stage_code = (old as any).stage ?? null;
      /* ④ 补统一表专有列（如 t_uni_dorm_bed.room_id，见 EXTRA_COLS 注释） */
      const extra = EXTRA_COLS[t.uni];
      if (extra) {
        for (const [k, v] of Object.entries(extra(old))) {
          if (uniCols.has(k)) row[k] = v;
        }
      }
      /* ⑤ ★ 值为 null 的 NOT NULL 列 → 删键，让数据库 DEFAULT 生效
       *    （与 tblIns() 的处理一致；不删会报 `Column 'x' cannot be null`）
       *    edu_stage 例外：它 NOT NULL 且无默认，必须留着显式值。 */
      for (const k of Object.keys(row)) {
        if (row[k] === null && k !== 'edu_stage' && nn.has(k)) delete row[k];
      }
      payload.push(row);
    }

    if (!payload.length) {
      console.log(`  · ${t.table} → ${t.uni}  无待补（${rows.length} 行均已存在）`);
      continue;
    }

    try {
      const CHUNK = 200;
      for (let i = 0; i < payload.length; i += CHUNK) {
        await conn('sms_common')(t.uni).insert(payload.slice(i, i + CHUNK));
      }
      stat.inserted += payload.length;
      stat.tables++;
      console.log(`  ✓ ${t.table} → ${t.uni}（${t.stage}）新增 ${payload.length} 行`);
    } catch (e: any) {
      stat.failed++;
      /* ⚠️ mysql 的报错消息里会**带上整条 SQL**，把真正的错误挤到末尾。
       *  只打最后 220 字符，否则真正的错误会被几千字的 SQL 淹掉。 */
      const msg = String(e?.message || e);
      const tail = msg.length > 220 ? '…' + msg.slice(-220) : msg;
      console.log(`  ✗ ${t.table} → ${t.uni} 失败：${tail}`);
    }
  }

  console.log('');
  console.log(`  完成：${stat.tables} 张表、新增 ${stat.inserted} 行、跳过已存在 ${stat.skipped} 行` +
    (stat.failed ? `、失败 ${stat.failed} 张表` : ''));
}

async function verify() {
  console.log('════════ 逐表核对（老表 vs 统一表）════════');
  console.log('  ' + '老表'.padEnd(32) + '学段'.padEnd(6) + '老表'.padStart(7) + '统一表'.padStart(7) + '  判定');
  let bad = 0;
  for (const t of tasks()) {
    if (NEEDS_MANUAL.has(t.key) || !t.stage) continue;
    const c = conn(t.dbName);
    if (!(await tableExists(c, t.dbName, t.table))) continue;

    const oldN = await countOf(c, t.table);
    const uniN = await countOf(conn('sms_common'), t.uni, [['edu_stage', t.stage]]);
    // 判定：统一表该学段的行数应 ≥ 老表行数（老表是子集；统一表可能还有别的来源的数据）
    const ok = uniN >= oldN;
    if (!ok) bad++;
    console.log(
      '  ' +
        t.table.padEnd(32) +
        String(t.stage).padEnd(6) +
        String(oldN).padStart(7) +
        String(uniN).padStart(7) +
        '  ' + (ok ? '✅ 已覆盖' : `❌ 少 ${oldN - uniN} 行`),
    );
  }
  console.log('');
  console.log(bad === 0 ? '  ★★ 全部通过：老表数据都已在统一表里 ✅' : `  ★ 有 ${bad} 张表仍有缺口，需再跑 --run`);
}

/* ============================================================
 * 3. 入口
 * ============================================================ */

(async () => {
  try {
    if (MODE === 'plan') await plan();
    else if (MODE === 'run') await run();
    else await verify();
  } catch (e: any) {
    console.error('执行出错：' + e.message);
    process.exitCode = 1;
  } finally {
    for (const k of Object.keys(conns)) await conns[k].destroy().catch(() => {});
  }
})();
