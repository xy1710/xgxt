/**
 * 回归自检：密码规则必须真的生效（自助改密不能绕过）
 * ============================================================
 *
 * 【背景 / 用户反馈】
 *   「用户自己修改密码，密码设置规则要求有大写字母，但测试时没有写大写字母
 *     一样修改成功了。用户修改的密码要与规则一样才能修改成功。」
 *
 * 【根因】
 *   密码规则被写死在三个地方，而且口径不一样：
 *     · perm/routes/user.route.ts 的 assertPwdStrength（账号管理用）
 *       ＝ 读 t_perm_rule：≥8 位 + 含大写字母 + 含数字
 *     · portal/services/account.service.ts 的 assertNewPassword（顶栏自助改密用）
 *       ＝ **写死**的「6~20 位、不含空格、不能与原密码相同」，压根没有大写/数字要求
 *     · 前端改密弹窗照着后者写，placeholder 还写着「建议字母 + 数字组合」
 *   → 后端自助改密这一环没有任何强度校验，`abcdefgh` 这种密码能直接改成功。
 *
 * 【修法】
 *   ① 策略抽到 perm/services/pwdPolicy.ts 一处，perm 与 portal 共用；
 *   ② 自助改密改成先过 assertPwdStrength（与账号管理同一口径）；
 *   ③ 新增只读接口 GET /api/portal/account/pwd-policy，前端按它提示 + 预校验。
 *
 * 【断言】造一个【临时门户账号】跑真实接口，测完删掉：
 *   · 策略接口返回 min=8 / upper=true，文案里含「大写字母」
 *   · 无大写字母、无数字、长度不足 8、含空格、与原密码相同 → 一律被拒
 *   · 每一次被拒之后，**原密码必须还能用**（证明没有偷偷改掉）
 *   · 合规密码（≥8 位 + 大写 + 数字）→ 改成功，且新密码能登录、旧密码失效
 *
 * 【跑法】在 server-job 目录下（前后端已在 8004 / 5173 运行）：
 *     node scripts/_test-pwd-policy.mjs
 *   ★ 不起服务、不杀端口；临时账号测完自删，不留痕。
 */
import { randomUUID } from 'node:crypto';
import { BASE, buildRow, conn, makeChecker, req } from './_e2e-lib.mjs';

/** 登录接口走门户，改密接口也走门户（顺带验证 Vite proxy） */
const P = `${BASE}/api/portal/account`;

/** 临时账号的初始密码 —— 本身是合规密码，否则登录不进去 */
const OLD_PWD = 'OldPass123';
/** 合规的新密码 */
const NEW_PWD = 'NewPass123';
/** 临时账号登录名（带下划线前缀，一眼看出是自检产物） */
const TMP = '_e2e_pwdtest';

const { check, summary } = makeChecker();

/** 提交一次自助改密 */
async function tryChange(token, newPassword, oldPassword = OLD_PWD) {
  return req(`${P}/change-password`, {
    method: 'POST',
    token,
    body: { oldPassword, newPassword },
  });
}

/** 用某个密码探一次「原密码是否正确」—— 用来证明密码没被偷偷改掉 */
async function oldPwdStillWorks(token, pwd) {
  const r = await req(`${P}/verify-password`, { method: 'POST', token, body: { password: pwd } });
  return r.json?.code === 200;
}

async function loginWith(account, password) {
  const r = await req(`${P}/login`, { method: 'POST', body: { account, password } });
  return { token: r.json?.data?.token || '', code: r.json?.code, message: r.json?.message };
}

