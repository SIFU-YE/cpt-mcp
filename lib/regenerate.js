// cpt-mcp/lib/regenerate.js —— 从 .cpt.meta.json 一键复现模板（P2-1 留档的闭环）
//
// meta 由 build_report / generate_report 的 meta=true 选项落盘（<模板>.meta.json）。
// 复现语义：
//   - build_report 形态：spec 完整回放（faithful，产出与原模板 byte 级一致 —— golden 同源保证）
//   - generate_report 形态：核心生成参数回放（title/source/fields/dsName/theme/density/chart/fill），
//     未入档的次要 options（如自定义页眉字号）取默认值
// 覆盖语义（2026-11-07 P1）：本工具的语义就是「按留档回写同名模板」——目标必然已存在，
// 因此**默认覆盖**（原子替换并留 .bak-build-*）。显式 noOverwrite:true 才拒绝覆盖（只建不覆盖，
// 用于"目标被外部改坏时先留档再动手"这类场景）。
import fs from 'node:fs';
import { buildReport } from './engine/builder.js';
import { generateReport } from './engine/smart.js';

export function regenerateFromMeta(cptPath, { noOverwrite = false } = {}) {
  const metaPath = `${cptPath}.meta.json`;
  if (!fs.existsSync(metaPath)) {
    throw new Error(`未找到生成参数留档 ${metaPath}。只有 meta=true 生成的模板才有留档；若该模板来自外部，请用 read_cpt + build_report 重建`);
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new Error(`留档损坏（${e.message}）。删除 ${metaPath} 或手工修复后重试`);
  }

  if (meta.tool === 'build_report') {
    if (!meta.spec) throw new Error('留档缺少 spec（可能来自旧版本），无法复现');
    const r = buildReport({ path: cptPath, ...meta.spec, noOverwrite });
    return { ...r, regeneratedFrom: metaPath };
  }
  if (meta.tool === 'generate_report') {
    const r = generateReport({
      path: cptPath,
      title: meta.title ?? undefined,
      source: meta.source ?? {},
      fields: meta.fields ?? [],
      dsName: meta.dsName ?? 'ds1',
      theme: meta.theme ?? 'blue',
      chart: meta.chart ?? null,
      fill: meta.fill ?? null,
      options: { density: meta.density ?? 'standard', ...(meta.options ?? {}) },
      noOverwrite,
    });
    return { ...r, regeneratedFrom: metaPath };
  }
  throw new Error(`未知留档来源 "${meta.tool}"，无法复现`);
}
