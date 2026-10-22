import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { describeLength, extractOutline, readingMinutes } =
  await import(fileURLToPath(new URL("../../src/lib/outline.ts", import.meta.url)));
const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const chart = fs.readFileSync(new URL("../../src/components/ChartBlock.tsx", import.meta.url), "utf8");
const table = fs.readFileSync(new URL("../../src/components/SmartTable.tsx", import.meta.url), "utf8");

// ── 目录 ───────────────────────────────────────────────────

test("标题少于三个就不给目录", () => {
  // 两条的目录不解决问题，只占地方。
  assert.deepEqual(extractOutline("m", "# 一\n\n## 二"), []);
  assert.equal(extractOutline("m", "# 一\n## 二\n### 三").length, 3);
});

test("代码块里的 # 是注释，不是标题", () => {
  const doc = "# 真标题\n## 第二\n\n```js\n// # 假的\n// ## 也是假的\n```\n\n## 第三";
  const items = extractOutline("m", doc);
  assert.deepEqual(items.map((item) => item.text), ["真标题", "第二", "第三"]);
});

test("#标签 不是标题", () => {
  // 后面必须跟空格才算。
  assert.deepEqual(extractOutline("m", "#标签 #另一个 #第三个"), []);
});

test("标题里的强调符号剥掉", () => {
  const items = extractOutline("m", "# **加粗的标题**\n## `代码标题`\n### 普通");
  assert.deepEqual(items.map((item) => item.text), ["加粗的标题", "代码标题", "普通"]);
});

test("阅读时间是粗估，短回答不显示", () => {
  assert.equal(describeLength("很短的一句话"), "");
  assert.match(describeLength("中".repeat(800)), /800 字 · 大约读 2 分钟/);
  // 再短也至少 1 分钟，写 0 分钟没有意义。
  assert.equal(readingMinutes("中".repeat(50)), 1);
});

test("目录靠标题文字找 DOM，不存节点引用", () => {
  // 回答是流式渲染的，节点会被反复替换，存引用会指向已经不在的东西。
  const block = app.slice(app.indexOf("answer-outline"), app.indexOf("answer-outline") + 1600);
  assert.match(block, /querySelectorAll\("h1,h2,h3,h4"\)/);
  assert.match(block, /node\.textContent\?\.trim\(\) === item\.text/);
});

// ── 表格 ───────────────────────────────────────────────────

test("排序认得数字，也认得带符号的数字", async () => {
  const { compareCells } = await import(fileURLToPath(new URL("../../src/lib/table.ts", import.meta.url)));
  assert.ok(compareCells("120", "80") > 0);
  assert.ok(compareCells("1,200", "800") > 0, "千分位要认");
  assert.ok(compareCells("￥80", "￥120") < 0, "货币符号要认");
  // 数字排在文本前面：一列里混着「120」和「暂无」时，
  // 把「暂无」堆在一头比穿插在中间好读。
  assert.ok(compareCells("120", "暂无") < 0);
  assert.ok(compareCells("暂无", "120") > 0);
});

test("导出的 CSV 会转义逗号和引号", async () => {
  const { tableToCsv } = await import(fileURLToPath(new URL("../../src/lib/table.ts", import.meta.url)));
  const csv = tableToCsv(["名字", "备注"], [["张三", "住在北京,朝阳区"], ["李四", '他说"好"']]);
  assert.match(csv, /"住在北京,朝阳区"/);
  assert.match(csv, /"他说""好"""/);
});

test("排序点三下回到原始顺序", () => {
  // 排错了想撤销时不用刷新页面。
  assert.match(table, /current\.desc \? null : \{ column: index, desc: true \}/);
});

test("CSV 带 BOM，否则 Excel 打开是乱码", () => {
  assert.match(table, /﻿/);
});

test("表格从渲染器已解析的节点里读，不另写解析器", () => {
  // 自己再写一个 Markdown 表格解析器意味着两套规则，迟早对不上。
  assert.match(app, /function readTableNode/);
  assert.match(app, /table: \(\{ children \}\) => \{/);
  // 读不出表头时退回普通表格，不能因为读失败就把内容吞了。
  assert.match(app, /if \(!headers\.length\) return <table>\{children\}<\/table>/);
});

// ── 图表 ───────────────────────────────────────────────────

test("柱状折线可以互换，饼图不参与", () => {
  assert.match(chart, /const \[kind, setKind\] = useState<ChartSpec\["type"\]>\(spec\.type\)/);
  assert.match(chart, /\{spec\.type !== "pie" && \(/);
  // 换成折线时纵轴不再强制从 0 起。
  assert.match(chart, /axisRange\(flat, \{ zeroBased: kind === "bar" \}\)/);
});

test("图表能展开看原始数字，缺的值显示成破折号", () => {
  assert.match(chart, /const \[showData, setShowData\] = useState\(false\)/);
  assert.match(chart, /Number\.isFinite\(item\.values\[index\]\) \? item\.values\[index\] : "—"/);
});

// ── 代码块 ─────────────────────────────────────────────────

test("行号不写进代码文本，复制时不会带上", () => {
  assert.match(app, /<div className="code-gutter" aria-hidden="true">/);
  assert.match(css, /\.code-gutter \{[\s\S]*?user-select: none/);
  assert.match(css, /pointer-events: none/);
});

test("行号槽的字号行高和代码块一致", () => {
  // 差一点行号就会和代码错开，而且越往下错得越多。
  const rule = css.slice(css.indexOf(".code-gutter {"), css.indexOf("}", css.indexOf(".code-gutter {")));
  assert.match(rule, /font-family: var\(--font-serif\)/);
  assert.match(rule, /font-size: 0\.9em/);
  assert.match(rule, /line-height: inherit/);
  assert.match(rule, /padding: 14px 0/);
});

test("公式双击复制的是 LaTeX 原文", () => {
  // KaTeX 把原始式子放在 annotation 里，读那个比从渲染结果反推可靠。
  assert.match(app, /annotation\[encoding="application\/x-tex"\]/);
});

test("表格转 TSV：制表符和换行收成空格，结构不破", async () => {
  const { tableToTsv } = await import("../../src/lib/table.ts");
  const tsv = tableToTsv(["名字", "备注"], [["甲", "有\t制表符"], ["乙", "有\n换行"]]);
  assert.equal(tsv, "名字\t备注\n甲\t有 制表符\n乙\t有 换行");
});
