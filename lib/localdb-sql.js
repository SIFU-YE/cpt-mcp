// cpt-mcp/lib/localdb-sql.js
// 本地 SQLite 测试库的 MySQL/Doris 方言兼容层（自包含、无 npm 依赖）。
//
// 模块定位
//   cpt-mcp 的报表数据集 SQL 来自真实 MySQL 8.0 / Doris（MySQL 兼容）。本模块让这些 SQL
//   能直接在 Node 内置的 node:sqlite（DatabaseSync）上执行/校验：
//     1) translateMySqlToSqlite(sql)：把 MySQL/Doris 专有写法改写成 SQLite 可执行的 SQL；
//     2) registerMySqlFunctions(db)：注册 MySQL 语义的 UDF（CONCAT/IF/DATE_FORMAT/...）；
//     3) splitSqlStatements(sql)：按分号切分多语句，供导入 .sql 文件；
//     4) LOCAL_SQL_CAVEATS：已知语义差异清单。
//
// 为什么必须做词法级改写
//   MySQL 的关键字/运算符可能原样出现在字符串字面量、注释、反引号标识符里，例如
//   'STRAIGHT_JOIN'、'LIMIT 1,2'、'a || b'、'# 注释'。用全局正则替换会把这些文本一起改坏，
//   导致本地库执行结果与真实库不一致（甚至语法错误）。因此这里先做词法切分，只在“代码”
//   token 上改写；字符串 / 注释 / 反引号标识符 token 一律原样保留。
//
// 已知限制（详见 LOCAL_SQL_CAVEATS）
//   - 只覆盖报表 SQL 常用语法，不做完整 MySQL/Doris 方言解析；
//   - 运算符形式的 INTERVAL、DIV、COLLATE、MATCH ... AGAINST、ON DUPLICATE KEY UPDATE
//     只报告 issue、不硬改（本地硬改容易制造“看起来对、实际语义变了”的假象）；
//   - schema 限定表名（Doris `db.table`）会改写为裸表名并报 schema_prefix_stripped：
//     本地镜像库按裸表名导入，SQLite 也没有 schema 命名空间；只影响本地 SQL，真实库不受影响；
//   - SQLite 没有 DECIMAL 定点类型，排序规则 / 时区 / 正则语义也与 MySQL 有差异；
//   - 本地改写与 UDF 只是“尽量接近”，最终结论请以真实库执行为准。
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

const LOCAL_HINT_SUFFIX = '这是本地 SQLite 的限制，不代表报表 SQL 错，请以真实库执行为准。';

const PAD2 = (n) => String(n).padStart(2, '0');
const PAD3 = (n) => String(n).padStart(3, '0');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_ABBR = MONTH_NAMES.map((m) => m.slice(0, 3));
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBR = DAY_NAMES.map((d) => d.slice(0, 3));

/** 把 SQLite UDF 参数转成字符串（NULL 原样返回 null）。 */
function toText(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

/** MySQL 真值判断：0、''、'0'、'abc'（转数字 0）都算假。 */
function mysqlTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'bigint') return value !== 0n;
  const s = String(value).trim();
  if (s === '') return false;
  const n = Number(s);
  return Number.isFinite(n) ? n !== 0 : false;
}

// ---------------------------------------------------------------------------
// 1) 词法分析：字符串 / 注释 / 反引号标识符整体成 token，绝不改其内部文本
// ---------------------------------------------------------------------------

const MULTI_PUNCT = ['<=>', '->>', '->', '<=', '>=', '<>', '!=', '||', '&&', ':='];
const SKIP_TYPES = new Set(['ws', 'line_comment', 'block_comment', 'hint']);

function isSpaceChar(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isDigitChar(ch) {
  return ch >= '0' && ch <= '9';
}
function isWordStartChar(ch) {
  return /[A-Za-z_$\u0080-\uFFFF]/u.test(ch);
}
function isWordPartChar(ch) {
  return /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(ch);
}

/**
 * 词法切分。token 类型：
 *   ws / line_comment / hash_comment / block_comment / hint / string / ident / number / word / punct
 * 所有 token 的 start 都是原 SQL 中的字符偏移。
 */
function tokenize(sql) {
  const tokens = [];
  const n = sql.length;
  let i = 0;
  const push = (type, start, end) => {
    tokens.push({ type, text: sql.slice(start, end), start });
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (isSpaceChar(ch)) {
      let j = i + 1;
      while (j < n && isSpaceChar(sql[j])) j++;
      push('ws', i, j);
      i = j;
      continue;
    }

    // -- 行注释：MySQL 要求 -- 后跟空白/控制字符（因此 a--1 仍是 a - -1）
    if (ch === '-' && next === '-') {
      const after = sql[i + 2];
      if (after === undefined || isSpaceChar(after) || after === '\u0000') {
        let j = i + 2;
        while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
        push('line_comment', i, j);
        i = j;
        continue;
      }
    }

    // # 行注释（MySQL 特有；SQLite 不支持）
    if (ch === '#') {
      let j = i + 1;
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j++;
      push('hash_comment', i, j);
      i = j;
      continue;
    }

    // 块注释；/*+ 是优化器 hint
    if (ch === '/' && next === '*') {
      const isHint = sql[i + 2] === '+';
      let j = i + 2;
      while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      if (j < n) j += 2;
      else j = n;
      push(isHint ? 'hint' : 'block_comment', i, j);
      i = j;
      continue;
    }

    // 单引号 / 双引号字符串：支持 '' 与反斜杠转义
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('string', i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }

    // 反引号标识符：`` 是转义
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('ident', i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }

    // 数字（含小数 / 科学计数法）
    if (isDigitChar(ch) || (ch === '.' && isDigitChar(next || ''))) {
      let j = i;
      while (j < n && (isDigitChar(sql[j]) || sql[j] === '.')) j++;
      if (sql[j] === 'e' || sql[j] === 'E') {
        j++;
        if (sql[j] === '+' || sql[j] === '-') j++;
        while (j < n && isDigitChar(sql[j])) j++;
      }
      push('number', i, j);
      i = j;
      continue;
    }

    // 单词 / 标识符
    if (isWordStartChar(ch)) {
      let j = i + 1;
      while (j < n && isWordPartChar(sql[j])) j++;
      push('word', i, j);
      i = j;
      continue;
    }

    // 多字符运算符
    let multi = null;
    for (const p of MULTI_PUNCT) {
      if (sql.startsWith(p, i)) {
        multi = p;
        break;
      }
    }
    if (multi) {
      push('punct', i, i + multi.length);
      i += multi.length;
      continue;
    }

    push('punct', i, i + 1);
    i++;
  }

  return tokens;
}

/**
 * 词法切分（导出给 localdb-import 等模块复用：抽出 FROM/JOIN 表引用时不要再用正则糊弄
 * 字符串/注释/反引号，否则子查询、EXTRACT(... FROM x) 之类会误判）。
 * @param {string} sql
 * @returns {Array<{type:string,text:string,start:number}>}
 */
export function tokenizeSql(sql) {
  return tokenize(String(sql ?? ''));
}

/** 非代码 token 类型（空白/注释/hint）：扫描语句结构时应跳过。 */
export const SQL_SKIP_TOKEN_TYPES = SKIP_TYPES;

function nextSig(tokens, index) {
  for (let j = index + 1; j < tokens.length; j++) {
    if (!SKIP_TYPES.has(tokens[j].type)) return j;
  }
  return -1;
}

function prevSig(tokens, index) {
  for (let j = index - 1; j >= 0; j--) {
    if (!SKIP_TYPES.has(tokens[j].type)) return j;
  }
  return -1;
}

/** 从 openIdx 的 '(' 找到匹配的 ')' 下标；找不到返回 -1。 */
function findMatchingParen(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.text === '(') depth++;
    else if (t.text === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在 (openIdx, closeIdx) 内按“相对深度 0”查找满足 predicate 的 token。 */
function findTopLevel(tokens, openIdx, closeIdx, predicate) {
  let depth = 0;
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
    }
    if (depth === 0 && predicate(t, i)) return i;
  }
  return -1;
}

