/**
 * 财务域 · 学生档案关联（★ 2026-10-20）
 * ============================================================
 *
 * 【背景 · 为什么财务不能像教学域那样直接覆盖】
 *   教学域的缴费/退费/异动是**学籍业务**，单据上的学生一定来自学生档案，
 *   所以读取时可以直接「档案值覆盖快照」。
 *
 *   财务域不一样：`t_finance_fee` 的缴费单有两个来源 ——
 *     ① 咨询模块在报名前建的单（consult/services/fee-order.service.ts）
 *        → 此时学生**还没进学籍档案**，档案里查无此人是正常业务状态，不是脏数据；
 *     ② 报名/建档之后补的单 → 这时档案里已经有了，应该跟着档案走。
 *
 *   所以财务侧的口径是「**能对上就对齐，对不上就保持原样**」：
 *     · 对得上（按 student_id 或学号命中档案）→ 姓名/班级/部门取档案最新值；
 *     · 对不上 → 不动，也不删 —— 硬改只会把「未建档案」这个真实状态藏起来。
 *
 * 【匹配顺序】
 *   先按 `student_id`（最准），再按 `student_no`（学号跨模块认人的共同键，
 *   见 utils/financeFeeRef.ts 的注释：各库学生主键是不同 uuid，只有学号能跨库对上）。
 *
 * ⚠️ 本文件只读档案，不写任何学生数据。
 */

import { db } from '../utils/db';

/**
 * 三学段档案表坐标
 *
 * `hasSource` = 该表是否有 `source_system` / `source_id` 两列
 *   （班级模块 doReceive 建档时写入 `source_system='consult', source_id=咨询单号`）。
 *   实训学段（t_student_base）是老表，没有这两列 —— 不能拿去查，否则整条 SQL 报
 *   Unknown column，try/catch 一吞就变成「静默少一个学段」，很难发现。
 */
const ARCHIVE_TABLES = [
  { db: 'sms_class_jh', table: 't_class_student', hasSource: true },
  { db: 'sms_class', table: 't_class_student', hasSource: true },
  { db: 'sms_job', table: 't_student_base', hasSource: false },
];

/** 档案里取出来的学生（字段已归一） */
export interface ArchivedStudent {
  /** 档案主键 */
  id: string;
  /** 学号 */
  no: string;
  /** 姓名 */
  name: string;
  /** 班级ID */
  classId: string | null;
  /** 班级名称 */
  className: string | null;
  /** 部门 1初高部 2大学部 */
  deptCode: number | null;
}

/** whereIn 分片（导出/批量场景防止超长 SQL） */
const CHUNK = 500;

/**
 * id 前缀（种子/同步数据的形态差异）
 *
 * 财务库里能见到 `FSB-U26018`、`CST-U26018`，而咨询侧学籍的
 * `source_id` 存的是裸单号或 `consult/` 前缀。匹配前统一剥掉。
 */
const ID_PREFIX_RE = /^(?:FSB|CST)-/i;

const SOURCE_PREFIX = 'consult/';

/** 去掉 id 前缀，留下裸值 */
function bareKey(v: string): string {
  return v.replace(ID_PREFIX_RE, '').trim();
}

/** 去掉 source_id 的 `consult/` 前缀 */
function normalizeSourceId(v: unknown): string {
  const s = String(v ?? '').trim();
  return s.toLowerCase().startsWith(SOURCE_PREFIX) ? s.slice(SOURCE_PREFIX.length) : s;
}

/**
 * 档案查询失败默认静默（某个学段没建库 / 没这张表很常见，不该拖垮财务接口）；
 * 排查时置 `ARCHIVE_DEBUG=1` 就能看到到底是哪个学段、哪一步失败。
 */
function debugArchive(stage: string, full: string, e: unknown): void {
  if (!process.env.ARCHIVE_DEBUG) return;
  console.error(`[student-archive] ${stage} 查询失败 ${full}:`, (e as Error)?.message ?? e);
}

