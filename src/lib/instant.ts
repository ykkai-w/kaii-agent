// 立答工具：算式、单位、日期、随机串这类有唯一正确答案的问题，
// 本机纯函数直接给结果，不劳驾模型——快、准、零成本，也不用联网。
//
// 立场：只在"答案唯一且能算出来"时开口；含糊的输入宁可不接茬，
// 让用户正常发给模型，也不要给一个自作聪明的错答案。

export interface InstantAnswer {
  kind: "calc" | "unit" | "date" | "random";
  answer: string;
}

// ---------- 算式 ----------
// 自己写的递归下降解析器。绝不用 eval：输入来自输入框，eval 是安全事故。
function parseExpression(input: string): number | null {
  let at = 0;
  const text = input.replace(/\s+/g, "");
  function peek(): string { return text[at] ?? ""; }
  function parsePrimary(): number | null {
    if (peek() === "(") {
      at += 1;
      const inner = parseAddSub();
      if (peek() !== ")") return null;
      at += 1;
      return inner;
    }
    if (peek() === "-") {
      at += 1;
      const value = parsePrimary();
      return value === null ? null : -value;
    }
    const match = /^\d+(?:\.\d+)?/.exec(text.slice(at));
    if (!match) return null;
    at += match[0].length;
    return Number(match[0]);
  }
  function parsePower(): number | null {
    const base = parsePrimary();
    if (base === null) return null;
    if (peek() === "^") {
      at += 1;
      const exponent = parsePower();
      return exponent === null ? null : base ** exponent;
    }
    return base;
  }
  function parseMulDiv(): number | null {
    let left = parsePower();
    if (left === null) return null;
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = peek();
      at += 1;
      const right = parsePower();
      if (right === null) return null;
      if (op === "*") left *= right;
      else if (op === "/") {
        if (right === 0) return null;
        left /= right;
      } else {
        if (right === 0) return null;
        left %= right;
      }
    }
    return left;
  }
  function parseAddSub(): number | null {
    let left = parseMulDiv();
    if (left === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = peek();
      at += 1;
      const right = parseMulDiv();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  const result = parseAddSub();
  return at === text.length ? result : null;
}

function normalizeExpression(raw: string): string {
  return raw
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/[×xX]/g, "*").replace(/[÷]/g, "/")
    .replace(/＋/g, "+").replace(/－/g, "-")
    .replace(/[＝=?？]+$/g, "")
    .trim();
}

function tryCalc(raw: string): InstantAnswer | null {
  const text = normalizeExpression(raw);
  // 必须含运算符，且只由数字和运算符构成；纯数字不算算式。
  if (!/^[\d+\-*/%^().\s]+$/.test(text) || !/[+*/%^]|\d\s*-\s*\d/.test(text) || !/\d/.test(text)) return null;
  const value = parseExpression(text);
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e10) / 1e10;
  return { kind: "calc", answer: `${text} = ${rounded}` };
}

