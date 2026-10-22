import { Bookmark, ExternalLink, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SavedPage } from "../types";

function whenSaved(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return "刚存的";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} 天前` : `${Math.round(days / 30)} 个月前`;
}

// 存网页：看到想细看的文章先存下来，回头再问。
// 存的是当场抓下来的正文，不是链接——原网页删了改了都不影响。
export default function ReadLaterPanel({
  pages,
  onClose,
  onChange,
  onAttach,
}: {
  pages: SavedPage[];
  onClose: () => void;
  onChange: (pages: SavedPage[]) => void;
  onAttach: (page: SavedPage) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? pages.filter((page) => (
      page.title.toLowerCase().includes(needle)
      || (page.summary || "").toLowerCase().includes(needle)
      || (page.tags || []).some((tag) => tag.toLowerCase().includes(needle))
    ))
    : pages;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const save = async () => {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    const outcome = await window.kaiLocal.saveWebPage(target);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message || "没存下来");
      return;
    }
    if (outcome.items) onChange(outcome.items);
    setUrl("");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="readlater-panel" role="dialog" aria-modal="true" aria-label="存下来的网页">
        <header>
          <div>
            <h2>网页</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="readlater-add">
          <input
            value={url}
            placeholder="粘一个网址进来"
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
          <button type="button" disabled={busy || !url.trim()} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />} 存下来
          </button>
        </div>

        {error && <p className="readlater-error" role="alert">{error}</p>}

        {pages.length > 5 && (
          <div className="readlater-add readlater-filter">
            <input
              value={filter}
              placeholder="在存档里找（标题 / 摘要 / 标签）"
              onChange={(event) => setFilter(event.target.value)}
            />
            {needle && <small>{shown.length} / {pages.length}</small>}
          </div>
        )}

        {pages.length >= 3 && (
          <div className="readlater-bulk">
            <button
              type="button"
              title="每篇一个 .md 打包成 zip，正文都在里面"
              onClick={async () => {
                const { buildZip } = await import("../lib/docx.ts");
                const encoder = new TextEncoder();
                const entries: { name: string; data: Uint8Array }[] = [];
                for (const page of pages) {
                  const text = await window.kaiLocal.savedPageText(page.id);
                  if (!text) continue;
                  const clean = page.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
                  entries.push({
                    name: `${clean || page.id}.md`,
                    data: encoder.encode(`# ${page.title}\n\n> 来源：${page.url}\n\n${text}`),
                  });
                }
                if (!entries.length) {
                  setError("没有能导出的正文。");
                  return;
                }
                const bytes = buildZip(entries);
                const anchor = document.createElement("a");
                anchor.href = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" }));
                anchor.download = `网页存档-${new Date().toISOString().slice(0, 10)}.zip`;
                anchor.click();
                URL.revokeObjectURL(anchor.href);
              }}
            >
              全部导出 zip
            </button>
            <button
              type="button"
              onClick={async () => {
                const outcome = await window.kaiLocal.savedPagesToKnowledge();
                setError(outcome.ok ? `已将 ${outcome.count} 篇加入知识库，请前往知识库建立索引。` : (outcome.message || "加不进去"));
              }}
            >
              加入知识库
            </button>
            <small>建立索引后可统一搜索。</small>
          </div>
        )}

        <div className="readlater-list">
          {shown.length ? shown.map((page) => (
            <article key={page.id}>
              <div className="readlater-head">
                <Bookmark size={14} />
                <div>
                  <strong>{page.title}</strong>
                  <small>{whenSaved(page.savedAt)} · {page.characters} 字 · {new URL(page.url).hostname}</small>
                </div>
              </div>
              {page.summary
                ? <p className="readlater-summary">{page.summary}</p>
                : <p className="readlater-excerpt">{page.excerpt}…</p>}
              {(page.tags || []).length > 0 && (
                <div className="readlater-tags">
                  {(page.tags || []).map((tag) => <i key={tag}>{tag}</i>)}
                </div>
              )}
              <div className="readlater-actions">
                <button type="button" onClick={() => onAttach(page)}>拿来问</button>
                <button
                  type="button"
                  onClick={() => {
                    const tag = window.prompt("加个什么标签？（再输一次同样的就是去掉）", "");
                    if (tag === null || !tag.trim()) return;
                    const current = page.tags || [];
                    const next = current.includes(tag.trim())
                      ? current.filter((item) => item !== tag.trim())
                      : [...current, tag.trim()];
                    void window.kaiLocal.setSavedPageTags(page.id, next).then(onChange);
                  }}
                >
                  标签
                </button>
                <button
                  type="button"
                  title="把存下来的正文导出成 Markdown 文件"
                  onClick={async () => {
                    const text = await window.kaiLocal.savedPageText(page.id);
                    if (!text) {
                      setError("这篇的正文文件不在了。");
                      return;
                    }
                    const body = `# ${page.title}\n\n> 来源：${page.url}\n> 存于：${new Date(page.savedAt).toLocaleString("zh-CN")}\n\n${text}`;
                    const blob = new Blob([body], { type: "text/markdown" });
                    const anchor = document.createElement("a");
                    anchor.href = URL.createObjectURL(blob);
                    anchor.download = `${page.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.md`;
                    anchor.click();
                    URL.revokeObjectURL(anchor.href);
                  }}
                >
                  导出 .md
                </button>
                <button type="button" onClick={() => window.open(page.url, "_blank")}>
                  <ExternalLink size={12} /> 打开原网页
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void window.kaiLocal.removeSavedPage(page.id).then(onChange)}
                >
                  <Trash2 size={12} /> 删掉
                </button>
              </div>
            </article>
          )) : pages.length ? (
            <div className="readlater-blank">
              <Bookmark size={26} />
              <strong>没有匹配的存档</strong>
              <p>换个词试试。</p>
            </div>
          ) : (
            <div className="readlater-blank">
              <Bookmark size={26} />
              <strong>还没存过网页</strong>
              <p>保存正文。使用云端模型时会发送相关内容。</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
