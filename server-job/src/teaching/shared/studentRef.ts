/**
 * 学生档案 · 权威源统一取数（★ 2026-10-20）
 * ============================================================
 *
 * 【为什么要有这个文件】
 *   用户口径（2026-10-20）：
 *     ① 催费/缴费、退费、休学/退学审批 的数据要和学生档案关联；
 *     ② 学生档案里没有的学生，其他模块也不能有；
 *     ③ 其他模块状态改动时，学生档案也要跟着改；
 *     ④ 这些单据里「学生档案有的字段」一律按档案的值走。
 *
 *   ①②③ 在写入侧基本已经做到（退费 / 休退学的 create() 都会先查档案，
 *   查不到抛 STUDENT_NOT_FOUND；异动审批通过会回写 student_status）。
 *   真正缺的是 ④ 的**读取侧**：
 *     各业务表都冗余复制了一份学生属性（student_no / student_name /
 *     class_id / class_name / dept_code / id_card_no ...），列表和详情
 *     读的都是单据自己那份**开单时的快照**。学生一旦换班或改名，
 *     历史单据永远显示老班级 —— 实测初高缴费就有 4 条这种漂移。
 *
 * 【本文件的定位】
 *   「单据落库时写快照（财务可追溯）」+「界面读取时以档案最新值为准」。
 *   两者都要，缺一个都出问题：
 *     · 只有快照 → 换班后单据和档案对不上（当前现状）
 *     · 只有实时 → 历史单据无法还原开单时的样子，对账没依据
 *
 * 【三学段档案表坐标（实测 2026-10-20）】
 *   jh    初高    sms_class_jh.t_class_student   49 列，**唯一有 id_card_no 的**
 *   class 大学    sms_class.t_class_student      57 列，无 id_card_no
 *   job   实训    sms_job.t_student_base         41 列，无 id_card_no
 *   edu   教务    sms_edu.t_student_base         32 列，无 id_card_no
 *
 * 【为什么不直接 join】
 *   三个学段的业务表在三个库，档案表也分散；且 `tbl()` 可能把表切到
 *   sms_common 的统一表（t_uni_student，带 edu_stage 过滤）。
 *   统一走 `tbl()` 才能和切读开关保持一致，否则切换后会「查得到单据、
 *   查不到学生」。所以这里先按 id 批量取档案（Map），再在内存里覆盖。
 */

import type { Knex } from 'knex';
import { db as mainDb } from '../../utils/db';
import { tbl } from './uniTable';
import type { TeachingStage } from './dto';

/** 各学段档案表坐标 */
export const ARCHIVE_TABLE: Record<TeachingStage, { dbName: string; table: string }> = {
  jh: { dbName: 'sms_class_jh', table: 't_class_student' },
  class: { dbName: 'sms_class', table: 't_class_student' },
  job: { dbName: 'sms_job', table: 't_student_base' },
};

/**
 * 该学段档案表里「身份证号」的列名（实测 2026-10-20，三学段不统一）
 *   jh    → id_card_no
 *   class → id_card
 *   job   → id_card
 * 注意：`t_student_base`（实训底表）也有 id_card，注释写着「大学升实训时随档案带过来」。
 */
export const ARCHIVE_ID_CARD_COLUMN: Record<TeachingStage, string> = {
  jh: 'id_card_no',
  class: 'id_card',
  job: 'id_card',
};

/** 档案里的一个学生（字段语义统一后的形状） */
export interface ArchiveStudent {
  /** 主键 */
  id: string;
  /** 学号 */
  no: string;
  /** 姓名 */
  name: string;
  /** 性别 1男 2女 */
  gender: number | null;
  /** 班级ID */
  classId: string | null;
  /** 班级名称 */
  className: string | null;
  /** 部门 1初高部 2大学部 */
  deptCode: number | null;
  /** 学生手机号 */
  phone: string | null;
  /** 家长手机号 */
  parentPhone: string | null;
  /** 身份证号（仅初高有，其余学段恒为 null） */
  idCard: string | null;
  /** 学生状态 1待咨询…5正式在读 6休学 7退学 8实训中 9待就业 10已就业 11流失 */
  studentStatus: number | null;
}

