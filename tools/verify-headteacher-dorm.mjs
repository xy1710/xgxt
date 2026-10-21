/**
 * 校验「班主任」权限下的宿舍管理页（2026-10-21 调整）
 * ============================================================
 *
 * 业务口径：班主任在宿舍域只做「查看本班住宿 + 发起调宿/退宿申请」，
 * **没有「新增房间」按钮，也没有「班级分派」子页签**（房间与班级分派归教务/学管）。
 *
 * 静态：
 *   · 页签「班级分派」带 `v-if="!isOnlyHeadTeacher"`
 *   · 「新增房间」按钮带 `!isOnlyHeadTeacher`
 *   · 角色判定排除 教务/校长/管理员/学管主任，且 SUPER_TEST 不受影响
 * 运行时：
 *   · 班主任仍持有 *:dorm:view、/meta 200（页面本身能进）
 *   · 班主任仍能发起调宿（/change/create 走参数校验 40000，不是 40302）
 *   · 教务老师仍持有 classjh:dorm:view 且 /meta 可写（该看的人不受影响）
 *
 * 用法：node tools/verify-headteacher-dorm.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = 'http://localhost:8004';
const PWD = '123456';

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

async function req(method, url, { token, body } = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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

console.log('▶ 静态检查');
const dorm = read('web-job/src/teaching/views/TeachingDorm.vue');
check('保留「宿舍房间」页签', dorm.includes('label="宿舍房间"'));
check('「班级分派」对班主任隐藏', /v-if="!isOnlyHeadTeacher"[\s\S]{0,80}label="班级分派"/.test(dorm));
check('「新增房间」对班主任隐藏', dorm.includes('canCreate && !isOnlyHeadTeacher'));
check('保持「调宿/退宿申请」入口', dorm.includes('调宿/退宿申请'));
check('班主任判定排除更高角色', dorm.includes('HEAD_TEACHER_SUPERIOR_ROLES') && dorm.includes('RoleCode.TEACH_HEAD'));
check('SUPER_TEST 不受影响', /isSuperTest\.value\) return false/.test(dorm));
check('班主任看不到房间「编辑 / 删除」', (dorm.match(/canEdit\(row\) && !isOnlyHeadTeacher/g) || []).length >= 3);
check('入住改用「学生候选」接口', dorm.includes('listDormCandidates') && dorm.includes('remote-method="searchAssignStudents"'));

const repo = read('server-job/src/teaching/dorm/repo.uni.ts');
check('房间范围含「分派给本班」', repo.includes('ASSIGN_T') && repo.includes('t_edu_dorm_assignment'));
check('「我的班」兼容 id 与姓名', repo.includes('head_teacher_name') && repo.includes('permUid'));
check('入住候选按数据范围过滤', repo.includes('async candidates') && repo.includes('IN_SCHOOL_STATUS'));

console.log('\n▶ 运行时检查');
// ① 班主任：能进页面、能发起调宿，但（前端）不给建房间/班级分派
for (const a of [
  { account: 'sunmin', label: '初高班主任', code: 'classjh:dorm:view', stage: 'jh' },
  { account: 'zhanght', label: '大学班主任', code: 'class:dorm:view', stage: 'class' },
]) {
  const login = await req('POST', '/api/portal/account/login', { body: { account: a.account, password: PWD } });
  if (login.status !== 200 || !login.body?.data?.token) {
    check(`${a.label} 登录`, false, `HTTP ${login.status}`);
    continue;
  }
  const token = login.body.data.token;
  const myPages = await req('GET', '/api/job/auth/my-pages', { token });
  const perms = myPages.body?.data?.permissions || [];
  check(`${a.label} 仍可进宿舍页`, perms.includes(a.code));

  const meta = await req('GET', '/api/teaching/dorm/meta', { token });
  check(`${a.label} /meta 200`, meta.status === 200 && (meta.body?.data || []).length > 0);

  // 调宿申请：空 body 应命中「原因必填/业务类型」这类参数校验（40000），说明入口仍可用
  const change = await req('POST', '/api/teaching/dorm/change/create', { token, body: { stage: a.stage } });
  check(`${a.label} 仍可发起调宿（参数校验）`, change.body?.code === 40000, `code=${change.body?.code}`);
}

// ② 教务：两个功能都还在（不能被误伤）
const acad = await req('POST', '/api/portal/account/login', { body: { account: 'zhengym', password: PWD } });
if (acad.status === 200 && acad.body?.data?.token) {
  const token = acad.body.data.token;
  const myPages = await req('GET', '/api/job/auth/my-pages', { token });
  check('教务仍持 classjh:dorm:view', (myPages.body?.data?.permissions || []).includes('classjh:dorm:view'));
  const meta = await req('GET', '/api/teaching/dorm/meta', { token });
  check('教务 /meta 可写', meta.status === 200 && (meta.body?.data || []).every((m) => m.hasCreate));
  const classes = await req('GET', '/api/teaching/dorm/allocate/classes', { token });
  check('教务班级分派数据源 200', classes.status === 200, `${(classes.body?.data || []).length} 个班`);
} else {
  check('教务登录', false, `HTTP ${acad.status}`);
}

/* ③ 闭环：教务分派 → 班主任只能看到分给本班的那几间，并且能拿到本班未入住学生 */
console.log('\n▶ 分派 → 班主任可见');
const acadToken = acad.body?.data?.token;
const sunLogin = await req('POST', '/api/portal/account/login', { body: { account: 'sunmin', password: PWD } });
const sunToken = sunLogin.body?.data?.token;
if (acadToken && sunToken) {
  const m = await req('GET', `/api/teaching/dorm/allocate/rooms?category=1&building=${encodeURIComponent('1号楼')}`, { token: acadToken });
  const f = await req('GET', `/api/teaching/dorm/allocate/rooms?category=2&building=${encodeURIComponent('3号楼')}`, { token: acadToken });
  const male = (m.body?.data || []).find((r) => !r.full);
  const female = (f.body?.data || []).find((r) => !r.full);

  if (!male || !female) {
    check('找到可分派的男/女寝房间', false);
  } else {
    const save = await req('POST', '/api/teaching/dorm/allocate/save', {
      token: acadToken,
      body: {
        className: 'G2601',
        headTeacherName: '孙敏',
        maleRoomIds: [male.roomId],
        femaleRoomIds: [female.roomId],
      },
    });
    check('教务把 G2601 分到房间', save.status === 200 && save.body?.code === 200, save.body?.message || save.raw.slice(0, 80));

    const list = await req('GET', '/api/teaching/dorm/list?stage=jh&page=1&size=100', { token: sunToken });
    const rows = list.body?.data?.list || [];
    const ids = new Set(rows.map((r) => r.dormId));
    // 可见范围 = 分派给本班的房间 ∪ 本班学生已住的房间
    const s1 = await req('GET', `/api/teaching/dorm/allocate/students?className=${encodeURIComponent('G2601')}`, { token: acadToken });
    const s2 = await req('GET', `/api/teaching/dorm/allocate/students?className=${encodeURIComponent('J2602')}`, { token: acadToken });
    const own = [...(s1.body?.data || []), ...(s2.body?.data || [])]
      .map((s) => s.dormId)
      .filter(Boolean);
    const allowed = new Set([male.roomId, female.roomId, ...own]);
    check(
      '班主任只看到本班相关房间',
      ids.has(male.roomId) && ids.has(female.roomId) && rows.every((r) => allowed.has(r.dormId)),
      `${rows.map((r) => `${r.buildingName}${r.roomNo}`).join('、') || '空'}`,
    );

    const cand = await req('GET', '/api/teaching/dorm/candidates?stage=jh', { token: sunToken });
    const candRows = cand.body?.data || [];
    check(
      '班主任能拿到本班未入住学生',
      cand.status === 200 && candRows.length > 0 && candRows.every((c) => ['G2601', 'J2602'].includes(c.className)),
      `${candRows.length} 人（${[...new Set(candRows.map((c) => c.className))].join('/')}）`,
    );

    /**
     * ★ 2026-10-21 跨学段：Q30 是初高班，班主任却是大学部的张海涛（zhanght）。
     *   分派后 zhanght 必须能看到 1号楼 405 —— 验证「我的班」是跨学段查的。
     */
    const room405 = (m.body?.data || []).find((r) => r.room === '405');
    if (!room405) {
      check('找到 1号楼 405', false);
    } else {
      const saveQ30 = await req('POST', '/api/teaching/dorm/allocate/save', {
        token: acadToken,
        body: { className: 'Q30', headTeacherName: '张海涛', maleRoomIds: [room405.roomId], femaleRoomIds: [] },
      });
      check('教务把 Q30 分到 1号楼405', saveQ30.body?.code === 200, saveQ30.body?.message || '');
      const zhLogin = await req('POST', '/api/portal/account/login', { body: { account: 'zhanght', password: PWD } });
      const zhToken = zhLogin.body?.data?.token;
      const zlist = await req('GET', '/api/teaching/dorm/list?stage=class&page=1&size=100', { token: zhToken });
      const zrows = zlist.body?.data?.list || [];
      check(
        '跨学段班主任能看到本班分派的房间',
        zrows.some((r) => r.dormId === room405.roomId),
        zrows.map((r) => `${r.buildingName}${r.roomNo}`).join('、') || '空',
      );
    }
  }
} else {
  check('取教务/班主任 token', false);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
