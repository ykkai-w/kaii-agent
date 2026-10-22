import { FolderPlus, Library, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { KnowledgeLibrary } from "../types";

function whenIndexed(indexedAt: number): string {
  if (!indexedAt) return "还没建索引";
  const minutes = Math.round((Date.now() - indexedAt) / 60_000);
  if (minutes < 1) return "刚建好";
  if (minutes < 60) return `${minutes} 分钟前建的`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前建的`;
  return `${Math.round(hours / 24)} 天前建的`;
}

export default function KnowledgePanel({
  libraries,
  onClose,
  onAdd,
  onRemove,
  onToggle,
  onIndex,
  onLibrariesChange,
}: {
  libraries: KnowledgeLibrary[];
  onClose: () => void;
  onAdd: () => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onIndex: (id: string) => Promise<void>;
  onLibrariesChange: (libraries: KnowledgeLibrary[]) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ id: string; done: number; total: number; current: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 检索预览：拿个问题试试，看会翻出哪几段。
  const [probe, setProbe] = useState("");
  const [probeHits, setProbeHits] = useState<
    { index: number; library: string; file: string; label: string; excerpt?: string }[] | null
  >(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const off = window.kaiLocal.onKnowledgeProgress((payload) => {
      setProgress({ id: payload.libraryId, done: payload.done, total: payload.total, current: payload.current });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      off();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这一步没成功");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="knowledge-panel" role="dialog" aria-modal="true" aria-label="知识库">
        <header>
          <div>
            <h2>知识库</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭知识库" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="knowledge-list">
          {libraries.length ? libraries.map((library) => (
            <article key={library.id} className={library.enabled ? "" : "off"}>
              <div className="knowledge-head">
                <Library size={15} />
                <div>
                  <strong>{library.label}</strong>
                  <small>{library.path}</small>
                </div>
                <label className="knowledge-switch">
                  <input
                    type="checkbox"
                    checked={library.enabled}
                    onChange={(event) => void run(library.id, () => onToggle(library.id, event.target.checked))}
                  />
                  <span>提问时用</span>
                </label>
              </div>

              <div className="knowledge-meta">
                {library.exists
                  ? `${library.fileCount} 份文件 · ${library.sectionCount} 段${
                      library.characters ? ` · 约 ${Math.round(library.characters / 10000)} 万字` : ""
                    } · ${whenIndexed(library.indexedAt)}`
                  : "这个文件夹找不到了，可能被移走或改名了"}
                {library.skipped.length ? ` · ${library.skipped.length} 份没读成` : ""}
                {library.stale ? <b className="knowledge-stale">文件夹里有更新，建议重建索引</b> : null}
              </div>

              <div className="knowledge-excludes">
                <input
                  defaultValue={(library.excludes || []).join("、")}
                  placeholder="不想被搜到的目录名，比如：草稿、旧版（顿号分隔）"
                  aria-label="排除规则"
                  onBlur={(event) => {
                    const excludes = event.target.value.split(/[、,，\s]+/).map((name) => name.trim()).filter(Boolean);
                    if (excludes.join("|") === (library.excludes || []).join("|")) return;
                    void window.kaiLocal.setKnowledgeExcludes(library.id, excludes).then(onLibrariesChange);
                  }}
                />
              </div>

              {busy === library.id && progress?.id === library.id && (
                <div className="knowledge-progress">
                  <LoaderCircle className="spin" size={12} /> {progress.done}/{progress.total} 正在读 {progress.current}
                </div>
              )}

              {library.skipped.length > 0 && (
                <details className="knowledge-skipped">
                  <summary>没读成的 {library.skipped.length} 份</summary>
                  <ul>
                    {library.skipped.slice(0, 12).map((item) => (
                      <li key={item.path}><b>{item.path}</b>：{item.reason}</li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="knowledge-actions">
                <button
                  type="button"
                  disabled={busy === library.id || !library.exists}
                  onClick={() => void run(library.id, () => onIndex(library.id))}
                >
                  <RefreshCw size={13} /> {library.indexedAt ? "重建索引" : "建索引"}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy === library.id}
                  onClick={() => {
                    // 用户最怕的是「会不会把我的文件删了」。先把这句话讲明白。
                    if (!window.confirm(`把「${library.label}」从知识库里移走？只删索引，文件夹里的文件一个都不动。想再用就重新加一次、重建索引。`)) return;
                    void run(library.id, () => onRemove(library.id));
                  }}
                >
                  <Trash2 size={13} /> 移除
                </button>
              </div>
            </article>
          )) : (
            <div className="knowledge-blank">
              <Library size={28} />
              <strong>还没有知识库</strong>
              <p>选择资料文件夹。</p>
            </div>
          )}
        </div>

        {error && <p className="knowledge-error" role="alert">{error}</p>}

        {libraries.some((library) => library.indexedAt) && (
          <div className="knowledge-probe">
            <div className="knowledge-probe-bar">
              <input
                value={probe}
                placeholder="试一个问题，看会翻出哪几段"
                onChange={(event) => setProbe(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !probe.trim()) return;
                  setProbing(true);
                  void window.kaiLocal.previewKnowledge(probe.trim())
                    .then(setProbeHits)
                    .catch(() => setProbeHits([]))
                    .finally(() => setProbing(false));
                }}
              />
              {probing && <LoaderCircle className="spin" size={13} />}
            </div>
            {probeHits && (
              probeHits.length ? (
                <ul>
                  {probeHits.map((hit) => (
                    <li key={hit.index}>
                      <b>{hit.file} · {hit.label}</b>
                      <span>{hit.excerpt}…</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="knowledge-probe-blank">
                  这个问题在知识库里什么都没翻到。检索按词的字面匹配来找，换成文档里真实出现的说法再试试。
                </p>
              )
            )}
            <small>预览走的是提问时同一条检索路径，看到的就是真会送给模型的段落。</small>
          </div>
        )}

        <footer>
          <button type="button" onClick={() => void run("add", onAdd)} disabled={busy === "add"}>
            <FolderPlus size={14} /> 选一个文件夹
          </button>
          {libraries.filter((library) => library.exists && library.indexedAt).length > 1 && (
            <button
              type="button"
              disabled={Boolean(busy)}
              title="挨个重建所有库的索引，文件多的话要等一会"
              onClick={async () => {
                // 串行做：并行建索引会同时开一堆解析进程，机器会卡。
                for (const library of libraries.filter((item) => item.exists && item.indexedAt)) {
                  await run(library.id, () => onIndex(library.id));
                }
              }}
            >
              <RefreshCw size={14} /> 全部重建
            </button>
          )}
          <small>索引保存在本机。使用云端模型时，命中的段落会发送给对应服务；原文件不会修改。</small>
        </footer>
      </section>
    </div>
  );
}
