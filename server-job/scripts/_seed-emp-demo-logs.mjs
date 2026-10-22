/**
 * 补就业部演示数据（走接口，保证业务规则与关联正确）
 *   · 3 条就业日志（王子豪 / 李欣怡 / 赵雨桐）
 *   · 2 条复盘（陈宇航 / 刘子轩）
 * 幂等：先看列表里有没有同名同日期的记录，有就跳过。
 * 用法：node scripts/_seed-emp-demo-logs.mjs
 */
import { BASE, conn, killAll, login, req, startServices } from './_e2e-lib.mjs';

/* 幂等：先清掉本批演示学员名下的旧日志/复盘，避免重复堆积 */
const db = conn('sms_common');
for (const t of ['t_uni_employment_log', 't_uni_review']) {
  const n = await db(t).where('student_id', 'like', 'DEMO-EMP-%').del();
  if (n) console.log('清掉旧记录', t, n, '条');
}
await db.destroy();

await startServices();
const t = await login('zhouj');

const LOGS = [
  { studentName: '王子豪', logDate: '2026-10-15', resumeCount: 12, interviewInvite: 3, interviewCount: 2, company: '北京云启科技', position: 'Java 开发工程师', salary: 9500, interviewSituation: '二面通过，等 HR 谈薪' },
  { studentName: '李欣怡', logDate: '2026-10-16', resumeCount: 8, interviewInvite: 2, interviewCount: 2, company: '软通动力', position: '前端开发', salary: 8800, interviewSituation: '技术面通过，下周复试' },
  { studentName: '赵雨桐', logDate: '2026-10-17', resumeCount: 6, interviewInvite: 1, interviewCount: 1, company: '中科软', position: '测试工程师', salary: 8000, interviewSituation: '一面结束，反馈待定' },
];

const REVIEWS = [
  { studentName: '陈宇航', reviewTime: '2026-10-16 15:00', interviewTime: '2026-10-16 14:00', position: 'Java 开发工程师', salary: 10000, interviewConclusion: 2, reviewConclusion: 4, detail: '技术面与 HR 面均通过，已签三方，10 月底入职' },
  { studentName: '刘子轩', reviewTime: '2026-10-17 10:30', interviewTime: '2026-10-17 09:30', position: '运维工程师', salary: 9000, interviewConclusion: 3, reviewConclusion: 1, detail: '进入下一轮，保持现有刷题节奏' },
];

const existingLogs = (await req(`${BASE}/api/job/employment-log/list?page=1&size=100`, { token: t })).json?.data?.list || [];
for (const l of LOGS) {
  if (false && existingLogs.some((x) => x.studentName === l.studentName && x.logDate === l.logDate)) {
    console.log('已有日志，跳过：', l.studentName, l.logDate);
    continue;
  }
  const r = await req(`${BASE}/api/job/employment-log/add`, { method: 'POST', token: t, body: l });
  console.log('日志', l.studentName, r.json?.code, r.json?.message || '');
}

const existingReviews = (await req(`${BASE}/api/job/review/list?page=1&size=100`, { token: t })).json?.data?.list || [];
for (const v of REVIEWS) {
  if (false && existingReviews.some((x) => x.studentName === v.studentName)) {
    console.log('已有复盘，跳过：', v.studentName);
    continue;
  }
  const r = await req(`${BASE}/api/job/review/add`, { method: 'POST', token: t, body: v });
  console.log('复盘', v.studentName, r.json?.code, r.json?.message || '');
}

for (const p of ['/api/job/employment-log/list?page=1&size=100', '/api/job/review/list?page=1&size=100']) {
  const r = await req(`${BASE}${p}`, { token: t });
  const list = r.json?.data?.list || [];
  console.log(p.split('?')[0], r.json?.code, '共', list.length, '条 →', list.map((x) => `${x.studentName}/${x.studentNo || '-'}`).join(', '));
}

killAll();
