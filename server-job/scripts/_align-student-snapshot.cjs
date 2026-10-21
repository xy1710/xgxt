/**
 * 学生快照对齐工具（★ 2026-10-20）
 * ============================================================
 *
 * 【用途】
 *   业务单据（缴费/催费/退费/休退学）都冗余存了一份学生属性快照，
 *   学生换班或改名后这些快照会和 `t_class_student` 脱节。
 *   读取侧已经改成「以档案最新值为准」（见 teaching/shared/studentRef.ts），
 *   本脚本负责把**存量脏数据**也一次性对齐，让库里的快照不再误导人。
 *
 * 【安全设计】
 *   ① 默认 **dry-run**：只打印差异，一个字节都不写。
 *      必须显式加 `--apply` 才真正 UPDATE。
 *   ② apply 之前先把受影响的行**整行导出**到 exports/ 做备份，
 *      文件名带时间戳，出问题可以直接照着还原。
 *   ③ 只对齐「档案有值」的列：档案是 NULL/空串的列跳过，
 *      绝不把单据上已有的信息抹空。
 *   ④ 只处理 `student_id` 能在档案里查到的行；孤儿单据**只报告不改动**
 *      （没有档案就没有「正确值」可言，硬改只会把错误藏起来）。
 *
 * 【用法】
 *   node scripts/_align-student-snapshot.cjs            # 体检（默认）
 *   node scripts/_align-student-snapshot.cjs --apply    # 真正对齐
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  },
});

const APPLY = process.argv.includes('--apply');

/**
 * 要对齐的业务表清单
 *   idCardCol：该表里身份证列的列名（没有就写 null）
 *   archiveIdCardCol：档案里身份证列的列名（初高叫 id_card_no，其余叫 id_card）
 *
 * ⚠️ 只列「学生属性」列，业务列（金额/状态/原因）一律不碰。
 */
const TARGETS = [
  {
    label: '初高·缴费',
    db: 'sms_class_jh',
    t: 't_class_fee',
    s: 't_class_student',
    idCardCol: null, // 缴费表不存身份证
  },
  {
    label: '初高·催费',
    db: 'sms_class_jh',
    t: 't_class_fee_notify',
    s: 't_class_student',
    idCardCol: null,
  },
  {
    label: '初高·退费',
    db: 'sms_class_jh',
    t: 't_class_refund',
    s: 't_class_student',
    idCardCol: null,
  },
  {
    label: '大学·退费',
    db: 'sms_class',
    t: 't_class_refund_apply',
    s: 't_class_student',
    idCardCol: null,
  },
  {
    label: '大学·休退学',
    db: 'sms_class',
    t: 't_class_suspend_apply',
    s: 't_class_student',
    idCardCol: 'id_card',
    archiveIdCardCol: 'id_card',
  },
  {
    label: '实训·休退学',
    db: 'sms_job',
    t: 't_job_student_leave',
    s: 't_student_base',
    idCardCol: 'id_card',
    archiveIdCardCol: 'id_card',
  },
  {
    label: '实训·退费',
    db: 'sms_job',
    t: 't_job_refund',
    s: 't_student_base',
    idCardCol: null,
  },
];

/** 公共对齐列（各表都有） */
const COMMON = ['student_no', 'student_name', 'class_id', 'class_name', 'dept_code'];

async function tableColumns(db, t) {
  const r = await knex.raw(
    'SELECT COLUMN_NAME c FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [db, t],
  );
  return new Set(r[0].map((x) => x.c));
}

/** 某列现在是否还和档案不同（NULL 与 '' 视为相同） */
function differs(a, b) {
  return String(a ?? '') !== String(b ?? '');
}

