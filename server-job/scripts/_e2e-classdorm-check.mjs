/**
 * 自检：宿舍域（`/api/class/dorm/*`· 第 4 期第 5 批统一表切读）
 * ============================================================
 * ⚠️ 与 `_e2e-dorm-check.mjs` 的区别（别搞混）：
 *   `_e2e-dorm-check.mjs` = 第 2 期 `teaching/dorm` 三学段（jh/class/job 各走各的表）
 *   本脚本            = `class/dorm` 大学侧的 11 个接口，是这批真正改动的文件
 *
 * 本批最该盯死的几条（每一条都对应一个真实踩过的坑）：
 *   ①【★★ 幂等键 source_id】/sync 房间幂等键是 (source_system, source_id)。
 *      统一表若缺 source_id 列 → where 永远不命中 → 每推一次翻一倍，
 *      而接口照样返回 200、failed=0（**静默数据翻倍，最难查**）。
 *      → 断言：推两次，行数不变、inserted=0、updated=N。
 *   ②【★★ room_no 与 uk_dorm_room】uk_dorm_room(room_no, dorm_no, edu_stage)，
 *      room_no 列默认 ''。老代码只写 dorm_no → 三元组全等 → 第二间就撞。
 *      → 断言：连建 3 间不同 dorm_no 全部成功；切读时 room_no 有值。
 *   ③【★★★ 住宿表房间指向列改名】老表 dorm_id/dorm_no → 统一表 room_id/room_no。
 *      若没rename，数据会整列丢掉（不报错，只是房间显示为空）。
 *      → 断言：切读时住宿行的 room_id / room_no 有值且与房间对得上。
 *   ④【★★ failed === 0】同步类接口必须断言失败数为 0 并打印 errors[].reason，
 *      否则「200 + failed=3」会被当成成功。
 *   ⑤【★ 退宿清理】本次未出现的住宿记录要软删（老表 is_deleted=1 / 统一表同列）。
 *   ⑥【★ 床位总数不能小于在住人数】/room/update 的业务闸门。
 *   ⑦【★ 审批链】申请 → 审批通过 → 写调宿记录 + 改学生宿舍号，同生共死。
 *
 * 跑法：
 *   node scripts/_e2e-classdorm-check.mjs                （老表模式）
 *   TEACHING_UNI_TABLE=1 node scripts/_e2e-classdorm-check.mjs（切读模式）
 */
import {
  BASE,
  buildRow,
  conn,
  dumpBackendError,
  killAll,
  login,
  makeChecker,
  mirrorToUni,
  probe,
  regTarget,
  req,
  startServices,
  USE_UNI,
} from './_e2e-lib.mjs';

const API = `${BASE}/api/class/dorm`;
const { check, summary } = makeChecker();

const OK = 200;
const isOk = (r) => r.json?.code === OK;

const SRC = 'sms_class';
const SRC_ROOM = 'sms_common';
const STAGE = 'class';

const ROOM_T = 't_class_dorm_room_sync';
const LIVE_T = 't_class_dorm_live_sync';
const APPLY_T = 't_class_dorm_apply';
const CHANGE_T = 't_class_dorm_change_log';
const STU_T = 't_class_student';
const CLS_T = 't_class_info';

const db = conn(SRC);
const dbCommon = conn(SRC_ROOM);

/** 夹具登记：切读时数据落在统一表，必须跟着改指向，否则清理删不掉 */
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

/** 住宿表的房间指向列（切读后正名为 room_id / room_no） */
const RID = USE_UNI ? 'room_id' : 'dorm_id';
const RNO = USE_UNI ? 'room_no' : 'dorm_no';

/** 服务对服务接口的内部凭证（config.internalToken 默认值，见 src/config.ts:93） */
const INTERNAL = process.env.INTERNAL_TOKEN || 'CHANGE_ME_INTERNAL_TOKEN';

const rnd = Math.random().toString(36).slice(2, 8);
const SRC_ID = `E2E-DORM-${rnd}`;

/* ============================================================
 * 夹具
 * ============================================================ */

