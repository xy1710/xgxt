/**
 * 校验「宿舍管理 → 班级分派」子页面
 * ============================================================
 *
 * 静态：菜单/页面里确实挂了子页签与接口封装。
 * 运行时（教务老师 zhengym）：
 *   ① GET /api/teaching/dorm/allocate/classes  → 200，且每行含
 *      班级/班主任/男女生人数/状态/所分宿舍 六个字段
 *   ② GET /api/teaching/dorm/allocate/buildings?category=1 → 有男寝楼栋
 *   ③ GET /api/teaching/dorm/allocate/rooms?category=1&building=... → 含 capacity/occupied/remaining
 *   ④ 保存 G2601 现有分派（幂等）→ 200，回读状态仍为「已分派」
 *   ⑤ 旧入口 /api/edu/dorm/assign/list 对教务老师 403（说明只能走新接口）
 *
 * 用法：node tools/verify-dorm-allocate.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASE = 'http://localhost:8004';
const ACCOUNT = 'zhengym';
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
const page = read('web-job/src/teaching/views/DormAllocate.vue');
const api = read('web-job/src/teaching/api/dormAllocate.ts');
const route = read('server-job/src/teaching/dorm/allocate.route.ts');
const app = read('server-job/src/app.ts');
const svc = read('server-job/src/teaching/dorm/allocate.service.ts');

check('TeachingDorm 挂了「班级分派」页签', /班级分派/.test(dorm) && /DormAllocate/.test(dorm));
check('DormAllocate 列表有六个必需列', ['班级', '班主任', '男生人数', '女生人数', '状态', '所分宿舍'].every((h) => page.includes(h)));
check('DormAllocate 左右两栏（男寝 / 女寝）', page.includes('男寝') && page.includes('女寝') && page.includes("loadRooms('male')") && page.includes("loadRooms('female')"));
check('下拉框前有「选择楼栋」四个字', (page.match(/选择楼栋/g) || []).length >= 3);
check('无学生班级按 100 床上限', page.includes('EMPTY_CLASS_MAX_BEDS') && svc.includes('EMPTY_CLASS_MAX_BEDS = 100'));
check('楼栋取自「楼栋设置」字典', svc.includes("t_dorm_building") && svc.includes('BUILDING'));
check('宿舍取自各楼栋已建房间（t_job_dorm）', svc.includes("const ROOM = 'sms_job.t_job_dorm'"));
check('前端接口封装指向 allocate/*', api.includes('/api/teaching/dorm/allocate/classes') && api.includes('/save'));

/* ---- 调宿 / 退宿弹窗改版（2026-10-20）---- */
check('调宿弹窗去掉「学段」选择', !dorm.includes('v-model="changeForm.stage"') && !dorm.includes('onChangeStageChange'));
check('调宿弹窗有班级选择 + 学生远程搜索', dorm.includes('@change="onChangeClass"') && dorm.includes('remote-method="searchChangeStudents"'));
check('学生选项带学号（区分重名）', dorm.includes('${s.studentName}（${s.studentNo}）'));
check('选学生后回显当前宿舍', dorm.includes('label="当前宿舍"') && dorm.includes('curStudent.building'));
check('当前宿舍显示 楼栋/宿舍号/床位号', dorm.includes('楼栋：') && dorm.includes('宿舍号：') && dorm.includes('床位号：'));
check('调宿楼栋来自楼栋设置', dorm.includes('listAllocateBuildings(changeForm.category)'));
check('目标床位取宿舍剩余床位', dorm.includes('freeBeds'));
check('调宿有 类别 → 楼栋 → 目标床位', dorm.includes('label="目标床位"') && dorm.includes('loadChangeRooms'));
check('打开弹窗即预加载楼栋选项', /async function openChange\(\)[\s\S]{0,400}onChangeCategory\(\)/.test(dorm));
check('未选楼栋时目标床位禁用并提示', dorm.includes(':disabled="!changeForm.building"') && dorm.includes('请先选择楼栋'));
check('日期只读、原因 ≤100', dorm.includes('{{ changeForm.changeDate }}') && !dorm.includes('v-model="changeForm.changeDate"') && dorm.includes('maxlength="100"'));
check('后端路由有 classes/buildings/rooms/save', ['/classes', '/buildings', '/rooms', '/save'].every((p) => route.includes(`'${p}'`)));
check('app.ts 在 /api/teaching/dorm 之前挂载 allocate', app.indexOf("'/api/teaching/dorm/allocate'") > -1 && app.indexOf("'/api/teaching/dorm/allocate'") < app.indexOf("'/api/teaching/dorm'"));

