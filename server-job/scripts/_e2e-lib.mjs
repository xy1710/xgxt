import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
/**
 * 端到端自检共享脚手架（第 2 期各域共用）
 * ============================================================
 *
 * 【为什么要抽出来】
 *   7 个域每个都要写自检脚本，如果每个都抄一遍启服务/HTTP/断言/清理，
 *   那又是新的重复（我们正在消灭的那种）。这里收一处。
 *
 * 【内置的一个关键容错】
 *   `freePorts()` —— **启动前先清掉 8004 / 5173 上的残留进程**。
 *   踩过的坑：上一轮自检异常退出会留下孤儿进程占着端口，
 *   下一轮 `waitFor` 会连到那个旧进程上 → 表现为"服务就绪但接口全挂"，
 *   而且极难看出是端口被占。所以每轮启动前先清。
 *
 * 用法见 scripts/_e2e-attendance-check.mjs / _e2e-exam-check.mjs。
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
export const knex = require('knex');

export const ROOT = path.resolve(process.cwd(), '..');
export const NODE = process.execPath;
export const PASS = '123456';
/** 经前端代理访问，顺带验证 Vite proxy 配好了 */
export const BASE = 'http://127.0.0.1:5173';

const NETSTAT = process.platform === 'win32' ? 'C:/Windows/System32/netstat.exe' : 'netstat';
const TASKKILL = process.platform === 'win32' ? 'C:/Windows/System32/taskkill.exe' : null;

/* ============================================================
 * 进程管理
 * ============================================================ */

const procs = [];

export function launch(cwd, args, tag, envOverride = null) {
  const p = spawn(NODE, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(envOverride ? { env: envOverride } : {}),
  });
  let out = '';
  let err = '';
  // ⚠️ 必须把 stdout 也消费掉：管道缓冲写满后子进程会**卡死在启动阶段**，
  //    现象是「服务怎么都起不来」，但单独手动起又完全正常 —— 极难排查。
  p.stdout.on('data', (c) => (out += c.toString()));
  p.stderr.on('data', (c) => (err += c.toString()));
  p.on('error', (e) => (err += 'SPAWN ERROR: ' + e.message));
  procs.push({ p, tag, out: () => out, err: () => err });
  return p;
}

/**
 * 前端专用启动参数
 *
 * ★ 必须清掉 PORT：本脚本会 `dotenv.config()` 把 .env 灌进 process.env
 *   （里面有 PORT=8004），而 `vite.config.ts` 的端口是
 *   `Number(process.env.FRONTEND_PORT || process.env.PORT || 5173)` ——
 *   子进程继承后会**把前端起在后端端口上**，现象是
 *   「后端就绪 true、前端就绪 false，所有接口全挂」，极难看出是被环境变量带的。
 */
export function frontendEnv() {
  const env = { ...process.env, FRONTEND_PORT: '5173' };
  delete env.PORT;
  return env;
}

/** 启动失败时把两个服务的日志打出来，避免"只看到 ❌ 不知道为什么" */
export function dumpLogs() {
  for (const { tag, out, err } of procs) {
    const o = out().trim();
    const e = err().trim();
    if (o) console.log(`--- ${tag} stdout(尾) ---\n${o.split('\n').slice(-12).join('\n')}`);
    if (e) console.log(`--- ${tag} stderr(尾) ---\n${e.split('\n').slice(-12).join('\n')}`);
  }
}

/** 清掉指定端口上的监听进程（防止上一轮孤儿把这一轮带偏） */
export function freePorts(ports = [8004, 5173]) {
  const out = spawnSync(NETSTAT, ['-ano'], { encoding: 'utf8' }).stdout || '';
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    if (!ports.some((pt) => line.includes(`:${pt} `) || line.endsWith(`:${pt}`))) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    if (TASKKILL) spawnSync(TASKKILL, ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  }
  return [...pids];
}

