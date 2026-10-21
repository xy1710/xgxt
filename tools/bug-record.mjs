#!/usr/bin/env node
/**
 * 缺陷表写入工具 —— 幂等版
 *
 * 为什么需要它：手工 `lark-cli base +record-batch-create` 是**非幂等**操作。
 * 只要写入动作被跑两次（命令重复、payload 数组里写重、上一次超时后重试、
 * 或者「搜重」这一步本身失败被当成了「没有重复」），表里就会多出一条一模一样的记录。
 * 已经踩过两次：ad50165、0305797 各重复一条。
 *
 * 本工具把「查重 → 写入 → 写后复验 → 多余记录自动收敛」串成一步，
 * 同一个 hash 跑多少遍，表里都只有一条。
 *
 * 用法：
 *   node tools/bug-record.mjs check  <hash>                 查该 hash 现有几条（只读）
 *   node tools/bug-record.mjs upsert <hash> --payload f.json 幂等写入/更新（推荐）
 *   node tools/bug-record.mjs prune  <hash>                  收敛该 hash 的重复，保留最早一条
 *   node tools/bug-record.mjs audit                          全表查重（按 hash / 标题）
 *
 * payload 只需写业务字段（纯文本即可，脚本自动转单选数组）：
 *   {
 *     "BUG标题": "一句人话，说清哪里错了",
 *     "复现步骤": "现象 / 根因（不必写 hash，脚本会自动加【hash】前缀）",
 *     "预期结果": "修好后应该是什么行为",
 *     "严重等级": "P1严重",
 *     "BUG来源": "用户反馈",
 *     "开始时间": "2026-10-20 11:57"       // 可选，默认取 git 提交时间
 *   }
 *
 * 严重等级：P0阻断 / P1严重 / P2一般 / P3 轻微（注意 P3 中间有空格）
 * BUG来源：用户反馈 / 内部测试 / 改造过程中新发现 / 遗留程序改造
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE_TOKEN = 'KHPobyqjZaBiw5sri3XcHWORnub';
const TABLE_ID = 'tblsOphac4l6EM6E';
const PROJECT_RECORD_ID = 'recvxTFfo60NKZ'; // 所属项目 → 学管系统
const OWNER_OPEN_ID = 'ou_bc9379a083f52b683ad4101f805706dd'; // 负责人 → 孟令磊

const SEVERITY = ['P0阻断', 'P1严重', 'P2一般', 'P3 轻微'];
const SOURCE = ['用户反馈', '内部测试', '改造过程中新发现', '遗留程序改造'];
const HASH_RE = /^[0-9a-f]{7,40}$/;

const tmpRoot = mkdtempSync(join(tmpdir(), 'bug-record-'));
process.on('exit', () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ } });

let seq = 0;
function tmpFile(name, content) {
  const p = join(tmpRoot, `${seq++}-${name}`);
  writeFileSync(p, content, 'utf8');
  return p;
}

function lark(args) {
  const cmd = `lark-cli ${args}`;
  try {
    return JSON.parse(execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 }));
  } catch (err) {
    const out = String(err.stdout || '') + String(err.stderr || '');
    throw new Error(`lark-cli 执行失败：${cmd}\n${out.slice(0, 2000)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 查：服务端按 hash 过滤，再在本地做一次精确校验                        */
/* ------------------------------------------------------------------ */

/**
 * 只认「开头锚点」，不认正文引用。
 *
 * 复现步骤的约定格式是 `【hash】`（早期几条写成 `【git hash】`），开头那一个 hash
 * 才是这条记录归属的提交；正文里出现的其它 hash 属于交叉引用。
 * 例：c84819b 那条正文里提到了另一个提交，若用「全文包含」判断，
 * 就会把两个不同问题误判成重复，进而删错记录。
 */
function exactHit(steps, hash) {
  const s = String(steps || '').trimStart();
  return new RegExp(`^【(?:git\\s*)?${hash}】`).test(s);
}

/** 返回 [{ recordId, title, steps }]，只含真正带这个 hash 的记录 */
function findByHash(hash) {
  const filter = tmpFile('filter.json', JSON.stringify({
    logic: 'and',
    conditions: [['复现步骤', 'intersects', hash]],
  }));
  const res = lark(
    `base +record-list --base-token ${BASE_TOKEN} --table-id ${TABLE_ID} --as user` +
    ` --filter-json @${filter} --field-id 复现步骤 --field-id BUG标题 --limit 200 --format json`,
  );
  const d = res?.data ?? {};
  const cols = d.fields ?? [];
  if (d.has_more) {
    // 正常不会有：同一 hash 的记录不可能超过 200 条。真出现说明表被写脏了，直接报错让人看。
    throw new Error(`该 hash 命中记录超过 200 条，疑似表已被批量写脏（hash=${hash}），请人工检查`);
  }
  const idxSteps = cols.indexOf('复现步骤');
  const idxTitle = cols.indexOf('BUG标题');
  const rows = d.data ?? [];
  const ids = d.record_id_list ?? [];
  return rows
    .map((row, i) => ({
      recordId: ids[i],
      steps: idxSteps >= 0 ? row[idxSteps] : '',
      title: idxTitle >= 0 ? row[idxTitle] : '',
    }))
    .filter((r) => r.recordId && exactHit(r.steps, hash));
}

