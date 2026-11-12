// scripts/fr-audit-probe.mjs —— 本地 FineReport 设计器关键 jar 的 class 常量池解析器（只读逆向）
//
// 技术路线①：纯 Node 解析 .class 常量池（类名/父类/接口/字段名+类型/方法名/字符串常量/枚举常量），
//            不执行字节码方法体，不反编译方法体（FineReport 为商业软件，仅做结构提取用于交叉比对）。
// 数据来源：FR_HOME 下 3 个关键 jar（只读，不写 FR_HOME）：
//   - lib/fine-report-designer-11.0.jar
//   - webapps/webroot/WEB-INF/lib/fine-core-11.0.jar
//   - webapps/webroot/WEB-INF/lib/fine-report-engine-11.0.jar
// 产出：
//   - docs/fr-ground-truth.md        人类可读真实结构清单（交付物）
//   - tmp_test/fr-ground-truth.md    git 忽略副本（同内容）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FR_HOME = process.env.FR_HOME;
if (!FR_HOME) {
  console.error('缺少 FR_HOME：请先设置 FineReport 安装目录（例如 <FineReport安装目录>），本脚本不再写死本机盘符。');
  process.exit(1);
}
const JARS = {
  designer: join(FR_HOME, 'lib', 'fine-report-designer-11.0.jar'),
  core: join(FR_HOME, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-core-11.0.jar'),
  engine: join(FR_HOME, 'webapps', 'webroot', 'WEB-INF', 'lib', 'fine-report-engine-11.0.jar'),
};

// ---- zip 读取（纯 JS，无需外部 unzip）----
function readZipEntries(jarPath) {
  const b = readFileSync(jarPath);
  // 定位 End Of Central Directory
  const min = Math.max(0, b.length - 0xffff - 22);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`no EOCD: ${jarPath}`);
  const count = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const uncompSize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localOffset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { b, entries };
}

function readEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const { b } = zip;
  const p = e.localOffset;
  if (b.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header ${name}`);
  const nameLen = b.readUInt16LE(p + 26);
  const extraLen = b.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = b.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 8) return inflateRawSync(raw);
  if (e.method === 0) return raw;
  throw new Error(`unsupported zip method ${e.method} for ${name}`);
}

// ---- class 常量池解析 ----
const ACC = {
  PUBLIC: 0x0001, PRIVATE: 0x0002, PROTECTED: 0x0004, STATIC: 0x0008,
  FINAL: 0x0010, INTERFACE: 0x0200, ABSTRACT: 0x0400, ENUM: 0x4000, SYNTHETIC: 0x1000,
};
function accFlags(acc) {
  const f = [];
  if (acc & ACC.PUBLIC) f.push('public');
  if (acc & ACC.PRIVATE) f.push('private');
  if (acc & ACC.PROTECTED) f.push('protected');
  if (acc & ACC.STATIC) f.push('static');
  if (acc & ACC.FINAL) f.push('final');
  if (acc & ACC.INTERFACE) f.push('interface');
  if (acc & ACC.ABSTRACT) f.push('abstract');
  if (acc & ACC.ENUM) f.push('enum');
  if (acc & ACC.SYNTHETIC) f.push('synthetic');
  return f;
}

function parseClass(buf) {
  let p = 0;
  const u1 = () => buf[p++];
  const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  if (u4() !== 0xCAFEBABE) throw new Error('bad magic');
  const minor = u2();
  const major = u2();
  const cpCount = u2();
  const cp = [null];
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { tag, s: buf.subarray(p, p + len).toString('utf8') }; p += len; break; }
      case 3: cp[i] = { tag, int: buf.readInt32BE(p) }; p += 4; break;
      case 4: cp[i] = { tag, float: buf.readFloatBE(p) }; p += 4; break;
      case 5: { const hi = buf.readInt32BE(p); const lo = buf.readInt32BE(p + 4); cp[i] = { tag, long: hi * 2 ** 32 + lo }; p += 8; i++; break; }
      case 6: cp[i] = { tag, double: buf.readDoubleBE(p) }; p += 8; i++; break;
      case 7: cp[i] = { tag, nameIndex: u2() }; break;
      case 8: cp[i] = { tag, stringIndex: u2() }; break;
      case 9: case 10: case 11: cp[i] = { tag, classIndex: u2(), nameAndTypeIndex: u2() }; break;
      case 12: cp[i] = { tag, nameIndex: u2(), descriptorIndex: u2() }; break;
      case 15: cp[i] = { tag, refKind: u1(), refIndex: u2() }; break;
      case 16: cp[i] = { tag, descriptorIndex: u2() }; break;
      case 17: case 18: cp[i] = { tag, bootstrapIndex: u2(), nameAndTypeIndex: u2() }; break;
      case 19: case 20: cp[i] = { tag, nameIndex: u2() }; break;
      default: throw new Error(`unknown cp tag ${tag}`);
    }
  }
  const utf8 = (idx) => (idx > 0 && cp[idx] && cp[idx].s !== undefined) ? cp[idx].s : null;
  const clsName = (idx) => (idx > 0 && cp[idx] && cp[idx].nameIndex !== undefined) ? utf8(cp[idx].nameIndex) : null;
  const dot = (s) => (s ? s.replace(/\//g, '.') : s);

  const access = u2();
  const thisInternal = clsName(u2());
  const superClass = dot(clsName(u2()));
  const ifCount = u2();
  const interfaces = [];
  for (let i = 0; i < ifCount; i++) interfaces.push(dot(clsName(u2())));
  const thisClass = dot(thisInternal);

  const fields = [];
  const fieldsCount = u2();
  for (let i = 0; i < fieldsCount; i++) {
    const fa = u2();
    const name = utf8(u2());
    const desc = utf8(u2());
    const attrCount = u2();
    let constantValue = null;
    for (let a = 0; a < attrCount; a++) {
      const an = utf8(u2());
      const alen = u4();
      if (an === 'ConstantValue') {
        const cvi = u2();
        const cve = cp[cvi];
        if (cve) {
          if (cve.tag === 8) constantValue = utf8(cve.stringIndex);
          else if (cve.int !== undefined) constantValue = cve.int;
          else if (cve.float !== undefined) constantValue = cve.float;
          else if (cve.long !== undefined) constantValue = cve.long;
          else if (cve.double !== undefined) constantValue = cve.double;
        }
      } else p += alen;
    }
    fields.push({ name, desc, access: fa, flags: accFlags(fa), constantValue });
  }

  const methods = [];
  const methodsCount = u2();
  for (let i = 0; i < methodsCount; i++) {
    const ma = u2();
    const name = utf8(u2());
    const desc = utf8(u2());
    const attrCount = u2();
    for (let a = 0; a < attrCount; a++) { u2(); const alen = u4(); p += alen; }
    methods.push({ name, desc, access: ma, flags: accFlags(ma) });
  }

  const strings = [];
  const seen = new Set();
  for (let i = 1; i < cpCount; i++) {
    const e = cp[i];
    if (e && e.tag === 8 && e.stringIndex) {
      const s = utf8(e.stringIndex);
      if (s !== null && !seen.has(s)) { seen.add(s); strings.push(s); }
    }
  }

  const isInterface = !!(access & ACC.INTERFACE);
  const isEnum = !!(access & ACC.ENUM);
  const isAbstract = !!(access & ACC.ABSTRACT);
  let enumConstants = [];
  if (isEnum) {
    const selfDesc = 'L' + thisInternal + ';';
    enumConstants = fields.filter(f => (f.access & ACC.STATIC) && f.desc === selfDesc).map(f => f.name);
  }
  return { name: thisClass, super: superClass, interfaces, access, flags: accFlags(access),
    isInterface, isEnum, isAbstract, major, enumConstants, fields, methods, strings };
}

// 描述符 → 可读类型
function typeOf(desc) {
  if (desc === 'V') return 'void';
  const prim = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double' };
  if (prim[desc[0]]) return prim[desc[0]];
  let arr = 0;
  while (desc[arr] === '[') arr++;
  let base = desc.slice(arr);
  let out;
  if (base.startsWith('L') && base.endsWith(';')) out = base.slice(1, -1).replace(/\//g, '.');
  else if (prim[base[0]]) out = prim[base[0]];
  else out = base;
  return out + '[]'.repeat(arr);
}

// 目标包映射
const PACKAGES = [
  { key: 'com.fr.form.ui', jar: 'engine', prefix: 'com/fr/form/ui/' },
  { key: 'com.fr.form.main.parameter', jar: 'engine', prefix: 'com/fr/form/main/parameter/' },
  { key: 'com.fr.report.cell.cellattr.highlight', jar: 'engine', prefix: 'com/fr/report/cell/cellattr/highlight/' },
  { key: 'com.fr.data.condition', jar: 'core', prefix: 'com/fr/data/condition/' },
  { key: 'com.fr.js', jar: 'engine', prefix: 'com/fr/js/' },
  { key: 'com.fr.chart', jar: 'engine', prefix: 'com/fr/chart/' },
  { key: 'com.fr.plugin.chart', jar: 'engine', prefix: 'com/fr/plugin/chart/' },
  { key: 'com.fr.report.write', jar: 'engine', prefix: 'com/fr/report/write/' },
  { key: 'com.fr.write', jar: 'engine', prefix: 'com/fr/write/' },
  { key: 'com.fr.report.web.button.write', jar: 'engine', prefix: 'com/fr/report/web/button/write/' },
  { key: 'com.fr.web.attr', jar: 'engine', prefix: 'com/fr/web/attr/' },
  { key: 'com.fr.base.Formula', jar: 'core', prefix: 'com/fr/base/Formula' },
];

const zips = {};
function zipFor(jarKey) {
  if (!zips[jarKey]) zips[jarKey] = readZipEntries(JARS[jarKey]);
  return zips[jarKey];
}

const result = {};
for (const pkg of PACKAGES) {
  const zip = zipFor(pkg.jar);
  const map = new Map();
  for (const name of zip.entries.keys()) {
    if (!name.startsWith(pkg.prefix) || !name.endsWith('.class')) continue;
    try {
      const c = parseClass(readEntry(zip, name));
      map.set(c.name, c);
    } catch (e) {
      console.error(`WARN parse fail ${name}: ${e.message}`);
    }
  }
  result[pkg.key] = { jar: pkg.jar, jarPath: JARS[pkg.jar], classes: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  console.log(`${pkg.key} [${pkg.jar}]: ${result[pkg.key].classes.length} classes`);
}

mkdirSync(join(REPO_ROOT, 'tmp_test'), { recursive: true });

// ---- 生成 docs/fr-ground-truth.md ----
const IDENT = /^[A-Za-z_][A-Za-z0-9_.$-]{0,63}$/;
function identStrings(c) {
  return [...new Set(c.strings.filter(s => IDENT.test(s) && s.length <= 64))].sort();
}
function fmtField(f) {
  const t = typeOf(f.desc);
  const cv = (f.constantValue !== null && f.constantValue !== undefined) ? ` = ${JSON.stringify(f.constantValue)}` : '';
  return `${f.name}:${t}${cv}`;
}
function fmtClassFlags(c) {
  const m = [];
  if (c.isInterface) m.push('interface');
  else if (c.isEnum) m.push('enum');
  else if (c.isAbstract) m.push('abstract');
  if (c.access & ACC.PUBLIC) m.push('public');
  else if (c.access & ACC.PROTECTED) m.push('protected');
  return m.join(' ');
}

const lines = [];
lines.push('# FR 真实结构清单（FineReport 11.0 设计器逆向）');
lines.push('');
lines.push('> 只读逆向产物：用 `scripts/fr-audit-probe.mjs` 解析关键 jar 的 **class 常量池**（类名/父类/接口/字段名+类型/方法名/字符串常量/枚举常量），不执行、不反编译方法体。');
lines.push('> 证据来源为本机 `FR_HOME` 环境变量指向的 FineReport 安装目录，三个关键 jar，每个类均可追溯 jar 来源。');
lines.push('');
lines.push('## 0. 方法与来源');
lines.push('');
lines.push('| 证据 jar | 路径 | 用途 |');
lines.push('|---|---|---|');
lines.push(`| fine-report-engine-11.0.jar | \`webapps/webroot/WEB-INF/lib/\` | 报表实体/控件/图表/填报/超链接主体 |`);
lines.push(`| fine-core-11.0.jar | \`webapps/webroot/WEB-INF/lib/\` | 基础框架、\`com.fr.base.Formula\`、\`com.fr.data.condition\` |`);
lines.push(`| fine-report-designer-11.0.jar | \`lib/\` | 设计器 UI（本清单未重点展开，控件/引擎类不在其中） |`);
lines.push('');
lines.push('### 类计数汇总');
lines.push('');
lines.push('| 包 | 类数 | jar 来源 |');
lines.push('|---|---|---|');
for (const pkg of PACKAGES) {
  lines.push(`| \`${pkg.key}\` | ${result[pkg.key].classes.length} | ${result[pkg.key].jar} |`);
}
const totalClasses = PACKAGES.reduce((s, p) => s + result[p.key].classes.length, 0);
lines.push(`| **合计** | **${totalClasses}** | |`);
lines.push('');

