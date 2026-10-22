import { Check, CircleStop, Copy, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelState, QuickActionInfo, QuickState } from "./types";

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 复制走的这一段文字不是指令，是素材。界面上也要让用户看清楚它到底拿到了什么。
export default function QuickPanel() {
  const [state, setState] = useState<QuickState | null>(null);
  const [clip, setClip] = useState("");
  const [modelState, setModelState] = useState<ModelState | null>(null);
  const [activeAction, setActiveAction] = useState<QuickActionInfo | null>(null);
  const [result, setResult] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const streamId = useRef<string | null>(null);
  const resultBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let mounted = true;
    window.kaiLocal.getQuickState().then((incoming) => {
      if (!mounted) return;
      setState(incoming);
      setClip(incoming.clip);
      setModelState(incoming.modelState);
    }).catch((caught) => {
      if (mounted) setError(caught?.message || "快捷面板没有打开成功");
    });

    // 浮窗是复用的：每次按快捷键都会带来新的剪贴板内容，要重置成初始状态。
    const offClip = window.kaiLocal.onQuickClip(({ text }) => {
      setClip(text);
      setResult("");
      setActiveAction(null);
      setError(null);
      setCopied(false);
      streamId.current = null;
      setRequestId(null);
    });
    const offStatus = window.kaiLocal.onModelStatus(setModelState);
    const offChunk = window.kaiLocal.onChatChunk(({ requestId: incoming, content }) => {
      if (streamId.current !== incoming) return;
      setResult((current) => current + content);
    });
    const finish = (incoming: string, message?: string) => {
      if (streamId.current !== incoming) return;
      if (message) setError(message);
      streamId.current = null;
      setRequestId(null);
    };
    const offDone = window.kaiLocal.onChatDone(({ requestId: incoming }) => finish(incoming));
    const offError = window.kaiLocal.onChatError(({ requestId: incoming, message }) => finish(incoming, message));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void window.kaiLocal.closeQuickWindow();
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      mounted = false;
      offClip();
      offStatus();
      offChunk();
      offDone();
      offError();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    const node = resultBox.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [result]);

  const run = useCallback(async (action: QuickActionInfo) => {
    if (requestId || !clip) return;
    setActiveAction(action);
    setResult("");
    setError(null);
    setCopied(false);
    const incoming = randomId("quick");
    streamId.current = incoming;
    setRequestId(incoming);
    try {
      const outcome = await window.kaiLocal.runQuickAction({ requestId: incoming, action: action.id, text: clip });
      if (!outcome.ok && outcome.message) {
        setError(outcome.message);
        streamId.current = null;
        setRequestId(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这次处理没有完成");
      streamId.current = null;
      setRequestId(null);
    }
  }, [clip, requestId]);

  const copyResult = useCallback(async () => {
    if (!result.trim()) return;
    await window.kaiLocal.copyQuickResult(result.trim());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [result]);

  if (error && !state) {
    return <div className="quick-shell"><p className="quick-error">{error}</p></div>;
  }
  if (!state) {
    return <div className="quick-shell quick-loading"><LoaderCircle className="spin" size={16} /> 正在打开</div>;
  }

  return (
    <div className="quick-shell">
      <header className="quick-head">
        <div className="quick-drag" />
        <strong>快捷处理</strong>
        <span>{modelState?.status === "ready" ? "模型就绪" : "发送时会启动模型"}</span>
        <button type="button" aria-label="关闭" onClick={() => window.kaiLocal.closeQuickWindow()}><X size={15} /></button>
      </header>

      {clip ? (
        <>
          <section className="quick-clip" aria-label="剪贴板内容">
            <div className="quick-clip-label">剪贴板里的文字（{clip.length} 字）</div>
            <p>{clip.length > 400 ? `${clip.slice(0, 400)}…` : clip}</p>
          </section>

          <section className="quick-actions" aria-label="可以做的处理">
            {state.actions.map((action) => (
              <button
                type="button"
                key={action.id}
                className={activeAction?.id === action.id ? "active" : ""}
                disabled={Boolean(requestId)}
                title={action.hint}
                onClick={() => run(action)}
              >
                {action.label}
              </button>
            ))}
          </section>

          {(result || requestId || error) && (
            <section className="quick-result" aria-label="处理结果">
              <div className="quick-result-head">
                <span>
                  {activeAction ? activeAction.label : "结果"}
                  {result.trim() && !requestId ? <i className="quick-result-count">{result.trim().length} 字</i> : null}
                </span>
                {requestId ? (
                  <button type="button" onClick={() => window.kaiLocal.cancelMessage(requestId)}>
                    <CircleStop size={13} /> 停止
                  </button>
                ) : result.trim() ? (
                  <button type="button" onClick={copyResult}>
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制结果"}
                  </button>
                ) : null}
              </div>
              <div className="quick-result-body" ref={resultBox}>
                {result || (requestId ? <span className="thinking"><i /><i /><i /></span> : null)}
              </div>
              {error && <p className="quick-error">{error}</p>}
            </section>
          )}
        </>
      ) : (
        <section className="quick-empty">
          <p>剪贴板里现在没有文字。</p>
          <p className="quick-empty-hint">
            先在任何地方选中文字按 <b>⌘C</b> 复制，再按 <b>{state.hotkeys.find((item) => item.id === state.hotkey)?.label || state.hotkey}</b> 叫出这个面板。
          </p>
        </section>
      )}
    </div>
  );
}