export function killAll() {
  for (const { p } of procs) {
    if (!p.pid) continue;
    try {
      if (TASKKILL) spawnSync(TASKKILL, ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else p.kill('SIGKILL');
    } catch {}
  }
}

export function stderrOf(tag) {
  const t = procs.find((x) => x.tag === tag);
  return t ? t.err() : '';
}

/* ============================================================
 * HTTP
 * ============================================================ */

export function req(url, { method = 'GET', body = null, token = null, headers: extra = null, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    // ★ 服务对服务接口（/sync、/push）走 authAllowSync，要带 x-internal-token，
    //   否则 40101「内部服务凭证无效」→ 自检会误判成业务 bug
    if (extra) Object.assign(headers, extra);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(d);
          } catch {
            /* HTML（说明代理没转发） */
          }
          resolve({ status: res.statusCode, json, raw: d });
        });
      },
    );
    r.on('error', (e) => resolve({ status: 0, json: null, raw: 'ERR ' + e.message }));
    r.setTimeout(timeout, () => r.destroy());
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

export async function waitFor(url, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await req(url, { timeout: 3000 });
    if (r.status >= 200 && r.status < 400) return true;
    await new Promise((s) => setTimeout(s, 1500));
  }
  return false;
}

/* ============================================================
 * 断言
 * ============================================================ */

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? '  —— ' + detail : ''}`);
  };
  const summary = () => {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n===== 结果：${pass}/${results.length} 通过 =====`);
    results.filter((r) => !r.ok).forEach((r) => console.log(`  失败：${r.name}`));
    return pass === results.length;
  };
  return { check, summary, results };
}

/* ============================================================
 * 数据库
 * ============================================================ */

export function conn(dbName) {
  return knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: dbName,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true,
    },
    pool: { min: 0, max: 3 },
  });
}

/**
 * 按表结构补全 NOT NULL 无默认 的列 —— 造夹具时不用硬编码各库差异
 *
 * ⚠️ 对 `*_code` / `*_no` 结尾的字段要生成**唯一值**，
 *    否则多条夹具会撞唯一键（'Duplicate entry' for key 'uk_class_code'）。
 */
