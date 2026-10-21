/**
 * 回归检查：就业日志 / 复盘填写 两个页面「必须点查询按钮才查询」
 * ============================================================
 *
 * 【为什么用静态检查】
 *   这条规则是**交互约定**：筛选条件怎么改都不许触发请求，只有「查询」按钮可以。
 *   真跑 E2E 要起前后端 + 登录（tools/e2e-merged.mjs 那一套），为了两行模板属性不值当；
 *   而回归的方式又极其固定 —— 有人重新给下拉挂回 @change，就是这条规则被破坏了。
 *   所以这里直接读 .vue 源码做断言，秒级、零依赖。
 *
 * 【检查项】
 *   1. 两个页面里不存在 `@change="handleSearch"`（选完即查的老写法）
 *   2. 「班级」下拉（v-model="query.classId"）上没有 @change
 *   3. 页面里确实有「查询」按钮（@click="handleSearch"），别把入口也删了
 *   4. 筛选表单里除「查询 / 重置」外，输入框只允许 @keyup.enter 触发
 *
 * 用法（任意目录）：node tools/verify-manual-query.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web-job', 'src', 'views');

const TARGETS = [
  { file: 'EmploymentLog.vue', title: '就业日志' },
  { file: 'ReviewWrite.vue', title: '复盘填写' },
];

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' —— ' + detail : ''}`);
  if (!ok) failed++;
};

for (const t of TARGETS) {
  const full = path.join(WEB, t.file);
  if (!fs.existsSync(full)) {
    check(false, `${t.title}：文件存在`, full);
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');

  // 1. 全文不许有「选完即查」
  check(
    !/@change\s*=\s*"handleSearch"/.test(src),
    `${t.title}：不存在 @change="handleSearch"`,
    '筛选条件改动不应自动查询',
  );

  // 2. 班级下拉单独再确认一次（它是最容易被加回 @change 的地方）
  const classSelect = src.match(/<el-select[^>]*v-model="query\.classId"[\s\S]*?>/);
  check(!!classSelect, `${t.title}：找到「班级」下拉`);
  if (classSelect) {
    check(
      !/@change/.test(classSelect[0]),
      `${t.title}：「班级」下拉没有挂 @change`,
      classSelect[0].replace(/\s+/g, ' ').slice(0, 90),
    );
  }

  // 3. 「查询」按钮还在
  check(
    /<el-button[^>]*@click="handleSearch"[^>]*>\s*查询\s*<\/el-button>/.test(src),
    `${t.title}：「查询」按钮存在且绑定 handleSearch`,
  );

  // 4. 表单里的输入框不能挂 @input / @change（每敲一个字就查）
  const inputs = src.match(/<el-input[^>]*>/g) || [];
  const eager = inputs.filter((s) => /@(input|change)\s*=/.test(s));
  check(eager.length === 0, `${t.title}：输入框没有 @input / @change`, eager.join(' | ').slice(0, 120));
}

// 5. 反向兜底：这两个页面之外，允许别的页面继续用「选完即查」（不做全仓断言），
//    这里只提示一下当前全仓还有多少处，方便以后排查
const allViews = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.vue')) allViews.push(p);
  }
};
walk(path.join(ROOT, 'web-job', 'src'));
const stillEager = allViews.filter((p) => /@change\s*=\s*"(handleSearch|handleQuery|load\(1\))"/.test(fs.readFileSync(p, 'utf8')));
console.log(`INFO  全仓仍有「改条件即查询」的页面：${stillEager.length} 个${stillEager.length ? '\n      ' + stillEager.map((p) => path.relative(ROOT, p)).join('\n      ') : ''}`);

console.log(failed ? `\n✗ 失败 ${failed} 项` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
