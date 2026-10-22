const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// 表格理解：把 xlsx / csv 变成模型能算得清的形状。
//
// xlsx 本质是个 zip，里面是几份 XML。这里手工解包，不引第三方库——
// 一个只在本机跑的应用没必要为读表格背上一整个依赖树。
//
// 关键取舍：不把整张表原样倒给模型。几千行倒进去既超预算又没法算，
// 所以给的是「表头 + 前若干行 + 每列的统计」，让它先看懂结构再回答。

const MAX_ROWS = 400;
const MAX_COLUMNS = 40;
const MAX_CELL_CHARACTERS = 200;
const PREVIEW_ROWS = 12;

// ── 最小 zip 解包 ──────────────────────────────────────────
// 只认 store(0) 和 deflate(8) 两种压缩方式，xlsx 用的就是这两种。
function readZipEntries(buffer) {
  const entries = new Map();
  // 从尾部找中央目录结束记录，再顺着它读中央目录，比从头猜本地头可靠。
  let endOffset = -1;
  for (let index = buffer.length - 22; index >= 0 && index > buffer.length - 66_000; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) throw new Error("这不是一个有效的 zip（xlsx）文件");

  const count = buffer.readUInt16LE(endOffset + 10);
  let pointer = buffer.readUInt32LE(endOffset + 16);

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch {
      // 单个条目解不开就跳过，别让整份文件读不了。
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = itemPattern.exec(xml))) {
    // 一个单元格的文字可能被拆成好几段 <t>，要拼起来。
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXmlText(part[1]));
    strings.push(parts.join(""));
  }
  return strings;
}

function columnToIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] || "A";
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(xml)) && rows.length < MAX_ROWS) {
    const cells = [];
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      const attributes = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const reference = attributes.match(/r="([A-Z]+\d+)"/)?.[1] || "";
      const type = attributes.match(/t="([^"]+)"/)?.[1] || "";
      let value = "";
      if (type === "s") {
        const shared = Number.parseInt(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "", 10);
        value = Number.isInteger(shared) ? (sharedStrings[shared] ?? "") : "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXmlText(part[1])).join("");
      } else {
        value = decodeXmlText(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
      }
      const at = reference ? columnToIndex(reference) : cells.length;
      if (at < MAX_COLUMNS) cells[at] = String(value).slice(0, MAX_CELL_CHARACTERS);
    }
    for (let index = 0; index < cells.length; index += 1) if (cells[index] === undefined) cells[index] = "";
    if (cells.some((cell) => cell !== "")) rows.push(cells);
  }
  return rows;
}

function workbookSheetOrder(workbookXml, relationshipsXml, entryNames) {
  const relationships = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    const id = attributes.match(/\bId="([^"]+)"/)?.[1];
    const target = attributes.match(/\bTarget="([^"]+)"/)?.[1];
    if (!id || !target) continue;
    const normalized = target.startsWith("/")
      ? path.posix.normalize(target.slice(1))
      : target.startsWith("xl/")
        ? path.posix.normalize(target)
        : path.posix.normalize(path.posix.join("xl", target));
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(normalized)) relationships.set(id, normalized);
  }

  const ordered = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const attributes = match[1];
    const name = decodeXmlText(attributes.match(/\bname="([^"]*)"/)?.[1] || "");
    const relationId = attributes.match(/(?:\br:id|\bid)="([^"]+)"/)?.[1];
    const target = relationId ? relationships.get(relationId) : undefined;
    if (target && entryNames.has(target)) ordered.push({ name, target });
  }
  if (ordered.length) return ordered;

  // 极早或者不完整的工作簿可能没有 relationships。退路仍按数字排，
  // 不能用字典序：那会把 sheet10 排到 sheet2 前面。
  const fallbackNames = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)]
    .map((match) => decodeXmlText(match[1].match(/\bname="([^"]*)"/)?.[1] || ""));
  return [...entryNames]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => {
      const a = Number(left.match(/sheet(\d+)\.xml$/)?.[1]);
      const b = Number(right.match(/sheet(\d+)\.xml$/)?.[1]);
      return a - b;
    })
    .map((target, index) => ({ name: fallbackNames[index] || `Sheet${index + 1}`, target }));
}