/**
 * 由「财务单上的 id / 学号」推导出可能出现在 `source_id` 里的字面值
 *
 * 同一个学生在不同模块的写法不统一，这里一次铺开：
 *   · 原值            `U26018`
 *   · 剥前缀值        `FSB-ZX26001` → `ZX26001`
 *   · 加 consult/ 前缀 `consult/U26018`（班级侧建档的写法）
 */
function sourceVariants(keys: string[]): string[] {
  const out = new Set<string>();
  for (const raw of keys) {
    const k = String(raw ?? '').trim();
    if (!k) continue;
    for (const x of new Set([k, bareKey(k)])) {
      if (!x) continue;
      out.add(x);
      out.add(`${SOURCE_PREFIX}${x}`);
    }
  }
  return [...out];
}

function cleanIds(v: Array<string | null | undefined>): string[] {
  return [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

function toStudent(r: Record<string, any>): ArchivedStudent {
  return {
    id: String(r.id),
    no: String(r.student_no ?? ''),
    name: String(r.student_name ?? ''),
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name ?? null,
    deptCode: r.dept_code == null ? null : Number(r.dept_code),
  };
}

/**
 * 档案查询结果
 *
 * `bySource` + `ready` 是 2026-10-22 为了「学号只在分班后出现」加的：
 *   · `bySource`：咨询单号 / 咨询学生id → 学籍，解决「财务单存的是咨询侧
 *     身份(`cs-uuid` / `ZX…` / `U26xxx`)，学籍里存的是 `S2026xxxx`」对不上的问题；
 *   · `ready`：本次有没有成功访问到档案库。为 false 时**禁止清空学号**，
 *     否则档案库一抖动，整张缴费核对表的学号会被抹成「—」。
 */
export interface ArchiveLookup {
  byId: Map<string, ArchivedStudent>;
  byNo: Map<string, ArchivedStudent>;
  bySource: Map<string, ArchivedStudent>;
  ready: boolean;
}

/**
 * 批量在学生档案里找人：返回 `id → 学生` / `学号 → 学生` / `咨询单号 → 学生` 三张索引
 *
 * 三学段各查三次（按 id / 按学号 / 按咨询单号），共 8 条 SQL（实训表没有 source 列）；
 * 每张表内部走主键/唯一索引，成本可忽略。
 */
export async function lookupArchive(
  studentIds: Array<string | null | undefined>,
  studentNos: Array<string | null | undefined>,
): Promise<ArchiveLookup> {
  const byId = new Map<string, ArchivedStudent>();
  const byNo = new Map<string, ArchivedStudent>();
  const bySource = new Map<string, ArchivedStudent>();
  let ready = false;

  const ids = cleanIds(studentIds);
  const nos = cleanIds(studentNos);
  if (!ids.length && !nos.length) return { byId, byNo, bySource, ready };

  const srcs = sourceVariants([...ids, ...nos]);

  for (const { db: dbName, table, hasSource } of ARCHIVE_TABLES) {
    const full = `${dbName}.${table}`;

    for (let i = 0; i < ids.length; i += CHUNK) {
      try {
        const rows = (await db(full)
          .where({ is_deleted: false })
          .whereIn('id', ids.slice(i, i + CHUNK))
          .select('id', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code')) as any[];
        ready = true;
        for (const r of rows) byId.set(String(r.id), toStudent(r));
      } catch (e) {
        // 某个库没建/不可达 → 跳过，不影响其它学段
        debugArchive('id', full, e);
      }
    }

    for (let i = 0; i < nos.length; i += CHUNK) {
      try {
        const rows = (await db(full)
          .where({ is_deleted: false })
          .whereIn('student_no', nos.slice(i, i + CHUNK))
          .select('id', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code')) as any[];
        ready = true;
        for (const r of rows) {
          // 同一学号在多个学段都存在时，先命中的那个学段优先（初高 → 大学 → 实训）
          if (!byNo.has(String(r.student_no))) byNo.set(String(r.student_no), toStudent(r));
        }
      } catch (e) {
        debugArchive('no', full, e);
      }
    }

    /* ---------- ③ 按咨询单号 / 咨询学生id 找学籍（分班后才存在） ---------- */
    if (hasSource && srcs.length) {
      for (let i = 0; i < srcs.length; i += CHUNK) {
        try {
          const rows = (await db(full)
            .where({ is_deleted: false, source_system: 'consult' })
            .whereIn('source_id', srcs.slice(i, i + CHUNK))
            // ⚠️ `source_id` 必须 select 出来：索引的 key 就是它，
            //    漏了这一步 Map 永远收不到东西（症状：查询命中 N 行，bySource 却是 0）
            .select('id', 'source_id', 'student_no', 'student_name', 'class_id', 'class_name', 'dept_code')) as any[];
          ready = true;
          for (const r of rows) {
            const key = normalizeSourceId(r.source_id);
            if (key && !bySource.has(key)) bySource.set(key, toStudent(r));
          }
        } catch (e) {
          debugArchive('source', full, e);
        }
      }
    }
  }

  return { byId, byNo, bySource, ready };
}

/** 三路匹配：档案 id → 学号 → 咨询单号 */
function pickArchive(
  lookup: ArchiveLookup,
  studentId: string | null | undefined,
  studentNo: string | null | undefined,
): ArchivedStudent | undefined {
  const id = String(studentId ?? '').trim();
  const no = String(studentNo ?? '').trim();
  return (
    lookup.byId.get(id) ||
    lookup.byNo.get(no) ||
    lookup.bySource.get(bareKey(id)) ||
    lookup.bySource.get(bareKey(no))
  );
}

/**
 * 把档案值合并进财务缴费行（就地覆盖快照列）
 *
 * @returns `linked` = 命中档案的行数（自检用它断言「真关联上了」，
 *          而不是「接口没报错」）
 */
export function applyArchiveToFeeRows<T extends Record<string, any>>(
  rows: T[],
  lookup: ArchiveLookup,
): { rows: T[]; linked: number; cleared: number } {
  let linked = 0;
  let cleared = 0;

  for (const row of rows) {
    const t = row as Record<string, any>;
    const a = pickArchive(lookup, t.student_id, t.student_no);

    if (!a) {
      /**
       * ★ 2026-10-22 用户口径：「还没有进入试学阶段是没有学号的，
       *   财务那里不应该有分班前的学号」
       *
       * 财务单上的 `student_no` 是**建单那一刻**从咨询侧抄过来的：
       *   · `ZX{咨询学生id}` —— 咨询侧占位号（财务建单学号必填，不得不填）
       *   · `U26xxx` / `J26xxx` —— 咨询侧报名号，不是学籍学号
       * 这两种都不是「学号」，分班建档后学籍里才会生成真正的号。
       *
       * 所以：三路都没命中档案 = 这个人还没分班 → 学号置空，前端显示「—」。
       * 只清展示字段，不动 `student_id` 和库里的值（凭证共用/对账还靠它）。
       *
       * `ready=false`（档案库全挂了）时不清 —— 那是查询失败，不是「查无此人」，
       * 清掉会把已分班学生的学号也抹了。
       */
      if (lookup.ready && String(t.student_no ?? '').trim()) {
        t.student_no = '';
        cleared += 1;
      }
      continue;
    }

    // 档案有值才覆盖：档案某列是空的时候保留单据原值，不抹成空
    if (a.no) t.student_no = a.no;
    if (a.name) t.student_name = a.name;
    if (a.classId) t.class_id = a.classId;
    if (a.className) t.class_name = a.className;
    if (a.deptCode != null) t.dept_code = a.deptCode;

    linked += 1;
  }

  return { rows, linked, cleared };
}

/** 取一行的档案学生（详情页单行场景 / 建单时校正学号） */
export async function findArchiveStudent(
  studentId: string | null | undefined,
  studentNo: string | null | undefined,
): Promise<ArchivedStudent | null> {
  const lookup = await lookupArchive([studentId], [studentNo]);
  return pickArchive(lookup, studentId, studentNo) || null;
}