console.log('\n▶ 运行时检查（教务老师 zhengym）');
const login = await req('POST', '/api/portal/account/login', { body: { account: ACCOUNT, password: PWD } });
if (login.status !== 200 || !login.body?.data?.token) {
  check('登录', false, `HTTP ${login.status} ${login.raw.slice(0, 120)}`);
} else {
  check('登录', true);
  const token = login.body.data.token;

  const classes = await req('GET', '/api/teaching/dorm/allocate/classes', { token });
  const rows = classes.body?.data || [];
  check('班级列表 200', classes.status === 200, `共 ${rows.length} 个班`);
  const sample = rows[0] || {};
  check(
    '班级行字段齐全',
    rows.length > 0 &&
      'className' in sample &&
      'headTeacherName' in sample &&
      'maleCount' in sample &&
      'femaleCount' in sample &&
      'status' in sample &&
      'maleRooms' in sample &&
      'femaleRooms' in sample,
    JSON.stringify(sample).slice(0, 120),
  );

  const buildings = await req('GET', '/api/teaching/dorm/allocate/buildings?category=1', { token });
  const bList = buildings.body?.data || [];
  check('男寝楼栋非空', buildings.status === 200 && bList.length > 0, bList.join(','));

  // 楼栋来自「楼栋设置」字典；逐个楼栋找一间有房间的来验证
  let firstBuilding = bList[0] || '';
  let rList = [];
  for (const b of bList) {
    const resp = await req(
      'GET',
      `/api/teaching/dorm/allocate/rooms?category=1&building=${encodeURIComponent(b)}`,
      { token },
    );
    const list = resp.body?.data || [];
    if (list.length) {
      firstBuilding = b;
      rList = list;
      break;
    }
  }
  check(
    '宿舍列表含剩余床位',
    rList.length > 0 &&
      typeof rList[0].capacity === 'number' &&
      typeof rList[0].occupied === 'number' &&
      typeof rList[0].remaining === 'number',
    rList.length ? `${firstBuilding} ${rList[0].room} 余 ${rList[0].remaining}` : '所有男寝楼栋都没有房间',
  );

  // 保存：挑一个「待分派」的班，用空列表保存 = 清空（幂等，不改动已有分派）
  const pending = rows.find((r) => r.status === '待分派');
  if (pending) {
    const save = await req('POST', '/api/teaching/dorm/allocate/save', {
      token,
      body: {
        className: pending.className,
        headTeacherName: pending.headTeacherName,
        maleRoomIds: [],
        femaleRoomIds: [],
      },
    });
    check('保存分派 200（空列表幂等）', save.status === 200 && save.body?.code === 200, save.body?.message || save.raw.slice(0, 80));

    const after = await req('GET', '/api/teaching/dorm/allocate/classes', { token });
    const row = (after.body?.data || []).find((r) => r.className === pending.className);
    check('回读仍为待分派', !!row && row.status === '待分派', row ? `${row.className} ${row.status}` : '未找到班级');
  } else {
    check('保存分派 200（空列表幂等）', false, '没有「待分派」的班级可用于幂等保存');
  }

  // 非法房间 id → 必须拒绝，不能静默写入
  const badSave = await req('POST', '/api/teaching/dorm/allocate/save', {
    token,
    body: { className: '不存在的班', maleRoomIds: ['00000000-0000-0000-0000-000000000000'], femaleRoomIds: [] },
  });
  check('非法宿舍 id 被拒', badSave.status >= 400 || badSave.body?.code !== 200, `HTTP ${badSave.status} code=${badSave.body?.code}`);

  /* ---- 调宿弹窗：学生搜索 / 空床位 / 校验 ---- */
  const stuClass = rows.find((r) => r.maleCount + r.femaleCount > 0)?.className;
  const stu = await req(
    'GET',
    `/api/teaching/dorm/allocate/students?className=${encodeURIComponent(stuClass || '')}`,
    { token },
  );
  const stuList = stu.body?.data || [];
  check(
    '学生搜索 200 且带学号',
    stu.status === 200 && stuList.length > 0 && !!stuList[0].studentNo && !!stuList[0].studentName,
    stuList.length ? `${stuList[0].studentName}（${stuList[0].studentNo}）` : '空',
  );
  const kw = stuList[0]?.studentName?.slice(-1) || '';
  const stuKw = await req(
    'GET',
    `/api/teaching/dorm/allocate/students?keyword=${encodeURIComponent(kw)}`,
    { token },
  );
  check('学生姓名模糊搜索命中', (stuKw.body?.data || []).length > 0, `关键字 ${kw} → ${(stuKw.body?.data || []).length} 条`);

  check(
    '宿舍返回空闲床位明细',
    rList.length > 0 && Array.isArray(rList[0].freeBeds) && rList[0].freeBeds.every((b) => b.bedId && b.bedLabel),
    rList.length ? `${rList[0].room} 空闲 ${rList[0].freeBeds.length} 床` : '无房间',
  );

  const tooLong = await req('POST', '/api/teaching/dorm/change/create', {
    token,
    body: {
      stage: 'job',
      bizType: 2,
      studentId: stuList[0]?.studentId || 'x',
      changeDate: new Date().toISOString().slice(0, 10),
      changeReason: '超'.repeat(101),
    },
  });
  check('原因超 100 字被拒', tooLong.status >= 400 || tooLong.body?.code !== 200, `HTTP ${tooLong.status} code=${tooLong.body?.code}`);

  const oldApi = await req('GET', '/api/edu/dorm/assign/list', { token });
  check('旧入口 /api/edu/dorm/assign/list 对教务 403', oldApi.status === 403, `HTTP ${oldApi.status}`);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