(async () => {
  const pdb = conn('sms_portal');
  let tmpInserted = false;

  try {
    /* ---------- 0. 服务在跑 ---------- */
    const health = await req('http://127.0.0.1:8004/health', { timeout: 4000 });
    check('后端在跑（/health 200）', health.json?.code === 200, `code=${health.json?.code}`);
    if (health.json?.code !== 200) {
      console.log('  ⚠️ 后端没起，请先启动服务（一键启动.bat），再跑本脚本。');
      return;
    }

    /* ---------- 1. 造一个临时门户账号（不碰任何真实账号） ---------- */
    // 先清掉上一轮可能残留的同名账号
    await pdb('t_sys_account').where({ account: TMP }).del();

    const sample = await pdb('t_sys_account').where({ is_deleted: false }).first();
    const base = { ...(sample || {}) };
    delete base.id;
    const row = await buildRow(pdb, 't_sys_account', {
      ...base,
      id: randomUUID(),
      account: TMP,
      user_name: '密码策略自检账号',
      password: OLD_PWD,
      // 门户登录要求至少一个模块，否则「登录成功但看不到任何内容」直接抛错
      modules: sample?.modules || '["perm"]',
      active: 1,
      is_deleted: 0,
    });
    await pdb('t_sys_account').insert(row);
    tmpInserted = true;
    check('临时账号已建好', true, TMP);

    /* ---------- 2. 登录拿 token ---------- */
    const login0 = await loginWith(TMP, OLD_PWD);
    check('临时账号可登录（说明夹具密码合规）', !!login0.token, login0.message || '');
    if (!login0.token) return;
    const token = login0.token;

    /* ---------- 3. 策略接口：前端提示的唯一来源 ---------- */
    const pol = await req(`${P}/pwd-policy`, { token });
    const d = pol.json?.data || {};
    check('GET /pwd-policy 通', pol.json?.code === 200, `code=${pol.json?.code}`);
    check('策略最小长度 = 8', d.min === 8, `min=${d.min}`);
    check('策略要求大写字母（upper=true）', d.upper === true, `upper=${d.upper}`);
    check('策略要求数字（digit=true）', d.digit === true, `digit=${d.digit}`);
    check(
      '策略文案含「大写字母」（前端照它提示）',
      typeof d.tip === 'string' && d.tip.includes('大写字母'),
      `tip=${d.tip}`,
    );

    /* ---------- 4. 弱密码必须被拒（本次 bug 的核心） ---------- */
    const rejects = [
      { pwd: 'abcdefgh', why: '本次 bug 原样复现：8 位全小写、无大写字母', must: '大写字母' },
      { pwd: 'abcdefGH', why: '有大写、无数字', must: '数字' },
      { pwd: 'Abcd123', why: '长度只有 7 位（旧规则 6~20 是放过的）', must: '位' },
      { pwd: 'Abcd 1234', why: '含空格', must: '空格' },
      { pwd: OLD_PWD, why: '与原密码相同', must: '原密码' },
    ];

    for (const c of rejects) {
      const r = await tryChange(token, c.pwd);
      const msg = String(r.json?.message || '');
      check(
        `拒绝弱密码「${c.pwd}」 —— ${c.why}`,
        r.json?.code !== 200 && msg.includes(c.must),
        `code=${r.json?.code} msg=${msg}`,
      );
      // 关键：被拒之后密码必须原封不动
      check(
        `  拒后原密码仍可用（没被偷偷改掉）`,
        await oldPwdStillWorks(token, OLD_PWD),
      );
    }

    /* ---------- 5. 合规密码仍然改得成功（别把正常流程修坏） ---------- */
    const okRes = await tryChange(token, NEW_PWD);
    check('合规密码「NewPass123」改密成功', okRes.json?.code === 200, `code=${okRes.json?.code} msg=${okRes.json?.message}`);

    const loginNew = await loginWith(TMP, NEW_PWD);
    check('新密码能登录（说明真写进去了）', !!loginNew.token, loginNew.message || '');

    const loginOld = await loginWith(TMP, OLD_PWD);
    check('旧密码已失效', !loginOld.token, `code=${loginOld.code} ${loginOld.message || ''}`);
  } catch (e) {
    check('脚本未抛异常', false, e?.message || String(e));
  } finally {
    /* ---------- 6. 清理：临时账号删掉 ---------- */
    try {
      if (tmpInserted) {
        // 门户账号是登录入口，直接物理删（它没有任何业务数据引用）
        await pdb('t_sys_account').where({ account: TMP }).del();
        // 顺带清掉可能被同步出来的同名业务账号（正常情况下不会有）
        const pdbPerm = conn('sms_perm');
        await pdbPerm('t_perm_user').where({ account: TMP }).del().catch(() => undefined);
      }
    } catch {
      /* 清理失败不影响结论，但要让人看见 */
      console.log('  ⚠️ 临时账号清理失败，请手动删 sms_portal.t_sys_account 里 account = ' + TMP);
    }
    await pdb.destroy().catch(() => undefined);
  }

  process.exit(summary() ? 0 : 1);
})();