/* ------------------------------------------------------------------ */
/* 写                                                                */
/* ------------------------------------------------------------------ */

const cellText = (v) => (typeof v === 'string' ? v
  : Array.isArray(v) ? v.map((x) => x?.text ?? x?.name ?? '').join('') : v == null ? '' : String(v));

function gitInfo(hash) {
  try {
    // ⚠️ 必须用 execFileSync（数组传参、不经 cmd）。若用 execSync 拼字符串，
    // Windows 的 cmd 会把 `--format` 里的 `<%ae>` 里的 `<` 当成输入重定向，
    // git 直接报「系统找不到指定的文件」，而且这条记录会被静默当成「取不到提交信息」。
    const raw = execFileSync(
      'git',
      ['log', '-1', '--format=%h%n%an <%ae>%n%ad%n%s', '--date=format:%Y-%m-%d %H:%M', hash],
      { encoding: 'utf8' },
    ).trim().split('\n');
    return { hash: raw[0], author: raw[1], time: raw[2], subject: raw.slice(3).join('\n') };
  } catch {
    return null;
  }
}

function normalizePayload(hash, payload, defaultTime) {
  const missing = ['BUG标题', '复现步骤', '预期结果', '严重等级', 'BUG来源'].filter((k) => !cellText(payload[k]).trim());
  if (missing.length) throw new Error(`payload 缺少必填字段：${missing.join('、')}`);

  const severity = cellText(payload['严重等级']).trim();
  const source = cellText(payload['BUG来源']).trim();
  if (!SEVERITY.includes(severity)) throw new Error(`严重等级「${severity}」不是表里已有的选项，可选：${SEVERITY.join(' / ')}`);
  if (!SOURCE.includes(source)) throw new Error(`BUG来源「${source}」不是表里已有的选项，可选：${SOURCE.join(' / ')}`);

  let steps = cellText(payload['复现步骤']).trim();
  // 强制以【hash】开头：这是查重的锚点，缺了就没法去重
  if (!steps.startsWith(`【${hash}】`)) steps = `【${hash}】\n${steps}`;

  const time = cellText(payload['开始时间']).trim() || defaultTime;
  if (!time) throw new Error('缺少开始时间，且无法从 git 推断，请显式传 --time "YYYY-MM-DD HH:mm"');

  return {
    'BUG标题': cellText(payload['BUG标题']).trim(),
    '复现步骤': steps,
    '预期结果': cellText(payload['预期结果']).trim(),
    '严重等级': [severity],
    'BUG来源': [source],
    'BUG状态': ['待验证'],
    '实际结果': ['待验收'],
    '负责人': [{ id: OWNER_OPEN_ID }],
    '所属项目': [{ id: PROJECT_RECORD_ID }],
    '开始时间': time,
    '结束时间': time,
  };
}

function createOne(fields) {
  const p = tmpFile('create.json', JSON.stringify({ create_records: [fields] }));
  const res = lark(`base +record-batch-create --base-token ${BASE_TOKEN} --table-id ${TABLE_ID} --json @${p} --as user`);
  return (res?.data?.records ?? res?.data?.record_id_list ?? []).map((r) => r?.record_id ?? r).filter(Boolean);
}

/**
 * 更新一条记录。
 *
 * ⚠️ 批量改写的 payload 形态和批量新建**不一样**：新建是
 * `{create_records: [ {字段...}, ... ]}`（数组，记录本身即字段表），
 * 更新是 `{update_records: { "recXXX": {字段...} }}`（以 record_id 为键的**对象**）。
 * 写成数组会报 `800010701 invalid_request: Expected object, received array`。
 */
function updateOne(recordId, fields) {
  const f = { ...fields };
  delete f['开始时间']; // 更新时间不该被覆盖
  delete f['结束时间'];
  const p = tmpFile('update.json', JSON.stringify({ update_records: { [recordId]: f } }));
  lark(`base +record-batch-update --base-token ${BASE_TOKEN} --table-id ${TABLE_ID} --json @${p} --as user`);
}

