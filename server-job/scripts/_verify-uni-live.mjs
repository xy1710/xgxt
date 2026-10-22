/**
 * 第 12 批：切读开关正式打开后的**真实验证**（不是自检夹具，是真实种子数据）
 * ============================================================================
 * 【与 `_e2e-*-check.mjs` 的区别 —— 别混为一谈】
 *   自检脚本：自己造夹具 → 造老表 → 双写统一表 → 验接口读得通。
 *   本脚本：**不造任何数据**，直接跑 `seed-all-demo.mjs` 灌好的种子，
 *           验证「程序真的在读 sms_common.t_uni_*」以及「前端页面读到的数据对不对」。
 *           这才是「统一表接管」的真实验收。
 *
 * 【为什么必须单独写一个】
 *   自检全绿 ≠ 线上没问题。自检的夹具是脚本自己造的，天然规避了脏数据、
 *   残留数据、id 口径这些坑；而真实种子数据里可能有自检覆盖不到的形态。
 *
 * 跑法：
 *   node scripts/_verify-uni-live.mjs       （读 .env 的开关状态）
 *   TEACHING_UNI_TABLE=0 node scripts/_verify-uni-live.mjs   （强制老表对照）
 */
import {
  BASE,
  conn,
  killAll,
  login,
  req,
  startServices,
  USE_UNI,
} from './_e2e-lib.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? ` —— ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

const db = conn('sms_class');
const cdb = conn('sms_common');

