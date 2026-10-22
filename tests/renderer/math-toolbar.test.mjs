import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const { KATEX_OPTIONS, looksLikeMath, remarkNoCurrencyMath } =
  await import(fileURLToPath(new URL("../../src/lib/math.ts", import.meta.url)));
const appSource = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});
after(async () => vite.close());
const { default: MarkdownLite } = await vite.ssrLoadModule("/src/components/MarkdownLite.tsx");

// ── 公式 ───────────────────────────────────────────────────

test("公式渲染出错不会把整条回答炸掉", () => {
  // 流式输出到一半时公式本来就是残的。throwOnError 会让整段消息
  // 渲染失败，用户看到一片空白。
  assert.equal(KATEX_OPTIONS.throwOnError, false);
  assert.equal(KATEX_OPTIONS.trust, false, "不该允许会引入外部资源的命令");
  assert.equal(KATEX_OPTIONS.globalGroup, false, "宏定义不该跨消息污染");
});

test("中文钱文本不误判为公式，含数学结构的中文公式也不误伤", () => {
  // 「花了 $5 买的，另一个 $8」会被 remark-math 配成一对，
  // 中间那句中文整段被当成公式吃掉。
  assert.equal(looksLikeMath("5 买的，另一个 "), false);
  assert.equal(looksLikeMath("这段话"), false);
  assert.equal(looksLikeMath("5/本，另一个 "), false, "价格里的斜杠不是数学证据");
  assert.equal(looksLikeMath("优点+缺点都写了"), false, "普通中文里的加号不该触发 KaTeX");
  assert.equal(looksLikeMath(" n "), true);
  assert.equal(looksLikeMath("H_n"), true);
  assert.equal(looksLikeMath("\\frac{1}{2}"), true);
  assert.equal(looksLikeMath("x^2 + y^2 = z^2"), true);
  // 教材和财经内容常把中文写在 \text 或下标里，“只要有中文就拒绝”
  // 会把这些真公式导成原始 LaTeX。
  assert.equal(looksLikeMath(String.raw`\text{利润}=收入-成本`), true);
  assert.equal(looksLikeMath("利润=收入-成本"), true);
  assert.equal(looksLikeMath("x_{价格}"), true);
});

test("含中文的行内公式被还原成原文，一个字都不少", () => {
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [
        { type: "text", value: "这本书花了 " },
        { type: "inlineMath", value: "5 买的，另一本 " },
        { type: "text", value: "8。" },
      ],
    }],
  };
  remarkNoCurrencyMath()(tree);
  const paragraph = tree.children[0];
  assert.equal(paragraph.children[1].type, "text");
  assert.equal(paragraph.children[1].value, "$5 买的，另一本 $");
  assert.equal(
    paragraph.children.map((node) => node.value).join(""),
    "这本书花了 $5 买的，另一本 $8。",
    "还原之后文字对不上了",
  );
});

test("真公式不会被误伤", () => {
  const tree = {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "inlineMath", value: "H_n" }] }],
  };
  remarkNoCurrencyMath()(tree);
  assert.equal(tree.children[0].children[0].type, "inlineMath");
});

test("轻量渲染入口实际产出 KaTeX，同时不加载 Markdown 远程图", () => {
  const html = renderToStaticMarkup(React.createElement(MarkdownLite, {
    content: [String.raw`结果：$\text{利润}=x-y$`, "", "![图](https://attacker.invalid/a.png)"].join("\n"),
  }));
  assert.match(html, /class="katex"/, "MarkdownLite 仍把公式当原始 LaTeX");
  assert.equal(html.includes("attacker.invalid"), false);
  assert.equal(/<img\b|<link\b/i.test(html), false);
  assert.match(html, /\[图片：图\]/);
});

// ── 工具条 ─────────────────────────────────────────────────

test("工具条只有图标，没有文字", () => {
  // 一排带文字的按钮各自换行会把工具栏撑成两层，
  // 截图里「普通聊 天」「比一 比」就是这么来的。
  // 按缩进精确截取这一块，别让别处的同名标签混进来。
  const lines = appSource.split("\n");
  const start = lines.findIndex((line) => line.includes('<div className="tool-buttons"'));
  assert.ok(start >= 0, "找不到工具条");
  const indent = lines[start].length - lines[start].trimStart().length;
  const end = lines.findIndex((line, index) => index > start
    && line.trim() === "</div>" && line.length - line.trimStart().length === indent);
  assert.ok(end > start, "找不到工具条的结尾");
  const block = lines.slice(start + 1, end + 1).join("\n");
  // 按钮里除了图标组件和条件表达式，不该有中文标签。
  const labels = block.match(/>\s*[一-鿿]+\s*</g) || [];
  assert.deepEqual(labels, [], `工具条里还留着文字：${labels.join(" ")}`);
  // 但每个按钮都要有 title 和 aria-label，否则纯图标就成了猜谜。
  const buttons = (block.match(/<button/g) || []).length;
  const titles = (block.match(/title=/g) || []).length;
  const ariaLabels = (block.match(/aria-label=/g) || []).length;
  assert.ok(buttons >= 7, `工具条只找到 ${buttons} 个按钮`);
  assert.equal(titles, buttons, "有按钮没写 title");
  assert.equal(ariaLabels, buttons, "有按钮没写 aria-label");
});

test("工具按钮是固定尺寸的方块，不会被文字撑变形", () => {
  const rule = cssSource.match(/\.tool-buttons button \{([^}]*)\}/);
  assert.ok(rule, "找不到 .tool-buttons button 规则");
  assert.match(rule[1], /width:\s*28px/);
  assert.match(rule[1], /height:\s*28px/);
  assert.match(rule[1], /place-items:\s*center/);
});

test("左边那两个下拉的文字不从词中间断开", () => {
  // 截图里「普通聊 天」「自 动」就是断行断出来的。
  assert.match(cssSource, /\.skill-picker > button,\s*\n\.model-picker > button,\s*\n\.prompt-picker > button \{\s*\n\s*white-space: nowrap;/);
});
