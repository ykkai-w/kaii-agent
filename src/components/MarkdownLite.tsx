import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { KATEX_OPTIONS, remarkNoCurrencyMath } from "../lib/math.ts";
import { splitChartSegments } from "../lib/chart.ts";
import ChartBlock from "./ChartBlock";

// 对话主流程之外的地方（比一比、预览）用的轻量渲染。
// 和主流程共用同一套 Markdown 配置和图表渲染，不另起一套——
// 否则同一段回答在两个地方会长得不一样。
// 少的只是主流程那些交互：折叠、代码块复制、引用提问。
export default function MarkdownLite({ content }: { content: string }) {
  return (
    <>
      {splitChartSegments(content).map((segment, index) => (
        segment.kind === "chart"
          ? <ChartBlock key={index} spec={segment.spec} />
          : (
            <ReactMarkdown
              key={index}
              remarkPlugins={[remarkGfm, remarkMath, remarkNoCurrencyMath]}
              rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
              components={{
                // 外链在这里点不开也不该冒充可点，只留文字。
                a: ({ children }) => <span className="markdown-link-text">{children}</span>,
                img: ({ alt }) => <span className="markdown-image-note">[图片：{alt || "未命名"}]</span>,
              }}
            >{segment.text}</ReactMarkdown>
          )
      ))}
    </>
  );
}
