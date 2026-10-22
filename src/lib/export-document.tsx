import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { KATEX_OPTIONS, remarkNoCurrencyMath } from "./math.ts";
import ChartBlock from "../components/ChartBlock";
import type { Conversation } from "../types";
import { splitChartSegments } from "./chart.ts";
export { safeFileName } from "./filename.ts";

// 导出也必须遵守对话界面的外部资源边界：模型回答里的
// Markdown 图片和链接只保留可读文字，不让一个隐藏的 PDF 排版窗口
// 因为 `<img src="https://...">` 背地里发起网络请求。来源清单是另一回事：
// 那些 URL 经搜索边界校验过，且它们只是可点文本，不会自动加载。
const EXPORT_MARKDOWN_COMPONENTS = {
  a: ({ children }: { children?: React.ReactNode }) => <span className="markdown-link-text">{children}</span>,
  img: ({ alt }: { alt?: string }) => <span className="markdown-image-note">[图片：{alt || "未命名"}]</span>,
};

// 把一段对话导成一份能直接发给别人的文档。
//
// 关键决定：**复用界面上那套渲染**（ReactMarkdown + ChartBlock），
// 用 renderToStaticMarkup 转成 HTML 字符串。
// 另写一个 Markdown 解析器意味着导出和屏幕上看到的会慢慢长歪——
// 表格对不齐、代码块丢语言、图干脆不见，而且没人会发现。

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? escapeHtml(url.href) : null;
  } catch {
    return null;
  }
}

export function renderAnswerHtml(content: string): string {
  return splitChartSegments(content).map((segment) => (
    segment.kind === "chart"
      ? renderToStaticMarkup(<ChartBlock spec={segment.spec} />)
      : renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkNoCurrencyMath]}
          rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
          components={EXPORT_MARKDOWN_COMPONENTS}
        >{segment.text}</ReactMarkdown>,
      )
  )).join("\n");
}

// 导出的文档要能脱离这个应用单独看，所以样式全部内联，
// 不引外部字体和样式表。颜色写死成浅色一套：
// 别人多半是在浏览器里打开或者打印，深色变量在那边没有意义。
// 打包时把 KaTeX 的样式读进来内联。用 ?inline 让 vite 给字符串而不是插进页面。
import KATEX_CSS from "katex/dist/katex.min.css?inline";

const DOCUMENT_STYLE = `
  :root { color-scheme: light; }
  body {
    margin: 0 auto;
    max-width: 44rem;
    padding: 3rem 1.5rem 4rem;
    background: #ffffff;
    color: #181816;
    font: 15px/1.9 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  }
  h1.doc-title { margin: 0 0 4px; font-size: 24px; font-weight: 600; }
  .doc-meta { margin-bottom: 34px; color: #8b867c; font-size: 12px; }
  .turn { margin-bottom: 26px; }
  .who {
    display: inline-block;
    margin-bottom: 6px;
    padding: 2px 9px;
    border-radius: 999px;
    background: #efece4;
    color: #5d5a53;
    font-size: 11px;
  }
  .turn.me .who { background: #d7e3ef; color: #2f5580; }
  .body > *:first-child { margin-top: 0; }
  .body > *:last-child { margin-bottom: 0; }
  .body p { margin: 0 0 0.85em; }
  .body pre {
    overflow-x: auto;
    padding: 12px 14px;
    border: 1px solid rgba(24,24,22,0.12);
    border-radius: 6px;
    background: #f8f5ee;
    font-size: 12.5px;
    line-height: 1.7;
  }
  .body code { background: #f2eee6; border-radius: 3px; padding: 1px 4px; font-size: 0.92em; }
  .body pre code { background: none; padding: 0; }
  .body table { width: 100%; border-collapse: collapse; margin: 0 0 1em; font-size: 13.5px; }
  .body th, .body td { border: 1px solid rgba(24,24,22,0.14); padding: 6px 9px; text-align: left; }
  .body th { background: #f2eee6; font-weight: 500; }
  .body blockquote {
    margin: 0 0 1em;
    padding-left: 14px;
    border-left: 2px solid rgba(24,24,22,0.18);
    color: #5d5a53;
  }
  .attachment-note { margin: 0 0 8px; color: #8b867c; font-size: 12px; }
  .sources { margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(24,24,22,0.14); font-size: 12px; }
  .sources ol { margin: 4px 0 0; padding-left: 1.4em; }
  .sources a { color: #416f9f; }
  .doc-foot { margin-top: 44px; padding-top: 12px; border-top: 1px solid rgba(24,24,22,0.12); color: #8b867c; font-size: 11px; }

  /* 图表用的变量在导出的文档里也要有，否则扇形和柱子会没有颜色。 */
  :root {
    --chart-1: #416f9f; --chart-2: #a9682f; --chart-3: #587851;
    --chart-4: #8a5878; --chart-5: #a94838; --chart-6: #6f6a5c;
    --line: rgba(24,24,22,0.12); --line-strong: rgba(24,24,22,0.22);
    --surface: #f8f5ee; --surface-strong: #ffffff;
    --ink: #181816; --ink-soft: #5d5a53; --ink-faint: #8b867c;
  }
  .chart-block { margin: 14px 0; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  .chart-block figcaption { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12.5px; }
  /* 导出的文档里点不了"下载数据"，藏掉，别留一个假按钮。 */
  .chart-block figcaption button { display: none; }
  .chart-block svg { display: block; width: 100%; height: auto; }
  .chart-tick { fill: var(--ink-faint); font-size: 10px; }
  .chart-pie { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .chart-pie svg { width: 168px; flex: 0 0 auto; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 5px 14px; margin: 8px 0 0; padding: 0; list-style: none; }
  .chart-pie .chart-legend { flex: 1; flex-direction: column; gap: 5px; margin: 0; }
  .chart-legend li { display: flex; align-items: center; gap: 6px; color: var(--ink-soft); font-size: 11px; }
  .chart-legend i { width: 9px; height: 9px; border-radius: 2px; }
  .chart-legend b { margin-left: auto; color: var(--ink); font-weight: 500; }

  /* KaTeX 的样式在这里内联一份。少了它，公式在导出的文档里
     会散成一堆错位的字符——比不渲染还难看。 */
  ${KATEX_CSS}

  @media print {
    body { padding: 0; max-width: none; }
    /* 只保护"切开就看不懂"的整块：图、表格、代码块。
       整段问答不能加 break-inside: avoid——一段长回答比一页还高时，
       浏览器会把它整个推到下一页，前面留出大半页空白。
       实测第一版就是这样：第 1 页只有两行字，图跑到了第 2 页。 */
    .chart-block, .body table, .body pre { break-inside: avoid; }
    /* 说话人标签不能孤零零留在页尾。 */
    .who { break-after: avoid; }
    .turn { break-before: auto; }
  }
`;

