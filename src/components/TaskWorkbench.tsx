import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Cloud,
  Download,
  FileSearch,
  FileText,
  FolderInput,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import "../task-workbench.css";

export type TaskWorkbenchEntry = "ask" | "materials" | "automation";
export type TaskWorkbenchStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type TaskWorkbenchLocation = "local" | "cloud" | "mixed";
export type TaskWorkbenchVerification = "verified" | "needs-review" | "unverified";
export type TaskWorkbenchAction = "continue" | "retry" | "project" | "knowledge" | "export" | "copy";

export interface TaskWorkbenchSource {
  id: string;
  label: string;
  detail?: string;
  kind?: "file" | "text" | "web" | "memory";
}

export interface TaskWorkbenchResult {
  id: string;
  title: string;
  conclusion: string;
  body?: string;
  sourceSummary: string;
  sources?: TaskWorkbenchSource[];
  runAt: string;
  location: TaskWorkbenchLocation;
  verification: TaskWorkbenchVerification;
}

export interface TaskWorkbenchTask {
  id: string;
  label: string;
  status: TaskWorkbenchStatus;
  progressLabel?: string;
}

export interface TaskWorkbenchPrivacyPreview {
  destination: string;
  summary: string;
  items: string[];
  warning?: string;
  payloadPreview?: string;
}

export interface TaskWorkbenchProps {
  activeEntry?: TaskWorkbenchEntry;
  tasks?: TaskWorkbenchTask[];
  results: TaskWorkbenchResult[];
  selectedResultId?: string | null;
  privacyPreview?: TaskWorkbenchPrivacyPreview | null;
  onEntryChange?: (entry: TaskWorkbenchEntry) => void;
  onResultSelect?: (resultId: string) => void;
  onAction?: (action: TaskWorkbenchAction, result: TaskWorkbenchResult) => void;
  onPrivacyConfirm?: () => void;
  onPrivacyCancel?: () => void;
  onClose?: () => void;
  className?: string;
}

const entries = [
  { id: "ask" as const, label: "直接问", hint: "得到一个清楚答案", icon: MessageCircle },
  { id: "materials" as const, label: "分析材料", hint: "读文件，留下依据", icon: FileSearch },
  { id: "automation" as const, label: "自动 / 批量", hint: "交给它做完再回来", icon: Workflow },
];

const statusLabel: Record<TaskWorkbenchStatus, string> = {
  queued: "排队中",
  running: "正在处理",
  waiting: "等你决定",
  done: "已完成",
  failed: "未完成",
};

const verificationLabel: Record<TaskWorkbenchVerification, string> = {
  verified: "已核对",
  "needs-review": "建议复核",
  unverified: "尚未核对",
};

const locationLabel: Record<TaskWorkbenchLocation, string> = {
  local: "仅本机",
  cloud: "云端处理",
  mixed: "本机 + 云端",
};

