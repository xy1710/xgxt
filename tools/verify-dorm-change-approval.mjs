/**
 * 校验「宿舍管理 → 申请审批」
 * ============================================================
 *
 * 用户需求：新增一个子界面，接收班主任提交的换宿/退宿申请；
 * **审批通过后宿舍表要跟着改**（新增/减少/修改学生入住信息）。
 *
 * 覆盖：
 *   静态：页签存在且仅审批角色可见；审批/驳回接口与落库动作都在
 *   运行时：
 *     ① 班主任不能审批（40302）
 *     ② 教务对不存在的申请审批/驳回 → 参数错误（不会静默成功）
 *     ③ 端到端：班主任发起调宿 → 教务通过 → 目标床位变为已住、学生宿舍指向新房间
 *        → 脚本最后用「退宿」把床位还原，并软删测试单（可重复执行）
 *
 * 用法：node tools/verify-dorm-change-approval.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const BASE = 'http://localhost:8004';
const PWD = '123456';
const ROOM_303 = '3f2484f2-32bc-4a50-b076-bef6b2db6759';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function mysqlExec(sql) {
  const env = read('server-job/.env');
  const pwd = /^DB_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || '';
  return execFileSync('mysql', ['-uroot', `-p${pwd}`, '-N', '-e', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function req(method, url, { token, body } = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { status: r.status, body: json, raw };
}

async function login(account) {
  const r = await req('POST', '/api/portal/account/login', { body: { account, password: PWD } });
  return r.body?.data?.token || '';
}

console.log('▶ 静态检查');
const page = read('web-job/src/teaching/views/TeachingDorm.vue');
const comp = read('web-job/src/teaching/views/DormChangeApproval.vue');
const route = read('server-job/src/teaching/dorm/route.ts');
const svc = read('server-job/src/teaching/dorm/service.ts');
const repo = read('server-job/src/teaching/dorm/repo.uni.ts');

check('宿舍管理有「申请审批」页签', /label="申请审批"/.test(page) && page.includes('DormChangeApproval'));
check('页签只给审批角色', /canApproveDorm[\s\S]{0,120}label="申请审批"/.test(page) || page.includes('v-if="canApproveDorm"'));
check('审批组件有通过 / 驳回', comp.includes('approveDormChange') && comp.includes('rejectDormChange'));
check('后端有 approve / reject 路由', route.includes("'/change/approve'") && route.includes("'/change/reject'"));
check('只有教务/校长/学管主任可批', svc.includes('assertDormApprover') && svc.includes('RoleCode.ACAD_STAFF'));
check('通过时落库改床位与学生宿舍', repo.includes('async changeApprove') && repo.includes('applyChangeOnApproved'));
check('列表按 changeId 去重（老表三学段同表）', svc.includes('seen.has(r.changeId)'));
check('床位号按 bed_id 兜底回填', repo.includes('bedMap.get(str(a.new_bed_id)') && repo.includes('bedMap.get(str(a.old_bed_id)'));
check('重复提交被拦', repo.includes('该学生已有相同的待审批申请'));
check('审批表不再横向溢出（doLayout）', comp.includes('doLayout()') && comp.includes('ResizeObserver'));

console.log('\n▶ 运行时检查');
const sunToken = await login('sunmin');
const acadToken = await login('zhengym');
check('班主任 / 教务登录', !!sunToken && !!acadToken);

// ① 班主任不能审批
const sunApprove = await req('POST', '/api/teaching/dorm/change/approve', {
  token: sunToken,
  body: { stage: 'jh', id: '00000000-0000-0000-0000-000000000000' },
});
check('班主任不能审批', sunApprove.body?.code === 40302, `code=${sunApprove.body?.code}`);

// ①.5 列表不重复 + 床位号可见
const chgList = await req('GET', '/api/teaching/dorm/change/list', { token: acadToken });
const chgRows = chgList.body?.data || [];
const ids = chgRows.map((r) => r.changeId);
check('列表无重复单号', new Set(ids).size === ids.length, `${ids.length} 条`);
const withTarget = chgRows.find((r) => r.bizType === 1 && r.newDormNo);
check(
  '选了床位就能显示床位号',
  !!withTarget && !!withTarget.newBedNo,
  withTarget ? `${withTarget.newDormNo} · ${withTarget.newBedNo || '（缺）'}` : '无调宿单',
);

// ①.6 重复提交在下方「发起 → 通过」闭环里校验（那里有确定的待审批单）

// ② 不存在的申请不能静默通过
const badApprove = await req('POST', '/api/teaching/dorm/change/approve', {
  token: acadToken,
  body: { stage: 'jh', id: '00000000-0000-0000-0000-000000000000' },
});
check('不存在的申请被拒（通过）', badApprove.body?.code === 40000, `code=${badApprove.body?.code}`);
const badReject = await req('POST', '/api/teaching/dorm/change/reject', {
  token: acadToken,
  body: { stage: 'jh', id: '00000000-0000-0000-0000-000000000000', reason: 'x' },
});
check('不存在的申请被拒（驳回）', badReject.body?.code === 40000, `code=${badReject.body?.code}`);

// ③ 端到端：发起 → 通过 → 床位/学生变了 → 还原
let changeId = '';
let bedId = '';
try {
  const beds = await req('GET', `/api/teaching/dorm/beds?stage=jh&dormId=${ROOM_303}`, { token: acadToken });
  const free = (beds.body?.data?.beds || []).find((b) => b.bedStatus === 1);
  bedId = free?.bedId || '';
  check('找到空闲床位', !!bedId, free?.bedLabel || '无空闲床位');

  const cands = await req('GET', '/api/teaching/dorm/candidates?stage=jh', { token: sunToken });
  const stu = (cands.body?.data || []).find((c) => c.gender === 1 && !c.dormNo);
  check('找到未入住男生', !!stu, stu ? `${stu.studentName}(${stu.studentNo})` : '无');

  if (bedId && stu) {
    const created = await req('POST', '/api/teaching/dorm/change/create', {
      token: sunToken,
      body: {
        stage: 'jh',
        bizType: 1,
        studentId: stu.studentId,
        newDormId: ROOM_303,
        newBedId: bedId,
        changeDate: new Date().toISOString().slice(0, 10),
        changeReason: 'E2E 审批校验（脚本自动还原）',
      },
    });
    changeId = created.body?.data?.id || '';
    check('班主任发起调宿', !!changeId, created.body?.message || '');

    // 同一学生 + 同一目标床位再提一次 → 应被防重拦下
    const dup = await req('POST', '/api/teaching/dorm/change/create', {
      token: sunToken,
      body: {
        stage: 'jh',
        bizType: 1,
        studentId: stu.studentId,
        newDormId: ROOM_303,
        newBedId: bedId,
        changeDate: new Date().toISOString().slice(0, 10),
        changeReason: '重复提交校验',
      },
    });
    check('重复提交被拦', dup.body?.code === 40000, dup.body?.message || `code=${dup.body?.code}`);

    const approved = await req('POST', '/api/teaching/dorm/change/approve', {
      token: acadToken,
      body: { stage: 'jh', id: changeId },
    });
    check('教务审批通过', approved.body?.code === 200, approved.body?.message || '');

    const after = await req('GET', `/api/teaching/dorm/beds?stage=jh&dormId=${ROOM_303}`, { token: acadToken });
    const bed = (after.body?.data?.beds || []).find((b) => b.bedId === bedId);
    check(
      '通过后床位变为已住',
      bed?.bedStatus === 2 && bed?.studentNo === stu.studentNo,
      bed ? `${bed.bedLabel} ${bed.bedStatus} ${bed.studentName || ''}` : '未找到床位',
    );

    const stuAfter = await req('GET', `/api/teaching/dorm/allocate/students?keyword=${encodeURIComponent(stu.studentNo)}`, {
      token: acadToken,
    });
    const s2 = (stuAfter.body?.data || [])[0];
    check('通过后学生宿舍已更新', s2?.dormId === ROOM_303 && s2?.bedLabel === bed?.bedLabel, `${s2?.building || ''}${s2?.room || ''} ${s2?.bedLabel || ''}`);
  }
} finally {
  // 还原：直接退宿（把床放回去、学生宿舍清空）
  if (bedId) {
    try {
      await req('POST', '/api/teaching/dorm/checkout', {
        token: acadToken,
        body: { stage: 'jh', dormId: ROOM_303, bedId },
      });
    } catch {
      /* ignore */
    }
  }
  // 测试单软删，避免脏数据
  if (changeId) {
    try {
      mysqlExec(`UPDATE sms_job.t_job_dorm_change SET is_deleted=1 WHERE id='${changeId}'`);
    } catch {
      /* ignore */
    }
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
