import { LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { recentTopics, summarizeUsage } from "../lib/usage.ts";
import type { Conversation } from "../types";
import MarkdownLite from "./MarkdownLite";

function formatCharacters(count: number): string {
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)} 万字`;
  return `${count} 字`;
}

// 回顾：这些天在用什么、聊了什么。
//
// 用量部分只数自己看得见的（几次、多少字），**不估钱**——
// 各家价格随时在变，写死一个数字迟早是错的，而误导比不给更糟。
export default function ReviewPanel({
  conversations,
  onClose,
  onSummarize,
}: {
  conversations: Conversation[];
  onClose: () => void;
  onSummarize: (topics: string[]) => Promise<string>;
}) {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const usage = useMemo(() => summarizeUsage(conversations, days), [conversations, days]);
  const topics = useMemo(() => recentTopics(conversations, 7), [conversations]);
  const maxTurns = Math.max(1, ...usage.byModel.map((item) => item.turns));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="review-panel" role="dialog" aria-modal="true" aria-label="回顾">
        <header>
          <div>
            <h2>回顾</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="review-range">
          {[7, 30, 90].map((option) => (
            <button
              type="button"
              key={option}
              className={days === option ? "on" : ""}
              onClick={() => setDays(option)}
            >
              最近 {option} 天
            </button>
          ))}
        </div>

        <div className="review-body">
          <div className="review-stats">
            <div><b>{usage.turns}</b><span>次回答</span></div>
            <div><b>{usage.conversations}</b><span>段对话</span></div>
            <div><b>{formatCharacters(usage.characters)}</b><span>总共写了</span></div>
            {usage.busiestDay && (
              <div><b>{usage.busiestDay.date.slice(5)}</b><span>最忙的一天（{usage.busiestDay.turns} 次）</span></div>
            )}
          </div>

          {usage.byModel.length > 0 && (
            <div className="review-models">
              <div className="section-label">用了哪几个模型</div>
              {usage.byModel.map((item) => (
                <div className="review-model-row" key={item.label}>
                  <span>{item.label}</span>
                  <div className="review-bar"><i style={{ width: `${(item.turns / maxTurns) * 100}%` }} /></div>
                  <b>{item.turns}</b>
                </div>
              ))}
              <small>费用以各服务商账单为准。</small>
            </div>
          )}

          <div className="review-summary">
            <div className="section-label">这周聊了什么</div>
            {summary ? (
              <div className="review-summary-body"><MarkdownLite content={summary} /></div>
            ) : (
              <p className="review-hint">
                {topics.length
                  ? `这周有 ${topics.length} 段对话，可以生成一份小结。`
                  : "这周还没聊过什么。"}
              </p>
            )}
            {error && <p className="review-error" role="alert">{error}</p>}
            <button
              type="button"
              disabled={busy || !topics.length}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  setSummary(await onSummarize(topics));
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "没总结出来");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
              {summary ? "重新生成" : "生成小结"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
