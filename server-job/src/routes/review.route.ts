/**
 * 复盘路由（复盘填写 / 信息档案 - 复盘信息）
 *
 * 脑图字段：
 *   复盘填写 - 界面：姓名 / 工资 / 岗位 / 面试结论 / 复盘结论
 *   复盘填写 - 操作：新建 / 编辑 / 详情 / 搜索·筛选 / 上传录音
 *   信息档案 - 复盘信息：复盘时间 / 岗位 / 时间 / 结论
 *
 * ⚠️ 上传录音的实现：前端把音频文件读成 base64 dataURL，走普通 JSON 提交。
 *    这样不用额外引入 multer / 对象存储 —— 交付包能直接跑起来最重要。
 *    前端已限制单个文件 ≤ 5MB。
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  BizCode,
  INTERVIEW_CONCLUSION_NAME,
  REVIEW_CONCLUSION_NAME,
  InterviewConclusion,
  ReviewConclusion,
  NotificationType,
  StudentStatus,
} from 'shared-types';
import { ok, page } from '../utils/response';
import { db } from '../utils/db';
import { wrap } from '../utils/wrap';
import { validate } from '../middleware/validate';
import { BizError } from '../middleware/errorHandler';
import { pushNotification } from '../utils/empNotice';
// ★ 2026-10-16：姓名可手填 → 复用「按姓名尽量匹配学生」的共用逻辑
import { resolveStudentByName } from '../utils/studentResolve';
// ★ 2026-10-16：补上阶段隔离（这个模块原来完全没有 → 任何角色都能看到全部复盘）
import { applyTrainingScope } from '../utils/stageScope';
// ★ 2026-10-16：班级下拉选项（只读，就业老师也有权限）
import { listJobClassOptions } from './shared/jobClassOptions';

export const reviewRouter = Router();

const TABLE = 't_review';
const STUDENT = 't_student_base';

/* ============================================================
 * 0. 班级下拉选项（只读）
 *    ⚠️ 不要改用 /api/job/class/options —— 就业老师没有「班级管理」页面权限，
 *       调用会 403（前端弹「您没有该操作的权限」）。详见 routes/shared/jobClassOptions.ts
 * ============================================================ */
reviewRouter.get('/classes', listJobClassOptions);

const SELECT_FIELDS = [
  'id', 'student_id', 'student_no', 'student_name', 'class_name',
  'review_time', 'interview_time', 'position', 'salary',
  'interview_conclusion', 'review_conclusion', 'audio_name', 'detail', 'create_time',
];

function toVo(r: any, withAudio = false) {
  const vo: any = {
    id: r.id,
    studentId: r.student_id,
    studentNo: r.student_no,
    studentName: r.student_name,
    className: r.class_name,
    reviewTime: r.review_time,
    interviewTime: r.interview_time,
    position: r.position,
    salary: r.salary === null || r.salary === undefined ? undefined : Number(r.salary),
    interviewConclusion: r.interview_conclusion,
    interviewConclusionName: INTERVIEW_CONCLUSION_NAME[r.interview_conclusion] || '',
    reviewConclusion: r.review_conclusion,
    reviewConclusionName: REVIEW_CONCLUSION_NAME[r.review_conclusion] || '',
    audioName: r.audio_name,
    hasAudio: !!r.audio_name,
    detail: r.detail,
    createTime: r.create_time,
  };
  if (withAudio) vo.audioData = r.audio_data;
  return vo;
}

/* ============================================================
 * 1. 列表查询（含搜索/筛选）
 *    GET /api/job/review/list?studentName=张&reviewConclusion=2
 * ============================================================ */

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  studentId: z.string().optional(),
  studentName: z.string().optional(),
  // ★ 2026-10-16：班级筛选下拉
  classId: z.string().optional(),
  position: z.string().optional(),
  interviewConclusion: z.coerce.number().int().optional(),
  reviewConclusion: z.coerce.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

