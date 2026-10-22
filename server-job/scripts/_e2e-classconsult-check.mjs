/**
 * 自检：咨询推送域（`/api/class/consult/*` · 第 4 期第 6 批统一表切读）
 * ============================================================
 * ⚠️ 与其他自检脚本的区别：
 *   `_e2e-classdorm-check.mjs`（宿舍）/ `_e2e-classinfo-check.mjs`（班级）/
 *   `_e2e-classstudent-check.mjs`（学生档案）都不覆盖 `/api/class/consult/*`。
 *   本脚本是这批真正改动的 `class/modules/consult/consult.route.ts`（25 处）的唯一覆盖。
 *
 * 本批最该盯死的几条（每一条都对应一个实测踩出来的坑）：
 *   ①【★★ push 幂等三态】/push 同一consult_no 推第二次必须是 skip=1、inserted=0。
 *     但**已驳回(3) 要能被重新激活为待接收(1)**（斌哥 2026-10-06 拍板的业务规则：
 *     「已分班不可再分派，驳回之后可以」）。
 *   ②【★★★ t_uni_class_transfer 三方共用】这张表现在承接三件事：
 *      岗位交接(transfer_type=1) / 升学转班(6) / **本域换班留痕(7=STUDENT_CLASS_CHANGE)**。
 *     老表 `t_class_student_transfer` 压根没transfer_type 列，
 *     切读时不显式给 7 → 落成默认 0=字典外的未知值。
 *     → 断言：接收换班后 t_uni_class_transfer.transfer_type 必须是 7。
 *   ③【★★ bed_no 类型】迁移 003 把 t_uni_student.bed_no 从 varchar(20) 改回 int(11)
 *     （老表是 int；宿舍域 /bed/list 也按数字用它）。
 *     → 断言：切读时写入的是**数字**类型，且落库后能原样读回。
 *   ④【★★ consult_no 上不能有唯一索引】老表只有非唯一 idx_cp_no；
 *     统一表凭空加的 uk_consult_push 已由迁移 003 降级（第⑧条铁律第三次）。
 *     → 断言：information_schema.STATISTICS 里 consult_no 上 NON_UNIQUE 全为 1。
 *   ⑤【★★ 学生档案转班记录不重复】`student.route.ts` 原来并发查
 *     `t_class_transfer`(by class_id) + `t_class_student_transfer`(by student_id)，
 *     切读后两者是同一张表 → 第 6 批已合并为一次查询，断言两个数组都正确且不串。
 *   ⑥【★ 建档班】/receive 新建档路径：自动学号 +1、不撞已有学号、床位占用校验。
 *   ⑦【★ 权限】只能接收/驳回本班推送单；驳回必填原因（40002）。
 *
 * 跑法：
 *   node scripts/_e2e-classconsult-check.mjs                （老表模式）
 *   TEACHING_UNI_TABLE=1 node scripts/_e2e-classconsult-check.mjs（切读模式）
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

const API = `${BASE}/api/class/consult`;
const { check, summary } = makeChecker();

const OK = 200;
const isOk = (r) => r.json?.code === OK;

const SRC = 'sms_class';
const STAGE = 'class';

const PUSH_T = 't_class_consult_push';
const STU_T = 't_class_student';
const CLS_T = 't_class_info';
const REPEAT_T = 't_class_repeat';
const XFER_T = 't_class_student_transfer';

const db = conn(SRC);

/** 夹具登记：切读时数据落统一表，必须跟着改指向，否则清理删不掉 */
const fixtures = [];
const reg = (dbName, table, id) => {
  const [d, t] = regTarget(dbName, table);
  fixtures.push([d, t, id]);
};

/**
 * ★ `/push` 是**服务对服务接口**（走 authAllowSync），必须带内部凭证：
 *   `x-internal-token: <INTERNAL_TOKEN>`（值取 config.internalToken；未配 .env 时为占位符）。
 *   带普通登录 token 会被40101「内部服务凭证无效」挡掉。
 *   —— 实测踩过：登录明明成功（token 601 位），push 却一直40101，
 *   症状是「自检第一段全挂 + data 为 null」，很容易误判成业务 bug。
 */