// 每个包
for (const pkg of PACKAGES) {
  const { classes, jar } = result[pkg.key];
  lines.push(`## ${pkg.key}（${classes.length} 类，来源 ${jar}）`);
  lines.push('');

  // 类索引表
  lines.push('### 类索引');
  lines.push('');
  lines.push('| 类全名 | 父类 | 修饰 | 枚举常量 |');
  lines.push('|---|---|---|---|');
  for (const c of classes) {
    const flags = fmtClassFlags(c);
    const enums = c.enumConstants.length ? c.enumConstants.join(', ') : '';
    lines.push(`| \`${c.name}\` | ${c.super || ''} | ${flags} | ${enums} |`);
  }
  lines.push('');

  // 枚举清单
  const enums = classes.filter(c => c.isEnum && c.enumConstants.length);
  if (enums.length) {
    lines.push('### 枚举类（枚举值）');
    lines.push('');
    for (const e of enums) {
      lines.push(`- \`${e.name}\`: ${e.enumConstants.join(' | ')}`);
    }
    lines.push('');
  }

  // 类详情
  lines.push('### 类详情（字段 / 方法名 / 字符串常量）');
  lines.push('');
  for (const c of classes) {
    const flags = fmtClassFlags(c);
    lines.push(`**${c.name}**（super: ${c.super || '—'}，${flags || 'package-private'}）`);
    if (c.interfaces.length) lines.push(`- 接口: ${c.interfaces.join(', ')}`);
    if (c.fields.length) lines.push(`- 字段(${c.fields.length}): ${c.fields.map(fmtField).join(', ')}`);
    const methodNames = [...new Set(c.methods.map(m => m.name))].sort();
    if (methodNames.length) lines.push(`- 方法(${methodNames.length}): ${methodNames.join(', ')}`);
    const strs = identStrings(c);
    if (strs.length) lines.push(`- 字符串常量(${strs.length}): ${strs.map(s => `"${s}"`).join(', ')}`);
    if (c.enumConstants.length) lines.push(`- 枚举常量: ${c.enumConstants.join(', ')}`);
    lines.push('');
  }
}