/** whereIn 分片大小（与催费取电话的口径保持一致，避免超长 SQL） */
const CHUNK = 500;

/** 把一行 DB 记录（snake_case）翻成 ArchiveStudent */
function toArchive(r: Record<string, any>, stage: TeachingStage): ArchiveStudent {
  const idCol = ARCHIVE_ID_CARD_COLUMN[stage];
  return {
    id: String(r.id),
    no: String(r.student_no ?? ''),
    name: String(r.student_name ?? ''),
    gender: r.gender == null ? null : Number(r.gender),
    classId: r.class_id ? String(r.class_id) : null,
    className: r.class_name ?? null,
    deptCode: r.dept_code == null ? null : Number(r.dept_code),
    phone: r.phone ?? null,
    parentPhone: r.parent_phone ?? null,
    idCard: r[idCol] ?? null,
    studentStatus: r.student_status == null ? null : Number(r.student_status),
  };
}

/** 去重 + 剔空（混进 NULL 会让 whereIn 行为异常，也会白白多查一批） */
function cleanIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/**
 * 批量取档案：`学生id -> 档案`
 *
 * @param stage 学段（决定查哪张档案表）
 * @param ids   学生 id 列表（自动去重剔空 + 分片）
 * @param conn  可选连接（事务里传 trx；不传走主连接）
 *
 * ⚠️ 只返回**未逻辑删除**的学生。查不到 = 档案里没有这个人，
 *    调用方据此判定「孤儿单据」。
 */
export async function fetchArchiveStudents(
  stage: TeachingStage,
  ids: Array<string | null | undefined>,
  conn?: Knex,
): Promise<Map<string, ArchiveStudent>> {
  const out = new Map<string, ArchiveStudent>();
  const list = cleanIds(ids);
  if (!list.length) return out;

  const { dbName, table } = ARCHIVE_TABLE[stage];
  const conn2 = conn ?? mainDb;

  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = (await tbl(conn2, dbName, table, stage)
      .where({ is_deleted: 0 })
      .whereIn('id', part)
      .select('*')) as Array<Record<string, any>>;
    for (const r of rows) out.set(String(r.id), toArchive(r, stage));
  }
  return out;
}

/**
 * 取档案，缺人即报错（写入前的准入校验）
 *
 * 「学生档案没有的学生，其他模块也不能有」的**唯一判定入口**：
 * 写入单据前先过这一关，缺一个就整单拒绝，不写半截数据。
 *
 * @returns 全部命中的档案 Map（保证每个 id 都有）
 * @throws  Error（code = STUDENT_NOT_FOUND 语义由调用方包装）
 */
export async function requireArchiveStudents(
  stage: TeachingStage,
  ids: Array<string | null | undefined>,
  conn?: Knex,
): Promise<Map<string, ArchiveStudent>> {
  const map = await fetchArchiveStudents(stage, ids, conn);
  const missing = cleanIds(ids).filter((id) => !map.has(id));
  if (missing.length) {
    const err: any = new Error(`学生档案中不存在该学生：${missing.join(', ')}`);
    err.code = 'STUDENT_NOT_FOUND';
    err.missingIds = missing;
    throw err;
  }
  return map;
}

/**
 * 单据字段 -> 档案字段的对应关系（只列需要覆盖的，其余不动）
 *
 * 用 map 不写死的原因：各模块 DTO 命名不统一 ——
 *   原表行是 snake_case（student_no / student_name）
 *   前端 DTO 是 camelCase（studentNo / studentName）
 * 同一份档案要能同时喂给两种形状。
 */
export interface ArchiveFieldMap {
  /** 学号 → DTO 字段名 */
  no?: string;
  /** 姓名 → DTO 字段名 */
  name?: string;
  /** 性别 → DTO 字段名 */
  gender?: string;
  /** 班级ID → DTO 字段名 */
  classId?: string;
  /** 班级名称 → DTO 字段名 */
  className?: string;
  /** 部门 → DTO 字段名 */
  deptCode?: string;
  /** 学生手机号 → DTO 字段名 */
  phone?: string;
  /** 家长手机号 → DTO 字段名 */
  parentPhone?: string;
  /** 身份证号 → DTO 字段名 */
  idCard?: string;
}