function isWordToken(token, upper) {
  return Boolean(token) && token.type === 'word' && token.text.toUpperCase() === upper;
}

// ---------------------------------------------------------------------------
// 2) 方言翻译
// ---------------------------------------------------------------------------

const CAST_TYPE_MAP = {
  CHAR: 'TEXT',
  NCHAR: 'TEXT',
  SIGNED: 'INTEGER',
  UNSIGNED: 'INTEGER',
  DECIMAL: 'NUMERIC',
  DEC: 'NUMERIC',
  FIXED: 'NUMERIC',
  DATETIME: 'TEXT',
  DATE: 'TEXT',
  TIME: 'TEXT',
  JSON: 'TEXT',
};

const DATE_FN_MAP = {
  DATE_ADD: 'date_add',
  ADDDATE: 'date_add',
  DATE_SUB: 'date_sub',
  SUBDATE: 'date_sub',
};

const SUPPORTED_INTERVAL_UNITS = new Set([
  'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
]);

// 这些关键字之后出现的 BINARY 视为一元前缀（而不是 CAST(... AS BINARY) 的类型名）
const EXPR_START_KEYWORDS = new Set([
  'SELECT', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'WHEN', 'THEN', 'ELSE', 'BY', 'HAVING',
  'SET', 'VALUES', 'RETURNING', 'CASE', 'LIMIT', 'OFFSET', 'IN', 'LIKE', 'BETWEEN', 'IS',
  'EXISTS', 'DISTINCT', 'ALL', 'ANY', 'SOME', 'USING', 'FROM', 'JOIN', 'LEFT', 'RIGHT',
  'INNER', 'OUTER', 'CROSS', 'UNION', 'EXCEPT', 'INTERSECT',
]);

function mapCastType(word) {
  return CAST_TYPE_MAP[word.toUpperCase()] || null;
}

/** BINARY 是否处于一元运算符位置（CAST(x AS BINARY) 的类型名不算）。 */
function isUnaryBinary(tokens, index) {
  const next = nextSig(tokens, index);
  if (next < 0) return false;
  const nt = tokens[next];
  const nextOk = nt.type === 'word'
    || nt.type === 'number'
    || nt.type === 'string'
    || nt.type === 'ident'
    || (nt.type === 'punct' && ['(', '-', '+', '~', '!'].includes(nt.text));
  if (!nextOk) return false;

  const prev = prevSig(tokens, index);
  if (prev < 0) return true;
  const pt = tokens[prev];
  if (pt.type === 'word') return EXPR_START_KEYWORDS.has(pt.text.toUpperCase());
  if (pt.type === 'punct') return pt.text !== ')' && pt.text !== ']';
  return false; // 数字/字符串/标识符之后不是一元前缀
}

// ---------------------------------------------------------------------------
// 2.0) schema 限定表名：表位锚点与 FROM 列表边界
// ---------------------------------------------------------------------------

/** 这些关键字之后紧跟的是表位（MySQL/Doris 的 `db.table` 可能出现在这里）。 */
const SCHEMA_TABLE_ANCHORS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'STRAIGHT_JOIN']);

/** FROM 表列表在相对深度 0 遇到这些关键字即结束（各 JOIN 变体由各自的 JOIN 锚点处理）。 */
const FROM_LIST_END_KEYWORDS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW',
  'JOIN', 'STRAIGHT_JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL',
  'ON', 'USING', 'SET', 'VALUES', 'RETURNING', 'FOR', 'LOCK', 'PROCEDURE', 'INTO',
]);

/** 出现在表位/限定名位置但不是表名的保留字（FROM (SELECT…)、FROM LATERAL… 等）。 */
const SCHEMA_NAME_STOPWORDS = new Set([
  'SELECT', 'VALUES', 'LATERAL', 'TABLE', 'ONLY', 'WITH', 'TEMP', 'TEMPORARY',
  'AND', 'OR', 'NOT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
]);

/**
 * MySQL/Doris 方言 → SQLite 改写。
 * 只在代码 token 上改写，字符串 / 注释 / 反引号标识符内部一律原样保留。
 * 其中 schema 限定表名（`db.table`）会被改写成裸表名（仅本地 SQLite，见下方 schema 段），
 * 并记 `schema_prefix_stripped` dialectIssue，绝不静默。
 *
 * @param {string} sql
 * @returns {{sql:string, issues:Array<{code:string,at:number,snippet:string,hint:string}>, changed:boolean}}
 */
