import { LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DocumentAttachment } from "../types";

interface Outline {
  id: string;
  name: string;
  kind: string;
  truncated: boolean;
  sheetNames: string[];
  sections: { label: string; characters: number; preview: string }[];
}

// 文档结构一览：这份文档有几段、每段讲什么、在里面搜关键词、
// 多工作表的表格只挑一张。
//
// 长文档的正确用法是先看结构再问，而不是把整份倒给模型碰运气。
export default function DocumentPeek({
  attachment,
  onClose,
  onPickSheet,
  onFocusSection,
}: {
  attachment: DocumentAttachment;
  onClose: () => void;
  onPickSheet: (sheetName: string) => Promise<void>;
  onFocusSection: (label: string) => Promise<void>;
}) {
  const [outline, setOutline] = useState<Outline | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ label: string; excerpt: string }[]>([]);
  const [busySheet, setBusySheet] = useState("");

  useEffect(() => {
    void window.kaiLocal.documentOutline(attachment.id).then(setOutline).catch(() => setOutline(null));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [attachment.id, onClose]);

  // 搜索防抖：每敲一个字就搜一遍太吵。
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void window.kaiLocal.searchDocument(attachment.id, query.trim()).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [attachment.id, query]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="docpeek-panel" role="dialog" aria-modal="true" aria-label={`看看 ${attachment.name}`}>
        <header>
          <div>
            <h2>{attachment.name}</h2>
            <small>
              {outline ? `${outline.sections.length} 段` : "…"}
              {attachment.truncated ? " · 原文过长已截断" : ""}
            </small>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        {outline && outline.sheetNames.length > 1 && (
          <div className="docpeek-sheets">
            <span>这个文件有 {outline.sheetNames.length} 张工作表，可以只看一张：</span>
            <div>
              {outline.sheetNames.map((name) => (
                <button
                  type="button"
                  key={name}
                  className={attachment.sheetName === name ? "on" : ""}
                  disabled={Boolean(busySheet)}
                  onClick={async () => {
                    setBusySheet(name);
                    try {
                      await onPickSheet(name);
                    } finally {
                      setBusySheet("");
                    }
                  }}
                >
                  {busySheet === name ? <LoaderCircle className="spin" size={11} /> : null} {name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="docpeek-search">
          <Search size={13} />
          <input
            value={query}
            placeholder="在这份文档里找"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.trim() && <span>{hits.length} 处</span>}
        </div>

        <div className="docpeek-body">
          {query.trim() ? (
            hits.length ? hits.map((hit, index) => (
              <article key={index}>
                <b>{hit.label}</b>
                <p>…{hit.excerpt}…</p>
              </article>
            )) : <p className="docpeek-blank">没找到。搜的是提取出来的文字，扫描件里认不出的字搜不到。</p>
          ) : outline ? (
            outline.sections.map((section) => (
              <article key={section.label}>
                <b>
                  {section.label} <i>{section.characters} 字</i>
                  {outline.sections.length > 1 && (
                    <button
                      type="button"
                      className="docpeek-focus"
                      title="只把这一段挂上去问，别的段不带"
                      onClick={() => void onFocusSection(section.label)}
                    >
                      只问这段
                    </button>
                  )}
                </b>
                <p>{section.preview}…</p>
              </article>
            ))
          ) : (
            <p className="docpeek-blank">读不出这份文档的结构。</p>
          )}
        </div>
      </section>
    </div>
  );
}
