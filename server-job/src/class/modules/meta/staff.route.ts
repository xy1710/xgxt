import { Router } from 'express';
import { RoleCode } from 'shared-types/class';
import { ok } from '../../http/response';
import { wrap } from '../../middleware/error';
import { db } from '../../db';

/**
 * 人员选项（给前端下拉框用）
 *
 * 【口径（2026-10-06 用户拍板）】
 *   「所有涉及需要选择角色的地方，选项要来自系统内账户所对应的角色」
 *   → 本接口按分组（=一组角色码）去 sms_portal × sms_perm 查人，
 *     返回 { userId, userName, deptCode, roles }。
 *     返回字段刻意收窄：不吐手机号等敏感信息。
 *
 * 【历史】原实现是转发登录模块（8001）的 internal 接口 + 班级表兜底，
 *   但本项目已深度单体、8001 不启动 → 实际只有兜底在生效（口径不对）。
 *   详见 staffFromAccounts 的注释。
 */
export const staffRouter = Router();

/** 可按角色查询的人员分组（key 是前端用的短名，值是登录模块里的 roleCode） */
const ROLE_GROUPS: Record<string, string[]> = {
  /** 班主任（大学部；建班 / 交接时选） */
  headTeacher: [RoleCode.HEAD_TEACHER],
  /** 教员 */
  teacher: [RoleCode.TEACHER],
  /** 助教 */
  assistant: [RoleCode.ASSISTANT],
  // ★ 2026-10-04 斌哥拍板：建班时 5 个岗位一次定好
  /** 项目经理（实训阶段接手带训的人） */
  projectManager: [RoleCode.PROJECT_MANAGER],
  /** 就业指导老师（就业阶段带训的人） */
  employmentTeacher: [RoleCode.EMPLOYMENT],
  /** 学管 = 教质经理 + 学术经理 */
  studyManager: [RoleCode.QUALITY_MGR, RoleCode.ACADEMIC_MGR],
  /** 校长 */
  principal: [RoleCode.PRINCIPAL],
  /** 教务老师（退费链第 2 环） */
  eduAdmin: [RoleCode.EDU_ADMIN],
  /** 财务（退费链第 3 环） */
  finance: [RoleCode.FINANCE],
  /** 招生 / 咨询老师 */
  market: [RoleCode.RECRUIT, RoleCode.CONSULT],
  /** 以上全部（用于「选个老师」这类不需要限定的场景） */
  all: [
    RoleCode.HEAD_TEACHER,
    RoleCode.TEACHER,
    RoleCode.ASSISTANT,
    RoleCode.PROJECT_MANAGER,
    RoleCode.EMPLOYMENT,
    RoleCode.QUALITY_MGR,
    RoleCode.ACADEMIC_MGR,
    RoleCode.PRINCIPAL,
    RoleCode.EDU_ADMIN,
    RoleCode.FINANCE,
    RoleCode.RECRUIT,
    RoleCode.CONSULT,
  ],
};

export interface StaffOption {
  userId: string;
  userName: string;
  deptCode: number;
  /** 命中的角色码，供前端按需二次过滤 */
  roles: string[];
}

/* ============================================================
 * ★ 2026-10-04 修：岗位下拉「无数据」—— 加本地兜底
 *
 * 【现象】建班/改班弹窗里 班主任·教员·助教·项目经理·就业指导老师 五个下拉全是「无数据」
 * 【真因】上面 usersByRoles() 是**HTTP 调 8001 登录模块**的 internal 接口。
 *        本项目已把教务+班级并进 8004 单体跑，**8001 根本没启动** →
 *        fetch 失败 → getJson 返回 null → list 恒为 [] → 下拉全空。
 *        （不是"选项与实际不符"，是**一个选项都没有**）
 *
 * 【为什么用班级表兜底是对的】
 *   「谁是班主任/项目经理」这件事，**目前只有班级表记着**
 *   （t_class_info 的 head_teacher_id…/ project_manager_id…）。
 *   登录模块的 demo-identities 接口本来就是从这两张表捞人的，
 *   所以这里复用同一口径 —— 上游能用就用上游，不能用就用表里已有的，
 *   两边都不会给出"编出来"的人。
 *
 * 【为什么不写死假数据】宁可下拉空着，也不能塞几个假老师进去 ——
 *   假数据会被存进班级表，页面显示正常，演示时全是坑。
 * ============================================================ */