export function translateMySqlToSqlite(sql) {
  const source = String(sql ?? '');
  const tokens = tokenize(source);
  const edits = new Map();
  const issues = [];
  const issueKeys = new Set();
  const consumedInterval = new Set();
  const consumedAgainst = new Set();

  const setEdit = (index, text) => {
    edits.set(index, text);
  };

  const addIssue = (code, at, hint) => {
    const key = `${code}@${at}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    const safeAt = Number.isFinite(at) && at >= 0 ? Math.trunc(at) : 0;
    issues.push({
      code,
      at: safeAt,
      snippet: source.slice(Math.max(0, safeAt - 20), Math.min(source.length, safeAt + 20)),
      hint,
    });
  };

  // ---- 主改写循环 ----
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'hint') {
      setEdit(i, ' ');
      addIssue(
        'optimizer_hint_removed',
        token.start,
        '已移除 MySQL 优化器 hint（/*+ ... */）；SQLite 不支持执行计划 hint，去掉后语义不变。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (token.type === 'hash_comment') {
      setEdit(i, ' ');
      addIssue(
        'hash_comment_removed',
        token.start,
        '已移除 MySQL 的 # 行注释；SQLite 不支持 # 注释。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (token.type === 'punct' && token.text === '||') {
      setEdit(i, ' OR ');
      addIssue(
        'pipe_operator_assumed_or',
        token.start,
        'MySQL 默认 sql_mode 下 || 是逻辑或，已改写为 OR；若真实库启用了 PIPES_AS_CONCAT，则 || 表示字符串拼接，语义不同。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (token.type !== 'word') continue;
    const upper = token.text.toUpperCase();

    if (upper === 'STRAIGHT_JOIN') {
      setEdit(i, 'JOIN');
      addIssue(
        'straight_join_removed',
        token.start,
        'STRAIGHT_JOIN 已按普通 JOIN 处理；SQLite 无法强制 JOIN 顺序。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (upper === 'CAST') {
      const open = nextSig(tokens, i);
      if (open < 0 || tokens[open].text !== '(') continue;
      const close = findMatchingParen(tokens, open);
      if (close < 0) continue;
      const asIdx = findTopLevel(tokens, open, close, (t) => isWordToken(t, 'AS'));
      if (asIdx < 0) continue;
      const typeIdx = nextSig(tokens, asIdx);
      if (typeIdx < 0 || typeIdx >= close) continue;
      const typeToken = tokens[typeIdx];
      if (typeToken.type !== 'word') continue;
      const mapped = mapCastType(typeToken.text);
      if (!mapped) continue;
      setEdit(typeIdx, mapped);
      if (/^(SIGNED|UNSIGNED)$/.test(typeToken.text.toUpperCase())) {
        const intIdx = nextSig(tokens, typeIdx);
        if (intIdx > 0 && intIdx < close && isWordToken(tokens[intIdx], 'INTEGER')) setEdit(intIdx, '');
        else if (intIdx > 0 && intIdx < close && isWordToken(tokens[intIdx], 'INT')) setEdit(intIdx, '');
      }
      continue;
    }

    if (upper === 'CONVERT') {
      const open = nextSig(tokens, i);
      if (open < 0 || tokens[open].text !== '(') continue;
      const close = findMatchingParen(tokens, open);
      if (close < 0) continue;
      const comma = findTopLevel(tokens, open, close, (t) => t.type === 'punct' && t.text === ',');
      if (comma < 0) continue;
      const typeIdx = nextSig(tokens, comma);
      if (typeIdx < 0 || typeIdx >= close) continue;
      const typeToken = tokens[typeIdx];
      // CONVERT(x USING utf8) 是字符集转换，不硬改
      if (isWordToken(typeToken, 'USING')) continue;
      if (typeToken.type !== 'word') continue;
      const mapped = mapCastType(typeToken.text);
      if (!mapped) continue;
      setEdit(i, 'CAST');
      setEdit(comma, ' AS ');
      for (let k = comma + 1; k < typeIdx; k++) {
        if (tokens[k].type === 'ws') setEdit(k, '');
      }
      setEdit(typeIdx, mapped);
      if (/^(SIGNED|UNSIGNED)$/.test(typeToken.text.toUpperCase())) {
        const intIdx = nextSig(tokens, typeIdx);
        if (intIdx > 0 && intIdx < close
          && (isWordToken(tokens[intIdx], 'INTEGER') || isWordToken(tokens[intIdx], 'INT'))) {
          setEdit(intIdx, '');
        }
      }
      continue;
    }

    if (upper === 'GROUP_CONCAT') {
      const open = nextSig(tokens, i);
      if (open < 0 || tokens[open].text !== '(') continue;
      const close = findMatchingParen(tokens, open);
      if (close < 0) continue;
      const sepIdx = findTopLevel(tokens, open, close, (t) => isWordToken(t, 'SEPARATOR'));
      if (sepIdx < 0) continue;
      setEdit(sepIdx, ',');
      if (sepIdx - 1 >= 0 && tokens[sepIdx - 1].type === 'ws') setEdit(sepIdx - 1, '');
      continue;
    }

    if (DATE_FN_MAP[upper]) {
      const open = nextSig(tokens, i);
      if (open < 0 || tokens[open].text !== '(') continue;
      const close = findMatchingParen(tokens, open);
      if (close < 0) continue;
      const comma = findTopLevel(tokens, open, close, (t) => t.type === 'punct' && t.text === ',');
      if (comma < 0) continue;
      const secondIdx = nextSig(tokens, comma);
      if (secondIdx < 0 || secondIdx >= close) continue;

      if (isWordToken(tokens[secondIdx], 'INTERVAL')) {
        const intervalIdx = secondIdx;
        const qtyIdx = nextSig(tokens, intervalIdx);
        if (qtyIdx < 0 || qtyIdx >= close) continue;
        // unit 是 ')' 之前最后一个非空白 token
        let unitIdx = close - 1;
        while (unitIdx > intervalIdx && SKIP_TYPES.has(tokens[unitIdx].type)) unitIdx--;
        if (unitIdx <= intervalIdx) continue;
        const unitToken = tokens[unitIdx];
        if (unitToken.type !== 'word') continue;
        const unit = unitToken.text.toLowerCase();
        if (!SUPPORTED_INTERVAL_UNITS.has(unit)) {
          consumedInterval.add(intervalIdx);
          addIssue(
            'unsupported_interval_unit',
            unitToken.start,
            `DATE_ADD/DATE_SUB 的 INTERVAL 单位 "${unitToken.text}" 本地未支持（仅支持 SECOND/MINUTE/HOUR/DAY/WEEK/MONTH/QUARTER/YEAR），该调用已原样保留。` + LOCAL_HINT_SUFFIX,
          );
          continue;
        }
        setEdit(i, DATE_FN_MAP[upper]);
        setEdit(intervalIdx, '');
        // 去掉 INTERVAL 与数量之间、数量与单位之间的空白，保持参数间逗号与空格
        if (intervalIdx + 1 < tokens.length && tokens[intervalIdx + 1].type === 'ws') setEdit(intervalIdx + 1, '');
        if (unitIdx - 1 >= 0 && tokens[unitIdx - 1].type === 'ws') setEdit(unitIdx - 1, '');
        setEdit(unitIdx, `, '${unit}'`);
        consumedInterval.add(intervalIdx);
        continue;
      }

      // ADDDATE(d, 7) / SUBDATE(d, 7) 的数字简写：按“加/减 N 天”处理
      if (upper === 'ADDDATE' || upper === 'SUBDATE') {
        setEdit(i, DATE_FN_MAP[upper]);
        if (close - 1 >= 0 && tokens[close - 1].type === 'ws') setEdit(close - 1, '');
        setEdit(close, `, 'day')`);
      }
      continue;
    }

    if (upper === 'GREATEST' || upper === 'LEAST') {
      const open = nextSig(tokens, i);
      if (open < 0 || tokens[open].text !== '(') continue;
      setEdit(i, upper === 'GREATEST' ? 'max' : 'min');
      continue;
    }

    if (upper === 'BINARY' && isUnaryBinary(tokens, i)) {
      setEdit(i, '');
      addIssue(
        'binary_operator_ignored',
        token.start,
        '已去掉一元 BINARY 前缀；SQLite 没有二进制字符串强制转换，比较/排序可能按文本进行。' + LOCAL_HINT_SUFFIX,
      );
    }
  }

  // ---- 只报告、不硬改的不支持项 ----
  // MATCH ... AGAINST：先标记被 MATCH 消费的 AGAINST，避免重复报
  for (let i = 0; i < tokens.length; i++) {
    if (!isWordToken(tokens[i], 'MATCH')) continue;
    let depth = 0;
    for (let k = i + 1; k < tokens.length && k <= i + 40; k++) {
      const tk = tokens[k];
      if (tk.type === 'punct') {
        if (tk.text === '(') depth++;
        else if (tk.text === ')') {
          depth--;
          if (depth < 0) break;
        } else if (tk.text === ';' && depth === 0) break;
      }
      if (depth === 0 && isWordToken(tk, 'AGAINST')) {
        addIssue(
          'unsupported_fulltext',
          tokens[i].start,
          'MATCH ... AGAINST 全文检索在 SQLite 中不可用（需 FTS5 且语法不同），SQL 已原样保留。' + LOCAL_HINT_SUFFIX,
        );
        consumedAgainst.add(k);
        break;
      }
    }
  }

  // ---- schema 限定表名（Doris/MySQL `bi_ads.表名`）→ 裸表名（只改写本地 SQL） ----
  // 背景：本地镜像库按裸表名导入（localdb-import 的 autoTables 已 strip schema），
  // 若 SQL 写 `FROM bi_ads.ods_sku`，SQLite 会直接报 no such table，离线审计因此 enabled:false。
  // 规则：
  //   ① 只在表位（FROM/JOIN/UPDATE/INTO 及其 FROM 逗号列表）改写：删掉表名前的限定段与点；
  //   ② `schema.table.column` 三段式（列引用）也删 schema 段，但前提是该 schema/table 已在本次
  //      语句的表位出现过，且首段不是别名（alias 与 schema 同名时不误伤）；
  //   ③ 字符串 / 注释 / 反引号内部一律原样保留（token 边界保证）；alias.column 不动；
  //   ④ 每个 schema 只报一次 schema_prefix_stripped，提示"仅本地改写、真实库不受影响"。
  const schemaTables = new Map(); // schemaLower -> Set<tableLower>（表位出现过的 裸表名）
  const schemaNames = new Map(); // schemaLower -> 原始写法（用于 issue 文案）
  const aliasNames = new Set(); // 表别名（小写），避免把 alias.col 当成 schema.table
  const schemaIssueAt = new Set();
  const bareTables = new Set();

  const isNameToken = (tk) => Boolean(tk) && (tk.type === 'word' || tk.type === 'ident');
  const identifierName = (tk) => {
    if (!tk) return null;
    if (tk.type === 'word') return tk.text;
    if (tk.type === 'ident') {
      const raw = tk.text;
      if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) return raw.slice(1, -1).replace(/``/g, '`');
      return raw;
    }
    return null;
  };
  const isStopword = (tk) => tk.type === 'word' && SCHEMA_NAME_STOPWORDS.has(tk.text.toUpperCase());

  const reportSchema = (schemaLower, at) => {
    if (schemaIssueAt.has(schemaLower)) return;
    schemaIssueAt.add(schemaLower);
    const shown = schemaNames.get(schemaLower) ?? schemaLower;
    addIssue(
      'schema_prefix_stripped',
      at,
      `本地 SQLite 没有 schema 命名空间：表位 "${shown}.<表>" 已改写为裸表名（本地镜像按裸表名导入）。`
      + '该改写只作用于本地 SQL，真实库执行不受影响；若本地仍报缺表，说明这张裸表还没导入本地库。'
      + LOCAL_HINT_SUFFIX,
    );
  };

  /** 登记表位：识别 name(.name)*，前缀段删除，返回最终（裸）表名的 token 下标；不像表名则返回 -1。 */
  const registerTableRef = (startIdx) => {
    const first = tokens[startIdx];
    if (!isNameToken(first) || isStopword(first)) return -1;
    const firstName = identifierName(first);
    if (!firstName) return -1;
    const segs = [{ idx: startIdx, name: firstName, dotIdx: -1 }];
    let cur = startIdx;
    for (;;) {
      const dot = nextSig(tokens, cur);
      if (dot < 0 || tokens[dot].type !== 'punct' || tokens[dot].text !== '.') break;
      const nxt = nextSig(tokens, dot);
      if (nxt < 0 || !isNameToken(tokens[nxt]) || isStopword(tokens[nxt])) break;
      const nm = identifierName(tokens[nxt]);
      if (!nm) break;
      segs.push({ idx: nxt, name: nm, dotIdx: dot });
      cur = nxt;
    }
    const tableSeg = segs[segs.length - 1];
    const tableLower = tableSeg.name.toLowerCase();
    if (segs.length === 1) {
      bareTables.add(tableLower);
    } else {
      // `db.t` / `catalog.db.t`：删掉除最后一段外的所有限定段（含其后的点）
      for (let s = 0; s < segs.length - 1; s += 1) {
        const schemaLower = segs[s].name.toLowerCase();
        setEdit(segs[s].idx, '');
        const dotAfter = segs[s + 1]?.dotIdx ?? -1;
        if (dotAfter >= 0) setEdit(dotAfter, '');
        if (!schemaNames.has(schemaLower)) schemaNames.set(schemaLower, segs[s].name);
        if (!schemaTables.has(schemaLower)) schemaTables.set(schemaLower, new Set());
        schemaTables.get(schemaLower).add(tableLower);
        reportSchema(schemaLower, tokens[segs[s].idx].start);
      }
    }
    // 表别名：`FROM t AS x` / `FROM t x`（JOIN 变体与子句关键字不算别名）
    const a1 = nextSig(tokens, tableSeg.idx);
    if (a1 >= 0) {
      if (isWordToken(tokens[a1], 'AS')) {
        const a2 = nextSig(tokens, a1);
        const nm = isNameToken(tokens[a2]) ? identifierName(tokens[a2]) : null;
        if (nm) aliasNames.add(nm.toLowerCase());
      } else if (isNameToken(tokens[a1]) && !isStopword(tokens[a1])) {
        const up = tokens[a1].type === 'word' ? tokens[a1].text.toUpperCase() : '';
        if (!FROM_LIST_END_KEYWORDS.has(up)) {
          const nm = identifierName(tokens[a1]);
          if (nm) aliasNames.add(nm.toLowerCase());
        }
      }
    }
    return tableSeg.idx;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'word') continue;
    const upper = token.text.toUpperCase();
    if (!SCHEMA_TABLE_ANCHORS.has(upper)) continue;
    const start = nextSig(tokens, i);
    if (start < 0) continue;
    registerTableRef(start);
    if (upper !== 'FROM') continue;
    // FROM 表列表：`FROM a, db.b, c` —— 只在相对深度 0 的逗号后继续登记
    let depth = 0;
    for (let j = start; j < tokens.length; j += 1) {
      const tk = tokens[j];
      if (tk.type === 'punct') {
        if (tk.text === '(') depth += 1;
        else if (tk.text === ')') {
          depth -= 1;
          if (depth < 0) break;
        } else if (tk.text === ';' && depth === 0) break;
        else if (tk.text === ',' && depth === 0) {
          const nxt = nextSig(tokens, j);
          if (nxt >= 0) registerTableRef(nxt);
        }
      } else if (tk.type === 'word' && depth === 0 && FROM_LIST_END_KEYWORDS.has(tk.text.toUpperCase())) {
        break;
      }
    }
  }

  // 列引用里的 schema 前缀：`schema.table.column` → `table.column`（支持 `catalog.db.table.column`）。
  // 只删"已识别 schema"的前缀段，且保留最后两段（表 + 列）；`alias.column` 两段式不动。
  if (schemaNames.size > 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const tk = tokens[i];
      if (!isNameToken(tk)) continue;
      const name = identifierName(tk);
      if (!name) continue;
      const lower = name.toLowerCase();
      if (!schemaNames.has(lower) || aliasNames.has(lower)) continue;
      const prev = prevSig(tokens, i);
      if (prev >= 0 && tokens[prev].type === 'punct' && tokens[prev].text === '.') continue; // 已是被限定的一段
      // 收集 name (. name)* 链
      const chain = [{ idx: i, name: lower, dot: -1 }];
      let cur = i;
      for (;;) {
        const dot = nextSig(tokens, cur);
        if (dot < 0 || tokens[dot].type !== 'punct' || tokens[dot].text !== '.') break;
        const nxt = nextSig(tokens, dot);
        if (nxt < 0 || !isNameToken(tokens[nxt])) break;
        const nm = identifierName(tokens[nxt]);
        if (!nm) break;
        chain.push({ idx: nxt, name: nm.toLowerCase(), dot });
        cur = nxt;
      }
      if (chain.length < 3) continue; // 至少 schema.table.column
      const prefixCount = chain.length - 2;
      const prefixes = chain.slice(0, prefixCount);
      // 前缀段必须都是已识别 schema（链式限定），否则保守跳过（避免误改 a.b.c 之类的普通标识符链）
      if (!prefixes.every((p) => schemaNames.has(p.name))) continue;
      const tableSeg = chain[prefixCount];
      const parentSchema = chain[prefixCount - 1].name;
      if (!schemaTables.get(parentSchema)?.has(tableSeg.name)) continue;
      for (let s = 0; s < prefixCount; s += 1) {
        setEdit(chain[s].idx, '');
        const dotAfter = chain[s + 1]?.dot ?? -1;
        if (dotAfter >= 0) setEdit(dotAfter, '');
        reportSchema(chain[s].name, tokens[chain[s].idx].start);
      }
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'word') continue;
    const upper = token.text.toUpperCase();

    if (upper === 'INTERVAL' && !consumedInterval.has(i) && edits.get(i) !== '') {
      addIssue(
        'unsupported_interval_operator',
        token.start,
        '运算符形式的 INTERVAL（如 dt + INTERVAL 1 DAY）无法在本地 SQLite 执行，SQL 已原样保留。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (upper === 'DIV') {
      addIssue(
        'unsupported_div_operator',
        token.start,
        'MySQL 的 DIV 整数除法在 SQLite 中没有对应写法，SQL 已原样保留；可改用 CAST(a / b AS INTEGER)。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (upper === 'COLLATE') {
      addIssue(
        'unsupported_collate',
        token.start,
        'COLLATE 指定的排序规则在 SQLite 中不生效（本地库使用 BINARY 排序），SQL 已原样保留。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (upper === 'AGAINST' && !consumedAgainst.has(i)) {
      addIssue(
        'unsupported_fulltext',
        token.start,
        'MATCH ... AGAINST 全文检索在 SQLite 中不可用（需 FTS5 且语法不同），SQL 已原样保留。' + LOCAL_HINT_SUFFIX,
      );
      continue;
    }

    if (upper === 'ON') {
      const a = nextSig(tokens, i);
      const b = a >= 0 ? nextSig(tokens, a) : -1;
      const c = b >= 0 ? nextSig(tokens, b) : -1;
      if (a >= 0 && isWordToken(tokens[a], 'DUPLICATE')
        && b >= 0 && isWordToken(tokens[b], 'KEY')
        && c >= 0 && isWordToken(tokens[c], 'UPDATE')) {
        addIssue(
          'unsupported_upsert',
          token.start,
          'ON DUPLICATE KEY UPDATE 在 SQLite 中应写成 ON CONFLICT ... DO UPDATE，SQL 已原样保留。' + LOCAL_HINT_SUFFIX,
        );
      }
    }
  }

  // ---- 生成结果 ----
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const edited = edits.get(i);
    out += edited === undefined ? tokens[i].text : edited;
  }

  issues.sort((a, b) => (a.at - b.at) || a.code.localeCompare(b.code));

  return { sql: out, issues, changed: out !== source };
}

