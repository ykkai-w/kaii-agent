// 写作画布：把一段回答变成可以直接编辑的文档，选中某一段让模型就地改写。
//
// 和聊天最大的区别是"就地替换"：模型只需要吐出改好的那一段，
// 不需要重复整篇，也不需要解释。所以提示写得比聊天更紧。

const MAX_DOCUMENT_CHARACTERS = 60_000;
const MAX_SELECTION_CHARACTERS = 8000;
const CONTEXT_WINDOW = 600;

const ACTIONS = Object.freeze({
  rewrite: Object.freeze({
    id: "rewrite",
    label: "改写",
    hint: "换一种说法，意思不变",
    instruction: "把选中的这一段改写得更清楚、更自然。保持原意、原语言和大致长度。",
  }),
  expand: Object.freeze({
    id: "expand",
    label: "扩写",
    hint: "补细节和依据",
    instruction: "把选中的这一段展开写，补上必要的细节、依据或例子。不要编造事实；不确定的地方宁可不写。",
  }),
  shorten: Object.freeze({
    id: "shorten",
    label: "精简",
    hint: "砍到只剩要点",
    instruction: "把选中的这一段压短，只留关键信息。数字、时间、人名这类具体内容不能丢。",
  }),
  formal: Object.freeze({
    id: "formal",
    label: "更正式",
    hint: "书面、可以直接发出去",
    instruction: "把选中的这一段改成正式书面语气。保持原意，不要添加原文没有的承诺或事实。",
  }),
  plain: Object.freeze({
    id: "plain",
    label: "说人话",
    hint: "去术语，讲明白",
    instruction: "把选中的这一段改写得更口语、更好懂，去掉不必要的术语和长句。保持原意。",
  }),
  continue: Object.freeze({
    id: "continue",
    label: "接着写",
    hint: "从选中处往下续",
    instruction: "从选中这一段的结尾接着往下写一到两段。沿着已有的思路和语气，不要另起炉灶，不要复述已写的内容。",
  }),
  fix: Object.freeze({
    id: "fix",
    label: "改错字",
    hint: "只动错别字和标点",
    instruction: "只修正选中这一段里的错别字、标点和明显的语法问题。除此之外一个字都不要改，不要润色，不要调整语序。",
  }),
});

function listActions() {
  return Object.values(ACTIONS).map(({ id, label, hint }) => ({ id, label, hint }));
}

function validateActionId(value) {
  if (typeof value !== "string" || !Object.hasOwn(ACTIONS, value)) throw new TypeError("画布动作无效");
  return value;
}

function validateDocument(text) {
  if (typeof text !== "string") throw new TypeError("文档必须是文字");
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new RangeError("文档过长");
  return text;
}

// 选区在原文里的位置要由调用方给出，这样改完能精确替换回去，
// 而不是靠字符串搜索——同样的文字在文中可能出现好几次。
function validateSelection(document, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw new TypeError("选区位置无效");
  if (start < 0 || end > document.length || end <= start) throw new RangeError("选区超出文档范围");
  if (end - start > MAX_SELECTION_CHARACTERS) throw new RangeError("一次最多改 8000 字，先选小一点");
  return { start, end, text: document.slice(start, end) };
}

function buildCanvasPrompt({ action, document, start, end, note }) {
  const definition = ACTIONS[validateActionId(action)];
  const text = validateDocument(document);
  const selection = validateSelection(text, start, end);
  if (!selection.text.trim()) throw new Error("选中的内容是空的");

  const before = text.slice(Math.max(0, selection.start - CONTEXT_WINDOW), selection.start);
  const after = text.slice(selection.end, selection.end + CONTEXT_WINDOW);
  const extra = typeof note === "string" && note.trim()
    ? `\n用户对这次修改的额外要求：${note.trim().slice(0, 500)}`
    : "";

  return {
    action: definition,
    selection,
    systemContent: [
      "你是 kaii 的写作画布。用户正在编辑一篇文档，选中了其中一段要你改。",
      "只输出改好之后的那一段本身，直接替换原文用。",
      "不要重复整篇文档，不要加引号或代码块包裹，不要写“修改后：”这类前缀，不要解释你改了什么。",
      "上下文只是给你参考语气和衔接的，不要把它一起输出。",
    ].join("\n"),
    userContent: [
      definition.instruction + extra,
      "",
      before.trim() ? `【前文，仅供参考，不要输出】\n${before}` : "",
      "",
      "【要改的就是下面这一段】",
      selection.text,
      "",
      after.trim() ? `【后文，仅供参考，不要输出】\n${after}` : "",
    ].filter((part) => part !== "").join("\n"),
  };
}

// 模型仍然可能自作主张加包裹或前缀。这里做一次收口，
// 但不动内容本身——它可能就是要以引号开头的一句话。
function cleanReplacement(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const fenced = text.match(/^```[\w+#.-]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(修改后|改写后|结果|以下是修改后的内容)\s*[:：]\s*/i, "");
  return text;
}

function applyReplacement(document, start, end, replacement) {
  const text = validateDocument(document);
  const selection = validateSelection(text, start, end);
  const clean = cleanReplacement(replacement);
  if (!clean) throw new Error("这次没有生成出可用的内容");
  return {
    document: `${text.slice(0, selection.start)}${clean}${text.slice(selection.end)}`,
    replaced: clean,
    start: selection.start,
    end: selection.start + clean.length,
  };
}

module.exports = {
  ACTIONS,
  CONTEXT_WINDOW,
  MAX_DOCUMENT_CHARACTERS,
  MAX_SELECTION_CHARACTERS,
  applyReplacement,
  buildCanvasPrompt,
  cleanReplacement,
  listActions,
  validateActionId,
  validateDocument,
  validateSelection,
};