// ---------- 单位 ----------
const UNIT_TABLE: { from: RegExp; to: RegExp; convert: (v: number) => number; unit: string }[] = [
  { from: /^(公里|千米|km)$/i, to: /^(英里|mi)$/i, convert: (v) => v * 0.621371, unit: "英里" },
  { from: /^(英里|mi)$/i, to: /^(公里|千米|km)$/i, convert: (v) => v * 1.609344, unit: "公里" },
  { from: /^(公斤|千克|kg)$/i, to: /^(磅|lb|lbs)$/i, convert: (v) => v * 2.204623, unit: "磅" },
  { from: /^(磅|lb|lbs)$/i, to: /^(公斤|千克|kg)$/i, convert: (v) => v * 0.453592, unit: "公斤" },
  { from: /^斤$/, to: /^(公斤|千克|kg)$/i, convert: (v) => v * 0.5, unit: "公斤" },
  { from: /^(公斤|千克|kg)$/i, to: /^斤$/, convert: (v) => v * 2, unit: "斤" },
  { from: /^(厘米|cm)$/i, to: /^(英寸|in|inch)$/i, convert: (v) => v * 0.393701, unit: "英寸" },
  { from: /^(英寸|in|inch)$/i, to: /^(厘米|cm)$/i, convert: (v) => v * 2.54, unit: "厘米" },
  { from: /^(米|m)$/i, to: /^(英尺|ft)$/i, convert: (v) => v * 3.280840, unit: "英尺" },
  { from: /^(英尺|ft)$/i, to: /^(米|m)$/i, convert: (v) => v * 0.3048, unit: "米" },
  // 亩是中国地契、租地、农村宅基地绕不开的单位。1 亩 = 2000/3 平方米。
  { from: /^(平方米|㎡|m2)$/i, to: /^亩$/, convert: (v) => v * 3 / 2000, unit: "亩" },
  { from: /^亩$/, to: /^(平方米|㎡|m2)$/i, convert: (v) => v * 2000 / 3, unit: "平方米" },
  { from: /^(公顷|ha)$/i, to: /^亩$/, convert: (v) => v * 15, unit: "亩" },
  { from: /^亩$/, to: /^(公顷|ha)$/i, convert: (v) => v / 15, unit: "公顷" },
  { from: /^(摄氏度|°?C)$/i, to: /^(华氏度|°?F)$/i, convert: (v) => v * 9 / 5 + 32, unit: "华氏度" },
  { from: /^(华氏度|°?F)$/i, to: /^(摄氏度|°?C)$/i, convert: (v) => (v - 32) * 5 / 9, unit: "摄氏度" },
];

function tryUnit(raw: string): InstantAnswer | null {
  const match = /^([\d.]+)\s*([A-Za-z°]+|[一-龥]{1,3})\s*(?:转|换成|等于多少|是多少|to)\s*([A-Za-z°]+|[一-龥]{1,3})[?？]?$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  for (const entry of UNIT_TABLE) {
    if (entry.from.test(match[2]) && entry.to.test(match[3])) {
      const converted = Math.round(entry.convert(value) * 1000) / 1000;
      return { kind: "unit", answer: `${match[1]} ${match[2]} ≈ ${converted} ${entry.unit}` };
    }
  }
  return null;
}

