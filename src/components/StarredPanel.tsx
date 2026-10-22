import { Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../types";
import MarkdownLite from "./MarkdownLite";

// 收藏夹：把加过星的回答集中放一起。
// 一段有用的回答被埋在三个月前的某段对话里，靠搜索词想不起来该搜什么，
// 加星的那一刻就是最好的索引。
export default function StarredPanel({
  conversations,
  onClose,
  onJump,
  onUnstar,
}: {
  conversations: Conversation[];
  onClose: () => void;
  onJump: (conversationId: string, messageId: string) => void;
  onUnstar: (conversationId: string, messageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => conversations.flatMap((conversation) => (
    conversation.messages
      .filter((message) => message.starred && message.content.trim())
      .map((message) => ({ conversation, message }))
  // 新收藏的排前面。
  )).sort((a, b) => b.message.createdAt - a.message.createdAt), [conversations]);

  // 收藏攒到几十条之后，翻不如搜。搜正文也搜它所在对话的标题。
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((item) => (
      item.message.content.toLowerCase().includes(needle)
      || item.conversation.title.toLowerCase().includes(needle)
    ));
  }, [all, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="starred-panel" role="dialog" aria-modal="true" aria-label="收藏">
        <header>
          <div>
            <h2>收藏</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        {all.length > 5 && (
          <div className="starred-search">
            <input
              value={query}
              placeholder="在收藏里找"
              aria-label="在收藏里找"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query.trim() && <small>{items.length} / {all.length}</small>}
          </div>
        )}

        <div className="starred-list">
          {items.length ? items.map(({ conversation, message }) => (
            <article key={message.id}>
              <div className="starred-head">
                <button
                  type="button"
                  className="starred-source"
                  title="跳到这段对话"
                  onClick={() => onJump(conversation.id, message.id)}
                >
                  {conversation.title || "未命名对话"}
                </button>
                <span>{new Date(message.createdAt).toLocaleDateString("zh-CN")}</span>
                <button
                  type="button"
                  className="starred-remove"
                  aria-label="取消收藏"
                  title="取消收藏"
                  onClick={() => onUnstar(conversation.id, message.id)}
                >
                  <Star size={13} />
                </button>
              </div>
              <div className="starred-body">
                <MarkdownLite content={message.content.length > 1200
                  ? `${message.content.slice(0, 1200)}\n\n（后面还有，点标题跳过去看全文）`
                  : message.content} />
              </div>
            </article>
          )) : (
            <div className="starred-blank">
              <Star size={26} />
              <strong>还没有收藏</strong>
              <p>点回答下方的星号即可收藏。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
