/**
 * 自检 · 自建权限点（新增 / 修改 / 删除）+ 页面管理「按部门分组」
 * ============================================================
 *
 * 【背景】
 *   用户在系统里加了「招生部 / 招生老师」，但权限树是**预置能力清单**
 *   （8 板块 · 55 功能点），清单里没有「招生」相关的功能点，于是给不出权限。
 *   本次加了一套「自己加权限点」的能力，格式与预置完全一致：
 *        板块（module） → 功能点（item） → 动作（action）
 *
 * 【这个脚本钉什么】
 *   一、静态口径（不需要起服务）：
 *       前端弹窗在、入口在 3 处、只能改自建项、页面管理不再出现「其他职位」；
 *       后端 4 个接口都在且写操作都挂了 checkPermission；
 *       预置项保护 / 名字重名 / 动作为空 三个业务码都在。
 *   二、真实接口全链路（需要 8004 + 5173 在线）：
 *       新增 → 出现 → 改名+加动作 → 改预置被拒(40027) → 勾给「招生老师」
 *       → 删除 → 授权被收回 → 职位权限回到原样。
 *   三、收尾核对：探针数据一行不剩，`is_custom` 列真实存在。
 *
 * 跑法：cd server-job && node scripts/_test-custom-perm-item.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BASE, ROOT, req, login, conn, makeChecker } from './_e2e-lib.mjs';

const { check, summary } = makeChecker();

/* ============================================================
 * 0. 工具
 * ============================================================ */

/** 剥注释：断言「某词应消失」时，先剥掉注释，否则自己的说明文字会污染计数 */
function read(p) {
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}
function stripComments(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '') // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, ''); // 整行 // 注释
}
const count = (s, needle) => s.split(needle).length - 1;

const F = {
  dlg: path.join(ROOT, 'web-job/src/perm/components/PermItemDialog.vue'),
  assign: path.join(ROOT, 'web-job/src/perm/views/PermAssign.vue'),
  page: path.join(ROOT, 'web-job/src/perm/views/PageManage.vue'),
  webApi: path.join(ROOT, 'web-job/src/perm/api/perm.ts'),
  route: path.join(ROOT, 'server-job/src/perm/routes/menu.route.ts'),
  svc: path.join(ROOT, 'server-job/src/perm/services/menuAdmin.service.ts'),
  permSvc: path.join(ROOT, 'server-job/src/perm/services/perm.service.ts'),
  types: path.join(ROOT, 'shared-types/src/perm/perm.ts'),
  codes: path.join(ROOT, 'shared-types/src/perm/common.ts'),
};
const S = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, stripComments(read(p))]));

console.log('\n===== 一、静态口径 =====');

/* ---- 1.1 弹窗组件 ---- */
check('弹窗组件 PermItemDialog.vue 存在', S.dlg.length > 1000, `${S.dlg.length} 字符`);
check(
  '弹窗调用了 4 个权限点接口（items/addItem/updateItem/removeItem）',
  ['menuApi.items()', 'menuApi.addItem(', 'menuApi.updateItem(', 'menuApi.removeItem('].every((k) =>
    S.dlg.includes(k),
  ),
);
check(
  '弹窗区分「预置只读」与「自建可改」',
  S.dlg.includes('editingPreset') && S.dlg.includes('预置'),
  'editingPreset 控制在编辑态',
);
check(
  '弹窗按 6 个动作基类做快速添加',
  count(S.dlg, '＋ {{ b.name }}') === 1 && S.dlg.includes('BASE_ACTIONS'),
);
check('弹窗有「新建板块」入口（__new__）', S.dlg.includes("NEW_MODULE = '__new__'"));

/* ---- 1.2 职位权限分配页 3 个入口 ---- */
check(
  'PermAssign 引入了 PermItemDialog 并真实挂载',
  S.assign.includes("import PermItemDialog from '@/perm/components/PermItemDialog.vue'") &&
    S.assign.includes('<PermItemDialog v-model="itemAdminOpen" @saved="onItemSaved"'),
);
check(
  '「＋ 新增权限」入口 1 处（页头；工具条 + 权限树底栏两处已按 2026-10-20 要求删除）',
  count(S.assign, 'itemAdminOpen = true') === 1,
  `实测 ${count(S.assign, 'itemAdminOpen = true')} 处`,
);
check(
  '保存后重新拉权限树并保留已勾草稿（onItemSaved）',
  S.assign.includes('async function onItemSaved') && S.assign.includes('assignApi.tree('),
);
check('权限树里给自建项打了「自建」标签', S.assign.includes('row.item.isCustom'));

