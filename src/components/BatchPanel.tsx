import { Check, CircleStop, Copy, Download, LoaderCircle, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { QuickActionInfo } from "../types";

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface BatchItem {
  id: string;
  input: string;
  output: string;
  status: "waiting" | "running" | "done" | "error";
  error?: string;
}

// 批量处理：同一件事要对十几段文字各做一遍时，一条条粘进聊天太蠢。
// 这里一次收一批，挨个跑，结果能整体复制或存成文件。
export default function BatchPanel({
  actions,
  onClose,
}: {
  actions: QuickActionInfo[];
  onClose: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [action, setAction] = useState(actions[0]?.id || "polish");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelled = useRef(false);
  const streamId = useRef<string | null>(null);
  const streamed = useRef("");

  useEffect(() => {
    const offChunk = window.kaiLocal.onChatChunk(({ requestId, content }) => {
      if (streamId.current === requestId) streamed.current += content;
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      offChunk();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, running]);

  // 空行分段是最自然的切法：从表格或文档里粘过来通常就是这个形状。
  const split = useCallback(() => {
    const parts = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    setItems(parts.slice(0, 40).map((part) => ({
      id: randomId("item"),
      input: part,
      output: "",
      status: "waiting" as const,
    })));
  }, [raw]);

  const run = useCallback(async () => {
    const targets = items.length ? items : [];
    if (!targets.length || running) return;
    cancelled.current = false;
    setRunning(true);

    for (const item of targets) {
      if (cancelled.current) break;
      setItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, status: "running", output: "", error: undefined } : entry
      )));
      const requestId = randomId("batch");
      streamId.current = requestId;
      streamed.current = "";
      try {
        const outcome = await window.kaiLocal.runQuickAction({ requestId, action, text: item.input });
        const produced = streamed.current.trim();
        setItems((current) => current.map((entry) => (
          entry.id !== item.id
            ? entry
            : outcome.ok && produced
              ? { ...entry, status: "done", output: produced }
              : { ...entry, status: "error", error: outcome.message || "这一条没有生成出内容" }
        )));
      } catch (error) {
        setItems((current) => current.map((entry) => (
          entry.id === item.id
            ? { ...entry, status: "error", error: error instanceof Error ? error.message : "这一条失败了" }
            : entry
        )));
      } finally {
        streamId.current = null;
      }
    }

    setRunning(false);
  }, [action, items, running]);

  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;
  const combined = items.filter((item) => item.output).map((item) => item.output).join("\n\n");

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !running && onClose()}>
      <section className="batch-panel" role="dialog" aria-modal="true" aria-label="批量处理">
        <header>
          <div>
            <h2>批量</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭批量处理" onClick={onClose} disabled={running}>
            <X size={18} />
          </button>
        </header>

        <div className="batch-setup">
          <textarea
            value={raw}
            placeholder={"把要处理的内容粘进来，空一行分成一条。\n\n比如十条产品描述，或者一份名单里的十段介绍。"}
            onChange={(event) => setRaw(event.target.value)}
            onBlur={split}
            disabled={running}
          />
          <div className="batch-controls">
            <select value={action} onChange={(event) => setAction(event.target.value)} disabled={running}>
              {actions.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
            </select>
            <button type="button" onClick={split} disabled={running || !raw.trim()}>分成 {items.length || "?"} 条</button>
            {running ? (
              <button type="button" className="danger" onClick={() => { cancelled.current = true; }}>
                <CircleStop size={13} /> 停下
              </button>
            ) : (
              <button type="button" className="primary" onClick={run} disabled={!items.length}>
                <Play size={13} /> 开始
              </button>
            )}
          </div>
        </div>

        {items.length > 0 && (
          <div className="batch-list">
            {items.map((item, index) => (
              <article key={item.id} className={`batch-${item.status}`}>
                <div className="batch-index">
                  {item.status === "running" ? <LoaderCircle className="spin" size={12} /> : index + 1}
                </div>
                <div className="batch-body">
                  <p className="batch-input">{item.input.length > 160 ? `${item.input.slice(0, 160)}…` : item.input}</p>
                  {item.output && <p className="batch-output">{item.output}</p>}
                  {item.error && <p className="batch-error">{item.error}</p>}
                </div>
              </article>
            ))}
          </div>
        )}

        <footer>
          <span>
            {items.length ? `${done} 条做完${failed ? `，${failed} 条失败` : ""}，共 ${items.length} 条` : "还没有内容"}
          </span>
          <button
            type="button"
            disabled={!combined}
            onClick={async () => {
              await navigator.clipboard.writeText(combined);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制结果"}
          </button>
          <button
            type="button"
            disabled={!combined}
            onClick={() => {
              const blob = new Blob([combined], { type: "text/plain;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = "批量结果.txt";
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={13} /> 存成文件
          </button>
        </footer>
      </section>
    </div>
  );
}
