import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import TaskWorkbench, {
  type TaskWorkbenchPrivacyPreview,
  type TaskWorkbenchResult,
  type TaskWorkbenchTask,
} from "../src/components/TaskWorkbench";
import "./task-workbench-harness.css";

const tasks: TaskWorkbenchTask[] = [
  { id: "running", label: "核对政策材料", status: "running", progressLabel: "读取第 4 份" },
  { id: "waiting", label: "云端风险分析", status: "waiting", progressLabel: "等待确认" },
  { id: "done", label: "整理会议纪要", status: "done", progressLabel: "已留回执" },
];

const results: TaskWorkbenchResult[] = [
  {
    id: "result-1",
    title: "政策材料核对",
    conclusion: "三份材料的适用范围一致，但第二份的发布日期早于最终修订版。",
    body: "已按发布日期和发布机构交叉核对。建议引用最终修订版，并保留旧版作为变更依据。",
    sourceSummary: "2 份文件 · 1 条网页来源",
    sources: [
      { id: "source-1", label: "最终修订版.pdf", detail: "本机文件", kind: "file" },
      { id: "source-2", label: "发布机构公告", detail: "官网", kind: "web" },
    ],
    runAt: "11:42",
    location: "mixed",
    verification: "verified",
  },
  {
    id: "result-2",
    title: "会议纪要整理",
    conclusion: "形成 3 项决定、2 个待办和 1 个仍需确认的问题。",
    sourceSummary: "1 份本机材料",
    runAt: "10:18",
    location: "local",
    verification: "needs-review",
  },
];

const privacyPreview: TaskWorkbenchPrivacyPreview = {
  destination: "GLM",
  summary: "下面逐字展示对话和项目文字；附件正文不在本预览中。",
  items: ["历史消息 4 条", "项目说明 1 条", "附件 1 份（仅显示名称与规模）"],
  payloadPreview: "[项目说明]\n只比较正式发布材料。\n\n[问题]\n请核对这份材料里的日期与适用范围。",
  warning: "附件正文尚未逐字预览，也未经过本页的密钥和个人信息扫描。",
};

function Harness() {
  const [showPrivacy, setShowPrivacy] = useState(true);
  return (
    <main className="harness-page">
      <div className="harness-toolbar">
        <strong>界面预览 · 演示数据</strong>
        <button type="button" onClick={() => setShowPrivacy((value) => !value)}>
          {showPrivacy ? "隐藏发送预览" : "显示发送预览"}
        </button>
      </div>
      <div className="task-workbench-backdrop">
        <div className="task-workbench-dialog" role="dialog" aria-modal="true" aria-label="任务与结果视觉检查">
          <TaskWorkbench
            tasks={tasks}
            results={results}
            privacyPreview={showPrivacy ? privacyPreview : null}
            onClose={() => undefined}
            onPrivacyCancel={() => setShowPrivacy(false)}
            onPrivacyConfirm={() => setShowPrivacy(false)}
          />
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
