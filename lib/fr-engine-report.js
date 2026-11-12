// cpt-mcp/lib/fr-engine-report.js —— 真实 FR 引擎校验报告的只读查询
//
// 真正跑引擎的动作在 scripts/verify-fr-engine.mjs（npm run verify:fr -- <cpt.cpt>），
// 由开发者/CI/用户显式执行；本模块只读取它落盘的 JSON 报告，供 MCP 的
// fr_engine_check 工具把「真实引擎地面真值」带回给模型。
// 报告 staleness：报告时间早于 .cpt 修改时间 → 模板在验证后又被改过，需重跑。

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertToolPath } from './security.js';
import { detectFrHome } from './fr-decompile.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 报告候选位置：CPT 同目录优先；FR_HOME 内官方样本（安装目录只读）回退到项目根目录 */
function reportPaths(cpt) {
  const name = `${path.basename(cpt)}.json`;
  const primary = path.join(path.dirname(cpt), '.fr-engine-check', name);
  const det = detectFrHome();
  if (det.frHome) {
    const frRoot = path.resolve(det.frHome).replaceAll('\\', '/');
    if (path.resolve(cpt).replaceAll('\\', '/').startsWith(`${frRoot}/`)) {
      return [primary, path.join(projectRoot, '.fr-engine-check', name)];
    }
  }
  return [primary];
}

export function engineCheckReport(cptPath) {
  const cpt = assertToolPath('fr_engine_check', cptPath, { write: false });
  if (!existsSync(cpt)) {
    return { ok: false, status: 'cpt-not-found', cpt, hint: `${cpt} 不存在` };
  }
  const candidates = reportPaths(cpt);
  const reportPath = candidates.find((p) => existsSync(p));
  if (!reportPath) {
    return {
      ok: false,
      status: 'not-run',
      cpt,
      reportPath: candidates[candidates.length - 1],
      howToRun: `npm run verify:fr -- ${cpt.split(path.sep).join('/')}`,
      hint: '该模板还没有真实 FR 引擎校验记录。用 run_fr_engine_check（本 MCP 工具）触发校验，'
        + '或让用户/CI 执行 howToRun 里的命令；验证通过后（status=pass）再交付，本工具随后可读取结论。',
    };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return { ok: false, status: 'report-corrupt', cpt, reportPath, hint: `校验报告损坏：${e.message}。重跑 npm run verify:fr -- <cpt> 覆盖它。` };
  }
  const cptMtime = statSync(cpt).mtimeMs;
  const reportMtime = statSync(reportPath).mtimeMs;
  if (reportMtime < cptMtime) {
    return {
      ok: false,
      status: 'stale',
      cpt,
      reportPath,
      report,
      howToRun: `npm run verify:fr -- ${cpt.split(path.sep).join('/')}`,
      hint: '校验报告早于模板最后修改时间 —— 模板在验证后又被改过，结论已过期，请重跑。',
    };
  }
  return {
    ok: report.status === 'pass',
    status: report.status,
    cpt,
    reportPath,
    report,
    hint: report.status === 'pass'
      ? `真实 FineReport 引擎校验通过（${report.checkedAt}${report.roundTrip ? '，含导出重读' : ''}）；该模板可被设计器打开。`
      : '真实 FR 引擎校验失败 —— 设计器同样会打不开。请先跑 validate_cpt 修复结构问题后重试。',
  };
}