// ---------------------------------------------------------------------------
// 3) 多语句切分（导入 .sql 用）
// ---------------------------------------------------------------------------

function isCommentOnlyText(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return true;
  return tokens.every((t) => SKIP_TYPES.has(t.type));
}

/**
 * 按分号切分多语句：
 *   - 单引号 / 双引号字符串、反引号标识符、-- / # 行注释、块注释内的分号不切分；
 *   - 每句 trim 后丢弃空语句（以及只含注释的片段，避免导入时执行空 SQL）；
 *   - 其余保留原文（含语句内部的注释与换行）。
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitSqlStatements(sql) {
  const source = String(sql ?? '');
  const out = [];
  const n = source.length;
  let start = 0;
  let i = 0;
  let state = 'normal';
  let quote = '';

  const flush = (end) => {
    const text = source.slice(start, end).trim();
    if (!text) return;
    if (isCommentOnlyText(text)) return;
    out.push(text);
  };

  while (i < n) {
    const ch = source[i];

    if (state === 'normal') {
      if (ch === "'" || ch === '"') {
        state = 'string';
        quote = ch;
        i++;
        continue;
      }
      if (ch === '`') {
        state = 'ident';
        i++;
        continue;
      }
      if (ch === '-' && source[i + 1] === '-') {
        const after = source[i + 2];
        if (after === undefined || isSpaceChar(after) || after === '\u0000') {
          state = 'line';
          i += 2;
          continue;
        }
      }
      if (ch === '#') {
        state = 'line';
        i++;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === ';') {
        flush(i);
        start = i + 1;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === 'string') {
      if (ch === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (source[i + 1] === quote) {
          i += 2;
          continue;
        }
        state = 'normal';
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === 'ident') {
      if (ch === '`') {
        if (source[i + 1] === '`') {
          i += 2;
          continue;
        }
        state = 'normal';
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n' || ch === '\r') state = 'normal';
      i++;
      continue;
    }

    // block
    if (ch === '*' && source[i + 1] === '/') {
      state = 'normal';
      i += 2;
      continue;
    }
    i++;
  }

  flush(n);
  return out;
}

// ---------------------------------------------------------------------------
// 4) 日期解析 / 格式化（统一按宿主本地时区）
// ---------------------------------------------------------------------------

function fmtDate(date) {
  return `${date.getFullYear()}-${PAD2(date.getMonth() + 1)}-${PAD2(date.getDate())}`;
}

function fmtTime(date) {
  return `${PAD2(date.getHours())}:${PAD2(date.getMinutes())}:${PAD2(date.getSeconds())}`;
}

function fmtDateTime(date) {
  return `${fmtDate(date)} ${fmtTime(date)}`;
}

function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000) + 1;
}

function isoWeekInfo(date) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return { week, year: isoYear };
}

/**
 * 解析日期时间字符串（本地时区）。
 * 支持：YYYY-MM-DD、YYYY-MM-DD HH:MM[:SS[.SSS]]、YYYY/MM/DD [HH:MM[:SS]]、
 *       YYYYMMDD、YYYYMMDDHHMM、YYYYMMDDHHMMSS。
 * 解析失败返回 null（UDF 层不要抛错，避免整条 SQL 崩）。
 *
 * @returns {{date:Date, hasTime:boolean}|null}
 */
function parseDateTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { date: value, hasTime: true };
  }
  let s = String(value).trim();
  if (!s) return null;

  if (/^\d{14}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  } else if (/^\d{12}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  } else if (/^\d{8}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,9}))?)?)?$/.exec(s);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number((m[7] + '000').slice(0, 3));

  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, second, ms);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;

  return { date, hasTime: m[4] !== undefined };
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function addMonthsClamped(date, months) {
  const total = date.getFullYear() * 12 + date.getMonth() + months;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(date.getDate(), lastDay);
  return new Date(year, month, day, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function dateShift(value, amount, unit, sign) {
  if (value === null || value === undefined) return null;
  if (amount === null || amount === undefined) return null;
  if (unit === null || unit === undefined) return null;
  const parsed = parseDateTime(value);
  if (!parsed) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const u = String(unit).toLowerCase();
  const k = n * sign;
  let d = new Date(parsed.date.getTime());

  switch (u) {
    case 'second':
      d = new Date(d.getTime() + Math.round(k * 1000));
      break;
    case 'minute':
      d = new Date(d.getTime() + Math.round(k * 60000));
      break;
    case 'hour':
      d = new Date(d.getTime() + Math.round(k * 3600000));
      break;
    case 'day':
      d = addDays(d, Math.trunc(k));
      break;
    case 'week':
      d = addDays(d, Math.trunc(k) * 7);
      break;
    case 'month':
      d = addMonthsClamped(d, Math.trunc(k));
      break;
    case 'quarter':
      d = addMonthsClamped(d, Math.trunc(k) * 3);
      break;
    case 'year':
      d = addMonthsClamped(d, Math.trunc(k) * 12);
      break;
    default:
      return null;
  }

  const timeUnit = u === 'second' || u === 'minute' || u === 'hour';
  return parsed.hasTime || timeUnit ? fmtDateTime(d) : fmtDate(d);
}

function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffix[(v - 20) % 10] || suffix[v] || suffix[0]);
}

/**
 * MySQL DATE_FORMAT 实现。未识别占位符原样输出，并通过 onUnknown 回报。
 * @param {Date} date
 * @param {string} fmt
 * @param {(placeholder:string)=>void} [onUnknown]
 */
function formatDateValue(date, fmt, onUnknown) {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch !== '%') {
      out += ch;
      continue;
    }
    if (i + 1 >= fmt.length) {
      out += '%';
      break;
    }
    const p = fmt[++i];
    switch (p) {
      case 'Y': out += String(date.getFullYear()).padStart(4, '0'); break;
      case 'y': out += PAD2(date.getFullYear() % 100); break;
      case 'm': out += PAD2(date.getMonth() + 1); break;
      case 'c': out += String(date.getMonth() + 1); break;
      case 'd': out += PAD2(date.getDate()); break;
      case 'e': out += String(date.getDate()); break;
      case 'H': out += PAD2(date.getHours()); break;
      case 'k': out += String(date.getHours()); break;
      case 'h':
      case 'I': out += PAD2(date.getHours() % 12 || 12); break;
      case 'l': out += String(date.getHours() % 12 || 12); break;
      case 'i': out += PAD2(date.getMinutes()); break;
      case 's':
      case 'S': out += PAD2(date.getSeconds()); break;
      case 'f': out += String(date.getMilliseconds() * 1000).padStart(6, '0'); break;
      case 'p': out += date.getHours() < 12 ? 'AM' : 'PM'; break;
      case 'W': out += DAY_NAMES[date.getDay()]; break;
      case 'a': out += DAY_ABBR[date.getDay()]; break;
      case 'M': out += MONTH_NAMES[date.getMonth()]; break;
      case 'b': out += MONTH_ABBR[date.getMonth()]; break;
      case 'j': out += PAD3(dayOfYear(date)); break;
      case 'w': out += String(date.getDay()); break;
      case 'u': out += PAD2(Math.floor((dayOfYear(date) + 6 - ((date.getDay() + 6) % 7)) / 7)); break;
      case 'U': out += PAD2(Math.floor((dayOfYear(date) + 6 - date.getDay()) / 7)); break;
      case 'v': out += PAD2(isoWeekInfo(date).week); break;
      case 'V': out += PAD2(Math.max(1, Math.floor((dayOfYear(date) + 6 - date.getDay()) / 7))); break;
      case 'T': out += `${PAD2(date.getHours())}:${PAD2(date.getMinutes())}:${PAD2(date.getSeconds())}`; break;
      case 'r': out += `${PAD2(date.getHours() % 12 || 12)}:${PAD2(date.getMinutes())}:${PAD2(date.getSeconds())} ${date.getHours() < 12 ? 'AM' : 'PM'}`; break;
      case 'D': out += ordinal(date.getDate()); break;
      case 'x': out += String(isoWeekInfo(date).year); break;
      case 'X': {
        const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
        out += String(sunday.getFullYear());
        break;
      }
      case '%': out += '%'; break;
      default:
        out += '%' + p;
        if (typeof onUnknown === 'function') onUnknown(p);
    }
  }
  return out;
}

