import { CircleCheck, CircleX, History, LoaderCircle, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { agentRunResumeAvailability, type AgentRunSummary } from "../types";

const STATUS_LABEL: Record<string, string> = {
  done: "做完了",
  failed: "失败",
  cancelled: "中途停了",
  interrupted: "应用退出时被打断",
  running: "还在跑",
};

// 工程模式动过什么，回头能查。
//
// 这些记录一直都在写（SQLite），IPC 也早就开好了，
// 但**界面上从来没有入口**——等于"有记录"却没人能看，
// 出了事只能去翻数据库文件。
interface AuditPanelProps {
  onClose: () => void;
  onResume: (runId: string) => Promise<{ ok: boolean; message?: string }>;
  busy: boolean;
}

export default function AuditPanel({ onClose, onResume, busy }: AuditPanelProps) {
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.kaiLocal.listAgentRuns(40)
      .then(setRuns)
      .catch(() => {
        setRuns([]);
        setError("工程记录没有读出来。");
      })
      .finally(() => setLoading(false));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const resume = async (runId: string) => {
    if (busy || resumingId) return;
    setError(null);
    setResumingId(runId);
    try {
      const outcome = await onResume(runId);
      if (outcome.ok) onClose();
      else setError(outcome.message || "这次任务没有恢复成功。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这次任务没有恢复成功。");
    } finally {
      setResumingId(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-panel" role="dialog" aria-modal="true" aria-label="动过的东西">
        <header>
          <div>
            <h2>工程记录</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="audit-list">
          {error && <p className="audit-error" role="alert">{error}</p>}
          {loading ? (
            <div className="audit-blank"><LoaderCircle className="spin" size={20} /></div>
          ) : runs.length ? runs.map((run) => {
            const resumeAvailability = agentRunResumeAvailability(run, busy || resumingId !== null);
            return (
            <article key={run.id} className={run.status === "failed" ? "bad" : ""}>
              <div className="audit-head">
                {run.status === "done" ? <CircleCheck size={14} /> : <CircleX size={14} />}
                <div>
                  <strong>{run.goal || "（没记下目标）"}</strong>
                  <small>
                    {new Date(run.createdAt).toLocaleString("zh-CN")}
                    {" · "}{STATUS_LABEL[run.status] || run.status}
                    {" · "}{run.rounds} 轮
                  </small>
                </div>
                {resumeAvailability !== "hidden" && (
                  <button
                    className="audit-resume"
                    type="button"
                    disabled={resumeAvailability !== "ready"}
                    onClick={() => void resume(run.id)}
                  >
                    {resumingId === run.id ? <LoaderCircle className="spin" size={13} /> : <RotateCw size={13} />}
                    继续
                  </button>
                )}
              </div>
            </article>
            );
          }) : (
            <div className="audit-blank">
              <History size={26} />
              <strong>还没有记录</strong>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