// XML 序列化形态
lines.push('## 8. XML 序列化形态（基于真实 .cpt 样本 + 字符串常量证据）');
lines.push('');
lines.push('### 8.1 普通报表单元格控件（填报单元格）');
lines.push('```xml');
lines.push('<C c="0" r="1" s="2">');
lines.push('  <PrivilegeControl/>');
lines.push('  <Widget class="com.fr.form.ui.TextEditor">');
lines.push('    <WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">');
lines.push('      <MobileBookMark useBookMark="false" bookMarkName="" frozen="false" index="-1" oldWidgetName=""/>');
lines.push('      <PrivilegeControl/>');
lines.push('    </WidgetAttr>');
lines.push('    <TextAttr/>');
lines.push('    <Reg class="com.fr.form.ui.reg.NoneReg"/>');
lines.push('    <widgetValue><O><![CDATA[]]></O></widgetValue>');
lines.push('  </Widget>');
lines.push('  <Expand/>');
lines.push('</C>');
lines.push('```');
lines.push('- 单元格控件的 XML 元素统一为 `<Widget class="...">`，类型由 `class` 属性给出 FQN（而非控件名作为元素名）。');
lines.push('- 控件专属配置为子元素：`WidgetAttr`（通用属性）、`TextAttr`/`NumberAttr`/`DateAttr` 等（各控件类型专属）、`Reg`（校验规则，`class="com.fr.form.ui.reg.NoneReg"`）。');
lines.push('');
lines.push('### 8.2 填报按钮（Submit / AppendColumnRow）');
lines.push('```xml');
lines.push('<Widget class="com.fr.report.web.button.write.Submit">');
lines.push('  <WidgetAttr aspectRatioLocked="false" aspectRatioBackup="-1.0" description="">...</WidgetAttr>');
lines.push('  <Text><![CDATA[${i18n(\'Utils-Submit\')}]]></Text>');
lines.push('  <Hotkeys><![CDATA[]]></Hotkeys>');
lines.push('  <IconName><![CDATA[submit]]></IconName>');
lines.push('  <Verify failVerifySubmit="false"/>');
lines.push('  <Sheet onlySubmitSelect="false"/>');
lines.push('</Widget>');
lines.push('```');
lines.push('- 填报按钮类位于 `com.fr.report.web.button.write`（Submit/AppendColumnRow/AppendRowButton/DeleteRowButton/Verify/ExcelImport 等），**不在** `com.fr.form.ui`。');
lines.push('');
lines.push('### 8.3 填报提交配置（ReportWriteAttr / SubmitVisitor）');
lines.push('```xml');
lines.push('<ReportWriteAttr>');
lines.push('  <SubmitVisitor class="com.fr.report.write.BuiltInSQLSubmiter">');
lines.push('    <Name><![CDATA[内置SQL1]]></Name>');
lines.push('    <Attributes dsName="Doris"/>');
lines.push('    <DMLConfig class="com.fr.write.config.IntelliDMLConfig">');
lines.push('      <Table schema="" name="fill_record"/>');
lines.push('      <ColumnConfig name="sku_code" isKey="false" skipUnmodified="false">');
lines.push('        <ColumnRow column="0" row="1"/>');
lines.push('      </ColumnConfig>');
lines.push('    </DMLConfig>');
lines.push('  </SubmitVisitor>');
lines.push('</ReportWriteAttr>');
lines.push('```');
lines.push('- `ReportWriteAttr`（`com.fr.report.write.ReportWriteAttr`）的 XML_TAG = `ReportWriteAttr`；`SubmitVisitor` 抽象类 XML_TAG = `SubmitVisitor`。');
lines.push('- `DMLConfig`（`com.fr.write.config.DMLConfig`）、`ColumnConfig`（`com.fr.write.config.ColumnConfig`）对应 `com.fr.write` 包（填报提交层）。');
lines.push('');
lines.push('### 8.4 参数面板布局');
lines.push('```xml');
lines.push('<ReportParameterAttr>');
lines.push('  <ParameterUI class="com.fr.form.main.parameter.FormParameterUI">');
lines.push('    <Parameters/>');
lines.push('    <Layout class="com.fr.form.ui.container.WParameterLayout">');
lines.push('      <WidgetName name="para"/>');
lines.push('      <Margin top="1" left="1" bottom="1" right="1"/>');
lines.push('      <LCAttr vgap="0" hgap="0" compInterval="0"/>');
lines.push('    </Layout>');
lines.push('  </ParameterUI>');
lines.push('</ReportParameterAttr>');
lines.push('```');
lines.push('');
lines.push('### 8.5 报表 Web 填报属性（WebWriteContent / EditRowColor 为 XML 元素名，非类名）');
lines.push('```xml');
lines.push('<ReportWebAttr>');
lines.push('  <WebWriteContent>');
lines.push('    <ToolBars/>');
lines.push('    <EditRowColor setColor="false"/>');
lines.push('    <WebWrite SheetPosition="3"/>');
lines.push('    <RptLocation isShowAtLeft="true"/>');
lines.push('    <UnloadCheck/>');
lines.push('    <ShowWidgets/>');
lines.push('    <OtherAttr autoStash="false"/>');
lines.push('  </WebWriteContent>');
lines.push('</ReportWebAttr>');
lines.push('```');
lines.push('- `WebWriteContent`、`EditRowColor`、`WebPageContent` 等是 **XML 元素名（字符串常量）**，由 `com.fr.web.attr.ReportWebAttr` 读写；对应类为 `com.fr.web.attr.ReportWebAttr`（不是 `com.fr.report.write.*` 下的类）。');
lines.push('');

const md = lines.join('\n');
const docsPath = join(REPO_ROOT, 'docs', 'fr-ground-truth.md');
const tmpPath = join(REPO_ROOT, 'tmp_test', 'fr-ground-truth.md');
writeFileSync(docsPath, md);
writeFileSync(tmpPath, md);
console.log(`\ndone: ${docsPath} (${lines.length} lines), ${tmpPath}`);