/**
 * ★ 切读夹具必须**双写**：先插老表，再镜像一份到统一表
 *   （与 `_e2e-classinfo-check.mjs` 等同款口径，用脚手架的 mirrorToUni）
 *   直接往统一表插会报 `Field 'edu_stage' doesn't have a default value`
 *   —— 统一表该列 NOT NULL 且故意没默认值，是「当场炸」的设计。
 */
async function makeStudent(name) {
  // ★ 必须**显式给id**：buildRow 只会「缺失时」生成，reg() 登记的 id 必须等于落库的 id
  const id = `stu-cd-${rnd}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(db, STU_T, {
    id,
    student_no: `E2E${rnd}${Math.floor(Math.random() * 9000 + 1000)}`,
    student_name: name,
    gender: 1,
    // ★ dataScope=3 的账号 dept_code 必须匹配，自检脚本要自己控住这列，
    //   否则 buildRow 按 COLUMN_DEFAULT 填 0 会让「班主任只看本班」查空
    dept_code: 1,
    // ★ 学生状态列叫 student_status，不是 status（写错报 Unknown column 'status'）
    student_status: 5,
  });
  await db(STU_T).insert(row);
  reg(SRC, STU_T, id);
  if (USE_UNI) await mirrorToUni(SRC, STU_T, { ...row, id }, STAGE, reg);
  return { id, ...row };
}

async function makeClass(name) {
  const id = `cls-cd-${rnd}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(db, CLS_T, {
    id,
    class_name: name,
    dept_code: 1,
    // ★ 班级状态列叫 class_status，不是 status（t_class_info 没有 status 列）
    class_status: 1,
  });
  await db(CLS_T).insert(row);
  reg(SRC, CLS_T, id);
  if (USE_UNI) await mirrorToUni(SRC, CLS_T, { ...row, id }, STAGE, reg);
  return { id, ...row };
}

async function cleanup() {
  // 先删子表再删主表，避免软删残留占住唯一索引
  const order = [
    [SRC, CHANGE_T],
    [SRC, APPLY_T],
    [SRC_ROOM, LIVE_T],
    [SRC_ROOM, ROOM_T],
    [SRC, STU_T],
    [SRC, CLS_T],
  ];
  for (const [dbName, table] of order) {
    for (const [fdb, ftable, id] of fixtures) {
      if (fdb !== dbName || ftable !== table) continue;
      const c = conn(fdb);
      // 物理删（自检数据不进软删池，避免占唯一索引）
      await c(ftable).where({ id }).del().catch(() => {});
      await c.destroy();
    }
  }
  /* ★ 2026-10-19 修：上面只按老表清单删，`mirrorToUni` 登记的 **统一表镜像行**（db='sms_common'）
       从来没被删过 → 每跑一轮就在 t_uni_student / t_uni_class 里留一批「自检住宿xxx」。
       这里按登记顺序倒着补删一遍（先子后主）。 */
  for (const [fdb, ftable, id] of [...fixtures].reverse()) {
    if (fdb !== 'sms_common') continue;
    const c = conn(fdb);
    await c(ftable).where({ id }).del().catch(() => {});
    await c.destroy();
  }
}

/* ============================================================
 * 用例
 * ============================================================ */

