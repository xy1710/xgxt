/**
 * 第 4 期 · 阶段 2 收口（#24 适配出勤套件时实锤）：**统一表「比老表更严」的 NOT NULL 全量放宽**
 * ============================================================
 *
 * 【★★ 结论先行】
 *   把 90 处「老表可空（IS_NULLABLE=YES）、统一表 NOT NULL」的列
 *   全量放宽为 **可空（保留原类型 / 默认值 / 字符集 / EXTRA）**。
 *
 * 【为什么必须放宽 —— 超集原则 + 已实锤故障】
 *   统一表是老表的超集：老表允许的写入，统一表没有理由拒绝。
 *   建表时（第 4 期）把这批列统一建成 NOT NULL DEFAULT ''，比老表口径**更严**。
 *
 *   ★ 实锤（2026-10-16，`_e2e-classjh-att-import-check` 开关开 1/8）：
 *     `t_uni_attendance_detail.absent_reason` 老表 nullable、统一表 NOT NULL DEFAULT ''，
 *     而出勤明细 upsert 的 **update 分支**（`attendance.route.ts:299` 的 `absent_reason: d.absentReason ?? null`）
 *     直接写 NULL → `Column 'absent_reason' cannot be null` → 二次导入 500。
 *     （insert 分支有 `tblInsTrx` 的「NOT NULL 收到 null 删键走 DEFAULT」保护，
 *       **update 分支没有任何保护** —— 修 90 处代码不现实，放宽列才是对的。）
 *
 * 【为什么全量 90 列而不是只改 absent_reason】
 *   判定 SQL（可随时复扫）：
 *     对 UNI_MAP 每对 (老表, 统一表)：老表列 IS_NULLABLE=YES 且统一表同名列 IS_NULLABLE=NO。
 *   这 90 处 = ~40 处 create_by/update_by（baseUpdate 未填时的潜在炸弹）
 *   + ~50 处真实业务列（student_no / fee_amount / content / transfer_reason / exam_result / building_id …）。
 *   不改的话，任何一条 update 路径写到其中一列的 NULL 都会 500（遍布各域，无法逐一枚举）。
 *   放宽**不会破坏任何现有成功路径**（约束只会变松），且与迁移 023（uni_relax_not_null）同方向。
 *
 * 【幂等】已是 NULL 的列跳过。
 * 【回滚】down 不恢复 NOT NULL（会把放宽当缺陷重新引入，回滚无意义），仅打印提示。
 */

const SCHEMA = () => 'sms_common';

/** 判定：老表（任一源）可空 & 统一表 NOT NULL 的列（与本文件头部的判定 SQL 同口径） */
async function targets(knex) {
  // UNI_MAP 从后端源文件解析（与 _e2e-lib 的 readBackendUniMap 同款正则）
  const { readFileSync } = require('fs');
  const path = require('path');
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'teaching', 'shared', 'uniTable.ts'),
    'utf8',
  );
  const body = src.slice(
    src.indexOf('export const UNI_MAP'),
    src.indexOf('};', src.indexOf('export const UNI_MAP')),
  );
  const pairs = [...body.matchAll(/'([a-z_]+\.t_[a-z_]+)'\s*:\s*'(t_uni_[a-z_]+)'/g)].map(
    (x) => [x[1], x[2]],
  );

  const [cols] = await knex.raw(
    `select table_schema ts, table_name tn, column_name cn, is_nullable nl
       from information_schema.columns
      where table_schema in ('sms_common','sms_class','sms_class_jh','sms_job','sms_consult')
        and table_name like 't\\_%'`,
  );
  const norm = cols.map((x) => ({
    ts: x.ts || x.TS,
    tn: x.tn || x.TN,
    cn: x.cn || x.CN,
    nl: x.nl || x.NL,
  }));
  const map = {};
  for (const x of norm) map[`${x.ts}.${x.tn}.${x.cn}`] = x.nl;

  const seen = new Set();
  const out = [];
  for (const [o, u] of pairs) {
    const [odb, otb] = o.split('.');
    for (const x of norm) {
      if (x.ts !== odb || x.tn !== otb) continue;
      if (map[`sms_common.${u}.${x.cn}`] === 'NO' && x.nl === 'YES' && !seen.has(`${u}.${x.cn}`)) {
        seen.add(`${u}.${x.cn}`);
        out.push({ table: u, column: x.cn });
      }
    }
  }
  return out;
}

/** 拼一条「保留原类型/默认值/字符集/EXTRA，只放宽 NULL」的 MODIFY 语句 */
async function modifySql(knex, table, column) {
  const [rows] = await knex.raw(
    `select COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, EXTRA, CHARACTER_SET_NAME, COLLATION_NAME
       from information_schema.columns
      where table_schema=? and table_name=? and column_name=?`,
    [SCHEMA(), table, column],
  );
  const r = rows[0] || rows; // 驱动可能给原始协议行
  const name = r.COLUMN_NAME || r.column_name;
  const type = r.COLUMN_TYPE || r.column_type;
  const def = r.COLUMN_DEFAULT !== undefined ? r.COLUMN_DEFAULT : (r.column_default ?? null);
  const extra = r.EXTRA || r.extra || '';
  const cs = r.CHARACTER_SET_NAME || r.character_set_name || null;
  const co = r.COLLATION_NAME || r.collation_name || null;

  let sql = `ALTER TABLE \`${table}\` MODIFY \`${name}\` ${type}`;
  if (cs && co) sql += ` CHARACTER SET ${cs} COLLATE ${co}`;
  sql += ' NULL';
  // 默认值：字符串带引号，其余原样（含 CURRENT_TIMESTAMP）；无默认则不写
  if (def !== null && def !== undefined) {
    const isStr = /char|text|enum|set/i.test(type) && !/^CURRENT_TIMESTAMP/i.test(String(def));
    sql += isStr ? ` DEFAULT '${String(def).replace(/'/g, "''")}'` : ` DEFAULT ${def}`;
  }
  if (extra) sql += ` ${extra}`;
  return sql;
}

const up = async function (knex) {
  const list = await targets(knex);
  if (!list.length) {
    console.log('  · 无「老表可空、统一表 NOT NULL」差集，已是目标状态，跳过');
    return;
  }
  console.log(`  · 待放宽 ${list.length} 列`);
  let done = 0;
  for (const { table, column } of list) {
    // 幂等：复查当前是否仍为 NOT NULL（可能已被更早的循环项顺带处理）
    const [cur] = await knex.raw(
      `select IS_NULLABLE as nl from information_schema.columns
        where table_schema=? and table_name=? and column_name=?`,
      [SCHEMA(), table, column],
    );
    const row = Array.isArray(cur) ? cur[0] : cur;
    const nl = row ? row.nl || row.NL : null;
    if (nl !== 'NO') continue;
    await knex.raw(await modifySql(knex, table, column));
    done += 1;
  }
  console.log(`  ✔ 已放宽 ${done} 列为可空`);

  // 复核：不允许再有差集
  const rest = await targets(knex);
  if (rest.length) {
    throw new Error(`放宽后仍剩 ${rest.length} 处差集（如 ${rest[0].table}.${rest[0].column}），已中止`);
  }
  console.log('  ✔ 自检通过：统一表与老表的可空性口径已一致');
};

const down = async function () {
  console.log('  · 放宽 NOT NULL 不回滚（回滚会重新引入「比老表更严」的缺陷）');
};

module.exports = { up, down };
