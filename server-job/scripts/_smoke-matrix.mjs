/**
 * 矩阵探针：8 个教学域 × 3 学段的 list 端点 + 退费域的附属端点。
 * 用于发现「某个学段的某个仓储没切读」这类局部故障。
 *
 * 跑法：node scripts/_smoke-matrix.mjs
 */
import { BASE, killAll, login, req, startServices } from './_e2e-lib.mjs';

const STAGES = ['jh', 'class', 'job'];
const DOMAINS = ['attendance', 'class', 'dorm', 'exam', 'leave', 'refund', 'score', 'student'];

async function main() {
  const { backendReady } = await startServices();
  if (!backendReady) throw new Error('后端未就绪');
  const token = await login('qiansy');

  const rows = [];
  const bad = [];
  for (const d of DOMAINS) {
    for (const s of STAGES) {
      const path = `/api/teaching/${d}/list?stage=${s}&page=1&size=5`;
      let r = {};
      try {
        const res = await req(`${BASE}${path}`, { token, timeout: 20000 });
        r = { http: res.status, code: res.json?.code, msg: res.json?.message || '' };
      } catch (e) {
        r = { http: 'ERR', code: 'ERR', msg: String(e.message).slice(0, 80) };
      }
      const ok = r.http === 200 && (r.code === 200 || r.code === 0);
      rows.push(`${ok ? '✅' : '❌'} ${d.padEnd(10)} ${s.padEnd(5)} code=${r.code} ${ok ? '' : r.msg}`);
      if (!ok) bad.push(`${d}/${s} → ${r.msg}`);
    }
  }
  console.log(rows.join('\n'));

  // 退费域附属端点（初高段是重点）
  console.log('\n--- 退费域附属端点（初高）---');
  for (const p of [
    '/api/teaching/refund/classes?stage=jh',
    '/api/teaching/refund/chain?stage=jh',
    '/api/teaching/refund/student-options?stage=jh',
  ]) {
    const res = await req(`${BASE}${p}`, { token, timeout: 20000 });
    const ok = res.status === 200 && (res.json?.code === 200 || res.json?.code === 0);
    console.log(`${ok ? '✅' : '❌'} ${p} code=${res.json?.code} ${ok ? '' : res.json?.message}`);
    if (!ok) bad.push(`${p} → ${res.json?.message}`);
  }

  console.log(`\n===== 矩阵：${rows.length - bad.filter((x) => x.includes('/')).length}/${rows.length} 通过，附属端点失败 ${bad.filter((x) => x.includes('/api')).length} =====`);
  if (bad.length) {
    console.log('失败：');
    bad.forEach((x) => console.log('  - ' + x));
  }
}

main()
  .catch((e) => console.error('异常:', e))
  .finally(() => killAll());