/* ---- 1.4 弹窗内的按钮文案（2026-10-20 用户要求） ---- */
check(
  '★ 弹窗右上角的「＋ 新建权限」按钮已删除',
  !S.dlg.includes('＋ 新建权限'),
);
check(
  '删除按钮后，指引文案不再指向它（不能留死指引）',
  !S.dlg.includes('点右下角「＋ 新建权限」') && !S.dlg.includes('如需扩展请点「新建权限」'),
);
check(
  '★ 新建能力没丢：打开弹窗仍会 resetForm() 进「新增权限点」模式',
  /void loadItems\(\)\.then\(\(\) => resetForm\(\)\)/.test(S.dlg),
);
check(
  '★ 新建时底部按钮文案 =「保存权限」（不再是「保存权限点」）',
  S.dlg.includes("form.id ? '保存修改' : '保存权限'") && !S.dlg.includes('保存权限点'),
);

/* ---- 1.3 页面管理按部门分组 ---- */
check(
  '页面管理不再有「其他职位」这个分组标题',
  // 只钉「作为分组标题的那一处」；正文里「其他职位如需授权…」是正常措辞，不算
  count(S.page, '>其他职位<') === 0 && !S.page.includes('<span>其他职位</span>'),
  `实测 ${count(S.page, '>其他职位<')} 处标题`,
);
check(
  '页面管理按 deptName 分组渲染',
  S.page.includes('orphanDeptGroups') &&
    S.page.includes('toggleOrphanDept') &&
    S.page.includes('g.deptName'),
);
check(
  '未归属部门的兜底文案存在（data 里 deptName 为空时）',
  S.page.includes('未归属部门'),
);

/* ---- 1.4 前端 API ---- */
check(
  '前端 menuApi 有 4 个新方法',
  ['items: ()', 'addItem:', 'updateItem:', 'removeItem:'].every((k) => S.webApi.includes(k)),
);

/* ---- 1.5 后端路由 ---- */
check('路由 GET /menu/items 存在', S.route.includes("'/items'"));
check('路由 POST/PUT /menu/item 存在', count(S.route, "'/item'") === 2);
check('路由 DELETE /menu/item/:id 存在', S.route.includes("'/item/:id'"));
check(
  '3 个写接口都挂了 checkPermission(editPerm)（GET 为只读，走 router 级 permAuth）',
  count(S.route, "checkPermission('perm:权限配置:editPerm')") === 3,
  `实测 ${count(S.route, "checkPermission('perm:权限配置:editPerm')")} 处`,
);
check(
  '写操作都写了审计日志（addLog）',
  count(S.route, 'addLog(') >= 3,
);

/* ---- 1.6 后端服务 ---- */
check('服务里落地了 is_custom 列（含幂等补列）', S.svc.includes('is_custom') && S.svc.includes('information_schema'));
check('预置项保护已实现（PERM_ITEM_PROTECTED）', S.svc.includes('PERM_ITEM_PROTECTED'));
check('删除/修改后回填 perm_count', S.svc.includes('refreshRolePermCount'));
check('删权限点会连带清掉职位授权（t_perm_role_perm）', S.svc.includes('t_perm_role_perm'));
check('改功能点名会同步已授权记录', S.svc.includes('item_name'));
check('loadModules 透出 isCustom', S.permSvc.includes('isCustom'));

/* ---- 1.7 契约 ---- */
check('PermItem 增加 isCustom', S.types.includes('isCustom'));
check('新增 PermItemSavePayload / PermMenuItemAdmin 契约', S.types.includes('PermItemSavePayload') && S.types.includes('PermMenuItemAdmin'));
check(
  '三个业务码齐备（40026/40027/40028）',
  ['40026', '40027', '40028'].every((c) => S.codes.includes(c)),
);

/* ============================================================
 * 二、真实接口全链路
 * ============================================================ */

const DB_PERM = process.env.DB_NAME_PERM || 'sms_perm';
const ITEM_NAME = `探针招生权限点_${Date.now().toString().slice(-6)}`;
const ITEM_NAME2 = `${ITEM_NAME}_改`;

let db = null;
let token = '';
let itemId = '';
let roleId = '';
let roleName = '';
let permsBefore = null;
const apiOk = (await req(`${BASE}/api/perm/menu/items`, { timeout: 3000 })).status === 401;