function monthIndex(name) {
  const s = String(name).toLowerCase();
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (MONTH_NAMES[i].toLowerCase() === s || MONTH_ABBR[i].toLowerCase() === s) return i + 1;
  }
  return -1;
}

/** 把 STR_TO_DATE 的格式串编译成正则；不支持的占位符返回 null。 */
function buildStrToDateRegex(fmt) {
  let src = '^';
  const groups = [];
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '%') {
      if (i + 1 >= fmt.length) return null;
      const p = fmt[++i];
      switch (p) {
        case 'Y': src += '(\\d{4})'; groups.push('year'); break;
        case 'y': src += '(\\d{2})'; groups.push('year2'); break;
        case 'm':
        case 'c': src += '(\\d{1,2})'; groups.push('month'); break;
        case 'd':
        case 'e': src += '(\\d{1,2})'; groups.push('day'); break;
        case 'H':
        case 'k': src += '(\\d{1,2})'; groups.push('hour24'); break;
        case 'h':
        case 'I':
        case 'l': src += '(\\d{1,2})'; groups.push('hour12'); break;
        case 'i': src += '(\\d{1,2})'; groups.push('minute'); break;
        case 's':
        case 'S': src += '(\\d{1,2})'; groups.push('second'); break;
        case 'f': src += '(\\d{1,9})'; groups.push('micro'); break;
        case 'p': src += '([AaPp][Mm])'; groups.push('ampm'); break;
        case 'b': src += '([A-Za-z]{3,})'; groups.push('monthName'); break;
        case 'M': src += '([A-Za-z]+)'; groups.push('monthName'); break;
        case 'a': src += '([A-Za-z]{3,})'; groups.push('dayName'); break;
        case 'W': src += '([A-Za-z]+)'; groups.push('dayName'); break;
        case 'j': src += '(\\d{1,3})'; groups.push('doy'); break;
        case 'T': src += '(\\d{1,2}:\\d{1,2}:\\d{1,2})'; groups.push('timeT'); break;
        case 'r': src += '(\\d{1,2}:\\d{1,2}:\\d{1,2}\\s*[AaPp][Mm])'; groups.push('timeR'); break;
        case '%': src += '%'; break;
        default: return null;
      }
    } else if (/\s/.test(ch)) {
      src += '\\s+';
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  src += '$';
  try {
    return { re: new RegExp(src, 'i'), groups };
  } catch {
    return null;
  }
}

/** MySQL STR_TO_DATE：输出 YYYY-MM-DD[ HH:MM:SS]，解析失败返回 null。 */
function strToDateImpl(str, fmt) {
  const built = buildStrToDateRegex(fmt);
  if (!built) return null;
  const m = built.re.exec(String(str).trim());
  if (!m) return null;

  const parts = {};
  for (let i = 0; i < built.groups.length; i++) parts[built.groups[i]] = m[i + 1];

  let year = null;
  let month = null;
  let day = null;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let ms = 0;

  if (parts.year !== undefined) year = Number(parts.year);
  else if (parts.year2 !== undefined) {
    const y = Number(parts.year2);
    year = y < 70 ? 2000 + y : 1900 + y;
  }

  if (parts.month !== undefined) month = Number(parts.month);
  else if (parts.monthName !== undefined) {
    month = monthIndex(parts.monthName);
    if (month < 0) return null;
  }

  if (parts.day !== undefined) day = Number(parts.day);
  else if (parts.doy !== undefined && year !== null) {
    const doy = Number(parts.doy);
    if (doy < 1 || doy > 366) return null;
    const d = new Date(year, 0, doy);
    if (d.getFullYear() !== year) return null;
    month = d.getMonth() + 1;
    day = d.getDate();
  }

  if (parts.hour24 !== undefined) hour = Number(parts.hour24);
  else if (parts.hour12 !== undefined) {
    hour = Number(parts.hour12) % 12;
    if (parts.ampm && /^pm$/i.test(parts.ampm)) hour += 12;
  }
  if (parts.minute !== undefined) minute = Number(parts.minute);
  if (parts.second !== undefined) second = Number(parts.second);
  if (parts.micro !== undefined) ms = Number((parts.micro + '000').slice(0, 3));

  if (parts.timeT) {
    const [h, mi, s] = parts.timeT.split(':').map(Number);
    hour = h;
    minute = mi;
    second = s;
  }
  if (parts.timeR) {
    const mm = /^(\d{1,2}):(\d{1,2}):(\d{1,2})\s*([AaPp][Mm])$/.exec(parts.timeR);
    if (!mm) return null;
    hour = Number(mm[1]) % 12;
    minute = Number(mm[2]);
    second = Number(mm[3]);
    if (/^pm$/i.test(mm[4])) hour += 12;
  }

  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(year, month - 1, day, hour, minute, second, ms);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;

  const hasTime = built.groups.some((g) => g === 'hour24' || g === 'hour12' || g === 'minute'
    || g === 'second' || g === 'micro' || g === 'ampm' || g === 'timeT' || g === 'timeR');
  return hasTime ? fmtDateTime(date) : fmtDate(date);
}

// ---------------------------------------------------------------------------
// 5) 已知语义差异（先声明，registerMySqlFunctions 会引用）
// ---------------------------------------------------------------------------

/**
 * 本地 SQLite 测试库与真实 MySQL/Doris 的已知差异。
 * 注意：这不是“报表 SQL 写错了”，而是本地执行环境的限制。
 */
