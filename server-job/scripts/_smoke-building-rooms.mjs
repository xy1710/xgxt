/**
 * 冒烟：楼栋设置「楼层数 × 每层房间数」自动生成宿舍号 + 宿舍数联动 + 删除前置条件
 *
 * 用法：node server-job/scripts/_smoke-building-rooms.mjs
 * （服务需已在 127.0.0.1:8004 运行且为最新代码）
 */

const BASE = 'http://127.0.0.1:8004';
/**
 * ★ 用 qiansy 而不是 sunjl：
 *   宿舍列表有「数据范围」过滤（班主任只看自己班学生住的房间，见 repo.uni.scopedDormIds），
 *   sunjl 一个班都没有 → 列表恒为 0 条，看不出生成效果。qiansy 是全量角色。
 */
const ACCOUNT = 'qiansy';
const PASS = '123456';

async function api(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = { raw: 'non-json' };
  }
  return { status: r.status, json };
}

const P = (label, v) => console.log(`\n=== ${label} ===\n${JSON.stringify(v, null, 2)}`);

async function main() {
  const login = await api('/api/portal/account/login', {
    method: 'POST',
    body: { account: ACCOUNT, password: PASS },
  });
  const token = login.json?.data?.token || '';
  if (!token) {
    console.log('登录失败', login.status, JSON.stringify(login.json));
    return;
  }
  console.log(`登录成功：${ACCOUNT}`);

  // 1. 楼栋列表（看新字段 + 宿舍数）
  const list1 = await api('/api/teaching/building/list', { token });
  P('1. 楼栋列表（含 floorCount / roomCount）', list1.json?.data ?? list1.json);

  // 2. 新增一栋测试楼：3 层 × 每层 4 间 × 每间 4 床
  const NAME = '冒烟测试楼';
  const save = await api('/api/teaching/building/save', {
    method: 'POST',
    token,
    body: {
      buildingName: NAME,
      category: 1,
      floorCount: 3,
      roomsPerFloor: 4,
      bedPerRoom: 4,
      remark: '冒烟自动生成',
    },
  });
  P('2. 新增楼栋 + 自动生成房间', save.json);

  // 3. 生成的房间列表（应 12 间：101~104 / 201~204 / 301~304）
  const rooms = await api(
    `/api/teaching/dorm/list?stage=job&building=${encodeURIComponent(NAME)}&page=1&size=100`,
    { token },
  );
  const rows = rooms.json?.data?.list ?? [];
  P(
    '3. 生成的房间（房号 / 床位 / 已住）',
    rows.map((r) => ({ roomNo: r.roomNo, bed: r.bedCount, occupied: r.occupiedCount, status: r.roomStatusName })),
  );

  // 4. 再查楼栋列表 → 宿舍数应为 12
  const list2 = await api('/api/teaching/building/list', { token });
  const b2 = (list2.json?.data ?? []).find((b) => b.buildingName === NAME);
  P('4. 该楼栋的宿舍数（应为 12）', b2);

  // 5. 删除一间**没有学生**的房间 → 成功，宿舍数应变成 11
  const empty = rows.find((r) => Number(r.occupiedCount) === 0);
  if (empty) {
    const del = await api(`/api/teaching/dorm/delete?stage=job&id=${empty.dormId}`, {
      method: 'DELETE',
      token,
    });
    P(`5. 删除空房间 ${empty.roomNo}`, del.json);
    const list3 = await api('/api/teaching/building/list', { token });
    const b3 = (list3.json?.data ?? []).find((b) => b.buildingName === NAME);
    P('5b. 删除后宿舍数（应为 11）', { roomCount: b3?.roomCount });
  } else {
    console.log('\n5. 没有空房间可删，跳过');
  }

  // 6. 找一个**有学生入住**的房间，尝试删除 → 应被拒绝
  const all = await api(`/api/teaching/dorm/list?stage=job&page=1&size=200`, { token });
  const busy = (all.json?.data?.list ?? []).find((r) => Number(r.occupiedCount) > 0);
  if (busy) {
    const delBusy = await api(`/api/teaching/dorm/delete?stage=job&id=${busy.dormId}`, {
      method: 'DELETE',
      token,
    });
    P(`6. 删除有学生入住的房间 ${busy.roomNo}（应报错）`, delBusy.json);
  } else {
    console.log('\n6. 当前没有住着人的房间，跳过该项');
  }

  // 7. 清理：删掉测试楼生成的房间，再删楼栋
  const rooms2 = await api(
    `/api/teaching/dorm/list?stage=job&building=${encodeURIComponent(NAME)}&page=1&size=100`,
    { token },
  );
  for (const r of rooms2.json?.data?.list ?? []) {
    await api(`/api/teaching/dorm/delete?stage=job&id=${r.dormId}`, { method: 'DELETE', token });
  }
  const b4row = (await api('/api/teaching/building/list', { token })).json?.data?.find(
    (b) => b.buildingName === NAME,
  );
  if (b4row) {
    const delB = await api(`/api/teaching/building/delete?id=${b4row.id}`, { method: 'DELETE', token });
    P('7. 清理测试楼栋', delB.json);
  }
}

main().catch((e) => console.error('SMOKE ERROR', e));
