import { Check, Copy, Download, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Artifact } from "../lib/artifacts";
import { artifactSummary } from "../lib/artifacts";
import { highlightCode } from "../lib/highlight";

// 右侧面板：把回答里成段的代码单独摊开看，带行号、高亮、复制和另存为。
export default function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: Artifact;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const highlighted = useMemo(() => highlightCode(artifact.code, artifact.language), [artifact]);
  const lines = useMemo(() => artifact.code.split("\n"), [artifact]);

  return (
    <aside className="artifact-panel" aria-label={`${artifact.title} 预览`}>
      <header>
        <div>
          <strong>{artifact.title}</strong>
          <small>{artifactSummary(artifact)}</small>
        </div>
        <button className="icon-button" type="button" aria-label="关闭预览" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="artifact-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(artifact.code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制全部"}
        </button>
        <button
          type="button"
          onClick={() => {
            const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = artifact.fileName;
            anchor.click();
            URL.revokeObjectURL(url);
            setSaved(true);
            window.setTimeout(() => setSaved(false), 1500);
          }}
        >
          <Download size={13} /> {saved ? "已保存" : `另存为 ${artifact.fileName}`}
        </button>
      </div>

      <div className="artifact-body">
        <pre className={highlighted.language ? `hljs language-${highlighted.language}` : "hljs"}>
          <span className="artifact-gutter" aria-hidden="true">
            {lines.map((_, index) => <i key={index}>{index + 1}</i>)}
          </span>
          {/* 和聊天里的代码块一样：hljs 只产出 span，输入已转义。 */}
          <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
        </pre>
      </div>
    </aside>
  );
}