/**
 * 写后真复验：按 record_id **直读记录本身**，确认字段真的落库了。
 *
 * 为什么非要做这一步（2026-10-20 踩坑）：
 *   查重用的 `findByHash` 走的是搜索索引，索引有延迟、也可能给出「幽灵命中」。
 *   出现过这样的连环坑：工具打印「更新成功」，check 也查得到标题，
 *   但把整表导出后那条记录其实是**全空**的 —— 只验索引等于没验。
 *   这里直接 +record-get 读那一条，标题对不上就报错，别让人以为写完了。
 */
function assertWritten(recordId, fields) {
  if (!recordId) return { ok: false, why: '没有拿到 record_id' };
  const res = lark(
    `base +record-get --base-token ${BASE_TOKEN} --table-id ${TABLE_ID}` +
    ` --record-id ${recordId} --field-id 复现步骤 --field-id BUG标题 --format json --as user`,
  );
  const d = res?.data ?? {};
  const cols = d.fields ?? [];
  const row = (d.data ?? [])[0] ?? [];
  const got = {
    title: cellText(row[cols.indexOf('BUG标题')]).trim(),
    steps: cellText(row[cols.indexOf('复现步骤')]).trim(),
  };
  const wantTitle = cellText(fields['BUG标题']).trim();
  if (!got.title) return { ok: false, why: `记录 ${recordId} 读回来是空的（写没落地）`, got };
  if (got.title !== wantTitle) return { ok: false, why: `标题对不上：表里是「${got.title}」`, got };
  if (!got.steps.startsWith(`【`)) return { ok: false, why: `复现步骤缺少 hash 锚点：${got.steps.slice(0, 40)}`, got };
  return { ok: true, got };
}

/** 同步等待（不 spawn 子进程；Windows 下拼 shell 命令容易因路径/引号失败） */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function deleteMany(recordIds) {
  if (!recordIds.length) return;
  const args = recordIds.map((id) => `--record-id ${id}`).join(' ');
  lark(`base +record-delete --base-token ${BASE_TOKEN} --table-id ${TABLE_ID} --as user ${args} --yes`);
}

/** 只保留一条，删掉多余的；返回保留下来的 recordId */
function converge(hash, hits, keepId, { dryRun = false } = {}) {
  const keep = keepId ?? hits[0].recordId;
  const extra = hits.filter((h) => h.recordId !== keep).map((h) => h.recordId);
  if (extra.length && !dryRun) deleteMany(extra);
  return { keep, removed: extra };
}

/**
 * 等服务端索引追平。
 *
 * 删除是立刻生效的，但 `record-list` 的过滤走的是搜索索引，实测删除后
 * 还要 1~3 秒才反映出来。如果删完立刻复查，会把「索引还没刷新」误判成
 * 「删失败了」，进而让人以为要手工删 —— 白折腾一轮。
 */