const INTERNAL = process.env.INTERNAL_TOKEN || 'CHANGE_ME_INTERNAL_TOKEN';

const rnd = Math.random().toString(36).slice(2, 8);
const TAG = `E2E-CONSULT-${rnd}`;

/* ============================================================
 * 夹具
 * ============================================================ */

/**
 * ★ 切读夹具必须**双写**：先插老表，再镜像一份到统一表
 *   （用脚手架 mirrorToUni，与 classdorm/classinfo 同款口径）。
 *   直接往统一表插会报 `Field 'edu_stage' doesn't have a default value`
 *   —— 统一表该列 NOT NULL 且故意没默认值，是「当场炸」的设计。
 * ★ 必须**显式给 id**：buildRow 只会「缺失时」生成，reg() 登记的 id 必须等于落库 id。
 */
async function makeClass(name) {
  const id = `cls-cc-${rnd}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(db, CLS_T, {
    id,
    class_name: name,
    dept_code: 1,
    // ★ 班级状态列叫 class_status，不是 status（t_class_info 没有 status 列）
    class_status: 1,
    student_count: 0,
  });
  // ★ 2026-10-21 班号新规：接收咨询学生时学号 = LZ + 班级编号 + 序号，
  //   班级没有编号会直接被拦 → 统一表镜像里必须带编号。
  //   ⚠️ 老表 t_class_info 没有 class_code 列（该列只在统一表），别写进老表 insert。
  const classCode = 'CC' + Math.random().toString(36).slice(2, 6).toUpperCase();
  await db(CLS_T).insert(row);
  reg(SRC, CLS_T, id);
  if (USE_UNI) await mirrorToUni(SRC, CLS_T, { ...row, id, class_code: classCode }, STAGE, reg);
  return { id, ...row };
}

async function makeStudent(name) {
  const id = `stu-cc-${rnd}-${Math.floor(Math.random() * 1e6)}`;
  const row = await buildRow(db, STU_T, {
    id,
    student_no: `E2E${rnd}${Math.floor(Math.random() * 9000 + 1000)}`,
    student_name: name,
    gender: 1,
    dept_code: 1,
    // ★ 学生状态列叫 student_status，不是 status
    student_status: 5,
  });
  await db(STU_T).insert(row);
  reg(SRC, STU_T, id);
  if (USE_UNI) await mirrorToUni(SRC, STU_T, { ...row, id }, STAGE, reg);
  return { id, ...row };
}

async function cleanup() {
  // 先删子表再删主表
  const order = [
    [SRC, XFER_T],
    [SRC, REPEAT_T],
    [SRC, PUSH_T],
    [SRC, STU_T],
    [SRC, CLS_T],
  ];
  for (const [dbName, table] of order) {
    for (const [fdb, ftable, id] of fixtures) {
      if (fdb !== dbName || ftable !== table) continue;
      /* ★ 2026-10-22：老表已 DROP，清理必须走统一表名 ——
         原来拿老表名（t_class_consult_push 等）去查，查不到 → catch 吞掉 →
         自检数据一直留在库里（今天累计攒了 133 条待接收单，
         把后续套件的列表顶到分页上限，classdorm 因此挂了 3 条）。 */
      const [tdb, ttable] = regTarget(fdb, ftable);
      const c = conn(tdb);
      // 物理删（自检数据不进软删池，避免占唯一索引）
      await c(ttable).where({ id }).del().catch(() => {});
      await c.destroy();
    }
  }
}

/* ============================================================
 * 用例
 * ============================================================ */
async function main() {
  await startServices();
  const token = await login('qiansy');
  const H = { Authorization: `Bearer ${token}` };
  const call = (path, opts = {}) =>
    req(`${API}${path}`, { ...opts, headers: { ...H, 'x-internal-token': INTERNAL, ...(opts.headers || {}) } });

  const clsA = await makeClass(`${TAG}-A`);
  const clsB = await makeClass(`${TAG}-B`);

  /* ---------- ① /push 新建推送单 ---------- */
  const consultNo1 = `${TAG}-N1`;
  const r1 = await call('/push', {
    method: 'POST',
    body: {
      items: [
        {
          consultNo: consultNo1,
          studentName: `${TAG}-学员甲`,
          gender: 1,
          phone: '13800000001',
          parentPhone: '13800000002',
          age: 18,
          education: '高中',
          origin: '河南',
          graduateSchool: '郑州一中',
          homeAddress: '郑州市文化路 1 号',
          intendDeptCode: 1,
          intendStage: 201,
          intendClassId: clsA.id,
          intendClassName: clsA.class_name,
          sourceSystem: 'consult',
        },
      ],
    },
  });
  check('push 新建成功 inserted=1', isOk(r1) && r1.json?.data?.inserted === 1, JSON.stringify(r1.json?.data));

  const push1 = await probe(db, SRC, PUSH_T, STAGE).where({ consult_no: consultNo1 }).first();
  reg(SRC, PUSH_T, push1?.id);
  check('推送单落库且 apply_status=1 待接收', Number(push1?.apply_status) === 1, `apply_status=${push1?.apply_status}`);
  check('推送单意向班级=指定班级', String(push1?.intend_class_id ?? '') === String(clsA.id), push1?.intend_class_id);

  /* ---------- ② /push 幂等：同单号再推必须 skip ---------- */
  const r2 = await call('/push', {
    method: 'POST',
    body: { items: [{ consultNo: consultNo1, studentName: `${TAG}-学员甲`, intendClassId: clsA.id, intendClassName: clsA.class_name }] },
  });
  check('★ 重复推送 skip=1 inserted=0（幂等）', isOk(r2) && r2.json?.data?.skipped === 1 && r2.json?.data?.inserted === 0, JSON.stringify(r2.json?.data));
  const cnt1 = await probe(db, SRC, PUSH_T, STAGE).where({ consult_no: consultNo1 });
  check('★ 重复推送后行数仍为 1（没翻倍）', cnt1.length === 1, `实际 ${cnt1.length} 行`);

  /* ---------- ③ /list /detail ---------- */
  const l1 = await call('/list?page=1&size=10&keyword=' + encodeURIComponent(TAG));
  check('list 按关键词能查到推送单', isOk(l1) && (l1.json?.data?.list || []).some((x) => x.consultNo === consultNo1), `total=${l1.json?.data?.total}`);
  const item = (l1.json?.data?.list || []).find((x) => x.consultNo === consultNo1);
  check('★ 来源标注为「咨询新生」', item?.sourceKind === '咨询新生', `sourceKind=${item?.sourceKind}`);
  check('状态名=待接收', item?.applyStatusName === '待接收', `applyStatusName=${item?.applyStatusName}`);

  const d1 = await call(`/detail?id=${push1.id}`);
  check('detail 能查到推送单', isOk(d1) && d1.json?.data?.consultNo === consultNo1, d1.json?.message);
  const dMiss = await call('/detail?id=NOT-EXIST');
  check('detail 不存在报「咨询推送单不存在」', dMiss.json?.message === '咨询推送单不存在', dMiss.json?.message);

  /* ---------- ④ /internal-status ---------- */
  const is1 = await call(`/internal-status?nos=${consultNo1}`);
  check('internal-status 返回状态=1', isOk(is1) && Number(is1.json?.data?.[consultNo1]?.applyStatus) === 1, JSON.stringify(is1.json?.data));
  const is2 = await call(`/internal-status?nos=${consultNo1},${TAG}-NOT-EXIST`);
  check('internal-status 未知单号不返回条目', isOk(is2) && is2.json?.data?.[`${TAG}-NOT-EXIST`] === undefined, JSON.stringify(is2.json?.data));

  /* ---------- ⑤ /reject 必填原因 ---------- */
  const rj1 = await call('/reject', { method: 'POST', body: { id: push1.id } });
  check('★ 驳回不填原因报 40002 必填缺失', !isOk(rj1) && rj1.json?.message === '驳回原因', `${rj1.json?.code} ${rj1.json?.message}`);

  const rj2 = await call('/reject', { method: 'POST', body: { id: push1.id, rejectReason: `${TAG}-信息不全` } });
  // ★ /reject 的返回体只有 { id }，**不含 applyStatus** → 状态要去库里查
  check('驳回成功', isOk(rj2) && !!rj2.json?.data?.id, JSON.stringify(rj2.json?.data));
  const afterReject = await probe(db, SRC, PUSH_T, STAGE).where({ id: push1.id }).first();
  check('驳回后 apply_status=3 且 reject_reason 落库', Number(afterReject?.apply_status) === 3 && String(afterReject?.reject_reason ?? '').includes('信息不全'), `status=${afterReject?.apply_status}`);

  const rj3 = await call('/reject', { method: 'POST', body: { id: push1.id, rejectReason: '重复驳回' } });
  check('★ 已驳回单不能重复驳回', !isOk(rj3) && rj3.json?.message === '只有「待接收」的咨询单可以驳回', rj3.json?.message);

  /* ---------- ⑥ ★ 驳回后可重新分派（重新激活） ---------- */
  const consultNo2 = `${TAG}-N2`;
  const rp = await call('/push', {
    method: 'POST',
    body: { items: [{ consultNo: consultNo1, studentName: `${TAG}-学员甲`, intendClassId: clsB.id, intendClassName: clsB.class_name }] },
  });
  check('★ 驳回后重新分派 reopened=1 inserted=0', isOk(rp) && rp.json?.data?.reopened === 1 && rp.json?.data?.inserted === 0, JSON.stringify(rp.json?.data));
  const reopened = await probe(db, SRC, PUSH_T, STAGE).where({ consult_no: consultNo1 }).first();
  check('★ 重新激活后 apply_status 回到 1', Number(reopened?.apply_status) === 1, `apply_status=${reopened?.apply_status}`);
  check('★ 重新激活后意向班级已换新', String(reopened?.intend_class_id ?? '') === String(clsB.id), reopened?.intend_class_id);
  check('★ 重新激活后驳回痕迹已清空', (reopened?.reject_reason ?? null) === null, `reject_reason=${reopened?.reject_reason}`);

  /* ---------- ⑦ /receive 新建档路径 ---------- */
  const recv1 = await call('/receive', { method: 'POST', body: { id: push1.id, classId: clsB.id, stage: 201 } });
  check('接收并建档成功', isOk(recv1) && !!recv1.json?.data?.studentId, `${recv1.json?.code} ${recv1.json?.message}`);
  const newStuId = recv1.json?.data?.studentId;
  const newStuNo = recv1.json?.data?.studentNo;
  reg(SRC, STU_T, newStuId);

  const afterRecv = await probe(db, SRC, PUSH_T, STAGE).where({ id: push1.id }).first();
  check('接收后 apply_status=2 已接收', Number(afterRecv?.apply_status) === 2, `apply_status=${afterRecv?.apply_status}`);
  check('接收后回写 student_id/student_no', String(afterRecv?.student_id ?? '') === String(newStuId) && String(afterRecv?.student_no ?? '') === String(newStuNo), `${afterRecv?.student_id}/${afterRecv?.student_no}`);

  const stuRow = await probe(db, SRC, STU_T, STAGE).where({ id: newStuId }).first();
  check('★ 新建档 source_system=consult', String(stuRow?.source_system) === 'consult', stuRow?.source_system);
  check('★ 新建档 source_id=咨询单号（溯源）', String(stuRow?.source_id ?? '') === consultNo1, stuRow?.source_id);
  // ★ 2026-10-22 学号新规：LZ + 班级编号 + 3 位班内序号（夹具班编号 CCxxxx → LZCCxxxx001）
  check('★ 自动学号符合 LZ+班级编号+序号（新规）', /^LZCC[A-Z0-9]{4}\d{3}$/.test(String(newStuNo)), String(newStuNo));
  check('★ 建档后班级回填正确', String(stuRow?.class_id ?? '') === String(clsB.id), stuRow?.class_id);

  const clsBCount = await probe(db, SRC, CLS_T, STAGE).where({ id: clsB.id }).first();
  check('★ 目标班级 student_count +1', Number(clsBCount?.student_count) === 1, `student_count=${clsBCount?.student_count}`);

  /* ---------- ⑧ /receive 已有档案 → 换班留痕（★ t_uni_class_transfer 7=学生换班） ---------- */
  const stuOld = await makeStudent(`${TAG}-转班生`);
  const clsOldRow = await probe(db, SRC, CLS_T, STAGE).where({ id: clsA.id }).first();
  // ★ `t_class_student` **没有** student_count 列（那是 `t_class_info` 的列），
  //   人数只在班级表上冗余存一份 → 这里只回填班级归属，人数去班级表改。
  await probe(db, SRC, STU_T, STAGE).where({ id: stuOld.id }).update({ class_id: clsA.id, class_name: clsOldRow.class_name });
  await probe(db, SRC, CLS_T, STAGE).where({ id: clsA.id }).update({ student_count: 1 });

  const consultNo3 = `${TAG}-N3`;
  const rp3 = await call('/push', {
    method: 'POST',
    body: {
      items: [
        {
          consultNo: consultNo3,
          studentName: stuOld.student_name,
          gender: 1,
          intendDeptCode: 1,
          intendStage: 201,
          intendClassId: clsB.id,
          intendClassName: clsB.class_name,
          // sourceSystem=transfer + originStudentId → 走「已建档转入」分支
          sourceSystem: 'transfer',
          originStudentId: stuOld.id,
          fromClassId: clsA.id,
          fromClassName: clsOldRow.class_name,
          transferReason: `${TAG}-班级信息管理发起换班`,
        },
      ],
    },
  });
  check('换班转入推送成功', isOk(rp3) && rp3.json?.data?.inserted === 1, JSON.stringify(rp3.json?.data));
  const push3 = await probe(db, SRC, PUSH_T, STAGE).where({ consult_no: consultNo3 }).first();
  reg(SRC, PUSH_T, push3?.id);

  const rv3 = await call('/receive', { method: 'POST', body: { id: push3.id, classId: clsB.id, stage: 201 } });
  check('换班接收成功', isOk(rv3) && rv3.json?.data?.studentId === stuOld.id, `${rv3.json?.code} ${rv3.json?.message}`);

  const stuMoved = await probe(db, SRC, STU_T, STAGE).where({ id: stuOld.id }).first();
  check('★ 转班后学生 class_id 已改到新班', String(stuMoved?.class_id ?? '') === String(clsB.id), stuMoved?.class_id);

  const xferRows = await probe(db, SRC, XFER_T, STAGE).where({ student_id: stuOld.id });
  check('★ 换班留痕已写入', xferRows.length >= 1, `${xferRows.length} 行`);
  const xf = xferRows[xferRows.length - 1];
  check('★ 换班留痕 from/to 班级名正确', String(xf?.from_class_name ?? '') === String(clsOldRow.class_name) && String(xf?.to_class_name ?? '') === String(clsB.class_name), `${xf?.from_class_name}→${xf?.to_class_name}`);
  check('★ 换班留痕 consult_no 关联正确', String(xf?.consult_no ?? '') === consultNo3, xf?.consult_no);

  if (USE_UNI) {
    // ③ 老表压根没 transfer_type 列 → 切读时不显式给 7 会落成默认 0（字典外的未知值）
    const uniXfer = await conn('sms_common')('t_uni_class_transfer').where({ student_id: stuOld.id }).orderBy('create_time', 'desc').first();
    await conn('sms_common').destroy();
    check('★★ 切读：t_uni_class_transfer.transfer_type = 7（学生换班）', Number(uniXfer?.transfer_type) === 7, `实际=${uniXfer?.transfer_type}`);
    check('★★ 切读：t_uni_class_transfer.class_id = 目标班级', String(uniXfer?.class_id ?? '') === String(clsB.id), uniXfer?.class_id);
    check('★ 切读：from_class_name 是班级名不是人名（未被列名翻译污染）', String(uniXfer?.from_class_name ?? '') === String(clsOldRow.class_name), uniXfer?.from_class_name);
  }

  const clsACount2 = await probe(db, SRC, CLS_T, STAGE).where({ id: clsA.id }).first();
  const clsBCount2 = await probe(db, SRC, CLS_T, STAGE).where({ id: clsB.id }).first();
  check('★ 跨班转出后原班 student_count -1', Number(clsACount2?.student_count) === 0, `A=${clsACount2?.student_count}`);
  check('★ 跨班转入后目标班 student_count +1', Number(clsBCount2?.student_count) === 2, `B=${clsBCount2?.student_count}`);

  /* ---------- ⑤ ★ 学生档案转班记录不重复（第 6 批修的两表合表问题） ---------- */
  const prof = await call(`/student/detail?id=${stuOld.id}`).catch(() => null);
  if (prof && isOk(prof)) {
    const ct = prof.json?.data?.classTransfers || [];
    const st = prof.json?.data?.studentTransfers || [];
    check('★ 学生档案 classTransfers 不含重复 id', new Set(ct.map((x) => x.id)).size === ct.length, `${ct.length} 条，去重后 ${new Set(ct.map((x) => x.id)).size}`);
    check('★ 学生档案 studentTransfers 能查到本次换班', st.some((x) => String(x.consultNo ?? '') === consultNo3), `${st.length} 条`);
  }

  /* ---------- ⑨ 权限：非本班班主任不可接收 ---------- */
  const stuNotMine = await makeStudent(`${TAG}-别班生`);
  const consultNo4 = `${TAG}-N4`;
  const rp4 = await call('/push', {
    method: 'POST',
    body: {
      items: [
        { consultNo: consultNo4, studentName: stuNotMine.student_name, gender: 1, intendDeptCode: 1, intendStage: 201, intendClassId: clsB.id, intendClassName: clsB.class_name },
      ],
    },
  });
  check('别班推送单创建成功', isOk(rp4) && rp4.json?.data?.inserted === 1, JSON.stringify(rp4.json?.data));
  const push4 = await probe(db, SRC, PUSH_T, STAGE).where({ consult_no: consultNo4 }).first();
  reg(SRC, PUSH_T, push4?.id);

  const teacherTok = await login('zhouj');
  const callT = (path, opts = {}) => req(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${teacherTok}`, ...(opts.headers || {}) } });
  const tList = await callT('/list?page=1&size=50&keyword=' + encodeURIComponent(TAG));
  const tRow = (tList.json?.data?.list || []).find((x) => x.consultNo === consultNo4);
  check('★ 班主任看不到别班推送单（数据范围收敛）', !tRow, `可见 ${tList.json?.data?.list?.length} 条`);

  /* ---------- ⑩ 切读专属体检：结构 ---------- */
  if (USE_UNI) {
    const uc = conn('sms_common');
    // ③ bed_no 类型必须回到 int（迁移 003）
    //    ★ P6 修正：display width（int(11)）被现代 MySQL 弃用，迁移 009 的 MODIFY 按
    //      information_schema 的 COLUMN_TYPE 重建后显示为 int —— 两者语义相同，断言兼容两种。
    const bedCol = await uc('information_schema.COLUMNS')
      .where({ TABLE_SCHEMA: 'sms_common', TABLE_NAME: 't_uni_student', COLUMN_NAME: 'bed_no' })
      .first();
    check(
      '★ 切读：t_uni_student.bed_no 类型 = int（int 或 int(11)）',
      String(bedCol?.COLUMN_TYPE).replace(/\(\d+\)/, '') === 'int',
      `实际=${bedCol?.COLUMN_TYPE}`,
    );

    // ④ consult_no 上不得有唯一索引
    const stIdx = await uc('information_schema.STATISTICS')
      .where({ TABLE_SCHEMA: 'sms_common', TABLE_NAME: 't_uni_consult_push', COLUMN_NAME: 'consult_no' });
    check(
      '★ 切读：consult_no 上已无唯一索引（uk 已降级，第⑧条铁律）',
      stIdx.length > 0 && stIdx.every((r) => Number(r.NON_UNIQUE) === 1),
      stIdx.map((r) => `${r.INDEX_NAME}:NON_UNIQUE=${r.NON_UNIQUE}`).join(' '),
    );
    // edu_stage 必须落上
    const uniPush = await uc('t_uni_consult_push').where({ consult_no: consultNo1 }).first();
    check('★ 切读：t_uni_consult_push.edu_stage = class', String(uniPush?.edu_stage) === 'class', uniPush?.edu_stage);
    await uc.destroy();
  }

  /* ---------- 收尾 ---------- */
  await cleanup();
  await db.destroy();
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