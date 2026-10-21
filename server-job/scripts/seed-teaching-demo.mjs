/**
 * ★ 教学管理演示数据补齐脚本 ★
 * ============================================================
 * 用法：
 *   node scripts/seed-teaching-demo.mjs           # 补齐（幂等：已有的不重复造）
 *   node scripts/seed-teaching-demo.mjs --dry     # 只看计划，不写
 *
 * 【前置】后端要在 8004 跑着 —— 本脚本**走真实接口**（登录校长 → 各域 create/save），
 *   不直接写库。这样造出来的数据必然符合接口校验与业务流程，
 *   不会出现「库里看着对、页面查不出来」的情况。
 *
 * 【它和 seed-all-demo.mjs 的分工】
 *   seed-all-demo.mjs   ：全系统重建（清库重造，咨询/财务/班级/教务/实训一起）；
 *   本脚本              ：**只补教学管理**，在已有数据上做加法，专治「打开页面是空的」：
 *     · 出勤管理 —— 每个班补最近 6 个工作日（大学手填应到/实到，初高·实训按学生点名）
 *     · 考试管理 —— 每个班补「技术考试 / 质素考核」各一场
 *     · 成绩管理 —— 上面新造的考试按各学段公式录入成绩（有成绩的不覆盖）
 *     · 退费     —— 每学段 2 单：1 单待审批 + 1 单已审批已出款
 *     · 休学/退学 —— 每学段 2 单：1 单待审批（休学）+ 1 单已通过（退学）
 *     · 宿舍管理 —— 初高补一条调宿申请
 *
 * ⚠️ 幂等策略：按「该学段/该班已有多少条」判断，缺哪补哪；重复跑不会翻倍。
 */

const BASE = process.env.SEED_BASE || 'http://127.0.0.1:8004';
const ACCOUNT = process.env.SEED_ACCOUNT || 'qiansy';
const PASSWORD = process.env.SEED_PASSWORD || '123456';
const DRY = process.argv.includes('--dry');

const STAGE_LABEL = { jh: '初高部', class: '大学部', job: '实训' };
const STAGES = ['class', 'jh', 'job'];

let token = '';
const TOKENS = {};
const stat = [];
const say = (m) => { stat.push(m); console.log(m); };

/* ---------------- 接口小工具 ---------------- */

async function rawLogin(account, password) {
  const res = await fetch(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 200) throw new Error(`登录 ${account} 失败：${json?.message ?? res.status}`);
  return json.data;
}

/** 切换成某个账号（审批链每一步的角色不同，必须换人操作） */
async function loginAs(account) {
  if (!TOKENS[account]) {
    const d = await rawLogin(account, PASSWORD);
    TOKENS[account] = d.token;
  }
  token = TOKENS[account];
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 200) {
    throw new Error(`${method} ${url} → ${json?.code ?? res.status} ${json?.message ?? ''}`);
  }
  return json.data;
}

const tryApi = async (method, url, body) => {
  try { return { ok: true, data: await api(method, url, body) }; }
  catch (e) { return { ok: false, err: e.message }; }
};