function waitFor(hash, expected, { tries = 8, delayMs = 1200 } = {}) {
  let hits = findByHash(hash);
  for (let i = 0; i < tries && hits.length !== expected; i++) {
    sleep(delayMs);
    hits = findByHash(hash);
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 全表审计                                                           */
/* ------------------------------------------------------------------ */

function audit() {
  const out = join(tmpRoot, 'audit.ndjson');
  lark(`base +record-list --base-token ${BASE_TOKEN} --table-id ${TABLE_ID} --as user --limit 2000 --format ndjson --output ${out}`);
  const recs = readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const F = (r) => r.fields ?? r;

  const byHash = new Map();
  const byTitle = new Map();
  for (const r of recs) {
    const steps = cellText(F(r)['复现步骤']);
    const title = cellText(F(r)['BUG标题']).trim();
    // 抽取开头锚点的 hash（不用全文匹配，避免把正文引用当成归属）
    const m = steps.trimStart().match(/^【(?:git\s*)?([0-9a-f]{7,40})】/);
    if (m) {
      const k = m[1]; // 只取 hash 本体（不含【】），否则提示出来的 prune 命令跑不通
      if (!byHash.has(k)) byHash.set(k, []);
      byHash.get(k).push({ recordId: r.record_id, title });
    }
    if (title) {
      if (!byTitle.has(title)) byTitle.set(title, []);
      byTitle.get(title).push({ recordId: r.record_id });
    }
  }

  const dupHash = [...byHash.entries()].filter(([, v]) => v.length > 1);
  const dupTitle = [...byTitle.entries()].filter(([, v]) => v.length > 1);

  console.log(`记录总数：${recs.length}`);
  if (!dupHash.length && !dupTitle.length) {
    console.log('体检结果：干净，没有重复记录。');
    return 0;
  }
  for (const [hash, list] of dupHash) {
    console.log(`\n★ 重复 hash ${hash}（${list.length} 条）`);
    list.forEach((x) => console.log(`   ${x.recordId}  ${x.title.slice(0, 48)}`));
    console.log(`   → 收敛：node tools/bug-record.mjs prune ${hash}`);
  }
  for (const [title, list] of dupTitle) {
    if (list.length < 2) continue;
    const alreadyReported = dupHash.some(([, v]) => v.filter((x) => list.some((y) => y.recordId === x.recordId)).length > 1);
    if (alreadyReported) continue;
    console.log(`\n★ 重复标题（hash 不同，可能是同一问题写了两次）`);
    console.log(`   标题：${title.slice(0, 60)}`);
    list.forEach((x) => console.log(`   ${x.recordId}`));
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* CLI                                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { opts[key] = next; i++; } else { opts[key] = true; }
    } else opts._.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  const rawHash = opts._[1];
  const hash = rawHash ? String(rawHash).trim() : '';

  if (cmd === 'audit') process.exit(audit());

  if (!['check', 'upsert', 'prune'].includes(cmd)) {
    console.error('用法：\n  node tools/bug-record.mjs check  <hash>\n  node tools/bug-record.mjs upsert <hash> --payload <file.json>\n  node tools/bug-record.mjs prune  <hash>\n  node tools/bug-record.mjs audit');
    process.exit(2);
  }
  if (!HASH_RE.test(hash)) {
    console.error(`hash 不合法：「${hash}」（应为 7~40 位十六进制，如 0305797）`);
    process.exit(2);
  }

  if (cmd === 'check') {
    const hits = findByHash(hash);
    console.log(`hash ${hash}：${hits.length} 条`);
    hits.forEach((h) => console.log(`  ${h.recordId}  ${h.title}`));
    process.exit(hits.length > 1 ? 1 : 0);
  }

  if (cmd === 'prune') {
    const hits = findByHash(hash);
    if (hits.length <= 1) {
      console.log(`hash ${hash}：${hits.length} 条，无需收敛。`);
      process.exit(0);
    }
    const { keep, removed } = converge(hash, hits);
    console.log(`保留 ${keep}，已删除 ${removed.length} 条重复：${removed.join(', ')}`);
    const after = waitFor(hash, 1);
    if (after.length !== 1) {
      console.error(`收敛后仍有 ${after.length} 条（已等待索引刷新），请人工检查：${after.map((x) => x.recordId).join(', ')}`);
      process.exit(1);
    }
    console.log(`复验：hash ${hash} 现在 1 条 ✓`);
    process.exit(0);
  }

  // upsert
  if (!opts.payload) {
    console.error('缺少 --payload <file.json>');
    process.exit(2);
  }
  const payloadPath = resolve(String(opts.payload));
  if (!existsSync(payloadPath)) {
    console.error(`payload 文件不存在：${payloadPath}`);
    process.exit(2);
  }
  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  const info = gitInfo(hash);
  if (info && !/menglinglei/.test(info.author)) {
    console.log(`作者 ${info.author} 不是 menglinglei，按约定跳过（不写缺陷表）。`);
    process.exit(0);
  }
  const fields = normalizePayload(hash, payload, opts.time ? String(opts.time) : info?.time);

  const before = findByHash(hash);
  let action;
  let keepId;
  if (before.length === 0) {
    const ids = createOne(fields);
    keepId = ids[0];
    action = '新增';
  } else {
    keepId = before[0].recordId;
    updateOne(keepId, fields);
    action = '更新';
  }

  // 写后复验：宁可这里报错，也不要留下看不见的重复
  // （要等索引刷新，否则「刚创建」会被误判成「写失败」）
  const after = waitFor(hash, 1);
  if (after.length === 0) {
    console.error(`✗ 写入后查不到记录（hash=${hash}），请检查表权限或字段名`);
    process.exit(1);
  }
  if (after.length > 1) {
    const { keep, removed } = converge(hash, after, keepId ?? after[0].recordId);
    keepId = keep;
    console.log(`⚠ 检测到重复写入，已自动收敛：保留 ${keep}，删除 ${removed.join(', ')}`);
  }
  const finalCheck = waitFor(hash, 1);
  console.log(`复验：hash ${hash} 共 ${finalCheck.length} 条`);

  // ★ 再直读一次记录本身：索引查得到 ≠ 字段真写进去了（见 assertWritten 注释）
  const verify = assertWritten(keepId ?? finalCheck[0]?.recordId, fields);
  if (!verify.ok) {
    console.error(`✗ 写后复验失败：${verify.why}`);
    console.error('  这条提交的缺陷记录**没有真正落库**，请按上面的原因处理后重跑（重跑是幂等的）。');
    process.exit(1);
  }

  console.log(`${action}成功：${keepId}`);
  console.log(`复验：字段已落库（标题「${verify.got.title.slice(0, 30)}…」）✓`);
  if (info) console.log(`对应提交：${info.hash} ${info.subject}（${info.author} · ${info.time}）`);
  process.exit(finalCheck.length === 1 ? 0 : 1);
}

main();
