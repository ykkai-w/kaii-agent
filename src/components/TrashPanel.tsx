import { RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Conversation } from "../types";
import { TRASH_DAYS, isInTrash } from "../lib/organize.ts";

function daysLeft(deletedAt: number): number {
  return Math.max(0, TRASH_DAYS - Math.floor((Date.now() - deletedAt) / 86_400_000));
}

// 回收站。
//
// 删除改成两步不是为了流程好看：手滑删掉一段聊了两小时的对话是不可逆的损失，
// 而多按一次「彻底删除」的代价几乎为零。这个不对称决定了该做两步。
export default function TrashPanel({
  conversations,
  onClose,
  onRestore,
  onPurge,
}: {
  conversations: Conversation[];
  onClose: () => void;
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  // 一键清空走双重确认：清空是 N 次不可逆删除的叠加，值得多问一句。
  const [query, setQuery] = useState("");
  const all = conversations
    .filter(isInTrash)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  // 删了三十天内都能捞回来，攒到几十条时得能搜。标题和正文一起搜。
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((item) => (
      (item.title || "").toLowerCase().includes(needle)
      || item.messages.some((message) => message.content.toLowerCase().includes(needle))
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
      <section className="trash-panel" role="dialog" aria-modal="true" aria-label="回收站">
        <header>
          <div>
            <h2>回收站</h2>
          </div>
          {all.length > 1 && !query.trim() && (
            <button
              type="button"
              className="trash-empty-all"
              onClick={() => {
                // 一律对「全部」动手，不受搜索框影响：写着「清空」却只删筛出来的那几条，
                // 是最容易让人误删（或误以为删了）的一种写法。
                if (!window.confirm(`彻底删掉回收站里的全部 ${all.length} 段对话？删了就真没了。`)) return;
                if (!window.confirm("再确认一次：全部彻底删除，无法恢复。")) return;
                for (const item of all) onPurge(item.id);
              }}
            >
              <Trash2 size={12} /> 清空（{all.length}）
            </button>
          )}
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        {all.length > 5 && (
          <div className="starred-search">
            <input
              value={query}
              placeholder="在回收站里找"
              aria-label="在回收站里找"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query.trim() && <small>{items.length} / {all.length}</small>}
          </div>
        )}

        <div className="trash-list">
          {items.length ? items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title || "未命名对话"}</strong>
                <small>
                  {item.messages.length} 条 · {new Date(item.deletedAt ?? 0).toLocaleDateString("zh-CN")} 删的
                  {" · "}还剩 {daysLeft(item.deletedAt ?? 0)} 天
                </small>
              </div>
              <button type="button" title="放回列表" onClick={() => onRestore(item.id)}>
                <RotateCcw size={12} /> 捞回来
              </button>
              <button
                type="button"
                className="danger"
                title="这一步不可逆"
                onClick={() => {
                  // 彻底删除是真的没了，问一句。
                  if (window.confirm(`彻底删掉「${item.title || "未命名对话"}」？这一步撤不回来。`)) {
                    onPurge(item.id);
                  }
                }}
              >
                <Trash2 size={12} /> 彻底删
              </button>
            </article>
          )) : (
            <div className="trash-blank">
              <Trash2 size={26} />
              <strong>回收站是空的</strong>
              <p>删掉的对话会先放这里 {TRASH_DAYS} 天，期间随时能捞回来。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
