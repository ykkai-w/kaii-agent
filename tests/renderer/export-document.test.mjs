import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// 这里故意经 Vite SSR 载入真实 TSX。以前的测试只在源码里找
// `ReactMarkdown` 和 `rehypeKatex` 几个字，即使导出仍是原始 LaTeX 也会全绿。
const root = fileURLToPath(new URL("../..", import.meta.url));
// 这个文件必须走真实的 KaTeX CSS 内联：下面有一条用例专门验证导出的 HTML
// 内联了 20 个 woff2 字体（保证文档离开本机也能显示公式）。曾经想用插件把
// ?inline 短路掉来躲开负载高时的 60 秒传输超时，结果正好把那条用例架空成 0 个
// —— 为了让测试跑快而削弱它要验的东西，是本末倒置。
// 正确做法：保留真实 CSS，机器负载高导致的超时按环境问题处理（串行跑 + 空闲时跑）。
const vite = await createServer({
  root,
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});

after(async () => vite.close());

const { conversationToHtml, projectToHtml, renderAnswerHtml, safeFileName } =
  await vite.ssrLoadModule("/src/lib/export-document.tsx");

function conversation(id, title, createdAt, messages) {
  return {
    id,
    title,
    skillId: "chat",
    createdAt,
    updatedAt: createdAt,
    messages: messages.map((message, index) => ({
      id: `${id}-${index}`,
      createdAt: createdAt + index,
      ...message,
    })),
  };
}

test("导出的公式、表格和图表是真渲染，不是源码里只写了库名", () => {
  const answer = [
    "公式 $x^2+y^2=z^2$",
    "",
    "| 城市 | 值 |",
    "| --- | ---: |",
    "| 北京 | 42 |",
    "",
    "```chart",
    '{"type":"bar","title":"数量","labels":["北京","上海"],"series":[{"name":"值","values":[42,31]}]}',
    "```",
  ].join("\n");
  const html = renderAnswerHtml(answer);
  assert.match(html, /class="katex"/, "公式没有变成 KaTeX 节点");
  assert.match(html, /<table>/, "GFM 表格没有变成 table");
  assert.match(html, /<figure class="chart-block">/, "chart 围栏没有走真实图表组件");
  assert.match(html, /<rect\b/, "柱子没有渲染出来");
});

test("含中文的真公式不再被当成钱文本还原", () => {
  const html = renderAnswerHtml(String.raw`净利润：$\text{利润}=x-y$`);
  assert.match(html, /class="katex"/);
  assert.ok(html.includes('annotation encoding="application/x-tex">\\text{利润}=x-y'));
});

test("助手 Markdown 里的远程图片和链接不会让隐藏排版窗口联网", () => {
  const html = renderAnswerHtml([
    "![账单图](https://attacker.invalid/pixel.png?secret=1)",
    "[点我](https://attacker.invalid/page)",
  ].join("\n\n"));
  assert.equal(html.includes("attacker.invalid"), false, "远程 URL 还进了导出 HTML");
  assert.equal(/<img\b/i.test(html), false, "远程图片仍会自动加载");
  assert.equal(/<link\b/i.test(html), false, "React 的图片 preload 仍会自动加载");
  assert.match(html, /\[图片：账单图\]/);
  assert.match(html, />点我<\/span>/);
});

test("只有搜索来源的 http/https 地址会保留为可点链接", () => {
  const item = conversation("sources", "来源", Date.UTC(2026, 7, 10), [{
    role: "assistant",
    content: "结论",
    sources: [
      { title: "正常来源", url: "https://example.com/a?q=1&b=2" },
      { title: "坏来源", url: "javascript:alert(1)" },
    ],
  }]);
  const html = conversationToHtml(item);
  assert.match(html, /href="https:\/\/example\.com\/a\?q=1&amp;b=2" rel="noreferrer noopener">正常来源/);
  assert.equal(html.includes("javascript:"), false);
  assert.match(html, /<li><span>坏来源<\/span><\/li>/);
});

test("用户输入按字面导出并转义，助手回答仍走 Markdown", () => {
  const item = conversation("one", "<标题>", Date.UTC(2026, 7, 10), [
    { role: "user", content: '<script>alert("x")</script>\n* 不是斜体' },
    { role: "assistant", content: "**是粗体**" },
  ]);
  const html = conversationToHtml(item, { footer: "测试落款" });
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>\* 不是斜体/);
  assert.match(html, /<strong>是粗体<\/strong>/);
  assert.match(html, /<title>&lt;标题&gt;<\/title>/);
});

test("导出 HTML 内联 KaTeX 的 woff2 字体，离开 dist 目录也能显示", () => {
  const item = conversation("font", "公式", Date.UTC(2026, 7, 10), [
    { role: "assistant", content: "$E=mc^2$" },
  ]);
  const html = conversationToHtml(item);
  const embeddedFonts = html.match(/data:font\/woff2;base64,/g) || [];
  assert.equal(embeddedFonts.length, 20, `应内联 20 个 KaTeX woff2，实际 ${embeddedFonts.length}`);
  assert.equal(/url\([^)]*\.(?:woff|ttf)(?:[?#)]|$)/i.test(html), false, "HTML 还依赖外部字体文件");
  assert.equal(/<link\b|<script\b/i.test(html), false, "自包含文档里还有外部子资源入口");
});

test("整个项目导出按时间排序，有真目录且只有一份落款", () => {
  const later = conversation("later", "后来", 200, [{ role: "assistant", content: "B" }]);
  const earlier = conversation("earlier", "最早", 100, [{ role: "assistant", content: "A" }]);
  const html = projectToHtml("项目&一", [later, earlier], { footer: "唯一落款" });
  assert.match(html, /<div class="project-toc">[\s\S]*<li>最早<\/li><li>后来<\/li>/);
  assert.ok(html.indexOf(">最早</h1>") < html.indexOf(">后来</h1>"), "正文没按时间正序");
  assert.equal((html.match(/class="doc-foot"/g) || []).length, 1);
  assert.equal((html.match(/唯一落款/g) || []).length, 1);
  assert.match(html, /<title>项目&amp;一<\/title>/);
});

test("文件名里的路径分隔符、隐藏文件前缀和超长文字被清理", () => {
  assert.equal(safeFileName("2026/08 的账单", "pdf"), "2026_08 的账单.pdf");
  assert.equal(safeFileName('他说"好"吗?', "md"), "他说_好_吗_.md");
  assert.equal(safeFileName("../../etc/passwd", "html"), "_.._etc_passwd.html");
  assert.equal(safeFileName("...隐藏", "md"), "隐藏.md");
  assert.equal(safeFileName("结尾有空格   ", "md"), "结尾有空格.md");
  assert.equal(safeFileName("   ", "pdf"), "对话.pdf");
  assert.ok(safeFileName("很长的标题".repeat(30), "md").length <= 44);
});