export const LOCAL_SQL_CAVEATS = [
  '数值精度：SQLite 没有 DECIMAL 定点类型，DECIMAL/NUMERIC 实际按整数/浮点存储，金额、汇总等运算可能出现二进制浮点误差；MySQL/Doris 的 DECIMAL 是精确计算。',
  '时区：本地库按宿主本地时区解释 DATETIME，NOW()/CURDATE()/UNIX_TIMESTAMP()/DATE_FORMAT() 都走本地时区；真实库可能使用 UTC 或会话时区，结果可能不同。',
  '排序规则：SQLite 默认 BINARY 排序，MySQL 常见 utf8mb4_general_ci / utf8mb4_0900_ai_ci 大小写和重音不敏感；ORDER BY / GROUP BY / DISTINCT / 等值比较的结果可能不同。',
  '|| 语义：MySQL 默认 sql_mode 下 || 是逻辑或，SQLite 是字符串拼接；translateMySqlToSqlite 已把它改写成 OR。若真实库启用了 PIPES_AS_CONCAT，则真实语义是拼接，本地改写反而不同。',
  'IF() 非短路：本地 IF 是 SQLite UDF，SQLite 会先求值全部参数；MySQL IF 只求值命中的分支，含除零、副作用或昂贵子查询的表达式行为可能不同。',
  '正则：REGEXP 用 JS RegExp 模拟（默认大小写不敏感），与 MySQL 8 的 ICU 正则语法、字符类、回溯行为不完全一致；非法 pattern 在本地返回 0 而不是报错。',
  'GROUP_CONCAT：MySQL 默认分隔符是 ","，SQLite 的 group_concat 默认也是 ","，这一点一致；但 SQLite 不支持 GROUP_CONCAT(DISTINCT ... ORDER BY ... SEPARATOR ...) 的完整写法。',
  '日期格式：DATE_FORMAT/STR_TO_DATE 只覆盖常用占位符，%U/%u/%V/%v 周数为近似实现，未识别占位符会原样输出。',
  '整数除法：MySQL 的 / 返回 DECIMAL（5/2=2.5000），SQLite 整数相除得整数（5/2=2）；本地结果可能与真实库不同。',
  '函数覆盖：只实现报表 SQL 常用的 MySQL/Doris 函数；遇到未实现函数时 SQLite 会报 "no such function"，需按提示补充或改在真实库执行。',
  'DDL/类型：SQLite 的类型亲和性与 MySQL 不同（VARCHAR/TINYINT/DATETIME 等按亲和性处理），导入 .sql 建表语句时需要自行调整。',
  'schema 限定表名：Doris/MySQL 的 `db.table` 在本地会被改写成裸表名（SQLite 没有 schema 命名空间、镜像库按裸表名导入），并记 schema_prefix_stripped；改写只影响本地 SQL，真实库执行不受影响。',
  '文本比较：未模拟 MySQL 的 BINARY 强制转换、字符集与排序规则；大小写/重音/尾部空格比较结果可能不同。',
];

// ---------------------------------------------------------------------------
// 6) MySQL/Doris UDF 注册
// ---------------------------------------------------------------------------