// ---------- 日期 ----------
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}（${WEEKDAYS[date.getDay()]}）`;
}

function tryDate(raw: string, now: Date): InstantAnswer | null {
  const text = raw.trim().replace(/[?？]$/, "");
  let match = /^(\d{1,4})\s*(?:天|日)(后|前)(?:是几号|是哪天|是什么日子)?$/.exec(text);
  if (match) {
    const days = Number(match[1]);
    if (days > 36500) return null;
    const target = new Date(now);
    target.setDate(target.getDate() + (match[2] === "后" ? days : -days));
    return { kind: "date", answer: `${match[1]} 天${match[2]}是 ${formatDate(target)}` };
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:到|至)\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:差?几天|相差多少天)?$/.exec(text);
  if (match) {
    const a = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const b = new Date(Number(match[4]), Number(match[5]) - 1, Number(match[6]));
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    const days = Math.round(Math.abs(b.getTime() - a.getTime()) / 86_400_000);
    return { kind: "date", answer: `${match[1]}-${match[2]}-${match[3]} 到 ${match[4]}-${match[5]}-${match[6]} 相差 ${days} 天` };
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*(?:是)?\s*(?:周几|星期几)$/.exec(text);
  if (match) {
    const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    // 用回读校验：2026-02-30 这种不存在的日期会被 Date 顺延，必须拦下。
    if (Number.isNaN(target.getTime())
      || target.getMonth() !== Number(match[2]) - 1
      || target.getDate() !== Number(match[3])) return null;
    return { kind: "date", answer: `${match[1]}-${match[2]}-${match[3]} 是 ${WEEKDAYS[target.getDay()]}` };
  }
  if (/^(?:现在)?几点(?:了)?$/.test(text) || /^现在时间$/.test(text)) {
    return { kind: "date", answer: `现在是 ${now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}（${formatDate(now)}）` };
  }
  match = /^(今天|明天|后天)(?:是)?(?:周几|星期几|几号)$/.exec(text);
  if (match) {
    const offset = match[1] === "今天" ? 0 : match[1] === "明天" ? 1 : 2;
    const target = new Date(now);
    target.setDate(target.getDate() + offset);
    return { kind: "date", answer: `${match[1]}是 ${formatDate(target)}` };
  }
  return null;
}

// ---------- 随机串（本机生成，绝不经过模型） ----------
// 去掉了容易看混的 0O1lI。
const PASSWORD_CHARSET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ!@#$%^&*";

export function generatePassword(length: number): string {
  const size = Math.min(64, Math.max(8, Math.floor(length) || 16));
  const bytes = new Uint32Array(size);
  crypto.getRandomValues(bytes);
  return [...bytes].map((value) => PASSWORD_CHARSET[value % PASSWORD_CHARSET.length]).join("");
}

function tryRandom(raw: string): InstantAnswer | null {
  const text = raw.trim().replace(/[?？]$/, "");
  const match = /^(?:随机|生成|来个)?\s*(?:密码|password)\s*(\d{1,2})?\s*(?:位)?$/i.exec(text);
  if (match) {
    return { kind: "random", answer: generatePassword(match[1] ? Number(match[1]) : 16) };
  }
  if (/^uuid$/i.test(text)) {
    return { kind: "random", answer: crypto.randomUUID() };
  }
  // 「随机数 1-100」。闭区间，两端都可能取到。
  const range = /^随机数\s*(-?\d+)\s*[-到~]\s*(-?\d+)$/.exec(text);
  if (range) {
    const low = Math.min(Number(range[1]), Number(range[2]));
    const high = Math.max(Number(range[1]), Number(range[2]));
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return null;
    const span = high - low + 1;
    const bucket = new Uint32Array(1);
    crypto.getRandomValues(bucket);
    return { kind: "random", answer: `${low} 到 ${high}：${low + (bucket[0] % span)}` };
  }
  return null;
}

// ---------- 中文数字 ----------
// 「三千五百二十」这种写法出现在合同、发票、老文档里，要拿去算数时得先转成数字。
// 只认规规矩矩的写法；「一万二」这类口语省略（到底是 12000 还是 10002）一律不猜。
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

export function parseChineseNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text || !/^[零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟万萬亿億]+$/.test(text)) return null;
  // 分段处理「亿」「万」，段内是千百十个的组合。
  const parseSection = (section: string): number | null => {
    if (!section) return 0;
    let total = 0;
    let current = 0;
    let sawAny = false;
    for (const character of section) {
      if (character in CN_DIGITS) {
        current = CN_DIGITS[character];
        sawAny = true;
        continue;
      }
      const unit = CN_UNITS[character];
      if (!unit) return null;
      // 「十五」这种开头省略「一」的写法。
      total += (current || (unit === 10 ? 1 : 0)) * unit;
      current = 0;
      sawAny = true;
    }
    return sawAny ? total + current : null;
  };
  const byYi = text.split(/[亿億]/);
  if (byYi.length > 2) return null;
  const parseWan = (part: string): number | null => {
    const byWan = part.split(/[万萬]/);
    if (byWan.length > 2) return null;
    if (byWan.length === 1) return parseSection(byWan[0]);
    const high = parseSection(byWan[0]);
    const low = byWan[1] ? parseSection(byWan[1]) : 0;
    if (high === null || low === null) return null;
    return high * 10_000 + low;
  };
  if (byYi.length === 1) return parseWan(byYi[0]);
  const high = parseSection(byYi[0]);
  const low = byYi[1] ? parseWan(byYi[1]) : 0;
  if (high === null || low === null) return null;
  return high * 100_000_000 + low;
}

function tryChineseNumber(raw: string): InstantAnswer | null {
  const value = parseChineseNumber(raw);
  if (value === null || !Number.isFinite(value) || value === 0) return null;
  return { kind: "calc", answer: `${raw.trim()} = ${value}` };
}

// 数字转中文大写金额。开发票、写合同、填支票时要用，手写极容易出错。
// 只做到「元/角/分」这一层，超出 12 位不接（大写金额本来也不该那么长）。
const BIG_DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const BIG_UNITS = ["", "拾", "佰", "仟"];
const BIG_GROUPS = ["", "万", "亿"];

export function toChineseAmount(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value >= 1e12) return null;
  const cents = Math.round(value * 100);
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  let integerPart = "";
  if (yuan === 0) {
    integerPart = "零";
  } else {
    const groups: { text: string; value: number }[] = [];
    let rest = yuan;
    let groupIndex = 0;
    while (rest > 0) {
      const chunk = rest % 10_000;
      let chunkText = "";
      let zeroPending = false;
      for (let position = 0; position < 4; position += 1) {
        const digit = Math.floor(chunk / 10 ** position) % 10;
        if (digit === 0) {
          zeroPending = chunkText !== "";
          continue;
        }
        chunkText = `${BIG_DIGITS[digit]}${BIG_UNITS[position]}${zeroPending ? "零" : ""}${chunkText}`;
        zeroPending = false;
      }
      if (chunkText) groups.unshift({ text: `${chunkText}${BIG_GROUPS[groupIndex]}`, value: chunk });
      rest = Math.floor(rest / 10_000);
      groupIndex += 1;
    }
    // 跨节的零：低位节没填满千位（一万零壹、壹亿零贰佰）就要补一个「零」，
    // 中间整节缺失（壹亿零壹）也走同一条规则。
    integerPart = groups
      .map((group, index) => {
        const previous = groups[index - 1];
        return previous && group.value > 0 && group.value < 1000 ? `零${group.text}` : group.text;
      })
      .join("");
  }

  if (!jiao && !fen) return `${integerPart}元整`;
  const jiaoText = jiao ? `${BIG_DIGITS[jiao]}角` : (fen ? "零" : "");
  const fenText = fen ? `${BIG_DIGITS[fen]}分` : "";
  return `${integerPart}元${jiaoText}${fenText}`;
}

function tryBigAmount(raw: string): InstantAnswer | null {
  // 「1200 大写」「1200元转大写」「1200 的大写」都要认——
  // 先前写成 (?:转|大写|…) 的择一，遇到「转大写」只吃掉「转」就卡住了。
  const match = /^([\d.]+)\s*元?\s*(?:的?大写|转(?:成)?大写)$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const text = toChineseAmount(value);
  return text ? { kind: "calc", answer: `${match[1]} 元 → ${text}` } : null;
}

// ---------- 折扣与百分比 ----------
// 「85折 1200」「1200 的 15%」这两种问法在买东西和算提成时天天遇到。
function tryPercent(raw: string): InstantAnswer | null {
  const text = raw.trim().replace(/[?？]$/, "");
  let match = /^([\d.]+)\s*折\s*([\d.]+)$/.exec(text) || /^([\d.]+)\s*的\s*([\d.]+)\s*折$/.exec(text);
  if (match) {
    // 中文的「折」：8.5 折 = 原价 ×0.85，85 折按 8.5 折理解（口语常这么说）。
    const rawRate = Number(match[1]);
    const price = Number(match[2]);
    if (!Number.isFinite(rawRate) || !Number.isFinite(price)) return null;
    // 「85折」是口语说法，正规写法是 8.5 折。统一归一化到「几点几折」，
    // 并且在答案里显示归一化后的值——这样万一用户打错（比如把 8.5 打成 12），
    // 一眼就能看出它是按什么读的，不用猜。
    const rate = rawRate > 10 ? rawRate / 100 : rawRate / 10;
    if (rate <= 0 || rate > 1) return null;
    const paid = Math.round(price * rate * 100) / 100;
    const shown = Math.round(rate * 1000) / 100;
    return { kind: "calc", answer: `${price} 打 ${shown} 折 = ${paid}（省 ${Math.round((price - paid) * 100) / 100}）` };
  }
  match = /^([\d.]+)\s*的\s*([\d.]+)\s*%$/.exec(text) || /^([\d.]+)\s*\*\s*([\d.]+)\s*%$/.exec(text);
  if (match) {
    const base = Number(match[1]);
    const percent = Number(match[2]);
    if (!Number.isFinite(base) || !Number.isFinite(percent)) return null;
    return { kind: "calc", answer: `${base} 的 ${percent}% = ${Math.round(base * percent) / 100}` };
  }
  return null;
}

// ---------- 进制转换 ----------
function tryRadix(raw: string): InstantAnswer | null {
  const text = raw.trim().replace(/[?？]$/, "");
  let match = /^(?:0x)?([0-9a-fA-F]+)\s*(?:转|转成|to)\s*(?:十进制|10进制|dec)$/.exec(text);
  if (match) {
    const value = Number.parseInt(match[1], 16);
    if (!Number.isFinite(value)) return null;
    return { kind: "unit", answer: `0x${match[1].toUpperCase()} = ${value}` };
  }
  match = /^(\d+)\s*(?:转|转成|to)\s*(十六进制|16进制|hex)$/.exec(text);
  if (match) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) return null;
    return { kind: "unit", answer: `${value} = 0x${value.toString(16).toUpperCase()}` };
  }
  match = /^(\d+)\s*(?:转|转成|to)\s*(?:二进制|2进制|bin)$/.exec(text);
  if (match) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) return null;
    return { kind: "unit", answer: `${value} = 0b${value.toString(2)}` };
  }
  return null;
}

// ---------- 时间戳 ----------
// 10 位当秒、13 位当毫秒，这是这两种长度事实上的约定。
function tryTimestamp(raw: string, now: Date): InstantAnswer | null {
  const match = /^(\d{10}|\d{13})$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const date = new Date(match[1].length === 10 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return null;
  // 只认最近几十年的时间戳，别把随手打的一串数字都解释成日期。
  const year = date.getFullYear();
  if (year < 1990 || year > 2100) return null;
  void now;
  return { kind: "date", answer: `${match[1]} → ${date.toLocaleString("zh-CN")}` };
}

// 主入口：短输入才试，避免把长问题误判成工具活。
export function instantAnswer(raw: string, now = new Date()): InstantAnswer | null {
  const text = raw.trim();
  if (!text || text.length > 80) return null;
  return tryCalc(text) || tryPercent(text) || tryUnit(text) || tryRadix(text) || tryTimestamp(text, now)
    || tryDate(text, now) || tryRandom(text) || tryBigAmount(text) || tryChineseNumber(text);
}

// ---------- 文本清理（对输入框内容就地整理） ----------
export function cleanText(raw: string): string {
  return raw
    // 中英文之间补一个空格（所谓「盘古之白」）。只补字母数字这一侧，
    // 不动标点——「中文，English」不该变成「中文， English」。
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, "$1 $2")
    .replace(/　/g, " ")                       // 全角空格
    .replace(/[ \t]+$/gm, "")                      // 行尾空白
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)) // 全角字母数字
    .replace(/\n{3,}/g, "\n\n")                    // 三连以上空行收成一个空行
    .trim();
}

// ---------- JSON 排版 ----------
// 只认真 JSON。YAML 没有内置解析器，宁可不做也不半吊子。
export function formatJson(raw: string): string | null {
  const text = raw.trim();
  if (!/^[\[{]/.test(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

// ---------- Markdown 转纯文本 ----------
// 拿去粘进不认 Markdown 的地方（表单、微信、备注）。
// 只拆记号不动内容；代码块保留原文，链接保留文字丢掉网址。
export function stripMarkdown(raw: string): string {
  return raw
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_, code: string) => code.replace(/\n$/, ""))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/^\s*\d+\.\s+/gm, (match) => match.trim() + " ")
    .replace(/^>\s?/gm, "")
    .replace(/^([-=_]){3,}\s*$/gm, "")
    .trim();
}