async function main() {
  console.log(`\n===== 宿舍域自检（${USE_UNI ? '统一表' : '老表'}模式） =====\n`);
  const svc = await startServices();
  if (!svc.backendReady) {
    console.log('❌ 后端未就绪');
    dumpBackendError(40);
    return false;
  }
  const token = await login('qiansy'); // 校长：写操作必须用校长，学管只审批
  if (!token) {
    console.log('❌ 登录失败');
    return false;
  }
  const H = { Authorization: `Bearer ${token}` };
  const call = (path, opts = {}) => req(`${API}${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  /**
   * /sync 是**服务对服务**接口，走 authAllowSync：
   *   没带 x-internal-token 会40101「内部服务凭证无效」——
   *   症状长得像业务 bug，其实是缺凭证，自检必须自己带上。
   */
  const callSync = (path, body) =>
    req(`${API}${path}`, { method: 'POST', body, headers: { 'x-internal-token': INTERNAL } });

  const stu = await makeStudent(`自检住宿${rnd}`);
  const cls = await makeClass(`自检班级${rnd}`);

  /* ---------- ① /sync 首推：房间 + 住宿 ---------- */
  console.log('\n-- ① /sync 首次推送 --');
  const syncBody = {
    sourceSystem: 'edu',
    batchNo: `E2E-B1-${rnd}`,
    items: [
      {
        room: {
          sourceId: `${SRC_ID}-R1`,
          buildingId: `B-${rnd}`,
          buildingName: '自检A栋',
          dormType: 1,
          dormNo: `E2E-${rnd}-101`,
          bedCount: 4,
          usedCount: 1,
        },
        residents: [
          {
            studentId: stu.id,
            studentNo: stu.student_no,
            studentName: stu.student_name,
            classId: cls.id,
            className: cls.class_name,
            checkInDate: '2026-01-01',
          },
        ],
      },
      {
        room: {
          sourceId: `${SRC_ID}-R2`,
          buildingName: '自检A栋',
          dormType: 1,
          dormNo: `E2E-${rnd}-102`,
          bedCount: 4,
          usedCount: 0,
        },
        residents: [],
      },
    ],
  };
  const r1 = await callSync('/sync', syncBody);
  check('sync 首推 code=200', isOk(r1), r1.json?.message || `code=${r1.json?.code}`);
  check(
    'sync 首推 failed=0（★必须断言并看 errors.reason）',
    r1.json?.data?.failed === 0,
    `failed=${r1.json?.data?.failed} ${JSON.stringify(r1.json?.data?.errors || [])}`,
  );
  check('sync 首推 inserted=2', r1.json?.data?.inserted === 2, `inserted=${r1.json?.data?.inserted}`);

  const room1 = await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE)
    .where({ source_id: `${SRC_ID}-R1` })
    .first();
  check('房间落库且 source_id 正确（幂等键）', !!room1, room1 ? `dorm_no=${room1.dorm_no}` : '未查到');
  const room2 = await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE)
    .where({ source_id: `${SRC_ID}-R2` })
    .first();

  // ★ 这是本批最关键的一条：老代码从不写 room_no，靠列默认 ''；
  //   统一表唯一索引 (room_no, dorm_no, edu_stage) 靠 dorm_no 区分才不撞
  if (USE_UNI) {
    check(
      '切读：room_no 与 dorm_no 同时有值（uk_dorm_room 三元组靠它区分）',
      !!room1 && String(room1.room_no || '') === String(room1.dorm_no || ''),
      `room_no=${room1?.room_no} dorm_no=${room1?.dorm_no}`,
    );
  }

  /* ---------- ② /sync 幂等：同一批再推一次 ---------- */
  console.log('\n-- ② /sync 幂等重推 --');
  const r2 = await callSync('/sync', syncBody);
  check('sync 重推 code=200', isOk(r2), r2.json?.message || `code=${r2.json?.code}`);
  check(
    'sync 重推 inserted=0（★幂等键生效，没静默翻倍）',
    r2.json?.data?.inserted === 0,
    `inserted=${r2.json?.data?.inserted}`,
  );
  const roomCount = await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE)
    .whereIn('source_id', [`${SRC_ID}-R1`, `${SRC_ID}-R2`])
    .count({ c: '*' })
    .first();
  check(
    'sync 重推后房间仍是 2 行（★没有静默翻倍）',
    Number(roomCount?.c) === 2,
    `count=${roomCount?.c}`,
  );

  /* ---------- ③ 住宿表房间指向列（rename 命门） ---------- */
  console.log('\n-- ③ 住宿表房间指向列 --');
  const live = await probe(dbCommon, SRC_ROOM, LIVE_T, STAGE)
    .where({ source_id: `${SRC_ID}-R1##${stu.student_no}` })
    .first();
  check('住宿记录落库', !!live, live ? `source_id=${live.source_id}` : '未查到');
  // ★ 2026-10-11 修的口径：住宿记录的 dorm_id/room_id 存**房间表本地 id**，
  //   不是 source_id。旧代码存 source_id → 床位视图/在住人数恒为 0（既有 bug）。
  check(
    `住宿记录 ${RID}=房间表本地 id（★不是 source_id，2026-10-11 已修口径）`,
    !!live && !!room1 && String(live[RID] || '') === String(room1.id),
    `${RID}=${live?.[RID]} room.id=${room1?.id} source_id=${SRC_ID}-R1`,
  );
  const stuDorm = await probe(db, SRC, STU_T, STAGE).where({ id: stu.id }).first();
  check(
    '★ 学生档案 dorm_id=房间表本地 id（与床位视图同一口径）',
    String(stuDorm?.dorm_id || '') === String(room1?.id),
    `dorm_id=${stuDorm?.dorm_id} room.id=${room1?.id}`,
  );
  check(
    `住宿记录 ${RNO} 有值且=房间 dorm_no`,
    !!live && String(live[RNO] || '') === `E2E-${rnd}-101`,
    `${RNO}=${live?.[RNO]}`,
  );

  /* ---------- ④ /room/list ---------- */
  console.log('\n-- ④ /room/list --');
  /**
   * ★ 2026-10-22：按关键词查 + 分页给足 ——
   *   原来写死 size=50 且不排序，库里房间一多（前面套件残留 + 演示数据），
   *   刚同步的房间就被挤出这 50 条 → 断言「查不到刚同步的房间 / 楼栋名为空」，
   *   实际功能是好的。用 keyword 精确查，避免依赖数据量。
   */
  const rl = await call(`/room/list?page=1&size=200&keyword=E2E-${rnd}`);
  check('room/list code=200', isOk(rl));
  const list = rl.json?.data?.list || [];
  check('room/list 能查到刚同步的房间', list.some((x) => x.dormNo === `E2E-${rnd}-101`), `共 ${list.length} 行`);
  const one = list.find((x) => x.dormNo === `E2E-${rnd}-101`);
  check('room/list 返回楼栋名', one?.buildingName === '自检A栋', `buildingName=${one?.buildingName}`);
  check('room/list 字段是驼峰（rowsToCamel 生效）', !!one && one.dormNo !== undefined && one.bedCount !== undefined);

  /* ---------- ⑤ /room/add 连建 3 间（uk_dorm_room 撞墙回归） ---------- */
  console.log('\n-- ⑤ /room/add 连建 3 间（★uk_dorm_room 撞墙回归）--');
  const addNos = [`E2E-${rnd}-201`, `E2E-${rnd}-202`, `E2E-${rnd}-203`];
  let addOk = 0;
  for (const dormNo of addNos) {
    const ra = await call('/room/add', {
      method: 'POST',
      body: { buildingName: '自检B栋', dormNo, bedCount: 4, dormType: 1 },
    });
    if (isOk(ra)) addOk += 1;
    else console.log(`     ${dormNo} 失败：${ra.json?.message}`);
  }
  check('room/add 连建 3 间全部成功（★三元组索引没撞）', addOk === 3, `${addOk}/3`);
  const built = await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE)
    .whereIn('dorm_no', addNos)
    .select('id', 'dorm_no');
  for (const b of built) reg(SRC_ROOM, ROOM_T, b.id);

  // 重复 dorm_no 应被业务闸门拦（不是唯一索引拦）
  const dupAdd = await call('/room/add', {
    method: 'POST',
    body: { buildingName: '自检B栋', dormNo: addNos[0], bedCount: 4 },
  });
  check('room/add 重复宿舍号被业务拦（code≠200）', !isOk(dupAdd), dupAdd.json?.message || '');

  /* ---------- ⑥ /room/update ---------- */
  console.log('\n-- ⑥ /room/update --');
  const target = built[0];
  const ru = await call('/room/update', {
    method: 'POST',
    body: { dormId: target.id, buildingName: '自检B栋改名', bedCount: 6 },
  });
  check('room/update code=200', isOk(ru), ru.json?.message || `code=${ru.json?.code}`);
  const afterUpd = await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE).where({ id: target.id }).first();
  check('room/update 楼栋名已改', afterUpd?.building_name === '自检B栋改名', `building_name=${afterUpd?.building_name}`);
  check('room/update 床位数已改', Number(afterUpd?.bed_count) === 6, `bed_count=${afterUpd?.bed_count}`);

  // 床位总数不能小于在住人数
  const ruLow = await call('/room/update', { method: 'POST', body: { dormId: target.id, bedCount: 0 } });
  check('room/update 床位数=0 被闸门拦（最小1）', !isOk(ruLow), ruLow.json?.message || '');

  const ruMiss = await call('/room/update', { method: 'POST', body: { dormId: 'NOT-EXIST', bedCount: 4 } });
  check('room/update 宿舍不存在报「宿舍不存在」', ruMiss.json?.message === '宿舍不存在', ruMiss.json?.message);

  /* ---------- ⑦ /live/list ---------- */
  console.log('\n-- ⑦ /live/list --');
  const ll = await call(`/live/list?page=1&size=50&keyword=${encodeURIComponent(stu.student_no)}`);
  check('live/list code=200', isOk(ll));
  const liveList = ll.json?.data?.list || [];
  check('live/list 按学号搜到该学员', liveList.some((x) => x.studentNo === stu.student_no), `共 ${liveList.length} 行`);
  const lv = liveList[0] || {};
  // ★ 切读后返回字段名也会跟着列名变（roomNo 而非 dormNo）——这是刻意设计
  const noKey = USE_UNI ? 'roomNo' : 'dormNo';
  check(
    `live/list 返回房间号字段 ${noKey}（切读后正名）`,
    String(lv[noKey] ?? '') === `E2E-${rnd}-101`,
    `${noKey}=${lv[noKey]} / 实际键=${Object.keys(lv).filter((k) => /no\$/i.test(k) || /No$/.test(k)).join(',')}`,
  );

  /* ---------- ⑧ /bed/list ---------- */
  console.log('\n-- ⑧ /bed/list --');
  const bl = await call(`/bed/list?dormId=${room1.id}`);
  check('bed/list code=200', isOk(bl));
  check('bed/list 返回 4 个床位', bl.json?.data?.beds?.length === 4, `实际 ${bl.json?.data?.beds?.length}`);
  // 床位标签走 shared-types 的 bedLabel()：奇数上铺、偶数下铺 → `宿舍号-床位号-上/下`
  check(
    'bed/list 床位标签=宿舍号-序号-上/下（★上下铺成对：1→1-上 2→1-下）',
    bl.json?.data?.beds?.[0]?.label === `E2E-${rnd}-101-1-上` && bl.json?.data?.beds?.[1]?.label === `E2E-${rnd}-101-1-下`,
    `${bl.json?.data?.beds?.[0]?.label} / ${bl.json?.data?.beds?.[1]?.label}`,
  );
  // /sync 只写dorm_id/dorm_no，不写 bed_no（宿位分配是教务另一张表的事）
  // → 此时该学员应落在 unassigned（历史数据待补齐），床位全部空着
  check(
    '/sync 不同步 bed_no → 床位暂未占用（落在 unassigned 待补齐）',
    (bl.json?.data?.beds || []).every((b) => !b.occupied) &&
      (bl.json?.data?.unassigned || []).some((u) => u.studentNo === stu.student_no),
    `occupied=${(bl.json?.data?.beds || []).filter((b) => b.occupied).length} unassigned=${(bl.json?.data?.unassigned || []).length}`,
  );
  const blMiss = await call('/bed/list?dormId=NOT-EXIST');
  check('bed/list 宿舍不存在报「宿舍不存在」', blMiss.json?.message === '宿舍不存在', blMiss.json?.message);

  // 手工补床位号 → 应变成「已占用」，验证占用态与未补齐清单两条分支
  await probe(db, SRC, STU_T, STAGE).where({ id: stu.id }).update({ bed_no: 2 });
  const bl2 = await call(`/bed/list?dormId=${room1.id}`);
  const occ2 = (bl2.json?.data?.beds || []).filter((b) => b.occupied);
  check(
    '★ 补bed_no=2 后该床位变已占用且 unassigned 清空',
    occ2.length === 1 && occ2[0].bedNo === 2 && occ2[0].studentNo === stu.student_no && (bl2.json?.data?.unassigned || []).length === 0,
    `occupied=${occ2.length} unassigned=${(bl2.json?.data?.unassigned || []).length}`,
  );

  /* ---------- ⑨ 换宿申请 → 审批 ---------- */
  console.log('\n-- ⑨ /apply/add + /apply/approve --');
  const aa = await call('/apply/add', {
    method: 'POST',
    body: {
      applyCategory: 1,
      studentId: stu.id,
      toDormId: room2.id, // ★ 房间表本地主键（前端传的就是这个）
      applyReason: `自检换宿${rnd}`,
    },
  });
  check('apply/add code=200', isOk(aa), aa.json?.message || `code=${aa.json?.code}`);
  const applyId = aa.json?.data?.applyId;
  const applyNo = aa.json?.data?.applyNo;
  check('apply/add 返回申请单号（HS 前缀）', String(applyNo || '').startsWith('HS'), `applyNo=${applyNo}`);
  if (applyId) reg(SRC, APPLY_T, applyId);

  if (!applyId) {
    console.log('\n⚠️ 申请单未创建成功，跳过后续审批链断言');
    await cleanup();
    for (const c of [db, dbCommon]) await c.destroy();
    const p2 = summary();
    killAll();
    return p2;
  }
  const applyRow = await probe(db, SRC, APPLY_T, STAGE).where({ id: applyId }).first();
  check('apply/add 原宿舍号带出来了（来自住宿表）', applyRow?.from_dorm_no === `E2E-${rnd}-101`, `from_dorm_no=${applyRow?.from_dorm_no}`);
  check('apply/add 目标宿舍号回查到了', applyRow?.to_dorm_no === `E2E-${rnd}-102`, `to_dorm_no=${applyRow?.to_dorm_no}`);

  // 未确认物品完好 → 拦
  const apNoGoods = await call('/apply/approve', { method: 'POST', body: { applyId, action: 'approve' } });
  check('apply/approve 未确认物品完好被拦', !isOk(apNoGoods), apNoGoods.json?.message || '');

  // 驳回：必须给原因
  const apNoReason = await call('/apply/approve', { method: 'POST', body: { applyId, action: 'reject' } });
  check('apply/approve 驳回未填原因被拦', !isOk(apNoReason), apNoReason.json?.message || '');

  const al = await call('/apply/list?page=1&size=50');
  check('apply/list code=200', isOk(al));
  check('apply/list 查到刚提交的申请', (al.json?.data?.list || []).some((x) => x.applyNo === applyNo), `共 ${al.json?.data?.list?.length} 行`);
  const alRow = (al.json?.data?.list || []).find((x) => x.applyNo === applyNo);
  // 字典里的原文是「待审核」（ApplyStatus.PENDING = 1// 待审核）
  check('apply/list 状态名=待审核', alRow?.applyStatusName === '待审核', `applyStatusName=${alRow?.applyStatusName}`);

  // 通过
  const apOk = await call('/apply/approve', {
    method: 'POST',
    body: { applyId, action: 'approve', opinion: '同意', hasGoodsChecked: true },
  });
  check('apply/approve 通过 code=200', isOk(apOk), apOk.json?.message || `code=${apOk.json?.code}`);

  const applyAfter = await probe(db, SRC, APPLY_T, STAGE).where({ id: applyId }).first();
  check('申请单状态已落库为「已通过」', Number(applyAfter?.apply_status) === 2, `apply_status=${applyAfter?.apply_status}`);

  const changeRow = await probe(db, SRC, CHANGE_T, STAGE)
    .where({ student_id: stu.id })
    .orderBy('create_time', 'desc')
    .first();
  check('★ 通过后自动写了调宿记录', !!changeRow, changeRow ? `to_dorm_no=${changeRow.to_dorm_no}` : '未查到');
  if (changeRow) reg(SRC, CHANGE_T, changeRow.id);

  const stuAfter = await probe(db, SRC, STU_T, STAGE).where({ id: stu.id }).first();
  check(
    '★ 学生档案宿舍号已改成目标房间',
    stuAfter?.dorm_no === `E2E-${rnd}-102`,
    `dorm_no=${stuAfter?.dorm_no}`,
  );

  const apAgain = await call('/apply/approve', {
    method: 'POST',
    body: { applyId, action: 'approve', hasGoodsChecked: true },
  });
  check('apply/approve 重复审批被拦', !isOk(apAgain), apAgain.json?.message || '');

  const cl2 = await call(`/change/list?page=1&size=50&studentId=${stu.id}`);
  check('change/list code=200', isOk(cl2));
  check('change/list 查到调宿记录', (cl2.json?.data?.list || []).length >= 1, `共 ${cl2.json?.data?.list?.length} 行`);

  /* ---------- ⑩ /bed/out 退宿 ---------- */
  console.log('\n-- ⑩ /bed/out 退宿 --');
  const bo = await call('/bed/out', { method: 'POST', body: { studentId: stu.id } });
  check('bed/out code=200', isOk(bo), bo.json?.message || `code=${bo.json?.code}`);
  const stuOut = await probe(db, SRC, STU_T, STAGE).where({ id: stu.id }).first();
  check('bed/out 学生宿舍号已清空', !stuOut?.dorm_id && !stuOut?.bed_no, `dorm_id=${stuOut?.dorm_id} bed_no=${stuOut?.bed_no}`);
  const bo2 = await call('/bed/out', { method: 'POST', body: { studentId: stu.id } });
  check('bed/out 无床位时再退被拦', !isOk(bo2), bo2.json?.message || '');

  /* ---------- ⑪ /sync 退宿清理（本次未出现的住宿记录软删） ---------- */
  console.log('\n-- ⑪ /sync 退宿清理 --');
  // 只推 R1（★R2 的住宿要被软删 =退宿清理）
  const r3 = await callSync('/sync', { ...syncBody, batchNo: `E2E-B2-${rnd}`, items: [syncBody.items[0]] });
  check('sync 第三推 code=200', isOk(r3), r3.json?.message || `code=${r3.json?.code}`);
  check(
    'sync 第三推 failed=0',
    r3.json?.data?.failed === 0,
    `failed=${r3.json?.data?.failed} errors=${JSON.stringify(r3.json?.data?.errors || [])}`,
  );
  check(
    'sync 第三推房间数仍为 2（★未被误删）',
    Number(
      (await probe(dbCommon, SRC_ROOM, ROOM_T, STAGE).whereIn('source_id', [`${SRC_ID}-R1`, `${SRC_ID}-R2`]).count({ c: '*' }).first())?.c,
    ) === 2,
  );

  /* ---------- ⑫ 同步表结构体检 ---------- */
  console.log('\n-- ⑫ 同步表结构体检（★统一表补列是否到位）--');
  if (USE_UNI) {
    const cols = await dbCommon.raw(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_uni_dorm_room'`,
    );
    const names = new Set((cols[0] || []).map((r) => r.name || r.COLUMN_NAME));
    for (const c of ['source_system', 'source_id', 'source_batch_no', 'source_update_time', 'sync_status', 'room_no', 'dorm_no']) {
      check(`t_uni_dorm_room 有列 ${c}`, names.has(c));
    }
    const idx = await dbCommon.raw(
      `SELECT INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols,
              MAX(NON_UNIQUE) AS nu
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_uni_dorm_room'
       GROUP BY INDEX_NAME`,
    );
    const uk = (idx[0] || []).find((r) => r.name === 'uk_dorm_room');
    // ★ ADD INDEX ≠ ADD UNIQUE INDEX：必须查 NON_UNIQUE 复核，否则一条重复都拦不住
    check('uk_dorm_room 确为唯一索引（NON_UNIQUE=0）', uk && Number(uk.nu) === 0, `NON_UNIQUE=${uk?.nu}`);
    // ★ P5 迁移 011 再加宽：jh 两栋楼各有 '2-01' 房 → 必须含 building_id（老表 uk_building_room_no 口径）
    check(
      'uk_dorm_room 已加宽为(building_id,dorm_no,room_no,edu_stage)（迁移 011）',
      String(uk?.cols) === 'building_id,dorm_no,room_no,edu_stage',
      `实际=${uk?.cols}`,
    );
  }

  /* ---------- 收尾 ---------- */
  await cleanup();
  for (const c of [db, dbCommon]) await c.destroy();
  const pass = summary();
  if (!pass) dumpBackendError(40);
  killAll();
  return pass;
}

main()
  .then((ok2) => process.exit(ok2 ? 0 : 1))
  .catch(async (e) => {
    console.error('\n💥 自检异常：', e.message);
    try {
      await cleanup();
    } catch {}
    dumpBackendError(50);
    killAll();
    process.exit(1);
  });
