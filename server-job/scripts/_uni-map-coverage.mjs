/**
 * UNI_MAP 覆盖率核查（对照统一表设计字典）
 * ============================================================
 *
 * 用法：node scripts/_uni-map-coverage.mjs
 *
 * 【要解决什么问题】
 *   前三轮都靠「个案发现」补映射（T2 补 11 条、P3 补 5 条、P4 补 7 条），
 *   每次都以为补完了，下次又冒出新的 —— 因为**没有对照权威清单**。
 *   本脚本把权威清单从字典里抽出来，逐条核对 UNI_MAP：
 *
 *     字典 `docs/学管系统-统一表设计字典-第4期.md` 的表格形如：
 *       | `t_uni_exam` | 考试管理 | 初高.`t_class_exam` / 大学.`t_class_exam` / 实训.`t_job_exam` | ... |
 *     → 抽出「统一表 → 源表列表」，逐条查 UNI_MAP 里有没有 `'库.表'` 这个键。
 *
 * 输出：
 *   ① 每个统一表：声明的源表 / 已登记 / **未登记（漏映射）**
 *   ② 未被字典声明为源表、却在 UNI_MAP 里的（反向核对，防乱登记）
 *   ③ 结论数字
 *
 * ⚠️ 字典里的学段前缀是简称：初高=sm阶级s_class_jh / 大学=sms_class / 实训=sms_job / 教务=sms_edu
 *   另有 `t_class_*_sync` 归 `sms_common`（字典写作「教务同步」或直接写 sms_common）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DICT = 'docs/学管系统-统一表设计字典-第4期.md';
const UNI_TS = 'src/teaching/shared/uniTable.ts';

/** 学段简称 → 库名 */
const DB_OF = { 初高: 'sms_class_jh', 大学: 'sms_class', 实训: 'sms_job', 教务: 'sms_edu' };

const uniSrc = readFileSync(path.join(process.cwd(), UNI_TS), 'utf8');
const mapBody = uniSrc
  .match(/export const UNI_MAP: Record<string, string> = \{([\s\S]*?)\n\};/)[1]
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
const UNI = new Map([...mapBody.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));

const dict = readFileSync(path.join(process.cwd(), DICT), 'utf8');

/** 抽「统一表 → 声明的源表集合」 */
const declared = new Map();
for (const line of dict.split('\n')) {
  // 只认「表格行」：| `t_uni_x` | 域 | 来源... | 列数 | ... |
  const m = line.match(/^\|\s*★?\s*`(t_uni_[a-z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|/);
  if (!m) continue;
  const uni = m[1];
  const srcCell = m[3];
  const list = [];
  for (const seg of srcCell.split('/')) {
    // 形如： 初高.`t_class_exam`   或  `sms_common.t_class_fee_sync`   或 大学.`t_class_grade`
    const sm = seg.match(/([^\s`]+)?\s*\.?\s*`([a-z0-9_.]+)`/);
    if (!sm) continue;
    // ⚠️ 前缀组会把结尾的点一起吃进去（`初高.`），必须剥掉，否则 DB_OF 查不到 → 整表被静默跳过
    let prefix = (sm[1] || '').trim().replace(/[（）()]/g, '').replace(/\.+$/, '');
    let table = sm[2];
    if (table.includes('.')) {
      list.push(table); // 已带库名
      continue;
    }
    const db = DB_OF[prefix];
    if (!db) continue; // 认不出学段的跳过（如「外键」「—」）
    list.push(`${db}.${table}`);
  }
  if (list.length) declared.set(uni, [...new Set(list)]);
}

console.log('########## 逐统一表核对 ##########\n');
const missing = [];
let okCnt = 0;
for (const [uni, srcs] of [...declared.entries()].sort()) {
  const hit = srcs.filter((s) => UNI.get(s) === uni);
  const miss = srcs.filter((s) => UNI.get(s) !== uni);
  if (miss.length) missing.push({ uni, miss });
  else okCnt++;
  const flag = miss.length ? '⚠️ ' : '✔ ';
  console.log(`${flag}${uni}   声明 ${srcs.length} / 已登记 ${hit.length}`);
  if (miss.length) {
    for (const s of miss) {
      const other = UNI.get(s);
      console.log(`      ✘ ${s}${other ? `  （实际登记为 ${other}，指向了别的统一表！）` : '  （UNI_MAP 里没有）'}`);
    }
  }
}

console.log('\n########## 反向：UNI_MAP 里有、但字典没声明为该表源表 ##########\n');
let reverse = 0;
for (const [old, uni] of UNI) {
  const srcs = declared.get(uni) || [];
  if (!srcs.includes(old)) {
    console.log(`  ${old} → ${uni}（字典未声明${declared.has(uni) ? '，该统一表声明的是：' + srcs.join(', ') : '，该统一表不在字典表格里'}）`);
    reverse++;
  }
}
if (!reverse) console.log('  （无）');

console.log('\n===== 结论 =====');
console.log(`字典声明源表的统一表：${declared.size} 张（完全对齐 ${okCnt} 张）`);
console.log(`UNI_MAP 总条数：${UNI.size}`);
console.log(missing.length ? `⚠️ 仍有 ${missing.length} 张统一表存在漏映射：${missing.map((m) => m.uni).join(', ')}` : '✔ 无漏映射');
