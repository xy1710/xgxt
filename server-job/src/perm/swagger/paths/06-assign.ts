/**
 * Swagger 注解 —— 职位权限分配（5 个接口）
 */

/**
 * @openapi
 * /api/perm/assign/role-list:
 *   get:
 *     tags:
 *       - 职位权限分配
 *     summary: 左栏职位清单
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: 操作成功
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: R01
 *                       roleName:
 *                         type: string
 *                         example: 系统管理员
 *                       roleCode:
 *                         type: string
 *                         example: SYS_ADMIN
 *                       roleType:
 *                         type: string
 *                         example: 管理职位
 *                       roleStatus:
 *                         type: string
 *                         enum: [启用, 停用]
 *                       isSys:
 *                         type: boolean
 *                         example: true
 *                       permCount:
 *                         type: integer
 *                         example: 185
 */

/**
 * @openapi
 * /api/perm/assign/tree:
 *   get:
 *     tags:
 *       - 职位权限分配
 *     summary: 权限树 + 勾选态 + 实时统计
 *     parameters:
 *       - name: roleId
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         example: R01
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: 操作成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     roleId:
 *                       type: string
 *                       example: R01
 *                     roleName:
 *                       type: string
 *                       example: 系统管理员
 *                     modules:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PermModule'
 *                     checked:
 *                       type: object
 *                       description: '已勾选的权限：`模块key||功能点名` → 动作编码数组'
 *                       additionalProperties:
 *                         type: array
 *                         items:
 *                           type: string
 *                     stats:
 *                       type: object
 *                       properties:
 *                         checkedCount:
 *                           type: integer
 *                           example: 185
 *                         totalCount:
 *                           type: integer
 *                           example: 185
 */

/**
 * @openapi
 * /api/perm/assign/save:
 *   put:
 *     tags:
 *       - 职位权限分配
 *     summary: 保存职位权限（全量覆盖）
 *     description: |
 *       权限标识 `perm:权限配置:editPerm`。**这是本模块最关键的一个接口。**
 *
 *       语义：**提交的勾选状态 = 该职位的最终权限**。后端在事务里先 `WHERE role_id = ?` 全删、
 *       再分片（每 200 条）插入，最后回填 `t_perm_role.perm_count`。
 *
 *       > 为什么必须全量覆盖？做成增量合并的话，用户**取消勾选后权限会残留** ——
 *       > 这类「幽灵权限」在真实系统里属于安全事故，所以这里刻意不做增量。
 *       > 代价是每次保存都要重写该职位的全部权限行，但单个职位最多 185 行，完全可接受。
 *
 *       提交空对象会返回 40025（权限全量覆盖内容为空）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roleId
 *               - perms
 *             properties:
 *               roleId:
 *                 type: string
 *                 example: R01
 *               perms:
 *                 type: object
 *                 description: '`模块key||功能点名` → 动作编码数组'
 *                 additionalProperties:
 *                   type: array
 *                   items:
 *                     type: string
 *                 example:
 *                   market||预到校名单:
 *                     - view
 *                     - add
 *                     - edit
 *                   market||跟进记录:
 *                     - view
 *                     - add
 *                     - edit
 *     responses:
 *       200:
 *         description: 成功，返回保存后的权限条数
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 message:
 *                   type: string
 *                   example: 保存成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     permCount:
 *                       type: integer
 *                       example: 723
 */

/**
 * @openapi
 * /api/perm/assign/copy:
 *   post:
 *     tags:
 *       - 职位权限分配
 *     summary: 从其他职位复制权限
 *     description: '权限标识 `perm:权限配置:editPerm`。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetRoleId
 *               - sourceRoleId
 *             properties:
 *               targetRoleId:
 *                 type: string
 *                 example: R15
 *               sourceRoleId:
 *                 type: string
 *                 example: R01
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 data:
 *                   type: object
 *                   properties:
 *                     permCount:
 *                       type: integer
 *                       example: 185
 *                     sourceRoleName:
 *                       type: string
 *                       example: 系统管理员
 */

/**
 * @openapi
 * /api/perm/assign/reset:
 *   post:
 *     tags:
 *       - 职位权限分配
 *     summary: 清空 / 全给权限
 *     description: '权限标识 `perm:权限配置:editPerm`。`mode = full` 是调试用（一键全给 185 个权限点）。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roleId
 *             properties:
 *               roleId:
 *                 type: string
 *                 example: R15
 *               mode:
 *                 type: string
 *                 enum: [clear, full]
 *                 default: clear
 *                 description: clear 清空 / full 全给（调试用）
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: integer
 *                   example: 200
 *                 data:
 *                   type: object
 *                   properties:
 *                     permCount:
 *                       type: integer
 *                       example: 0
 */

export {};
