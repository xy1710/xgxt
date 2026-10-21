/**
 * Swagger 注解 —— 职位管理（10 个接口）
 */

/**
 * @openapi
 * /api/perm/role/list:
 *   get:
 *     tags:
 *       - 职位管理
 *     summary: 职位分页列表
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/Size'
 *       - name: keyword
 *         in: query
 *         schema:
 *           type: string
 *         description: 职位名称模糊搜索（★ 2026-10-19 界面已去掉「职位编码」，按编码搜索仅为接口向后兼容保留）
 *       - name: roleType
 *         in: query
 *         schema:
 *           type: string
 *         description: 职位类型（取值见 /api/perm/option/get 的 roleTypes）
 *         example: 管理职位
 *       - name: roleStatus
 *         in: query
 *         schema:
 *           type: string
 *           enum: [启用, 停用]
 *       - name: deptId
 *         in: query
 *         schema:
 *           type: string
 *         description: 按所属部门过滤
 *       - name: isSys
 *         in: query
 *         schema:
 *           type: boolean
 *         description: 是否只看系统预置职位
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
 *                       example: 14
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     size:
 *                       type: integer
 *                       example: 20
 *                     list:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Role'
 */

/**
 * @openapi
 * /api/perm/role/detail:
 *   get:
 *     tags:
 *       - 职位管理
 *     summary: 职位详情（含完整权限映射）
 *     description: |
 *       `perms` 的形状是 **`模块key||功能点名` → 动作编码数组**：
 *
 *       ```json
 *       { "perms": { "market||预到校名单": ["view", "add", "edit"], "perm||职位管理": ["view"] } }
 *       ```
 *
 *       职位不存在时 `code = 40410`。
 *     parameters:
 *       - name: id
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
 *                   allOf:
 *                     - $ref: '#/components/schemas/Role'
 *                     - type: object
 *                       properties:
 *                         perms:
 *                           type: object
 *                           additionalProperties:
 *                             type: array
 *                             items:
 *                               type: string
 *                           example:
 *                             market||预到校名单:
 *                               - view
 *                               - add
 *                             perm||职位管理:
 *                               - view
 */

/**
 * @openapi
 * /api/perm/role/add:
 *   post:
 *     tags:
 *       - 职位管理
 *     summary: 新建职位（可同时提交权限）
 *     description: |
 *       权限标识 `perm:职位管理:add`。编码重复 40010，名称重复 40011。
 *
 *       ★ 2026-10-19 起界面不再维护「职位编码」：`roleCode` 改为**可选**，
 *       不传由后端自动生成（如 `ROLE_0001`）。显式传值时仍按老规则校验。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RoleSavePayload'
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
 *                       example: R15
 *                     permCount:
 *                       type: integer
 *                       example: 12
 */

/**
 * @openapi
 * /api/perm/role/update:
 *   put:
 *     tags:
 *       - 职位管理
 *     summary: 编辑职位
 *     description: |
 *       权限标识 `perm:职位管理:edit`。
 *
 *       **预置职位（is_sys = true）的 `roleCode` 不可修改** —— 登录 token 里存的就是它，改了会导致所有人权限失效。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/RoleSavePayload'
 *               - type: object
 *                 required:
 *                   - id
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: R15
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
 * /api/perm/role/status:
 *   put:
 *     tags:
 *       - 职位管理
 *     summary: 启用 / 停用职位
 *     description: |
 *       权限标识 `perm:职位管理:edit`。`roleStatus` 只接受「启用 / 停用」。
 *
 *       **SYS_ADMIN 职位不可停用**（40013）—— 停了就没人能改权限了。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id
 *               - roleStatus
 *             properties:
 *               id:
 *                 type: string
 *                 example: R15
 *               roleStatus:
 *                 type: string
 *                 enum: [启用, 停用]
 *                 example: 停用
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
 * /api/perm/role/delete/{id}:
 *   delete:
 *     tags:
 *       - 职位管理
 *     summary: 删除职位（逻辑删除）
 *     description: |
 *       权限标识 `perm:职位管理:del`。
 *
 *       **三条硬规则**：
 *       1. 预置职位（`is_sys = true`，共 13 个）**不可删除**（40013）；
 *       2. 有关联账号的职位**不可删除**（40012）；
 *       3. 逻辑删除时把 `role_code` 改写成 `原编码#DEL#时间戳` —— 因为唯一索引不认 `is_deleted`，
 *          不改写则同名编码无法重建。
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
 * /api/perm/role/overview:
 *   get:
 *     tags:
 *       - 职位管理
 *     summary: 职位 KPI
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
 *                     roleTotal:
 *                       type: integer
 *                       example: 14
 *                     presetTotal:
 *                       type: integer
 *                       example: 14
 *                     customTotal:
 *                       type: integer
 *                       example: 0
 *                     disabledTotal:
 *                       type: integer
 *                       example: 0
 */

/**
 * @openapi
 * /api/perm/role/codes:
 *   get:
 *     tags:
 *       - 职位管理
 *     summary: 职位编码清单（跨模块）
 *     description: 供其他模块（登录 / 教务 / 班级等）取职位编码清单，避免各自硬编码字符串。
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
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       roleCode:
 *                         type: string
 *                         example: SYS_ADMIN
 *                       roleName:
 *                         type: string
 *                         example: 系统管理员
 *                       roleType:
 *                         type: string
 *                         example: 管理职位
 */

/**
 * @openapi
 * /api/perm/role/export:
 *   get:
 *     tags:
 *       - 职位管理
 *     summary: 职位全量清单（不分页）
 *     description: 前端据此生成导出表格。
 *     parameters:
 *       - name: keyword
 *         in: query
 *         schema:
 *           type: string
 *       - name: roleType
 *         in: query
 *         schema:
 *           type: string
 *       - name: roleStatus
 *         in: query
 *         schema:
 *           type: string
 *           enum: [启用, 停用]
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
 *                     total:
 *                       type: integer
 *                       example: 14
 *                     list:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Role'
 */

/**
 * @openapi
 * /api/perm/role/import:
 *   post:
 *     tags:
 *       - 职位管理
 *     summary: 批量导入职位
 *     description: '权限标识 `perm:职位管理:add`。逐行校验：成功入库，失败回报行号与原因。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - list
 *             properties:
 *               list:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     roleName:
 *                       type: string
 *                       example: 助教组长
 *                     roleCode:
 *                       type: string
 *                       description: ★ 可选。2026-10-19 起界面不再维护，不传由后端自动生成
 *                       example: ROLE_0001
 *                     deptName:
 *                       type: string
 *                       example: 教学部
 *                     roleType:
 *                       type: string
 *                       example: 管理职位
 *     responses:
 *       200:
 *         description: 成功（含逐行结果）
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
 *                     success:
 *                       type: integer
 *                       example: 1
 *                     fail:
 *                       type: integer
 *                       example: 1
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           row:
 *                             type: integer
 *                             example: 2
 *                           reason:
 *                             type: string
 *                             example: 职位编码已存在
 */

export {};