function readWorkbook(filePath) {
  const entries = readZipEntries(fs.readFileSync(filePath));
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8") || "";
  const relationshipsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";

  const sheets = [];
  const sheetOrder = workbookSheetOrder(workbookXml, relationshipsXml, new Set(entries.keys()));
  for (const [index, sheet] of sheetOrder.entries()) {
    const rows = parseSheet(entries.get(sheet.target).toString("utf8"), shared);
    if (rows.length) sheets.push({ name: sheet.name || `Sheet${index + 1}`, rows });
  }
  if (!sheets.length) throw new Error("这个表格里没有读到内容");
  return sheets;
}

// ── CSV ────────────────────────────────────────────────────
function parseDelimited(text, delimiter = ",") {
  if (delimiter !== "," && delimiter !== "\t") throw new TypeError("分隔符无效");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell.slice(0, MAX_CELL_CHARACTERS));
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.slice(0, MAX_CELL_CHARACTERS));
      if (row.some((item) => item !== "")) rows.push(row.slice(0, MAX_COLUMNS));
      row = [];
      cell = "";
      if (rows.length >= MAX_ROWS) return rows;
    } else {
      cell += character;
    }
  }
  row.push(cell.slice(0, MAX_CELL_CHARACTERS));
  if (row.some((item) => item !== "")) rows.push(row.slice(0, MAX_COLUMNS));
  return rows;
}

function parseCsv(text) {
  return parseDelimited(text, ",");
}

function parseTsv(text) {
  return parseDelimited(text, "\t");
}

// ── 摘要 ───────────────────────────────────────────────────
function summarizeColumn(header, values) {
  const filled = values.filter((value) => value !== "" && value !== undefined);
  const numbers = filled.map((value) => Number(String(value).replace(/[,，\s%￥$]/g, ""))).filter(Number.isFinite);
  const looksNumeric = filled.length > 0 && numbers.length / filled.length >= 0.8;

  if (looksNumeric && numbers.length) {
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const sorted = [...numbers].sort((a, b) => a - b);
    return `${header}：数字列，${numbers.length} 个值，最小 ${sorted[0]}，最大 ${sorted.at(-1)}，`
      + `合计 ${Number(total.toFixed(4))}，平均 ${Number((total / numbers.length).toFixed(4))}`;
  }

  const unique = [...new Set(filled.map((value) => String(value)))];
  const sample = unique.slice(0, 5).join("、");
  return `${header}：文本列，${filled.length} 个值，${unique.length} 种取值${sample ? `，例如 ${sample}` : ""}`
    + `${filled.length < values.length ? `，另有 ${values.length - filled.length} 个空` : ""}`;
}

function describeTable(name, rows) {
  if (!rows.length) return "";
  const header = rows[0].map((cell, index) => (cell || `第${index + 1}列`));
  const body = rows.slice(1);
  const columns = header.map((_, index) => body.map((row) => row[index] ?? ""));

  const preview = [header, ...body.slice(0, PREVIEW_ROWS)]
    .map((row) => row.map((cell) => String(cell ?? "")).join(" | "))
    .join("\n");

  return [
    `【${name}】共 ${body.length} 行 × ${header.length} 列${body.length > PREVIEW_ROWS ? `（下面只列前 ${PREVIEW_ROWS} 行）` : ""}`,
    preview,
    "",
    "每列的情况：",
    ...header.map((title, index) => `- ${summarizeColumn(title, columns[index])}`),
  ].join("\n");
}

function readTable(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    const sheets = readWorkbook(filePath);
    return {
      kind: "xlsx",
      sheets: sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows })),
    };
  }
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    const raw = fs.readFileSync(filePath, "utf8");
    const rows = lower.endsWith(".tsv") ? parseTsv(raw) : parseCsv(raw);
    if (!rows.length) throw new Error("这个表格里没有读到内容");
    return { kind: "csv", sheets: [{ name: "表格", rows }] };
  }
  throw new Error("只支持 xlsx、xlsm、csv 和 tsv");
}

function formatTableContext(table, fileName) {
  const blocks = table.sheets.map((sheet) => describeTable(sheet.name, sheet.rows)).filter(Boolean);
  return [
    `[本机表格：${fileName}]`,
    "",
    blocks.join("\n\n"),
    "",
    "以上是在这台电脑上从表格里读出来的。行数多的表只给了前几行和每列统计，",
    "要算总数或找极值请用上面的统计，不要凭前几行猜整张表。",
  ].join("\n");
}

module.exports = {
  MAX_ROWS,
  PREVIEW_ROWS,
  describeTable,
  formatTableContext,
  parseCsv,
  parseTsv,
  parseSharedStrings,
  readTable,
  readWorkbook,
  readZipEntries,
  summarizeColumn,
  workbookSheetOrder,
};
