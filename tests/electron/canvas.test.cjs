const assert = require("node:assert/strict");
const test = require("node:test");

const canvas = require("../../electron/lib/canvas.cjs");

const DOCUMENT = [
  "第一段是开头，交代背景。",
  "",
  "第二段讲的是具体做法，需要改写。",
  "",
  "第三段是结论。",
].join("\n");

function rangeOf(needle, document = DOCUMENT) {
  const start = document.indexOf(needle);
  return { start, end: start + needle.length };
}

test("every canvas action asks for a drop-in replacement and nothing else", () => {
  const actions = canvas.listActions();
  assert.ok(actions.length >= 5);
  const { start, end } = rangeOf("第二段讲的是具体做法，需要改写。");

  for (const action of actions) {
    const built = canvas.buildCanvasPrompt({ action: action.id, document: DOCUMENT, start, end });
    assert.equal(built.action.id, action.id);
    assert.match(built.systemContent, /只输出改好之后的那一段本身/);
    assert.match(built.systemContent, /不要重复整篇文档/);
    // 上下文要给，但必须标明"不要输出"。
    assert.match(built.userContent, /【要改的就是下面这一段】/);
    assert.match(built.userContent, /第二段讲的是具体做法/);
    assert.match(built.userContent, /仅供参考，不要输出/);
    assert.equal(built.selection.text, "第二段讲的是具体做法，需要改写。");
  }
});

test("the extra note reaches the model, and 改错字 stays conservative", () => {
  const { start, end } = rangeOf("第二段讲的是具体做法，需要改写。");
  const withNote = canvas.buildCanvasPrompt({
    action: "rewrite",
    document: DOCUMENT,
    start,
    end,
    note: "  保留第一句  ",
  });
  assert.match(withNote.userContent, /额外要求：保留第一句/);

  const fix = canvas.buildCanvasPrompt({ action: "fix", document: DOCUMENT, start, end });
  assert.match(fix.userContent, /除此之外一个字都不要改/);
  assert.match(fix.userContent, /不要润色/);
});

test("selections are validated against the real document, not by searching text", () => {
  assert.throws(() => canvas.validateSelection(DOCUMENT, -1, 5), /选区超出文档范围/);
  assert.throws(() => canvas.validateSelection(DOCUMENT, 5, 5), /选区超出文档范围/);
  assert.throws(() => canvas.validateSelection(DOCUMENT, 5, DOCUMENT.length + 1), /选区超出文档范围/);
  assert.throws(() => canvas.validateSelection(DOCUMENT, 1.5, 5), /选区位置无效/);
  assert.throws(() => canvas.validateSelection("字".repeat(20_000), 0, 9000), /一次最多改 8000 字/);
  assert.throws(() => canvas.validateDocument("x".repeat(canvas.MAX_DOCUMENT_CHARACTERS + 1)), /文档过长/);
  // 只选中了换行这种空白，没有可改的东西。
  const blankStart = DOCUMENT.indexOf("\n\n");
  assert.throws(
    () => canvas.buildCanvasPrompt({ action: "rewrite", document: DOCUMENT, start: blankStart, end: blankStart + 2 }),
    /选中的内容是空的/,
  );
  assert.throws(() => canvas.buildCanvasPrompt({ action: "删库", document: DOCUMENT, start: 0, end: 3 }), /画布动作无效/);
});

test("the same text appearing twice is replaced at the selected position only", () => {
  // 靠字符串搜索会改错地方：这里第二个"重复"才是被选中的那个。
  const document = "重复的一段话。\n\n中间隔开。\n\n重复的一段话。";
  const second = document.lastIndexOf("重复的一段话。");
  const applied = canvas.applyReplacement(document, second, second + "重复的一段话。".length, "换成新的内容。");
  assert.equal(applied.document, "重复的一段话。\n\n中间隔开。\n\n换成新的内容。");
  assert.equal(applied.replaced, "换成新的内容。");
  assert.equal(applied.start, second);
  assert.equal(applied.end, second + "换成新的内容。".length);
});

test("model wrappers and prefixes are stripped before the text lands in the document", () => {
  assert.equal(canvas.cleanReplacement("```\n改好的内容\n```"), "改好的内容");
  assert.equal(canvas.cleanReplacement("```markdown\n改好的内容\n```"), "改好的内容");
  assert.equal(canvas.cleanReplacement("修改后：改好的内容"), "改好的内容");
  assert.equal(canvas.cleanReplacement("改写后： 改好的内容"), "改好的内容");
  assert.equal(canvas.cleanReplacement("  改好的内容  \n"), "改好的内容");
  // 内容本身以引号开头是合法的，不能顺手剥掉。
  assert.equal(canvas.cleanReplacement('"这句话本来就带引号"'), '"这句话本来就带引号"');
  assert.equal(canvas.cleanReplacement(""), "");
  assert.equal(canvas.cleanReplacement(null), "");

  const { start, end } = rangeOf("第三段是结论。");
  assert.throws(() => canvas.applyReplacement(DOCUMENT, start, end, "   \n  "), /没有生成出可用的内容/);
});

test("a replacement keeps everything outside the selection byte-identical", () => {
  const { start, end } = rangeOf("第二段讲的是具体做法，需要改写。");
  const applied = canvas.applyReplacement(DOCUMENT, start, end, "第二段已经换成了新写法。");
  assert.equal(applied.document.startsWith("第一段是开头，交代背景。\n\n"), true);
  assert.equal(applied.document.endsWith("\n\n第三段是结论。"), true);
  assert.equal(applied.document.includes("需要改写"), false);
  assert.equal(applied.document.includes("第二段已经换成了新写法。"), true);
});