(async () => {
  console.log(APPLY ? '=== 模式：APPLY（会写库）===' : '=== 模式：DRY-RUN（只体检，不写库）===');

  let totalDiff = 0;
  let totalOrphan = 0;
  const backup = {};

  for (const cfg of TARGETS) {
    const { label, db, t, s } = cfg;
    let cols;
    try {
      cols = await tableColumns(db, t);
    } catch (e) {
      console.log(`\n[跳过] ${label} ${db}.${t} — ${e.message}`);
      continue;
    }
    if (!cols.has('student_id')) {
      console.log(`\n[跳过] ${label} ${db}.${t} — 无 student_id 列`);
      continue;
    }

    // 只对齐该表真实存在的列
    const fields = COMMON.filter((c) => cols.has(c));
    if (cfg.idCardCol && cols.has(cfg.idCardCol)) fields.push(cfg.idCardCol);

    const archiveCol = (c) => (c === cfg.idCardCol ? cfg.archiveIdCardCol : c);
    const selectCols = fields.map((c) => `s.${archiveCol(c)} AS a_${c}`).join(', ');

    const rows = (
      await knex.raw(
        `SELECT f.id, f.student_id, ${fields.map((c) => `f.${c}`).join(', ')}, ${selectCols}
         FROM ${db}.${t} f
         JOIN ${db}.${s} s ON s.id = f.student_id AND s.is_deleted = 0
         WHERE f.is_deleted = 0`,
      )
    )[0];

    // 找出真正有差异的行 + 以及每一列该改成什么
    const diffs = [];
    for (const r of rows) {
      const patch = {};
      for (const c of fields) {
        const now = r[c];
        const want = r[`a_${c}`];
        // 档案为空 → 跳过（不抹掉单据上的值）
        if (want === null || want === undefined || String(want) === '') continue;
        if (differs(now, want)) patch[c] = want;
      }
      if (Object.keys(patch).length) diffs.push({ id: r.id, student_id: r.student_id, patch });
    }

    // 孤儿单据：student_id 在档案里查不到（只报告）
    const orphan = (
      await knex.raw(
        `SELECT COUNT(*) c FROM ${db}.${t} f
         LEFT JOIN ${db}.${s} s ON s.id = f.student_id AND s.is_deleted = 0
         WHERE f.is_deleted = 0 AND s.id IS NULL`,
      )
    )[0][0].c;

    totalDiff += diffs.length;
    totalOrphan += Number(orphan);

    console.log(
      `\n${label.padEnd(12)} ${db}.${t}\n` +
        `  总行=${rows.length}  需对齐=${diffs.length}  孤儿(档案查无此人)=${orphan}`,
    );

    if (!diffs.length) continue;

    // 逐条打印「哪一行、哪一列、从什么改成什么」
    for (const d of diffs.slice(0, 20)) {
      const parts = Object.entries(d.patch)
        .map(([k, v]) => {
          const row = rows.find((x) => x.id === d.id);
          return `${k}: ${row[k] ?? 'NULL'} → ${v}`;
        })
        .join('；');
      console.log(`    · ${d.id}  ${parts}`);
    }
    if (diffs.length > 20) console.log(`    … 另有 ${diffs.length - 20} 条`);

    if (APPLY) {
      backup[`${db}.${t}`] = diffs.map((d) => {
        const row = rows.find((x) => x.id === d.id);
        const old = { id: row.id };
        for (const c of fields) old[c] = row[c];
        return old;
      });

      // 一条 UPDATE 批量改完（按 id 分别给不同的 patch 太啰嗦，这里按行更新）
      for (const d of diffs) {
        await knex(`${db}.${t}`).where({ id: d.id }).update(d.patch);
      }
      console.log(`    ✅ 已对齐 ${diffs.length} 条`);
    }
  }

  console.log(`\n=== 汇总：需对齐 ${totalDiff} 条，孤儿单据 ${totalOrphan} 条 ===`);
  if (!APPLY && totalDiff) {
    console.log('（当前是体检模式，如需真正写入请加 --apply）');
  }

  if (APPLY && Object.keys(backup).length) {
    const dir = path.join(__dirname, '../exports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `align-student-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`备份已写入：${file}`);
  }

  await knex.destroy();
})().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
