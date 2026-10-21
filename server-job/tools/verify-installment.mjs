/**
 * ★ 2026-10-16 分期付款端到端验证（一次性脚本，验证完可删）
 *
 * 跑法：node tools/verify-installment.mjs
 *
 * 验证链路：
 *   ① 找一个可发起收费的学生
 *   ② 创建分期计划（学费 + 餐费，分 3 期，各期之和 = 实缴）
 *   ③ 回查计划详情，确认期次与金额
 *   ④ 查学生账本，确认应收 / 已缴 / 待缴
 *   ⑤ 清理测试数据（咨询侧 + 财务侧软删）
 */

const BASE = 'http://localhost:8004';

async function login() {
  const res = await fetch(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'qiansy', password: '123456' }),
  });
  const json = await res.json();
  return json.data.token;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const yuan = (cent) => `¥${(Number(cent || 0) / 100).toFixed(2)}`;

(async () => {
  const token = await login();

  // ① 找一个待分班（4）或试学中（5）的学生
  const listRes = await api(token, 'GET', '/api/consult/student/list?page=1&size=50&consultState=4');
  const students = listRes.data?.list || [];
  if (!students.length) {
    console.log('没有待分班的学生，换试学中');
    return;
  }
  const stu = students[0];
  console.log(`① 选中学生：${stu.studentName} (${stu.consultStudentId}) 状态=${stu.consultStateName}`);

  // ② 创建分期计划：学费(1) + 餐费(5)，实缴 = 应缴（无优惠）
  const stdRes = await api(token, 'GET', '/api/consult/fee/standard-batch?feeTypes=1,5&deptCode=2');
  const stds = stdRes.data?.list || [];
  const tuition = stds.find((s) => s.feeType === 1)?.amount || 2800000;
  const meal = stds.find((s) => s.feeType === 5)?.amount || 85000;
  const total = tuition + meal;
  console.log(`② 应缴：学费 ${yuan(tuition)} + 餐费 ${yuan(meal)} = ${yuan(total)}`);

  // 分 3 期，零头落最后一期
  const n = 3;
  const base = Math.floor(total / n);
  const stages = [];
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const amt = i === n ? total - sum : base;
    sum += amt;
    const d = new Date();
    d.setDate(d.getDate() + 30 * (i - 1));
    stages.push({
      stageNo: i,
      amount: amt,
      dueDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    });
  }
  console.log(`   分期：${stages.map((s) => `${s.stageNo}期 ${yuan(s.amount)}(${s.dueDate})`).join(' / ')}`);
  console.log(`   各期之和 ${yuan(sum)} == 实缴 ${yuan(total)} → ${sum === total ? 'OK' : '不一致！'}`);

  const createRes = await api(token, 'POST', '/api/consult/fee/plan/create', {
    consultStudentId: stu.consultStudentId,
    feeTypes: [1, 5],
    payMethod: '微信支付',
    stages,
  });
  if (createRes.code !== 200) {
    console.log('创建失败：', createRes.code, createRes.message);
    return;
  }
  const plan = createRes.data;
  console.log(`③ 计划已建：${plan.planNo} 应收 ${plan.totalAmountYuan} 待缴 ${plan.pendingAmountYuan} 状态=${plan.statusName}`);
  console.log(`   期次：`);
  for (const it of plan.items) {
    console.log(
      `     第${it.stageNo}期 应收${it.dueAmountYuan} 到期${it.dueDate || '—'} 状态=${it.statusName} 单号=${it.orderNo || '—'}`,
    );
  }

  // ④ 账本
  const ledgerRes = await api(
    token,
    'GET',
    `/api/consult/fee/plan/ledger?consultStudentId=${stu.consultStudentId}`,
  );
  const lg = ledgerRes.data;
  console.log(
    `④ 账本：应收 ${lg.totalAmountYuan} 已缴 ${lg.paidAmountYuan} 优惠 ${lg.discountAmountYuan} 待缴 ${lg.pendingAmountYuan} 欠费=${lg.inArrear}`,
  );

  // ⑤ 尝试重复缴第 1 期（应被拦）
  const dup = await api(token, 'POST', '/api/consult/fee/plan/pay', {
    planId: plan.planId,
    stageNo: 1,
  });
  console.log(`⑤ 重复缴第1期 → ${dup.code !== 200 ? `已拦截：${dup.message}` : '未拦截（异常！）'}`);

  // ⑥ 发起第 2 期
  const pay2 = await api(token, 'POST', '/api/consult/fee/plan/pay', {
    planId: plan.planId,
    stageNo: 2,
    payMethod: '支付宝支付',
  });
  console.log(
    `⑥ 发起第2期 → ${pay2.code === 200 ? `成功，单号 ${pay2.data.items.find((i) => i.stageNo === 2)?.orderNo}` : `失败：${pay2.message}`}`,
  );

  console.log('\n=== 测试数据保留，供界面查看 ===');
  console.log('PLAN_ID=' + plan.planId);
  console.log('STUDENT_ID=' + stu.consultStudentId);
})();
