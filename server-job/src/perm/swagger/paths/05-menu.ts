/**
 * Swagger 注解 —— 权限树（2 个接口）
 */

/**
 * @openapi
 * /api/perm/menu/tree:
 *   get:
 *     tags:
 *       - 权限树
 *     summary: 完整权限树
 *     description: |
 *       8 模块 / 53 个顶级功能点 / 185 动作。
 *
 *       带 **60 秒内存缓存**；传 `refresh=1` 强制刷新（改了 `t_perm_menu` 表后用它）。
 *     parameters:
 *       - name: refresh
 *         in: query
 *         schema:
 *           type: integer
 *           enum: [0, 1]
 *         description: 传 1 强制绕过缓存重新查库
 *         example: 1
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
 *                     $ref: '#/components/schemas/PermModule'
 */

/**
 * @openapi
 * /api/perm/menu/stats:
 *   get:
 *     tags:
 *       - 权限树
 *     summary: 权限树统计
 *     description: 顶栏右上角展示，让人一眼知道当前系统有多少权限点。
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
 *                     modCount:
 *                       type: integer
 *                       example: 8
 *                     itemCount:
 *                       type: integer
 *                       example: 53
 *                     actionCount:
 *                       type: integer
 *                       example: 185
 */

/**
 * @openapi
 * /api/perm/menu/items:
 *   get:
 *     tags:
 *       - 权限树
 *     summary: 权限点清单（管理视图 · 扁平分页无关）
 *     description: |
 *       给「新增 / 管理权限」弹窗用的扁平清单：每个功能点一行，带它的动作、
 *       是否自建（`isCustom`）以及**已被多少个职位勾选**（`grantedRoleCount`）。
 *
 *       与 `/api/perm/menu/tree` 的区别：tree 是给权限树勾选用（按模块嵌套、带缓存），
 *       items 是给管理端编辑用（扁平、实时读库、带授权计数）。
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
 *                       id:
 *                         type: string
 *                         example: MN_market_01
 *                       moduleKey:
 *                         type: string
 *                         example: market
 *                       moduleName:
 *                         type: string
 *                         example: 市场管理
 *                       moduleIcon:
 *                         type: string
 *                         example: 📣
 *                       moduleSort:
 *                         type: integer
 *                         example: 3
 *                       itemName:
 *                         type: string
 *                         example: 预到校名单
 *                       parentItemName:
 *                         type: string
 *                         nullable: true
 *                       itemSort:
 *                         type: integer
 *                         example: 1
 *                       remark:
 *                         type: string
 *                         nullable: true
 *                       isCustom:
 *                         type: boolean
 *                         description: true = 管理员自建（可改可删）；false = 系统预置（只读）
 *                       grantedRoleCount:
 *                         type: integer
 *                         example: 0
 *                       actions:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: string
 *                             actionCode:
 *                               type: string
 *                               example: view
 *                             actionName:
 *                               type: string
 *                               example: 查看
 *                             baseAction:
 *                               type: integer
 *                               example: 1
 *                             actionSort:
 *                               type: integer
 *                               example: 1
 */

/**
 * @openapi
 * /api/perm/menu/item:
 *   post:
 *     tags:
 *       - 权限树
 *     summary: 新增自建权限点
 *     description: |
 *       新增一个「模块 → 功能点 → 动作」形态的权限点，**格式与系统预置完全一致**。
 *
 *       · `moduleKey` 传 `"__new__"`（或不传）表示同时新建板块，需给 `moduleName`；
 *         后端会分配 `custom_N` 形式的模块标识。
 *       · 同一板块内功能点重名会被拒绝（`40026`）。
 *       · `actionCode` 可留空，后端按 `baseAction` 自动补（查看→view、新建→add…）；
 *         同一功能点内编码重复时自动加序号去重。
 *       · 需要权限 `perm:权限配置:editPerm`。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemName, actions]
 *             properties:
 *               moduleKey:
 *                 type: string
 *                 example: market
 *                 description: 已有板块标识；新建板块传 __new__
 *               moduleName:
 *                 type: string
 *                 example: 招生管理
 *                 description: 新建板块时的板块名称
 *               moduleIcon:
 *                 type: string
 *                 example: 🎓
 *               moduleSort:
 *                 type: integer
 *                 example: 9
 *               itemName:
 *                 type: string
 *                 example: 招生报名登记
 *               parentItemName:
 *                 type: string
 *                 nullable: true
 *               remark:
 *                 type: string
 *               actions:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [actionName]
 *                   properties:
 *                     actionCode:
 *                       type: string
 *                       example: view
 *                     actionName:
 *                       type: string
 *                       example: 查看
 *                     baseAction:
 *                       type: integer
 *                       enum: [1, 2, 3, 4, 5, 6]
 *                       example: 1
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
 *                     id:
 *                       type: string
 *                       example: MN_c_0cd7e220
 *                     moduleKey:
 *                       type: string
 *                       example: market
 *                     moduleName:
 *                       type: string
 *                       example: 市场管理
 *                     itemName:
 *                       type: string
 *                       example: 招生报名登记
 *                     actionCount:
 *                       type: integer
 *                       example: 3
 *                     created:
 *                       type: boolean
 *                       example: true
 *       400:
 *         description: |
 *           参数校验失败 / 重名（40026 PERM_ITEM_NAME_EXISTS）/
 *           没有动作（40028 PERM_ITEM_ACTIONS_EMPTY）
 */

/**
 * @openapi
 * /api/perm/menu/item:
 *   put:
 *     tags:
 *       - 权限树
 *     summary: 修改自建权限点
 *     description: |
 *       · **只允许改自建项**（`is_custom=1`）；改预置项返回 `40027 PERM_ITEM_PROTECTED`。
 *       · 不允许跨板块移动（`moduleKey` 必须与原值一致）。
 *       · 功能点改名时，会同步更新 `t_perm_role_perm.item_name`，已有授权不丢。
 *       · 动作按 `actionCode` 做 diff：新增的补插、改名的更新、被移除的连同
 *         各职位对它的授权一起删除，最后回填受影响职位的 `perm_count`。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/PermItemSavePayload'
 *               - type: object
 *                 required: [id]
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: MN_c_0cd7e220
 *     responses:
 *       200:
 *         description: 成功（返回结构同 POST，`created=false`）
 *       400:
 *         description: 预置权限点只读（40027）/ 重名（40026）/ 动作被清空（40028）
 */

/**
 * @openapi
 * /api/perm/menu/item/{id}:
 *   delete:
 *     tags:
 *       - 权限树
 *     summary: 删除自建权限点
 *     description: |
 *       只允许删自建项。删除时会：
 *       ① 逻辑删除功能点与它的动作；② **物理删除**所有职位对它的授权；
 *       ③ 回填受影响职位的 `perm_count`。
 *
 *       返回里带 `affectedRoles`，前端据此提示「已收回 N 个职位的授权」。
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         example: MN_c_0cd7e220
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
 *                     itemName:
 *                       type: string
 *                       example: 招生报名登记
 *                     affectedRoles:
 *                       type: integer
 *                       example: 1
 *       400:
 *         description: 预置权限点不可删除（40027）
 */

export {};