export async function buildRow(db, table, provided) {
  const [cols] = await db.raw(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_DEFAULT AS def
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND IS_NULLABLE = 'NO'
       AND EXTRA NOT LIKE '%auto_increment%'`,
    [table],
  );
  const row = { ...provided };
  const uniq = () => 'T' + Math.random().toString(36).slice(2, 8).toUpperCase();
  for (const c of cols) {
    if (c.name === 'id') {
      if (row[c.name] === undefined || row[c.name] === null) row[c.name] = cryptoRandomUUID();
      continue;
    }
    // ★★ 第二类兜底：NOT NULL **有默认值**，但调用方传了 null。
    //   老表这列允许 null、镜像到统一表这列是 NOT NULL DEFAULT '' → 直接插
    //   报 `Column 'create_by' cannot be null`（实测考试域炸的就是这个：
    //   老行的 create_by/create_time 是 NULL，新表这两列 NOT NULL）。
    //   → **不是「值缺失」而是「值非法」**，原逻辑只管前者。
    if (row[c.name] === null) {
      const d = c.def;
      if (d !== null && d !== undefined) {
        row[c.name] = /^b'/.test(String(d)) ? 0 : String(d);   // tinyint(1) 默认值在 MariaDB 返回 b'0'
      } else if (/int|decimal|float|double/.test(c.type)) row[c.name] = 0;
      else if (/date|time/.test(c.type)) row[c.name] = new Date();
      else row[c.name] = '';
      continue;
    }
    if (row[c.name] !== undefined) continue;
    // ★★ 第三类兜底：值缺失，但该列在 DDL 里**有默认值**。
    //   → 必须用数据库默认值，而不是无脑填 0。
    //   实测踩坑（学生域初高）：sms_class_jh.t_class_student.dept_code
    //   的 COLUMN_DEFAULT = 1，夹具没显式传 → 填 0 →
    //   而登录账号的 dataScope=3(本部门) deptCode=1 →
    //   仓储拼出 `and dept_code = 1` → 一条都查不到（老表/统一表都挂）。
    //   大学和就业的夹具恰好显式写了 dept_code:1，所以只有初高暴露。
    const hasDefault = c.def !== null && c.def !== undefined;
    const isNum = /int|decimal|float|double/.test(c.type);
    if (hasDefault) {
      row[c.name] = /^b'/.test(String(c.def)) ? 0 : String(c.def);
      continue;
    }
    if (isNum) row[c.name] = 0;
    else if (/date|time/.test(c.type)) row[c.name] = new Date();
    else if (c.name.endsWith('_code') || c.name.endsWith('_no')) row[c.name] = uniq();
    else row[c.name] = '';
  }
  return row;
}

function cryptoRandomUUID() {
  return require('node:crypto').randomUUID();
}

/* ============================================================
 * ★ 第 4 期 · 步骤 1：统一表镜像写入层（双写）
 * ============================================================
 *
 * 【★ 为什么是「双写」而不是「把夹具搬到统一表」】
 *   第 4 期方案原文写「自检夹具改成写统一表」，我实现时发现**那样会砸掉八域回归**：
 *
 *   八个自检脚本的夹具一共涉及 **28 张老表**，而本轮（步骤 0+1+2）只切读
 *   **11 张**已归一的表。剩下 17 张（成绩链 `t_class_grade`、审批链
 *   `t_class_refund`、出勤明细 `t_class_attendance_detail`、宿舍主数据
 *   `t_class_room`/`t_class_bed`…）的**仓储还在读老表**。
 *
 *   如果夹具只写统一表 → 那 17 张表的老表变空 → 对应断言全报「查不到数据」。
 *   → 现象是「代码没改却测试挂了」，极难定位。
 *
 *   所以：**夹具照旧写老表，同时镜像写一份统一表**。
 *     · 已切读的 11 张表 → 仓储读统一表，查得到✅
 *     · 未切读的 17 张表   → 仓储读老表，也查得到 ✅
 *   → 同一套夹具能同时喂饱新旧两条读路径，**回归可横向对比**
 *     （同一条断言，开关前后各跑一次，结果必须完全一致 —— 这是切读正确性的最强证据）。
 *
 * 【★ 为什么列名能原样直传】
 *   步骤 0 已把三学段老表在统一表里缺的 54 列全部补齐（`20261010_020`），
 *   补的是**同名列**（`id_card_no`、`origin`、`class_ids`…），
 *   → 老表行对象可以**整行原样**插进统一表，不需要任何字段映射。
 *   只需额外补统一表自有列：`edu_stage`（学段）+ 溯源三件套。
 *
 * 【★ 学段怎么定】
 *   不能靠表名猜（`t_class_info` 同时存在于初高和大学，是**同表名跨库**）。
 *   → 由夹具脚本显式传入 `stage`，见 `mirrorToUni()` 的 `stage` 参数。
 *
 * 【★★ 第 4 期步骤 2 追加：学段列改名了】
 *   统一表的学段列已从 `stage` 改名为 **`edu_stage`**（迁移 20261010_022）。
 *   原因：老表本来就有一列叫 `stage`，但那是**阶段码**（int，初高 101 / 大学 201~206），
 *   和学段（jh/class/job）**同名不同义**。不分开迟早读错数据。
 *   → 镜像时：老表 `stage` 搬到 `stage_code`，学段写进 `edu_stage`。
 */

/** 老表 → 统一表 映射（只列本轮切读的 11 张；其余 17 张不镜像） */
export const UNI_MAP = {
  // 班级
  'sms_class_jh.t_class_info': 't_uni_class',
  'sms_class.t_class_info': 't_uni_class',
  'sms_job.t_job_class': 't_uni_class',
  // 学生
  'sms_class_jh.t_class_student': 't_uni_student',
  'sms_class.t_class_student': 't_uni_student',
  'sms_job.t_student_base': 't_uni_student',
  // 花名册
  'sms_job.t_job_class_student': 't_uni_class_student',
  // 出勤
  'sms_class_jh.t_class_attendance': 't_uni_attendance',
  'sms_class.t_class_attendance': 't_uni_attendance',
  // 考试
  'sms_class_jh.t_class_exam': 't_uni_exam',
  'sms_class.t_class_exam': 't_uni_exam',
  'sms_job.t_job_exam': 't_uni_exam',
  'sms_class.t_class_exam_content': 't_uni_exam_content',
  // ★ 第4期第2批（审批链）：三张审批源表合并成 87 列的 t_uni_approval
  'sms_class.t_class_suspend_apply': 't_uni_approval',
  'sms_class_jh.t_class_flow': 't_uni_approval',
  'sms_job.t_job_student_leave': 't_uni_approval',
  'sms_class.t_class_approval_log': 't_uni_approval_log',
  // ⚠️ 这里曾经还有一条 `'sms_class_jh.t_class_approval_log'`，P4 收尾时删除：
  //    初高**没有**这张老表（它的审批流水表是 `t_class_flow_log`，已登记）。
  //    详见 src/teaching/shared/uniTable.ts 同位置的注释。
  //    注意 `readBackendUniMap()` 只比对两份副本的 key 是否一致，
  //    **查不出「key 指向的老表不存在」** —— 所以错映射必须靠人工/DB 核对删掉。
  // ★ 第4期第2批（`class/modules/approval` 老审批接口）：三类单据各一张统一表
  //   审批链本体按**单据类型分表**，而不是全塞进 t_uni_approval：
  //   休学管学籍状态、退费管钱和明细项、升学管班级和成绩快照 —— 字段完全不同。
  'sms_class.t_class_refund_apply': 't_uni_refund',
  'sms_class.t_class_refund_item': 't_uni_refund_item',
  'sms_class.t_class_upgrade_apply': 't_uni_upgrade_apply',
  'sms_class.t_class_transfer': 't_uni_class_transfer',
  // 站内通知（藏在 shared/flow.ts 里，只扫 approval/ 目录扫不到）
  'sms_class.t_class_notify': 't_uni_notify',
  // ★ 第 3 批（学生档案域）新增 3 张：consult_push / student_transfer / grade
  'sms_class.t_class_consult_push': 't_uni_consult_push',
  'sms_class.t_class_student_transfer': 't_uni_class_transfer',
  'sms_class.t_class_grade': 't_uni_exam_score',
  // ★ 第 4 批（班级域）新增 2 张：stage_log / training_handoff
  'sms_class.t_class_stage_log': 't_uni_stage_log',
  'sms_class.t_class_training_handoff': 't_uni_handover',
  'sms_class_jh.t_class_exam_field': 't_uni_exam_field',
  'sms_class.t_class_exam_field': 't_uni_exam_field',
  // 末班
  'sms_class_jh.t_class_repeat': 't_uni_repeat',
  'sms_class.t_class_repeat': 't_uni_repeat',
  // 宿舍申请
  'sms_class_jh.t_class_dorm_apply': 't_uni_dorm_apply',
  'sms_class.t_class_dorm_apply': 't_uni_dorm_apply',
  // —— 宿舍域（第4期第1批 · 三学段统一用实训模型）——
  // ⚠️ 必须与 `src/teaching/shared/uniTable.ts` 的 UNI_MAP **逐行一致**，
  //    两边不一致 = 自检夹具写一张表、仓储读另一张表 → 一行都查不到。
  'sms_job.t_job_dorm': 't_uni_dorm_room',
  'sms_class_jh.t_class_room': 't_uni_dorm_room',
  'sms_common.t_class_dorm_room_sync': 't_uni_dorm_room',
  'sms_job.t_job_dorm_bed': 't_uni_dorm_bed',
  'sms_class_jh.t_class_bed': 't_uni_dorm_bed',
  'sms_class_jh.t_class_dorm_resident': 't_uni_dorm_resident',
  'sms_common.t_class_dorm_live_sync': 't_uni_dorm_resident',
  'sms_job.t_dorm': 't_uni_dorm_building',
  'sms_job.t_job_dorm_change': 't_uni_dorm_change',
  'sms_class.t_class_dorm_change_log': 't_uni_dorm_change_log',
  // —— 第 10 批（出勤/通知/催费/费用 四域收尾）——
  'sms_class.t_class_attendance_absent': 't_uni_attendance_detail',
  // —— ★ P2（2026-10-16 出勤明细/汇总归一）——
  //    ⚠️ 这三条**必须与后端 `src/teaching/shared/uniTable.ts` 同步**，
  //       否则切读模式下 `probe()` / `mirrorRow()` 会回退到老表：
  //         夹具写老表、产品写统一表 → 断言读到的永远是老表那份没被动过的数据
  //         → 现象是「明明产品写对了，断言却说落库值没变」（本轮实际踩到）。
  //       `assertUniMapConsistent()` 就是为抓这种不一致而存在的，别绕过它。
  'sms_class_jh.t_class_attendance_detail': 't_uni_attendance_detail',
  'sms_job.t_job_attendance': 't_uni_attendance',
  'sms_job.t_job_attendance_summary': 't_uni_attendance_summary',
  'sms_class.t_class_urge_log': 't_uni_urge_log',
  'sms_common.t_class_urge_sync': 't_uni_urge',
  'sms_common.t_class_fee_sync': 't_uni_fee',
  // —— 第 11 批（实训侧退费）——
  'sms_job.t_job_refund': 't_uni_refund',
  // —— 第 12 批（2026-10-16 · 补「孤儿统一表」11 条；须与后端 uniTable.ts 同步）——
  'sms_job.t_job_approval': 't_uni_approval_main',
  'sms_class_jh.t_class_checkout_apply': 't_uni_checkout_apply',
  'sms_class_jh.t_class_term': 't_uni_class_term',
  'sms_class_jh.t_class_op_log': 't_uni_op_log',
  'sms_class_jh.t_class_refund_log': 't_uni_refund_log',
  'sms_class_jh.t_class_setting': 't_uni_setting',
  'sms_class_jh.t_class_stage': 't_uni_stage_def',
  'sms_class_jh.t_student_base': 't_uni_student_base_jh',
  'sms_job.t_employment_log': 't_uni_employment_log',
  'sms_job.t_review': 't_uni_review',
  'sms_job.t_kpi_target': 't_uni_kpi_target',
  /* ★ 第 13 批（2026-10-16 · P3 前置）补 5 条实训映射，
     与 src/teaching/shared/uniTable.ts 严格保持一致（assertUniMapConsistent 会校验）。 */
  'sms_job.t_job_exam_score': 't_uni_exam_score',
  'sms_job.t_job_fee_call': 't_uni_fee',
  'sms_job.t_job_class_transfer': 't_uni_class_transfer',
  'sms_job.t_job_training_handoff': 't_uni_handover',
  'sms_job.t_job_notice': 't_uni_notify',
  /* ★ 第 14 批（2026-10-16 · P4 前置）补 7 条初高映射，同样与 uniTable.ts 保持一致。 */
  'sms_class_jh.t_class_fee': 't_uni_fee',
  'sms_class_jh.t_class_refund': 't_uni_refund',
  'sms_class_jh.t_class_fee_notify': 't_uni_notify',
  'sms_class_jh.t_class_handover': 't_uni_handover',
  'sms_class_jh.t_class_exam_score': 't_uni_exam_score',
  'sms_class_jh.t_class_flow_log': 't_uni_approval_log',
  'sms_class_jh.t_class_building': 't_uni_dorm_building',
  'sms_job.t_job_approval_log': 't_uni_approval_log',
};

/**
 * ★★ 自检库 UNI_MAP 与后端 UNI_MAP 的一致性校验
 *
 * 【为什么必须校验】两处各写了一份映射表，一旦不一致：
 *   自检夹具往 A 表写，仓储从 B 表读 → **一行都查不到**，
 *   而报错信息毫无指向性（不会说「你两份映射不一致」，只会说「没数据」）。
 *   本轮宿舍域就差点踩：库里少 4 条宿舍映射，症状是「切读后宿舍全空」。
 *
 * 跑法：任何域自检开跑前会调本函数，不一致直接抛错、附带差集。
 */
export function assertUniMapConsistent() {
  if (USE_UNI !== true) return; // 只在切读模式下校验（老表模式两套都不走）
  const backend = readBackendUniMap();
  const mine = new Set(Object.keys(UNI_MAP));
  const theirs = new Set(Object.keys(backend));
  const missing = [...theirs].filter((k) => !mine.has(k));
  const extra = [...mine].filter((k) => !theirs.has(k));
  if (!missing.length && !extra.length) return;
  const lines = ['UNI_MAP 与后端不一致：'];
  if (missing.length) lines.push(`  仓库有、自检缺 (${missing.length}): ${missing.join(', ')}`);
  if (extra.length) lines.push(`  自检有、仓库缺 (${extra.length}): ${extra.join(', ')}`);
  throw new Error(lines.join('\n'));
}

/** 从后端源文件里正则抠出 UNI_MAP 的 key（避免为了校验去 require 整个 TS 模块） */
function readBackendUniMap() {
  // ★ 本文件是 ESM（.mjs），必须用 import.meta.url 定位，不能用 __dirname / require
  const src = readFileSync(
    fileURLToPath(new URL('../src/teaching/shared/uniTable.ts', import.meta.url)),
    'utf8',
  );
  const block = src.slice(src.indexOf('export const UNI_MAP'), src.indexOf('};', src.indexOf('export const UNI_MAP')));
  const out = {};
  const re = /'(sms_[a-z_]+\.[a-z_0-9]+)'\s*:\s*'([a-z_0-9]+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * ★ 不能带进统一表的列（镜像时必须剔除）
 *
 * `uk_in_class`（`t_job_class_student` 的列）是**生成列** ——
 * MariaDB 按「班级ID_学生ID」自动算出来，**手动插入会报**
 * `Unknown column 'uk_in_class' in 'field list'`。
 * 老表 insert 能过是因为脚本没写这一列；但镜像是**整行原样直传**，
 * 老行对象里就带着它 → 必须显式剔除。
 *
 * ⚠️ 这个坑踩了两次（成绩域自检炸出来的）：
 *   ① 缺列扫描脚本 `_p4-missing-cols.cjs` 里**手写了排除** uk_in_class
 *   ② 镜像层忘了排除
 *   → 两个地方口径不一致 = 一个说「已覆盖」、一个实际插不进去。
 *   **纪律：排除规则只在镜像层定义一处，其他脚本引用它，不要各写一份。**
 */
const NON_INSERTABLE = new Set(['uk_in_class']);

/** 剔除不能手动插入的列（生成列 / DB 自动维护的列） */
function stripNonInsertable(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (NON_INSERTABLE.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/* ============================================================
 * ★★ 按「目标表实际列」裁剪（斌哥 2026-10-10 拍板方案 A）
 * ============================================================
 *
 * 【为什么必须有】
 *   第4 期建表时按七铁律第⑤条决定：统一表**不加**溯源三件套
 *   `src_db` / `src_table` / `src_id` —— 数据都是从老库归一来的，
 *   记「来自哪个库」不如记「属于哪个学段」（edu_stage）。
 *   而八域自检脚本是照着**老表结构**写的，镜像时会把 src_* 一并写过去
 *   → `Unknown column 'src_db' in 'field list'`（实测班级域第一个炸的就是这个）。
 *
 * 【为什么 buildRow 挡不住】
 *   `buildRow()` 只负责给「NOT NULL 且无默认值」的列兜底，
 *   它**不会剔除目标表不存在的列** → 不该写的列照样写进去 → 照样炸。
 *
 * 【为什么必须集中在这一处】
 *   `mirrorRow()` 和 `mirrorToUni()` 是同一个逻辑的两份实现。
 *   之前 NON_INSERTABLE 已经踩过「两处口径不一致」的坑
 *   （缺列扫描脚本排除了 uk_in_class、镜像层没排除），
 *   → **排除规则只在镜像层定义一处，其他脚本引用它，不要各写一份。**
 */
const UNI_COLS_CACHE = {};   // { 't_uni_class': Set(列名) }
let uniDbRef = null;          // 复用连接，避免每次开新连接

/** 取统一表某张表的实际列名集合（带进程内缓存） */
export async function uniColumnsOf(uniDb, table) {
  if (UNI_COLS_CACHE[table]) return UNI_COLS_CACHE[table];
  const [rows] = await uniDb.raw(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    ['sms_common', table],
  );
  const set = new Set(rows.map((r) => (r.COLUMN_NAME || r.column_name)));
  UNI_COLS_CACHE[table] = set;
  return set;
}

/**
 * 统一表别名列 → 老表列名（只补「统一表改名」的列）
 * ⚠️ 只放**确实被统一表改过名**的列；同名列一律不进这里。
 */
const UNI_ALIAS_COLS = {
  room_id: 'dorm_id',
  room_no: 'dorm_no',
};

/**
 * 把一行老表数据裁剪成「统一表能接受的形状」
 * - 剔除目标表不存在的列（如 src_* 三件套）
 * - 老表 stage（阶段码 int）→ 统一表 stage_code
 * - 学段写进 edu_stage
 */
export async function shapeForUni(uniDb, dbName, table, row, stage, uniTable) {
  const base = stripNonInsertable(row);
  const phaseCode =
    base.stage === null || base.stage === undefined || base.stage === ''
      ? undefined
      : Number(base.stage);
  delete base.stage;

  const shaped = {
    ...base,
    edu_stage: stage,
    ...(phaseCode === undefined || Number.isNaN(phaseCode) ? {} : { stage_code: phaseCode }),
  };
  // ★ #23 方案 B（2026-10-16 拍板）：统一表 `stage` 列**废弃**，阶段码一律 `stage_code`。
  //   不再双写 stage（原「两个都写」的逻辑已删）——业务代码全部走 phaseCodeCol()/readPhaseCode()，
  //   搬迁（P5）同样跳过该列；P7/P8 时列本身随 DROP 处理。
  // ★ 兜底：老表有的列里，凡是新表没有的，一律不写
  const cols = await uniColumnsOf(uniDb, uniTable);
  for (const k of Object.keys(shaped)) {
    if (!cols.has(k)) delete shaped[k];
  }

  // ★★ 反向补列（宿舍域血坑）：统一表 t_uni_dorm_bed 的房间指针列叫 room_id/room_no，
  //   而老表 t_job_dorm_bed 只有 dorm_id/dorm_no。老行镜像过来时 room_id「值缺失」，
  //   buildRow() 的兜底分支会把它填成空串 '' → 撞唯一索引 uk_dorm_bed。
  //   判定：源行根本没有 room_id 这个键，而统一表有 → 用 dorm_id 补。
  //   ⚠️ 绝不能无条件改名：t_uni_dorm_room（房间表）自身的 dorm_id 就是房间主键。
  for (const [uniCol, oldCol] of Object.entries(UNI_ALIAS_COLS)) {
    if (!cols.has(uniCol)) continue;
    if (shaped[uniCol] === undefined || shaped[uniCol] === null || shaped[uniCol] === '') {
      const v = base[oldCol];
      if (v !== undefined && v !== null && v !== '') shaped[uniCol] = v;
    }
  }
  return shaped;
}

/**
 * 把一条老表行镜像写入统一表（复用已有连接版）
 *
 * ★ 为什么要有这个重载：
 *   `_e2e-attendance-check.mjs` 等脚本**不 import 本脚手架**（第 2 期早期独立写法），
 *   它们自己 `conn('sms_common')` 并要在 finally 里统一 destroy。
 *   → 不能用 `mirrorToUni()`（内部会开连接又立刻关掉，脚本没法登记清理）。
 *
 * @param {function} uniDb   已建立的 sms_common 连接
 * @param {string}   dbName  源库名
 * @param {string}   table   源表名
 * @param {object}   row     已插入老表的完整行
 * @param {string}   stage   学段（'jh'|'class'|'job'）★ 必须显式传
 * @param {function} reg     注册清理回调
 */
export async function mirrorRow(uniDb, dbName, table, row, stage, reg) {
  const uniTable = UNI_MAP[`${dbName}.${table}`];
  if (!uniTable) return null; // 本轮不镜像的 17 张表

  // ★ 统一化：剔生成列 + stage→stage_code + 写 edu_stage + 剔除新表没有的列
  const uniRow = await shapeForUni(uniDb, dbName, table, row, stage, uniTable);
  // 统一表可能有 NOT NULL 无默认、老表没有的列 → 再兜一次底
  const safe = await buildRow(uniDb, uniTable, uniRow);
  await uniDb(uniTable).insert(safe);
  if (reg) reg('sms_common', uniTable, safe.id);
  return safe.id;
}

/**
 * 把一条老表行镜像写入统一表（自开连接版，见下方注释里的双写理由）
 *
 * @param {string} dbName  源库名（如 sms_class_jh）
 * @param {string} table   源表名（如 t_class_info）
 * @param {object} row     已插入老表的完整行（含 id）
 * @param {string} stage   学段（'jh' | 'class' | 'job'）★ 必须显式传，同表名跨库无法猜
 * @param {function} reg   注册清理回调（统一表的行也要清理）
 * @returns {Promise<string|null>} 统一表行 id（不镜像时返回 null）
 */
export async function mirrorToUni(dbName, table, row, stage, reg) {
  const uniTable = UNI_MAP[`${dbName}.${table}`];
  if (!uniTable) return null; // 本轮不镜像的 17 张表
  const uniDb = conn('sms_common');
  try {
    // ★ 与 mirrorRow 同口径（统一走 shapeForUni，避免两处逻辑分叉）：
    //   剔生成列 + stage→stage_code + 写 edu_stage + **剔除新表没有的列**
    const uniRow = await shapeForUni(uniDb, dbName, table, row, stage, uniTable);
    // ⚠️ 统一表可能有 NOT NULL 无默认的列（老表没有的），
    //   用 buildRow 对着**统一表**再兜一次底 —— 直接插会 ER_BAD_NULL_ERROR
    const safe = await buildRow(uniDb, uniTable, uniRow);
    await uniDb(uniTable).insert(safe);
    if (reg) reg('sms_common', uniTable, safe.id);
    return safe.id;
  } finally {
    await uniDb.destroy();
  }
}

/* ============================================================
 * ★ 第 4 期步骤 2：断言侧的表路由
 * ============================================================ */

/** 与后端同一个开关（`src/teaching/shared/uniTable.ts` 读的就是这个变量） */
export const USE_UNI = process.env.TEACHING_UNI_TABLE === '1';

/**
 * ★ 夹具登记要记「数据真正落在哪张表」
 *
 * 自检脚本调 API 建数据时只知道老表名
 * （`reg('sms_class', 't_class_info', id)`），
 * 但切读开启后仓储写的是**统一表** → 清理按老表删 = **一行都没删掉**。
 *
 * 后果实测（不是理论）：
 *   残留的软删行会继续占住唯一索引 `uk_uni_class_name_stage`，
 *   而仓储的「同部门重名」校验**带 is_deleted 过滤** → 查着不重复、插入却报重复，
 *   现象是「第一次跑通过、第二次跑报『已存在』」——
 *   正是本项目反复踩的「软删 + 唯一索引 = 删了再也建不回来」。
 *
 * → 所有 `reg()` 都必须经过这里，切换时自动改指向统一表。
 */
export function regTarget(dbName, table) {
  if (!USE_UNI) return [dbName, table];
  const uniTable = UNI_MAP[`${dbName}.${table}`];
  return uniTable ? ['sms_common', uniTable] : [dbName, table];
}

/**
 * probe 用法：`dbJob('t_job_class')` → `probe(dbJob, 'sms_job', 't_job_class', 'job')`
 *
 * @param {function} db     老库连接
 * @param {string}  dbName  老库名
 * @param {string}  table   老表名
 * @param {string}  [stage] 学段（切读时用于按 edu_stage 过滤）
 */
export function probe(db, dbName, table, stage) {
  if (!USE_UNI) return db(table);
  const uniTable = UNI_MAP[`${dbName}.${table}`];
  if (!uniTable) return db(table); // 未归一 → 老库
  const uniDb = conn('sms_common');
  const qb = uniDb(uniTable);
  if (stage) qb.where({ edu_stage: stage });
  return qb;
}

/** probe + first() 的语法糖 */
export async function probeFirst(db, dbName, table, where, stage) {
  return probe(db, dbName, table, stage).where(where).first();
}

/** probe + select(...).limit(n) 的语法糖 */
export async function probeRows(db, dbName, table, stage, limit = 50) {
  return probe(db, dbName, table, stage).select('*').limit(limit);
}

/* ============================================================
 * 服务与登录
 * ============================================================ */

/** 启动前后端并等就绪；返回 { backendReady, frontendReady } */
export async function startServices() {
  const freed = freePorts();
  if (freed.length) console.log(`  已清掉占用端口的残留进程：${freed.join(', ')}`);
  launch(`${ROOT}/server-job`, ['node_modules/tsx/dist/cli.mjs', 'src/app.ts'], 'backend');
  launch(`${ROOT}/web-job`, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], 'frontend', frontendEnv());
  const be = await waitFor('http://127.0.0.1:8004/health');
  const fe = await waitFor(`${BASE}/`);
  return { backendReady: be, frontendReady: fe };
}

export async function login(account) {
  const r = await req(`${BASE}/api/portal/account/login`, {
    method: 'POST',
    body: { account, password: PASS },
  });
  return r.json?.data?.token || '';
}

/** 打印失败时的后端 stderr 尾部，便于定位 */
export function dumpBackendError(lines = 25) {
  const e = stderrOf('backend');
  if (!e) return;
  console.log('\n--- backend stderr（尾）---');
  console.log(e.split('\n').slice(-lines).join('\n'));
}