reviewRouter.get(
  '/list',
  validate(listSchema),
  wrap(async (req, res) => {
    const q = (req as any).validated as z.infer<typeof listSchema>;

    const query = db(TABLE).where('is_deleted', false);

    // ★ 2026-10-16：补阶段隔离 —— 老师只能看到自己班级的数据
    //   就业老师 / 项目经理 → 只看自己带的实训班；班主任（大学侧）不看实训/就业数据；
    //   校长 / 学管 / 管理员 → 不限。
    //   ownCreatedBy：姓名可手填 → 未关联学生（student_id 为 NULL）的记录，
    //   也要让**建单人自己**看得到，否则建完就"消失"了。
    await applyTrainingScope(query, req, { table: TABLE, via: 'student', ownCreatedBy: true });

    if (q.studentId) query.andWhere('student_id', q.studentId);
    // ★ 2026-10-16：班级筛选 —— 复盘表没有 class_id（只有 class_name 快照），
    //   所以经 student_id 反查「当前在该班的学生」。学生调过班也能按新班查到。
    if (q.classId) {
      query.whereIn(
        'student_id',
        db(STUDENT).select('id').where('class_id', q.classId).where('is_deleted', false),
      );
    }
    if (q.studentName) query.andWhere('student_name', 'like', `%${q.studentName}%`);
    if (q.position) query.andWhere('position', 'like', `%${q.position}%`);
    if (q.interviewConclusion) query.andWhere('interview_conclusion', q.interviewConclusion);
    if (q.reviewConclusion) query.andWhere('review_conclusion', q.reviewConclusion);
    if (q.startDate) query.andWhere('review_time', '>=', `${q.startDate} 00:00`);
    if (q.endDate) query.andWhere('review_time', '<=', `${q.endDate} 23:59`);

    const [{ total }] = await query.clone().count({ total: '*' });

    const rows = await query
      .clone()
      .select(SELECT_FIELDS)
      .orderBy('review_time', 'desc')
      .limit(q.size)
      .offset((q.page - 1) * q.size);

    res.json(page(rows.map((r: any) => toVo(r, false)), Number(total), q));
  }),
);

/* ============================================================
 * 2. 详情（带录音内容）
 *    GET /api/job/review/detail?id=xxx
 * ============================================================ */

reviewRouter.get(
  '/detail',
  validate(z.object({ id: z.string().min(1, '必须传 id') })),
  wrap(async (req, res) => {
    const { id } = (req as any).validated as { id: string };

    // ★ 2026-10-16：详情也要过数据范围，否则拿到 id 就能绕过列表看别人的复盘。
    //   不通过时统一抛「不存在」，避免暴露"这条记录存在但你没权限"。
    const guard: any = db(TABLE).where({ id, is_deleted: false });
    await applyTrainingScope(guard, req, { table: TABLE, via: 'student', ownCreatedBy: true });
    if (!(await guard.first())) throw new BizError(BizCode.PARAM_ERROR, '复盘记录不存在');

    const row = await db(TABLE)
      .where({ id, is_deleted: false })
      .first([
        ...SELECT_FIELDS,
        'audio_data',
      ] as any);

    if (!row) throw new BizError(BizCode.PARAM_ERROR, '复盘记录不存在');

    res.json(ok(toVo(row, true)));
  }),
);

/* ============================================================
 * 3. 新增
 *    POST /api/job/review/add
 * ============================================================ */

/**
 * ★ 2026-10-02（斌哥）：约束「面试结论 = 已发 offer」时必须配「复盘结论 = 已签约入职」
 *
 * 【为什么】
 *   发了 offer 基本就等于签约了。两个字段自由填会出现
 *   「已发 offer + 保持当前策略」这种自相矛盾的记录。
 *   前端已经做了联动（自动选中「已签约入职」+ 锁住其它选项），这里是**服务端兜底**，
 *   防止有人绕过前端直接调接口。
 */
function assertOfferConclusion(
  interviewConclusion?: number | null,
  reviewConclusion?: number | null,
): void {
  if (
    interviewConclusion === InterviewConclusion.OFFER &&
    reviewConclusion !== ReviewConclusion.SIGNED
  ) {
    throw new BizError(
      BizCode.PARAM_ERROR,
      '「面试结论」选了「已发 offer」时，复盘结论只能是「已签约入职」',
    );
  }
}

const addSchema = z.object({
  studentId: z.string().optional(),
  // ★ 2026-10-16：姓名改为可直接手填（原先是必须从学生下拉里选）
  studentName: z.string().min(1, '请输入姓名').max(50, '姓名最长 50 个字'),
  reviewTime: z.string().min(1, '请选择复盘时间'),
  interviewTime: z.string().max(32).optional(),
  position: z.string().max(100).optional(),
  salary: z.coerce.number().min(0).max(1000000).optional(),
  interviewConclusion: z.coerce.number().int().min(1).max(4).optional(),
  reviewConclusion: z.coerce.number().int().min(1).max(4).optional(),
  audioName: z.string().max(200).optional(),
  audioData: z.string().optional(),
  detail: z.string().max(2000).optional(),
});