/**
 * 兜底数据源：统一班级表 `sms_common.t_uni_class`（三个学段的班级都在这张表里）。
 *
 * ★ 2026-10-19：原来是 `sms_class.t_class_info` + `sms_job.t_job_class` 两张老表，
 *   P8 已 DROP → 查询被下面的 try/catch 吞掉，兜底恒为空（权限库没建人时
 *   建班弹窗 5 个岗位下拉会「无数据」且不报错）。改为统一表，一条查询覆盖三学段。
 */
const LOCAL_STAFF_TABLES = ['sms_common.t_uni_class'];

/* ============================================================
 * ★ 2026-10-06 新增：人员下拉的【首选】数据源 = 系统账户 + 其角色
 *
 * 【用户口径】「所有涉及需要选择角色时，选择的角色来自系统内账户所对应的角色」
 *
 * 【为什么不是原来的 8001】原实现 HTTP 调登录模块 8001 的 internal 接口，
 *   但本项目已深度单体，8001 根本不启动 → 永远失败 → 落到「班级表兜底」，
 *   而班级表兜底只能捞到**已经出现在班级表里的人**（口径是「历史上谁被填过」，
 *   不是「系统里谁是教员」）。表现就是：新建班级时 项目经理 / 教员 / 助教
 *   三个下拉是空的，或者只有一两个人。
 *
 * 【现在的口径】门户账号（sms_portal.t_sys_account）× 权限角色绑定
 *   （sms_perm.t_perm_user_role → t_perm_role.role_code）。
 *   谁是教员 = 谁的账号角色里有 TEACH_TUTOR —— 唯一事实来源。
 *
 * 【userId 用哪个】用**门户账号 id**（t_sys_account.id）。
 *   因为班级表的 head_teacher_id / project_manager_id … 存的就是门户账号 id
 *   （数据重建脚本 seed-all-demo 就是这么挂的），两边必须同口径，
 *   否则「下拉选出来的人」和「列表里显示的人」对不上。
 * ============================================================ */

/**
 * 班级模块的角色码 → sms_perm 里实际使用的 role_code
 *
 * ⚠️ 两处编码历史上不完全一致（班级模块早期是独立系统）：
 *   · 班级 RoleCode.PROJECT_MANAGER = 'PROJECT_MANAGER'
 *     但 sms_perm.t_perm_role 里项目经理是 `RM_PROJECT`
 *   · 班级 RoleCode.FINANCE = 'ROLE_FINANCE'
 *     但 sms_perm 里财务是 `FIN_STAFF`
 * 其余（TEACH_HEAD / TEACH_TUTOR / TEACH_ASSIST / TEACH_DEAN /
 * ACAD_STAFF / JOB_STAFF / RM_PRINCIPAL / MKT_CONSULT / SYS_ADMIN）一一对应。
 */
const PERM_ROLE_ALIAS: Record<string, string[]> = {
  [RoleCode.PROJECT_MANAGER]: ['RM_PROJECT', 'PROJECT_MANAGER'],
  [RoleCode.FINANCE]: ['FIN_STAFF', 'ROLE_FINANCE'],
  // 学管：主系统已把「教质经理 / 学术经理」合并成 TEACH_DEAN，
  // 早期数据里可能两个码都在，一起认
  [RoleCode.QUALITY_MGR]: ['TEACH_DEAN', 'TEACH_QTY'],
};

/** 把班级模块的角色码展开成 sms_perm 里可能对应的 role_code 集合 */
function permCodesOf(code: string): string[] {
  return PERM_ROLE_ALIAS[code] ?? [code];
}

/**
 * 「岗位池」和「模块」的绑定（软约束）
 *
 * ⚠️ 为什么需要：大学部班主任（zhanght）和初高班主任（sunmin）**角色码完全相同**
 *   （都是 TEACH_HEAD），系统里就是靠「授权了哪个模块」区分的
 *   （见 seed-portal-accounts.mjs 的说明）。
 *   只按角色查人，初高班主任会出现在「大学部班级」的班主任下拉里 —— 不合理。
 *
 * 只对「班级内师资」这几个岗位生效；学管 / 校长 / 教务 / 财务 / 咨询
 * 本来就是跨模块角色（校长要能选，教务要出现在退费链），不做模块限制。
 */
