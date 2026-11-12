// scripts/e2e-schedule.mjs —— 调度器端到端可用性演练（R21）
// 链路: addTask → listTasks(nextRun) → runTask(立即执行) → scheduler_status →
//       history → disable/enable → remove → 重启重载(ensureLoadedFor)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { createCpt } = await import(pathToFileURL(path.join(here, '../lib/generate.js')).href);
const {
  addTask, listTasks, getTask, removeTask, enableTask, disableTask, runTask,
  getScheduler, listActions, schedulerStatus,
} = await import(pathToFileURL(path.join(here, '../lib/schedule.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-sched-' + Date.now() + '-'));
const cpt = path.join(dir, 'sched.cpt');
createCpt(cpt, { rows: 2, columns: 2 });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++; else fail++;
};

try {
  // 0) 动作清单
  const acts = listActions();
  check('listActions 5 动作且含 validate', acts.length === 5 && acts.some((a) => a.name === 'validate'), acts.map((a) => a.name).join(','));

  // 1) addTask：validate + 每分钟
  const t1 = await addTask(cpt, { cron: '* * * * *', action: 'validate', note: '全链路演练' });
  check('addTask 返回 id', typeof t1.id === 'string' && t1.id.length > 0, t1.id);
  check('addTask 计算 nextRun', t1.task?.nextRun != null, t1.task?.nextRun);
  check('storePath 指向 .cpt-schedule.json', String(t1.storePath).endsWith('.cpt-schedule.json'), t1.storePath);

  // 2) 同 cron+action 重复加 → 允许（id 区分，M24 只限 50 上限）
  const t1b = await addTask(cpt, { cron: '* * * * *', action: 'validate' });
  check('重复任务允许但 id 不同', t1b.id !== t1.id);
  await removeTask(cpt, t1b.id);

  // 3) 非法 cron 抛错
  let bad = false;
  try { await addTask(cpt, { cron: 'not a cron', action: 'validate' }); } catch { bad = true; }
  check('非法 cron 抛错', bad);

  // 4) listTasks（store 持久化 + tracked）
  const lt = await listTasks(cpt);
  const tasks = lt.tasks ?? [];
  check('listTasks tasks=1', tasks.length === 1 && tasks[0].action === 'validate', `len=${tasks.length}`);
  check('listTasks nextRun 与 addTask 一致', tasks[0].nextRun === t1.task.nextRun, tasks[0].nextRun);
  check('tasks[0].tracked=true（已订阅）', tasks[0].tracked === true);

  // 5) getTask 详情
  const gt = await getTask(cpt, t1.id);
  check('getTask 返回任务详情', gt?.id === t1.id && gt?.note === '全链路演练' && gt?.tracked === true, `tracked=${gt?.tracked}`);

  // 6) runTask：立即执行 validate
  const r1 = await runTask(cpt, t1.id);
  check('runTask 执行成功 ok', r1?.status === 'ok', `status=${r1?.status} | ${r1?.summary ?? ''}`);

  // 7) scheduler_status
  const st = await schedulerStatus();
  check('scheduler.started=true', st.started === true);
  check('activeTasks>=1 且含本任务', st.activeTasks >= 1 && st.activeTaskIds.includes(t1.id), `active=${st.activeTasks}`);

  // 8) history + lastRun（runTask 后）
  const gh = await getTask(cpt, t1.id);
  check('history>=1', (gh?.history ?? []).length >= 1, `len=${(gh?.history ?? []).length}`);
  check('lastRun.status=ok', gh?.lastRun?.status === 'ok', JSON.stringify(gh?.lastRun ?? null));

  // 9) disable → 订阅移除 + enabled=false
  const dis = await disableTask(cpt, t1.id);
  check('disable 后 enabled=false', dis?.enabled === false);
  const lt2 = await listTasks(cpt);
  check('disable 后 listTasks tracked=false', lt2.tasks[0].tracked === false, `tracked=${lt2.tasks[0].tracked}`);
  check('disable 后 cronTasks 不含', !getScheduler().trackedIdsFor(cpt).includes(t1.id), getScheduler().trackedIdsFor(cpt).join(','));

  // 10) enable → 恢复订阅
  await enableTask(cpt, t1.id);
  check('enable 后恢复订阅', getScheduler().trackedIdsFor(cpt).includes(t1.id));

  // 11) 重启重载模拟：stop + ensureLoadedFor 幂等重载
  getScheduler().stop();
  check('stop 后 activeTasks=0', getScheduler().activeCount() === 0);
  const loaded = await getScheduler().ensureLoadedFor(cpt);
  check('重启重载恢复订阅', getScheduler().trackedIdsFor(cpt).includes(t1.id), `loaded=${loaded.loaded}`);
  check('重载幂等（缓存命中）', (await getScheduler().ensureLoadedFor(cpt)).cached === true);

  // 12) removeTask：store + 订阅清空
  const rm = await removeTask(cpt, t1.id);
  const lt3 = await listTasks(cpt);
  check('remove 后 tasks=0', (lt3.tasks ?? []).length === 0, `len=${(lt3.tasks ?? []).length}`);
  check('remove 后订阅清空', !getScheduler().trackedIdsFor(cpt).includes(t1.id));
  check('remove 返回 removed', rm?.removed?.id === t1.id && rm?.remaining === 0);

  // 13) store 文件合法 JSON
  const storeFile = path.join(dir, '.cpt-schedule.json');
  const parsed = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : null;
  check('store 文件含空 tasks', fs.existsSync(storeFile) && Array.isArray(parsed?.tasks) && parsed.tasks.length === 0);

  // 14) 空 store 后再次 addTask 正常（新任务在不同 day 的 cron）
  const t2 = await addTask(cpt, { cron: '0 9 * * 1-5', action: 'style_review' });
  const lt4 = await listTasks(cpt);
  check('清空后 addTask 正常', (lt4.tasks ?? []).length === 1 && lt4.tasks[0].action === 'style_review');
  check('工作日 cron nextRun 有效', lt4.tasks[0].nextRun != null, lt4.tasks[0].nextRun);
  await removeTask(cpt, t2.id);
} finally {
  getScheduler().stop();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n调度器端到端演练 (R21): ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);