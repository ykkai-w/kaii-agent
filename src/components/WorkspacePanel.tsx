import { CircleAlert, FilePlus2, FolderOpen, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, WorkspaceDetail, WorkspaceState } from "../types";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function WorkspacePanel({
  state,
  onStateChange,
  onClose,
  allowedCommands,
}: {
  state: WorkspaceState;
  onStateChange: (next: WorkspaceState) => void;
  onClose: () => void;
  allowedCommands: string[];
}) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const active = state.roots.find((root) => root.id === state.activeId) || null;

  const refreshDetail = useCallback(async () => {
    if (!state.activeId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await window.kaiLocal.getWorkspaceSummary(state.activeId));
    } catch (caught) {
      setDetail(null);
      setError(caught instanceof Error ? caught.message : "读取工作区失败");
    }
  }, [state.activeId]);

  const refreshAudit = useCallback(async () => {
    try {
      setAudit(await window.kaiLocal.listToolCalls(30));
    } catch {
      setAudit([]);
    }
  }, []);

  useEffect(() => {
    void refreshDetail();
    void refreshAudit();
  }, [refreshAudit, refreshDetail]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这一步没有成功");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="workspace-panel" role="dialog" aria-modal="true" aria-label="kaii-agent 项目工作区">
        <header>
          <div>
            <h2>工作区</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭项目面板" onClick={onClose}><X size={18} /></button>
        </header>

        <p className="panel-note">
          kaii-agent 只访问已授权的文件夹，默认只读。打开“允许改写”后才可改文件和运行白名单命令。使用云端模型时，读取内容会发送给对应服务。
        </p>

        <div className="workspace-actions">
          <button type="button" disabled={busy} onClick={() => run(async () => {
            const next = await window.kaiLocal.chooseWorkspace();
            if (next) {
              onStateChange(next);
              setNotice("已授权。默认只读。");
            }
          })}>
            <FolderOpen size={15} /> 选择文件夹
          </button>
          {active && (
            <button type="button" disabled={busy || !active.writable} title={active.writable ? "在项目根目录生成 KAII.md" : "先打开允许改写"} onClick={() => run(async () => {
              const result = await window.kaiLocal.initProjectNotes(active.id);
              setNotice(`已生成 ${result.path}。工程模式会读取这份说明。`);
              await refreshDetail();
            })}>
              <FilePlus2 size={15} /> 生成 KAII.md
            </button>
          )}
        </div>

        {error && <p className="panel-error" role="alert"><CircleAlert size={14} /> {error}</p>}
        {notice && <p className="panel-notice">{notice}</p>}

        <div className="workspace-list">
          {state.roots.length === 0 && <div className="workspace-empty">还没有授权任何文件夹。</div>}
          {state.roots.map((root) => (
            <article className={`workspace-row ${root.id === state.activeId ? "active" : ""}`} key={root.id}>
              <button className="workspace-pick" type="button" onClick={() => run(async () => {
                onStateChange(await window.kaiLocal.setActiveWorkspace(root.id));
              })}>
                <strong>{root.label}{root.id === state.activeId ? " · 当前" : ""}</strong>
                <small>{root.path}</small>
                {!root.exists && <small className="workspace-missing">这个文件夹已经不在了</small>}
              </button>
              <label className="workspace-write">
                <input
                  type="checkbox"
                  checked={root.writable}
                  onChange={(event) => run(async () => {
                    onStateChange(await window.kaiLocal.setWorkspaceWritable(root.id, event.target.checked));
                  })}
                />
                <span>允许改写</span>
              </label>
              <button className="workspace-remove" type="button" aria-label={`取消授权 ${root.label}`} onClick={() => run(async () => {
                onStateChange(await window.kaiLocal.removeWorkspace(root.id));
              })}>
                <Trash2 size={14} />
              </button>
            </article>
          ))}
        </div>

        {detail && (
          <div className="workspace-detail">
            <h3>{detail.label} 的索引</h3>
            <p>
              {detail.summary.fileCount} 个文件{detail.summary.truncated ? "（已达索引上限）" : ""}，
              合计 {formatBytes(detail.summary.totalBytes)}。
              主要类型：{detail.summary.topExtensions.slice(0, 6).map((item) => `${item.extension} ${item.count}`).join("，") || "无"}。
            </p>
            <p className="workspace-notes">
              {detail.projectNotes
                ? `工程模式会读取 ${detail.projectNotes.fileName}。`
                : "根目录可添加 KAII.md、CLAUDE.md、AGENTS.md 或 .kaii/NOTES.md。工程模式会读取其中一份。"}
            </p>
            <p className="workspace-commands">可运行：{allowedCommands.join("、")}；git 仅限只读子命令。</p>
          </div>
        )}

        <div className="workspace-audit">
          <h3>最近的工具记录</h3>
          {audit.length === 0 && <div className="workspace-empty">还没有任何工具调用。</div>}
          {audit.map((entry) => (
            <article className={`audit-row audit-${entry.status}`} key={entry.id}>
              <div>
                <strong>{entry.tool}</strong>
                <small>{entry.summary || entry.status}</small>
                <small className="audit-time">{formatTime(entry.createdAt)}</small>
              </div>
              {entry.snapshotPath && !entry.rolledBack && (
                <button type="button" disabled={busy} onClick={() => run(async () => {
                  await window.kaiLocal.rollbackToolCall(entry.id);
                  setNotice(`已撤销对 ${entry.changedPath} 的改动。`);
                  await refreshAudit();
                })}>
                  <RotateCcw size={13} /> 撤销
                </button>
              )}
              {entry.rolledBack && <span className="audit-rolled">已撤销</span>}
            </article>
          ))}
        </div>

        {busy && <div className="workspace-busy"><LoaderCircle className="spin" size={16} /> 正在处理</div>}
      </section>
    </div>
  );
}