/** 原表行（snake_case）的标准映射 —— 大部分仓储的 DB 行都适用 */
export const RAW_FIELDS: ArchiveFieldMap = {
  no: 'student_no',
  name: 'student_name',
  gender: 'gender',
  classId: 'class_id',
  className: 'class_name',
  deptCode: 'dept_code',
  phone: 'phone',
  parentPhone: 'parent_phone',
  idCard: 'id_card_no',
};

/**
 * 按学段给出「单据行」的字段映射
 *
 * ⚠️ 身份证这一列三学段不统一，必须按学段修正，否则大学/实训的单据
 *    会被写进一个不存在的 `id_card_no` 字段 → 覆盖静默失效
 *    （大学异动表叫 `id_card`，实训也一样）。
 */
export function rawFieldsOf(stage: TeachingStage): ArchiveFieldMap {
  return { ...RAW_FIELDS, idCard: ARCHIVE_ID_CARD_COLUMN[stage] };
}

/** 前端 DTO（camelCase）的标准映射 */
export const DTO_FIELDS: ArchiveFieldMap = {
  no: 'studentNo',
  name: 'studentName',
  gender: 'gender',
  classId: 'classId',
  className: 'className',
  deptCode: 'deptCode',
  phone: 'phone',
  parentPhone: 'parentPhone',
  idCard: 'idCard',
};

/**
 * 用档案值覆盖一批数据里的学生属性（就地修改并原样返回）
 *
 * 只覆盖**档案里有值**的字段：
 *   档案某一列是 null（如实训没有身份证），就保留单据原值，
 *   绝不把单据上已有的信息抹成 null —— 「按档案走」不等于「档案空就清空」。
 *
 * @param rows    待覆盖的数据（DB 行或 DTO 都行）
 * @param archive fetchArchiveStudents 的结果
 * @param fields  字段映射，默认按 DB 行（snake_case）
 * @param keyField 从哪一列取学生 id，默认 'student_id'
 * @returns 是否发生了覆盖（自检脚本用它断言「读取确实走了档案」）
 */
export function overlayArchive<T extends Record<string, any>>(
  rows: T[],
  archive: Map<string, ArchiveStudent>,
  fields: ArchiveFieldMap = RAW_FIELDS,
  keyField = 'student_id',
): { rows: T[]; overlaid: number; orphans: string[] } {
  let overlaid = 0;
  const orphans: string[] = [];

  for (const row of rows) {
    const sid = String(row[keyField] ?? '').trim();
    const a = sid ? archive.get(sid) : undefined;
    if (!a) {
      // 档案查无此人：不动它，但记下来（调用方可标记 / 自检可断言）
      if (sid) orphans.push(sid);
      continue;
    }

    let touched = false;
    const put = (dtoKey: string | undefined, value: any) => {
      if (!dtoKey) return;
      if (value === null || value === undefined || value === '') return;
      // T 是泛型，只能读索引 → 断言成可变字典再写
      const target = row as Record<string, any>;
      if (target[dtoKey] === value) return;
      target[dtoKey] = value;
      touched = true;
    };

    put(fields.no, a.no);
    put(fields.name, a.name);
    put(fields.gender, a.gender);
    put(fields.classId, a.classId);
    put(fields.className, a.className);
    put(fields.deptCode, a.deptCode);
    put(fields.phone, a.phone);
    put(fields.parentPhone, a.parentPhone);
    put(fields.idCard, a.idCard);

    if (touched) overlaid += 1;
  }

  return { rows, overlaid, orphans };
}

/**
 * 一次性完成「取档案 + 覆盖」的便捷封装（列表接口最常用）
 */
export async function hydrateWithArchive<T extends Record<string, any>>(
  stage: TeachingStage,
  rows: T[],
  opts: {
    fields?: ArchiveFieldMap;
    keyField?: string;
    conn?: Knex;
  } = {},
): Promise<{ rows: T[]; overlaid: number; orphans: string[] }> {
  const keyField = opts.keyField ?? 'student_id';
  const archive = await fetchArchiveStudents(
    stage,
    rows.map((r) => r[keyField]),
    opts.conn,
  );
  return overlayArchive(rows, archive, opts.fields ?? rawFieldsOf(stage), keyField);
}
