import { Check, CircleStop, Copy, Download, LoaderCircle, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasActionInfo } from "../types";
import MarkdownLite from "./MarkdownLite";

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 写作画布：回答变成一篇可以直接编辑的文档，选中某一段交给 kaii 就地改。
// 和聊天的区别是改动会落回文档本身，而不是又生成一条新消息。
export default function CanvasPanel({
  title,
  initialText,
  onClose,
}: {
  title: string;
  initialText: string;
  onClose: () => void;
}) {
  // 预览：写 Markdown 时想看渲染成什么样。共用主流程那套渲染，
  // 不另写一份，免得预览和真正发出去的长得不一样。
  const [previewing, setPreviewing] = useState(false);
  const [text, setText] = useState(() => {
    // 156) 上次没保存的草稿捞回来。崩溃、误关都不丢。
    try {
      const saved = localStorage.getItem(`kaii.canvas.${title}`);
      if (saved && saved !== initialText && saved.length > initialText.length / 2) return saved;
    } catch {
      // 读不了就用传进来的。
    }
    return initialText;
  });
  const [history, setHistory] = useState<{ text: string; at: number; action: string }[]>([]);
  const [wordTarget, setWordTarget] = useState(0);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showFind, setShowFind] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [compareWith, setCompareWith] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [glossary, setGlossary] = useState(() => localStorage.getItem("kaii.canvas.glossary") || "");
  const [checkReport, setCheckReport] = useState("");
  const [checking, setChecking] = useState(false);
  const [actions, setActions] = useState<CanvasActionInfo[]>([]);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const streamId = useRef<string | null>(null);
  const streamed = useRef("");
  const pendingRange = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    window.kaiLocal.listCanvasActions().then(setActions).catch(() => setActions([]));
  }, []);

  // 自动存盘：停笔一秒落一次。崩溃不丢。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(`kaii.canvas.${title}`, text);
      } catch {
        // 存不下（配额满）就算了，别打断写作。
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [text, title]);

  useEffect(() => {
    try {
      localStorage.setItem("kaii.canvas.glossary", glossary);
    } catch {
      // 同上。
    }
  }, [glossary]);

  useEffect(() => {
    const offChunk = window.kaiLocal.onChatChunk(({ requestId: incoming, content }) => {
      if (streamId.current !== incoming) return;
      streamed.current += content;
    });
    const finish = async (incoming: string, message?: string) => {
      if (streamId.current !== incoming) return;
      const range = pendingRange.current;
      const produced = streamed.current;
      streamId.current = null;
      pendingRange.current = null;
      streamed.current = "";
      setRequestId(null);
      setPendingAction(null);
      if (message) {
        setError(message);
        return;
      }
      if (!range || !produced.trim()) {
        setError("这次没有生成出可用的内容");
        return;
      }
      try {
        // 替换由主进程按位置精确完成：同样的文字在文中可能出现好几次，不能靠搜索。
        const applied = await window.kaiLocal.applyCanvasReplacement({
          document: text,
          start: range.start,
          end: range.end,
          replacement: produced,
        });
        setHistory((current) => [...current, { text, at: Date.now(), action: pendingAction || "改写" }].slice(-30));
        setText(applied.document);
        setSelection({ start: applied.start, end: applied.end });
        requestAnimationFrame(() => {
          const node = editor.current;
          if (!node) return;
          node.focus();
          node.setSelectionRange(applied.start, applied.end);
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "这段改动没有写回文档");
      }
    };
    const offDone = window.kaiLocal.onChatDone(({ requestId: incoming }) => void finish(incoming));
    const offError = window.kaiLocal.onChatError(({ requestId: incoming, message }) => void finish(incoming, message));
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, [text]);

  const captureSelection = useCallback(() => {
    const node = editor.current;
    if (!node) return;
    const { selectionStart, selectionEnd } = node;
    setSelection(selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null);
  }, []);

  const run = useCallback(async (action: CanvasActionInfo) => {
    if (requestId) return;
    const range = selection;
    if (!range) {
      setError("先在文档里选中一段要改的内容");
      return;
    }
    setError(null);
    const incoming = randomId("canvas");
    streamId.current = incoming;
    streamed.current = "";
    pendingRange.current = range;
    setRequestId(incoming);
    setPendingAction(action.id);
    try {
      const outcome = await window.kaiLocal.runCanvasAction({
        requestId: incoming,
        action: action.id,
        document: text,
        start: range.start,
        end: range.end,
        note,
      });
      if (!outcome.ok && outcome.message) {
        setError(outcome.message);
        streamId.current = null;
        pendingRange.current = null;
        setRequestId(null);
        setPendingAction(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这次修改没有完成");
      streamId.current = null;
      pendingRange.current = null;
      setRequestId(null);
      setPendingAction(null);
    }
  }, [note, requestId, selection, text]);

  const selectedLength = selection ? selection.end - selection.start : 0;

  return (
    <aside className={`canvas-panel${fullscreen ? " fullscreen" : ""}`} aria-label="写作画布">
      <header>
        <div>
          <strong>{title}</strong>
          <small>{text.length} 字{history.length ? ` · 改过 ${history.length} 次` : ""}</small>
        </div>
        <button className="icon-button" type="button" aria-label="关闭画布" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="canvas-toolbar">
        {actions.map((action) => (
          <button
            type="button"
            key={action.id}
            title={action.hint}
            disabled={Boolean(requestId) || !selection}
            onClick={() => run(action)}
          >
            {pendingAction === action.id ? <LoaderCircle className="spin" size={12} /> : null} {action.label}
          </button>
        ))}
        <button type="button" title="查找替换" aria-pressed={showFind} onClick={() => setShowFind((value) => !value)}>找</button>
        <button type="button" title="大纲：只看标题，点了跳" aria-pressed={showOutline} onClick={() => setShowOutline((value) => !value)}>纲</button>
        <button type="button" title="版本历史：每次改写都留了底" aria-pressed={showVersions} disabled={!history.length} onClick={() => setShowVersions((value) => !value)}>版</button>
        <button type="button" title="全屏写" aria-pressed={fullscreen} onClick={() => setFullscreen((value) => !value)}>满</button>
        <span className="canvas-selection">
          {requestId
            ? "正在改写…"
            : selection
              ? `已选中 ${selectedLength} 字`
              : "选中一段再点上面的按钮"}
        </span>
      </div>

      {showFind && (
        <div className="canvas-find">
          <input value={findText} placeholder="找什么" onChange={(event) => setFindText(event.target.value)} />
          <input value={replaceText} placeholder="换成什么" onChange={(event) => setReplaceText(event.target.value)} />
          <span>{findText ? `${text.split(findText).length - 1} 处` : ""}</span>
          <button
            type="button"
            disabled={!findText || !text.includes(findText)}
            onClick={() => {
              // 全部替换前先进版本历史，替错了能整体撤销。
              setHistory((current) => [...current, { text, at: Date.now(), action: "替换前" }].slice(-30));
              setText((current) => current.split(findText).join(replaceText));
            }}
          >
            全换
          </button>
        </div>
      )}

      {showOutline && (
        <div className="canvas-outline">
          {(text.match(/^#{1,3}\s+.+$/gm) || []).length
            ? (text.match(/^#{1,3}\s+.+$/gm) || []).map((line, index) => (
              <button
                type="button"
                key={index}
                style={{ paddingLeft: `${((line.match(/^#+/)?.[0].length || 1) - 1) * 12 + 6}px` }}
                onClick={() => {
                  const at = text.indexOf(line);
                  const node = editor.current;
                  if (at < 0 || !node) return;
                  node.focus();
                  node.setSelectionRange(at, at + line.length);
                  // 让选区滚到可见：按行数估算滚动位置。
                  const linesBefore = text.slice(0, at).split("\n").length;
                  node.scrollTop = Math.max(0, (linesBefore - 3) * 22);
                }}
              >
                {line.replace(/^#+\s+/, "")}
              </button>
            ))
            : <p>正文里还没有 # 标题。行首写「# 标题」就会出现在这里。</p>}
        </div>
      )}

      {showVersions && (
        <div className="canvas-versions">
          {[...history].reverse().map((version, index) => (
            <div key={version.at + index}>
              <span>{new Date(version.at).toLocaleTimeString("zh-CN", { hour12: false })} · {version.action}前 · {version.text.length} 字</span>
              <button type="button" onClick={() => setCompareWith(compareWith === version.text ? null : version.text)}>
                {compareWith === version.text ? "收起对比" : "对比"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setHistory((current) => [...current, { text, at: Date.now(), action: "回退前" }].slice(-30));
                  setText(version.text);
                  setShowVersions(false);
                  setCompareWith(null);
                }}
              >
                回到这版
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        className="canvas-note"
        value={note}
        maxLength={200}
        placeholder="可选：这次改写的额外要求，比如「保留第一句」「换成第一人称」"
        onChange={(event) => setNote(event.target.value)}
      />

      {compareWith !== null && (
        <div className="canvas-compare">
          <div>
            <b>那一版</b>
            <pre>{compareWith}</pre>
          </div>
        </div>
      )}
      {previewing ? (
        <div className="canvas-preview" aria-label="预览">
          <MarkdownLite content={text} />
        </div>
      ) : (
        <textarea
          ref={editor}
          className="canvas-editor"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onSelect={captureSelection}
          onKeyUp={captureSelection}
          onMouseUp={captureSelection}
        />
      )}

      {error && <p className="canvas-error" role="alert">{error}</p>}

      <div className="canvas-extras">
        {/* 中文默认按 400 字/分钟估——朗读慢、扫读快，这是个中间值，
            标上「约」提醒它只是量级参考。 */}
        <button
          type="button"
          className="canvas-preview-toggle"
          title="在光标处插入今天的日期"
          onClick={() => {
            const node = editor.current;
            const stamp = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
            if (!node) {
              setText((current) => `${current}${stamp}`);
              return;
            }
            const start = node.selectionStart ?? text.length;
            const end = node.selectionEnd ?? start;
            setText(`${text.slice(0, start)}${stamp}${text.slice(end)}`);
            requestAnimationFrame(() => {
              node.focus();
              node.setSelectionRange(start + stamp.length, start + stamp.length);
            });
          }}
        >
          插日期
        </button>
        <button
          type="button"
          className={previewing ? "canvas-preview-toggle on" : "canvas-preview-toggle"}
          aria-pressed={previewing}
          title={previewing ? "回到编辑" : "看渲染出来的样子"}
          onClick={() => setPreviewing((value) => !value)}
        >
          {previewing ? "编辑" : "预览"}
        </button>
        <span className="canvas-readtime">
          {text.length} 字 · 约 {Math.max(1, Math.round(text.length / 400))} 分钟读完
        </span>
        <label className="canvas-target">
          目标
          <input
            type="number"
            min={0}
            max={100000}
            value={wordTarget || ""}
            placeholder="字数"
            onChange={(event) => setWordTarget(Math.max(0, Number(event.target.value) || 0))}
          />
          {wordTarget > 0 && (
            <i className="canvas-target-bar">
              <b style={{ width: `${Math.min(100, (text.length / wordTarget) * 100)}%` }} />
              <span>{Math.round((text.length / wordTarget) * 100)}%</span>
            </i>
          )}
        </label>
      </div>
      <div className="canvas-extras canvas-exports">
        <input
          className="canvas-glossary"
          value={glossary}
          placeholder="术语表：正确写法|错误写法1,错误写法2（分号隔多条）"
          onChange={(event) => setGlossary(event.target.value)}
        />
        <button
          type="button"
          disabled={!glossary.trim()}
          title="按术语表查：正文里还残留着哪些不该用的写法"
          onClick={() => {
            const problems: string[] = [];
            for (const rule of glossary.split(/[;；]/)) {
              const [right, wrongs] = rule.split("|");
              if (!right?.trim() || !wrongs) continue;
              for (const wrong of wrongs.split(/[,，]/)) {
                const bad = wrong.trim();
                if (!bad) continue;
                const count = text.split(bad).length - 1;
                if (count > 0) problems.push(`「${bad}」出现 ${count} 次，该写成「${right.trim()}」`);
              }
            }
            setCheckReport(problems.length ? problems.join("\n") : "术语都对，没发现该换的写法。");
          }}
        >
          查术语
        </button>
        <button
          type="button"
          disabled={checking || text.length < 200}
          title="让模型看一遍：称呼、数字、说法前后打架的地方"
          onClick={async () => {
            setChecking(true);
            setCheckReport("");
            try {
              const outcome = await window.kaiLocal.checkCanvasConsistency(text);
              setCheckReport(outcome.ok ? (outcome.report || "") : (outcome.message || "没检查成"));
            } finally {
              setChecking(false);
            }
          }}
        >
          {checking ? "检查中…" : "查一致性"}
        </button>
        <button
          type="button"
          title="存成 Markdown 文件"
          onClick={async () => {
            const { safeFileName } = await import("../lib/filename.ts");
            const blob = new Blob([text], { type: "text/markdown" });
            const anchor = document.createElement("a");
            anchor.href = URL.createObjectURL(blob);
            anchor.download = safeFileName(title, "md");
            anchor.click();
            URL.revokeObjectURL(anchor.href);
          }}
        >
          存 .md
        </button>
        <button
          type="button"
          title="存成 Word 文档"
          onClick={async () => {
            const { textToDocx } = await import("../lib/docx.ts");
            const { safeFileName } = await import("../lib/filename.ts");
            const bytes = textToDocx(text);
            const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = safeFileName(title, "docx");
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          存 Word
        </button>
        <button
          type="button"
          title="存成 PDF"
          onClick={async () => {
            const { renderAnswerHtml } = await import("../lib/export-document.tsx");
            const { safeFileName } = await import("../lib/filename.ts");
            const body = renderAnswerHtml(text);
            const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
              body{max-width:44rem;margin:0 auto;padding:3rem 1.5rem;font:15px/1.9 -apple-system,"PingFang SC",sans-serif;color:#181816;background:#fff}
              pre{overflow-x:auto;padding:12px;border:1px solid #ddd;border-radius:6px;background:#f8f5ee}
            </style></head><body>${body}</body></html>`;
            const outcome = await window.kaiLocal.exportPdf({ html, fileName: safeFileName(title, "pdf") });
            if (!outcome.ok && !outcome.cancelled) setError(outcome.message || "PDF 没导出成功");
          }}
        >
          存 PDF
        </button>
      </div>

      {checkReport && (
        <pre className="canvas-report">{checkReport}</pre>
      )}

      <footer className="canvas-actions">
        <button
          type="button"
          disabled={!history.length || Boolean(requestId)}
          onClick={() => {
            setHistory((current) => {
              const previous = current.at(-1);
              if (previous === undefined) return current;
              setText(previous.text);
              return current.slice(0, -1);
            });
          }}
        >
          <Undo2 size={13} /> 撤销上一次改写
        </button>
        {requestId ? (
          <button type="button" onClick={() => window.kaiLocal.cancelMessage(requestId)}>
            <CircleStop size={13} /> 停止
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制全文"}
            </button>
            <button
              type="button"
              onClick={() => {
                const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = `${title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "kaii"}.md`;
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download size={13} /> 另存为
            </button>
          </>
        )}
      </footer>
    </aside>
  );
}