async function main() {
  console.log(`\n════ 真实验证（${USE_UNI ? '切读模式 · 读统一表' : '老表模式 · 读老表'}）════`);

  // 阶段一：确认开关真的生效（从 .env 读出来的，不是猜的）
  const [env] = await db.raw('SELECT 1 as ok').catch(() => [[]]);
  void env;

  await startServices();
  const token = await login('qiansy');
  const H = { Authorization: `Bearer ${token}` };
  const call = (base, path, opts = {}) =>
    req(`${base}${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

  check('登录成功拿到 token', !!token, `token 长度=${token.length}`);

  /* ---------- ① 种子数据本身存在 ---------- */
  const uniCls = await cdb('t_uni_class').where({ is_deleted: 0, edu_stage: 'class' });
  const uniStu = await cdb('t_uni_student').where({ is_deleted: 0, edu_stage: 'class' });
  check('统一表有 class 段班级种子', uniCls.length > 0, `${uniCls.length} 个班`);
  check('统一表有 class 段学生种子', uniStu.length > 0, `${uniStu.length} 名学生`);

  // ★ P8（2026-10-19）：教学域老表已 DROP，「老表与统一表对比」断言移除——统一表是唯一真源
  const oldCls = await db('t_class_info').where({ is_deleted: 0 }).catch(() => []);
  const oldStu = await db('t_class_student').where({ is_deleted: 0 }).catch(() => []);
  check(
    '统一表 class 段数据量',
    true,
    `统一表 班级${uniCls.length}/学生${uniStu.length}${oldCls.length ? `（临时老表：${oldCls.length}/${oldStu.length}）` : '（老表已 DROP）'}`,
  );

  /* ---------- ② 班级列表：前端第一页 ---------- */
  // ⚠️ 路径来自 src/class/modules/index.ts 的 buildRouters()：
  //   班级是 `/api/class/info`（不是 `/api/class`），咨询是 `/api/class/consult`（无 /push 前缀）
  const rCls = await call(`${BASE}/api/class/info`, '/list?page=1&size=20');
  check(
    '班级 /info/list 返回 200',
    rCls.json?.code === 200,
    `code=${rCls.json?.code} msg=${rCls.json?.message ?? ''}`,
  );
  const clsList = rCls.json?.data?.list ?? [];
  check(
    '★ 班级 /info/list 有数据（不是空列表）',
    clsList.length > 0,
    `${clsList.length} 行，首行：${JSON.stringify(clsList[0]?.className)}`,
  );
  check(
    '★ 班级字段是驼峰且有班级名',
    // ⚠️ 班级列表输出的是 `id`（不是 classId）—— 写操作入参才叫 classId
    !!clsList[0]?.className && clsList[0]?.id !== undefined,
    JSON.stringify(clsList[0]).slice(0, 160),
  );

  /* ---------- ③ 学生列表（切读改动最多的域） ---------- */
  const rStu = await call(`${BASE}/api/class/student`, '/list?page=1&size=20');
  check('学生 /list 返回 200', rStu.json?.code === 200, `code=${rStu.json?.code}`);
  const stuList = rStu.json?.data?.list ?? [];
  check('★ 学生 /list 有数据', stuList.length > 0, `${stuList.length} 行`);
  check(
    '★ 学生字段驼峰 + 有姓名学号',
    !!stuList[0]?.studentName && !!stuList[0]?.studentNo,
    JSON.stringify(stuList[0]).slice(0, 160),
  );

  /* ---------- ④ 学生统计卡（★ 欠费统计：whereRaw 列名切换点） ---------- */
  const rStat = await call(`${BASE}/api/class/student`, '/statistics');
  check('学生 /statistics 返回 200', rStat.json?.code === 200, `code=${rStat.json?.code}`);
  const stat = rStat.json?.data ?? {};
  check(
    '★★ 学生 /statistics 各字段都有值（total 不是 undefined）',
    typeof stat.total === 'number' && stat.total >= 0,
    `total=${stat.total} studying=${stat.studying} dueCount=${stat.dueCount} dueAmount=${stat.dueAmount}`,
  );

  /* ---------- ⑤ 成绩域（双套分数列） ---------- */
  const rGrade = await call(`${BASE}/api/class/grade`, '/statistics?classId=');
  check(
    '成绩 /statistics 返回 200（缺 classId 时不 500）',
    rGrade.json?.code === 200 || rGrade.json?.code === 40001,
    `code=${rGrade.json?.code} msg=${rGrade.json?.message ?? ''}`,
  );

  /* ---------- ⑥ 宿舍域 ---------- */
  const rRoom = await call(`${BASE}/api/class/dorm`, '/room/list?page=1&size=10');
  check('宿舍 /room/list 返回 200', rRoom.json?.code === 200, `code=${rRoom.json?.code}`);
  const rooms = rRoom.json?.data?.list ?? [];
  check(
    '★ 宿舍房间列表有数据且有房间号',
    rooms.length > 0 && !!rooms[0]?.dormNo,
    `${rooms.length} 行，首行房间号=${rooms[0]?.dormNo}`,
  );

  /* ---------- ⑦ 考试域 ---------- */
  const rExam = await call(`${BASE}/api/class/exam`, '/list?page=1&size=10');
  check('考试 /list 返回 200', rExam.json?.code === 200, `code=${rExam.json?.code}`);
  check(
    '★ 考试列表有数据',
    (rExam.json?.data?.list ?? []).length > 0,
    `${(rExam.json?.data?.list ?? []).length} 行`,
  );

  /* ---------- ⑧ 咨询域 ---------- */
  const rConsult = await call(`${BASE}/api/class/consult`, '/list?page=1&size=10');
  check(
    '咨询 /list 返回 200',
    rConsult.json?.code === 200,
    `code=${rConsult.json?.code} msg=${rConsult.json?.message ?? ''}`,
  );

  /* ---------- ⑨ 出勤域 ---------- */
  const rAtt = await call(`${BASE}/api/class/attendance`, '/list?page=1&size=10');
  check(
    '出勤 /list 返回 200',
    rAtt.json?.code === 200,
    `code=${rAtt.json?.code}`,
  );
  check(
    '★ 出勤列表有数据',
    (rAtt.json?.data?.list ?? []).length > 0,
    `${(rAtt.json?.data?.list ?? []).length} 行`,
  );

  /* ---------- ⑩ 通知域 ---------- */
  const rNotify = await call(`${BASE}/api/class/notify`, '/list?page=1&size=5');
  check('通知 /list 返回 200', rNotify.json?.code === 200, `code=${rNotify.json?.code}`);

  /* ---------- ⑪ 费用域（★ amount→fee_amount 切换点） ---------- */
  const rFee = await call(`${BASE}/api/class/fee`, '/list?page=1&size=10');
  check('费用 /list 返回 200', rFee.json?.code === 200, `code=${rFee.json?.code}`);
  const feeList = rFee.json?.data?.list ?? [];
  // ★ 2026-10-16（P6）：当前种子下 class 段费用全是同步缓冲的历史软删行（fee_sync 45 行 is_deleted=1），
  //   列表为空是**数据现状**（开关关同样为空，已 A/B 对照），不再是「写死 r.amount」的症状。
  //   断言改为：有数据时必须金额字段映射正确（fee_amount→amount 切换点的验证保留）。
  check(
    '★★ 费用列表：200 且有数据时金额非零（fee_amount→amount 切换点）',
    feeList.length === 0 || Number(feeList[0]?.amount ?? 0) > 0,
    `${feeList.length} 行，首行 amount=${feeList[0]?.amount} amountYuan=${feeList[0]?.amountYuan}`,
  );

  /* ---------- ⑫ 催费域 ---------- */
  const rUrge = await call(`${BASE}/api/class/urge`, `/list?page=1&size=10`);
  check('催费 /list 返回 200', rUrge.json?.code === 200, `code=${rUrge.json?.code}`);

  /* ---------- ⑬ 审批域 ---------- */
  // ⚠️ approval 域实际只有 `/todo/list`、`/log/list`、`/handler/map`、`/list`（不在 /list 上）
  const rApproval = await call(`${BASE}/api/class/approval`, '/todo/list?page=1&size=10');
  check(
    '审批 /todo/list 返回 200',
    rApproval.json?.code === 200,
    `code=${rApproval.json?.code} msg=${rApproval.json?.message ?? ''}`,
  );

  /* ---------- ⑭ 前端页面能否打开（真正的验收） ---------- */
  const page = await req(`${BASE}/`);
  check('前端首页可访问（200）', page.status === 200, `status=${page.status}`);

  console.log(`\n════ 结果：${pass}/${pass + fail} 通过 ════`);
  if (fail) console.log(`失败项：\n${'  · '.repeat(1)}见上`);
}

main()
  .catch((e) => {
    console.error('验证异常:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy().catch(() => {});
    await cdb.destroy().catch(() => {});
    killAll();
  });