export interface ExportOptions {
  /** 落款。默认写明是本机生成的，别人拿到能看出来源。 */
  footer?: string;
  /** 不带「附了文档：xxx.pdf」这类行。文件名本身可能就是隐私。 */
  omitAttachmentNotes?: boolean;
}

export function conversationToHtml(conversation: Conversation, options: ExportOptions = {}): string {
  const stamp = new Date().toLocaleString("zh-CN");
  const started = new Date(conversation.createdAt).toLocaleString("zh-CN");

  const turns = conversation.messages
    .filter((message) => message.content.trim())
    .map((message) => {
      const notes: string[] = [];
      if (!options.omitAttachmentNotes) {
        if (message.document) notes.push(`附了文档：${escapeHtml(message.document.name)}`);
        if (message.attachment) notes.push(`附了图片：${escapeHtml(message.attachment.name)}`);
      }

      const body = message.role === "user"
        // 用户说的话原样保留，不当 Markdown 解析——
        // 用户写的 * 和 # 就是字面意思，不该被渲染成列表和标题。
        ? `<p>${escapeHtml(message.content.trim()).replaceAll("\n", "<br>")}</p>`
        : renderAnswerHtml(message.content.trim());

      const sources = message.sources?.length
        ? `<div class="sources">来源：<ol>${message.sources
          .map((source) => {
            const href = safeExternalHref(source.url);
            const title = escapeHtml(source.title);
            return href
              ? `<li><a href="${href}" rel="noreferrer noopener">${title}</a></li>`
              : `<li><span>${title}</span></li>`;
          })
          .join("")}</ol></div>`
        : "";

      return `<section class="turn ${message.role === "user" ? "me" : "kaii"}">
  <div class="who">${message.role === "user" ? "我" : "kaii"}</div>
  ${notes.map((note) => `<p class="attachment-note">${note}</p>`).join("")}
  <div class="body">${body}</div>
  ${sources}
</section>`;
    })
    .join("\n");

  const footer = options.footer
    ?? `这份文档由 kaii 在本机生成于 ${stamp}。`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conversation.title || "对话")}</title>
<style>${DOCUMENT_STYLE}</style>
</head>
<body>
<h1 class="doc-title">${escapeHtml(conversation.title || "对话")}</h1>
<div class="doc-meta">开始于 ${started}</div>
${turns}
<div class="doc-foot">${escapeHtml(footer)}</div>
</body>
</html>
`;
}

// 把一个项目下的所有对话导成一份文档。
// 单段对话导出解决的是"把这次问答发给别人"，
// 项目导出解决的是"把这一整摊事整理成一份材料"。
export function projectToHtml(
  projectName: string,
  conversations: Conversation[],
  options: ExportOptions = {},
): string {
  const stamp = new Date().toLocaleString("zh-CN");
  // 按时间正序：读一份材料时，事情该按发生顺序排。
  const ordered = [...conversations].sort((a, b) => a.createdAt - b.createdAt);

  const sections = ordered.map((conversation) => {
    const inner = conversationToHtml(conversation, { footer: "" });
    // 每段对话自己那份 <html> 外壳不要，只取正文。
    const body = inner.slice(inner.indexOf("<body>") + 6, inner.lastIndexOf("</body>"));
    // 每段的落款也去掉，整份文档末尾统一署一次。
    return body.replace(/<div class="doc-foot">[\s\S]*?<\/div>/, "");
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(projectName)}</title>
<style>${DOCUMENT_STYLE}
  .project-toc { margin-bottom: 36px; padding-bottom: 18px; border-bottom: 1px solid rgba(24,24,22,0.12); }
  .project-toc ol { margin: 8px 0 0; padding-left: 1.4em; font-size: 13px; line-height: 2; }
  .project-part { margin-top: 30px; padding-top: 22px; border-top: 1px dashed rgba(24,24,22,0.16); }
  .project-part:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }
</style>
</head>
<body>
<h1 class="doc-title">${escapeHtml(projectName)}</h1>
<div class="doc-meta">共 ${ordered.length} 段对话</div>
<div class="project-toc">
  <strong>目录</strong>
  <ol>${ordered.map((item) => `<li>${escapeHtml(item.title || "未命名对话")}</li>`).join("")}</ol>
</div>
${sections.map((section) => `<div class="project-part">${section}</div>`).join("\n")}
<div class="doc-foot">${escapeHtml(options.footer ?? `这份材料由 kaii 在本机生成于 ${stamp}。`)}</div>
</body>
</html>
`;
}
