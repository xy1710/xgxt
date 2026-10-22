/**
 * 冒烟探针：起服务后逐学段打主要接口，输出 HTTP 状态与业务 code/message。
 * 用途：P8 DROP 老表后的运行时巡检（静态扫描只能覆盖字面量，这里补「实际执行」）。
 *
 * 跑法：node scripts/_smoke-probe.mjs
 */
import { BASE, killAll, login, req, startServices } from './_e2e-lib.mjs';

const PROBES = [
  // ---- 统一教学接口：退费（初高段是本次静态扫描的重点怀疑对象）----
  ['退费列表·初高', '/api/teaching/refund/list?stage=jh&page=1&size=5'],
  ['退费汇总·初高', '/api/teaching/refund/summary?stage=jh'],
  ['退费列表·大学', '/api/teaching/refund/list?stage=class&page=1&size=5'],
  ['退费列表·实训', '/api/teaching/refund/list?stage=job&page=1&size=5'],
  // ---- 其它 7 域 ----
  ['请假列表·初高', '/api/teaching/leave/list?stage=jh&page=1&size=5'],
  ['学生列表·初高', '/api/teaching/student/list?stage=jh&page=1&size=5'],
  ['班级列表·初高', '/api/teaching/class/list?stage=jh&page=1&size=5'],
  ['班级列表·实训', '/api/teaching/class/list?stage=job&page=1&size=5'],
  ['考试列表·初高', '/api/teaching/exam/list?stage=jh&page=1&size=5'],
  ['宿舍列表·大学', '/api/teaching/dorm/list?stage=class&page=1&size=5'],
  ['成绩列表·大学', '/api/teaching/score/list?stage=class&page=1&size=5'],
  // ---- 老接口（观察期回退通道，应同样正常）----
  ['老·大学费用列表', '/api/class/fee/list?page=1&size=5'],
  ['老·大学宿舍房间', '/api/class/dorm/room/list'],
  ['老·实训统计', '/api/job/statistics/overview'],
  ['老·初高班级列表', '/api/class-jh/classInfo/list?page=1&size=5'],
  ['老·初高工作台', '/api/class-jh/dashboard/stat'],
  ['老·初高退费列表', '/api/class-jh/refund/list?page=1&size=5'],
  // ---- 人员下拉（静态扫描发现其兜底源写死了已 DROP 的全限定表名）----
  ['人员下拉', '/api/class/meta/staff?group=all'],
];

async function main() {
  console.log('启动服务…');
  const { backendReady } = await startServices();
  if (!backendReady) {
    console.error('✗ 后端未就绪');
    return;
  }
  const token = await login('qiansy');
  console.log('登录成功，开始探针\n');

  const bad = [];
  for (const [name, path] of PROBES) {
    let line = '';
    try {
      const r = await req(`${BASE}${path}`, { token, timeout: 20000 });
      const j = r.json || {};
      const ok = r.status === 200 && (j.code === 200 || j.code === 0);
      const n = Array.isArray(j.data?.list)
        ? ` list=${j.data.list.length}`
        : j.data?.total !== undefined
          ? ` total=${j.data.total}`
          : '';
      line = `${ok ? '✅' : '❌'} ${name}  http=${r.status} code=${j.code}${n} ${ok ? '' : JSON.stringify(j.message || j).slice(0, 160)}`;
      if (!ok) bad.push(`${name} | ${path} | http=${r.status} code=${j.code} msg=${j.message}`);
    } catch (e) {
      line = `❌ ${name}  异常: ${String(e.message).slice(0, 120)}`;
      bad.push(`${name} | ${path} | ${e.message}`);
    }
    console.log(line);
  }

  console.log(`\n===== 结果：${PROBES.length - bad.length}/${PROBES.length} 通过 =====`);
  if (bad.length) {
    console.log('失败清单：');
    bad.forEach((x) => console.log('  - ' + x));
  }
}

main()
  .catch((e) => console.error('探针异常:', e))
  .finally(() => {
    killAll();
  });
