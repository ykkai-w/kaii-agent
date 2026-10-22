import { Ban, Check, ChevronRight, CircleAlert, CircleCheck, FileDiff, FolderTree, LoaderCircle, ListChecks, Play, RotateCcw, Search, ShieldQuestion, Terminal, X } from "lucide-react";
import { useState } from "react";
import type { ToolCallReceipt } from "../types";

const TOOL_ICONS: Record<string, typeof Search> = {
  list_dir: FolderTree,
  read_file: FileDiff,
  search_text: Search,
  update_plan: ListChecks,
  git_status: Terminal,
  apply_patch: FileDiff,
  run_test: Play,
};

function DiffBlock({ detail }: { detail: string }) {
  return (
    <pre className="tool-diff">
      {detail.split("\n").map((line, index) => {
        const tone = line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "remove"
            : line.startsWith("@@")
              ? "hunk"
              : "context";
        return <span className={`diff-line ${tone}`} key={index}>{line || " "}</span>;
      })}
    </pre>
  );
}

function PlanBlock({ receipt }: { receipt: ToolCallReceipt }) {
  const steps = receipt.meta?.steps ?? [];
  if (!steps.length) return null;
  return (
    <ol className="tool-plan">
      {steps.map((step, index) => (
        <li className={`plan-${step.status}`} key={`${step.title}-${index}`}>
          <span className="plan-mark" aria-hidden="true" />
          <span>{step.title}</span>
        </li>
      ))}
    </ol>
  );
}

function ApprovalPrompt({
  receipt,
  onDecide,
}: {
  receipt: ToolCallReceipt;
  onDecide: (callId: string, approved: boolean) => void;
}) {
  const isCommand = receipt.tool === "run_test";
  return (
    <div className="tool-approval">
      <p>
        kaii-agent 想{isCommand ? "运行命令" : "改文件"}：<b>{receipt.summary || receipt.intent}</b>
      </p>
      {receipt.detail && (
        receipt.previewInvalid
          ? <pre className="tool-output preview-invalid">{receipt.detail}</pre>
          : isCommand
            ? <pre className="tool-output">{receipt.detail}</pre>
            : <DiffBlock detail={receipt.detail} />
      )}
      <div>
        <button className="approve" type="button" onClick={() => onDecide(receipt.callId, true)}>
          <Check size={13} /> {isCommand ? "允许运行" : "允许这次改动"}
        </button>
        <button className="deny" type="button" onClick={() => onDecide(receipt.callId, false)}>
          <X size={13} /> {isCommand ? "不要运行" : "不要改"}
        </button>
      </div>
    </div>
  );
}

export function ToolReceiptCard({
  receipt,
  onRollback,
  onDecide,
}: {
  receipt: ToolCallReceipt;
  onRollback: (callId: string) => void;
  onDecide: (callId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState(receipt.tool === "update_plan");
  const Icon = TOOL_ICONS[receipt.tool] ?? Terminal;
  const isDiff = receipt.tool === "apply_patch" && receipt.status === "ok";

  return (
    <div className={`tool-receipt tool-${receipt.status}`}>
      <button className="tool-head" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="tool-icon"><Icon size={14} /></span>
        <span className="tool-line">
          <strong>{receipt.title}</strong>
          <small>{receipt.status === "running" ? receipt.intent : receipt.summary}</small>
        </span>
        <span className="tool-state">
          {receipt.status === "waiting" && <ShieldQuestion size={14} />}
          {receipt.status === "running" && <LoaderCircle className="spin" size={14} />}
          {receipt.status === "ok" && <CircleCheck size={14} />}
          {receipt.status === "blocked" && <Ban size={14} />}
          {(receipt.status === "error" || receipt.status === "cancelled" || receipt.status === "denied") && <CircleAlert size={14} />}
          <ChevronRight className={`tool-caret ${open ? "open" : ""}`} size={14} />
        </span>
      </button>
      {receipt.status === "waiting" && <ApprovalPrompt receipt={receipt} onDecide={onDecide} />}
      {open && receipt.status !== "waiting" && (
        <div className="tool-body">
          {receipt.tool === "update_plan"
            ? <PlanBlock receipt={receipt} />
            : isDiff
              ? <DiffBlock detail={receipt.detail} />
              : <pre className="tool-output">{receipt.detail || receipt.summary}</pre>}
          {receipt.changedPath && receipt.canRollback && (
            <div className="tool-actions">
              <span>{receipt.rolledBack ? "已回滚这次改动" : `已修改 ${receipt.changedPath}`}</span>
              {!receipt.rolledBack && (
                <button type="button" onClick={() => onRollback(receipt.callId)}>
                  <RotateCcw size={13} /> 撤销这次改动
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolReceiptList({
  receipts,
  runId,
  onRollback,
  onRollbackRun,
  onDecide,
}: {
  receipts: ToolCallReceipt[];
  runId?: string;
  onRollback: (callId: string) => void;
  onRollbackRun: (runId: string) => void;
  onDecide: (callId: string, approved: boolean) => void;
}) {
  if (!receipts.length) return null;
  const undoable = receipts.filter((receipt) => receipt.canRollback && !receipt.rolledBack);
  return (
    <div className="tool-receipts" aria-label="kaii-agent 这次做了什么">
      {receipts.map((receipt) => (
        <ToolReceiptCard key={receipt.callId} receipt={receipt} onRollback={onRollback} onDecide={onDecide} />
      ))}
      {runId && undoable.length > 1 && (
        <button className="tool-undo-all" type="button" onClick={() => onRollbackRun(runId)}>
          <RotateCcw size={13} /> 撤销这次任务的全部 {undoable.length} 处改动
        </button>
      )}
    </div>
  );
}