/* ---------------- 日期工具 ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 最近 n 个工作日（周一到周五），从今天往前数 */
function lastWorkdays(n) {
  const out = [];
  const d = new Date();
  while (out.length < n) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) out.push(ymd(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}
/** 稳定伪随机（同一 seed 结果一致，便于复跑对照） */
let seedN = 20261016;
function rnd() { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; }
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/* ---------------- 业务 ---------------- */

async function classesOf(stage) {
  const d = await api('GET', `/api/teaching/class/list?stage=${stage}&page=1&size=50`);
  return d.list || [];
}
async function studentsOfClass(stage, classId) {
  const d = await api('GET', `/api/teaching/student/list?stage=${stage}&classId=${classId}&page=1&size=200`);
  return d.list || [];
}

/* ---- 1. 出勤 ---- */

const ATT_OK = 1;      // 出勤
const ATT_LATE = 3;    // 迟到
const ATT_LEAVE = 5;   // 请假

async function seedAttendance(stage, cls, students) {
  const dates = lastWorkdays(6);
  const had = (await api('GET', `/api/teaching/attendance/list?stage=${stage}&classId=${cls.classId}&page=1&size=100`)).list || [];
  const hadDates = new Set(had.map((r) => r.attendanceDate));
  // ⚠️ 后端只认「应到名单」里的学生：初高是在读（3 试学中 / 4 预在读 / 5 正式在读），
  //    休学、退学的学生传了会整单被拒（「以下学生不在该班应到名单中」）
  const roster = stage === 'jh' ? students.filter((s) => [3, 4, 5].includes(s.studentStatus)) : students;
  let n = 0;
  for (const date of dates) {
    if (hadDates.has(date)) continue;
    if (DRY) { n++; continue; }
    let body;
    if (stage === 'class') {
      // 大学：老师手工填应到 / 实到
      body = { stage, classId: cls.classId, attendanceDate: date, shouldCount: students.length, actualCount: Math.max(students.length - int(0, 2), 0) };
    } else {
      // 初高 / 实训：按学生点名（1 出勤 / 3 迟到 / 5 请假）
      const rows = roster.map((s) => {
        const r = rnd();
        const status = r > 0.94 ? ATT_LEAVE : r > 0.88 ? ATT_LATE : ATT_OK;
        return { studentId: s.studentId, status, reason: status === ATT_LEAVE ? '病假' : null };
      });
      if (!rows.length) continue;
      body = { stage, classId: cls.classId, attendanceDate: date, rows };
    }
    const r = await tryApi('POST', '/api/teaching/attendance/save', body);
    if (r.ok) n++; else say(`    ⚠️ 出勤 ${cls.className} ${date} 跳过：${r.err}`);
  }
  return n;
}

/* ---- 2. 考试 ---- */

const EXAM_PLAN = [
  { examName: '2026 秋季 · 技术考试（月测）', examType: 1, offDays: 12 },
  { examName: '2026 秋季 · 质素考核', examType: 2, offDays: 5 },
];

async function seedExams(stage, cls) {
  const had = (await api('GET', `/api/teaching/exam/list?stage=${stage}&page=1&size=100&classId=${cls.classId}`)).list || [];
  const names = new Set(had.map((e) => e.examName));
  const out = [];
  for (const p of EXAM_PLAN) {
    const examName = `${cls.className} · ${p.examName}`;
    if (names.has(examName)) continue;
    if (DRY) { out.push({ examName, id: null }); continue; }
    const r = await tryApi('POST', '/api/teaching/exam/save', {
      stage,
      examName,
      examType: p.examType,
      examDate: daysAgo(p.offDays),
      classIds: [cls.classId],
      remark: null,
    });
    if (r.ok) out.push({ examName, examId: r.data?.examId ?? r.data?.id ?? null });
    else say(`    ⚠️ 考试 ${examName} 跳过：${r.err}`);
  }
  return out;
}

/* ---- 3. 成绩 ---- */

async function seedScores(stage, classId) {
  const exams = (await api('GET', `/api/teaching/exam/list?stage=${stage}&page=1&size=100&classId=${classId}`)).list || [];
  let filled = 0;
  for (const ex of exams) {
    const entry = await api('GET', `/api/teaching/score/entry?stage=${stage}&examId=${ex.id}&classId=${classId}`);
    const rows = (entry.rows || []).filter((r) => r.totalScore === null || r.totalScore === undefined);
    if (!rows.length) continue;
    if (DRY) { filled += rows.length; continue; }
    const body = {
      stage,
      examId: ex.id,
      rows: rows.map((r) => {
        // 技术考试给「笔试 + 机试 + 面试」，质素考核只给面试分（各学段公式不同，
        // 后端会按本学段公式折算综合成绩；多余字段会被忽略）
        const written = int(58, 98);
        const machine = int(60, 96);
        const interview = int(62, 97);
        const row = { studentId: r.studentId, writtenScore: written, machineScore: machine, interviewScore: interview, remark: written >= 85 ? '掌握扎实' : written >= 70 ? '掌握良好' : '需加强' };
        // 大学部是「老师手判」（judgeMode=manual），要显式给通过/未通过
        if (stage === 'class') row.examResult = written >= 60 && interview >= 60 ? 1 : 2;
        return row;
      }),
    };
    const res = await tryApi('POST', '/api/teaching/score/save', body);
    if (res.ok) filled += rows.length;
    else say(`    ⚠️ 成绩 ${ex.examName} 跳过：${res.err}`);
  }
  return filled;
}

/* ---- 4. 退费 ---- */

/**
 * ⚠️ 金额单位是**分**：缴费台账里学费显示 ¥12,800.00 = 存 1280000，
 *    这里跟它保持一致，否则退费金额会显示成 ¥12.00 这种离谱的数。
 */
const REFUND_REASONS = [
  { reason: '实训转岗，剩余课时退费', items: [{ feeType: 1, amount: 1280000 }, { feeType: 2, amount: 360000 }] },
  { reason: '休学退住宿费', items: [{ feeType: 2, amount: 360000 }] },
];

/**
 * 按审批链挨个换人点「通过」
 *   退费：学管主任 → 校长 → 财务确认；退学：学管 → 校长；休学：学管（1 步）
 *   ⚠️ 必须换账号：校长点「学管审批」这一步会 40302「您没有「学管审批」的审批权限」。
 * @returns 是否已走到终态
 */
async function walkApproval(stage, id, accounts, url, comment) {
  for (const acc of accounts) {
    await loginAs(acc);
    const r = await tryApi('POST', url, { stage, id, comment });
    if (!r.ok) {
      if (/审批权限/.test(r.err)) continue; // 这一环不是他，换下一个
      say(`    ⚠️ ${url.split('/').pop()} 跳过：${r.err}`);
      return false;
    }
    if (r.data?.finished) return true;
  }
  return false;
}

async function seedRefund(stage, students) {
  const had = (await api('GET', `/api/teaching/refund/list?stage=${stage}&page=1&size=50`)).list || [];
  if (had.length) return 0;
  let n = 0;
  for (let i = 0; i < REFUND_REASONS.length && i < students.length; i++) {
    const s = students[i];
    const plan = REFUND_REASONS[i];
    const amount = plan.items.reduce((a, b) => a + b.amount, 0);
    if (DRY) { n++; continue; }
    await loginAs('qiansy'); // 单子由班主任/学管发起，这里用校长代发起
    const created = await tryApi('POST', '/api/teaching/refund/create', {
      stage,
      studentId: s.studentId,
      items: plan.items,
      refundAmount: amount,
      applyDate: daysAgo(9 - i * 4),
      refundReason: plan.reason,
      submit: true,
    });
    if (!created.ok) { say(`    ⚠️ 退费(${stage}) 创建失败：${created.err}`); continue; }
    n++;
  }
  await loginAs('qiansy');
  return n;
}

/**
 * 退费单不能全是「待学管审批」—— 留一单待审、把另一单推到「已出款」，
 * 这样列表上三种状态都能看到（待审 / 审批中 / 已出款）。
 */
async function finishOneRefund(stage) {
  const list = (await api('GET', `/api/teaching/refund/list?stage=${stage}&page=1&size=50`)).list || [];
  if (list.some((r) => /已出款/.test(r.approvalStatusName || ''))) return 0;
  const target =
    list.find((r) => /已通过/.test(r.approvalStatusName || '')) ||
    list.find((r) => /待学管/.test(r.approvalStatusName || ''));
  if (!target) return 0;
  if (DRY) return 1;
  if (/待/.test(target.approvalStatusName || '')) {
    const done = await walkApproval(stage, target.id, ['congym', 'qiansy'], '/api/teaching/refund/approve', '同意退费');
    if (!done) return 0;
  }
  // ⚠️ 出款这一步用校长：财务账号（zhoum）没被授权进教学模块，会 40302「该模块未授权」
  await loginAs('qiansy');
  const fin = await tryApi('POST', '/api/teaching/refund/finance-confirm', {
    stage, id: target.id, financeRemark: '已网银出款', refundTime: daysAgo(1),
  });
  if (!fin.ok) { say(`    ⚠️ 财务确认跳过：${fin.err}`); return 0; }
  return 1;
}

/* ---- 5. 休学 / 退学审批 ---- */

async function seedLeave(stage, students) {
  const had = (await api('GET', `/api/teaching/leave/list?stage=${stage}&page=1&size=50`)).list || [];
  if (had.length) return 0;
  const plans = [
    { bizType: 1, leaveReason: '家庭原因，申请休学一学期', final: false, off: 6 },
    { bizType: 2, leaveReason: '已转学，申请办理退学', final: true, off: 20 },
  ];
  let n = 0;
  for (let i = 0; i < plans.length && i < students.length; i++) {
    const s = students[i];
    const p = plans[i];
    if (DRY) { n++; continue; }
    await loginAs('qiansy');
    const created = await tryApi('POST', '/api/teaching/leave/create', {
      stage,
      studentId: s.studentId,
      bizType: p.bizType,
      leaveDate: daysAgo(p.off),
      expectResumeDate: p.bizType === 1 ? daysAgo(-120) : undefined,
      leaveReason: p.leaveReason,
      submit: true,
    });
    if (!created.ok) { say(`    ⚠️ 审批(${stage}) 创建失败：${created.err}`); continue; }
    n++;
  }
  await loginAs('qiansy');
  return n;
}

/** 同退费：留一单休学待审、把退学单推到「已通过」 */
async function finishOneLeave(stage) {
  const list = (await api('GET', `/api/teaching/leave/list?stage=${stage}&page=1&size=50`)).list || [];
  if (list.some((r) => /已通过/.test(r.approvalStatusName || ''))) return 0;
  const target = list.find((r) => r.bizType === 2 && /待/.test(r.approvalStatusName || '')) || list.find((r) => /待学管/.test(r.approvalStatusName || ''));
  if (!target) return 0;
  if (DRY) return 1;
  await walkApproval(stage, target.id, ['congym', 'qiansy'], '/api/teaching/leave/approve', '同意');
  await loginAs('qiansy');
  return 1;
}

/* ---- 6. 宿舍：初高调宿申请 ---- */

/** 有的接口 data 是数组（住宿名单），有的是 {list}（分页），统一成数组 */
const asList = (d) => (Array.isArray(d) ? d : d?.list || []);

async function seedDormChange() {
  const had = asList(await api('GET', '/api/teaching/dorm/change/list?stage=jh&page=1&size=50'));
  if (had.length) return 0;
  const residents = asList(await api('GET', '/api/teaching/dorm/residents?stage=jh&page=1&size=50'));
  const rooms = asList(await api('GET', '/api/teaching/dorm/list?stage=jh&page=1&size=50'));
  const resident = residents.find((r) => r.bedId && r.dormId);
  if (!resident) return 0;
  // ⚠️ /dorm/beds 必须带 dormId（不带会 400「缺少宿舍ID」），而且只换到别的房间
  let target = null;
  for (const room of rooms) {
    if (room.dormId === resident.dormId) continue;
    // ⚠️ /dorm/beds 的 data 是 `{ beds: [...], dorm: {...} }`（不是 list），单独解一层
    const bedRes = await api('GET', `/api/teaching/dorm/beds?stage=jh&dormId=${room.dormId}&page=1&size=50`);
    const beds = Array.isArray(bedRes) ? bedRes : bedRes?.beds || [];
    const free = beds.find((b) => !b.studentId);
    if (free) { target = { room, free }; break; }
  }
  if (!target) return 0;
  if (DRY) return 1;
  const r = await tryApi('POST', '/api/teaching/dorm/change/create', {
    stage: 'jh',
    bizType: 1,
    studentId: resident.studentId,
    oldDormId: resident.dormId,
    oldBedId: resident.bedId,
    newDormId: target.room.dormId,
    newBedId: target.free.bedId,
    changeDate: daysAgo(2),
    changeReason: '作息不合，申请调换宿舍',
  });
  if (!r.ok) { say(`    ⚠️ 调宿申请跳过：${r.err}`); return 0; }
  return 1;
}

/* ---------------- 主流程 ---------------- */

(async () => {
  console.log(`\n=== 教学管理演示数据补齐 ${DRY ? '（预演）' : ''} ===\n`);
  try {
    await loginAs(ACCOUNT);
  } catch (e) {
    console.error(`${e.message}\n（请先确认后端在 ${BASE} 跑着）`);
    process.exit(1);
  }
  console.log(`已登录：${ACCOUNT}\n`);

  for (const stage of STAGES) {
    const classes = await classesOf(stage);
    console.log(`【${STAGE_LABEL[stage]}】${classes.length} 个班`);
    if (!classes.length) { say(`  （该学段没有班级，跳过）`); continue; }

    let att = 0; let exam = 0; let score = 0;
    const allStudents = [];
    for (const cls of classes) {
      const students = await studentsOfClass(stage, cls.classId);
      allStudents.push(...students);
      att += await seedAttendance(stage, cls, students);
      const newExams = await seedExams(stage, cls);
      exam += newExams.length;
      score += await seedScores(stage, cls.classId);
    }
    const refund = await seedRefund(stage, allStudents);
    const leave = await seedLeave(stage, allStudents);
    const refundDone = await finishOneRefund(stage);
    const leaveDone = await finishOneLeave(stage);

    say(
      `  ✓ ${STAGE_LABEL[stage]}：学生 ${allStudents.length} · 新增出勤 ${att} · 新增考试 ${exam} · 录成绩 ${score}` +
        ` · 退费 ${refund} 单(其中 ${refundDone} 单推到已出款) · 休学退学 ${leave} 单(其中 ${leaveDone} 单推到已通过)`,
    );
  }

  const dorm = await seedDormChange();
  say(`  ✓ 宿舍：新增调宿申请 ${dorm} 条`);

  console.log(`\n${'═'.repeat(46)}\n  ✓ 完成\n${'═'.repeat(46)}`);
  console.log('（打开 教学管理 各页面核对；重复执行本脚本不会造重复数据）\n');
})().catch((e) => {
  console.error('\n脚本异常：', e.message);
  process.exit(1);
});