export default function TaskWorkbench({
  activeEntry = "ask",
  tasks = [],
  results,
  selectedResultId,
  privacyPreview,
  onEntryChange,
  onResultSelect,
  onAction,
  onPrivacyConfirm,
  onPrivacyCancel,
  onClose,
  className = "",
}: TaskWorkbenchProps) {
  const fallbackId = results[0]?.id ?? null;
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(selectedResultId ?? fallbackId);
  const [openSources, setOpenSources] = useState<Record<string, boolean>>({});
  const workbenchRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const privacyCancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const privacyVisible = Boolean(privacyPreview);

  useEffect(() => {
    if (selectedResultId !== undefined) setInternalSelectedId(selectedResultId);
  }, [selectedResultId]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget?.isConnected) requestAnimationFrame(() => restoreTarget.focus());
    };
  }, []);

  useEffect(() => {
    if (!onClose) return undefined;
    const workbench = workbenchRef.current;
    if (!workbench) return undefined;

    const focusInitialControl = () => {
      const target = privacyVisible
        ? privacyCancelRef.current
        : closeRef.current || workbench.querySelector<HTMLElement>("button:not([disabled])");
      target?.focus();
    };
    const frame = requestAnimationFrame(focusInitialControl);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onClose && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const focusable = Array.from(workbench.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((item) => item.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, privacyVisible]);

  useEffect(() => {
    if (internalSelectedId && results.some((result) => result.id === internalSelectedId)) return;
    setInternalSelectedId(fallbackId);
  }, [fallbackId, internalSelectedId, results]);

  const selected = useMemo(
    () => results.find((result) => result.id === internalSelectedId) ?? results[0] ?? null,
    [internalSelectedId, results],
  );

  const selectResult = (id: string) => {
    if (selectedResultId === undefined) setInternalSelectedId(id);
    onResultSelect?.(id);
  };

  const runAction = (action: TaskWorkbenchAction) => {
    if (selected) onAction?.(action, selected);
  };

  return (
    <section ref={workbenchRef} className={`task-workbench ${onClose ? "has-close" : ""} ${className}`} aria-label="任务与结果">
      {onClose && (
        <button ref={closeRef} className="task-workbench-close" type="button" aria-label="关闭任务与结果" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      )}

      {privacyPreview && (
        <aside className="privacy-preview" role="alert" aria-labelledby="privacy-preview-title">
          <div className="privacy-preview-icon"><Cloud size={18} /></div>
          <div className="privacy-preview-copy">
            <span className="workbench-kicker">发送预览</span>
            <h3 id="privacy-preview-title">这些内容将发送到 {privacyPreview.destination}</h3>
            <p>{privacyPreview.summary}</p>
            <ul>{privacyPreview.items.map((item) => <li key={item}>{item}</li>)}</ul>
            {privacyPreview.payloadPreview && (
              <pre className="privacy-payload" aria-label="实际发送内容">{privacyPreview.payloadPreview}</pre>
            )}
            {privacyPreview.warning && <strong className="privacy-warning">{privacyPreview.warning}</strong>}
          </div>
          <div className="privacy-preview-actions">
            <button ref={privacyCancelRef} type="button" onClick={onPrivacyCancel}>取消</button>
            <button type="button" className="primary" onClick={onPrivacyConfirm}>确认发送</button>
          </div>
        </aside>
      )}

      <nav className="task-workbench-entries" aria-label="开始一项任务">
        {entries.map(({ id, label, hint, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={activeEntry === id ? "is-active" : ""}
            aria-current={activeEntry === id ? "page" : undefined}
            onClick={() => onEntryChange?.(id)}
          >
            <Icon size={18} aria-hidden="true" />
            <span><strong>{label}</strong><small>{hint}</small></span>
          </button>
        ))}
      </nav>

      {tasks.length > 0 && (
        <div className="task-workbench-status" aria-label="任务状态">
          {tasks.map((task) => (
            <span className={`task-pill task-pill-${task.status}`} key={task.id}>
              <i aria-hidden="true" />
              <b>{task.label}</b>
              <small>{task.progressLabel || statusLabel[task.status]}</small>
            </span>
          ))}
        </div>
      )}

      <div className="task-workbench-grid">
        <section className="result-inbox" aria-labelledby="result-inbox-title">
          <header>
            <div>
              <span className="workbench-kicker">RESULTS</span>
              <h2 id="result-inbox-title">结果收件箱</h2>
            </div>
            <small>{results.length ? `${results.length} 份结果` : "空"}</small>
          </header>

          {results.length ? (
            <div className="result-inbox-list" role="group" aria-label="已完成的结果">
              {results.map((result) => (
                <button
                  type="button"
                  key={result.id}
                  className={selected?.id === result.id ? "is-selected" : ""}
                  aria-pressed={selected?.id === result.id}
                  aria-label={`${result.title}，${verificationLabel[result.verification]}，${locationLabel[result.location]}`}
                  onClick={() => selectResult(result.id)}
                >
                  <span className="result-card-head">
                    <strong>{result.title}</strong>
                    <time>{result.runAt}</time>
                  </span>
                  <span className="result-card-conclusion">{result.conclusion}</span>
                  <span className="result-card-meta">
                    <span><FileText size={12} />{result.sourceSummary}</span>
                    <span className={`location-${result.location}`}>
                      {result.location === "local" ? <ShieldCheck size={12} /> : <Cloud size={12} />}
                      {locationLabel[result.location]}
                    </span>
                    <span className={`verify-${result.verification}`}><CheckCircle2 size={12} />{verificationLabel[result.verification]}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="result-inbox-empty">
              <Archive size={25} />
              <strong>做完的事会放在这里</strong>
              <p>不必守着进度。完成后再回来查看结论和依据。</p>
            </div>
          )}
        </section>

        <article className="work-page" aria-label="工作页详情">
          {selected ? (
            <>
              <header className="work-page-head">
                <div>
                  <span className="workbench-kicker">WORK PAGE</span>
                  <h2>{selected.title}</h2>
                </div>
                <span className={`work-page-verification verify-${selected.verification}`}>
                  <CheckCircle2 size={13} />{verificationLabel[selected.verification]}
                </span>
              </header>

              <p className="work-page-lead">{selected.conclusion}</p>
              {selected.body && <div className="work-page-body">{selected.body}</div>}

              <div className="work-page-actions" aria-label="处理这份结果">
                <button type="button" className="primary" onClick={() => runAction("continue")}><MessageCircle size={14} />继续</button>
                <button type="button" onClick={() => runAction("retry")}><RefreshCw size={14} />准备重试</button>
                <button type="button" onClick={() => runAction("project")}><FolderInput size={14} />打开项目…</button>
                <button type="button" onClick={() => runAction("knowledge")}><Sparkles size={14} />放到输入区</button>
                <button type="button" onClick={() => runAction("export")}><Download size={14} />导出</button>
                <button type="button" onClick={() => runAction("copy")}><Clipboard size={14} />复制</button>
              </div>

              <section className="memory-evidence">
                <button
                  type="button"
                  aria-expanded={Boolean(openSources[selected.id])}
                  onClick={() => setOpenSources((current) => ({ ...current, [selected.id]: !current[selected.id] }))}
                >
                  <span><Bot size={14} /><strong>这份结果记住了什么</strong><small>{selected.sources?.length || 0} 条可质证来源</small></span>
                  <ChevronDown size={15} className={openSources[selected.id] ? "is-open" : ""} />
                </button>
                {openSources[selected.id] && (
                  selected.sources?.length ? (
                    <ul>
                      {selected.sources.map((source) => (
                        <li key={source.id}>
                          <span>{source.kind === "web" ? "网页" : source.kind === "memory" ? "记忆" : source.kind === "text" ? "文字" : "文件"}</span>
                          <div><strong>{source.label}</strong>{source.detail && <small>{source.detail}</small>}</div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="memory-evidence-empty">这份结果没有引用长期记忆或外部材料。</p>
                )}
              </section>
            </>
          ) : (
            <div className="work-page-empty"><FileText size={28} /><strong>选择一份结果</strong><p>详情、来源与后续动作会出现在这里。</p></div>
          )}
        </article>
      </div>

    </section>
  );
}
