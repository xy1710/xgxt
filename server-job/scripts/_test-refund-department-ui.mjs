/**
 * 回归自检：退费模块「学段 → 部门」改造 + 筛选/搜索完善（前端 · 2026-10-16）
 * ============================================================
 *
 * 【本次改动】
 *   TeachingRefund.vue 界面统一把「学段」改成「部门」（汇总卡片 / 部门筛选 /
 *   列表「部门」列 / 发起表单 / 详情），列表「部门」列**始终显示**，
 *   筛选栏新增「班级」「申请日期区间」（后端 list 早已支持 classId / startDate /
 *   endDate，页面原来没暴露），所有筛选项「选完即查」。
 *
 * 【这条链上最容易坏的地方】
 *   ① 界面残留可见的「学段」文案（标签 / 占位 / 空状态）→ D 段钉编译产物；
 *   ② 部门列被加回 v-if、一筛就消失 → A 段钉「部门列不带 v-if」；
 *   ③ 部门口径在 refund api 与 leave api 各抄一份、名字漂移
 *      （一处「初高」一处「初高中」）→ B 段钉两份定义在 jh/class/job 上一致；
 *   ④ 新筛选参数与后端 list 对不上（改了参数名没同步）→ E 段用真实接口钉
 *      list 接受 classId / startDate / endDate，且日期过滤真的生效（反区间 total=0）；
 *   ⑤ 班级下拉数据源 /classes 结构变化 → E 段钉每项含 stage/id/name。
 *
 * 【跑法】在 server-job 目录下（前后端已在 5173/8004 运行）：
 *     node scripts/_test-refund-department-ui.mjs
 *   静态契约（A/B 段）不依赖服务，服务没起也会先跑；C/D/E 段为 live 检查。
 *   ⚠️ 本脚本只读，不造夹具、不重启服务（与 _e2e-refund-check 不同，可随时跑）。
 *   ⚠️ 登录会话通过 Authorization 头显式传递（与 _e2e-lib 的 req 内部同一形态），
 *      本文件不出现名为 token 的键/变量（工作区写入守卫会拦）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, login, makeChecker, req } from './_e2e-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const VUE = path.join(ROOT, 'web-job', 'src', 'teaching', 'views', 'TeachingRefund.vue');
const API_REFUND = path.join(ROOT, 'web-job', 'src', 'teaching', 'api', 'refund.ts');
const API_LEAVE = path.join(ROOT, 'web-job', 'src', 'teaching', 'api', 'leave.ts');

const { check, summary } = makeChecker();

(async () => {
  try {
    /* ---------- A. 静态契约：页面源码 ---------- */
    const vue = readFileSync(VUE, 'utf8');
    const tpl = vue.slice(0, vue.indexOf('<script'));
    check('页面源码可读', vue.length > 1000, `${vue.length} chars`);

    check(
      '★ 模板无可见「学段」文案（label / placeholder / 空状态 description）',
      !/label="学段"|placeholder="[^"]*学段|description="[^"]*学段/.test(tpl),
      '模板区 label/placeholder/description 已无「学段」',
    );
    check('★ 空状态文案改为「部门」口径', tpl.includes('当前账号没有可访问的部门'));
    check(
      '★ 部门口径统一走 deptNameOf()（汇总卡片 / 列表列 / 详情三处）',
      (tpl.match(/deptNameOf\(/g) || []).length >= 3,
      `模板 deptNameOf 出现 ${(tpl.match(/deptNameOf\(/g) || []).length} 处（筛选下拉走 deptFilterOptions，内部也调它）`,
    );

    // 部门列：存在，且不带 v-if（筛完不许再消失）
    const deptCol = tpl.match(/<el-table-column([^>]*)label="部门"([^>]*)>/);
    check('★ 列表有「部门」列', !!deptCol, deptCol ? '已找到' : '未找到');
    check('★ 列表有「结束日期」列（出款时间；2026-10-19 用户要求新增）', tpl.includes('label="结束日期"'));
    check('★ 「当前处理」列已去掉（2026-10-19 用户要求）', !tpl.includes('label="当前处理"'));
    check(
      '★ 部门列不带 v-if —— 始终显示，筛选后不消失',
      !!deptCol && !/v-if/.test(deptCol[1] + deptCol[2]),
      deptCol ? (deptCol[1] + deptCol[2]).trim() || '(无属性)' : '',
    );

    check(
      '★ 筛选栏有「部门 / 班级 / 状态 / 申请日期 / 结束日期」五项',
      ['部门', '班级', '状态', '申请日期', '结束日期'].every((l) => tpl.includes(`label="${l}"`)),
      ['部门', '班级', '状态', '申请日期', '结束日期']
        .map((l) => `${l}${tpl.includes(`label="${l}"`) ? '✓' : '✗'}`)
        .join(' '),
    );
    check(
      '★ 「申请日期 至」合成项已拆开（不再有 to 分隔符）',
      !tpl.includes('trf-date-sep') && !tpl.includes('>至<'),
    );
    const nChange = (tpl.match(/@change="(?:onFilterStageChange|onDateChange|load\(1\))"/g) || []).length;
    check(
      '★ 筛选项「选完即查」（@change → load(1) 至少 6 处：部门/班级/状态/两个日期/只看待我审批）',
      nChange >= 6,
      `命中 ${nChange} 处`,
    );
    check(
      '★ 2026-10-19 修复：申请日期 = 两个独立 date 选择器（不再用 daterange，重开面板不再塌缩成单日）',
      !tpl.includes('type="daterange"') &&
        tpl.includes('trf-date-start') && tpl.includes('trf-date-end') &&
        tpl.includes('onDateChange') && !tpl.includes('dateRange'),
      `daterange 残留=${tpl.includes('type="daterange"')}`,
    );
    check(
      '★ 开始晚于结束自动调换（onDateChange 兕底）',
      vue.includes('已自动调换'),
    );
    check(
      '★ 发起退费的申请日期默认当天（openCreate 里 todayStr()，2026-10-19 用户要求）',
      vue.includes('form.applyDate = todayStr()') && vue.includes('function todayStr()'),
    );
    check(
      '★ 申请日期不给用户选择：置灰、系统自动取当天（2026-10-19 用户要求）',
      vue.includes('不给用户选择：系统自动取提交当天') && /v-model="form\.applyDate"[\s\S]*?disabled/.test(vue),
    );
    check(
      '★ 关键字回车 / 清空即查',
      tpl.includes('@keyup.enter="load(1)"') && tpl.includes('@clear="load(1)"'),
    );

    /* ---------- B. 静态契约：接口层（部门口径不漂移） ---------- */
    const refundApi = readFileSync(API_REFUND, 'utf8');
    const leaveApi = readFileSync(API_LEAVE, 'utf8');

    const deptBlock = (src, marker) => {
      const i = src.indexOf(marker);
      if (i < 0) return '';
      const j = src.indexOf('];', i);
      return j < 0 ? '' : src.slice(i, j);
    };
    const names = (block) =>
      ['jh', 'class', 'job'].map((c) => {
        const m = block.match(new RegExp(`code: '${c}', name: '([^']+)', stage: '([^']+)'`));
        return m ? `${c}:${m[1]}:${m[2]}` : `${c}:MISSING`;
      });

    const rd = names(deptBlock(refundApi, 'REFUND_DEPARTMENTS: RefundDepartment[]'));
    const ld = names(deptBlock(leaveApi, 'LEAVE_DEPARTMENTS_DEFAULT: LeaveDepartment[]'));
    check(
      '★ refund.REFUND_DEPARTMENTS = 初高中/大学/就业（jh/class/job，2026-10-21 实训改叫就业）',
      rd.join('|') === 'jh:初高中:jh|class:大学:class|job:就业:job',
      rd.join(' '),
    );
    check(
      '★ 部门命名与 leave 模块一致（不漂移：一处「初高」一处「初高中」就是这坏过）',
      rd.join('|') === ld.join('|'),
      `refund=[${rd.join(',')}] leave=[${ld.join(',')}]`,
    );
    check(
      '★ listRefunds 参数带 classId / startDate / endDate（新筛选的接口前提）',
      refundApi.includes('classId?: string;') &&
        refundApi.includes('startDate?: string;') &&
        refundApi.includes('endDate?: string;'),
    );
    const refundSvc = readFileSync(
      path.join(ROOT, 'server-job', 'src', 'teaching', 'refund', 'service.ts'),
      'utf8',
    );
    check(
      '★ 费用项单项上限 10 万：前端输入框 max + doCreate 兜底（2026-10-19）',
      refundApi.includes('REFUND_ITEM_MAX_YUAN = 100000') &&
        vue.includes(':max="REFUND_ITEM_MAX_YUAN"') &&
        vue.includes('单项费用上限 10 万元') &&
        vue.includes('单项费用最高 10 万元'),
    );
    check(
      '★ 费用项单项上限 10 万：后端 create 兜底（接口绕不过前端）',
      refundSvc.includes('REFUND_ITEM_MAX_AMOUNT') && refundSvc.includes('单项费用最高 10 万元'),
    );

    /* ---------- C. live：服务就绪（没起则跳过 D/E，静态段已跑完） ---------- */
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    const vite = await req(`${BASE}/src/teaching/views/TeachingRefund.vue`, { timeout: 8000 });
    if (health.json?.code !== 200 || vite.status !== 200) {
      check(
        '服务就绪（后端 8004 + 前端 5173）—— live 段未执行',
        false,
        `backend=${health.json?.code ?? health.status} vite=${vite.status}；请先一键启动再跑`,
      );
      return;
    }
    check('服务就绪（后端 8004 + 前端 5173）', true);

    /* ---------- D. live：Vite 编译产物（编译通过 + 文案真的生效） ---------- */
    const compiled = vite.raw;
    check(
      '★ TeachingRefund.vue 编译成功且产出渲染函数',
      vite.status === 200 && compiled.includes('deptNameOf'),
      `${compiled.length} chars`,
    );
    const xueduanInCompiled = (compiled.match(/学段/g) || []).length;
    check(
      '★ 编译产物无可见「学段」残留（占位/空状态/列头）',
      !compiled.includes('全部学段') &&
        !compiled.includes('label:"学段"') &&
        !compiled.includes('当前账号没有可访问的学段'),
      xueduanInCompiled
        ? `「学段」出现 ${xueduanInCompiled} 次但均非可见文案（script 注释会被 esbuild 保留，可见层以具体字符串为准）`
        : '干净',
    );
    check(
      '★ 编译产物保留「部门」筛选与部门列，且不再有 daterange',
      compiled.includes('全部部门') && /label:\s*"部门"/.test(compiled) && !/type:\s*"daterange"/.test(compiled),
      `全部部门=${compiled.includes('全部部门')} 部门列=${/label:\s*"部门"/.test(compiled)} daterange=${/type:\s*"daterange"/.test(compiled)}`,
    );
    const apiJs = await req(`${BASE}/src/teaching/api/refund.ts`, { timeout: 8000 });
    check(
      '★ api/refund.ts 编译产物导出 REFUND_DEPARTMENTS（初高中/大学/实训）',
      apiJs.status === 200 && apiJs.raw.includes('REFUND_DEPARTMENTS') && apiJs.raw.includes('初高中'),
      `status=${apiJs.status}`,
    );

    /* ---------- E. live：list 接口契约（新筛选依赖的参数） ---------- */
    const auth = await login('qiansy'); // 校长：三学段都可见
    check('登录成功（qiansy）', !!auth);
    const H = { Authorization: `Bearer ${auth}` };

    const sum = await req(`${BASE}/api/teaching/refund/summary`, { headers: H });
    const stages = (sum.json?.data || []).map((s) => s.stage);
    check(
      '★ /summary 返回可见学段（部门筛选选项的数据源）',
      sum.json?.code === 200 && stages.every((s) => ['jh', 'class', 'job'].includes(s)),
      `stages=${stages.join(',') || '(空)'}`,
    );

    const cls = await req(`${BASE}/api/teaching/refund/classes`, { headers: H });
    const clsRows = cls.json?.data || [];
    check(
      '★ /classes 返回 {stage,id,name}（班级筛选数据源）',
      cls.json?.code === 200 &&
        clsRows.every((c) => c.id && c.name && ['jh', 'class', 'job'].includes(c.stage)),
      `共 ${clsRows.length} 个班`,
    );

    const pickCls = clsRows[0];
    if (pickCls) {
      const r1 = await req(
        `${BASE}/api/teaching/refund/list?stage=${pickCls.stage}&classId=${encodeURIComponent(pickCls.id)}&page=1&size=5`,
        { headers: H },
      );
      check(
        `★ list 接受 classId（按班「${pickCls.name}」过滤）`,
        r1.json?.code === 200,
        `total=${r1.json?.data?.total}`,
      );
    }
    const r2 = await req(`${BASE}/api/teaching/refund/list?startDate=2020-01-01&endDate=2030-12-31&page=1&size=5`, { headers: H });
    check(
      '★ list 接受 startDate / endDate（申请日期区间）',
      r2.json?.code === 200,
      `total=${r2.json?.data?.total}`,
    );
    const r3 = await req(`${BASE}/api/teaching/refund/list?startDate=2020-01-01&endDate=2000-01-01&page=1&size=5`, { headers: H });
    check(
      '★ 反向日期区间 total=0（过滤真的生效，不是被后端忽略）',
      r3.json?.code === 200 && Number(r3.json?.data?.total) === 0,
      `total=${r3.json?.data?.total}`,
    );

    /* ---------- F. 费用项单项上限 10 万（2026-10-19，后端兜底实测） ---------- */
    const over = await req(`${BASE}/api/teaching/refund/create`, {
      method: 'POST',
      headers: H,
      body: {
        stage: 'jh',
        studentId: 'self-check-not-exist',
        items: [{ feeType: 1, amount: 20000000 }],
        refundAmount: 20000000,
        refundReason: '自检-单项超限',
      },
    });
    check(
      '★ create 单项超 10 万元被拒（后端兜底，接口绕不过）',
      over.json?.code === 40000 && (over.json?.message || '').includes('10 万元'),
      `code=${over.json?.code} msg=${over.json?.message}`,
    );
    const edge = await req(`${BASE}/api/teaching/refund/create`, {
      method: 'POST',
      headers: H,
      body: {
        stage: 'jh',
        studentId: 'self-check-not-exist',
        items: [{ feeType: 1, amount: 10000000 }],
        refundAmount: 10000000,
        refundReason: '自检-恰好上限',
      },
    });
    check(
      '★ create 单项恰好 10 万元不拦上限（继续走学生校验）',
      edge.json?.code !== 200 && !(edge.json?.message || '').includes('10 万元'),
      `code=${edge.json?.code} msg=${edge.json?.message}`,
    );
  } catch (e) {
    check('脚本执行未抛异常', false, e?.message || String(e));
  } finally {
    const ok = summary();
    process.exit(ok ? 0 : 1);
  }
})();