const GROUP_MODULE: Record<string, string> = {
  headTeacher: 'class',
  teacher: 'class',
  assistant: 'class',
  projectManager: 'job',
  employmentTeacher: 'job',
};

/**
 * 首选数据源：门户账号 + 权限角色绑定
 *
 * @param codes          该分组命中的「班级模块角色码」
 * @param requiredModule 若给定，账号必须授权了该模块（用于区分大学部/初高班主任）
 */
async function staffFromAccounts(codes: string[], requiredModule = ''): Promise<StaffOption[]> {
  const wanted = [...new Set(codes.flatMap(permCodesOf))];
  if (!wanted.length) return [];

  const permDb = process.env.DB_NAME_PERM || 'sms_perm';
  const portalDb = process.env.DB_NAME_PORTAL || 'sms_portal';

  // 注意：本连接绑在 sms_class 上，靠**跨库限定名**读 portal / perm（项目里既有写法）
  const sql = `
    SELECT DISTINCT
           a.id            AS userId,
           a.user_name     AS userName,
           a.account       AS account,
           a.title         AS title,
           a.modules       AS modules,
           r.role_code     AS roleCode
      FROM \`${portalDb}\`.t_sys_account a
      JOIN \`${permDb}\`.t_perm_user u
        ON u.account = a.account AND u.is_deleted = 0
      JOIN \`${permDb}\`.t_perm_user_role ur
        ON ur.user_id = u.id AND ur.is_deleted = 0
      JOIN \`${permDb}\`.t_perm_role r
        ON r.id = ur.role_id AND r.is_deleted = 0
     WHERE a.is_deleted = 0
       AND a.active = 1
       AND r.role_code IN (${wanted.map(() => '?').join(', ')})
     ORDER BY a.id`;

  let rows: Array<Record<string, unknown>> = [];
  try {
    const [raw] = (await db.raw(sql, wanted)) as unknown as [
      Array<Record<string, unknown>>,
      unknown,
    ];
    rows = raw;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[staff] 按账户角色取人失败（回落班级表兜底）：${(e as Error).message}`);
    return [];
  }

  // 模块软约束：只留「授权了本模块」的账号（区分大学部班主任 / 初高班主任）
  if (requiredModule) {
    rows = rows.filter((r) => {
      try {
        const mods = JSON.parse(String(r.modules ?? '[]')) as string[];
        return Array.isArray(mods) && mods.includes(requiredModule);
      } catch {
        return false;
      }
    });
  }

  // 同一个账号可能命中多个角色（如学管主任同时是 TEACH_DEAN + TEACH_QTY）→ 合并 roles
  const map = new Map<string, StaffOption>();
  for (const r of rows) {
    const id = String(r.userId ?? '');
    if (!id) continue;
    const hit = map.get(id);
    if (hit) {
      if (!hit.roles.includes(String(r.roleCode))) hit.roles.push(String(r.roleCode));
      continue;
    }
    map.set(id, {
      userId: id,
      userName: String(r.userName ?? r.account ?? id),
      // 部门：班级模块只认「大学部(2)」，跨部门人员沿用大学部口径
      deptCode: 2,
      roles: [String(r.roleCode)],
    });
  }
  return [...map.values()].sort((a, b) => a.userName.localeCompare(b.userName, 'zh-Hans-CN'));
}

/**
 * 分组 → 班级表里对应的「ID 列 / 姓名列」
 *
 * 只覆盖**建班 5 岗位**。其余分组（学管/校长/财务/咨询）本地表里没有这个概念，
 * 上游不可用时就让它空着 —— 那几个岗位本来也不在本页选。
 */
const LOCAL_STAFF_COLUMNS: Record<string, { id: string; name: string; role: string }> = {
  headTeacher: { id: 'head_teacher_id', name: 'head_teacher_name', role: RoleCode.HEAD_TEACHER },
  teacher: { id: 'teacher_id', name: 'teacher_name', role: RoleCode.TEACHER },
  assistant: { id: 'assistant_id', name: 'assistant_name', role: RoleCode.ASSISTANT },
  projectManager: {
    id: 'project_manager_id',
    name: 'project_manager_name',
    role: RoleCode.PROJECT_MANAGER,
  },
  employmentTeacher: {
    id: 'employment_teacher_id',
    name: 'employment_teacher_name',
    role: RoleCode.EMPLOYMENT,
  },
};

/**
 * 从班级表里捞人员（上游 8001 不可用时的兜底）
 *
 * ⚠️ 用 `sms_class.t_class_info` / `sms_job.t_job_class` 这种**带库名**的写法，
 *    本连接绑在 sms_class 上，靠跨库限定名读另一张表（项目里 auth/demo-identities
 *    已经是这个写法，实测可读）。
 *
 * @param group  请求的分组（headTeacher / all …）；传 roleCode 时传空串
 * @param codes  该分组命中的角色码（与 ROLE_GROUPS 保持一致）
 */
async function staffFromClassTables(group: string, codes: string[]): Promise<StaffOption[]> {
  // 本组要捞哪几个岗位：`all` → 5 个全要；传了 roleCode → 按角色码反查岗位；否则就是 group 自己
  const postKeys =
    group === 'all' || group === ''
      ? Object.keys(LOCAL_STAFF_COLUMNS)
      : Object.keys(LOCAL_STAFF_COLUMNS).filter(
          (k) => LOCAL_STAFF_COLUMNS[k].role === group || group === k,
        );

  const map = new Map<string, StaffOption>();
  for (const key of postKeys) {
    const col = LOCAL_STAFF_COLUMNS[key];
    if (!codes.includes(col.role)) continue; // 该分组不含这个岗位
    for (const tbl of LOCAL_STAFF_TABLES) {
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = (await db(tbl)
          .where('is_deleted', false)
          .whereNotNull(col.id)
          .distinct()
          .select(col.id, col.name)) as Array<Record<string, unknown>>;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[staff] 兜底读 ${tbl}.${col.id} 失败：${(e as Error).message}`);
        continue;
      }
      for (const r of rows) {
        const id = r[col.id] as string;
        if (!id || map.has(id)) continue;
        map.set(id, {
          userId: id,
          userName: (r[col.name] as string) || id,
          // 兜底人员都来自班级表，部门一律按大学部（实训无独立部门，沿用大学部）
          deptCode: 2,
          roles: [col.role],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * @openapi
 * /api/class/meta/staff:
 *   get:
 *     tags: [元数据]
 *     summary: 人员选项（班主任 / 教员 / 助教 / 学管 / 校长 / 教务 / 财务）
 *     description: |
 *       转调登录模块（8001）的 internal 接口，把结果收窄成下拉框够用的三个字段。
 *       传 `group` 取某一类人（默认 all）；传 `roleCode` 则按原始角色码查。
 *       ★ 8001 不可用时自动从班级表（t_class_info / t_job_class）兜底，
 *         保证建班弹窗的 5 个岗位下拉不会「无数据」。
 *     parameters:
 *       - { in: query, name: group, schema: { type: string, enum: [headTeacher, teacher, assistant, studyManager, principal, eduAdmin, finance, market, all] } }
 *       - { in: query, name: roleCode, schema: { type: string } }
 *     responses:
 *       200: { description: 成功 }
 */
staffRouter.get(
  '/staff',
  wrap(async (req, res) => {
    const group = typeof req.query.group === 'string' ? req.query.group : 'all';
    const roleCode = typeof req.query.roleCode === 'string' ? req.query.roleCode : '';

    const codes = roleCode ? [roleCode] : (ROLE_GROUPS[group] ?? ROLE_GROUPS.all);

    /* ============================================================
     * ★ 2026-10-06 取人数值链路（口径：账户 → 角色）
     *   ① 首选：门户账号 × sms_perm 角色绑定（staffFromAccounts）
     *        —— 「谁是教员」= 谁的角色里有 TEACH_TUTOR，唯一事实来源
     *   ② 降级：班级表里出现过的人（staffFromClassTables）
     *        —— 只在 ① 查不到时兜底（例如权限库还没建人），
     *           宁可少列，也不能让建班 5 个岗位下拉变成「无数据」。
     *   ✗ 已废弃：HTTP 调 8001 登录模块 —— 本项目已单体，8001 不启动，
     *     这条链路恒失败，留着只会掩盖问题。
     * ============================================================ */
    let list = await staffFromAccounts(codes, roleCode ? '' : (GROUP_MODULE[group] ?? ''));

    if (!list.length) {
      list = await staffFromClassTables(roleCode ? '' : group, codes);
    }

    return ok(res, { list, total: list.length }, '查询成功');
  }),
);