reviewRouter.post(
  '/add',
  validate(addSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof addSchema>;

    // ★ 2026-10-16：姓名可手填 → 能唯一匹配到学生就自动关联（带出学号/班级），否则只记姓名
    const student = await resolveStudentByName(body.studentId, body.studentName);

    // ★ 2026-10-02（斌哥）：面试结论选了「已发 offer」→ 复盘结论只能是「已签约入职」
    //   前端已经做了联动（自动选中 + 锁住），这里**兜底**，防止绕过前端直接调接口。
    assertOfferConclusion(body.interviewConclusion, body.reviewConclusion);

    const id = randomUUID();
    await db(TABLE).insert({
      id,
      student_id: student ? student.id : null,
      student_no: student ? student.student_no : null,
      student_name: body.studentName,
      class_name: student ? student.class_name : null,
      review_time: body.reviewTime,
      interview_time: body.interviewTime ?? null,
      position: body.position ?? null,
      salary: body.salary ?? null,
      interview_conclusion: body.interviewConclusion ?? null,
      review_conclusion: body.reviewConclusion ?? null,
      audio_name: body.audioName ?? null,
      audio_data: body.audioData ?? null,
      detail: body.detail ?? null,
      is_deleted: false,
      create_time: new Date(),
      create_by: req.user?.userId || 'system',
    });

    // ---- 拿到 offer 自动发一条就业通知，让消息中心联动起来 ----
    if (body.interviewConclusion === InterviewConclusion.OFFER) {
      const noPart = student ? `（${student.student_no}）` : '';
      await pushNotification({
        title: `${body.studentName} 已获得 offer`,
        content: `学生 ${body.studentName}${noPart}在「${body.position || '未知岗位'}」岗位面试中已收到 offer，薪资 ${body.salary ? `${body.salary} 元/月` : '待确认'}，请及时跟进签约。`,
        type: NotificationType.EMPLOYMENT,
        receiver: '就业老师',
        createBy: req.user?.userId,
      });
    }

    // ---- ★ 2026-10-02：选了「已签约入职」→ 提示前端问一句「要不要标记为已就业」 ----
    //   只在学生**还在待就业(9)** 时才提示（已经是已就业的不用再问）。
    //   ⚠️ 这里**不改状态**，只把"建议"回给前端，由老师点确认后才调
    //      POST /api/job/student/confirm-employment —— 避免"悄悄改错"。
    //   ★ 2026-10-16：没匹配到学生（student 为 null）就没有可标记的对象 → 不提示
    const suggestEmploy =
      !!student &&
      body.reviewConclusion === ReviewConclusion.SIGNED &&
      student.student_status === StudentStatus.WAIT_EMPLOY;

    res.json(ok({ id, suggestEmploy }, '新增成功'));
  }),
);

/* ============================================================
 * 4. 修改
 *    PUT /api/job/review/update
 * ============================================================ */

const updateSchema = addSchema.extend({ id: z.string().min(1, '必须传 id') });

reviewRouter.put(
  '/update',
  validate(updateSchema),
  wrap(async (req, res) => {
    const body = (req as any).validated as z.infer<typeof updateSchema>;

    const row = await db(TABLE).where({ id: body.id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '复盘记录不存在或已被删除');

    // ★ 同新增：姓名可手填，能唯一匹配到学生就重新关联，否则只记姓名
    const student = await resolveStudentByName(body.studentId, body.studentName);

    // ★ 2026-10-02（斌哥）：同 add —— 服务端兜底校验「发 offer 必须配已签约入职」
    assertOfferConclusion(body.interviewConclusion, body.reviewConclusion);

    await db(TABLE).where({ id: body.id }).update({
      student_id: student ? student.id : null,
      student_no: student ? student.student_no : null,
      student_name: body.studentName,
      class_name: student ? student.class_name : null,
      review_time: body.reviewTime,
      interview_time: body.interviewTime ?? null,
      position: body.position ?? null,
      salary: body.salary ?? null,
      interview_conclusion: body.interviewConclusion ?? null,
      review_conclusion: body.reviewConclusion ?? null,
      audio_name: body.audioName ?? null,
      audio_data: body.audioData ?? null,
      detail: body.detail ?? null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    // ★ 2026-10-02：同 add —— 选了「已签约入职」且学生还在待就业 → 提示前端确认
    //   ★ 2026-10-16：未匹配到学生时不提示（没有可标记的对象）
    const suggestEmploy =
      !!student &&
      body.reviewConclusion === ReviewConclusion.SIGNED &&
      student.student_status === StudentStatus.WAIT_EMPLOY;

    res.json(ok({ suggestEmploy }, '修改成功'));
  }),
);

/* ============================================================
 * 5. 删除（逻辑删除）
 *    DELETE /api/job/review/delete/:id
 * ============================================================ */

reviewRouter.delete(
  '/delete/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '复盘记录不存在或已被删除');

    await db(TABLE).where({ id }).update({
      is_deleted: true,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '删除成功'));
  }),
);

/** 删除录音（只清音频字段，复盘正文保留） */
reviewRouter.put(
  '/remove-audio/:id',
  wrap(async (req, res) => {
    const { id } = req.params;

    const row = await db(TABLE).where({ id, is_deleted: false }).first();
    if (!row) throw new BizError(BizCode.PARAM_ERROR, '复盘记录不存在');

    await db(TABLE).where({ id }).update({
      audio_name: null,
      audio_data: null,
      update_time: new Date(),
      update_by: req.user?.userId || 'system',
    });

    res.json(ok(null, '录音已删除'));
  }),
);

export default reviewRouter;