if (!apiOk) {
  console.log('\n⚠️ 后端（8004 / 5173）未就绪，跳过第二部分真实接口验证。');
} else {
  console.log('\n===== 二、真实接口全链路 =====');
  try {
    token = await login('linx');
    check('门户账号可登录并拿到 token', !!token);

    /* ---- 2.1 基线 ---- */
    const base = await req(`${BASE}/api/perm/menu/items`, { token });
    const baseItems = base.json?.data || [];
    const baseTotal = baseItems.length;
    check('GET /menu/items 返回功能点清单', base.status === 200 && baseTotal > 40, `${baseTotal} 个`);
    check(
      '基线里全部为预置项（isCustom=false）',
      baseItems.every((x) => x.isCustom === false),
    );

    /* ---- 2.2 新增 ---- */
    const created = await req(`${BASE}/api/perm/menu/item`, {
      method: 'POST',
      token,
      body: {
        moduleKey: 'market',
        itemName: ITEM_NAME,
        remark: '自检探针，跑完即删',
        actions: [
          { actionName: '查看', baseAction: 1 },
          { actionName: '新建', baseAction: 2 },
        ],
      },
    });
    const cData = created.json?.data;
    itemId = cData?.id || '';
    check('POST 新增自建权限点成功', created.status === 200 && !!itemId, itemId);
    check('新增返回 created=true 且动作数=2', cData?.created === true && cData?.actionCount === 2);

    const afterAdd = await req(`${BASE}/api/perm/menu/items`, { token });
    const added = (afterAdd.json?.data || []).find((x) => x.id === itemId);
    check('新权限点立刻出现在清单里', !!added, added ? added.moduleName : '未找到');
    check('新项标记 isCustom=true、授权数=0', added?.isCustom === true && added?.grantedRoleCount === 0);
    check(
      '动作编码按基类自动补（view / add）',
      (added?.actions || []).map((a) => a.actionCode).join(',') === 'view,add',
      (added?.actions || []).map((a) => a.actionCode).join(','),
    );
    check('总数 +1', (afterAdd.json?.data || []).length === baseTotal + 1);

    /* ---- 2.3 修改（改名 + 加动作） ---- */
    const upd = await req(`${BASE}/api/perm/menu/item`, {
      method: 'PUT',
      token,
      body: {
        id: itemId,
        moduleKey: 'market',
        itemName: ITEM_NAME2,
        actions: [
          { actionName: '查看', baseAction: 1 },
          { actionName: '新建', baseAction: 2 },
          { actionName: '编辑', baseAction: 3 },
        ],
      },
    });
    check('PUT 修改自建权限点成功', upd.status === 200 && upd.json?.data?.created === false);
    check('修改后动作数=3', upd.json?.data?.actionCount === 3);
    const afterUpd = (await req(`${BASE}/api/perm/menu/items`, { token })).json?.data || [];
    check(
      '改名已生效',
      afterUpd.some((x) => x.id === itemId && x.itemName === ITEM_NAME2),
    );

    /* ---- 2.4 预置项保护 ---- */
    const preset = afterUpd.find((x) => x.isCustom === false);
    const prot = await req(`${BASE}/api/perm/menu/item`, {
      method: 'PUT',
      token,
      body: {
        id: preset.id,
        moduleKey: preset.moduleKey,
        itemName: preset.itemName + 'X',
        actions: [{ actionName: '查看', baseAction: 1 }],
      },
    });
    check(
      '改预置权限点被拒（40027 PERM_ITEM_PROTECTED）',
      // ⚠️ 本仓 BizError 默认 httpStatus=200，业务码只在 body 里（见 perm/middleware/errorHandler.ts）
      prot.json?.code === 40027,
      `HTTP ${prot.status} / code ${prot.json?.code}：${(prot.json?.message || '').slice(0, 40)}`,
    );
    const protDel = await req(`${BASE}/api/perm/menu/item/${preset.id}`, { method: 'DELETE', token });
    check(
      '删预置权限点被拒（40027）',
      protDel.json?.code === 40027,
      `HTTP ${protDel.status} / code ${protDel.json?.code}`,
    );

    /* ---- 2.5 勾给一个业务职位 ----
     * ⚠️ 原来写死「招生老师」。那个职位是用户在界面上自建的，随时可能被停用 / 删除
     *    （2026-10-20 实测：招生部连同招生老师已被逻辑删除，本脚本因此假报红 4 条）。
     *    断言的目标是「勾给职位 → 回显 1 个 → 删除时有 1 个职位被收回」这条链路，
     *    不依赖具体是哪个职位，所以改成「优先招生老师，否则任一启用的非预置职位」。 */
    db = conn(DB_PERM);
    const role =
      (await db('t_perm_role').where({ role_name: '招生老师', is_deleted: false }).first()) ||
      (await db('t_perm_role').where({ is_deleted: false, is_sys: false }).first()) ||
      (await db('t_perm_role').where({ is_deleted: false }).first());
    roleId = role?.id || '';
    roleName = role?.role_name || '（无可用职位）';
    check('库里有可用于授权的职位', !!roleId, `${roleName} / ${roleId}`);

    const tree0 = await req(`${BASE}/api/perm/assign/tree?roleId=${roleId}`, { token });
    permsBefore = tree0.json?.data?.perms || {};
    const cntBefore = Object.values(permsBefore).reduce((n, a) => n + (a?.length || 0), 0);

    const grantKey = `market||${ITEM_NAME2}`;
    const merged = { ...permsBefore, [grantKey]: ['view', 'add'] };
    const save = await req(`${BASE}/api/perm/assign/save`, {
      method: 'PUT',
      token,
      body: { roleId, perms: merged },
    });
    check(`把新权限点勾给「${roleName}」成功`, save.status === 200, `permCount=${save.json?.data?.permCount}`);
    check(
      '职位权限数 = 原值 + 2',
      Number(save.json?.data?.permCount) === cntBefore + 2,
      `${cntBefore} → ${save.json?.data?.permCount}`,
    );

    const granted = ((await req(`${BASE}/api/perm/menu/items`, { token })).json?.data || []).find(
      (x) => x.id === itemId,
    );
    check('清单回显「已被 1 个职位勾选」', granted?.grantedRoleCount === 1, String(granted?.grantedRoleCount));

    /* ---- 2.6 删除 → 授权一并收回 ---- */
    const del = await req(`${BASE}/api/perm/menu/item/${itemId}`, { method: 'DELETE', token });
    check('DELETE 删除自建权限点成功', del.status === 200, del.json?.data?.itemName);
    check('删除时收回 1 个职位的授权', del.json?.data?.affectedRoles === 1, String(del.json?.data?.affectedRoles));

    const afterDel = (await req(`${BASE}/api/perm/menu/items`, { token })).json?.data || [];
    check('删除后清单里不再有它', !afterDel.some((x) => x.id === itemId));
    check('总数回到基线', afterDel.length === baseTotal, `${afterDel.length} / ${baseTotal}`);
    itemId = '';

    const tree1 = await req(`${BASE}/api/perm/assign/tree?roleId=${roleId}`, { token });
    const permsAfter = tree1.json?.data?.perms || {};
    check('该职位上已没有这个权限点', !(grantKey in permsAfter));
    const cntAfter = Object.values(permsAfter).reduce((n, a) => n + (a?.length || 0), 0);
    check('职位权限数回到原值', cntAfter === cntBefore, `${cntAfter} / ${cntBefore}`);

    /* ---- 2.7 还原（保险：把权限原样写回） ---- */
    await req(`${BASE}/api/perm/assign/save`, {
      method: 'PUT',
      token,
      body: { roleId, perms: permsBefore },
    });
  } catch (e) {
    check('全链路未抛异常', false, e.message);
  } finally {
    /* 探针兜底清理：任何一步失败都不留垃圾 */
    try {
      if (itemId && token) await req(`${BASE}/api/perm/menu/item/${itemId}`, { method: 'DELETE', token });
      if (roleId && permsBefore && token) {
        await req(`${BASE}/api/perm/assign/save`, {
          method: 'PUT',
          token,
          body: { roleId, perms: permsBefore },
        });
      }
    } catch {
      /* 忽略 */
    }
  }
}

