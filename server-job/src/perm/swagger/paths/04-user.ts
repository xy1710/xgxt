/**
 * Swagger 注解 —— 账号管理（10 个接口）
 */

/**
 * @openapi
 * /api/perm/user/list:
 *   get:
 *     tags:
 *       - 账号管理
 *     summary: 账号分页列表
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/Size'
 *       - name: keyword
 *         in: query
 *         schema:
 *           type: string
 *         description: 姓名 / 账号 / 手机号模糊搜索
 *       - name: deptId
 *         in: query
 *         schema:
 *           type: string
 *       - name: roleId
 *         in: query
 *         schema:
 *           type: string
 *       - name: userStatus
 *         in: query
 *         schema:
 *           type: string
 *           enum: [正常, 已停用, 已锁定]
 *       - name: needChangePwd
 *         in: query
 *         schema:
 *           type: boolean
 *       - name: withChild
 *         in: query
 *         schema:
 *           type: boolean
 *         description: 'true 时部门筛选含子部门（默认 false，只看本部门）'
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
 *                   example: 查询成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       example: 17
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     size:
 *                       type: integer
 *                       example: 20
 *                     list:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/User'
 */

/**
 * @openapi
 * /api/perm/user/detail:
 *   get:
 *     tags:
 *       - 账号管理
 *     summary: 账号详情
 *     description: '含 `roleIds / roleNames / effectivePermCount`。账号不存在时 `code = 40411`。'
 *     parameters:
 *       - $ref: '#/components/parameters/IdQuery'
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
 *                   $ref: '#/components/schemas/User'
 */

/**
 * @openapi
 * /api/perm/user/add:
 *   post:
 *     tags:
 *       - 账号管理
 *     summary: 新建账号
 *     description: |
 *       权限标识 `perm:账号管理:add`。返回生成的初始密码。密码留空则由后端按当前密码策略生成。
 *
 *       **字段校验（后端 zod 强制）**：姓名仅汉字 ≥ 2 位；账号字母/数字 4-20 位且全局唯一；
 *       手机号 11 位以 1 开头且全局唯一；年龄 20-65；**职位至少 1 个且不可为已停用职位**（40014）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserSavePayload'
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
 *                   example: 新增成功
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       example: U018
 *                     password:
 *                       type: string
 *                       example: Ab3#k9mQ
 */

/**
 * @openapi
 * /api/perm/user/update:
 *   put:
 *     tags:
 *       - 账号管理
 *     summary: 编辑账号
 *     description: '权限标识 `perm:账号管理:edit`。`password` 留空 = 不改密码。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/UserSavePayload'
 *               - type: object
 *                 required:
 *                   - id
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: U018
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OkNull'
 */

/**
 * @openapi
 * /api/perm/user/status:
 *   put:
 *     tags:
 *       - 账号管理
 *     summary: 启用 / 停用 / 锁定账号
 *     description: '权限标识 `perm:账号管理:edit`。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - userStatus
 *             properties:
 *               id:
 *                 type: string
 *                 example: U018
 *               userStatus:
 *                 type: string
 *                 enum: [正常, 已停用, 已锁定]
 *                 example: 已停用
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OkNull'
 */

/**
 * @openapi
 * /api/perm/user/reset-pwd:
 *   put:
 *     tags:
 *       - 账号管理
 *     summary: 重置密码
 *     description: '权限标识 `perm:账号管理:resetPwd`。不传 `newPassword` 则由后端生成，返回新密码；密码强度不符策略返回 40023。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 example: U018
 *               newPassword:
 *                 type: string
 *                 description: 可选。不传则按当前密码策略生成
 *               needChangePwd:
 *                 type: boolean
 *                 default: true
 *                 description: 是否要求该用户下次登录强制改密
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
 *                     newPassword:
 *                       type: string
 *                       example: Xy7#pQ2w
 */

/**
 * @openapi
 * /api/perm/user/unlock:
 *   put:
 *     tags:
 *       - 账号管理
 *     summary: 解锁账号
 *     description: '权限标识 `perm:账号管理:edit`。清零错误次数并置为「正常」。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *             properties:
 *               id:
 *                 type: string
 *                 example: U018
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OkNull'
 */

/**
 * @openapi
 * /api/perm/user/delete/{id}:
 *   delete:
 *     tags:
 *       - 账号管理
 *     summary: 删除账号（逻辑删除）
 *     description: '权限标识 `perm:账号管理:edit`。会释放账号 / 手机号唯一键；有业务数据时返回 40021。'
 *     parameters:
 *       - $ref: '#/components/parameters/IdPath'
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OkNull'
 */

/**
 * @openapi
 * /api/perm/user/overview:
 *   get:
 *     tags:
 *       - 账号管理
 *     summary: 账号 KPI（5 项，均可点击筛选）
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
 *                     userTotal:
 *                       type: integer
 *                       example: 17
 *                     normalTotal:
 *                       type: integer
 *                       example: 15
 *                     disabledTotal:
 *                       type: integer
 *                       example: 1
 *                     lockedTotal:
 *                       type: integer
 *                       example: 1
 *                     needChangePwdTotal:
 *                       type: integer
 *                       example: 3
 */

/**
 * @openapi
 * /api/perm/user/auth-profile:
 *   get:
 *     tags:
 *       - 账号管理
 *     summary: 鉴权档案（跨模块 · 不鉴权）
 *     description: |
 *       登录模块用这个接口取用户的职位 / 权限点 / 数据范围，再签发 token。
 *
 *       - `permissions` 是**所有职位权限的并集去重**，元素形如 `模块:功能点:动作中文名`；
 *       - `dataScope` 取所有职位中**最宽的一档**（1 本人 / 2 本班级 / 3 本部门 / 4 全部数据）；
 *       - **不返回密码字段**。
 *     security: []
 *     parameters:
 *       - name: account
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         example: admin
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
 *                   $ref: '#/components/schemas/AuthProfile'
 */

export {};
