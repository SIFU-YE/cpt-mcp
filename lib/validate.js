// cpt-mcp/lib/validate.js —— CPT 结构校验（不依赖外部 MCP/数据库，纯本地原子校验）
// 升级：支持多工作表模板；新增映射文档关键结构检查（StyleList/RowHeight/ColumnWidth/ReportPageAttr/PaperSetting/控件/内容）
import { load } from './xml.js';
import { datasets, cells, fillConfig, fillSubmitMatrix, checkReportJs, duplicateEventGroups, parameters } from './cpt.js';
import { diagnoseFillRowIntegrityFromParsed } from './fill-integrity.js';
import { checkJsBaseline } from './js-baseline.js';
import { scanEmbeddedCommits, parseDml, COMMIT2DB_CLASS, colName } from './embedded.js';
import { blockRange, findAll } from './xml.js';
import { asArray, asReports } from './parsed-shape.js';


export function validateCpt(path) {
  const issues = [];
  let doc;
  try {
    doc = load(path);
  } catch (e) {
    return [{ severity: 'error', location: '文件', message: `无法解析 CPT: ${e.message}` }];
  }
  const parsed = doc.parsed;
  const wb = parsed.WorkBook;

  // 1. 根结构
  if (!wb) issues.push({ severity: 'error', location: '根', message: '缺少 WorkBook 根元素' });
  else {
    if (!wb['@_xmlVersion'] && !wb.xmlVersion) issues.push({ severity: 'warning', location: 'WorkBook', message: '缺少 xmlVersion 属性' });
    if (!wb['@_releaseVersion'] && !wb.releaseVersion) issues.push({ severity: 'warning', location: 'WorkBook', message: '缺少 releaseVersion 属性' });
  }
  const reports = wb ? asReports(parsed) : [];
  if (reports.length === 0) issues.push({ severity: 'error', location: 'Report', message: '缺少 Report 元素' });
  reports.forEach(({ report, sheet }) => {
    if (!report.CellElementList) issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 CellElementList（无单元格）' });
    // 映射文档关键结构
    if (!report.ReportPageAttr) issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 ReportPageAttr（分页/重复行列）（官方 1,550/1,550 样本必备）' });
    if (!report.RowHeight) issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 RowHeight' });
    if (!report.ColumnWidth) issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 ColumnWidth' });
  });
  // StyleList 与样式索引
  const styles = asArray(wb?.StyleList?.Style);
  if (!wb?.StyleList || styles.length === 0) {
    issues.push({ severity: 'warning', location: 'StyleList', message: '缺少 StyleList（无样式）' });
  }
  // 1b. 填报容器归属（P0，2026-10-20）：WebWriteContent 必须位于 WorkBook 级 <ReportWebAttr> 内。
  // 前车：build_report 未传 webWrite 后用 set_webwrite_extras 补容器，旧实现把容器插到最后一个
  // </Report> 前（Report 子级、ReportWebAttr 之外）→ FR 填报预览读不到，工具栏按钮/填报 Web 事件
  // 全部静默失效；而 validate/quality/引擎都不查容器归属，四件套照样全绿，导致"预览没按钮但复验全绿"。
  {
    try {
      const raw = doc.raw;
      // CDATA 掩码只用于标签扫描（等长空格，索引与原文一致），避免按钮 JS 里的字面量误判
      const masked = raw.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (c) => ' '.repeat(c.length));
      const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
      const startsOf = (tag) => {
        const out = [];
        const re = new RegExp(`<${tag}\\b`, 'g');
        let m;
        while ((m = re.exec(masked)) !== null) {
          const ch = masked[m.index + tag.length + 1];
          if (ch != null && /[\s/>]/.test(ch)) out.push(m.index);
        }
        return out;
      };
      const rwaOpen = startsOf('ReportWebAttr')[0];
      const rwaClose = rwaOpen === undefined ? -1 : masked.indexOf('</ReportWebAttr>', rwaOpen);
      const insideRwa = (idx) => rwaOpen !== undefined && idx > rwaOpen && (rwaClose < 0 || idx < rwaClose);
      const wwcStarts = startsOf('WebWriteContent');
      if (wwcStarts.length > 0) {
        // 自嵌套（WebWriteContent 里又出现 WebWriteContent）
        for (let i = 0; i < wwcStarts.length; i++) {
          const s = wwcStarts[i];
          const openEnd = masked.indexOf('>', s);
          const selfClose = openEnd < 0 || masked.slice(s, openEnd + 1).trim().endsWith('/>');
          const end = selfClose ? openEnd + 1 : masked.indexOf('</WebWriteContent>', openEnd + 1);
          const nested = wwcStarts.slice(i + 1).find((s2) => end > s2);
          if (nested !== undefined) {
            issues.push({
              severity: 'error',
              location: `WebWriteContent(文件第${lineOf(nested)}行)`,
              message: '检测到 <WebWriteContent> 自嵌套（容器里又套了一个 WebWriteContent）：设计器不认该结构，填报工具栏/事件行为不确定。',
              fix: '用 set_webwrite_extras({path, repair:true}) 自动清理/修复多余容器层；或 read_cpt 确认后手工删除。',
            });
            break;
          }
        }
        if (rwaOpen !== undefined) {
          // ReportWebAttr 存在 → 容器落在外面是明确错误（FR 填报预览读不到）
          for (const s of wwcStarts) {
            if (!insideRwa(s)) {
              issues.push({
                severity: 'error',
                location: `WebWriteContent(文件第${lineOf(s)}行)`,
                message: '<WebWriteContent> 不在 WorkBook 级 <ReportWebAttr> 内（飘在 <Report> 等其它容器里）——FR 填报预览只读 ReportWebAttr 里的填报页面设置：该模板的工具栏按钮不会显示、填报 Web 事件（beforewrite/afterload 等）也不会执行；设计器打开保存还可能直接丢掉这一节点。',
                fix: '用 set_webwrite_extras({path, repair:true}) 把容器连同全部子节点搬回 ReportWebAttr；或 create_cpt(webWrite=true)/build_report(webWrite:true) 重建。',
              });
            }
          }
        } else {
          // 无 ReportWebAttr：历史遗留形态，容错为 warning（工具读取兼容，但设计器/填报预览不保证）
          issues.push({
            severity: 'warning',
            location: 'WebWriteContent',
            message: '模板有 <WebWriteContent> 但没有 <ReportWebAttr>：属历史遗留形态（工具读取兼容，但 FR 填报预览/设计器不保证识别）。',
            fix: '用 set_webwrite_extras({path, repair:true}) 自动创建 ReportWebAttr 并把容器搬入；或 create_cpt(webWrite=true)/build_report(webWrite:true) 重建。',
          });
        }
      }
      // WebPageContent 自嵌套（同类低层写入产物：update_report_node 传了带外层标签的 xmlBody）
      const wpcStarts = startsOf('WebPageContent');
      for (let i = 0; i < wpcStarts.length; i++) {
        const s = wpcStarts[i];
        const openEnd = masked.indexOf('>', s);
        const selfClose = openEnd < 0 || masked.slice(s, openEnd + 1).trim().endsWith('/>');
        const end = selfClose ? openEnd + 1 : masked.indexOf('</WebPageContent>', openEnd + 1);
        const nested = wpcStarts.slice(i + 1).find((s2) => end > s2);
        if (nested !== undefined) {
          issues.push({
            severity: 'warning',
            location: `WebPageContent(文件第${lineOf(nested)}行)`,
            message: '检测到 <WebPageContent> 自嵌套：分页预览容器被重复包裹，设计器可能不认。',
            fix: 'read_cpt 确认后用 update_report_node(nodeName="WebPageContent", sheet=..., xmlBody=<正确子节点内容，不要再套外层标签>) 重设，或用设计器重设。',
          });
          break;
        }
      }
    } catch (e) {
      issues.push({ severity: 'warning', location: '容器结构', message: `填报容器归属检查执行失败：${e.message}` });
    }
  }

  // 1c. Web 页面静态资源引用（<ReportWebAttr> 内 CSSImport/JSImport，FR 按 webroot 相对路径
  // 加载服务器磁盘文件）。只做 warning、不断言文件存在：校验机本地 webroot 与生产常不一致；
  // 存在性核对走 set_report_imports({webroot})。sandbox17 实测：无参数版靠这三个节点挂自定义样式/JS。
  {
    try {
      const raw = doc.raw;
      const openM = raw.match(/<ReportWebAttr\b[^>]*>/);
      if (openM && !openM[0].trim().endsWith('/>')) {
        const openEnd = raw.indexOf('>', openM.index) + 1;
        const closeIdx = raw.indexOf('</ReportWebAttr>', openEnd);
        if (closeIdx >= 0) {
          const seg = raw.slice(openEnd, closeIdx);
          const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
          for (const [tag, ext] of [['CSSImport', '.css'], ['JSImport', '.js']]) {
            const seen = new Map();
            const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
            let m;
            while ((m = re.exec(seg)) !== null) {
              const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
              const p = (cdata ? cdata[1] : m[1]).trim();
              const loc = `${tag}(文件第${lineOf(openEnd + m.index)}行)`;
              if (!p) {
                issues.push({ severity: 'warning', location: loc, message: `<${tag}> 内容为空（引用了不存在的路径）`, fix: '用 set_report_imports 重写该类引用列表，或删除该空节点。' });
                continue;
              }
              seen.set(p, (seen.get(p) ?? 0) + 1);
              if (!new RegExp(`\\${ext}$`, 'i').test(p)) {
                issues.push({ severity: 'warning', location: loc, message: `<${tag}> 路径后缀不是 ${ext}（当前为 ${p.slice(-12)}），FR 可能不加载`, fix: '用 set_report_imports 修正后缀（css→.css，js→.js）。' });
              } else if (/(\.\.|^\/|^[A-Za-z]:|\\|^(https?:)?\/\/)/.test(p)) {
                issues.push({ severity: 'warning', location: loc, message: `<${tag}> 不是合法的 webroot 相对路径（禁 .. / 绝对路径 / 反斜杠 / URL）：${p.slice(0, 80)}`, fix: '改成 webroot 下的相对路径（如 css/index.css），再用 set_report_imports({webroot}) 核对文件存在。' });
              }
            }
            for (const [p, n] of seen) {
              if (n > 1) {
                issues.push({ severity: 'warning', location: tag, message: `<${tag}> 重复引用同一文件 ${n} 次：${p.slice(0, 80)}（预览会重复加载）`, fix: '用 set_report_imports 去重后重写该类引用列表。' });
              }
            }
          }
        }
      }
    } catch (e) {
      issues.push({ severity: 'warning', location: 'Web 页面静态资源', message: `引用检查执行失败：${e.message}` });
    }
  }

  // 1d. 单元格内嵌提交（Commit2DBJavaScript → Attributes+DMLConfig）
  // 这类提交不在 ReportWriteAttr 下，fillSubmits 数不到、validate 此前完全盲区：
  // 实测 update_cell_listener 整块替换后 DMLConfig 4→2，校验仍只报 info。
  // 这里补三类检查，全部 warning（不阻断交付），但足以在写入前后暴露真实问题：
  //   · Commit2DBJavaScript 一套 DMLConfig 都没有（提交配置被破坏）；
  //   · 同一提交内字段重复 / ColumnConfig 既无 ColumnRow 也无常量值；
  //   · **跨提交列号不一致**（同一张表同一字段在报表级提交与内嵌提交里指向不同列）。
  //     新品表 2026-10-23 的真实事故就是这一类：operation_record 在内嵌提交里仍是 c34，
  //     主提交已改 c29 → 行内删除按钮会把空值写进 mechanism_summary。
  {
    try {
      const raw = doc.raw;
      const commits = scanEmbeddedCommits(raw);
      const badBlocks = findAll(raw, `<JavaScript`)
        .filter((s) => raw.slice(s, raw.indexOf('>', s) + 1).includes(COMMIT2DB_CLASS));
      if (badBlocks.length > commits.length) {
        issues.push({
          severity: 'warning', location: '内嵌提交（Commit2DBJavaScript）',
          message: `有 ${badBlocks.length - commits.length} 处 Commit2DBJavaScript 的 <DMLConfig> 缺失或结构损坏（提交配置可能已被整块替换掉）`,
          fix: '用 get_embedded_submits 核对；若确实丢了，在设计器里重建该按钮的提交配置（cpt-mcp 的 update_cell_listener 会拒绝覆盖这类块）。',
        });
      }
      // 收集「表+字段 → 列号」的所有提交口径（报表级 SubmitVisitor + 内嵌提交）
      const sites = new Map(); // `${table}::${field}` -> [{ column, where }]
      const addSite = (table, columns, where) => {
        if (!table) return;
        for (const c of columns || []) {
          if (!c || !c.name || c.column == null) continue;
          const k = `${table}::${c.name}`;
          if (!sites.has(k)) sites.set(k, []);
          sites.get(k).push({ column: c.column, where });
        }
      };
      for (const s of findAll(raw, '<SubmitVisitor')) {
        let block;
        try { block = blockRange(raw, s, '<SubmitVisitor', '</SubmitVisitor>'); } catch { continue; }
        const seg = raw.slice(block[0], block[1]);
        const name = ((seg.slice(0, 300).match(/<Attributes\b[^>]*\bname="([^"]*)"/) || [])[1]) || '报表级提交';
        const dmlIdx = seg.indexOf('<DMLConfig');
        if (dmlIdx < 0) continue;
        let dml;
        try { dml = blockRange(seg, dmlIdx, '<DMLConfig ', '</DMLConfig>'); } catch { continue; }
        const parsed = parseDml(seg.slice(dml[0], dml[1]));
        addSite(parsed.table, parsed.columns, `${name}(报表级)`);
      }
      for (const c of commits) {
        const where = c.cell ? `内嵌提交@${colName(c.cell.column)}${c.cell.row + 1}` : '内嵌提交';
        if (c.submitCount === 0) {
          issues.push({
            severity: 'warning', location: where,
            message: 'Commit2DBJavaScript 内没有任何提交配置（<Attributes>+<DMLConfig> 缺失）',
            fix: '该按钮点击后不会提交入库；请在设计器里重新配置按钮的「提交」事件。',
          });
        }
        for (const sub of c.submits) {
          const seen = new Set();
          for (const col of sub.columns) {
            if (col.name && seen.has(col.name)) {
              issues.push({
                severity: 'warning', location: `${where}·${sub.name}`,
                message: `字段 "${col.name}" 重复出现（同一提交内同名会产生两个 ColumnConfig，FR 提交行为未定义）`,
                fix: '用 update_embedded_submit(mode=replace) 给出去重后的完整字段清单。',
              });
            }
            if (col.name) seen.add(col.name);
            if (col.column == null && col.constant == null) {
              issues.push({
                severity: 'warning', location: `${where}·${sub.name}`,
                message: `字段 "${col.name}" 既无 ColumnRow 也无常量值（提交时取不到值）`,
                fix: '用 update_embedded_submit 补 column/row，或改成常量值绑定。',
              });
            }
          }
          addSite(sub.table, sub.columns, `${where}·${sub.name}`);
        }
      }
      for (const [k, list] of sites) {
        const cols = [...new Set(list.map((x) => x.column))];
        if (cols.length > 1) {
          const [table, field] = k.split('::');
          issues.push({
            severity: 'warning', location: `提交配置·${table}.${field}`,
            message: `同一字段在多个提交里指向不同列：${list.map((x) => `${x.where}=c${x.column}`).join(' / ')}（写回时会用不同单元格的值，极易互相覆盖成 NULL）`,
            fix: '用 update_embedded_submit(patch) 把内嵌提交的列号对齐主提交；对齐后可复跑 validate_cpt 确认该告警消失。',
          });
        }
      }
    } catch (e) {
      issues.push({ severity: 'warning', location: '内嵌提交', message: `内嵌提交检查执行失败：${e.message}` });
    }
  }

  const cellList = cells(path);
  cellList.forEach((c) => {
    if (c.style != null) {
      const idx = Number(c.style);
      if (!Number.isInteger(idx) || idx < 0 || idx >= styles.length) {
        issues.push({ severity: 'error', location: `单元格(${c.sheet}.${c.column},${c.row})`, message: `样式索引 s=${c.style} 越界（StyleList 仅 ${styles.length} 个样式）` });
      }
    }
  });

  // 1d. 公式形态体检（2026-10-29）：官方公式必须是 <O t="XMLable" class="com.fr.base.Formula"> 对象，
  //     旧版 add_cell/update_cell 把 "=..." 写成普通 <O> CDATA（纯文本）→ FR 不计算，用户看到 "不能改公式/公式不生效"。
  //     官方 1550 样本单元格级裸 "=" CDATA 为 0 例，故该告警不会误伤基线。
  cellList.forEach((c) => {
    if (c.contentKind === 'text' && typeof c.contentText === 'string' && /^\s*=/.test(c.contentText)) {
      issues.push({
        severity: 'warning',
        location: `单元格(${c.sheet}.${c.column},${c.row})`,
        message: `内容以 "=" 开头但落盘为普通文本（<O> CDATA），不是官方公式对象 —— FR 不会把它当公式计算（旧版 cpt-mcp 产物）`,
        fix: `用 update_cell({column:${c.column}, row:${c.row}, content:"=..."}) 在同一格重写公式；会自动升级为官方 Formula 对象`,
      });
    }
  });

  // M106：控件默认值槽（<Widget><widgetValue>）里不得出现「单元格内容对象」。
  // 背景：官方 1550 份模板的 <widgetValue> 内只出现 Date/XMLable/B/D/Formula（默认值或公式），
  // 出现 DSColumn 的为 **0 例**。此前 set_cell_content_type 对"有控件、无单元格级 <O>"的格会把绑定
  // 写进这里 —— 单元格级仍无绑定（设计器不认），而 cells() 的兼容读取又会把它读成 DSColumn，
  // 于是「写错位置 → 读侧掩盖 → 门禁放行」整条链无声通过。本规则让门禁能直接拦住这个臆造形态。
  reports.forEach(({ report, sheet }) => {
    asArray(report.CellElementList?.C).forEach((c) => {
      const t = c.Widget?.widgetValue?.O?.['@_t'];
      if (t === 'DSColumn' || t === 'Image' || t === 'CC') {
        issues.push({
          severity: 'error',
          location: `单元格(${sheet}.${c['@_c']},${c['@_r']})`,
          message: `控件默认值 <Widget><widgetValue> 内含单元格内容对象 <O t="${t}">：控件值槽只能放默认值/公式（官方 1550 份样本 0 例）；数据绑定必须是单元格级 <O t="DSColumn">（与 <Widget> 同级的兄弟节点，位置在 <PrivilegeControl/> 之前）`,
        });
      }
    });
  });

  // 浮动元素（FloatElementList）：样式索引越界 / 位置与尺寸
  reports.forEach(({ report, sheet }) => {
    const floats = asArray(report.FloatElementList?.['com.fr.report.cell.FloatElement']);
    floats.forEach((fe, i) => {
      const name = fe.FloatElementName?.['@_name'] || `Float#${i}`;
      const s = Number(fe.Style?.['@_index']);
      if (Number.isInteger(s) && (s < 0 || s >= styles.length)) {
        issues.push({ severity: 'error', location: `浮动元素(${sheet}.${name})`, message: `样式索引 s=${s} 越界（StyleList 仅 ${styles.length} 个样式）` });
      }
      const loc = fe.Location || {};
      for (const attr of ['leftDistance', 'topDistance', 'width', 'height']) {
        const v = Number(loc[`@_${attr}`]);
        if (!Number.isFinite(v) || v < 0) {
          issues.push({ severity: 'error', location: `浮动元素(${sheet}.${name})`, message: `Location.${attr} 非法：${loc[`@_${attr}`]}` });
        }
      }
      if (fe.O == null) {
        issues.push({ severity: 'warning', location: `浮动元素(${sheet}.${name})`, message: '浮动元素缺少内容 <O>' });
      }
    });
  });

  // 2. 数据集
  // 2026-11-05 修（审计 P0-2）：原来对所有数据集都要求 Connection/SQL，导致 ExcelTableData /
  // EmbeddedTableData / NameTableData / RecursionTableData 这些**合法的非 SQL 数据集**被报
  // "未指定数据连接 / SQL 为空"（quality_gate 因此变 warning，模型可能去删合法数据集）。
  // 现在按 class 分支：只有 DBTableData 需要 connection+SQL；Excel 数据集给导入预检指引；其余非 SQL 不适用。
  const dsList = datasets(path);
  dsList.forEach((d) => {
    if (!d.name) issues.push({ severity: 'error', location: '数据集', message: '数据集缺少 name' });
    const cls = d.class == null ? '' : String(d.class);
    if (/DBTableData/i.test(cls)) {
      if (!d.connection) issues.push({ severity: 'warning', location: `数据集 ${d.name}`, message: '未指定数据连接（Connection）' });
      if (!d.sql || !String(d.sql).trim()) issues.push({ severity: 'warning', location: `数据集 ${d.name}`, message: 'SQL 为空' });
    } else if (/ExcelTableData/i.test(cls)) {
      issues.push({
        severity: 'info',
        location: `数据集 ${d.name}`,
        message: `Excel 数据集（${cls}）不参与 SQL 校验；导入按钮可用 local_db_import({action:"excel"}) 离线预检`,
      });
    } else if (/EmbeddedTableData|NameTableData|RecursionTableData|ConditionTableData/i.test(cls)) {
      issues.push({
        severity: 'info',
        location: `数据集 ${d.name}`,
        message: `非 SQL 数据集（${cls}），不适用 SQL 校验`,
      });
    } else {
      // 2026-11-05 独立验收 P2-6：未知 class 不再当成"合法非 SQL"静默放松，
      // 仍按 SQL 数据集要求连接/SQL（白名单外的新类型若真无 SQL，会以 info 指引人工确认）。
      issues.push({
        severity: 'info',
        location: `数据集 ${d.name}`,
        message: `未识别的数据集 class（${cls}）：暂按 SQL 数据集口径校验（如果是新类型非 SQL 数据集请告知）`,
      });
      if (!d.connection) issues.push({ severity: 'warning', location: `数据集 ${d.name}`, message: '未指定数据连接（Connection）' });
      if (!d.sql || !String(d.sql).trim()) issues.push({ severity: 'warning', location: `数据集 ${d.name}`, message: 'SQL 为空' });
    }
  });

  // 3. 单元格坐标唯一性
  const coordSet = new Map();
  cellList.forEach((c) => {
    if (c.column == null || c.row == null) return;
    const key = `${c.sheet}.${c.column},${c.row}`;
    if (coordSet.has(key)) issues.push({ severity: 'error', location: `单元格(${key})`, message: '坐标重复' });
    else coordSet.set(key, true);
  });

  // 4. 填报绑定一致性
  const fc = fillConfig(path);
  if (fc.submits.length === 0) {
    issues.push({ severity: 'info', location: '填报', message: '未配置任何提交设置（SubmitVisitor）' });
  }
  // 4b. 官方形态口径（2026-10-27 反哺自官方 1,550 样本全量统计）：
  //   · 提交器 <SubmitVisitor>(156) 与 <Submiter>(65) **互斥**——全库 0 例共存，共存即形态错误；
  //   · <ConditionAttr> 是图表专属伴随结构（525/525 与 <Chart> 共现），单元格条件走
  //     HighlightList/HighlightAction 口径，两套不要混。
  const morphRaw = doc.raw;
  if (morphRaw.includes('<SubmitVisitor') && morphRaw.includes('<Submiter')) {
    issues.push({
      severity: 'error', location: '填报',
      message: '同时存在 <SubmitVisitor> 与 <Submiter> 两种提交器（官方 1,550 样本中两者互斥、0 例共存）：请保留一种口径',
    });
  }
  if (morphRaw.includes('<ConditionAttr') && !morphRaw.includes('<Chart')) {
    issues.push({
      severity: 'warning', location: '条件属性',
      message: '<ConditionAttr> 无伴随 <Chart>（官方 525/525 共现）：图表条件用 ConditionAttr；单元格条件应走 HighlightList/HighlightAction 口径',
    });
  }
  // 4c. 参数引用一致性前置：提交参数（自由 SQL）与数据集 SQL 都要和报表级参数对账。
  // P1-1 双层口径补遗：报表级参数（scope=report）可单独供数，数据集层没有它不算缺口
  const reportParamNames = new Set(
    parameters(path).filter((p) => p.scope === 'report').map((p) => p.name).filter(Boolean)
  );
  fc.submits.forEach((s) => {
    const loc = `提交 ${s.name}`;
    if (s.mode === 'free-sql') {
      // 自由 SQL 提交（FreeSQLSubmiter）：没有目标表/列绑定，校验 SQL 与提交参数（2026-10-30 补）
      if (!String(s.sql || '').trim()) issues.push({ severity: 'error', location: loc, message: '自由 SQL 提交缺少 SQL 正文' });
      if (!s.dbName) issues.push({ severity: 'warning', location: loc, message: '自由 SQL 提交缺少数据连接（DBName）' });
      const refs = [...String(s.sql || '').matchAll(/\$\{([a-zA-Z_][\w]*)\}/g)].map((m) => m[1]);
      const declared = new Set((s.parameters || []).map((p) => p.name));
      [...new Set(refs)].forEach((r) => {
        if (!declared.has(r)) {
          issues.push({
            severity: 'warning', location: loc,
            message: `自由 SQL 引用参数 \${${r}}，但提交参数里没有声明 —— FR 不会自动替换，运行时会原样进数据库（多数报语法/类型错）。用 update_fill_submit 的 parameters 声明（新建时 add_fill_submit 会按 SQL 里的 \${x} 自动声明）`,
          });
        }
      });
      for (const p of s.parameters || []) {
        const m = /^\s*=\s*\$([A-Za-z_][\w]*)\s*$/.exec(String(p.value || ''));
        if (m && !reportParamNames.has(m[1]) && !/^fine_/.test(m[1])) {
          issues.push({
            severity: 'warning', location: `${loc}.${p.name}`,
            message: `提交参数 ${p.name} 取值 =$${m[1]}，但模板未定义报表参数 ${m[1]}（参数面板/URL 注入缺失时取不到值）`,
          });
        }
      }
      return;
    }
    if (!s.table) issues.push({ severity: 'error', location: loc, message: '缺少目标表（Table.name）' });
    if (!s.dsName) issues.push({ severity: 'warning', location: loc, message: '缺少数据连接（dsName）' });
    s.columns.forEach((col) => {
      const cloc = `${loc}.${col.field}`;
      if (!col.field) issues.push({ severity: 'error', location: loc, message: '绑定字段缺少 name' });
      if (col.column == null || col.row == null) {
        if (col.constant != null) {
          issues.push({ severity: 'info', location: cloc, message: `常量值绑定（固定值=${col.constant}），无单元格坐标` });
        } else {
          // 官方实证：存在只有字段名、无 ColumnRow 也无常量的官方模板（年度财务分析报告等），
          // 降为 warning
          issues.push({ severity: 'warning', location: cloc, message: '绑定缺少单元格坐标（ColumnRow）且无常量值' });
        }
      } else if (!coordSet.has(`${s.sheet}.${col.column},${col.row}`)) {
        // 官方实证：填报允许绑定尚未创建单元格的网格位（提交时按坐标写值），
        // 因此降为 warning —— 对生成场景仍是"多半是笔误"的信号，但不构成结构性错误
        issues.push({ severity: 'warning', location: cloc, message: `绑定的单元格(${col.column},${col.row})不存在（提交所在工作表 ${s.sheet}）—— 若为笔误请修正坐标` });
      }
    });
  });

  // 5. 参数引用一致性（数据集 SQL 中 ${xxx} 与数据集参数/报表级参数匹配）
  // 4d. 跨 sheet 填报提交拓扑：两个 sheet 同目标表/同主键/无 sheet 判别条件时，
  // 提交一个 sheet 可能把另一个 sheet 的旧行一起 upsert（双 sheet 样本实测缺陷）。
  // 默认 warning，不改变存量模板的 error/blocker 口径；strict 由 quality_gate 显式开启。
  try {
    const matrix = fillSubmitMatrix(path);
    for (const w of matrix.warnings) {
      issues.push({
        severity: 'warning',
        code: w.code,
        location: w.location,
        message: w.message,
        fix: w.fix,
      });
    }
  } catch (e) {
    issues.push({ severity: 'info', location: '填报提交拓扑', message: `跨 sheet 提交拓扑检查跳过：${e.message}` });
  }

  // 5. 参数引用一致性（数据集 SQL 中 ${xxx} 与数据集参数/报表级参数匹配）
  dsList.forEach((d) => {
    const sql = String(d.sql || '');
    const refs = [...sql.matchAll(/\$\{([a-zA-Z_][\w]*)\}/g)].map((m) => m[1]);
    const defined = new Set(d.parameters.map((p) => p.name).filter(Boolean));
    [...new Set(refs)].forEach((r) => {
      if (!defined.has(r) && !reportParamNames.has(r)) {
        issues.push({ severity: 'warning', location: `数据集 ${d.name} SQL`, message: `SQL 引用参数 ${r} 未在数据集参数中定义` });
      }
    });
  });

  // 6. 提交目标表与数据集关系（弱校验：提交表名出现在 SQL 中则更好；自由 SQL 提交无目标表，跳过）
  fc.submits.forEach((s) => {
    if (!s.table) return;
    const inSql = dsList.some((d) => String(d.sql || '').includes(s.table || ''));
    if (!inSql) {
      issues.push({ severity: 'info', location: `提交 ${s.name}`, message: `目标表 ${s.table} 未出现在任何数据集 SQL 中（可接受，如走存储过程）` });
    }
  });

  // 7. 纸张/页面设置（映射文档：ReportAttrSet>ReportSettings>PaperSetting）
  reports.forEach(({ report, sheet }) => {
    const rs = report.ReportAttrSet?.ReportSettings;
    if (!rs) {
      issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 ReportAttrSet>ReportSettings（页面设置）' });
    } else if (rs.PaperSetting == null) {
      issues.push({ severity: 'warning', location: `Report(${sheet})`, message: '缺少 PaperSetting（纸张设置，可为默认 <PaperSetting/>）' });
    }
  });

  // 8. 单元格内容与控件（复用函数开头已 load 的 parsed，避免重复解析）
  // S2: 数据集引用完整性。写入侧（addCell/addChart）已用 assertDatasetExists 硬拦；
  // 校验侧面对的悬空引用只会来自外部引入 —— 官方实证（订单套打.cpt 等）此类模板
  // 真实引擎仍可加载（数据集解析是渲染期惰性的），故为 warning 而非 error。
  const declaredDs = asArray(wb?.TableDataMap?.TableData).map((d) => d['@_name']).filter(Boolean);
  const dsDeclared = (name) => declaredDs.includes(String(name));
  asReports(parsed).forEach(({ report, sheet }) => {
    asArray(report.CellElementList?.C).forEach((c) => {
      const loc = `单元格(${sheet}.${c['@_c'] ?? '?'},${c['@_r'] ?? '?'})`;
      const o = c.O;
      if (!o && !c.Widget) {
        issues.push({ severity: 'warning', location: loc, message: '单元格既无内容(O)也无控件(Widget)（可能是合并区的空单元格，可忽略）' });
      }
      if (o && typeof o === 'object' && o['@_t'] === 'DSColumn') {
        const attrs = o.Attributes || {};
        // 官方实证（动态列模板）：columnName 可由列序号 ci 替代（dsName + ci 形态）
        if (!attrs['@_dsName'] || (!attrs['@_columnName'] && attrs['@_ci'] == null)) {
          issues.push({ severity: 'error', location: loc, message: 'DSColumn 单元格缺少 dsName 或 columnName/ci' });
        } else if (!dsDeclared(attrs['@_dsName'])) {
          issues.push({
            severity: 'warning',
            location: loc,
            message: `DSColumn 引用的数据集 "${attrs['@_dsName']}" 不存在（已声明：${declaredDs.join('、') || '无'}）—— 若为模板内数据集请修正拼写，渲染该单元格时会报错`,
          });
        }
      }
      // 图表（<O t="CC"> 内的 NameTableData 引用）
      if (o && typeof o === 'object' && o['@_t'] === 'CC') {
        const chartDs = new Set();
        collectChartDsNames(o, chartDs);
        for (const name of chartDs) {
          if (!dsDeclared(name)) {
            issues.push({
              severity: 'warning',
              location: loc,
              message: `图表引用的数据集 "${name}" 不存在（已声明：${declaredDs.join('、') || '无'}）—— 渲染图表时会报错`,
            });
          }
        }
      }
      if (c.Widget && typeof c.Widget === 'object' && !c.Widget['@_class']) {
        issues.push({ severity: 'error', location: loc, message: '控件缺少 class' });
      }
    });
  });

  // 9. 填报行完整性（insertPolicy）
  // 【背景】填报模板插入新行时，靠 <CellInsertPolicy><InsertPolicy><![CDATA[copy]]></InsertPolicy></CellInsertPolicy>
  // 让该格复制上一行的值；业务侧此前只能"备份后直写 XML"补这条属性（MCP 无入口），是本次闭环要收回的线。
  // 【判据（队长专业域裁定，按此定稿）】「官方模板未设 insertPolicy」不算缺口 —— 官方 178 个填报 sheet 中
  // 175 个整格未写，说明"不设"是官方常态、设计器不强制。只有「同一数据行内不一致」（同行部分格显式设了、
  // 其余没设）才是真信号，warning 判据即为此，不再用「零误报」措辞。
  // 官方语料实测命中（均为官方模板自身的真实不一致，报出来是对的）：
  //   doc/Form/LineForm/自动匹配.cpt（sheet1!A3 未设 / B3..F3=copy）、
  //   doc/Form/LineForm/LineForm6.cpt（sheet1!B3 未设 / C3..K3=copy）、
  //   demo/form/通讯录(自匹配excel在线导入).cpt（第 7 行多个格未设 / 同行其余格=copy）。
  // 另：行内只有 default/null 混用时不在 warning 内（官方 doc/Form/LineForm/插入行策略.cpt 即 B3=default + F3=copy、
  // A3/C3/D3/E3/G3 未设）—— default=用默认插入值是显式设计决策，故仅作 info，且 fix 对齐同行已显式设置的值。
  reports.forEach(({ report, sheet }) => {
    const state = asArray(report.ReportWriteAttr?.SubmitVisitor)
      .concat(asArray(report.SubmitVisitor), asArray(report.ReportAttrSet?.SubmitVisitor));
    if (state.length === 0) return; // 非填报工作表：无需 insertPolicy
    const index = reports.findIndex((r) => r.report === report);
    let diag;
    try {
      diag = diagnoseFillRowIntegrityFromParsed(parsed, path, { sheet: index });
    } catch (e) {
      issues.push({ severity: 'warning', location: `填报(${sheet})`, message: `填报行完整性检查执行失败：${e.message}` });
      return;
    }
    const sheetDiag = diag.sheets.find((s) => s.sheetIndex === index);
    if (!sheetDiag) return;
    for (const row of sheetDiag.partialRows) {
      // 【t9 修复】文案按策略分组：只把「已设 copy」的格说成 copy；同行若另有显式 default 等非 copy 值，
      // 单独列出并明确「不对齐它」，避免把 default 误述为 copy / 诱导把 default 改掉。
      const others = row.setNonCopy?.length
        ? `；同行 ${row.setNonCopy.join('、')} 显式设的是 ${(row.setNonCopyPolicies || []).join('/')}（不对齐它，保留原值）`
        : '';
      issues.push({
        severity: 'warning',
        location: `数据行(${sheet}!第 ${row.rowNumber} 行)`,
        message: `填报行完整性：同一数据行内 insertPolicy 不一致 —— ${(row.setCopy || []).join('、')} 已设 copy${others}，而 ${row.missing.join('、')} 未设 insertPolicy（共 ${row.missingCount} 格）。插入新行时这些未设格取值会与同行不一致`,
        fix: `把未设的格对齐到同行已显式设置的 copy：update_cell 传 insertPolicy:"copy" 逐格补齐；整行批量用 batch_mutate_cells 的 data.patch.insertPolicy:"copy"（勿改动显式 ${(row.setNonCopyPolicies || []).join('/') || '非 copy'} 的格）`,
      });
    }
    for (const row of sheetDiag.mixedPolicyRows || []) {
      // 无唯一对齐目标（同行只有 default 等非 copy 显式值，或 default+copy 并存）→ info，不给改 copy 的建议
      const stated = [
        row.setCopy?.length ? `${row.setCopy.join('、')}=copy` : null,
        row.setNonCopy?.length ? `${row.setNonCopy.join('、')}=${(row.setNonCopyPolicies || []).join('/')}` : null,
      ].filter(Boolean).join('、');
      issues.push({
        severity: 'info',
        location: `数据行(${sheet}!第 ${row.rowNumber} 行)`,
        message: `填报行完整性：同一数据行内 insertPolicy 不统一 —— ${stated || '同行存在显式设置'}，而 ${row.unsetCells.join('、')} 未设 insertPolicy（共 ${row.unsetCount} 格）。default=用默认插入值属显式设计决策，无唯一对齐目标；仅当这些格也需要随行复制时才补 copy`,
      });
    }
    for (const item of sheetDiag.missing.dictionary) {
      issues.push({ severity: 'warning', location: `单元格(${item.address})`, message: `填报行完整性：下拉控件 ${item.widgetClass} 缺少数据字典（<Dictionary>），页面下拉为空` });
    }
    // 「数据行列格既无控件也无 DSColumn 绑定」：结构提示，不进 warning —— 官方 1550 样本实测 977 处
    // （合并区占位、行内空档、纯展示模板都会命中），无法据此判定缺陷；详情由 diagnose 工具逐格给出。
    for (const item of sheetDiag.missing.widget) {
      issues.push({ severity: 'info', location: `单元格(${item.address})`, message: '填报行完整性：数据行列格既无录入控件也无 DSColumn 绑定（既不能录入也取不到数；合并区占位/空档可忽略）' });
    }
    for (const item of sheetDiag.missing.expandParent) {
      for (const p of item.problems) {
        issues.push({ severity: 'error', location: `单元格(${item.address})`, message: `扩展父格引用悬空：${p.problem}` });
      }
    }
    // 整表未设 insertPolicy：官方常态（设计器只在确有需要的格上开 copy）→ 只作 info 提示
    const anyPolicyCell = sheetDiag.cells.some((r) => r.insertPolicy != null);
    if (sheetDiag.missingCounts.insertPolicyCopyWarn === 0 && sheetDiag.dataCellCount > 0 && anyPolicyCell) {
      issues.push({
        severity: 'info',
        location: `填报(${sheet})`,
        message: `填报行完整性：本工作表已有数据格显式设了 insertPolicy，但仍有 ${sheetDiag.missingCounts.insertPolicyCopyInfo} 个数据格未设 —— 若这些格也需要插入行随行复制，请按需补 copy（官方样本多数不设，非缺陷）`,
      });
    }
  });

  // 10. JS 语法检查（P0 V2-F12：validate/gate 至今不解析 JS，已提交的语法污染仍全绿）
  // 复用 check_report_js 的 V8 扫描逻辑（**M116 起先解码 FR 转义 `]A`→`]`，再做
  // new vm.Script 解析 + 函数体包裹兜底**），只对真语法错误上报。
  // 【M116 更正 t7/t8 的错误归因】旧注释写"41 个失败全是官方样本自身含代码位 ]A 污染
  // 但设计器可打开（V8 比 FR 设计器严格）"——**反了**。官方全量实测：237 个 `]` 100% 都
  // 写成 `]A`，原文喂 V8 失败 55 块、解码后 0 块。`]A` 是设计器的正常转义，不是污染；
  // 当时那 41 个"失败"是**本检测器**没解码造成的假阳性，"官方也中招"本该推翻前提而不是
  // 给检测器找台阶。解码修复后官方基线自然全绿（见 test/fr-js-escape.test.js）。
  // 仍保持 warning 级：真语法错误（如少写 `}`）不该阻断结构交付，可见可闭环即可。
  try {
    const jsRes = checkReportJs(path);
    for (const f of jsRes.failures || []) {
      issues.push({
        severity: 'warning',
        // 【M92】行号直接进 location/message：排错会话曾因只有块级定位而人肉逐行验 77 步；
        // check_report_js.failures[i].line 即块内行号（1 起），validate 复述一遍，读到即修。
        location: `JS语法(${f.location}${f.line != null ? `第${f.line}行` : ''})`,
        message: `JS 语法错误：${f.error}${f.line != null ? `（块内第${f.line}行）` : ''}`,
        fix: '先调 check_report_js 拿块内行号定位，再用对应写入工具修正后重跑 validate_cpt：报表JS用 set_report_js / 报表事件用 set_report_listener / 填报事件用 set_webwrite_js / 单元格监听用 update_cell_listener / 工具栏按钮用 set_toolbar_button_js / 超链script用 update_cell_hyperlink',
      });
    }
  } catch (e) {
    issues.push({ severity: 'warning', location: 'JS语法', message: `JS 语法检查执行失败：${e.message}` });
  }

  // 11. 事件唯一性（M94 + JS 合并约定：同一容器内同事件 Listener 只能有一份代码）
  // 前车：6 个 V3 模板的 WebWriteContent 各挂 2~4 个 afterload（填报3/审批4/汇总2），
  // 改错块/写回污染之后只能人肉二分。TopJS/按钮JS/超链无事件属性，不参与判定；
  // 同格同事件（极少）同样上榜。warning 级（t8 口径：可见、可闭环，不阻断交付），
  // 合并路径见 fix（aggregate=true 一键并回一块，或 match 定点，禁止再起新块）。
  try {
    for (const g of duplicateEventGroups(path)) {
      const where = g.container.startsWith('填报事件')
        ? 'WorkBook 级 WebWriteContent'
        : g.container.startsWith('报表事件:')
          ? `报表事件(${g.container.slice(5)})`
          : g.container.startsWith('填报事件:')
            ? `填报事件(${g.container.slice(5)})`
            : g.container.startsWith('webpage:')
              ? `分页预览 WebPageContent(${g.container.slice(8)})`
              : g.container.startsWith('webview:')
                ? `预览 WebViewContent(${g.container.slice(8)})`
                : `单元格(${g.container})`;
      issues.push({
        severity: 'warning',
        location: `事件唯一(${g.event}×${g.locations.length})`,
        message: `${where}挂了 ${g.locations.length} 份 event="${g.event}" 的代码：${g.locations.join(' / ')}。违反 JS 合并约定（同一容器内、相同事件类型的 JS 只允许一个 <Listener> 代码块）：同事件多份代码会互相覆盖/执行顺序不定，改其中一份时极易改错块。`,
        fix: '按 JS 合并约定并为一块（保留全部 JS，按文档顺序拼接）：填报事件用 set_webwrite_js({event, aggregate:true})、报表事件用 set_report_listener({event, aggregate:true, sheet})——不传 js 即只合并（不删除不新建）。若只想保留其中一份、丢弃其余，先 get_webwrite_js(event)/get_report_listener(event) 读回各块确认，再用 match 定点替换 + 删除；单元格级用 update_cell_listener(event,match)/delete_cell_listener(event,match)。合并后重跑 validate 确认本条消失。',
      });
    }
  } catch (e) {
    issues.push({ severity: 'warning', location: '事件唯一', message: `事件去重扫描执行失败：${e.message}` });
  }

  // 12. 命名与B字符（M94）
  // 口径（2026-09-19 定，祖父条款见 fix）：
  // - error：希腊字母块（含 Σ）出现在机器消费的命名位（XML name/kiName/viName/columnName/dsName
  //   属性值、JS 声明的变量/函数名）——必拦，工具链按 ASCII/Météo…按A标识符解析会错位。
  // - warning：希腊字母出现在注释/文本；版本形标记含英文数字小数点下划线连字符之外的字符。
  // - 不判定：①②→✓✗×…≈ 等注释排版符号（存量上百处，全拦则告警淹没信号；新人内容优先用 [1]/->/OK）。
  // - 版本命名规范：英文前缀+数字，可带小数（v3.7 / F12 / t8 均合法；日期属时间戳不在此限）。
  try {
    const raw = doc.raw;
    const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/;
    const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
    // 12a. 机器命名位（error）
    for (const m of raw.matchAll(/\b(name|kiName|viName|columnName|dsName)="([^"]*)"/g)) {
      if (GREEK.test(m[2])) {
        issues.push({ severity: 'error', location: `命名(文件第${lineOf(m.index)}行)`, message: `属性 ${m[1]}="..." 含希腊字母（Σ类）：${m[2].slice(0, 40)}。机器消费的命名只允许字母数字下划线/CJK/$.`, fix: '改名：希腊字母改为英文拼音（如 Σ→sigma/合计），字典 ki/vi 与数据集名同步改调用方。' });
      }
    }
    // JS 声明标识符：先去注释（行注释 // 与块注释 /* */；正则字面量内 // 的误伤可接受——希腊字母本就不该出现，误报即真问题）
    const jsTexts = [...raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((x) => x[1]);
    const identRe = /(?:function\s+|(?:var|let|const)\s+)([^\s({;=,，：:]+)/g;
    for (const code of jsTexts) {
      const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, '');
      const noLine = noBlock.split('\n').map((ln) => { const i = ln.indexOf('//'); return i < 0 ? ln : ln.slice(0, i); }).join('\n');
      let im;
      while ((im = identRe.exec(noLine)) !== null) {
        if (GREEK.test(im[1]) || /[^\w$\u4e00-\u9fff]/.test(im[1])) {
          issues.push({ severity: 'error', location: '命名(JS标识符)', message: `JS 声明名含希腊字母或非A符号：${im[1].slice(0, 40)}。标识符只允许字母数字下划线/$/CJK。`, fix: '改名：希腊字母改为英文拼音，清除装饰符号；同步改所有引用处后重跑 validate。' });
          break;
        }
      }
    }
    // 12b. 注释/文本中的希腊字母 + 版本标记格式（warning，首犯列举+计数封顶）
    let greekWarns = 0;
    for (const m of raw.matchAll(/[\u0370-\u03FF\u1F00-\u1FFF]/g)) {
      if (++greekWarns === 1) {
        const ln = raw.slice(Math.max(0, m.index - 120), m.index).split('\n').pop() + raw[m.index] + raw.slice(m.index + 1, m.index + 60).split('\n')[0];
        issues.push({ severity: 'warning', location: `命名(文件第${lineOf(m.index)}行)`, message: `注释/文本含希腊字母（Σ类）：…${ln.trim().slice(0, 80)}…。新内容请用英文拼音替代。`, fix: '希腊字母改为英文（如 Σ→sigma/合计/总和）；版本标记统一用英文前缀+数字，可带小数（如 v3.7）。' });
      }
    }
    if (greekWarns > 1) issues.push({ severity: 'warning', location: '命名', message: `注释/文本希腊字母共 ${greekWarns} 处（仅列首处），请批量替换为英文。` });
    // 版本形标记：字母前缀+数字（如 v3.7/F12/t8/M10）含英文数字._- 之外字符（排除 CJK 后缀如 t8补丁）→ warning
    const verSeen = new Set();
    for (const m of raw.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Za-z]{1,3}\d[\w.\-]*)/g)) {
      const tok = m[1];
      if (verSeen.has(tok)) continue;
      verSeen.add(tok);
      const stripped = tok.replace(/[\u4e00-\u9fff]+$/g, '');
      if (/[^\w.\-]/.test(stripped) || GREEK.test(tok)) {
        issues.push({ severity: 'warning', location: '命名(版本标记)', message: `版本标记含B字符：${tok}。版本命名用英文前缀+数字，可带小数（如 v3.7）。`, fix: '版本标记改为英文+小数（如 v3.7）；日期时间戳不受此限。' });
        if (verSeen.size > 400) break;
      }
    }
  } catch (e) {
    issues.push({ severity: 'warning', location: '命名', message: `命名规范扫描执行失败：${e.message}` });
  }

  // 1c. 参数面板体检（2026-10-29）：筛选控件高频异常的真实来源是「控件重叠 / 尺寸 0 / 空复选组」，
  // 此前 validate/quality_gate 完全不看参数面板 —— 面板叠成一片也能全绿交付，用户看到异常才回头返工。
  // 官方 1,550 样本里有 4 例刻意重叠、1 例空复选组，故这里全部用 warning，不误杀官方基线。
  try {
    const rawPp = doc.raw;
    const ppStart = rawPp.indexOf('<ReportParameterAttr>');
    if (ppStart >= 0) {
      const ppEnd = rawPp.indexOf('</ReportParameterAttr>', ppStart);
      const seg = rawPp.slice(ppStart, ppEnd);
      const blocks = [...seg.matchAll(/<Widget class="com\.fr\.form\.ui\.container\.WAbsoluteLayout\$BoundsWidget">([\s\S]*?)<\/Widget>/g)].map((m) => m[1]);
      const visibleBoxes = [];
      const seenNames = new Set();
      blocks.forEach((b, idx) => {
        const nm = (b.match(/<WidgetName name="([^"]+)"/) || [])[1];
        const cls = (b.match(/<InnerWidget class="([^"]+)"/) || [])[1] || '';
        const invisible = /<WidgetAttr[^>]*\binvisible="true"/.test(b);
        const loc = nm ? `参数面板·${nm}` : `参数面板·第${idx + 1}个控件`;
        const ba = b.match(/<BoundsAttr\b([^>]*)\/>/);
        if (!ba) {
          issues.push({ severity: 'warning', location: loc, message: '控件缺少 <BoundsAttr>（位置/尺寸未定义，设计器可能打不开或渲染异常）', fix: '用 update_parameter_widget 传 x/y/width/height 补坐标；或 delete_parameter_widget 删掉后用 add_parameter_widget 重建。' });
        } else {
          const num = (attr) => Number((ba[1].match(new RegExp(`\\b${attr}="([^"]*)"`)) || [])[1]);
          const [bx, by, bw, bh] = [num('x'), num('y'), num('width'), num('height')];
          if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) {
            issues.push({ severity: 'warning', location: loc, message: `BoundsAttr 尺寸非法（x=${bx} y=${by} width=${bw} height=${bh}）：0/负尺寸会渲染成不可见控件`, fix: '用 update_parameter_widget 传 width/height（须 >0）修正。' });
          } else if (!invisible) visibleBoxes.push({ loc, x: bx, y: by, w: bw, h: bh });
        }
        if (nm) {
          if (seenNames.has(nm)) issues.push({ severity: 'warning', location: `参数面板·${nm}`, message: `控件名重复（${nm} 出现多次）：同名控件行为不确定`, fix: '用 rename_parameter_widget 改名，或 delete_parameter_widget 删掉多余控件。' });
          seenNames.add(nm);
        }
        // 复选类控件必须有非空字典，否则预览是空控件（add_parameter_widget 已强制；这里兜底存量模板）
        if (/CheckBoxGroup|ComboCheckBox/.test(cls)) {
          const emptyDict = !/<Dictionary\b/.test(b) || /<CustomDictAttr>\s*<\/CustomDictAttr>/.test(b);
          if (emptyDict) {
            issues.push({ severity: 'warning', location: loc, message: `${cls.split('.').pop()} 没有配置任何选项（字典为空/缺失）：预览时会渲染成空控件——筛选控件异常的典型形态`, fix: '用 update_parameter_widget 传 dictionary（db/table/custom/formula）或 items 补选项；或 delete + add_parameter_widget 重建。' });
          }
        }
      });
      for (let i = 0; i < visibleBoxes.length; i++) {
        for (let j = i + 1; j < visibleBoxes.length; j++) {
          const a = visibleBoxes[i], b = visibleBoxes[j];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 1 && oy > 1) {
            issues.push({
              severity: 'warning',
              location: `${a.loc}×${b.loc.replace('参数面板·', '')}`,
              message: `两个控件位置重叠（重叠区 ${Math.round(ox)}×${Math.round(oy)}px）：预览时标签/输入框会互相遮挡`,
              fix: '用 update_parameter_widget 调整 x/y/width/height 错开（或删掉多余控件）；新增控件不传 x/y 会自动排布，避免默认重叠。',
            });
          }
        }
      }
    }
  } catch (e) {
    issues.push({ severity: 'warning', location: '参数面板', message: `参数面板检查执行失败：${e.message}` });
  }

  // M120：JS 块数基线比对 —— 拦截「整块丢失」（实际事故：引擎导出覆写源模板丢 TopJS
  // 整块，validate/quality_gate 全绿放行）。丢失 → error（进 gate blocker）；
  // 首见 → info 提示已建立基线；无丢失的增长静默刷新基线。
  try {
    const bl = checkJsBaseline(path, parsed);
    if (bl.loss) {
      const det = bl.decreased.map((d) => `${d.cat} 基线${d.base}→现存${d.now}`).join('；');
      issues.push({
        severity: 'error',
        location: 'JS块基线',
        message: `JS 块数较基线减少（现存 ${bl.current.total} 块）：${det} —— 疑似整块被外部工具覆写丢失`,
        fix: '确认丢失来源：文件被外部工具改坏则用 git/备份恢复后重跑本检查；确属有意删块（或写坏块后已重做）则用 validate_cpt({path, resetJsBaseline:true}) 或 quality_gate_cpt({path, resetJsBaseline:true}) 复位本模板基线（只删本模板条目后按当前文件重建，返回旧计数摘要），不要手工删 %LOCALAPPDATA% 下的基线文件；经 cpt-mcp 写入工具重做删除也会自动刷新基线',
      });
    } else if (!bl.known) {
      issues.push({ severity: 'info', location: 'JS块基线', message: `已建立 JS 块基线（${bl.current.total} 块）——后续 validate/quality_gate 将据此拦截整块丢失` });
    }
  } catch (e) {
    issues.push({ severity: 'info', location: 'JS块基线', message: `基线比对执行失败（不拦截）：${e.message}` });
  }

  return issues;
}

/** 递归收集图表子树里所有 NameTableData 的数据集名（class 属性识别，不限层级） */
function collectChartDsNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node['@_class'] === 'com.fr.data.impl.NameTableData' && node.Name) {
    const name = node.Name.__cdata ?? node.Name['#text'] ?? node.Name;
    if (name != null && String(name).trim() !== '') out.add(String(name));
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectChartDsNames(v, out);
  }
}

export function issueSummary(issues) {
  const n = { error: 0, warning: 0, info: 0 };
  issues.forEach((i) => { n[i.severity] += 1; });
  return n;
}