/* ============================================================
 * 三、收尾核对（直接查库）
 * ============================================================ */

console.log('\n===== 三、收尾核对 =====');
try {
  db = db || conn(DB_PERM);
  const col = await db.raw(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 't_perm_menu' AND COLUMN_NAME = 'is_custom'`,
    [DB_PERM],
  );
  const colRows = Array.isArray(col) ? col[0] : col;
  check('t_perm_menu 真实存在 is_custom 列', (colRows || []).length === 1, JSON.stringify(colRows?.[0] || {}));

  const menuLeft = await db('t_perm_menu').where('item_name', 'like', '探针招生权限点%');
  // ⚠️ 产品的「删除权限点」是**逻辑删除**（is_deleted=1，界面上看不见），
  //    但自检脚本是「一次性探针」，跑完必须一行不剩，否则每跑一次库里多一条垃圾。
  //    所以这里对探针数据做**物理清除**，并且只删 item_name 前缀命中的行。
  if (menuLeft.length) {
    const ids = menuLeft.map((r) => r.id);
    await db('t_perm_menu_action').whereIn('menu_id', ids).del();
    await db('t_perm_menu').whereIn('id', ids).del();
    await db('t_perm_role_perm').where('item_name', 'like', '探针招生权限点%').del();
    console.log(`  · 已物理清除探针遗留 ${menuLeft.length} 行（逻辑删除产生的）`);
  }
  const menuLeft2 = await db('t_perm_menu').where('item_name', 'like', '探针招生权限点%');
  check('t_perm_menu 没有留下探针数据', menuLeft2.length === 0, `${menuLeft2.length} 行`);

  const permLeft = await db('t_perm_role_perm').where('item_name', 'like', '探针招生权限点%');
  check('t_perm_role_perm 没有留下探针授权', permLeft.length === 0, `${permLeft.length} 行`);
} catch (e) {
  check('收尾核对可执行', false, e.message);
} finally {
  if (db) await db.destroy();
}

process.exit(summary() ? 0 : 1);
