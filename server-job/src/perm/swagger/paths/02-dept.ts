/**
 * Swagger 注解 —— 部门管理（7 个接口）
 */

/**
 * @openapi
 * /api/perm/dept/list:
 *   get:
 *     tags:
 *       - 部门管理
 *     summary: 部门分页列表
 *     parameters:
 *       - $ref: '#/components/parameters/Page'
 *       - $ref: '#/components/parameters/Size'
 *       - name: keyword
 *         in: query
 *         schema:
 *           type: string
 *         description: 部门名称 / 简称模糊搜索
 *         example: 教学
 *       - name: parentId
 *         in: query
 *         schema:
 *           type: string
 *         description: 按上级部门过滤
 *         example: D00
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
 *                       example: 11
 *                     page:
 *                       type: integer
 *                       example: 1
 *                     size:
 *                       type: integer
 *                       example: 20
 *                     list:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Dept'
 */

/**
 * @openapi
 * /api/perm/dept/tree:
 *   get:
 *     tags:
 *       - 部门管理
 *     summary: 部门树
 *     description: '两级树（校级 → 部门 → 学段），节点带 `roleCount / userCount`，统计口径含子部门。'
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
 *                     $ref: '#/components/schemas/DeptTreeNode'
 */

/**
 * @openapi
 * /api/perm/dept/overview:
 *   get:
 *     tags:
 *       - 部门管理
 *     summary: 部门 KPI
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
 *                     deptTotal:
 *                       type: integer
 *                       example: 6
 *                     stageTotal:
 *                       type: integer
 *                       example: 5
 *                     roleTotal:
 *                       type: integer
 *                       example: 14
 *                     userTotal:
 *                       type: integer
 *                       example: 17
 */

/**
 * @openapi
 * /api/perm/dept/detail:
 *   get:
 *     tags:
 *       - 部门管理
 *     summary: 部门详情
 *     description: '部门不存在时 `code = 40412`。'
 *     parameters:
 *       - name: id
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         example: D01
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
 *                   $ref: '#/components/schemas/Dept'
 */

/**
 * @openapi
 * /api/perm/dept/add:
 *   post:
 *     tags:
 *       - 部门管理
 *     summary: 新建部门
 *     description: '权限标识 `perm:职位管理:add`。`deptLevel` 由后端按「上级.deptLevel + 1」计算，前端不传。名称重复返回 40015。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DeptSavePayload'
 *     responses:
 *       200:
 *         description: 成功，返回新部门 ID
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
 *                       example: D12
 *       403:
 *         description: 无权限（40302）
 */

/**
 * @openapi
 * /api/perm/dept/update:
 *   put:
 *     tags:
 *       - 部门管理
 *     summary: 编辑部门
 *     description: '权限标识 `perm:职位管理:edit`。'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/DeptSavePayload'
 *               - type: object
 *                 required:
 *                   - id
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: D01
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
 * /api/perm/dept/delete/{id}:
 *   delete:
 *     tags:
 *       - 部门管理
 *     summary: 删除部门（逻辑删除）
 *     description: |
 *       权限标识 `perm:职位管理:del`。
 *
 *       **删除校验顺序**：
 *       1. 校级部门 → 40016 部门被引用
 *       2. 有子部门 → 40017 部门下还有子部门
 *       3. 被职位 / 账号引用 → 40016
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         example: D12
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OkNull'
 */

export {};
