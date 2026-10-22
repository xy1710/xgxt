/**
 * ★ 演示数据重置脚本（标准版）
 * 清空 sms_job + sms_class 两库业务表，按现有规则重造：
 *   6 班 Q1~Q6（大学一~六阶段）· 30 学生 · 5 岗位齐全 · 宿舍分配
 * 用法：node scripts/reset-demo-data.cjs
 *
 * ★ P8（2026-10-19）：教学域老表已 DROP。本脚本按老表列名重建演示数据，
 *   因此流程改为「临时重建老表 → 重建演示数据 → 全量搬迁进统一表 → 清除临时老表」。
 *   （重建 → 搬迁 缺一不可：只写老表的话，产品读统一表会看到空数据。）
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const pathMod = require('path');

const runNode = (script, ...args) =>
  spawnSync(process.execPath, [pathMod.join(__dirname, script), ...args], { stdio: 'inherit' });

const DB = { host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'sms_job' };
if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD is required; configure server-job/.env');

const DEPT_UNIV = 2; // 大学部
const ST_TRIAL = 3, ST_ACTIVE = 5, ST_SUSPEND = 6, ST_QUIT = 7;

// 人员（角色扩充：班主任4 / 教员2 / 助教2 / 项目经理4 / 就业老师4）
const P = {
  headT001: ['T001', '李婉宁'], headT002: ['T002', '王寒逸'], headT003: ['T003', '赵晓雅'], headT004: ['T004', '周建国'],
  teacher1: ['T101', '张教员'], teacher2: ['T102', '刘教员'],
  assist1: ['T103', '李助教'], assist2: ['T104', '陈助教'],
  pmP001: ['P001', '马志斌'], pmP002: ['P002', '陈文展'], pmP003: ['P003', '吴明轩'], pmP004: ['P004', '林俊杰'],
  jobJ001: ['J001', '齐晋霄'], jobJ002: ['J002', '张砚'], jobJ003: ['J003', '王静'], jobJ004: ['J004', '刘洋'],
};

// 宿舍房间（room_sync 里已存在 D1~D8）：男 type1 / 女 type2
const ROOMS = {
  D1: { no: '301', type: 1, cap: 4 }, D2: { no: '302', type: 1, cap: 4 }, D3: { no: '303', type: 1, cap: 4 }, D7: { no: '401', type: 1, cap: 4 },
  D4: { no: '201', type: 2, cap: 4 }, D5: { no: '202', type: 2, cap: 4 }, D6: { no: '203', type: 2, cap: 2 }, D8: { no: '402', type: 2, cap: 4 },
};

// 6 个班：班名 / 阶段 / 班主任 / 教员 / 助教 / 项目经理 / 就业老师 / 学生 [姓名,性别,年龄,状态]
const CLASSES = [
  { name: 'Q1', stage: 201, head: P.headT001, teacher: P.teacher1, assist: P.assist1, pm: P.pmP001, job: P.jobJ001, room: 'A101', students: [
    ['张子轩', 1, 18, ST_ACTIVE], ['李子涵', 2, 19, ST_ACTIVE], ['王子墨', 1, 18, ST_ACTIVE], ['刘雨桐', 2, 19, ST_ACTIVE], ['陈思远', 1, 18, ST_ACTIVE]] },
  { name: 'Q2', stage: 202, head: P.headT002, teacher: P.teacher1, assist: P.assist1, pm: P.pmP001, job: P.jobJ001, room: 'A102', students: [
    ['杨静怡', 2, 19, ST_ACTIVE], ['赵一鸣', 1, 18, ST_ACTIVE], ['孙浩然', 1, 19, ST_ACTIVE], ['周晓彤', 2, 18, ST_ACTIVE], ['吴子豪', 1, 19, ST_SUSPEND]] },
  { name: 'Q3', stage: 203, head: P.headT003, teacher: P.teacher1, assist: P.assist2, pm: P.pmP002, job: P.jobJ002, room: 'A103', students: [
    ['郑凯文', 1, 18, ST_ACTIVE], ['林欣怡', 2, 19, ST_ACTIVE], ['黄子睿', 1, 18, ST_ACTIVE], ['徐天佑', 1, 19, ST_QUIT], ['冯雪晴', 2, 18, ST_TRIAL]] },
  { name: 'Q4', stage: 204, head: P.headT004, teacher: P.teacher2, assist: P.assist1, pm: P.pmP002, job: P.jobJ002, room: 'A104', students: [
    ['马志远', 1, 18, ST_ACTIVE], ['何静宜', 2, 19, ST_ACTIVE], ['高远航', 1, 18, ST_ACTIVE], ['邓雨欣', 2, 19, ST_QUIT], ['罗佳怡', 2, 18, ST_ACTIVE]] },
  { name: 'Q5', stage: 205, head: P.headT001, teacher: P.teacher2, assist: P.assist2, pm: P.pmP003, job: P.jobJ003, room: 'A105', students: [
    ['陈嘉豪', 1, 18, ST_ACTIVE], ['梁诗涵', 2, 19, ST_ACTIVE], ['唐俊杰', 1, 18, ST_ACTIVE], ['苏雅雯', 2, 19, ST_ACTIVE], ['谢铭轩', 1, 18, ST_ACTIVE]] },
  { name: 'Q6', stage: 206, head: P.headT002, teacher: P.teacher2, assist: P.assist1, pm: P.pmP004, job: P.jobJ004, room: 'A106', students: [
    ['郭子睿', 1, 18, ST_ACTIVE], ['袁梦琪', 2, 19, ST_ACTIVE], ['蒋天乐', 1, 18, ST_ACTIVE], ['方语嫣', 2, 19, ST_ACTIVE], ['廖思远', 1, 18, ST_ACTIVE]] },
];

(async () => {
  const log = [];
  /* ★ P8：先把空壳老表建出来（脚本下面全是按老表列名写的 SQL） */
  log.push('→ 临时重建教学域老表…');
  if (runNode('_uni-recreate-legacy.mjs').status !== 0) {
    log.push('✗ 临时老表重建失败（检查 exports/p8-final-backup）');
    require('fs').writeFileSync('D:/_seed2.txt', log.join('\n'));
    process.exit(1);
  }

  const c = await mysql.createConnection(DB);
  let ok = false;
  try {
    await c.beginTransaction();

    // ① 清空两库业务表（保留 knex_migrations）
    for (const db of ['sms_job', 'sms_class']) {
      const [tables] = await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME NOT LIKE "knex%"', [db]);
      for (const t of tables) {
        const [r] = await c.query(`DELETE FROM ${db}.${t.TABLE_NAME}`);
        log.push(`清空 ${db}.${t.TABLE_NAME}: ${r.affectedRows}`);
      }
    }
    await c.query('DELETE FROM sms_common.t_class_dorm_live_sync');
    log.push('清 sms_common.t_class_dorm_live_sync');

    // ② 造 6 班 + 30 学生 + 宿舍
    let sno = 20260001;
    const bedCursor = {};
    for (const cl of CLASSES) {
      const clsId = randomUUID();
      const now = new Date();
      await c.query(
        `INSERT INTO sms_class.t_class_info
          (id, create_time, create_by, is_deleted, class_name, dept_code, stage,
           head_teacher_id, head_teacher_name, teacher_id, teacher_name,
           assistant_id, assistant_name, project_manager_id, project_manager_name,
           employment_teacher_id, employment_teacher_name, university_no,
           class_status, student_count, room, open_date)
         VALUES (?,?,?,0, ?,?,?, ?,?, ?,?, ?,?, ?,?, ?,?, ?, 1, ?, ?, ?)`,
        [clsId, now, 'SYSTEM', cl.name, DEPT_UNIV, cl.stage,
         cl.head[0], cl.head[1], cl.teacher[0], cl.teacher[1],
         cl.assist[0], cl.assist[1], cl.pm[0], cl.pm[1],
         cl.job[0], cl.job[1], cl.name,
         cl.students.length, cl.room, '2026-09-01'],
      );

      for (const [name, gender, age, status] of cl.students) {
        const no = `S${sno++}`;
        const sid = randomUUID();
        let dormId = null, dormNo = null, bedNo = null;
        if (status !== ST_QUIT) {
          const type = gender === 2 ? 2 : 1;
          let rid = null;
          for (const [k, r] of Object.entries(ROOMS)) {
            if (r.type !== type) continue;
            const used = bedCursor[`${type}_${k}`] || 0;
            if (used < r.cap) { rid = k; bedCursor[`${type}_${k}`] = used + 1; break; }
          }
          if (rid) { dormId = rid; dormNo = ROOMS[rid].no; bedNo = String(bedCursor[`${type}_${rid}`]); }
        }
        await c.query(
          `INSERT INTO sms_class.t_class_student
            (id, create_time, create_by, is_deleted, student_no, student_name,
             gender, age, dept_code, student_status, stage, class_id, class_name,
             head_teacher_id, head_teacher_name, dorm_id, dorm_no, bed_no, phone, education, enroll_date)
           VALUES (?,?,?,0, ?,?, ?,?, ?,?, ?,?,?, ?,?, ?,?,?, ?,?,?)`,
          [sid, now, 'SYSTEM', no, name, gender, age, DEPT_UNIV, status, cl.stage, clsId, cl.name,
           cl.head[0], cl.head[1], dormId, dormNo, bedNo, `138${String(sno).padStart(8, '0')}`, '高中', '2026-09-01'],
        );
        if (dormId) {
          await c.query(
            `INSERT INTO sms_common.t_class_dorm_live_sync
              (id, create_time, create_by, is_deleted, source_system, source_id, source_batch_no, source_update_time, sync_status,
               student_id, student_no, student_name, class_id, class_name, dorm_id, dorm_no, check_in_date)
             VALUES (?,NOW(),'SYSTEM',0,'edu',?,?,NOW(),2, ?,?,?, ?,?, ?,?, '2026-09-01')`,
            ['LIVE_' + no, `${dormId}##STU_${no}`, 'EDU-20261004', sid, no, name, clsId, cl.name, dormId, dormNo],
          );
        }
      }
      log.push(`建班 ${cl.name} stage=${cl.stage} 班主任=${cl.head[1]} PM=${cl.pm[1]} 就业=${cl.job[1]}`);
    }

    await c.commit();
    ok = true;
    log.push('✓ 完成：6 班 30 学生 + 宿舍分配 + 角色扩充');
  } catch (e) {
    await c.rollback();
    log.push('✗ 失败已回滚：' + e.message);
  } finally {
    await c.end();
    /* ★ P8：把老表里的演示数据全量搬进统一表（产品只读统一表），然后清除临时老表。
       ⚠️ 本脚本语义就是「重置」——搬迁脚本会先清空统一表再全量搬，符合预期。 */
    if (ok) {
      log.push('→ 全量搬迁进统一表…');
      const mig = runNode('_uni-migrate-p5.mjs');
      log.push(mig.status === 0 ? '✓ 统一表已同步' : '✗ 统一表同步失败（可手动跑 node scripts/_uni-migrate-p5.mjs）');
    }
    log.push('→ 清除临时老表…');
    const drop = runNode('_uni-recreate-legacy.mjs', '--drop');
    log.push(drop.status === 0 ? '✓ 临时老表已清除' : '✗ 临时老表清除失败（可手动跑 --drop）');

    require('fs').writeFileSync('D:/_seed2.txt', log.join('\n'));
  }
})();