function hasBuiltinFunction(db, name) {
  try {
    const row = db.prepare('select count(*) as c from pragma_function_list where name = ? and builtin = 1').get(name);
    return Number(row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 在 DatabaseSync 实例上注册 MySQL/Doris 兼容函数。
 * 函数名统一小写；NULL 参数按 MySQL 语义处理（大多返回 NULL）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{registered:string[], caveats:string[]}}
 */
export function registerMySqlFunctions(db) {
  if (!db || typeof db.function !== 'function') {
    throw new TypeError('registerMySqlFunctions(db) 需要一个 node:sqlite 的 DatabaseSync 实例');
  }

  const registered = [];
  const seen = new Set();
  const caveats = [...LOCAL_SQL_CAVEATS];

  const noteCaveat = (text) => {
    if (!caveats.includes(text)) caveats.push(text);
  };

  const reg = (name, options, fn) => {
    db.function(name, options, fn);
    if (!seen.has(name)) {
      seen.add(name);
      registered.push(name);
    }
  };

  const fn0 = (name, impl, deterministic = true) => reg(name, { deterministic, nArg: 0 }, impl);
  const fn1 = (name, impl) => reg(name, { deterministic: true, nArg: 1 }, impl);
  const fn2 = (name, impl) => reg(name, { deterministic: true, nArg: 2 }, impl);
  const fn3 = (name, impl) => reg(name, { deterministic: true, nArg: 3 }, impl);
  const fnN = (name, impl) => reg(name, { deterministic: true, varargs: true }, impl);

  const noteUnknownFormat = (p) => {
    noteCaveat(`DATE_FORMAT 未识别占位符 %${p}，已原样输出（本地库只覆盖常用占位符）。`);
  };

  // ---- 日期时间 ----
  fn0('now', () => fmtDateTime(new Date()), false);
  fn0('curdate', () => fmtDate(new Date()), false);
  fn0('curtime', () => fmtTime(new Date()), false);

  fn2('date_format', (value, fmt) => {
    if (value === null || value === undefined || fmt === null || fmt === undefined) return null;
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    return formatDateValue(parsed.date, String(fmt), noteUnknownFormat);
  });

  fn2('str_to_date', (value, fmt) => {
    if (value === null || value === undefined || fmt === null || fmt === undefined) return null;
    return strToDateImpl(String(value), String(fmt));
  });

  const fromUnixTime = (sec, fmt) => {
    if (sec === null || sec === undefined) return null;
    const n = Number(sec);
    if (!Number.isFinite(n)) return null;
    const date = new Date(n * 1000);
    if (Number.isNaN(date.getTime())) return null;
    if (fmt === undefined) return fmtDateTime(date);
    return formatDateValue(date, String(fmt), noteUnknownFormat);
  };
  reg('from_unixtime', { deterministic: true, nArg: 1 }, (sec) => fromUnixTime(sec));
  reg('from_unixtime', { deterministic: true, nArg: 2 }, (sec, fmt) => (fmt === null ? null : fromUnixTime(sec, fmt)));

  const unixTimestamp = (value) => {
    if (value === undefined) return Math.floor(Date.now() / 1000);
    if (value === null) return null;
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    return Math.floor(parsed.date.getTime() / 1000);
  };
  reg('unix_timestamp', { deterministic: false, nArg: 0 }, () => unixTimestamp());
  reg('unix_timestamp', { deterministic: true, nArg: 1 }, (value) => unixTimestamp(value));

  fn3('date_add', (value, amount, unit) => dateShift(value, amount, unit, 1));
  fn3('date_sub', (value, amount, unit) => dateShift(value, amount, unit, -1));

  fn2('datediff', (a, b) => {
    const pa = parseDateTime(a);
    const pb = parseDateTime(b);
    if (!pa || !pb) return null;
    const da = Date.UTC(pa.date.getFullYear(), pa.date.getMonth(), pa.date.getDate());
    const dbv = Date.UTC(pb.date.getFullYear(), pb.date.getMonth(), pb.date.getDate());
    return Math.round((da - dbv) / 86400000);
  });

  fn3('timestampdiff', (unit, a, b) => {
    if (unit === null || unit === undefined) return null;
    const u = String(unit).toLowerCase();
    const pa = parseDateTime(a);
    const pb = parseDateTime(b);
    if (!pa || !pb) return null;
    const ms = pb.date.getTime() - pa.date.getTime();
    const monthDiff = () => {
      let months = (pb.date.getFullYear() - pa.date.getFullYear()) * 12 + (pb.date.getMonth() - pa.date.getMonth());
      const key = (d) => d.getDate() * 86400000 + d.getHours() * 3600000
        + d.getMinutes() * 60000 + d.getSeconds() * 1000 + d.getMilliseconds();
      if (key(pb.date) < key(pa.date)) months -= 1;
      return months;
    };
    switch (u) {
      case 'second': return Math.trunc(ms / 1000);
      case 'minute': return Math.trunc(ms / 60000);
      case 'hour': return Math.trunc(ms / 3600000);
      case 'day': return Math.trunc(ms / 86400000);
      case 'week': return Math.trunc(ms / 604800000);
      case 'month': return monthDiff();
      case 'quarter': return Math.trunc(monthDiff() / 3);
      case 'year': return Math.trunc(monthDiff() / 12);
      default: return null;
    }
  });

  fn1('last_day', (value) => {
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    const d = parsed.date;
    return fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  });

  const datePart = (value, getter) => {
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    return getter(parsed.date);
  };
  fn1('year', (v) => datePart(v, (d) => d.getFullYear()));
  fn1('month', (v) => datePart(v, (d) => d.getMonth() + 1));
  fn1('day', (v) => datePart(v, (d) => d.getDate()));
  fn1('hour', (v) => datePart(v, (d) => d.getHours()));
  fn1('minute', (v) => datePart(v, (d) => d.getMinutes()));
  fn1('second', (v) => datePart(v, (d) => d.getSeconds()));
  fn1('weekday', (v) => datePart(v, (d) => (d.getDay() + 6) % 7));
  fn1('dayofweek', (v) => datePart(v, (d) => d.getDay() + 1));
  fn1('dayofmonth', (v) => datePart(v, (d) => d.getDate()));
  fn1('dayofyear', (v) => datePart(v, (d) => dayOfYear(d)));
  fn1('weekofyear', (v) => datePart(v, (d) => isoWeekInfo(d).week));
  fn1('quarter', (v) => datePart(v, (d) => Math.floor(d.getMonth() / 3) + 1));

  fn2('date_trunc', (unit, value) => {
    if (unit === null || unit === undefined) return null;
    const u = String(unit).toLowerCase();
    const parsed = parseDateTime(value);
    if (!parsed) return null;
    const d = parsed.date;
    let r;
    switch (u) {
      case 'year': r = new Date(d.getFullYear(), 0, 1); break;
      case 'quarter': r = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); break;
      case 'month': r = new Date(d.getFullYear(), d.getMonth(), 1); break;
      case 'week': {
        const wd = (d.getDay() + 6) % 7;
        r = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
        break;
      }
      case 'day': r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); break;
      case 'hour': r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()); break;
      case 'minute': r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()); break;
      case 'second': r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()); break;
      default: return null;
    }
    return fmtDateTime(r);
  });

  // ---- 字符串 ----
  fnN('concat', (...args) => {
    for (const a of args) {
      if (a === null || a === undefined) return null;
    }
    return args.map((a) => toText(a)).join('');
  });

  fnN('concat_ws', (sep, ...args) => {
    if (sep === null || sep === undefined) return null;
    const parts = args.filter((a) => a !== null && a !== undefined).map((a) => toText(a));
    return parts.join(toText(sep));
  });

  fn3('substring_index', (str, delim, count) => {
    const s = toText(str);
    const d = toText(delim);
    if (s === null || d === null || count === null || count === undefined) return null;
    const c = Math.trunc(Number(count));
    if (!Number.isFinite(c) || d === '' || c === 0) return '';
    const parts = s.split(d);
    if (c > 0) return parts.slice(0, c).join(d);
    return parts.slice(c).join(d);
  });

  fn2('find_in_set', (needle, list) => {
    const x = toText(needle);
    const hay = toText(list);
    if (x === null || hay === null) return null;
    if (x.includes(',') || hay === '') return 0;
    const idx = hay.split(',').indexOf(x);
    return idx < 0 ? 0 : idx + 1;
  });

  const locateImpl = (sub, str, pos) => {
    const s = toText(sub);
    const t = toText(str);
    if (s === null || t === null) return null;
    let from = 0;
    if (pos !== undefined) {
      if (pos === null) return null;
      const p = Math.trunc(Number(pos));
      if (!Number.isFinite(p) || p < 1) return 0;
      from = p - 1;
    }
    return t.indexOf(s, from) + 1;
  };
  reg('locate', { deterministic: true, nArg: 2 }, (sub, str) => locateImpl(sub, str));
  reg('locate', { deterministic: true, nArg: 3 }, (sub, str, pos) => locateImpl(sub, str, pos));

  const padImpl = (left, str, len, pad) => {
    const s = toText(str);
    const p = toText(pad);
    if (s === null || p === null || len === null || len === undefined) return null;
    const n = Math.trunc(Number(len));
    if (!Number.isFinite(n) || n <= 0) return '';
    const chars = Array.from(s);
    if (chars.length >= n) return chars.slice(0, n).join('');
    if (p === '') return '';
    const padChars = Array.from(p);
    const need = n - chars.length;
    const fill = [];
    for (let i = 0; fill.length < need; i++) fill.push(padChars[i % padChars.length]);
    return left ? fill.join('') + s : s + fill.join('');
  };
  fn3('lpad', (str, len, pad) => padImpl(true, str, len, pad));
  fn3('rpad', (str, len, pad) => padImpl(false, str, len, pad));

  fn2('repeat', (str, count) => {
    const s = toText(str);
    if (s === null || count === null || count === undefined) return null;
    const n = Math.trunc(Number(count));
    if (!Number.isFinite(n) || n <= 0) return '';
    return s.repeat(n);
  });

  fn1('reverse', (str) => {
    const s = toText(str);
    if (s === null) return null;
    return Array.from(s).reverse().join('');
  });

  fn1('char_length', (str) => {
    const s = toText(str);
    if (s === null) return null;
    return Array.from(s).length;
  });
  fn1('character_length', (str) => {
    const s = toText(str);
    if (s === null) return null;
    return Array.from(s).length;
  });

  const midImpl = (str, pos, len) => {
    const s = toText(str);
    if (s === null || pos === null || pos === undefined) return null;
    const chars = Array.from(s);
    let p = Math.trunc(Number(pos));
    if (!Number.isFinite(p) || p === 0) return '';
    if (p < 0) p = chars.length + p + 1;
    if (p < 1) return '';
    const start = p - 1;
    if (len === undefined) return chars.slice(start).join('');
    if (len === null) return null;
    const n = Math.trunc(Number(len));
    if (!Number.isFinite(n) || n <= 0) return '';
    return chars.slice(start, start + n).join('');
  };
  reg('mid', { deterministic: true, nArg: 2 }, (str, pos) => midImpl(str, pos));
  reg('mid', { deterministic: true, nArg: 3 }, (str, pos, len) => midImpl(str, pos, len));

  const takeChars = (str, n, fromLeft) => {
    const s = toText(str);
    if (s === null || n === null || n === undefined) return null;
    const k = Math.trunc(Number(n));
    if (!Number.isFinite(k) || k <= 0) return '';
    const chars = Array.from(s);
    return fromLeft ? chars.slice(0, k).join('') : chars.slice(-k).join('');
  };
  fn2('left', (str, n) => takeChars(str, n, true));
  fn2('right', (str, n) => takeChars(str, n, false));

  fn1('hex', (value) => {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex').toUpperCase();
    if (typeof value === 'bigint') return BigInt.asUintN(64, value).toString(16).toUpperCase();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return BigInt.asUintN(64, BigInt(Math.trunc(value))).toString(16).toUpperCase();
    }
    return Buffer.from(String(value), 'utf8').toString('hex').toUpperCase();
  });

  fn1('unhex', (value) => {
    const s = toText(value);
    if (s === null) return null;
    const t = s.trim();
    if (t.length % 2 !== 0 || /[^0-9a-fA-F]/.test(t)) return null;
    return Buffer.from(t, 'hex').toString('utf8');
  });

  fn1('md5', (value) => {
    const s = toText(value);
    if (s === null) return null;
    return createHash('md5').update(s, 'utf8').digest('hex');
  });

  // ---- 条件 / 数学 ----
  fn3('if', (cond, a, b) => (mysqlTruthy(cond) ? a : b));

  fn0('rand', () => Math.random(), false);

  fn2('truncate', (value, decimals) => {
    if (value === null || value === undefined || decimals === null || decimals === undefined) return null;
    const x = Number(value);
    const d = Math.trunc(Number(decimals));
    if (!Number.isFinite(x) || !Number.isFinite(d)) return null;
    const factor = Math.pow(10, d);
    return Math.trunc(x * factor) / factor;
  });

  fn2('mod', (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
    return x % y;
  });

  // power/pow：SQLite 编译了 math 函数时已有内置实现，不覆盖
  const powerImpl = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return null;
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return Math.pow(x, y);
  };
  if (!hasBuiltinFunction(db, 'power')) fn2('power', powerImpl);
  if (!hasBuiltinFunction(db, 'pow')) fn2('pow', powerImpl);

  // ---- JSON / 正则 ----
  fn1('json_unquote', (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    const s = String(value);
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s;
  });

  fn2('regexp', (pattern, value) => {
    if (pattern === null || pattern === undefined || value === null || value === undefined) return null;
    const p = String(pattern);
    try {
      return new RegExp(p, 'i').test(String(value)) ? 1 : 0;
    } catch {
      noteCaveat('REGEXP 收到非法 pattern，已返回 0（MySQL 会直接报错）。');
      return 0;
    }
  });

  return { registered, caveats };
}
