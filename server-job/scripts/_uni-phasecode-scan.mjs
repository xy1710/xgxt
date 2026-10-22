/**
 * 「阶段码列名」漏网扫描（T5 / 任务 #23 的常驻索引）
 * ============================================================
 *
 * 用法：node scripts/_uni-phasecode-scan.mjs
 *
 * 【背景 · 为什么这是一个独立的缺陷类】
 *   老表 `stage`  = **学段内阶段码**（int，初高 101~107 / 大学 201~206 / 实训 301）
 *   老表 `stage`  ≠ 学段！学段在统一表叫 `edu_stage`（varchar jh/class/job）
 *
 *   第 3 期建统一表时把学段列也叫了 `stage`（varchar）→ 与老表撞名但语义相反。
 *   第 4 期迁移 022 把学段列改名 `edu_stage`，并把阶段码统一命名为 `stage_code`。
 *   于是统一表里 **`stage`（遗留列，语义未定义/同名不同义）** 与
 *   **`stage_code`（权威阶段码）** 并存 —— 见 023 迁移的 UNI_OWNED 与设计字典
 *   「★同名不同义（最危险）」表。
 *
 *   ⇒ 切读打开后，任何写死的 `where('stage', …)` / `payload.stage` / `row.stage`
 *     **要么静默查不到任何行、要么静默写进遗留列**，两种都不报错。
 *
 * 【既定约定（src/teaching/** 已全面落地，本脚本找出「漏网」）】
 *   · 过滤：`andWhere(phaseCodeCol(), v)`
 *   · 写入：`{ [phaseCodeCol()]: v }` / `.set(phaseCodeCol(), v)`
 *   · 读取：`readPhaseCode(row)`
 *   证据：src/teaching/{class,student}/repo.{class,classJh,job}.ts 共 18 处
 *         + src/class/modules/grade/grade.route.ts:584（已迁移的示范点）
 *
 * 【扫描范围】
 *   `src/**` 排除 `src/teaching/**`（该目录已收口）。
 *   逐行匹配「列名字面量恰为 stage」的三类形态。
 *
 * 【⚠️ 能力边界（必须人工复核，脚本只减负）】
 *   · 只认**字面量** 'stage'；`[col]` 变量形式需人工判断
 *   · 不判断该行所在的 runner 是否真的走了 tbl() 切读（未切读的老表读写无害）
 *   · 不区分「阶段码」与「恰好也叫 stage 的别的语义」（如实训路由那个 1..3 的历史写法）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'src');
const SKIP_DIRS = [path.join(ROOT, 'teaching')];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP_DIRS.some((d) => full.startsWith(d))) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/* ---------- 三类形态 ---------- */
/** ① 过滤：.where('stage' / .andWhere("stage" / .orWhere / .whereIn / .whereNot */
const RE_FILTER = /\.(where|andWhere|orWhere|whereIn|whereNot|whereNotIn)\(\s*['"`]stage['"`]/;
/** ② 对象条件 / 写入 payload：{ stage: X }（排除 stage_code / edu_stage / to_stage / from_stage …） */
const RE_OBJ = /(^|[^A-Za-z0-9_])stage\s*:/;
/** ③ 读投影 / 取值：X.stage（排除 .stage_code） */
const RE_READ = /\.stage(?!_)\b/;
/** ④ .set('stage', X) */
const RE_SET = /\.set\(\s*['"`]stage['"`]/;

/** 已知「不是阶段码列」的白名单（人工核实过 —— 加进来前必须写明理由） */
const EXPECTED = [
  {
    re: /^src\/routes\/eduStudent\.route\.ts:254$/,
    why: 'applyListFilters 的 stage 分支只在教务侧生效（db(TABLE) 裸访问 sms_edu.t_student_base，教务域未归一）；' +
      '实训/大学部两个调用点均传 skipStage:true，stage 分支永远不会作用于切读表 → 保持原样是正确的',
  },
  {
    re: /^src\/routes\/eduStudentImport\.route\.ts:\d+$/,
    why: '教务域导入（sms_edu 未归一，保持裸访问）→ 列名 stage 就是老表自己的列，无需切换',
  },
];

/** 噪音过滤：zod 请求字段 / TS 类型声明 / 局部参数名 —— 不是「数据库列」引用 */
function isNoise(cp) {
  if (/\bz\./.test(cp)) return true; // zod 校验定义
  if (/stage\s*:\s*(number|string|boolean|TeachingStage)\b/.test(cp)) return true; // 形参/返回类型
  if (/\bfunction\s+\w*[Ss]tage/.test(cp)) return true; // 函数签名
  if (/^stage\s*:\s*'stage'/.test(cp.trim())) return true; // { stage: 'stage' } 字段映射表
  return false;
}

const hits = { filter: [], obj: [], read: [], set: [] };
const files = walk(ROOT);

for (const f of files) {
  const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
  const text = readFileSync(f, 'utf8');
  // ★ 块注释用「等量换行」替换，**保持行号对齐**（直接删掉会让 rawLines[i] 错位）
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  const lines = stripped.split('\n');
  const rawLines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = rawLines[i] ?? '';
    // 整行注释 / JSDoc 续行 → 跳过；只对代码部分匹配（保留行尾注释无妨）
    const trimmed = raw.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    const codePart = raw.replace(/\/\/.*$/, '');
    if (!codePart.trim()) continue;
    const at = `${rel}:${i + 1}`;
    const snippet = raw.trim().slice(0, 150);
    if (isNoise(codePart)) continue;

    if (RE_FILTER.test(codePart)) hits.filter.push({ at, snippet });
    if (RE_SET.test(codePart)) hits.set.push({ at, snippet });
    if (RE_OBJ.test(codePart)) hits.obj.push({ at, snippet });
    else if (RE_READ.test(codePart)) hits.read.push({ at, snippet });
  }
}

const isExpected = (at) => EXPECTED.find((e) => e.re.test(at));
const partition = (arr) => {
  const real = [];
  const exp = [];
  for (const h of arr) (isExpected(h.at) ? exp : real).push(h);
  return { real, exp };
};

const SECTIONS = [
  ['① 过滤条件写死 stage（若「stage 已废弃」则静默查不到任何行）', hits.filter, 'HIGH'],
  ["② .set('stage', …) 写路径", hits.set, 'HIGH'],
  ['③ 对象 payload / 对象条件里的 stage 键（写入或 where 对象）', hits.obj, 'MIX'],
  ['④ 读投影 / 取值 X.stage', hits.read, 'MIX'],
];

console.log('===== 阶段码列名（老表 stage ↔ 统一表 stage_code）漏网扫描 =====\n');
console.log(`扫描范围：src/** 排除 src/teaching/**（${files.length} 个 .ts）\n`);
console.log('⚠️ 分级说明：HIGH = 一定是列名字面量（无歧义）；');
console.log('   MIX  = 混了业务逻辑取值（如 STAGE_NAME[row.stage]、canRepeatByStage(stu.stage)），');
console.log('          需人工按「该行的行对象是否来自切读查询」再分级。\n');
console.log('✅ #23 已拍板（2026-10-16）：方案 B —— 废弃统一表 stage 列，阶段码一律 stage_code；');
console.log('   代码侧统一走 phaseCodeCol()（过滤/写入）与 readPhaseCode()（读行）。');
console.log('   本清单剩余 HIGH 项 = 仍需收口的真 DB 列引用；白名单 = 已核实无需改。\n');

let totalReal = 0;
let totalExp = 0;
for (const [title, arr, level] of SECTIONS) {
  const { real, exp } = partition(arr);
  totalReal += real.length;
  totalExp += exp.length;
  console.log(`########## ${title}  [${level}] ##########`);
  if (!real.length) console.log('  （无）');
  for (const h of real) console.log(`  ${h.at}\n      ${h.snippet}`);
  if (exp.length) {
    console.log(`  —— 白名单（已核实，非切读缺陷）：${exp.length} 处`);
    for (const h of exp) console.log(`     ${h.at}`);
  }
  console.log('');
}

console.log('===== 结论 =====');
console.log(`待收口 ${totalReal} 处（+ 白名单 ${totalExp} 处）`);
console.log('');
console.log('修法（与 src/teaching/** 既定约定一致，开关关时逐字节等价）：');
console.log("  · 过滤：query.andWhere(phaseCodeCol(), v)");
console.log('  · 写入：{ [phaseCodeCol()]: v }  或  .set(phaseCodeCol(), v)');
console.log('  · 读取：stage: readPhaseCode(row)');
console.log("  三者都由 src/teaching/shared/uniTable.ts 导出。");
console.log('');
console.log('白名单理由：');
for (const e of EXPECTED) console.log(`  · ${e.re.source}\n      ${e.why}`);

process.exit(0);
