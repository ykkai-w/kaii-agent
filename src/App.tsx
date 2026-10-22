import WelcomePanel from "./components/WelcomePanel";
import { hasCloudProvider, isBrowsingWithoutModel, readOnboardingChoice, rememberOnboardingChoice, type OnboardingChoice } from "./lib/onboarding";
import {
  ArrowDown,
  Archive,
  ArrowUp,
  Bookmark,
  BookmarkPlus,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleStop,
  Clock,
  Cloud,
  Columns2,
  Copy,
  Cpu,
  Crop,
  Download,
  FlaskConical,
  Ellipsis,
  FileCode2,
  FilePenLine,
  FileText,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitMerge,
  GripVertical,
  Globe,
  Globe2,
  Hash,
  ImagePlus,
  Layers,
  Library,
  LoaderCircle,
  Maximize2,
  Menu,
  MessageSquareText,
  Mic,
  Minimize2,
  Minus,
  Monitor,
  Moon,
  MessageSquareQuote,
  PenLine,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Power,
  Quote,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Star,
  Sun,
  Tag,
  Target,
  Trash2,
  Wifi,
  WifiOff,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import type React from "react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { KATEX_OPTIONS, remarkNoCurrencyMath } from "./lib/math.ts";
import ArtifactPanel from "./components/ArtifactPanel";
import ChartBlock from "./components/ChartBlock";
import SmartTable from "./components/SmartTable";
import CanvasPanel from "./components/CanvasPanel";
import BatchPanel from "./components/BatchPanel";
import CommandPalette from "./components/CommandPalette";
import AuditPanel from "./components/AuditPanel";
import ComparePanel from "./components/ComparePanel";
import DocumentPeek from "./components/DocumentPeek";
import ReadLaterPanel from "./components/ReadLaterPanel";
import ReviewPanel from "./components/ReviewPanel";
import ShortcutsPanel from "./components/ShortcutsPanel";
import StarredPanel from "./components/StarredPanel";
import TrashPanel from "./components/TrashPanel";
import SchedulePanel from "./components/SchedulePanel";
import KnowledgePanel from "./components/KnowledgePanel";
import ProjectPanel from "./components/ProjectPanel";
import TaskWorkbench, {
  type TaskWorkbenchAction,
  type TaskWorkbenchEntry,
  type TaskWorkbenchResult,
  type TaskWorkbenchTask,
} from "./components/TaskWorkbench";
import { ToolReceiptList } from "./components/ToolReceipts";
import { extractArtifacts, artifactSummary } from "./lib/artifacts";
import { conversationToHtml, projectToHtml, safeFileName } from "./lib/export-document.tsx";
import { splitChartSegments } from "./lib/chart.ts";
import { describeLength, extractOutline } from "./lib/outline.ts";
import {
  commitChatRevision,
  continuationReasonForStop,
  disableResumedRunInRevision,
  prepareChatRevision,
  recoverableRevisionAssistant,
  revisionBlocksConversationMutation,
  revisionOutboundMessages,
  shouldEnrichRevisionResult,
  type ChatRevisionIntent,
  type ChatRevisionPlan,
} from "./lib/chat-revisions.ts";
import { keepMenuClickInside } from "./lib/menu-events.ts";
import type { Project } from "./lib/projects.ts";
import { buildBackup } from "./lib/backup.ts";
import {
  commitRestorePlan,
  planBackupRestore,
  reconcilePendingRestore,
  rollbackRestorePlan,
} from "./lib/restore.ts";
import type { SavedPrompt } from "./lib/prompts.ts";
import { createPrompt, fillPromptVariables, loadPrompts, savePrompts, sortPrompts } from "./lib/prompts.ts";
import { cleanText, formatJson, instantAnswer, stripMarkdown } from "./lib/instant.ts";
import {
  appendArtifact,
  appendCheckpoint,
  appendEvidenceReceipt,
  capsuleInput,
  createTaskCapsule,
  previewPrivacyMessages,
  privacyInventory,
  serializeTaskCapsule,
  sha256Text,
  type CapsuleStatus,
  type PrivacyMessagePreview,
  type TaskCapsule,
} from "./lib/task-capsule.ts";
import { loadTaskCapsulesWithStatus, saveTaskCapsules, upsertTaskCapsule } from "./lib/task-store.ts";
import { parseChatGptExport, planChatGptImport, type ChatGptImportPlan } from "./lib/import-chatgpt.ts";
import type { PaletteCommand } from "./lib/palette.ts";
import { allTags, expiredInTrash, isInTrash, isVisible, matchesTags, toggleTag } from "./lib/organize.ts";
import { createProject, groupConversations, loadProjects, normalizeProjectName, projectDocumentIdsFor, projectInstructionsFor, saveProjects } from "./lib/projects.ts";
import type { Artifact } from "./lib/artifacts";
import { highlightCode } from "./lib/highlight";
import {
  INITIAL_CODE_BLOCK_VIEW,
  toggleCodeBlockView,
  type CodeBlockViewState,
} from "./lib/code-block-view.ts";
import WorkspacePanel from "./components/WorkspacePanel";
import {
  exportConversations,
  loadActiveConversationId,
  loadConversationsWithStatus,
  pruneRedundantEmptyConversations,
  conversationToMarkdown,
  referencedAttachmentIds,
  referencedDocumentIds,
  searchConversations,
  saveActiveConversationId,
  saveConversations,
} from "./lib/storage";
import type {
  AgentRunSummary,
  AppSettings,
  ChatMessage,
  Conversation,
  DocumentAttachment,
  ImageAttachment,
  InitialState,
  MemoryEntry,
  ModelState,
  QuickHotkeyInfo,
  QuickHotkeyState,
  TrayState,
  SearchProviderInfo,
  SkillInfo,
  ProviderInfo,
  ProviderModelInfo,
  CatalogSection,
  KnowledgeCitation,
  KnowledgeLibrary,
  MemorySuggestion,
  QuickActionInfo,
  SavedPage,
  Schedule,
  ToolCallReceipt,
  WebSource,
  WorkspaceState,
} from "./types";

const EMPTY_MODEL_STATE: ModelState = {
  status: "stopped",
  detail: "模型尚未启动",
  owned: false,
};

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function newConversation(skillId = "none", projectId?: string): Conversation {
  const now = Date.now();
  return {
    id: randomId("chat"),
    title: "新对话",
    messages: [],
    skillId,
    createdAt: now,
    updatedAt: now,
    ...(projectId ? { projectId } : {}),
  };
}

function deriveTitle(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 22) || "新对话";
}

function modelLabel(state: ModelState) {
  if (state.status === "ready") return "模型就绪";
  if (state.status === "starting") return "正在加载";
  if (state.status === "stopping") return "正在停止";
  if (state.status === "error") return "需要看看";
  return "模型休息中";
}

// 回答里的代码块加一键复制。用 pre 而不是 code，是因为要连整段一起复制，
// 而不是行内那些短片段。
// 从 react-markdown 交给 <pre> 的子节点里，把原始代码和语言标记挖出来。
// 结构是 <pre><code className="language-xxx">文本</code></pre>。
function readCodeNode(children: React.ReactNode): { code: string; language: string | null } {
  const child = Array.isArray(children) ? children[0] : children;
  const props = (child as { props?: { className?: string; children?: React.ReactNode } })?.props;
  if (!props) return { code: typeof children === "string" ? children : "", language: null };
  const raw = props.children;
  const code = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((item) => typeof item === "string").join("") : "";
  const match = /language-([\w+#-]+)/.exec(props.className || "");
  return { code: code.replace(/\n$/, ""), language: match ? match[1] : null };
}

// 从 ReactMarkdown 已经解析好的节点里把表头和数据行读出来。
// 自己再写一个 Markdown 表格解析器意味着两套规则，迟早对不上。
function readTableNode(children: React.ReactNode): { headers: string[]; rows: string[][] } {
  const headers: string[] = [];
  const rows: string[][] = [];

  const textOf = (node: React.ReactNode): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    const element = node as { props?: { children?: React.ReactNode } };
    return element.props ? textOf(element.props.children) : "";
  };

  const walk = (node: React.ReactNode, inHead: boolean) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inHead);
      return;
    }
    const element = node as { type?: unknown; props?: { children?: React.ReactNode } } | null;
    if (!element || typeof element !== "object" || !element.props) return;
    const tag = typeof element.type === "string" ? element.type : "";
    if (tag === "thead") {
      walk(element.props.children, true);
      return;
    }
    if (tag === "tr") {
      const cells: string[] = [];
      const collect = (cellNode: React.ReactNode) => {
        if (Array.isArray(cellNode)) {
          for (const child of cellNode) collect(child);
          return;
        }
        const cell = cellNode as { type?: unknown; props?: { children?: React.ReactNode } } | null;
        if (!cell || typeof cell !== "object") return;
        const cellTag = typeof cell.type === "string" ? cell.type : "";
        if (cellTag === "th" || cellTag === "td") cells.push(textOf(cell.props?.children).trim());
      };
      collect(element.props.children);
      if (inHead || (!headers.length && cells.length)) headers.push(...cells);
      else if (cells.length) rows.push(cells);
      return;
    }
    walk(element.props.children, inHead);
  };

  walk(children, false);
  return { headers, rows };
}

// 语言名到文件后缀。认不出的一律 .txt，不猜。
const CODE_EXTENSIONS: Record<string, string> = {
  javascript: "js", js: "js", typescript: "ts", ts: "ts", python: "py", py: "py",
  bash: "sh", shell: "sh", sh: "sh", zsh: "sh", json: "json", html: "html", css: "css",
  c: "c", cpp: "cpp", java: "java", go: "go", rust: "rs", ruby: "rb", sql: "sql",
  yaml: "yml", yml: "yml", xml: "xml", markdown: "md", md: "md", swift: "swift", kotlin: "kt",
};

// 超过这个行数的代码块先收起来。一段三百行的配置文件铺开
// 会把上下文全推出屏幕，人得滚半天才看得到模型接下来说了什么。
const CODE_FOLD_LINES = 40;

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  // 换行会使行号与视觉行错位，两个低频开关共用一个互斥状态。
  const [view, setView] = useState<CodeBlockViewState>(INITIAL_CODE_BLOCK_VIEW);
  const { wrapped, numbered } = view;
  const { code, language } = useMemo(() => readCodeNode(children), [children]);
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const folded = lineCount > CODE_FOLD_LINES && !unfolded;

  return (
    <div className={`code-block${wrapped ? " wrap" : ""}${numbered ? " numbered" : ""}${folded ? " folded" : ""}`}>
      <div className="code-bar">
        {highlighted.language && <span className="code-language">{highlighted.language}</span>}
        <span className="code-lines">{lineCount} 行</span>
        <button
          type="button"
          className="code-wrap"
          aria-pressed={numbered}
          title={numbered ? "去掉行号" : "显示行号"}
          onClick={() => setView((current) => toggleCodeBlockView(current, "numbers"))}
        >
          {numbered ? "无行号" : "行号"}
        </button>
        <button
          type="button"
          className="code-wrap"
          aria-pressed={wrapped}
          title={wrapped ? "改回一行到底" : "长行折下来，不用横着拖"}
          onClick={() => setView((current) => toggleCodeBlockView(current, "wrap"))}
        >
          {wrapped ? "不换行" : "自动换行"}
        </button>
        <button
          type="button"
          className="code-wrap"
          title="把这段代码存成文件"
          onClick={() => {
            if (!code.trim()) return;
            const extension = CODE_EXTENSIONS[highlighted.language || ""] || "txt";
            const blob = new Blob([code], { type: "text/plain" });
            const anchor = document.createElement("a");
            anchor.href = URL.createObjectURL(blob);
            anchor.download = `代码.${extension}`;
            anchor.click();
            URL.revokeObjectURL(anchor.href);
          }}
        >
          存文件
        </button>
      </div>
      <button
        type="button"
        className="code-copy"
        aria-label="复制这段代码"
        onClick={async () => {
          if (!code.trim()) return;
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "已复制" : "复制"}
      </button>
      {/* highlightCode 只产出 hljs 的 span，输入里的尖括号已被转义，不会把模型输出当标记执行。 */}
      {numbered && (
        <div className="code-gutter" aria-hidden="true">
          {code.split("\n").map((_, index) => <i key={index}>{index + 1}</i>)}
        </div>
      )}
      <pre className={highlighted.language ? `hljs language-${highlighted.language}` : "hljs"}>
        <code dangerouslySetInnerHTML={{ __html: highlighted.html }} />
      </pre>
      {folded && (
        <button className="code-unfold" type="button" onClick={() => setUnfolded(true)}>
          展开全部 {lineCount} 行
        </button>
      )}
    </div>
  );
}

// 粘超过这个长度就收成附件。2000 字大约是屏幕上十几屏，
// 再多就没人会在输入框里翻着看了。
const PASTE_AS_DOCUMENT_CHARACTERS = 2000;
const LONG_ANSWER_CHARACTERS = 2200;
const FOLDED_CHARACTERS = 900;

// 很长的回答折起来。不按行数按字数，因为中文一行能塞很多字。
// 折叠点往后找一个自然断句，避免从半句话中间切开。
function foldPoint(text: string): number {
  const window = text.slice(FOLDED_CHARACTERS, FOLDED_CHARACTERS + 260);
  const relative = window.search(/\n\n|[。！？]\s|\n/);
  return relative < 0 ? FOLDED_CHARACTERS : FOLDED_CHARACTERS + relative + 1;
}

function MarkdownAnswer({ content, folded, onExpand }: { content: string; folded: boolean; onExpand: () => void }) {
  // 带图的回答不折叠：折点落在图的围栏中间会把它切坏，
  // 而这类回答本来就是数据小结，很少长到需要折。
  const hasChart = content.includes("```chart");
  const tooLong = !hasChart && content.length > LONG_ANSWER_CHARACTERS;
  const shown = tooLong && folded ? content.slice(0, foldPoint(content)) : content;

  if (hasChart) {
    return (
      <>
        {splitChartSegments(content).map((segment, index) => (
          segment.kind === "chart"
            ? <ChartBlock key={index} spec={segment.spec} />
            : <MarkdownAnswer key={index} content={segment.text} folded={false} onExpand={onExpand} />
        ))}
      </>
    );
  }

  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkNoCurrencyMath]}
        rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
        components={{
          a: ({ children, href }) => (
            <span
              className="markdown-link-text"
              title={href ? `${href}\n点一下复制网址（有意不做直接打开）` : undefined}
              onClick={() => {
                if (href) void navigator.clipboard.writeText(href);
              }}
            >
              {children}
            </span>
          ),
          img: ({ alt }) => <span className="markdown-image-note">[图片：{alt || "未命名"}]</span>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // 表格换成能排序、能导 CSV 的那个。
          // 从 React 节点里把表头和行读出来——这比另写一个 Markdown
          // 表格解析器可靠，因为读的就是渲染器已经解析好的结果。
          table: ({ children }) => {
            const { headers, rows } = readTableNode(children);
            if (!headers.length) return <table>{children}</table>;
            return <SmartTable headers={headers} rows={rows} />;
          },
        }}
      >{shown}</ReactMarkdown>
      {tooLong && folded && (
        <button className="expand-answer" type="button" onClick={onExpand}>
          展开全文（还有 {content.length - shown.length} 字）
        </button>
      )}
    </>
  );
}

function statusTone(state: ModelState) {
  return state.status === "ready" ? "ready" : state.status === "error" ? "error" : state.status;
}

function CompletionEvidenceCard({ evidence }: { evidence: NonNullable<ChatMessage["completion"]> }) {
  const labels = {
    verified: "最近检查通过",
    unverified: "已改动，尚未检查",
    partial: "任务只完成一部分",
    "read-only": "只读完成",
  } as const;
  const latestCheck = evidence.checks.at(-1);
  return (
    <div className={`completion-evidence completion-${evidence.state}`} aria-label="任务完成情况">
      <span className="completion-dot" aria-hidden />
      <strong>{labels[evidence.state]}</strong>
      <span>改动 {evidence.changedPaths.length} 个文件</span>
      {latestCheck ? <small title={latestCheck.summary}>最近检查：{latestCheck.summary}</small> : null}
    </div>
  );
}

function ResumeCheckpointStatus({ run }: { run?: AgentRunSummary }) {
  if (!run?.checkpoint) return null;
  const done = run.checkpoint.plan.filter((item) => item.status === "done").length;
  const total = run.checkpoint.plan.length;
  const changed = run.checkpoint.changedPaths.length;
  const stale = run.checkpoint.changedPaths.filter((item) => item.stale).length;
  const needsWorkspaceReview = run.checkpoint.workspaceDirty === true;
  return (
    <div className={`resume-status ${stale || needsWorkspaceReview ? "resume-stale" : run.resumable ? "resume-ready" : "resume-unavailable"}`} role="status">
      <span className="resume-dot" aria-hidden />
      <strong>{needsWorkspaceReview ? "工作区待核对" : stale ? "文件有变化" : run.resumable ? "进度已保存" : "这份进度不能继续"}</strong>
      {total ? <span>{done}/{total} 步</span> : null}
      {changed ? <span>{changed} 个文件</span> : null}
      {needsWorkspaceReview ? <small>这份进度只能查看；继续改动请另开工程任务</small> : stale ? <small>{stale} 个文件需要重新核对</small> : null}
    </div>
  );
}

// 应用锁：验证锁码后显示主界面。
// 猜错的延迟在主进程里（400ms），这里只负责画界面。
function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  const tryUnlock = async () => {
    if (busy || !code) return;
    setBusy(true);
    const outcome = await window.kaiLocal.verifyLock(code).catch(() => ({ ok: false }));
    setBusy(false);
    if (outcome.ok) onUnlock();
    else {
      setWrong(true);
      setCode("");
    }
  };
  return (
    <div className="lock-screen">
      <div className="lock-box">
        <img className="lock-logo" src="./logos/kaii-k-a.svg" alt="kaii-agent" />
        <strong>输入锁码</strong>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={code}
          maxLength={8}
          aria-label="锁码"
          onChange={(event) => {
            setCode(event.target.value.replace(/[^0-9]/g, ""));
            setWrong(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void tryUnlock();
          }}
        />
        {wrong && <small role="alert">不对，再试一次。</small>}
        <button type="button" disabled={busy || !code} onClick={() => void tryUnlock()}>
          {busy ? "…" : "打开"}
        </button>
      </div>
    </div>
  );
}

// 搜索命中处标黄。只做朴素子串匹配——搜索本身就是这么匹配的，两边一致。
function highlightMatches(text: string, needle: string): React.ReactNode {
  const query = needle.trim().toLowerCase();
  if (!query) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let found = lower.indexOf(query); found >= 0 && parts.length < 40; found = lower.indexOf(query, at)) {
    parts.push(text.slice(at, found), <mark key={`${found}`}>{text.slice(found, found + query.length)}</mark>);
    at = found + query.length;
  }
  parts.push(text.slice(at));
  return parts;
}

// 项目颜色点可选的几个颜色。点一下换下一个，转回无色。
const PROJECT_COLORS = ["", "#416f9f", "#a9682f", "#587851", "#8a5878", "#a94838"];

// 空状态问候跟着钟点走。凌晨四点打开看到「今天想聊点什么」有点像机器人。
function greetingNow(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "夜深了，想聊点什么？";
  if (hour < 11) return "早上好，想聊点什么？";
  if (hour < 14) return "中午好，想聊点什么？";
  if (hour < 18) return "下午好，想聊点什么？";
  return "晚上好，想聊点什么？";
}

interface ChatGptImportOutcome extends ChatGptImportPlan {
  storageBlocked: boolean;
}

function describeChatGptImport(outcome: ChatGptImportOutcome, malformed: number): string {
  if (outcome.storageBlocked) {
    return "对话存储正在保护状态，暂时没有导入。原来的本机数据和这份导出文件都没有改动。";
  }
  const parts = [`实际搬来 ${outcome.accepted.length} 段`];
  if (outcome.duplicates) parts.push(`${outcome.duplicates} 段已经存在`);
  if (malformed) parts.push(`${malformed} 段为空或格式损坏`);
  if (outcome.capacitySkipped) parts.push(`${outcome.capacitySkipped} 段因本机容量不足没有搬入`);
  const suffix = outcome.accepted.length
    ? "已按「ChatGPT」标签筛出来了，点标签可以取消筛选。"
    : "没有新增内容，原导出文件没有改动。";
  return `${parts.join("，")}。${suffix}`;
}

export default function App() {
  const initialActive = useMemo(() => loadActiveConversationId(), []);
  const initialConversationStorage = useMemo(() => loadConversationsWithStatus(), []);
  const initialTaskStorage = useMemo(() => loadTaskCapsulesWithStatus(), []);
  const initialConversations = useMemo(
    () => pruneRedundantEmptyConversations(initialConversationStorage.conversations, initialActive),
    [initialActive, initialConversationStorage.conversations],
  );
  // 未知新版本或半损数据必须原样留在磁盘上。确认恢复前，既不自动覆写，也不按空历史清附件。
  const conversationStorageBlocked = useRef(
    initialConversationStorage.status === "unsupported" || initialConversationStorage.status === "corrupt",
  );
  const taskStorageBlocked = useRef(
    initialTaskStorage.status === "unsupported" || initialTaskStorage.status === "corrupt",
  );
  // 在主进程返回未完成的恢复事务之前，三类自动保存都不许抢跑。
  // 否则混合态里读成空数组的项目／常用语会被 effect 再次覆盖。
  const [storageEffectsReady, setStorageEffectsReady] = useState(false);
  const fallbackConversation = useMemo(() => newConversation(), []);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const raw = Number(localStorage.getItem("kaii.sidebarWidth.v1"));
    return Number.isFinite(raw) && raw >= 220 && raw <= 400 ? raw : 274;
  });
  useEffect(() => {
    void window.kaiLocal.lockStatus().then((status) => setLocked(status.enabled)).catch(() => setLocked(false));
  }, []);
  useEffect(() => {
    const fontscale = localStorage.getItem("kaii.fontscale.v1");
    if (fontscale === "small" || fontscale === "big") document.documentElement.dataset.fontscale = fontscale;
    const density = localStorage.getItem("kaii.density.v1");
    if (density === "compact") document.documentElement.dataset.density = density;
    if (localStorage.getItem("kaii.calm.v1") === "1") document.documentElement.dataset.calm = "1";
  }, []);
  const [conversations, setConversations] = useState<Conversation[]>(
    initialConversations.length ? initialConversations : [fallbackConversation],
  );
  const [activeId, setActiveId] = useState(
    initialConversations.some((conversation) => conversation.id === initialActive)
      ? initialActive!
      : (initialConversations[0]?.id || fallbackConversation.id),
  );
  const [initialState, setInitialState] = useState<InitialState | null>(null);
  const [modelState, setModelState] = useState<ModelState>(EMPTY_MODEL_STATE);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [localOnlyBusy, setLocalOnlyBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [editSession, setEditSession] = useState<{
    conversationId: string;
    messageId: string;
    previousDraft: string;
  } | null>(null);
  // 每段对话记自己那份没发出去的草稿。
  // 原来是全局一个 draft，切走再切回来就没了——打了一半去查个东西，
  // 回来发现白打了，是很实在的恼火。
  const draftsByConversation = useRef(new Map<string, string>());
  // 208 崩溃后草稿还在：草稿表落盘（防崩溃/强退），开机还原。
  const draftsRestored = useRef(false);
  useEffect(() => {
    if (draftsRestored.current) return;
    draftsRestored.current = true;
    try {
      const stored = JSON.parse(localStorage.getItem("kaii.drafts.v1") || "{}") as Record<string, string>;
      for (const [id, text] of Object.entries(stored)) {
        if (typeof text === "string" && text.trim()) draftsByConversation.current.set(id, text.slice(0, 20_000));
      }
      const mine = draftsByConversation.current.get(activeIdRef.current || "");
      if (mine) setDraft((current) => current || mine);
    } catch {
      // 草稿表坏了就从零开始，不挡启动。
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [webEnabled, setWebEnabled] = useState(true);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [missionMode, setMissionMode] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceState>({ roots: [], activeId: null });
  const [searchProviders, setSearchProviders] = useState<SearchProviderInfo[]>([]);
  const [allowedCommands, setAllowedCommands] = useState<string[]>([]);
  const [quickHotkeyState, setQuickHotkeyState] = useState<QuickHotkeyState | null>(null);
  const [trayState, setTrayState] = useState<TrayState | null>(null);
  const [openArtifact, setOpenArtifact] = useState<Artifact | null>(null);
  const [openCanvas, setOpenCanvas] = useState<{ title: string; text: string } | null>(null);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [onboardingChoice, setOnboardingChoice] = useState(() => readOnboardingChoice(localStorage));
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const finishWelcome = useCallback((choice: OnboardingChoice) => {
    rememberOnboardingChoice(localStorage, choice);
    setOnboardingChoice(choice);
    setWelcomeOpen(false);
  }, []);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelInfo[]>>({});
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogSection[]>([]);
  const [routedReason, setRoutedReason] = useState<string | null>(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const cleanupFocusRefresh = useRef<(() => void) | null>(null);
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() => loadPrompts());
  const [promptMenuOpen, setPromptMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [taskWorkbenchOpen, setTaskWorkbenchOpen] = useState(false);
  const [taskEntry, setTaskEntry] = useState<TaskWorkbenchEntry>("ask");
  const [pendingTaskKind, setPendingTaskKind] = useState<TaskWorkbenchEntry | null>(null);
  const [taskCapsules, setTaskCapsules] = useState<TaskCapsule[]>(initialTaskStorage.capsules);
  const taskCapsulesRef = useRef(taskCapsules);
  const taskRequestMap = useRef(new Map<string, {
    capsuleId: string;
    conversationId: string;
    messageId: string;
  }>());
  const streamAnswerBuffers = useRef(new Map<string, string>());
  const [privacyApproval, setPrivacyApproval] = useState<{
    destination: string;
    preview: PrivacyMessagePreview;
    messageCount: number;
    attachmentLabels: string[];
  } | null>(null);
  const privacyApprovalResolver = useRef<((approved: boolean) => void) | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [messageMenu, setMessageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [projectDragId, setProjectDragId] = useState<string | null>(null);
  const [conversationDragId, setConversationDragId] = useState<string | null>(null);
  // 对话内查找跳到第几条命中。-1 = 还没跳过。
  const findCursor = useRef(-1);
  // 折叠起来的项目分组（记在本机，下次打开还是这个样子）。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("kaii.collapsedGroups.v1") || "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem("kaii.collapsedGroups.v1", JSON.stringify([...next]));
      return next;
    });
  }, []);
  const [projectDragOver, setProjectDragOver] = useState<string | null>(null);
  const [readLaterOpen, setReadLaterOpen] = useState(false);
  const [miniMode, setMiniMode] = useState(false);
  const [starredOpen, setStarredOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [peekDocument, setPeekDocument] = useState<DocumentAttachment | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [sidebarToolsOpen, setSidebarToolsOpen] = useState(false);
  // 工具菜单的关闭宽限：鼠标滑出去 400ms 内回来就不关。
  // 立刻关的话，穿过按钮和菜单之间的空隙、或者手抖出边缘一像素，菜单就没了。
  const toolsCloseTimer = useRef<number | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ src: string; name: string } | null>(null);
  const [inChatFind, setInChatFind] = useState<string | null>(null);
  // 写长问题时三行太憋屈，但默认高会把对话挤下去，所以做成开关。
  const [tallComposer, setTallComposer] = useState(false);
  const suggestions = useMemo(() => [
      "理一理今天的想法",
      "润色这段话",
      "把数据画成图",
      "看看这张截图",
      "总结这份文档",
      "解释这段代码",
    ], []);
  const [followups, setFollowups] = useState<{ messageId: string; items: string[] }>({ messageId: "", items: [] });
  // 算式/单位/日期/随机串：本机立答，不劳驾模型。
  const instantHit = useMemo(() => instantAnswer(draft), [draft]);
  const cleanable = useMemo(() => (
    draft.length > 80 && cleanText(draft) !== draft.trim() ? cleanText(draft) : null
  ), [draft]);
  const jsonPretty = useMemo(() => (
    // 是不是 JSON 由 formatJson 自己判断（解析得过才算），不设长度门槛——
    // 17 个字符的合法 JSON 也值得排版。
    draft.length > 5 ? formatJson(draft) : null
  ), [draft]);

  // 输入框开头敲 / 时匹配常用语（Tab 或点击展开第一条）。
  const slashHits = useMemo(() => {
    const match = /^\/(\S*)$/.exec(draft);
    if (!match) return [];
    const token = match[1].toLowerCase();
    return sortPrompts(prompts)
      .filter((item) => !token || item.label.toLowerCase().includes(token))
      .slice(0, 4);
  }, [draft, prompts]);
  const [savedPages, setSavedPages] = useState<SavedPage[]>([]);
  const [listening, setListening] = useState(false);
  const [speechNote, setSpeechNote] = useState<string | null>(null);
  // 开始听之前输入框里已有的字。听写的结果接在它后面，
  // 不能覆盖——用户可能是打了一半改用嘴说的。
  const draftBeforeSpeech = useRef("");
  const requestStartedAt = useRef(0);
  // 生成中每秒跳一下，让「等了多久」看得见。没在生成时不跑。
  const [nowTick, setNowTick] = useState(0);
  // React state 要到下一次渲染才更新。路由模型/启动本机模型的等待期间，
  // 用同步锁堵住双击和连按 Enter，避免同一句发两遍。
  const sendLock = useRef(false);
  const [preparingConversationId, setPreparingConversationId] = useState<string | null>(null);
  // ↑ 翻到第几条了。发出去或者手动改了字就归零。
  const historyBack = useRef(0);
  const listedRef = useRef<Conversation[]>([]);
  const msgNavIndex = useRef(-1);
  const askNavIndex = useRef(-1);
  const lastEscAt = useRef(0);
  const lastRequestId = useRef<string | null>(null);
  // 「做完为止」这段对话里确认过没有。每句话都弹一次没法用。
  const confirmedMission = useRef(false);
  useEffect(() => {
    if (!requestId) return;
    const timer = window.setInterval(() => setNowTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [requestId]);
  void nowTick;

  // 事件回调里要拿最新的对话列表。直接闭包捕获会拿到注册那一刻的旧值。
  const conversationsRef = useRef(conversations);
  const activeIdRef = useRef(activeId);
  const [quickActions, setQuickActions] = useState<QuickActionInfo[]>([]);
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  // 画布和代码预览都占右侧，同时开会互相盖住。
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(() => new Set());
  const [quoteTarget, setQuoteTarget] = useState<{ text: string; x: number; y: number } | null>(null);
  const [projects, setProjects] = useState<Project[]>(() => loadProjects());
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [attachment, setAttachment] = useState<ImageAttachment | null>(null);
  // 一次最多挂三份文档。数组是唯一事实，
  // 下面那个同名单数是给老代码读的（= 最后一份），别往它上面写。
  const [documentAttachments, setDocumentAttachments] = useState<DocumentAttachment[]>([]);
  const documentAttachment = documentAttachments.at(-1) ?? null;
  const MAX_DOCUMENTS = 3;
  // 加一份。满了就顶掉最旧的，被顶掉的把本机记录也清掉。
  const addDocumentAttachment = useCallback((incoming: DocumentAttachment) => {
    setDocumentAttachments((current) => {
      if (current.some((item) => item.id === incoming.id)) return current;
      const next = [...current, incoming];
      if (next.length > MAX_DOCUMENTS) {
        const dropped = next.shift();
        if (dropped) {
          void window.kaiLocal.discardDocument(dropped.id).catch(() => {});
          // 原来是静默挤掉最早那份——用户会以为四份都挂上了。
          setStorageWarning(`一次最多挂 ${MAX_DOCUMENTS} 份，「${dropped.name}」被挤下来了。`);
        }
      }
      return next;
    });
  }, []);
  const removeDocumentAttachment = useCallback((id: string) => {
    setDocumentAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) void window.kaiLocal.discardDocument(target.id).catch(() => {});
      return current.filter((item) => item.id !== id);
    });
  }, []);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [imageBusy, setImageBusy] = useState(false);
  const [bootPhase, setBootPhase] = useState<"loading" | "ready" | "error">("loading");
  const [bootFailure, setBootFailure] = useState<string | null>(null);
  const [bootSettingsOpen, setBootSettingsOpen] = useState(false);
  const [bootSettingsBusy, setBootSettingsBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [fileHints, setFileHints] = useState<Array<{ path: string; size: number }>>([]);
  const [fileHintIndex, setFileHintIndex] = useState(0);
  const [scrollState, setScrollState] = useState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const streamTarget = useRef<{
    conversationId: string;
    messageId: string;
    requestId: string;
    revision?: ChatRevisionIntent;
  } | null>(null);
  const revisionStage = useRef<{ plan: ChatRevisionPlan; assistant: ChatMessage } | null>(null);
  const revisionSourceLock = useRef<string | null>(null);
  const [revisionPreview, setRevisionPreview] = useState<{
    conversationId: string;
    kind: ChatRevisionIntent["kind"];
    assistant: ChatMessage;
  } | null>(null);
  const chatScroll = useRef<HTMLElement | null>(null);
  const scrollRail = useRef<HTMLDivElement | null>(null);
  const scrollDrag = useRef<{ pointerId: number; startY: number; startScroll: number } | null>(null);
  const lastScrollTop = useRef(0);
  const followLatest = useRef(true);
  // 每段对话各自记住滚到哪了。"bottom" = 当时贴着底，切回来继续贴底。
  const scrollMemory = useRef<Record<string, number | "bottom">>({});
  const pendingScrollRestore = useRef<number | null>(null);
  // 长按发送＝这一条临时反转联网开关。只影响一次，用完即弃。
  const sendWebOnce = useRef<boolean | null>(null);
  const sendHoldArmed = useRef(false);
  const sendHoldTimer = useRef<number | null>(null);
  const [sendHolding, setSendHolding] = useState(false);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const composerWrap = useRef<HTMLElement | null>(null);
  const bootAttempt = useRef(0);

  const resolvePrivacyApproval = useCallback((approved: boolean) => {
    const resolve = privacyApprovalResolver.current;
    privacyApprovalResolver.current = null;
    setPrivacyApproval(null);
    resolve?.(approved);
  }, []);

  const requestPrivacyApproval = useCallback((value: NonNullable<typeof privacyApproval>) => {
    // 理论上一轮必须先被处理；若界面异常叠进来，旧请求按取消收口，不能悬着锁住发送。
    privacyApprovalResolver.current?.(false);
    setPrivacyApproval(value);
    setTaskWorkbenchOpen(true);
    return new Promise<boolean>((resolve) => {
      privacyApprovalResolver.current = resolve;
    });
  }, []);

  const settleTrackedTask = useCallback((incoming: string, outcome: {
    answer?: string;
    status: CapsuleStatus;
    summary: string;
  }) => {
    const tracked = taskRequestMap.current.get(incoming);
    if (!tracked) return;
    taskRequestMap.current.delete(incoming);
    const observedAt = Date.now();
    setTaskCapsules((current) => {
      const capsule = current.find((item) => item.id === tracked.capsuleId);
      if (!capsule) return current;
      try {
        const effectiveStatus: CapsuleStatus = outcome.status === "verified" && !outcome.answer?.trim()
          ? "unverified"
          : outcome.status;
        const checkpointId = randomId("checkpoint");
        let next = appendCheckpoint(capsule, {
          id: checkpointId,
          label: effectiveStatus === "verified" ? "结果与完成证据已核对" : effectiveStatus === "retryable" ? "任务中断，可重试" : "结果已收到，仍需复核",
          status: effectiveStatus,
          detail: outcome.summary.slice(0, 4000),
          observedAt,
        });
        const artifactIds: string[] = [];
        if (outcome.answer?.trim()) {
          const artifactId = randomId("artifact");
          next = appendArtifact(next, {
            id: artifactId,
            kind: "report",
            label: "模型回答",
            sha256: sha256Text(outcome.answer),
            uri: `kaii://conversation/${tracked.conversationId}/message/${tracked.messageId}`,
            createdAt: observedAt,
          });
          artifactIds.push(artifactId);
        }
        next = appendEvidenceReceipt(next, {
          id: randomId("receipt"),
          checkpointId,
          status: effectiveStatus,
          summary: outcome.summary.slice(0, 4000),
          observedAt,
          inputHashes: next.inputs.map((item) => item.sha256),
          artifactIds,
        });
        return upsertTaskCapsule(current, next);
      } catch (error) {
        setStorageWarning(error instanceof Error ? `任务证据没有写入：${error.message}` : "任务证据没有写入。");
        return current;
      }
    });
  }, []);

  const activeConversation = conversations.find((conversation) => conversation.id === activeId) || conversations[0];

  // 切换对话时把当前草稿收起来，把那边的拿出来。
  const previousActiveId = useRef(activeId);
  useEffect(() => {
    if (previousActiveId.current === activeId) return;
    const leavingEdit = editSession?.conversationId === previousActiveId.current;
    const runningEdit = leavingEdit
      && revisionStage.current?.plan.kind === "edit"
      && revisionStage.current.plan.sourceConversationId === previousActiveId.current;
    draftsByConversation.current.set(
      previousActiveId.current,
      runningEdit ? revisionStage.current!.plan.userMessage.content : leavingEdit ? editSession.previousDraft : draft,
    );
    if (leavingEdit && !runningEdit) setEditSession(null);
    setDraft(draftsByConversation.current.get(activeId) ?? "");
    previousActiveId.current = activeId;
    confirmedMission.current = false;
    // draft 故意不进依赖：这里要的是"切换那一刻的草稿"，
    // 每次打字都跑一遍既没必要也会打断输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  const selectedSkill = skills.find((skill) => skill.id === activeConversation?.skillId);
  const activeWorkspace = workspaces.roots.find((root) => root.id === workspaces.activeId) || null;
  // 只对已经写完的助手回答做提取，避免流式输出到一半反复重算。
  const artifactsByMessage = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const message of activeConversation?.messages || []) {
      if (message.role !== "assistant" || message.pending || !message.content.includes("```")) continue;
      const found = extractArtifacts(message.id, message.content);
      if (found.length) map.set(message.id, found);
    }
    return map;
  }, [activeConversation?.messages]);

  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  // 侧栏只列"该看见的"：没删、（默认）没归档、符合标签筛选。
  const listedConversations = useMemo(() => conversations.filter((item) => (
    !isInTrash(item)
    && (showArchived ? true : !item.archived)
    && matchesTags(item, tagFilter)
  )), [conversations, showArchived, tagFilter]);

  useEffect(() => { listedRef.current = listedConversations; }, [listedConversations]);

  const tagList = useMemo(() => allTags(conversations), [conversations]);
  const trashCount = useMemo(() => conversations.filter(isInTrash).length, [conversations]);
  const archivedCount = useMemo(
    () => conversations.filter((item) => item.archived && !isInTrash(item)).length,
    [conversations],
  );

  const conversationGroups = useMemo(
    () => groupConversations(listedConversations, projects),
    [listedConversations, projects],
  );
  const projectCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of conversationGroups) {
      if (group.project) counts[group.project.id] = group.conversationIds.length;
    }
    return counts;
  }, [conversationGroups]);
  // 对话长到一定程度，最早的几轮就会被裁掉送不进模型。
  // 与其让用户发现"它怎么忘了前面说的"，不如提前说一声。
  const contextPressure = useMemo(() => {
    if (!activeConversation) return false;
    const bytes = activeConversation.messages
      .reduce((total, item) => total + new Blob([item.content]).size, 0);
    // 本机默认 8192 上下文，大约 6000 字节就该提醒了。云端宽得多。
    const budget = (activeConversation.provider || "local") === "local" ? 6000 : 60_000;
    return bytes > budget;
  }, [activeConversation?.messages.length, activeConversation?.provider]);

  const starredCount = useMemo(
    () => conversations.reduce((total, item) => total + item.messages.filter((m) => m.starred).length, 0),
    [conversations],
  );
  const activeProject = projects.find((project) => project.id === activeConversation?.projectId) || null;

  const searchHits = useMemo(
    () => (searchQuery.trim() ? searchConversations(conversations, searchQuery) : null),
    [conversations, searchQuery],
  );
  const searchHitGroups = useMemo(() => {
    if (!searchHits) return null;
    const groups: { label: string; hits: typeof searchHits }[] = [];
    const at = new Map<string, number>();
    for (const hit of searchHits) {
      const conversation = conversations.find((item) => item.id === hit.conversationId);
      const project = projects.find((item) => item.id === conversation?.projectId);
      const label = project ? project.name : "未分组";
      if (!at.has(label)) {
        at.set(label, groups.length);
        groups.push({ label, hits: [] });
      }
      groups[at.get(label)!].hits.push(hit);
    }
    return groups;
  }, [searchHits, conversations, projects]);
  const scrollOverflow = scrollState.scrollHeight > scrollState.clientHeight + 2;
  const scrollAwayFromBottom = scrollOverflow
    && scrollState.scrollHeight - scrollState.scrollTop - scrollState.clientHeight > 8;
  const scrollThumbHeight = scrollOverflow
    ? Math.max(14, Math.min(100, (scrollState.clientHeight / scrollState.scrollHeight) * 100))
    : 100;
  const scrollProgress = scrollOverflow
    ? scrollState.scrollTop / Math.max(1, scrollState.scrollHeight - scrollState.clientHeight)
    : 0;
  const scrollThumbTop = scrollProgress * (100 - scrollThumbHeight);

  const updateScrollState = useCallback(() => {
    const node = chatScroll.current;
    if (!node) return;
    setScrollState({
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    });
  }, []);

  // 浮动提示与自绘滚动条统一读这个实测值，不再各猜一个 126/205/225px。
  useEffect(() => {
    const node = composerWrap.current;
    if (!node) {
      document.documentElement.style.setProperty("--composer-height", "0px");
      return;
    }
    const sync = () => {
      document.documentElement.style.setProperty("--composer-height", `${Math.ceil(node.getBoundingClientRect().height)}px`);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    sync();
    return () => observer.disconnect();
  }, [bootPhase]);

  useEffect(() => {
    if (!storageEffectsReady) return;
    if (conversationStorageBlocked.current) return;
    const result = saveConversations(conversations);
    if (!result.ok) setStorageWarning(result.error || "对话没有保存成功。");
    else if (result.droppedConversations || result.droppedMessages) {
      setStorageWarning("本机存储接近上限，较早的对话内容已自动精简。");
    }
  }, [conversations, storageEffectsReady]);

  useEffect(() => {
    if (lastRequestId.current && !requestId
      && localStorage.getItem("kaii.dingdone.v1") === "1"
      && !document.hasFocus()) {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 784;
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
        osc.onended = () => void ctx.close();
      } catch {
        // 响不了拉倒。
      }
    }
    lastRequestId.current = requestId;
  }, [requestId]);

  useEffect(() => {
    const title = (activeConversation?.title);
    document.title = title && title !== "新对话" ? `${title} · kaii-agent` : "kaii-agent";
  }, [activeConversation?.title]);

  useEffect(() => {
    if (!bootError) return;
    try {
      const ring = JSON.parse(localStorage.getItem("kaii.errorlog.v1") || "[]") as { at: number; text: string }[];
      ring.unshift({ at: Date.now(), text: String(bootError).slice(0, 300) });
      localStorage.setItem("kaii.errorlog.v1", JSON.stringify(ring.slice(0, 30)));
    } catch {
      // 记不上就算了，日志不该反过来制造故障。
    }
  }, [bootError]);

  useEffect(() => {
    saveActiveConversationId(activeId);
    setOpenArtifact(null);
    setConversationMenu(null);
    msgNavIndex.current = -1;
    askNavIndex.current = -1;
    const saved = scrollMemory.current[activeId];
    followLatest.current = saved === undefined || saved === "bottom";
    pendingScrollRestore.current = typeof saved === "number" ? saved : null;
  }, [activeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const today = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem("kaii.autobackup.day") === today) return;
      const list = conversationsRef.current;
      if (!list.length) return;
      const payload = buildBackup(list, loadProjects(), loadPrompts());
      void window.kaiLocal.writeAutoBackup(payload).then((outcome) => {
        if (outcome.ok) localStorage.setItem("kaii.autobackup.day", today);
      }).catch(() => {});
    }, 8000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!zoomedImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomedImage(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomedImage]);

  useEffect(() => {
    if (!messageMenu) return;
    const close = () => setMessageMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, [messageMenu]);

  // 上一段对话的 id，Ctrl+Tab 在两段之间来回跳。
  // （previousActiveId 已被草稿交换逻辑占用，这里另立一个。）
  const quickSwitchPrevId = useRef<string | null>(null);
  const quickSwitchLastId = useRef<string | null>(null);
  useEffect(() => {
    if (quickSwitchLastId.current && quickSwitchLastId.current !== activeId) {
      quickSwitchPrevId.current = quickSwitchLastId.current;
    }
    quickSwitchLastId.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // [ ] 在「我的提问」之间跳。长对话里找回自己问过什么，比逐条翻快得多。
      if (event.key === "[" || event.key === "]") {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const asked = (conversationsRef.current.find((item) => item.id === activeIdRef.current)?.messages || [])
          .filter((item) => item.role === "user");
        if (!asked.length) return;
        event.preventDefault();
        const step = event.key === "]" ? 1 : -1;
        askNavIndex.current = (askNavIndex.current + step + asked.length * 2) % asked.length;
        followLatest.current = false;
        document.getElementById(`msg-${asked[askNavIndex.current].id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      // Home / End 跳到本段对话的开头和末尾（不在输入框里时）
      if (event.key === "Home" || event.key === "End") {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) return;
        const node = chatScroll.current;
        if (!node) return;
        event.preventDefault();
        followLatest.current = event.key === "End";
        node.scrollTo({ top: event.key === "Home" ? 0 : node.scrollHeight, behavior: "smooth" });
        return;
      }
      // ⌘⇧C 复制最后一条完成的回答
      if (event.key.toLowerCase() === "c" && (event.metaKey || event.ctrlKey) && event.shiftKey) {
        const last = [...(conversationsRef.current.find((item) => item.id === activeIdRef.current)?.messages || [])]
          .reverse()
          .find((item) => item.role === "assistant" && !item.pending && item.content.trim());
        if (last) {
          event.preventDefault();
          void navigator.clipboard.writeText(last.content);
        }
        return;
      }
      // ⌘1-9 直达侧栏列表里的第 N 段对话
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        const target = listedRef.current[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          setActiveId(target.id);
        }
        return;
      }
      // j/k 在消息列表里上下走（打字时不生效，开着弹层不生效）
      if (event.key === "j" || event.key === "k") {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable)) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (document.querySelector(".modal-backdrop")) return;
        const ids = (conversationsRef.current.find((item) => item.id === activeIdRef.current)?.messages || []).map((item) => item.id);
        if (!ids.length) return;
        event.preventDefault();
        const next = event.key === "j" ? msgNavIndex.current + 1 : msgNavIndex.current - 1;
        msgNavIndex.current = Math.max(0, Math.min(ids.length - 1, next));
        document.getElementById(`msg-${ids[msgNavIndex.current]}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }
      if (event.key !== "Tab" || !event.ctrlKey) return;
      const target = quickSwitchPrevId.current;
      if (!target || !conversationsRef.current.some((item) => item.id === target && !item.deletedAt)) return;
      event.preventDefault();
      setActiveId(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const table: Record<string, string> = {};
      const snapshot = new Map(draftsByConversation.current);
      snapshot.set(activeId, draft);
      for (const [id, text] of snapshot) {
        if (!text.trim()) continue;
        // 阅后即焚的对话连草稿也不落盘。
        if (conversationsRef.current.find((item) => item.id === id)?.ephemeral) continue;
        table[id] = text.slice(0, 20_000);
        if (Object.keys(table).length >= 20) break;
      }
      try {
        localStorage.setItem("kaii.drafts.v1", JSON.stringify(table));
      } catch {
        // 配额满时草稿舍弃，主数据优先。
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, activeId]);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { taskCapsulesRef.current = taskCapsules; }, [taskCapsules]);

  useEffect(() => {
    if (!storageEffectsReady) return;
    savePrompts(prompts);
  }, [prompts, storageEffectsReady]);

  useEffect(() => {
    if (!storageEffectsReady) return;
    const result = saveProjects(projects);
    if (!result.ok) setStorageWarning(result.error || "项目没有保存成功。");
  }, [projects, storageEffectsReady]);

  useEffect(() => {
    if (!storageEffectsReady || taskStorageBlocked.current) return;
    const result = saveTaskCapsules(taskCapsules);
    if (!result.ok) {
      // 配额或瞬时写盘失败不等于数据版本损坏；保留内存结果并在下一次变化时重试。
      setStorageWarning(`${result.error} 当前结果仍在本次运行中，退出前请导出。`);
    }
  }, [storageEffectsReady, taskCapsules]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = chatScroll.current;
      if (pendingScrollRestore.current !== null && node) {
        node.scrollTop = pendingScrollRestore.current;
        pendingScrollRestore.current = null;
        lastScrollTop.current = node.scrollTop;
      } else if (followLatest.current && node) {
        node.scrollTop = node.scrollHeight;
        lastScrollTop.current = node.scrollTop;
      }
      updateScrollState();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeConversation?.messages, activeId, initialState, requestId, updateScrollState]);

  useEffect(() => {
    const node = chatScroll.current;
    if (!node) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(node);
    const observedChildren = new Set<Element>();
    const observeContent = () => {
      for (const child of Array.from(node.children)) {
        if (observedChildren.has(child)) continue;
        observedChildren.add(child);
        observer.observe(child);
      }
      updateScrollState();
    };
    observeContent();
    const mutationObserver = new MutationObserver(observeContent);
    mutationObserver.observe(node, { childList: true });
    updateScrollState();
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [initialState, updateScrollState]);

  const initializeApp = useCallback(async () => {
    const attempt = ++bootAttempt.current;
    setBootPhase("loading");
    setBootFailure(null);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const state = await Promise.race([
        window.kaiLocal.getState(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("初始化等待超时，可以重试或检查设置。")), 12_000);
        }),
      ]);
      if (attempt !== bootAttempt.current) return;
      let restoreNotice = "";
      if (state.pendingRestore) {
        const reconciled = reconcilePendingRestore(state.pendingRestore);
        if (!reconciled.ok) throw new Error(reconciled.error);
        await window.kaiLocal.resolveRestoreTransaction(state.pendingRestore.id, reconciled.action);

        const reloaded = loadConversationsWithStatus();
        const reloadedConversations = reloaded.conversations.length ? reloaded.conversations : [fallbackConversation];
        conversationStorageBlocked.current = reloaded.status === "unsupported" || reloaded.status === "corrupt";
        conversationsRef.current = reloadedConversations;
        setConversations(reloadedConversations);
        setProjects(loadProjects());
        setPrompts(loadPrompts());
        setActiveId((current) => (
          reloadedConversations.some((item) => item.id === current) ? current : reloadedConversations[0].id
        ));
        restoreNotice = reconciled.action === "committed"
          ? "上次恢复已完整落盘，kaii 已回读确认。"
          : "上次恢复在提交中断，kaii 已回到恢复前的完整数据。";
      }
      setInitialState(state);
      setSettings(state.settings);
      setSkills(state.skills);
      setModelState(state.modelState);
      setWorkspaces(state.workspaces);
      setSearchProviders(state.searchProviders);
      setAllowedCommands(state.allowedCommands);
      setQuickHotkeyState(state.quickHotkeyState);
      setProviderList(state.providers);
      setWelcomeOpen(!readOnboardingChoice(localStorage) && !hasCloudProvider(state.providers));
      setQuickActions(state.quickActions);
      setTrayState(state.trayState);
      setBootSettingsOpen(false);
      setStorageEffectsReady(true);
      setBootPhase("ready");
      document.documentElement.dataset.theme = state.settings.theme;
      if (restoreNotice) setStorageWarning(restoreNotice);
      else if (taskStorageBlocked.current) {
        setStorageWarning(initialTaskStorage.status === "unsupported"
          ? "任务结果由更新版 kaii 写入，已保留原数据并暂停自动保存。"
          : "任务结果库完整性异常，已保留原数据并暂停自动保存。");
      }

      void window.kaiLocal.listKnowledge().then(setLibraries).catch(() => {});
      void window.kaiLocal.listSchedules().then(setSchedules).catch(() => {});
      // 回到窗口就刷一次：定时任务多半是趁人不在的时候跑完的。
      const onFocus = () => void window.kaiLocal.listSchedules().then(setSchedules).catch(() => {});
      cleanupFocusRefresh.current?.(); // 初始化重试时别叠一层监听
      window.addEventListener("focus", onFocus);
      cleanupFocusRefresh.current = () => window.removeEventListener("focus", onFocus);
      void window.kaiLocal.listSavedPages().then(setSavedPages).catch(() => {});
      void window.kaiLocal.listAgentRuns(80).then(setAgentRuns).catch(() => {});
      // 攒了一大堆三个月没动的对话时提醒一次。只提醒，不代删。
      setConversations((current) => {
        const stale = current.filter((item) => !item.archived && !isInTrash(item)
          && Date.now() - item.updatedAt > 90 * 86_400_000).length;
        if (stale > 30) {
          setStorageWarning(`有 ${stale} 段对话三个月没动过了。归档或删掉一些，列表会清爽很多。`);
        }
        return current;
      });
      // 回收站里超过三十天的真删掉。永远不清理的话它就成了另一个垃圾堆。
      setConversations((current) => {
        const expired = new Set(expiredInTrash(current));
        return expired.size ? current.filter((item) => !expired.has(item.id)) : current;
      });
      // 启动时清掉没有任何会话再引用的原图与识别记录，避免选了图又不发导致文件堆积。
      const stored = loadConversationsWithStatus();
      if (stored.status === "valid" || stored.status === "missing") {
        void window.kaiLocal.pruneImages(referencedAttachmentIds(stored.conversations)).catch(() => {});
        // 项目上常驻的文档也算被引用，否则启动清理会把它们删掉。
        const projectDocIds = loadProjects().flatMap((project) => project.documents.map((item) => item.id));
        void window.kaiLocal.pruneDocuments([...referencedDocumentIds(stored.conversations), ...projectDocIds]).catch(() => {});
      } else {
        setStorageWarning(stored.status === "unsupported"
          ? "检测到由更新版 kaii 写入的对话数据。已暂停自动保存和附件清理，原文件没有改动。"
          : "检测到对话数据不完整。已暂停自动保存和附件清理，原文件没有改动。"
        );
      }
    } catch (error) {
      if (attempt !== bootAttempt.current) return;
      setInitialState(null);
      setBootFailure(error instanceof Error ? error.message : "应用没有完成初始化");
      setBootPhase("error");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, []);

  const openBootSettings = useCallback(async () => {
    setBootSettingsBusy(true);
    try {
      // getState 失败时仍尝试直接读设置，这样模型路径配错也有地方改。
      const [result, providers] = await Promise.all([
        window.kaiLocal.updateSettings({}),
        window.kaiLocal.listProviders().catch(() => []),
      ]);
      setSettings(result.settings);
      setSkills(result.skills);
      setProviderList(providers);
      setBootSettingsOpen(true);
    } catch (error) {
      setBootFailure(error instanceof Error ? error.message : "设置也没有打开");
    } finally {
      setBootSettingsBusy(false);
    }
  }, []);

  useEffect(() => {
    void initializeApp();

    const offStatus = window.kaiLocal.onModelStatus(setModelState);
    const updateRevisionAssistant = (
      target: NonNullable<typeof streamTarget.current>,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      if (!target.revision) return false;
      const stage = revisionStage.current;
      if (!stage || stage.assistant.id !== target.messageId) return true;
      const assistant = updater(stage.assistant);
      revisionStage.current = { ...stage, assistant };
      setRevisionPreview({ conversationId: target.conversationId, kind: target.revision.kind, assistant });
      return true;
    };
    const offChunk = window.kaiLocal.onChatChunk(({ requestId: incoming, content }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      streamAnswerBuffers.current.set(incoming, (streamAnswerBuffers.current.get(incoming) || "") + content);
      if (updateRevisionAssistant(target, (message) => ({ ...message, content: message.content + content }))) return;
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== target.conversationId) return conversation;
        return {
          ...conversation,
          updatedAt: Date.now(),
          messages: conversation.messages.map((message) => (
            message.id === target.messageId
              ? { ...message, content: message.content + content }
              : message
          )),
        };
      }));
    });
    const offReasoning = window.kaiLocal.onChatReasoning(({ requestId: incoming, content }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      if (updateRevisionAssistant(target, (message) => ({
        ...message,
        reasoning: (message.reasoning || "") + content,
      }))) return;
      setConversations((current) => current.map((conversation) => (
        conversation.id !== target.conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) => (
                message.id === target.messageId
                  ? { ...message, reasoning: (message.reasoning || "") + content }
                  : message
              )),
            }
      )));
    });

    const offCitations = window.kaiLocal.onChatKnowledge(({ requestId: incoming, citations }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      if (updateRevisionAssistant(target, (message) => ({ ...message, citations }))) return;
      setConversations((current) => current.map((conversation) => (
        conversation.id !== target.conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) => (
                message.id === target.messageId ? { ...message, citations } : message
              )),
            }
      )));
    });
    const offMentions = window.kaiLocal.onChatMentions(({ requestId: incoming, mentions }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      const failed = mentions.filter((item) => !item.ok);
      if (failed.length) {
        setBootError(`没读到点名文件：${failed.map((item) => item.path).join("、")}`);
      }
    });

    const offSources = window.kaiLocal.onChatSources(({ requestId: incoming, sources }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      if (updateRevisionAssistant(target, (message) => ({ ...message, sources }))) return;
      setConversations((current) => current.map((conversation) => (
        conversation.id !== target.conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) => (
                message.id === target.messageId ? { ...message, sources } : message
              )),
            }
      )));
    });
    const offTool = window.kaiLocal.onChatTool((payload) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== payload.requestId) return;
      const { requestId: _ignored, ...receipt } = payload;
      if (updateRevisionAssistant(target, (message) => {
        const existing = message.toolCalls ?? [];
        const index = existing.findIndex((item) => item.callId === receipt.callId);
        const next = index >= 0
          ? existing.map((item, position) => (position === index ? { ...item, ...receipt } : item))
          : [...existing, receipt as ToolCallReceipt];
        return { ...message, toolCalls: next };
      })) return;
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== target.conversationId) return conversation;
        return {
          ...conversation,
          messages: conversation.messages.map((message) => {
            if (message.id !== target.messageId) return message;
            const existing = message.toolCalls ?? [];
            const index = existing.findIndex((item) => item.callId === receipt.callId);
            const next = index >= 0
              ? existing.map((item, position) => (position === index ? { ...item, ...receipt } : item))
              : [...existing, receipt as ToolCallReceipt];
            return { ...message, toolCalls: next };
          }),
        };
      }));
    });

    const closeMenus = () => {
      setConversationMenu(null);
      setPromptMenuOpen(false);
    };
    window.addEventListener("click", closeMenus);

    const offSpeakDone = window.kaiLocal.onSpeakDone(() => setSpeakingId(null));
    // 存网页时摘要是后台慢慢生成的，好了会推一份新清单过来。
    const offSavedPages = window.kaiLocal.onSavedPagesUpdated(setSavedPages);
    const offScreenshot = window.kaiLocal.onScreenshotRequested(() => {
      void captureScreen();
    });

    const offSpeech = window.kaiLocal.onSpeechEvent((payload) => {
      if (payload.type === "partial") {
        const base = draftBeforeSpeech.current;
        setDraft(base && payload.text ? `${base} ${payload.text}` : (payload.text || base));
        return;
      }
      if (payload.type === "final") {
        setListening(false);
        const base = draftBeforeSpeech.current;
        setDraft(base && payload.text ? `${base} ${payload.text}` : (payload.text || base));
        requestAnimationFrame(() => composer.current?.focus());
        return;
      }
      if (payload.type === "error") {
        setListening(false);
        setDraft(draftBeforeSpeech.current);
        setSpeechNote(payload.message || "听写没成功。");
      }
    });

    const offSchedules = window.kaiLocal.onScheduleUpdated(setSchedules);
    const offScheduleOpen = window.kaiLocal.onScheduleOpen(() => setScheduleOpen(true));

    const offAgentStart = window.kaiLocal.onAgentStart(({ requestId: incoming, runId, resumedFrom }) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      if (target.revision) {
        const stage = revisionStage.current;
        if (stage && stage.assistant.id === target.messageId) {
          const assistant = { ...stage.assistant, runId };
          revisionStage.current = {
            plan: disableResumedRunInRevision(stage.plan, resumedFrom),
            assistant,
          };
          setRevisionPreview({ conversationId: target.conversationId, kind: target.revision.kind, assistant });
        }
        if (resumedFrom) {
          setConversations((current) => current.map((conversation) => (
            conversation.id !== target.conversationId
              ? conversation
              : {
                  ...conversation,
                  messages: conversation.messages.map((message) => (
                    message.runId === resumedFrom ? { ...message, continuable: false } : message
                  )),
                }
          )));
        }
        return;
      }
      setConversations((current) => current.map((conversation) => (
        conversation.id !== target.conversationId
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((message) => {
                if (message.id === target.messageId) return { ...message, runId };
                // 新任务已经真正接上时，旧检查点的按钮退场，避免同一份进度被重复启动。
                if (resumedFrom && message.runId === resumedFrom) return { ...message, continuable: false };
                return message;
              }),
            }
      )));
    });

    const finish = (incoming: string, error?: string, sources?: WebSource[], completion?: ChatMessage["completion"] | null) => {
      const target = streamTarget.current;
      if (!target || target.requestId !== incoming) return;
      if (target.revision) {
        const stage = revisionStage.current;
        const completed = stage
          ? {
              ...stage.assistant,
              pending: false,
              sources: sources?.length ? sources : stage.assistant.sources,
              completion: completion ?? stage.assistant.completion,
            }
          : null;
        const revisionError = error || (!completed?.content.trim() ? "这次没有生成出内容，原对话没有改。" : null);
        const recoverable = completed && revisionError
          ? recoverableRevisionAssistant(completed, error || "这次暂停了，可以从这里继续。")
          : null;
        const branchAssistant = !revisionError ? completed : recoverable;
        if (stage && branchAssistant) {
          setConversations((current) => {
            const source = current.find((conversation) => conversation.id === stage.plan.sourceConversationId);
            if (!source) return current;
            const branch = commitChatRevision(source, stage.plan, branchAssistant, Date.now());
            return [branch, ...current];
          });
          if (activeIdRef.current === stage.plan.sourceConversationId) {
            setActiveId(stage.plan.branchId);
            setDraft("");
          }
          setEditSession((current) => (
            current?.conversationId === stage.plan.sourceConversationId
              && current.messageId === stage.plan.targetMessageId
              ? null
              : current
          ));
          if (revisionError) setBootError(revisionError);
        } else {
          if (stage?.plan.kind === "edit") {
            draftsByConversation.current.set(stage.plan.sourceConversationId, stage.plan.userMessage.content);
            if (activeIdRef.current === stage.plan.sourceConversationId) setDraft(stage.plan.userMessage.content);
          }
          if (revisionError) setBootError(revisionError);
        }
        revisionStage.current = null;
        revisionSourceLock.current = null;
        setRevisionPreview(null);
        streamTarget.current = null;
        sendLock.current = false;
        setPreparingConversationId(null);
        setRequestId(null);
        return;
      }
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== target.conversationId) return conversation;
        return {
          ...conversation,
          messages: conversation.messages.map((message) => (
            message.id === target.messageId
              ? {
                  ...message,
                  content: message.content || error || "这次没有生成出内容。",
                  pending: false,
                  error: Boolean(error),
                  sources: sources?.length ? sources : message.sources,
                  completion: completion ?? message.completion,
                }
              : message
          )),
        };
      }));
      streamTarget.current = null;
      revisionSourceLock.current = null;
      sendLock.current = false;
      setPreparingConversationId(null);
      setRequestId(null);
    };
    // 首轮问答结束后，让模型起一个真正的标题。这是纯锦上添花：
    // 失败、超时、模型没开都不影响主流程，列表里继续用截取的那份。
    const maybeTitle = (conversationId: string) => {
      setConversations((current) => {
        const conversation = current.find((item) => item.id === conversationId);
        if (!conversation || conversation.titleAuto) return current;
        const question = conversation.messages.find((message) => message.role === "user")?.content || "";
        const answer = conversation.messages.find((message) => message.role === "assistant" && !message.error)?.content || "";
        if (!question.trim() || !answer.trim()) return current;
        void window.kaiLocal.suggestTitle({ question, answer }).then((outcome) => {
          if (!outcome.ok || !outcome.title) return;
          setConversations((latest) => latest.map((item) => (
            item.id === conversationId ? { ...item, title: outcome.title, titleAuto: true } : item
          )));
        }).catch(() => {});
        return current.map((item) => (item.id === conversationId ? { ...item, titleAuto: true } : item));
      });
    };

    // 一轮结束后问模型有没有值得长期记住的事。只提议，存不存由用户点。
    const maybeMemories = (conversationId: string, messageId: string) => {
      setConversations((current) => {
        const conversation = current.find((item) => item.id === conversationId);
        const answer = conversation?.messages.find((item) => item.id === messageId);
        const question = conversation?.messages.filter((item) => item.role === "user").at(-1);
        if (!conversation || !answer?.content.trim() || !question?.content.trim()) return current;
        void window.kaiLocal.suggestMemories({
          question: question.content,
          answer: answer.content,
          provider: conversation.provider || "local",
          model: conversation.model || "",
        }).then((outcome) => {
          if (!outcome.suggestions.length) return;
          setConversations((latest) => latest.map((item) => (
            item.id !== conversationId
              ? item
              : {
                  ...item,
                  messages: item.messages.map((message) => (
                    message.id === messageId ? { ...message, memorySuggestions: outcome.suggestions } : message
                  )),
                }
          )));
        }).catch(() => {});
        return current;
      });
    };

    const offDone = window.kaiLocal.onChatDone(({
      requestId: incoming,
      sources,
      stopReason,
      completion,
      provider: completedProvider,
      model: completedModel,
    }) => {
      const continuationReason = continuationReasonForStop(stopReason);
      // 花了多久。慢的时候用户会怀疑是不是卡了，给个数字比什么都不说好。
      const startedAt = requestStartedAt.current;
      if (startedAt) {
        const target = streamTarget.current;
        if (target && target.requestId === incoming) {
          const elapsed = Date.now() - startedAt;
          if (!updateRevisionAssistant(target, (message) => ({ ...message, elapsedMs: elapsed }))) {
            updateConversation(target.conversationId, (conversation) => ({
              ...conversation,
              messages: conversation.messages.map((message) => (
                message.id === target.messageId ? { ...message, elapsedMs: elapsed } : message
              )),
            }));
          }
        }
        requestStartedAt.current = 0;
      }

      // 顺手要三条追问建议。要不到就当没有，绝不打扰主流程。
      const done = streamTarget.current;
      if (done && done.requestId === incoming) {
        const conversation = conversationsRef.current.find((item) => item.id === done.conversationId);
        const stage = done.revision ? revisionStage.current : null;
        const answer = stage?.assistant.content
          || conversation?.messages.find((item) => item.id === done.messageId)?.content
          || "";
        const question = stage?.plan.userMessage.content
          || [...(conversation?.messages || [])].reverse().find((item) => item.role === "user")?.content
          || "";
        if (answer.length > 80 && shouldEnrichRevisionResult(Boolean(done.revision), stopReason)) {
          void window.kaiLocal.suggestFollowups({ question, answer })
            .then((outcome) => {
              if (outcome.ok) setFollowups({ messageId: done.messageId, items: outcome.items });
            })
            .catch(() => {});
        }
      }
      const target = streamTarget.current;
      // 轮数用满而不是自然收尾时，这条回答后面要留一个"继续这个任务"的入口。
      if (target && target.requestId === incoming && continuationReason) {
        if (!updateRevisionAssistant(target, (message) => ({
          ...message,
          continuable: true,
          continueReason: continuationReason,
        }))) {
          setConversations((current) => current.map((conversation) => (
            conversation.id !== target.conversationId
              ? conversation
              : {
                  ...conversation,
                  messages: conversation.messages.map((message) => (
                    message.id === target.messageId
                      ? { ...message, continuable: true, continueReason: continuationReason }
                      : message
                  )),
                }
          )));
        }
      }
      const staged = target?.requestId === incoming && target.revision ? revisionStage.current : null;
      const successfulRevision = !staged || Boolean(staged.assistant.content.trim());
      const shouldEnrich = shouldEnrichRevisionResult(Boolean(staged), stopReason);
      const conversationId = target?.requestId === incoming && successfulRevision && shouldEnrich
        ? (staged?.plan.branchId || target.conversationId)
        : null;
      const messageId = target?.requestId === incoming ? target.messageId : null;
      if (target?.requestId === incoming) {
        const conversation = conversationsRef.current.find((item) => item.id === target.conversationId);
        const answer = streamAnswerBuffers.current.get(incoming)
          || staged?.assistant.content
          || conversation?.messages.find((item) => item.id === target.messageId)?.content
          || "";
        const verified = completion?.state === "verified";
        settleTrackedTask(incoming, {
          answer,
          status: verified ? "verified" : "unverified",
          summary: verified
            ? "任务已完成，产物与检查证据均通过回执核对。"
            : completion?.state === "partial"
              ? "任务只完成了一部分；现有结果可查看，但不能当作完整结论。"
              : "结果已返回；开放式回答尚无足够证据自动标记为已核对。",
        });
      }
      streamAnswerBuffers.current.delete(incoming);
      finish(incoming, undefined, sources, completion);
      void window.kaiLocal.listAgentRuns(80).then(setAgentRuns).catch(() => {});
      if (conversationId) requestAnimationFrame(() => maybeTitle(conversationId));
      if (conversationId && messageId) requestAnimationFrame(() => maybeMemories(conversationId, messageId));
    });
    const offError = window.kaiLocal.onChatError(({ requestId: incoming, message, runId, resumable }) => {
      const target = streamTarget.current;
      if (target?.requestId === incoming && resumable && runId) {
        const stagedRevision = updateRevisionAssistant(target, (item) => ({
          ...item,
          runId,
          continuable: true,
          continueReason: "interrupted",
        }));
        if (!stagedRevision) {
          setConversations((current) => current.map((conversation) => (
            conversation.id !== target.conversationId
              ? conversation
              : {
                  ...conversation,
                  messages: conversation.messages.map((item) => (
                    item.id === target.messageId
                      ? { ...item, runId, continuable: true, continueReason: "interrupted" }
                      : item
                  )),
                }
          )));
        }
      }
      settleTrackedTask(incoming, {
        answer: streamAnswerBuffers.current.get(incoming) || undefined,
        status: "retryable",
        summary: `任务中断：${message || "这次没有完成，可以重试。"}`,
      });
      streamAnswerBuffers.current.delete(incoming);
      finish(incoming, message);
      void window.kaiLocal.listAgentRuns(80).then(setAgentRuns).catch(() => {});
    });

    return () => {
      bootAttempt.current += 1;
      offStatus();
      offChunk();
      offReasoning();
      offCitations();
      offMentions();
      offSources();
      offTool();
      window.removeEventListener("click", closeMenus);
      offSavedPages();
      offSpeakDone();
      offScreenshot();
      offSpeech();
      offSchedules();
      offScheduleOpen();
      offAgentStart();
      offDone();
      offError();
    };
  }, [initializeApp, settleTrackedTask]);

  const rollbackAgentRun = useCallback(async (runId: string) => {
    setBootError(null);
    try {
      const result = await window.kaiLocal.rollbackAgentRun(runId);
      setConversations((current) => current.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.runId === runId && message.toolCalls
            ? { ...message, toolCalls: message.toolCalls.map((call) => (call.canRollback ? { ...call, rolledBack: true } : call)) }
            : message
        )),
      })));
      if (result.failed.length) {
        setBootError(`有 ${result.failed.length} 处没有撤销成功：${result.failed.map((item) => item.message).join("；")}`);
      }
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这次任务的改动没有撤销成功");
    }
  }, []);

  const decideToolCall = useCallback(async (callId: string, approved: boolean) => {
    try {
      await window.kaiLocal.approveToolCall(callId, approved);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这次确认没有送达");
    }
  }, []);

  const rollbackToolCall = useCallback(async (callId: string) => {
    setBootError(null);
    try {
      await window.kaiLocal.rollbackToolCall(callId);
      setConversations((current) => current.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => (
          message.toolCalls?.some((call) => call.callId === callId)
            ? {
                ...message,
                toolCalls: message.toolCalls.map((call) => (
                  call.callId === callId ? { ...call, rolledBack: true } : call
                )),
              }
            : message
        )),
      })));
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这次改动没有撤销成功");
    }
  }, []);

  const updateConversation = useCallback((conversationId: string, updater: (conversation: Conversation) => Conversation) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId ? updater(conversation) : conversation
    )));
  }, []);

  const localOnly = Boolean(settings?.localOnly);
  const browsingWithoutModel = isBrowsingWithoutModel(onboardingChoice, providerList, modelState.status === "ready");
  const activeProvider = providerList.find((item) => item.id === (activeConversation?.provider || "local")) || null;
  // 选择器上显示的是"这段对话真正在用哪个模型"，不是笼统的来源名。
  // 断网模式是运行时的硬约束：旧对话仍记得原来的云端选择，但在关掉断网前不会真的走云端。
  const usingCloud = !localOnly && (activeConversation?.provider || "local") !== "local";
  const currentModelLabel = (() => {
    const provider = activeConversation?.provider || "local";
    const model = activeConversation?.model || "";
    if (provider === "local") return "本机模型";
    for (const section of catalog) {
      const hit = section.items.find((item) => item.provider === provider && item.model === model);
      if (hit) return hit.label;
    }
    return model || activeProvider?.label || "选择模型";
  })();
  const localModelShortStatus = modelState.status === "ready"
    ? "可用"
    : modelState.status === "starting" ? "启动中" : "未启动";

  const chooseModel = useCallback((providerId: string, modelId: string) => {
    if (!activeConversation || requestId) return;
    if (localOnly && providerId !== "local") {
      setStorageWarning("仅本机模式开着，云端模型暂时不可选。关掉右上角的「仅本机」后再试。");
      setModelMenuOpen(false);
      return;
    }
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      provider: providerId,
      model: modelId || undefined,
    }));
    setModelMenuOpen(false);
  }, [activeConversation, localOnly, requestId, updateConversation]);



  const loadProviderModels = useCallback(async (providerId: string) => {
    if (localOnly || providerId === "local" || providerModels[providerId]) return;
    const outcome = await window.kaiLocal.fetchProviderModels(providerId).catch(() => null);
    if (outcome?.models?.length) {
      setProviderModels((current) => ({ ...current, [providerId]: outcome.models }));
    }
  }, [localOnly, providerModels]);

  // 恢复只添不删，但“只添不删”不代表可以分三个 effect 慢慢写。
  // 统一管线为：严格解析 → 组合容量预检 → 主进程 0600 封存新旧字节
  // → 同步提交 → 三库重读。任一步失败都回到原字节。
  const restoreFromBackup = useCallback(async (
    content: string,
  ): Promise<{ conversations: number; projects: number; prompts: number } | null> => {
    const planned = planBackupRestore(content, {
      conversations: conversationsRef.current,
      projects,
      prompts,
    });
    if (!planned.ok) {
      setStorageWarning(planned.error);
      return null;
    }
    const { plan } = planned;
    try {
      await window.kaiLocal.prepareRestoreTransaction({
        version: plan.version,
        id: plan.id,
        createdAt: plan.createdAt,
        previous: plan.previous,
        target: plan.target,
      });
    } catch (error) {
      setStorageWarning(error instanceof Error ? error.message : "恢复快照没有封存成功，原数据没有改动。");
      return null;
    }

    const committed = commitRestorePlan(plan);
    if (!committed.ok) {
      await window.kaiLocal.resolveRestoreTransaction(plan.id, "rolled_back").catch(() => {});
      setStorageWarning(committed.error);
      return null;
    }

    const reloadedConversations = loadConversationsWithStatus();
    const reloadedProjects = loadProjects();
    const reloadedPrompts = loadPrompts();
    const exactIds = (left: { id: string }[], right: { id: string }[]) => (
      left.length === right.length && left.every((item, index) => item.id === right[index]?.id)
    );
    const verified = reloadedConversations.status === "valid"
      && exactIds(reloadedConversations.conversations, plan.next.conversations.filter((item) => !item.ephemeral))
      && exactIds(reloadedProjects, plan.next.projects)
      && exactIds(reloadedPrompts, plan.next.prompts);
    if (!verified) {
      const rolledBack = rollbackRestorePlan(plan);
      await window.kaiLocal.resolveRestoreTransaction(plan.id, "rolled_back").catch(() => {});
      setStorageWarning(rolledBack.ok
        ? "恢复落盘后的回读核对未通过，已完整回到恢复前。"
        : rolledBack.error);
      return null;
    }

    await window.kaiLocal.resolveRestoreTransaction(plan.id, "committed");
    conversationStorageBlocked.current = false;
    conversationsRef.current = reloadedConversations.conversations;
    setConversations(reloadedConversations.conversations);
    setProjects(reloadedProjects);
    setPrompts(reloadedPrompts);
    setActiveId((current) => (
      reloadedConversations.conversations.some((item) => item.id === current)
        ? current
        : reloadedConversations.conversations[0]?.id || fallbackConversation.id
    ));
    setStorageWarning(
      `已落盘并回读：新增 ${plan.counts.conversations} 段对话、${plan.counts.projects} 个项目、${plan.counts.prompts} 条指令。`,
    );
    return plan.counts;
  }, [fallbackConversation.id, projects, prompts]);

  // 在本段对话的命中之间来回跳。到头就绕回去——找东西的时候
  // 卡在最后一条不动比绕回去更让人困惑。
  const jumpToFind = useCallback((step: 1 | -1) => {
    const needle = (inChatFind || "").trim().toLowerCase();
    if (!needle) return;
    const hits = (conversationsRef.current.find((item) => item.id === activeIdRef.current)?.messages || [])
      .filter((item) => item.content.toLowerCase().includes(needle));
    if (!hits.length) return;
    const next = (findCursor.current + step + hits.length * 2) % hits.length;
    findCursor.current = next;
    followLatest.current = false;
    document.getElementById(`msg-${hits[next].id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [inChatFind]);

  // 从别家搬来的会话直接并入列表（新 id 不会撞车，只添不删）。
  // 搬完自动按来源标签筛上：几百段搬进来光说「打了标签」没用，
  // 侧栏立刻只剩这批才算搬到位。筛选动作放在这里，保证两个入口行为一致。
  const importConversations = useCallback((incoming: Conversation[]): ChatGptImportOutcome => {
    if (conversationStorageBlocked.current) {
      return { accepted: [], duplicates: 0, capacitySkipped: 0, storageBlocked: true };
    }
    const plan = planChatGptImport(conversationsRef.current, incoming);
    if (plan.accepted.length) {
      const next = [...conversationsRef.current, ...plan.accepted];
      conversationsRef.current = next;
      setConversations(next);
      const sourceTag = plan.accepted[0].tags?.[0];
      if (sourceTag) setTagFilter([sourceTag]);
    }
    return { ...plan, storageBlocked: false };
  }, []);

  const cycleProjectColor = useCallback((projectId: string) => {
    setProjects((current) => current.map((project) => {
      if (project.id !== projectId) return project;
      const at = PROJECT_COLORS.indexOf(project.color || "");
      const next = PROJECT_COLORS[(at + 1) % PROJECT_COLORS.length];
      return { ...project, color: next || undefined, updatedAt: Date.now() };
    }));
  }, []);

  // 拖完给每个项目都写上 sortIndex：从这一刻起顺序归用户管。
  const reorderProjects = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    setProjects((current) => {
      const dragged = current.find((project) => project.id === draggedId);
      if (!dragged) return current;
      const rest = current.filter((project) => project.id !== draggedId);
      const at = rest.findIndex((project) => project.id === targetId);
      if (at < 0) return current;
      rest.splice(at, 0, dragged);
      return rest.map((project, index) => ({ ...project, sortIndex: index }));
    });
  }, []);

  const moveConversation = useCallback((conversationId: string, projectId: string | undefined) => {
    setConversations((current) => current.map((conversation) => (
      conversation.id === conversationId ? { ...conversation, projectId } : conversation
    )));
  }, []);

  // 从某一轮分出一段新对话：保留到这条为止的上下文，之后各走各的。
  // 想换个方向问又不舍得毁掉原来那段时，这比"编辑重发"更合适。
  const branchConversation = useCallback((messageId: string) => {
    if (!activeConversation || requestId) return;
    const index = activeConversation.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const now = Date.now();
    const branch: Conversation = {
      ...activeConversation,
      id: randomId("chat"),
      title: `${activeConversation.title}（分支）`,
      titleAuto: true,
      messages: activeConversation.messages.slice(0, index + 1).map((message) => ({ ...message })),
      createdAt: now,
      updatedAt: now,
      branchedFrom: { conversationId: activeConversation.id, title: activeConversation.title },
    };
    setConversations((current) => [branch, ...current]);
    setActiveId(branch.id);
    followLatest.current = true;
    requestAnimationFrame(() => composer.current?.focus());
  }, [activeConversation, requestId]);

  const saveBlob = useCallback((content: string, mime: string, fileName: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportConversation = useCallback(async (conversation: Conversation, format: "md" | "html" | "pdf" | "pdf-clean" | "txt") => {
    setConversationMenu(null);
    if (format === "txt") {
      // 纯文本：给不认 Markdown 的地方用（邮件正文、工单系统、记事本）。
      const text = conversation.messages
        .map((item) => `${item.role === "user" ? "我" : "kaii"}：\n${stripMarkdown(item.content)}`)
        .join("\n\n");
      saveBlob(text, "text/plain;charset=utf-8", safeFileName(conversation.title, "txt"));
      return;
    }
    if (format === "md") {
      saveBlob(conversationToMarkdown(conversation), "text/markdown;charset=utf-8", safeFileName(conversation.title, "md"));
      return;
    }
    // pdf-clean：附件文件名也不带。文件名本身可能就是隐私（「体检报告.pdf」）。
    const html = conversationToHtml(conversation, format === "pdf-clean" ? { omitAttachmentNotes: true } : {});
    if (format === "html") {
      saveBlob(html, "text/html;charset=utf-8", safeFileName(conversation.title, "html"));
      return;
    }
    const outcome = await window.kaiLocal.exportPdf({ html, fileName: safeFileName(conversation.title, "pdf") });
    // 用户按取消是正常操作，不弹东西。
    if (!outcome.ok && !outcome.cancelled) setBootError(outcome.message || "PDF 没有导出成功");
  }, [saveBlob]);

  // 全部对话打包成一个 zip：每段一个 .md，文件名带日期前缀好排序。
  // 复用画布 Word 导出那套零依赖 zip 写入器，不引第三方库。
  const exportAllConversations = useCallback(async () => {
    const { buildZip } = await import("./lib/docx.ts");
    const alive = conversationsRef.current.filter((item) => !item.deletedAt && !item.ephemeral && item.messages.length);
    if (!alive.length) {
      setBootError("还没有可以导出的对话。");
      return;
    }
    const used = new Set<string>();
    const entries = alive.map((conversation) => {
      const day = new Date(conversation.updatedAt || Date.now()).toISOString().slice(0, 10);
      let name = `${day}-${safeFileName(conversation.title, "md")}`;
      // zip 里同名会互相覆盖，重名的挂个序号。
      let serial = 2;
      while (used.has(name)) {
        name = `${day}-${serial}-${safeFileName(conversation.title, "md")}`;
        serial += 1;
      }
      used.add(name);
      // buildZip 要字节：这里统一按 UTF-8 编码，中文标题和正文都不会乱。
      return { name, data: new TextEncoder().encode(conversationToMarkdown(conversation)) };
    });
    const bytes = buildZip(entries);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/zip" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `kaii-对话-${new Date().toISOString().slice(0, 10)}.zip`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    setStorageWarning(`已导出 ${entries.length} 段对话。`);
  }, []);

  const createChat = useCallback(() => {
    // 当前已经是一张完全没动过的空纸时，“新对话”只需要把焦点送回输入框。
    // 否则连点几次就会在侧栏堆出一排同名空壳。
    if (activeConversation
      && activeConversation.messages.length === 0
      && !draft.trim()
      && !attachment
      && !documentAttachment) {
      followLatest.current = true;
      requestAnimationFrame(() => composer.current?.focus());
      return;
    }
    // 在某个项目里新建对话时留在这个项目，不用再手动归档一次。
    const conversation = newConversation(activeConversation?.skillId || "none", activeConversation?.projectId);
    // 模型选择跟着走。上一段特意换成了 GLM，新建一段又跳回自动，
    // 等于每次都要重选一遍。项目钉了默认模型的话以项目为准。
    const projectDefault = projects.find((item) => item.id === conversation.projectId);
    if (projectDefault?.defaultProvider) {
      conversation.provider = projectDefault.defaultProvider;
      conversation.model = projectDefault.defaultModel;
    } else {
      conversation.provider = activeConversation?.provider;
      conversation.model = activeConversation?.model;
    }
    followLatest.current = true;
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    setDraft("");
    setAttachment(null);
    setDocumentAttachments([]);
    requestAnimationFrame(() => composer.current?.focus());
  }, [projects, activeConversation, attachment, documentAttachment, draft]);

  // 面板里的命令。顺序就是没输入内容时的默认排序，
  // 所以把日常最常用的排前面，模型和历史对话垫后。
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { id: "new-ephemeral", label: "开一段不留记录的对话", group: "常用", kind: "action",
        keywords: ["ephemeral", "incognito", "buliuji", "隐私", "阅后即焚"],
        run: () => {
          const conversation = newConversation();
          conversation.ephemeral = true;
          conversation.title = "不留记录的对话";
          setConversations((current) => [conversation, ...current]);
          setActiveId(conversation.id);
        } },
      { id: "new-chat", label: "新建对话", hint: "⌘N", group: "常用", kind: "action",
        keywords: ["new", "xinjian", "duihua", "开一段"], run: () => createChat() },
      { id: "search", label: "搜索历史对话", hint: "⇧⌘F", group: "常用", kind: "action",
        keywords: ["search", "sousuo", "找", "history"], run: () => {
          setSidebarOpen(true);
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".chat-search input")?.focus());
        } },
      { id: "settings", label: "设置", hint: "⌘,", group: "常用", kind: "action",
        keywords: ["settings", "shezhi", "配置", "api", "key"], run: () => setSettingsOpen(true) },
      { id: "task-workbench", label: "任务与结果", group: "常用", kind: "action",
        keywords: ["task", "result", "renwu", "jieguo", "任务", "结果", "收件箱"], run: () => setTaskWorkbenchOpen(true) },
      { id: "schedule", label: "定时任务", group: "面板", kind: "action",
        keywords: ["schedule", "dingshi", "每天", "提醒", "cron"], run: () => setScheduleOpen(true) },
      { id: "archive-stale", label: "归档三个月没动的对话", group: "常用", kind: "action",
        keywords: ["guidang", "archive", "清理", "旧对话"],
        run: () => {
          const cutoff = Date.now() - 90 * 86_400_000;
          const stale = conversations.filter((item) => (
            !item.deletedAt && !item.archived && !item.pinned && !item.ephemeral
            && item.messages.length > 0 && item.updatedAt < cutoff
          ));
          if (!stale.length) {
            setStorageWarning("没有三个月没动的对话，不用归档。");
            return;
          }
          if (!window.confirm(`把 ${stale.length} 段三个月没动的对话收进归档？不删除，随时能翻出来。置顶的不动。`)) return;
          const ids = new Set(stale.map((item) => item.id));
          setConversations((current) => current.map((item) => (
            ids.has(item.id) ? { ...item, archived: true } : item
          )));
          setStorageWarning(`已归档 ${stale.length} 段。侧栏底部「归档」里都在。`);
        } },
      { id: "import-chatgpt", label: "从 ChatGPT 导入对话", group: "面板", kind: "action",
        keywords: ["import", "daoru", "chatgpt", "搬家", "迁移", "conversations.json"],
        run: () => {
          // 和设置里那个入口同一段逻辑：选官方导出的 conversations.json，
          // 只搬当前对话线（放弃的重新生成分支不搬），统一打「ChatGPT」标签。
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".json";
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
              const { conversations: incoming, skipped } = parseChatGptExport(await file.text());
              const outcome = importConversations(incoming);
              setStorageWarning(describeChatGptImport(outcome, skipped));
            } catch (error) {
              setBootError(error instanceof Error ? error.message : "这份文件读不了。");
            }
          };
          input.click();
        } },
      { id: "open-data", label: "打开数据目录", group: "面板", kind: "action",
        keywords: ["data", "shujumulu", "finder", "userdata"],
        run: () => void window.kaiLocal.openDataDir() },
      { id: "yesterday", label: "昨天聊到哪了", group: "常用", kind: "action",
        keywords: ["zuotian", "yesterday", "回顾", "上次"],
        run: () => {
          const dayStart = new Date();
          dayStart.setHours(0, 0, 0, 0);
          const before = conversations
            .filter((item) => !item.deletedAt && !item.ephemeral && item.messages.length && item.updatedAt < dayStart.getTime())
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (!before) {
            setBootError("今天之前没有聊过的记录。");
            return;
          }
          setActiveId(before.id);
        } },
      { id: "mini", label: miniMode ? "回到正常大小" : "迷你模式（钉在最前面）", group: "常用", kind: "action",
        keywords: ["mini", "xiaochuangkou", "悬浮", "置顶", "always on top"],
        run: () => {
          const next = !miniMode;
          setMiniMode(next);
          void window.kaiLocal.setMiniWindow(next).then((result) => setMiniMode(result.mini));
        } },
      { id: "trash", label: "回收站", group: "面板", kind: "action",
        keywords: ["trash", "huishouzhan", "删除", "恢复"], run: () => setTrashOpen(true) },
      { id: "audit", label: "工程模式动过什么", group: "面板", kind: "action",
        keywords: ["audit", "jilu", "记录", "改过", "日志"], run: () => setAuditOpen(true) },
      { id: "review", label: "回顾：这些天在用它做什么", group: "面板", kind: "action",
        keywords: ["review", "huigu", "统计", "用量", "总结"], run: () => setReviewOpen(true) },
      { id: "starred", label: "收藏的回答", group: "面板", kind: "action",
        keywords: ["star", "shoucang", "星标", "收藏"], run: () => setStarredOpen(true) },
      { id: "shortcuts", label: "快捷键速查", group: "常用", kind: "action",
        keywords: ["shortcut", "kuaijiejian", "键盘", "help"], run: () => setShortcutsOpen(true) },
      { id: "readlater", label: "存下来的网页", group: "面板", kind: "action",
        keywords: ["readlater", "cunwangye", "网页", "收藏", "稍后读"], run: () => setReadLaterOpen(true) },
      { id: "knowledge", label: "知识库", group: "面板", kind: "action",
        keywords: ["knowledge", "zhishiku", "文件夹", "资料"], run: () => setKnowledgeOpen(true) },
      { id: "compare", label: "比一比两个模型", group: "面板", kind: "action",
        keywords: ["compare", "bibi", "对比", "并排"], run: () => {
          if (!catalog.length) void window.kaiLocal.fetchModelCatalog().then(setCatalog).catch(() => {});
          setCompareOpen(true);
        } },
      { id: "batch", label: "批量处理", group: "面板", kind: "action",
        keywords: ["batch", "piliang", "一批"], run: () => setBatchOpen(true) },
      { id: "memory", label: "记忆", group: "面板", kind: "action",
        keywords: ["memory", "jiyi", "记住"], run: () => {
          void window.kaiLocal.listMemories(true).then((entries) => {
            setMemories(entries);
            setMemoryOpen(true);
          }).catch((error) => setBootError(error instanceof Error ? error.message : "记忆库没有打开"));
        } },
      { id: "workspace", label: "工作区", group: "面板", kind: "action",
        keywords: ["workspace", "gongzuoqu", "目录", "项目路径"], run: () => setWorkspaceOpen(true) },
      { id: "projects", label: "项目", group: "面板", kind: "action",
        keywords: ["project", "xiangmu", "分组"], run: () => setProjectPanelOpen(true) },
      { id: "quick", label: "剪贴板浮窗", hint: "⇧⌘K", group: "面板", kind: "action",
        keywords: ["quick", "jiantieban", "clipboard", "浮窗"], run: () => void window.kaiLocal.openQuickWindow() },
      { id: "sidebar", label: sidebarOpen ? "收起侧栏" : "展开侧栏", group: "面板", kind: "action",
        keywords: ["sidebar", "celan", "侧边栏"], run: () => setSidebarOpen((value) => !value) },
    ];

    list.push({
      id: "model-auto",
      label: "换成：自动挑模型",
      hint: "按任务选择",
      group: "换模型",
      kind: "model",
      keywords: ["auto", "zidong", "模型"],
      disabled: Boolean(requestId),
      run: () => {
        if (!activeConversation) return;
        updateConversation(activeConversation.id, (conversation) => ({
          ...conversation, provider: undefined, model: undefined,
        }));
      },
    });
    for (const section of catalog) {
      for (const item of section.items) {
        list.push({
          id: `model-${item.provider}-${item.model}`,
          label: `换成：${item.label}`,
          hint: localOnly && item.provider !== "local"
            ? "仅本机模式下暂停"
            : item.configured ? item.note : "需要先填 API key",
          group: "换模型",
          kind: "model",
          keywords: [item.model, item.provider, section.group, "模型", "model"],
          disabled: !item.configured
            || (localOnly && item.provider !== "local")
            || Boolean(requestId),
          run: () => chooseModel(item.provider, item.model),
        });
      }
    }

    for (const item of sortPrompts(prompts)) {
      list.push({
        id: `prompt-${item.id}`,
        label: `用指令：${item.label}`,
        hint: item.body.length > 40 ? `${item.body.slice(0, 40)}…` : item.body,
        group: "我的指令",
        kind: "prompt",
        keywords: ["prompt", "zhiling", "指令"],
        run: () => {
          const filled = fillPromptVariables(item.body, {
            selection: window.getSelection()?.toString().trim() || undefined,
          });
          setDraft((current) => (current.trim() ? `${filled}\n\n${current.trim()}` : filled));
          setPrompts((current) => current.map((entry) => (
            entry.id === item.id ? { ...entry, useCount: entry.useCount + 1 } : entry
          )));
          requestAnimationFrame(() => composer.current?.focus());
        },
      });
    }

    // 只放最近 12 段，再多就把面板变成第二个侧栏了。
    for (const conversation of conversations.slice(0, 12)) {
      if (conversation.id === activeId) continue;
      list.push({
        id: `chat-${conversation.id}`,
        label: conversation.title || "未命名对话",
        hint: "跳到这段对话",
        group: "最近对话",
        kind: "conversation",
        run: () => { setActiveId(conversation.id); },
      });
    }
    return list;
  }, [activeConversation, activeId, catalog, chooseModel, conversations, createChat, localOnly, miniMode, prompts, requestId, sidebarOpen, updateConversation]);

  // 删除改成"扔进回收站"。真删要去回收站里再删一次。
  // 手滑删掉一段两小时的对话是不可逆的损失，多一步很值。
  const deleteChat = useCallback((conversationId: string) => {
    if (revisionBlocksConversationMutation(revisionSourceLock.current, conversationId)) {
      setBootError("正在生成修改后的版本，先停止再移动这段对话。");
      return;
    }
    if (requestId && streamTarget.current?.conversationId === conversationId) {
      void window.kaiLocal.cancelMessage(requestId);
    }
    setConversations((current) => {
      const marked = current.map((conversation) => (
        conversation.id === conversationId ? { ...conversation, deletedAt: Date.now() } : conversation
      ));
      if (activeId === conversationId) {
        const next = marked.find((item) => item.id !== conversationId && isVisible(item));
        if (next) setActiveId(next.id);
        else {
          const replacement = newConversation();
          setActiveId(replacement.id);
          return [replacement, ...marked];
        }
      }
      return marked;
    });
    setStorageWarning("已经扔进回收站，三十天内都能捞回来。");
  }, [activeId, requestId]);

  const purgeChat = useCallback((conversationId: string) => {
    if (revisionBlocksConversationMutation(revisionSourceLock.current, conversationId)) {
      setBootError("正在生成修改后的版本，先停止再彻底删除。");
      return;
    }
    setConversations((current) => current.filter((item) => item.id !== conversationId));
  }, []);

  const toggleArchiveChat = useCallback((conversationId: string) => {
    if (revisionBlocksConversationMutation(revisionSourceLock.current, conversationId)) {
      setBootError("正在生成修改后的版本，先停止再归档。");
      return;
    }
    updateConversation(conversationId, (item) => ({ ...item, archived: !item.archived }));
  }, [updateConversation]);

  const restoreChat = useCallback((conversationId: string) => {
    setConversations((current) => current.map((item) => (
      item.id === conversationId ? { ...item, deletedAt: undefined } : item
    )));
  }, []);

  const startModel = useCallback(async () => {
    setBootError(null);
    try {
      const state = await window.kaiLocal.startModel();
      setModelState(state);
      return state.status === "ready";
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "模型没有启动成功");
      return false;
    }
  }, []);

  const openMemoryPanel = useCallback(async () => {
    setBootError(null);
    try {
      const entries = await window.kaiLocal.listMemories(true);
      setMemories(entries);
      setMemoryOpen(true);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "记忆库没有打开");
    }
  }, []);

  const chooseImage = useCallback(async () => {
    if (requestId || imageBusy) return;
    setBootError(null);
    setImageBusy(true);
    try {
      const selected = await window.kaiLocal.chooseAndAnalyzeImage();
      if (selected) {
        const previous = attachment;
        setAttachment(selected);
        // 换图时立刻删掉上一张没发出去的原图和识别记录，不留孤儿文件。
        if (previous) void window.kaiLocal.discardImage(previous.id).catch(() => {});
      }
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这张图片没有识别成功");
    } finally {
      setImageBusy(false);
    }
  }, [attachment, imageBusy, requestId]);

  const captureScreen = useCallback(async () => {
    if (requestId || imageBusy) return;
    setBootError(null);
    setImageBusy(true);
    try {
      const outcome = await window.kaiLocal.captureScreenshot("region");
      // 按 esc 取消是正常操作，不该弹任何东西。
      if (outcome.cancelled) return;
      if (!outcome.ok || !outcome.attachment) {
        if (outcome.message) setBootError(outcome.message);
        return;
      }
      const previous = attachment;
      setAttachment(outcome.attachment);
      if (previous) void window.kaiLocal.discardImage(previous.id).catch(() => {});
      requestAnimationFrame(() => composer.current?.focus());
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这张截图没读进来");
    } finally {
      setImageBusy(false);
    }
  }, [attachment, imageBusy, requestId]);

  const discardAttachment = useCallback(() => {
    if (!attachment) return;
    const discarded = attachment;
    setAttachment(null);
    void window.kaiLocal.discardImage(discarded.id).catch(() => {});
  }, [attachment]);

  const chooseDocument = useCallback(async () => {
    if (requestId || documentBusy) return;
    setBootError(null);
    setDocumentBusy(true);
    try {
      const selected = await window.kaiLocal.chooseAndReadDocument();
      if (selected) addDocumentAttachment(selected);
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这份文档没有读成功");
    } finally {
      setDocumentBusy(false);
    }
  }, [documentAttachment, documentBusy, requestId]);

  // 拖文件进来比点文件选择器自然得多。类型判断放在主进程，渲染层只负责给出路径。
  const acceptDroppedFile = useCallback(async (filePath: string) => {
    if (requestId || imageBusy || documentBusy) return;
    setBootError(null);
    const isImage = /\.(png|jpe?g|heic|heif|webp|tiff?)$/i.test(filePath);
    if (isImage) setImageBusy(true);
    else setDocumentBusy(true);
    try {
      const outcome = await window.kaiLocal.handleDroppedFile(filePath);
      if (outcome.kind === "image") {
        const previous = attachment;
        setAttachment(outcome.attachment);
        if (previous) void window.kaiLocal.discardImage(previous.id).catch(() => {});
      } else if (outcome.kind === "knowledge") {
        // 拖进来的是文件夹：直接收成知识库。
        setLibraries(outcome.libraries);
        setStorageWarning(`「${outcome.library.label}」已经收成知识库了，去建一下索引就能搜。`);
      } else {
        addDocumentAttachment(outcome.document);
      }
      requestAnimationFrame(() => composer.current?.focus());
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "这个文件没有读成功");
    } finally {
      setImageBusy(false);
      setDocumentBusy(false);
    }
  }, [attachment, documentAttachment, documentBusy, imageBusy, requestId]);

  const copyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 1600);
    } catch {
      setBootError("这段内容没有复制成功");
    }
  }, []);

  const startEdit = useCallback((message: ChatMessage) => {
    if (!activeConversation || requestId) return;
    const index = activeConversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0 || message.role !== "user") return;
    setEditSession({
      conversationId: activeConversation.id,
      messageId: message.id,
      previousDraft: editSession?.conversationId === activeConversation.id
        ? editSession.previousDraft
        : draft,
    });
    setDraft(message.content);
    requestAnimationFrame(() => composer.current?.focus());
  }, [activeConversation, draft, editSession, requestId]);

  const cancelEdit = useCallback(() => {
    if (!editSession || requestId) return;
    if (editSession.conversationId === activeId) setDraft(editSession.previousDraft);
    setEditSession(null);
    requestAnimationFrame(() => composer.current?.focus());
  }, [activeId, editSession, requestId]);

  const send = useCallback(async (
    suggestion?: string,
    resumeRunId?: string,
    explicitRevision?: ChatRevisionIntent,
  ): Promise<boolean> => {
    if (bootPhase !== "ready" || !initialState || !activeConversation || requestId || sendLock.current) return false;
    if (browsingWithoutModel) {
      setWelcomeOpen(true);
      return false;
    }
    if (activeConversation.detachedContext) {
      setBootError("这段历史对话仅供查阅，请新建对话。");
      return false;
    }
    const webForThisSend = localOnly ? false : sendWebOnce.current;
    sendWebOnce.current = null;
    const content = (suggestion ?? draft).trim()
      || (attachment ? "请分析这张图片。" : "")
      || (documentAttachment ? "帮我看看这份文档，先说它在讲什么。" : "");
    if (!content) return false;

    const revisionIntent = explicitRevision
      || (suggestion === undefined && editSession?.conversationId === activeConversation.id
        ? { kind: "edit" as const, targetMessageId: editSession.messageId }
        : undefined);
    const now = Date.now();
    const revisionPlan = revisionIntent
      ? prepareChatRevision(activeConversation, revisionIntent, {
          content,
          branchId: randomId("chat"),
          userMessageId: randomId("msg"),
          assistantMessageId: randomId("msg"),
          createdAt: now,
          ...(revisionIntent.kind === "edit" && attachment ? { attachment } : {}),
          ...(revisionIntent.kind === "edit" && documentAttachment ? { document: documentAttachment } : {}),
        })
      : null;
    if (revisionIntent && !revisionPlan) {
      setBootError("原来的那轮已经变化，请重新点一次编辑或重新生成。");
      return false;
    }

    // 工程模式带写权限、又开着「做完为止」时，它可能连着改十几个文件。
    // 这一步不是拦你，是让你有机会确认工作区选对了没有。
    if (toolsEnabled && missionMode && activeWorkspace?.writable && !confirmedMission.current) {
      const ok = window.confirm(
        `「做完为止」会连着改 ${activeWorkspace.path} 里的文件，最多 24 轮。\n`
        + "每一步都有记录、可以回滚，但确认一下工作区是不是选对了。\n\n继续吗？",
      );
      if (!ok) return false;
      // 这段对话里确认过一次就不再问了，否则每句话都弹一次没法用。
      confirmedMission.current = true;
    }

    sendLock.current = true;
    revisionSourceLock.current = revisionPlan?.sourceConversationId || null;
    setPreparingConversationId(activeConversation.id);

    // 没手动选过模型时，按这一轮的实际情况替他挑一个，并把理由记下来。
    let provider = activeConversation.provider;
    let model = activeConversation.model;
    let routingReason = activeConversation.provider ? "沿用这段对话已明确选择的模型。" : "等待自动路由。";
    if (localOnly) {
      // 保留对话原来的云端偏好，退出断网模式后还能恢复；这一轮则硬切到本机。
      provider = "local";
      model = undefined;
      routingReason = "仅本机模式是硬边界，本轮固定使用本机模型。";
      setRoutedReason(null);
    } else if (!provider) {
      const routingMessages = revisionPlan
        ? [...revisionPlan.prefixMessages, revisionPlan.userMessage]
        : activeConversation.messages;
      const routed = await window.kaiLocal.routeModel({
        question: content,
        hasImage: Boolean(revisionPlan?.userMessage.attachment || attachment),
        attachedCharacters: (revisionPlan?.userMessage.document?.characters || documentAttachment?.characters || 0)
          + (revisionPlan?.userMessage.attachment || attachment ? 200 : 0),
        conversationCharacters: routingMessages.reduce((sum, item) => sum + item.content.length, 0),
        useTools: toolsEnabled || Boolean(resumeRunId),
        manual: null,
      }).catch(() => null);
      if (routed) {
        provider = routed.provider;
        model = routed.model;
        routingReason = routed.reason || "按本轮输入自动选择模型。";
        setRoutedReason(routed.provider === "local" ? null : routed.reason);
      }
    } else {
      setRoutedReason(null);
    }

    const targetProvider = provider || activeConversation.provider || "local";
    const projectContextForSend = (projectInstructionsFor(projects, activeConversation.projectId));
    const privacyContextMessages = projectContextForSend
      ? [{ role: "project-context", content: projectContextForSend }]
      : [];
    const privacyChatMessages = (revisionPlan
        ? revisionOutboundMessages(revisionPlan).map(({ role, content: messageContent }) => ({ role, content: messageContent }))
        : [...activeConversation.messages.map(({ role, content: messageContent }) => ({ role, content: messageContent })), { role: "user" as const, content }]);
    const privacyMessages = [...privacyContextMessages, ...privacyChatMessages];
    const privacyMessageOffset = privacyContextMessages.length;
    const outboundPrivacy = previewPrivacyMessages(privacyMessages);
    const attachmentLabels = [
      ...(attachment ? [`图片：${attachment.name}`] : []),
      ...documentAttachments.map((item) => `文档：${item.name}（${item.characters || 0} 字）`),
    ];
    const shouldTrackTask = Boolean(pendingTaskKind)
      || (targetProvider !== "local" && (outboundPrivacy.findings.length > 0 || Boolean(attachment || documentAttachments.length)));
    if (shouldTrackTask && taskStorageBlocked.current) {
      setStorageWarning("任务结果库正在保护原数据，这次需要留存记录的任务暂未发送，避免做完后重启丢失。不需要任务记录的普通聊天仍可使用。");
      setTaskWorkbenchOpen(true);
      sendLock.current = false;
      revisionSourceLock.current = null;
      setPreparingConversationId(null);
      return false;
    }
    const sealedCloudTask = targetProvider !== "local" && shouldTrackTask;
    if (sealedCloudTask) {
      attachmentLabels.push("本轮暂停记忆、知识库、联网、工程工具和项目常驻资料；项目文字说明仍在上方预览中");
    } else {
      if (memoryEnabled) attachmentLabels.push("可能加入已启用的相关记忆");
      if (knowledgeEnabled) attachmentLabels.push("可能加入已启用知识库的相关片段");
      if (activeConversation.projectId) attachmentLabels.push("会加入当前项目的说明和常驻资料");
      if (webForThisSend ?? webEnabled) attachmentLabels.push("模型判断需要时可能加入联网检索结果");
    }
    let privacyReviewedAt: number | null = null;
    if (targetProvider !== "local" && (shouldTrackTask || outboundPrivacy.findings.length > 0)) {
      const destination = catalog.flatMap((section) => section.items)
        .find((item) => item.provider === targetProvider && (!model || item.model === model))?.label
        || model || targetProvider;
      const approved = await requestPrivacyApproval({
        destination,
        preview: outboundPrivacy,
        messageCount: privacyMessages.length,
        attachmentLabels,
      });
      if (!approved) {
        sendLock.current = false;
        revisionSourceLock.current = null;
        setPreparingConversationId(null);
        return false;
      }
      privacyReviewedAt = Date.now();
    }


    let ready = (provider || "local") !== "local" || modelState.status === "ready";
    if (!ready) ready = await startModel();
    if (!ready) {
      sendLock.current = false;
      revisionSourceLock.current = null;
      setPreparingConversationId(null);
      return false;
    }
    // 路由或模型启动期间切去别的对话，就不要把那边的输入框清空、也不要暗中发送。
    const sourceConversationId = revisionPlan?.sourceConversationId || activeConversation.id;
    if (activeIdRef.current !== sourceConversationId) {
      sendLock.current = false;
      revisionSourceLock.current = null;
      setPreparingConversationId(null);
      return false;
    }

    const userMessage: ChatMessage = revisionPlan?.userMessage || {
      id: randomId("msg"),
      role: "user",
      content,
      createdAt: now,
      attachment: attachment || undefined,
      document: documentAttachment || undefined,
      documents: documentAttachments.length > 1 ? [...documentAttachments] : undefined,
    };
    // 这条回答是谁答的，当场记下来。原来只有「比一比」选中的才带，
    // 翻旧对话时分不清哪条是本机哪条是云端。
    const answeringLabel = (() => {
      const effective = provider || "local";
      if (effective === "local") return "本机 Qwen3-8B";
      for (const section of catalog) {
        const hit = section.items.find((item) => item.provider === effective && (!model || item.model === model));
        if (hit) return hit.label;
      }
      return model || effective;
    })();
    const assistantMessage: ChatMessage = revisionPlan?.assistantMessage || {
      id: randomId("msg"),
      role: "assistant",
      content: "",
      createdAt: now + 1,
      pending: true,
      modelLabel: answeringLabel,
    };
    const incomingRequestId = randomId("request");
    followLatest.current = true;
    const rawOutboundMessages = (revisionPlan
        ? revisionOutboundMessages(revisionPlan)
        : [...activeConversation.messages, userMessage].map(({ role, content: messageContent, attachment: messageAttachment, document: messageDocument, documents: messageDocuments }) => ({
          role,
          content: messageContent,
          ...(messageAttachment ? { attachmentId: messageAttachment.id } : {}),
          // 多份走 documentIds，单份沿用 documentId——协议两边都认。
          ...(messageDocuments?.length
            ? { documentIds: messageDocuments.map((item) => item.id) }
            : messageDocument ? { documentId: messageDocument.id } : {}),
        })));
    // 云端真正拿到的消息与发送预览使用同一组脱敏结果；凭据不允许靠“已确认”绕过脱敏。
    const outboundMessages = targetProvider === "local"
      ? rawOutboundMessages
      : rawOutboundMessages.map((message, index) => ({
          ...message,
          content: outboundPrivacy.redactedMessages[index + privacyMessageOffset] ?? message.content,
        }));

    // 开始计时。慢的时候用户会怀疑是不是卡了，事后给个数字比什么都不说好。
    requestStartedAt.current = Date.now();
    streamTarget.current = {
      conversationId: activeConversation.id,
      messageId: assistantMessage.id,
      requestId: incomingRequestId,
      ...(revisionIntent ? { revision: revisionIntent } : {}),
      ...(({})),
    };
    streamAnswerBuffers.current.set(incomingRequestId, "");
    if (shouldTrackTask) {
      try {
        const inputs = [capsuleInput("prompt", "本轮问题", content)];
        documentAttachments.forEach((item, index) => {
          inputs.push(capsuleInput(
            `document-${index + 1}`,
            `附件记录：${item.name}`,
            JSON.stringify({ id: item.id, name: item.name, kind: item.kind, characters: item.characters, pageCount: item.pageCount }),
          ));
        });
        if (attachment) {
          inputs.push(capsuleInput(
            "image-1",
            `图片记录：${attachment.name}`,
            JSON.stringify({ id: attachment.id, name: attachment.name, width: attachment.width, height: attachment.height }),
          ));
        }
        const capsule = createTaskCapsule({
          id: randomId("task"),
          createdAt: now,
          updatedAt: now,
          target: content.slice(0, 8000),
          inputs,
          route: {
            provider: targetProvider,
            model: model || (targetProvider === "local" ? "configured-local" : "provider-default"),
            local: targetProvider === "local",
          },
          routingReason,
          privacy: privacyInventory(outboundPrivacy, now, {
            reviewedAt: privacyReviewedAt,
            approvedForSend: targetProvider === "local" ? false : privacyReviewedAt !== null,
            sendMode: targetProvider === "local" ? "original" : "redacted",
          }),
        });
        taskRequestMap.current.set(incomingRequestId, {
          capsuleId: capsule.id,
          conversationId: revisionPlan?.branchId || activeConversation.id,
          messageId: assistantMessage.id,
        });
        setTaskCapsules((current) => upsertTaskCapsule(current, capsule));
        setPendingTaskKind(null);
      } catch (error) {
        setStorageWarning(error instanceof Error ? `任务记录没有建立：${error.message}` : "任务记录没有建立。");
      }
    }
    setRequestId(incomingRequestId);
    // 从这一刻起由 requestId 控制“停止”键；同步锁继续持有到 done/error。
    setPreparingConversationId(null);
    setDraft("");
    setAttachment(null);
    setDocumentAttachments([]);
    if (revisionPlan) {
      revisionStage.current = { plan: revisionPlan, assistant: assistantMessage };
      setRevisionPreview({
        conversationId: activeConversation.id,
        kind: revisionPlan.kind,
        assistant: assistantMessage,
      });
    } else {
      // 编辑态里点了别的快捷追问，就按普通新问题发送，并结束编辑态。
      if (editSession?.conversationId === activeConversation.id) setEditSession(null);
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        title: conversation.messages.length ? conversation.title : deriveTitle(content),
        messages: [...conversation.messages, userMessage, assistantMessage],
        updatedAt: now,
      }));
    }

    const markSendFailure = (error: unknown) => {
      if (streamTarget.current?.requestId !== incomingRequestId) return;
      const message = error instanceof Error ? error.message : "这次回答没有完成。";
      settleTrackedTask(incomingRequestId, {
        answer: streamAnswerBuffers.current.get(incomingRequestId) || undefined,
        status: "retryable",
        summary: `任务没有开始或中途失败：${message}`,
      });
      streamAnswerBuffers.current.delete(incomingRequestId);
      if (revisionPlan) {
        revisionStage.current = null;
        revisionSourceLock.current = null;
        setRevisionPreview(null);
        if (revisionPlan.kind === "edit") {
          draftsByConversation.current.set(revisionPlan.sourceConversationId, revisionPlan.userMessage.content);
          if (activeIdRef.current === revisionPlan.sourceConversationId) setDraft(revisionPlan.userMessage.content);
        }
        setBootError(`${message} 原对话没有改。`);
        streamTarget.current = null;
        sendLock.current = false;
        setPreparingConversationId(null);
        setRequestId(null);
        return;
      }
      setConversations((current) => current.map((conversation) => (
        conversation.id !== activeConversation.id
          ? conversation
          : {
              ...conversation,
              messages: conversation.messages.map((item) => (
                item.id === assistantMessage.id
                  ? { ...item, content: message, pending: false, error: true }
                  : item
              )),
            }
      )));
      streamTarget.current = null;
      revisionSourceLock.current = null;
      sendLock.current = false;
      setPreparingConversationId(null);
      setRequestId(null);
    };

    try {
      const projectContext = targetProvider === "local"
        ? projectContextForSend
        : projectContextForSend
          ? (outboundPrivacy.redactedMessages[0] || "")
          : "";
      const delivery = window.kaiLocal.sendMessage({
        requestId: incomingRequestId,
        messages: outboundMessages,
        skillId: (activeConversation.skillId),
        options: ({
              useWeb: sealedCloudTask ? false : localOnly ? false : (webForThisSend ?? webEnabled),
              useTools: sealedCloudTask ? false : toolsEnabled || Boolean(resumeRunId),
              useKnowledge: sealedCloudTask ? false : knowledgeEnabled,
              useMemory: sealedCloudTask ? false : memoryEnabled,
              mission: sealedCloudTask ? false : toolsEnabled && missionMode,
              ...(activeConversation.maxTokensOverride ? { maxTokens: activeConversation.maxTokensOverride } : {}),
            }),
        // 项目背景每次都带上：这正是"不用重复交代"的意思。
        ...(projectContext ? { projectContext } : {}),
        provider: provider || "local",
        ...(model ? { model } : {}),
        ...(resumeRunId ? { resumeRunId } : {}),
        ...(sealedCloudTask ? {} : projectDocumentIdsFor(projects, activeConversation.projectId).length
          ? { projectDocumentIds: projectDocumentIdsFor(projects, activeConversation.projectId) }
          : {}),
        ...(({})),
      });
      // IPC 会在整轮生成结束后才 resolve。这里不等它：界面立刻进入运行态，
      // 恢复面板也能退场露出“停止”键；真正的完成/错误仍由流式事件收尾。
      void delivery
        .then((outcome) => {
          if (!outcome.ok) markSendFailure(new Error(outcome.message || "这次回答没有开始。"));
        })
        .catch(markSendFailure);
      return true;
    } catch (error) {
      markSendFailure(error);
      return false;
    }
  }, [activeConversation, attachment, bootPhase, browsingWithoutModel, catalog, documentAttachment, documentAttachments, draft, editSession, initialState, knowledgeEnabled, localOnly, memoryEnabled, missionMode, modelState.status, pendingTaskKind, projects, requestId, requestPrivacyApproval, settleTrackedTask, startModel, toolsEnabled, updateConversation, webEnabled]);

  const regenerate = useCallback((assistantId: string) => {
    if (!activeConversation || requestId) return;
    const index = activeConversation.messages.findIndex((message) => message.id === assistantId);
    if (index < 1) return;
    const question = activeConversation.messages[index - 1];
    if (question.role !== "user") return;
    void send(question.content, undefined, { kind: "regenerate", targetMessageId: assistantId });
  }, [activeConversation, requestId, send]);

  const resumeRunById = useCallback(async (
    runId: string,
    wording = "继续上次没有完成的任务。",
  ): Promise<{ ok: boolean; message?: string }> => {
    if (requestId || sendLock.current) return { ok: false, message: "先等当前任务结束。" };
    try {
      const latest = await window.kaiLocal.getAgentRun(runId);
      if (!latest) {
        const error = "找不到这次任务保存的进度，原对话仍然保留。";
        setBootError(error);
        return { ok: false, message: error };
      }
      setAgentRuns((current) => [latest, ...current.filter((item) => item.id !== latest.id)].slice(0, 80));
      if (!latest.resumable) {
        const stale = latest.checkpoint?.changedPaths.some((item) => item.stale);
        const error = stale ? "相关文件已经变化，kaii 没有贸然覆盖。请重新交代要继续的部分。" : "这次任务没有可恢复的进度。";
        setBootError(error);
        return { ok: false, message: error };
      }
      const savedWorkspaceId = latest.checkpoint?.workspace.id;
      if (savedWorkspaceId) {
        const savedWorkspace = workspaces.roots.find((root) => root.id === savedWorkspaceId);
        if (!savedWorkspace?.exists) {
          const error = "这次任务原来的工作区已不在授权列表里。";
          setBootError(error);
          setWorkspaceOpen(true);
          return { ok: false, message: error };
        }
        if (workspaces.activeId !== savedWorkspaceId) {
          const next = await window.kaiLocal.setActiveWorkspace(savedWorkspaceId);
          setWorkspaces(next);
        }
        setToolsEnabled(true);
      }
      const started = await send(wording, runId);
      if (!started) {
        const error = "这次任务没有开始。";
        setBootError(error);
        return { ok: false, message: error };
      }
      return { ok: true };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : "这次任务没有恢复成功";
      setBootError(error);
      return { ok: false, message: error };
    }
  }, [requestId, send, workspaces]);

  const resumeTask = useCallback(async (message: ChatMessage) => {
    const wording = message.continueReason === "truncated"
      ? "从中断处继续，不要重复已经完成的部分。"
      : "继续上次没有完成的任务。";
    // 旧版普通回答没有 runId，只能沿用自然语言续写；工程任务有 runId 时必须走真正的 checkpoint。
    if (!message.runId) {
      await send(wording);
      return;
    }
    await resumeRunById(message.runId, wording);
  }, [resumeRunById, send]);

  // 输入框里最后一个还没结束的 @token，用来决定要不要弹文件补全。
  const activeMention = useMemo(() => {
    if (!toolsEnabled || !activeWorkspace) return null;
    const match = draft.match(/(^|[\s（(【「])@([A-Za-z0-9_./-]*)$/);
    return match ? match[2] : null;
  }, [activeWorkspace, draft, toolsEnabled]);

  useEffect(() => {
    if (activeMention === null) {
      setFileHints([]);
      return;
    }
    let mounted = true;
    const timer = setTimeout(() => {
      window.kaiLocal.listWorkspaceFiles(activeMention).then((files) => {
        if (!mounted) return;
        setFileHints(files.slice(0, 8));
        setFileHintIndex(0);
      }).catch(() => {
        if (mounted) setFileHints([]);
      });
    }, 90);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [activeMention]);

  // @ 也能点名存下来的网页。工作区补全不活跃时才出（两个下拉叠一起没法用），
  // 匹配允许中文——网页标题基本都是中文。
  const pageMention = useMemo(() => {
    if (activeMention !== null) return null;
    if (!savedPages.length) return null;
    const match = draft.match(/(^|[\s（(【「])@([^\s@]*)$/);
    return match ? match[2] : null;
  }, [activeMention, draft, savedPages.length]);

  const pageHints = useMemo(() => {
    if (pageMention === null) return [];
    const query = pageMention.toLocaleLowerCase("zh-CN");
    return savedPages
      .filter((page) => !query || page.title.toLocaleLowerCase("zh-CN").includes(query))
      .slice(0, 6);
  }, [pageMention, savedPages]);

  const applyPageHint = useCallback(async (page: SavedPage) => {
    // 把 @xx 从草稿里擦掉，换成真正挂上这篇。
    setDraft((current) => current.replace(/@([^\s@]*)$/, ""));
    setDocumentBusy(true);
    try {
      const outcome = await window.kaiLocal.attachSavedPage(page.id);
      if (outcome.ok && outcome.attachment) addDocumentAttachment(outcome.attachment);
      else setBootError(outcome.message || "这一篇读不出来");
    } finally {
      setDocumentBusy(false);
      requestAnimationFrame(() => composer.current?.focus());
    }
  }, [addDocumentAttachment]);

  const applyFileHint = useCallback((filePath: string) => {
    setDraft((current) => current.replace(/@([A-Za-z0-9_./-]*)$/, `@${filePath} `));
    setFileHints([]);
    requestAnimationFrame(() => composer.current?.focus());
  }, []);

  const stopGeneration = useCallback(async () => {
    if (requestId) await window.kaiLocal.cancelMessage(requestId);
  }, [requestId]);

  const changeSkill = useCallback((skillId: string) => {
    if (!activeConversation || requestId) return;
    updateConversation(activeConversation.id, (conversation) => ({ ...conversation, skillId }));
    setSkillMenuOpen(false);
  }, [activeConversation, requestId, updateConversation]);

  const cycleTheme = useCallback(async () => {
    if (!settings) return;
    const nextTheme = settings.theme === "system" ? "dark" : settings.theme === "dark" ? "light" : "system";
    const result = await window.kaiLocal.updateSettings({ theme: nextTheme });
    setSettings(result.settings);
    document.documentElement.dataset.theme = result.settings.theme;
  }, [settings]);

  const toggleLocalOnly = useCallback(async () => {
    // 不在回答中途改变这条请求的网络边界。否则顶栏会先显示“云端已暂停”，
    // 但已经发出的云端流仍会继续回来，界面状态和真实状态会互相打架。
    if (!settings || localOnlyBusy || requestId) return;
    const next = !settings.localOnly;
    setLocalOnlyBusy(true);
    setBootError(null);
    try {
      const saved = await window.kaiLocal.updateSettings({ localOnly: next });
      if (!saved?.settings) throw new Error("设置没有保存成功");
      setSettings(saved.settings);
      sendWebOnce.current = null;
      if (sendHoldTimer.current) window.clearTimeout(sendHoldTimer.current);
      sendHoldTimer.current = null;
      sendHoldArmed.current = false;
      setSendHolding(false);
      setRoutedReason(null);
      setModelMenuOpen(false);
      setStorageWarning(next
        ? "已进入仅本机模式：主聊天的云端模型、自动云端路由和联网搜索都已暂停；这个开关本身不会启动模型。"
        : "仅本机模式已关闭。原来为这段对话选择的模型仍然保留。"
      );
    } catch (error) {
      setBootError(error instanceof Error ? error.message : "仅本机模式没有切换成功");
    } finally {
      setLocalOnlyBusy(false);
    }
  }, [localOnlyBusy, requestId, settings]);

  useEffect(() => {
    if (!conversationMenu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConversationMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [conversationMenu]);

  const taskWorkbenchResults = useMemo<TaskWorkbenchResult[]>(() => taskCapsules.map((capsule) => {
    const latestReceipt = capsule.receipts.at(-1);
    const artifact = [...capsule.artifacts].reverse().find((item) => item.uri?.startsWith("kaii://conversation/"));
    const match = artifact?.uri?.match(/^kaii:\/\/conversation\/([^/]+)\/message\/([^/]+)$/);
    const conversation = match ? conversations.find((item) => item.id === match[1]) : null;
    const answer = match ? conversation?.messages.find((item) => item.id === match[2])?.content : "";
    return {
      id: capsule.id,
      title: deriveTitle(capsule.target),
      conclusion: latestReceipt?.summary || "任务已经建立，正在等待结果。",
      body: answer || latestReceipt?.summary || "",
      sourceSummary: `${capsule.inputs.length} 份输入 · ${capsule.receipts.length} 条回执`,
      sources: [
        ...capsule.inputs.map((input) => ({
          id: input.id,
          label: input.label,
          detail: `${input.bytes} bytes · sha256 ${input.sha256.slice(0, 12)}…`,
          kind: input.label.startsWith("附件记录：") || input.label.startsWith("图片记录：") ? "file" as const : "text" as const,
        })),
        ...capsule.memoryProposals.map((proposal) => ({
          id: proposal.id,
          label: proposal.content,
          detail: `来源回执 ${proposal.source.receiptId}`,
          kind: "memory" as const,
        })),
      ],
      runAt: new Date(capsule.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      location: capsule.route.local ? "local" : "cloud",
      verification: capsule.status === "verified"
        ? "verified"
        : capsule.status === "needs_user" || capsule.status === "stale" ? "needs-review" : "unverified",
    };
  }), [conversations, taskCapsules]);

  const taskWorkbenchTasks = useMemo<TaskWorkbenchTask[]>(() => taskCapsules
    .filter((capsule) => !capsule.receipts.length || ["needs_user", "retryable"].includes(capsule.status))
    .slice(0, 8)
    .map((capsule) => ({
      id: capsule.id,
      label: deriveTitle(capsule.target),
      status: capsule.status === "needs_user"
        ? "waiting"
        : capsule.status === "retryable" || capsule.status === "terminal_failure" ? "failed" : "running",
      progressLabel: capsule.receipts.at(-1)?.summary || "已经接收，等待模型返回",
    })), [taskCapsules]);

  const startWorkbenchEntry = useCallback((entry: TaskWorkbenchEntry) => {
    setTaskEntry(entry);
    setTaskWorkbenchOpen(false);
    if (entry === "automation") {
      setPendingTaskKind(null);
      setBatchOpen(true);
      return;
    }
    setPendingTaskKind(entry);
    if (entry === "materials") void chooseDocument();
    requestAnimationFrame(() => composer.current?.focus());
  }, [chooseDocument]);

  const handleTaskWorkbenchAction = useCallback(async (action: TaskWorkbenchAction, result: TaskWorkbenchResult) => {
    const capsule = taskCapsules.find((item) => item.id === result.id);
    if (!capsule) return;
    const artifact = [...capsule.artifacts].reverse().find((item) => item.uri?.startsWith("kaii://conversation/"));
    const match = artifact?.uri?.match(/^kaii:\/\/conversation\/([^/]+)\/message\/([^/]+)$/);
    const conversationId = match?.[1] || null;

    if (action === "continue" || action === "retry") {
      if (conversationId && conversations.some((item) => item.id === conversationId)) setActiveId(conversationId);
      setPendingTaskKind("ask");
      setDraft(action === "retry" ? capsule.target : "继续这项任务。先沿用已有结果，只处理还没解决的部分。");
      setTaskWorkbenchOpen(false);
      requestAnimationFrame(() => composer.current?.focus());
      return;
    }
    if (action === "project") {
      if (conversationId && conversations.some((item) => item.id === conversationId)) setActiveId(conversationId);
      setTaskWorkbenchOpen(false);
      setProjectPanelOpen(true);
      return;
    }
    if (action === "knowledge") {
      const resultBody = result.body?.trim() || "";
      if (!resultBody) {
        setStorageWarning("这份结果还没有正文，暂时不能放进资料区。");
        return;
      }
      try {
        const outcome = await window.kaiLocal.documentFromText({ text: resultBody, name: result.title });
        if (!outcome.ok || !outcome.attachment) throw new Error(outcome.message || "结果没有转成文档");
        addDocumentAttachment(outcome.attachment);
        setTaskWorkbenchOpen(false);
        setDraft("请基于这份已核对来源的结果继续分析：");
        setStorageWarning("结果已作为本机文档挂到输入区；它还没有自动进入长期知识库。 ");
        requestAnimationFrame(() => composer.current?.focus());
      } catch (error) {
        setBootError(error instanceof Error ? error.message : "结果没有放进资料区");
      }
      return;
    }
    if (action === "copy") {
      await navigator.clipboard.writeText(result.body || result.conclusion);
      setStorageWarning("这份结果已经复制。");
      return;
    }
    if (action === "export") {
      const markdown = [
        `# ${result.title}`,
        "",
        result.conclusion,
        "",
        result.body,
        "",
        "## 任务证据胶囊",
        "",
        "```json",
        JSON.stringify(JSON.parse(serializeTaskCapsule(capsule)), null, 2),
        "```",
      ].join("\n");
      saveBlob(markdown, "text/markdown;charset=utf-8", safeFileName(`${result.title}-证据`, "md"));
    }
  }, [addDocumentAttachment, conversations, saveBlob, taskCapsules]);

  // 日常高频操作给键盘入口。刻意避开输入框里的按键：
  // 在输入框里敲 ⌘F 应该是浏览器行为，不该被抢走去开侧栏搜索。
  // 公式双击复制它的 LaTeX 原文。
  // KaTeX 把原始式子放在 <annotation encoding="application/x-tex"> 里，
  // 直接读那个，比从渲染出来的 span 反推可靠得多。
  useEffect(() => {
    const onDoubleClick = (event: MouseEvent) => {
      // 行内代码也双击复制，和公式同一个手势。代码块有自己的复制键，不抢。
      const inlineCode = (event.target as HTMLElement | null)?.closest?.("code");
      if (inlineCode && !inlineCode.closest("pre")) {
        const text = inlineCode.textContent?.trim();
        if (text) {
          event.preventDefault();
          void navigator.clipboard.writeText(text)
            .then(() => setStorageWarning(`已复制：${text.slice(0, 40)}`));
        }
        return;
      }
      const formula = (event.target as HTMLElement | null)?.closest?.(".katex");
      if (!formula) return;
      const tex = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      if (!tex) return;
      event.preventDefault();
      void navigator.clipboard.writeText(tex).then(() => setStorageWarning(`公式已复制：${tex.slice(0, 40)}`));
    };
    window.addEventListener("dblclick", onDoubleClick);
    return () => window.removeEventListener("dblclick", onDoubleClick);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 弹窗、菜单和输入候选已经在处理自己的键盘事件时，全局快捷键让路。
      // 否则按一次快捷键可能在现有面板上再叠一层，Esc 也会一键触发两件事。
      const overlay = document.querySelector<HTMLElement>("[role='dialog'], [role='menu'], [role='listbox']");
      if (overlay) {
        // ⌘K 再按一次仍允许关掉命令面板，其他弹层一律不被全局快捷键打扰。
        if (overlay.classList.contains("command-palette")
          && event.metaKey && !event.ctrlKey && !event.altKey
          && !event.shiftKey && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setPaletteOpen(false);
        }
        return;
      }
      // ? 打开快捷键速查。在输入框里打问号就是打问号，不能抢。
      if (event.key === "?" && !event.metaKey && !event.ctrlKey) {
        const target = event.target as HTMLElement | null;
        const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
        if (!typing) {
          event.preventDefault();
          setShortcutsOpen((value) => !value);
          return;
        }
      }
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        createChat();
      } else if (key === "f" && event.shiftKey) {
        // ⇧⌘F 才是搜全部历史。⌘F 先在当前这段对话里找——
        // 「刚才那句话在哪」比「哪段对话提过」常见得多。
        event.preventDefault();
        setSidebarOpen(true);
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".chat-search input")?.focus();
        });
      } else if (key === "f") {
        event.preventDefault();
        setInChatFind((value) => (value === null ? "" : null));
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".in-chat-find input")?.focus();
        });
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === "k" && event.shiftKey) {
        event.preventDefault();
        void window.kaiLocal.openQuickWindow();
      } else if (key === "k") {
        event.preventDefault();
        // 已经开着就关掉：⌘K 敲两下应该回到原地，而不是叠一层。
        setPaletteOpen((value) => !value);
        if (!catalog.length) void window.kaiLocal.fetchModelCatalog().then(setCatalog).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [catalog.length, createChat]);

  // Esc 停止正在生成的回答，这是最常用的一个"救急键"。
  useEffect(() => {
    if (!requestId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 第一记 Esc 归当前弹窗/菜单/候选框：只在没有任何覆盖层时才停止回答。
      if (document.querySelector("[role='dialog'], [role='menu'], [role='listbox']")) return;
      event.preventDefault();
      void window.kaiLocal.cancelMessage(requestId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestId]);

  if (bootPhase === "loading") {
    return <div className="boot-screen"><LoaderCircle className="spin" /> 正在打开 kaii-agent</div>;
  }

  if (bootPhase === "error" || !initialState) {
    return (
      <div className="boot-screen boot-failed">
        <div className="boot-paper" role="alert">
          <div className="boot-mark"><img src="./logos/kaii-k-a.svg" alt="" /></div>
          <span className="boot-kicker">没有准备好</span>
          <h1>kaii-agent 还没打开</h1>
          <p>{bootFailure || "应用没有完成初始化。"}</p>
          <div className="boot-actions">
            <button className="primary" type="button" onClick={() => void initializeApp()}>
              <RefreshCw size={15} /> 重试初始化
            </button>
            <button type="button" disabled={bootSettingsBusy} onClick={() => void openBootSettings()}>
              {bootSettingsBusy ? <LoaderCircle className="spin" size={15} /> : <Settings size={15} />}
              打开设置
            </button>
          </div>
        </div>
        {bootSettingsOpen && settings ? (
          <SettingsPanel
            settings={settings}
            skills={skills}
            modelState={modelState}
            searchProviders={searchProviders}
            quickHotkeys={[]}
            quickHotkeyState={quickHotkeyState}
            trayState={trayState}
            providerList={providerList}
            setProviderList={setProviderList}
            onBackup={() => buildBackup(conversations, projects, prompts)}
            onRestoreBackup={restoreFromBackup}
            onImportConversations={importConversations}
            onSkillsChange={setSkills}
            onExportAll={exportAllConversations}
            onSweep={async () => {
              const imageIds = referencedAttachmentIds(conversations);
              const conversationDocumentIds = referencedDocumentIds(conversations);
              const projectDocumentIds = projects.flatMap((project) => project.documents.map((document) => document.id));
              const documentIds = [...new Set([...conversationDocumentIds, ...projectDocumentIds])];
              await window.kaiLocal.sweepStorage({ imageIds, documentIds });
            }}
            onRestore={(text) => { void restoreFromBackup(text); }}
            onExport={() => exportConversations(conversations)}
            onClose={() => setBootSettingsOpen(false)}
            onSave={async (patch) => {
              const result = await window.kaiLocal.updateSettings(patch);
              setSettings(result.settings);
              setSkills(result.skills);
              await initializeApp();
            }}
          />
        ) : null}
      </div>
    );
  }

  if (locked !== false) {
    // null（还没问完主进程）也先遮着：锁的意义就是内容一秒都不该闪出来。
    return locked === null ? <div className="lock-screen" /> : <LockScreen onUnlock={() => setLocked(false)} />;
  }

  if (welcomeOpen) {
    return <WelcomePanel
      onSkip={() => finishWelcome("browse")}
      onLocalSettings={() => {
        finishWelcome("configured");
        setSettingsOpen(true);
      }}
      onSave={async (provider, key) => {
        const result = await window.kaiLocal.setProviderKey(provider, key);
        if (!result.ok || !result.configured) throw new Error("凭据保存失败");
        setProviderList(result.providers);
        if (settings?.localOnly) {
          const saved = await window.kaiLocal.updateSettings({ localOnly: false });
          setSettings(saved.settings);
        }
        const selected = result.providers.find((item) => item.id === provider);
        if (activeConversation && activeConversation.messages.length === 0) {
          updateConversation(activeConversation.id, (conversation) => ({
            ...conversation, provider, model: selected?.models[0]?.id,
          }));
        } else {
          const conversation = { ...newConversation(), provider, model: selected?.models[0]?.id };
          setConversations((current) => [conversation, ...current]);
          setActiveId(conversation.id);
        }
        setCatalog([]);
        finishWelcome("configured");
        setStorageWarning("API key 已保存。发出第一条消息后，可以查看模型的连接结果。");
      }}
    />;
  }

  return (
    <div
      className={`app-shell ${sidebarOpen ? "sidebar-visible" : "sidebar-hidden"} ${dragging ? "dragging" : ""}`}
      style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        // 子元素之间移动会连续触发 enter/leave，用计数抵消，否则高亮会闪。
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        // 一次拖几个就收几个（文档最多三份，图片取最后一张）。
        // 逐个 await：解析是串行的，一起发只会让报错混在一起分不清是哪个文件的。
        const paths = [...event.dataTransfer.files]
          .map((file) => window.kaiLocal.pathForFile(file))
          .filter(Boolean)
          .slice(0, 5);
        if (!paths.length) {
          setBootError("拿不到这些文件的路径，试试用“读文档”或“识图”按钮选择。");
          return;
        }
        void (async () => {
          for (const filePath of paths) {
            // eslint-disable-next-line no-await-in-loop
            await acceptDroppedFile(filePath);
          }
        })();
      }}
    >
      {dragging && (
        <div className="drop-veil" aria-hidden="true">
          <div>
            <strong>松手添加</strong>
          </div>
        </div>
      )}
      <aside className="sidebar" aria-hidden={!sidebarOpen}>
        <div className="sidebar-drag" />
        <div
          className="sidebar-resize"
          title="拖着改宽度，双击回默认"
          onDoubleClick={() => {
            setSidebarWidth(274);
            localStorage.setItem("kaii.sidebarWidth.v1", "274");
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startW = sidebarWidth;
            // 拖的时候关掉栅格过渡动画，不然跟手感很黏。
            document.body.classList.add("sidebar-resizing");
            const clamp = (value: number) => Math.min(400, Math.max(220, value));
            const move = (e: PointerEvent) => setSidebarWidth(clamp(startW + (e.clientX - startX)));
            const up = (e: PointerEvent) => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
              document.body.classList.remove("sidebar-resizing");
              localStorage.setItem("kaii.sidebarWidth.v1", String(clamp(startW + (e.clientX - startX))));
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
        <div className="brand-row">
          <div className="brand-mark"><img src="./logos/kaii-k-a.svg" alt="" /></div>
          <div><strong>kaii-agent</strong></div>
        </div>

        <button className="new-chat" type="button" onClick={createChat}>
          <Plus size={17} /> 新对话
        </button>

        <div className="chat-search">
          <Search size={13} />
          <input
            value={searchQuery}
            placeholder="搜索历史对话"
            aria-label="搜索历史对话"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery && (
            <button type="button" aria-label="清空搜索" onClick={() => setSearchQuery("")}><X size={13} /></button>
          )}
        </div>

        <div className="conversation-list" aria-label="对话记录" onScroll={() => setConversationMenu(null)}>
          {searchHits ? (
            <>
              <div className="section-label">{searchHits.length ? `找到 ${searchHits.length} 段` : "没有找到"}</div>
              {(searchHitGroups || []).map((hitGroup) => (
                <div key={hitGroup.label}>
                  {(searchHitGroups?.length ?? 0) > 1 && (
                    <div className="section-label group-label"><FolderOpen size={11} /> {hitGroup.label}</div>
                  )}
                  {hitGroup.hits.map((hit) => (
                <button
                  className={`search-hit ${hit.conversationId === activeId ? "active" : ""}`}
                  type="button"
                  key={hit.conversationId}
                  onClick={() => {
                    followLatest.current = false;
                    setActiveId(hit.conversationId);
                    setSearchQuery("");
                    // 跳到命中那条消息，而不是只切换对话。
                    if (hit.messageId) {
                      requestAnimationFrame(() => {
                        document.getElementById(`msg-${hit.messageId}`)?.scrollIntoView({ block: "center" });
                      });
                    }
                  }}
                >
                  <strong>{highlightMatches(hit.title, searchQuery)}{hit.matchCount > 1 ? ` · ${hit.matchCount} 处` : ""}</strong>
                  <small>{highlightMatches(hit.excerpt, searchQuery)}</small>
                </button>
                  ))}
                </div>
              ))}
              {(() => {
                const needle = searchQuery.trim().toLowerCase();
                const pageHits = savedPages.filter((page) => (
                  page.title.toLowerCase().includes(needle)
                  || (page.summary || "").toLowerCase().includes(needle)
                  || (page.tags || []).some((tag) => tag.toLowerCase().includes(needle))
                )).slice(0, 5);
                if (!pageHits.length) return null;
                return (
                  <>
                    <div className="section-label group-label"><Bookmark size={11} /> 网页存档</div>
                    {pageHits.map((page) => (
                      <button
                        className="search-hit"
                        type="button"
                        key={page.id}
                        onClick={() => {
                          setSearchQuery("");
                          setReadLaterOpen(true);
                        }}
                      >
                        <strong>{page.title}</strong>
                        <small>{page.summary || page.excerpt}</small>
                      </button>
                    ))}
                  </>
                );
              })()}
            </>
          ) : (
            <>
              {(tagList.length > 0 || archivedCount > 0) && (
                <div className="tag-filter">
                  {tagList.map((item) => (
                    <button
                      type="button"
                      key={item.tag}
                      className={tagFilter.includes(item.tag) ? "on" : ""}
                      title={`只看带「${item.tag}」的（选多个是"都要有"）`}
                      onClick={() => setTagFilter((current) => (
                        current.includes(item.tag)
                          ? current.filter((tag) => tag !== item.tag)
                          : [...current, item.tag]
                      ))}
                    >
                      {item.tag} <b>{item.count}</b>
                    </button>
                  ))}
                  {archivedCount > 0 && (
                    <button
                      type="button"
                      className={`tag-archived${showArchived ? " on" : ""}`}
                      onClick={() => setShowArchived((value) => !value)}
                    >
                      {showArchived ? "隐藏归档" : `归档 ${archivedCount}`}
                    </button>
                  )}
                </div>
              )}
              {conversationGroups.map((group) => (
                <div className="conversation-group" key={group.project?.id || "loose"}>
                  <div
                    className={`section-label group-label${group.project && projectDragOver === group.project.id ? " drop-target" : ""}`}
                    draggable={Boolean(group.project)}
                    onDragStart={(event) => {
                      if (!group.project) return;
                      setProjectDragId(group.project.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (conversationDragId && !group.pinned) {
                        event.preventDefault();
                        if (group.project) setProjectDragOver(group.project.id);
                        return;
                      }
                      if (!group.project || !projectDragId || projectDragId === group.project.id) return;
                      event.preventDefault();
                      setProjectDragOver(group.project.id);
                    }}
                    onDragLeave={() => setProjectDragOver(null)}
                    onDrop={() => {
                      if (conversationDragId && !group.pinned) {
                        // 拖到某个项目组=归入该项目；拖到「未分组」=移出项目
                        moveConversation(conversationDragId, group.project?.id);
                        setConversationDragId(null);
                        setProjectDragOver(null);
                        return;
                      }
                      if (group.project && projectDragId) reorderProjects(projectDragId, group.project.id);
                      setProjectDragId(null);
                      setProjectDragOver(null);
                    }}
                    onClick={(event) => {
                      // 点标题空白处收起/展开这一组。点里面的颜色点、导出键不算。
                      if ((event.target as HTMLElement).closest("button")) return;
                      toggleGroupCollapsed(group.project?.id || (group.pinned ? "pinned" : "loose"));
                    }}
                    onDragEnd={() => {
                      setProjectDragId(null);
                      setProjectDragOver(null);
                    }}
                  >
                    {collapsedGroups.has(group.project?.id || (group.pinned ? "pinned" : "loose")) && (
                      <span className="group-collapsed-count">{group.conversationIds.length}</span>
                    )}
                    {group.pinned
                      ? <><Pin size={11} /> 置顶</>
                      : group.project
                        ? <>
                            <button
                              type="button"
                              className={group.project.color ? "project-dot tinted" : "project-dot"}
                              title="点一下换个颜色记号"
                              aria-label={`给项目 ${group.project.name} 换颜色`}
                              style={group.project.color ? { background: group.project.color, borderColor: group.project.color } : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                cycleProjectColor(group.project!.id);
                              }}
                            />
                            {group.project.name}
                          </>
                        : "未分组"}
                    {group.project && group.conversationIds.length > 1 && (
                      <>
                      <button
                        className="group-export"
                        type="button"
                        title={`把「${group.project.name}」下的 ${group.conversationIds.length} 段对话导成一份 Markdown`}
                        aria-label={`把项目 ${group.project.name} 导成 Markdown`}
                        onClick={(event) => {
                          event.stopPropagation();
                          const inGroup = group.conversationIds
                            .map((id) => conversations.find((item) => item.id === id))
                            .filter(Boolean) as Conversation[];
                          const body = [
                            `# ${group.project!.name}`,
                            "",
                            ...inGroup.map((item) => conversationToMarkdown(item)),
                          ].join("\n\n---\n\n");
                          saveBlob(body, "text/markdown;charset=utf-8", safeFileName(group.project!.name, "md"));
                        }}
                      >
                        <FileText size={11} />
                      </button>
                      <button
                        className="group-export"
                        type="button"
                        title={`把「${group.project.name}」下的 ${group.conversationIds.length} 段对话导成一份 PDF`}
                        aria-label={`导出项目 ${group.project.name}`}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const inGroup = group.conversationIds
                            .map((id) => conversations.find((item) => item.id === id))
                            .filter(Boolean) as Conversation[];
                          const html = projectToHtml(group.project!.name, inGroup);
                          const outcome = await window.kaiLocal.exportPdf({
                            html,
                            fileName: safeFileName(group.project!.name, "pdf"),
                          });
                          if (!outcome.ok && !outcome.cancelled) {
                            setBootError(outcome.message || "这个项目没导出成功");
                          }
                        }}
                      >
                        <Download size={11} />
                      </button>
                      </>
                    )}
                    {group.project?.instructions.trim() ? <b title="这个项目有背景说明，提问时会自动带上">·背景</b> : null}
                  </div>
                  {collapsedGroups.has(group.project?.id || (group.pinned ? "pinned" : "loose"))
                    ? null
                    : group.conversationIds.length ? group.conversationIds.map((conversationId) => {
                    const conversation = conversations.find((item) => item.id === conversationId)!;
                    return (
                      <div className={`conversation-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                        {renamingId === conversation.id ? (
                          <input
                            className="rename-input"
                            defaultValue={conversation.title}
                            autoFocus
                            aria-label="改名字"
                            onBlur={(event) => {
                              const next = event.target.value.trim().slice(0, 60);
                              if (next) updateConversation(conversation.id, (item) => ({ ...item, title: next }));
                              setRenamingId(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                              if (event.key === "Escape") {
                                event.currentTarget.value = conversation.title;
                                event.currentTarget.blur();
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            title={`${conversation.messages.length} 条 · 最后活跃 ${new Date(conversation.updatedAt).toLocaleString("zh-CN")}。双击改名字，拖到项目名上可归入项目`}
                            draggable
                            onDragStart={(event) => {
                              setConversationDragId(conversation.id);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => setConversationDragId(null)}
                            onDoubleClick={() => setRenamingId(conversation.id)}
                            onClick={() => {
                              followLatest.current = true;
                              setActiveId(conversation.id);
                            }}
                          >
                            <MessageSquareText size={15} />
                            <span>
                              {conversation.branchedFrom && (
                                <GitBranch size={10} className="row-branch" aria-label={`从「${conversation.branchedFrom.title}」分出来`} />
                              )}
                              {conversation.title}
                              {conversation.tags?.length ? (
                                <em className="row-tags">{conversation.tags.join(" · ")}</em>
                              ) : null}
                            </span>
                          </button>
                        )}
                        <button
                          className="conversation-more"
                          type="button"
                          aria-label={`${conversation.title}的更多操作`}
                          aria-haspopup="menu"
                          aria-expanded={conversationMenu?.id === conversation.id}
                          data-tip="更多"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (conversationMenu?.id === conversation.id) {
                              setConversationMenu(null);
                              return;
                            }
                            const rect = event.currentTarget.getBoundingClientRect();
                            const menuWidth = 220;
                            const menuHeight = 500;
                            const below = window.innerHeight - rect.bottom;
                            const preferredTop = below >= menuHeight ? rect.bottom + 5 : rect.top - menuHeight - 5;
                            setConversationMenu({
                              id: conversation.id,
                              top: Math.max(8, Math.min(preferredTop, window.innerHeight - menuHeight - 8)),
                              left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
                            });
                          }}
                        >
                          <Ellipsis size={15} />
                        </button>
                        {conversationMenu?.id === conversation.id && (
                          <div
                            className="conversation-menu"
                            role="menu"
                            aria-label={`${conversation.title}的操作`}
                            style={{ top: conversationMenu.top, left: conversationMenu.left }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              setRenamingId(conversation.id);
                            }}>
                              <Pencil size={13} /> 改名
                            </button>
                            <label className="conversation-menu-project">
                              <FolderOpen size={13} />
                              <span>移到项目</span>
                              <select
                                aria-label={`把「${conversation.title}」移到项目`}
                                value={conversation.projectId || ""}
                                onChange={(event) => {
                                  moveConversation(conversation.id, event.target.value || undefined);
                                  setConversationMenu(null);
                                }}
                              >
                                <option value="">未分组</option>
                                {projects.map((project) => (
                                  <option value={project.id} key={project.id}>{project.name}</option>
                                ))}
                              </select>
                            </label>
                            <div className="conversation-menu-label">导出</div>
                            <button type="button" onClick={() => void exportConversation(conversation, "pdf")}>
                              <FileText size={13} /> PDF
                            </button>
                            <button type="button" onClick={() => void exportConversation(conversation, "html")}>
                              <Globe size={13} /> 网页
                            </button>
                            <button type="button" onClick={() => void exportConversation(conversation, "txt")}>
                              <FileText size={12} /> 纯文本<small>.txt</small>
                            </button>
                            <button type="button" onClick={() => void exportConversation(conversation, "pdf-clean")}>
                              <FileText size={12} /> 干净 PDF<small>不含附件文件名</small>
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                setConversationMenu(null);
                                const { textToDocx } = await import("./lib/docx.ts");
                                const { safeFileName } = await import("./lib/filename.ts");
                                // 逐条铺开：# 标题，## 谁说的，正文原样（Word 里代码块保持文本）。
                                const text = [
                                  `# ${conversation.title}`,
                                  "",
                                  ...conversation.messages.flatMap((item) => [
                                    `## ${item.role === "user" ? "我" : "kaii"}`,
                                    "",
                                    item.content,
                                    "",
                                  ]),
                                ].join("\n");
                                const bytes = textToDocx(text);
                                const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
                                const url = URL.createObjectURL(blob);
                                const anchor = document.createElement("a");
                                anchor.href = url;
                                anchor.download = safeFileName(conversation.title, "docx");
                                anchor.click();
                                URL.revokeObjectURL(url);
                              }}
                            >
                              <FileText size={12} /> Word<small>.docx</small>
                            </button>
                            <button type="button" onClick={() => void exportConversation(conversation, "md")}>
                              <Hash size={13} /> Markdown
                            </button>
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              const tag = window.prompt("标签（再输一次可去掉）", "");
                              if (tag === null) return;
                              updateConversation(conversation.id, (item) => ({
                                ...item,
                                tags: toggleTag(item.tags, tag),
                              }));
                            }}>
                              <Tag size={13} /> 标签
                            </button>
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              toggleArchiveChat(conversation.id);
                            }}>
                              <Archive size={13} /> {conversation.archived ? "恢复归档" : "归档"}
                            </button>
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              updateConversation(conversation.id, (item) => ({ ...item, pinned: !item.pinned }));
                            }}>
                              {conversation.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                              {conversation.pinned ? "取消置顶" : "置顶"}
                            </button>
                            <label className="conversation-menu-project">
                              <GitMerge size={13} />
                              <span>并入对话</span>
                              <select
                                aria-label={`把「${conversation.title}」并入另一段对话`}
                                value=""
                                onChange={(event) => {
                                  const targetId = event.target.value;
                                  setConversationMenu(null);
                                  if (!targetId) return;
                                  const target = conversations.find((item) => item.id === targetId);
                                  if (!target) return;
                                  if (!window.confirm(`把「${conversation.title}」整段接到「${target.title}」末尾？原对话进回收站，三十天内可反悔。`)) return;
                                  setConversations((current) => current.map((item) => {
                                    if (item.id === targetId) {
                                      return {
                                        ...item,
                                        messages: [...item.messages, ...conversation.messages],
                                        updatedAt: Date.now(),
                                      };
                                    }
                                    if (item.id === conversation.id) return { ...item, deletedAt: Date.now() };
                                    return item;
                                  }));
                                  if (activeId === conversation.id) setActiveId(targetId);
                                }}
                              >
                                <option value="">选一段…</option>
                                {conversations
                                  .filter((item) => item.id !== conversation.id && !item.deletedAt && !item.ephemeral && !item.archived)
                                  .slice(0, 12)
                                  .map((item) => (
                                    <option value={item.id} key={item.id}>{item.title.slice(0, 18)}</option>
                                  ))}
                              </select>
                            </label>
                            <button type="button" onClick={async () => {
                              setConversationMenu(null);
                              if (conversation.summary) {
                                updateConversation(conversation.id, (item) => ({ ...item, summary: undefined }));
                                return;
                              }
                              const digest = conversation.messages
                                .map((item) => `${item.role === "user" ? "问" : "答"}：${item.content.slice(0, 300)}`)
                                .join("\n")
                                .slice(0, 8000);
                              const outcome = await window.kaiLocal.summarizeConversation(digest);
                              if (outcome.ok && outcome.summary) {
                                updateConversation(conversation.id, (item) => ({ ...item, summary: outcome.summary }));
                              } else {
                                setBootError(outcome.message || "摘要没生成出来。");
                              }
                            }}>
                              <MessageSquareText size={13} /> {conversation.summary ? "去掉摘要" : "一句话摘要"}
                            </button>
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              const text = conversation.messages
                                .map((item) => `${item.role === "user" ? "我" : "kaii"}：${item.content}`)
                                .join("\n\n");
                              void navigator.clipboard.writeText(text);
                            }}>
                              <Copy size={13} /> 复制整段对话
                            </button>
                            <button type="button" onClick={() => {
                              setConversationMenu(null);
                              setOpenArtifact(null);
                              // 只取回答，不带提问：整理成文档时，问题本身通常是脚手架。
                              const answers = conversation.messages
                                .filter((item) => item.role === "assistant" && item.content.trim())
                                .map((item) => item.content)
                                .join("\n\n");
                              if (!answers.trim()) {
                                setBootError("这段对话还没有可以整理的回答。");
                                return;
                              }
                              setOpenCanvas({ title: conversation.title, text: answers });
                            }}>
                              <PenLine size={13} /> 整段进画布
                            </button>
                            <div className="conversation-menu-stats">
                              {conversation.messages.filter((item) => item.role === "user").length} 轮
                              {" · "}
                              {conversation.messages.reduce((total, item) => total + item.content.length, 0)} 字
                              {conversation.createdAt ? ` · 建于 ${new Date(conversation.createdAt).toLocaleDateString("zh-CN")}` : ""}
                              {(() => {
                                // 这段对话经手过哪些模型。云端和本机混着用的时候，
                                // 「这段内容到底发出去过没有」是个真问题。
                                const used = [...new Set(conversation.messages
                                  .map((item) => item.modelLabel)
                                  .filter((label): label is string => Boolean(label)))];
                                return used.length ? ` · ${used.join(" / ")}` : "";
                              })()}
                            </div>
                            <button className="danger" type="button" onClick={() => {
                              setConversationMenu(null);
                              deleteChat(conversation.id);
                            }}>
                              <Trash2 size={13} /> 删除
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }) : <div className="group-empty">还没有对话。在这个项目下新建一段。</div>}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sidebar-footer">
          <button
            className="status-card"
            type="button"
            title={localOnly
              ? "仅本机模式开着：云端已暂停。点一下启动或停止本机模型"
              : usingCloud ? "当前这段对话用的是云端模型，本机模型没有启动" : "点一下启动或停止本机模型"}
            onClick={usingCloud
              ? () => setSettingsOpen(true)
              : (modelState.status === "ready" ? () => window.kaiLocal.stopModel() : startModel)}
          >
            <span className={`status-dot ${statusTone(modelState)}`} />
            <span>
              <strong>{localOnly ? `仅本机 · ${modelLabel(modelState)}` : usingCloud ? currentModelLabel : modelLabel(modelState)}</strong>
              <small>
                {localOnly ? `云端已暂停 · ${modelState.detail}` : usingCloud ? "这段对话走的是云端" : modelState.detail}
                {!usingCloud && modelState.rssMb ? ` · 占内存 ${(modelState.rssMb / 1024).toFixed(1)}GB` : ""}
              </small>
            </span>
            <Power size={16} />
          </button>
          <div
            className="sidebar-tools"
            onMouseEnter={() => {
              if (toolsCloseTimer.current) {
                window.clearTimeout(toolsCloseTimer.current);
                toolsCloseTimer.current = null;
              }
              setSidebarToolsOpen(true);
            }}
            onMouseLeave={() => {
              if (toolsCloseTimer.current) window.clearTimeout(toolsCloseTimer.current);
              toolsCloseTimer.current = window.setTimeout(() => {
                toolsCloseTimer.current = null;
                setSidebarToolsOpen(false);
              }, 400);
            }}
          >
            <button
              className="utility-button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={sidebarToolsOpen}
              onClick={() => setSidebarToolsOpen((value) => !value)}
            >
              <Ellipsis size={16} /> 工具
            </button>
            {sidebarToolsOpen && (
              <div className="sidebar-tools-menu" role="menu" aria-label="工具">
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setTaskWorkbenchOpen(true); }}>
                  <Target size={15} /> 任务与结果{taskCapsules.length ? ` ${taskCapsules.length}` : ""}
                </button>
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setProjectPanelOpen(true); }}><FolderOpen size={15} /> 项目{projects.length ? ` ${projects.length}` : ""}</button>

                <button type="button" onClick={() => { setSidebarToolsOpen(false); setStarredOpen(true); }}><Star size={15} /> 收藏{starredCount ? ` ${starredCount}` : ""}</button>
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setReadLaterOpen(true); }}><Bookmark size={15} /> 网页{savedPages.length ? ` ${savedPages.length}` : ""}</button>
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setScheduleOpen(true); }}>
                  <Clock size={15} /> 定时
                  {schedules.some((item) => item.results?.some((entry) => entry.unread)) && <i className="unread-dot" aria-label="有新结果" />}
                </button>
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setBatchOpen(true); }}><Layers size={15} /> 批量</button>
                {trashCount > 0 && <button type="button" onClick={() => { setSidebarToolsOpen(false); setTrashOpen(true); }}><Trash2 size={15} /> 回收站 {trashCount}</button>}
                <button type="button" onClick={() => { setSidebarToolsOpen(false); setSettingsOpen(true); }}><Settings size={15} /> 设置</button>
              </div>
            )}
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button sidebar-toggle"
            type="button"
            aria-label={miniMode ? "回到完整窗口并打开侧边栏" : "切换侧边栏"}
            data-tip={miniMode ? "打开完整窗口" : "侧边栏"}
            onClick={() => {
              if (miniMode) {
                setMiniMode(false);
                setSidebarOpen(true);
                void window.kaiLocal.setMiniWindow(false).then((result) => setMiniMode(result.mini));
                return;
              }
              setSidebarOpen((value) => !value);
            }}
          >
            <Menu size={18} />
          </button>
          <div className="topbar-title">
            <span
              title={("双击改这段对话的名字")}
              onDoubleClick={() => {
                if (!activeConversation) return;
                setRenamingId(activeConversation.id);
                setSidebarOpen(true);
              }}
            >
              {((activeConversation?.title || "新对话"))}
            </span>
          </div>
          <div className="topbar-actions">
            <button
              className={`icon-button${miniMode ? " on" : ""}`}
              type="button"
              aria-label={miniMode ? "回到正常大小" : "缩成一条钉在最前面"}
              data-tip={miniMode ? "回到正常大小" : "迷你模式"}
              aria-pressed={miniMode}
              onClick={() => {
                const next = !miniMode;
                setMiniMode(next);
                void window.kaiLocal.setMiniWindow(next).then((result) => setMiniMode(result.mini));
              }}
            >
              {miniMode ? <Maximize2 size={17} /> : <Minimize2 size={17} />}
            </button>
            <button
              className={`icon-button network-mode${localOnly ? " on" : ""}`}
              type="button"
              aria-label={requestId ? "回答结束后才能切换仅本机模式" : localOnly ? "关掉仅本机模式" : "开仅本机模式"}
              data-tip={requestId ? "回答结束后再切换" : localOnly ? "仅本机：主聊天的云端与联网已暂停" : "仅本机模式"}
              aria-pressed={localOnly}
              disabled={!settings || localOnlyBusy || Boolean(requestId)}
              onClick={() => void toggleLocalOnly()}
            >
              {localOnlyBusy
                ? <LoaderCircle className="spin" size={16} />
                : localOnly ? <WifiOff size={17} /> : <Wifi size={17} />}
              {localOnly && <span>仅本机</span>}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={settings?.theme === "dark" ? "换成浅色" : settings?.theme === "light" ? "跟随系统" : "换成深色"}
              data-tip={settings?.theme === "dark" ? "换成浅色" : settings?.theme === "light" ? "跟随系统" : "换成深色"}
              onClick={() => void cycleTheme()}
            >
              {settings?.theme === "dark" ? <Sun size={17} /> : settings?.theme === "light" ? <Monitor size={17} /> : <Moon size={17} />}
            </button>
            <button className="icon-button" type="button" aria-label="设置" data-tip="设置" onClick={() => setSettingsOpen(true)}><Settings size={17} /></button>
          </div>
        </header>

        <section
          ref={chatScroll}
          className="chat-scroll"
          onMouseUp={(event) => {
            // 只认落在回答里的选区。选中后就地给一个"引用"，比复制粘贴顺手。
            const selection = window.getSelection();
            const text = selection?.toString().trim() ?? "";
            if (!text || text.length < 2 || text.length > 2000) {
              setQuoteTarget(null);
              return;
            }
            const inAnswer = (event.target as HTMLElement)?.closest?.(".message.assistant .message-body");
            if (!inAnswer) {
              setQuoteTarget(null);
              return;
            }
            setQuoteTarget({ text, x: event.clientX, y: event.clientY });
          }}
          onMouseDown={() => setQuoteTarget(null)}
          onScroll={(event) => {
            const node = event.currentTarget;
            const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
            if (node.scrollTop < lastScrollTop.current - 1) {
              followLatest.current = false;
            } else if (gap <= 8) {
              followLatest.current = true;
            }
            lastScrollTop.current = node.scrollTop;
            scrollMemory.current[activeId] = followLatest.current ? "bottom" : node.scrollTop;
            updateScrollState();
          }}
        >
          {activeConversation?.ephemeral && (
            <div className="ephemeral-note">这段对话不写盘：关掉应用就没了，也不进备份和搜索。</div>
          )}
          {activeConversation?.summary && (
            <div className="chat-summary" title="右键侧栏对话可重新生成或去掉">{activeConversation.summary}</div>
          )}
          {(activeConversation?.messages.filter((item) => item.starred).length ?? 0) > 0 && (
            <div className="bookmark-bar">
              <Star size={11} />
              {activeConversation!.messages.filter((item) => item.starred).map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  title={item.content.slice(0, 80)}
                  onClick={() => document.getElementById(`msg-${item.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          )}
          {inChatFind !== null && (
            <div className="in-chat-find">
              <Search size={13} />
              <input
                value={inChatFind}
                placeholder="在这段对话里找"
                aria-label="在这段对话里找"
                onChange={(event) => {
                  findCursor.current = -1;
                  setInChatFind(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setInChatFind(null);
                  // 回车跳下一处，⇧回车跳上一处——和浏览器查找一个手势。
                  if (event.key === "Enter") {
                    event.preventDefault();
                    jumpToFind(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span>
                {inChatFind.trim()
                  ? `命中 ${(activeConversation?.messages || []).filter((item) => item.content.toLowerCase().includes(inChatFind.toLowerCase())).length} 条`
                  : "⇧⌘F 是搜全部历史"}
              </span>
              {inChatFind.trim() && (
                <>
                  <button
                    type="button"
                    aria-label="上一处命中"
                    title="上一处"
                    onClick={() => jumpToFind(-1)}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="下一处命中"
                    title="下一处（在查找框里按回车也行）"
                    onClick={() => jumpToFind(1)}
                  >
                    <ChevronDown size={13} />
                  </button>
                </>
              )}
              <button type="button" aria-label="关掉查找" onClick={() => setInChatFind(null)}><X size={13} /></button>
            </div>
          )}
          {(activeConversation?.messages.length ? (
            <div className="messages">
              {activeConversation.messages.map((message, messageIndex) => (
                <Fragment key={message.id}>
                {(() => {
                  // 跨天时插一条日期分隔线。长对话翻上去，知道「这是哪天聊的」很重要。
                  const previous = activeConversation.messages[messageIndex - 1];
                  if (!message.createdAt) return null;
                  const day = new Date(message.createdAt).toDateString();
                  if (previous?.createdAt && new Date(previous.createdAt).toDateString() === day) return null;
                  if (!previous) return null; // 第一条上面不用画，顶部本来就是开头
                  return (
                    <div className="day-divider" aria-hidden="true">
                      {new Date(message.createdAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })}
                    </div>
                  );
                })()}
                <article
                  className={`message ${message.role} ${message.error ? "message-error" : ""}${
                    inChatFind?.trim() && message.content.toLowerCase().includes(inChatFind.toLowerCase()) ? " found" : ""
                  }`}
                  id={`msg-${message.id}`}
                  onContextMenu={(event) => {
                    if (message.role !== "assistant" || message.pending || !message.content.trim()) return;
                    // 右键选中文字时让位给系统菜单（用户多半想复制那段字）。
                    if (window.getSelection()?.toString().trim()) return;
                    event.preventDefault();
                    setMessageMenu({
                      id: message.id,
                      x: Math.min(event.clientX, window.innerWidth - 190),
                      y: Math.min(event.clientY, window.innerHeight - 190),
                    });
                  }}
                >
                  {messageMenu?.id === message.id && (
                    <div
                      className="conversation-menu message-context"
                      role="menu"
                      style={{ top: messageMenu.y, left: messageMenu.x }}
                    >
                      <button type="button" onClick={() => { void copyMessage(message); setMessageMenu(null); }}>
                        <Copy size={12} /> 复制全文
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(stripMarkdown(message.content));
                          setMessageMenu(null);
                        }}
                      >
                        <Copy size={12} /> 复制纯文本
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft((current) => `${current ? `${current}\n` : ""}> ${message.content.slice(0, 160).replace(/\n+/g, " ")}…\n\n`);
                          setMessageMenu(null);
                          requestAnimationFrame(() => composer.current?.focus());
                        }}
                      >
                        <MessageSquareQuote size={12} /> 引用追问
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenArtifact(null);
                          setOpenCanvas({ title: activeConversation?.title || "文档", text: message.content });
                          setMessageMenu(null);
                        }}
                      >
                        <PenLine size={12} /> 在画布里改
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          updateConversation(activeConversation!.id, (conversation) => ({
                            ...conversation,
                            messages: conversation.messages.map((item) => (
                              item.id === message.id ? { ...item, starred: !item.starred } : item
                            )),
                          }));
                          setMessageMenu(null);
                        }}
                      >
                        <Star size={12} /> {message.starred ? "取消收藏" : "收藏"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMessageMenu(null);
                          setDraft(`把下面这段翻译一下（中文翻英文，其他语言翻中文），保持格式：\n\n> ${message.content.slice(0, 1500).replace(/\n+/g, "\n> ")}`);
                          requestAnimationFrame(() => composer.current?.focus());
                        }}
                      >
                        <MessageSquareText size={12} /> 翻译这条
                      </button>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => {
                          setMessageMenu(null);
                          if (!window.confirm("删掉这一轮问答（连同你的问题）？删了不进回收站。")) return;
                          updateConversation(activeConversation!.id, (conversation) => {
                            const at = conversation.messages.findIndex((item) => item.id === message.id);
                            if (at < 0) return conversation;
                            // 连同紧挨着的那条提问一起删，不留半轮。
                            const dropFrom = at > 0 && conversation.messages[at - 1].role === "user" ? at - 1 : at;
                            return {
                              ...conversation,
                              messages: conversation.messages.filter((_, index) => index < dropFrom || index > at),
                            };
                          });
                        }}
                      >
                        <Trash2 size={12} /> 删掉这轮
                      </button>
                    </div>
                  )}
                  <div
                    className={`speaker-avatar ${message.role}`}
                    aria-label={message.role === "assistant" ? "kaii-agent" : "Me"}
                    title={[
                      `第 ${activeConversation.messages.slice(0, messageIndex + 1).filter((item) => item.role === "user").length || 1} 轮`,
                      message.createdAt ? new Date(message.createdAt).toLocaleString("zh-CN") : "",
                    ].filter(Boolean).join(" · ")}
                  >
                    {message.role === "assistant" ? <img src="./logos/kaii-k-a.svg" alt="" /> : <span>Me</span>}
                  </div>
                  <div
                    className="message-body"
                    onDoubleClick={() => {
                      // 双击已展开的长回答把它收回去；没展开过的双击不动（可能在选词）。
                      if (message.role !== "assistant" || !expandedMessages.has(message.id)) return;
                      if (window.getSelection()?.toString()) return;
                      setExpandedMessages((current) => {
                        const next = new Set(current);
                        next.delete(message.id);
                        return next;
                      });
                      document.getElementById(`msg-${message.id}`)?.scrollIntoView({ block: "start" });
                    }}
                  >
                    {message.document && (
                      <div className="message-document">
                        <FileText size={16} />
                        <span>
                          <strong>{message.document.name}</strong>
                          <small>
                            {message.document.kind === "pdf"
                              ? `${message.document.pageCount} 页`
                              : `${message.document.characters} 字`}
                          </small>
                        </span>
                      </div>
                    )}
                    {message.attachment && (
                      <figure className="message-image">
                        <button
                          type="button"
                          className="image-save image-ocr"
                          title="把图里读出来的字取出来"
                          onClick={() => {
                            void window.kaiLocal.imageText(message.attachment!.id).then((text) => {
                              if (!text.trim()) {
                                setBootError("这张图里没读出文字。");
                                return;
                              }
                              void navigator.clipboard.writeText(text);
                              setStorageWarning(`图里的 ${text.length} 个字已复制。`);
                            });
                          }}
                        >
                          抠字
                        </button>
                        <button
                          type="button"
                          className="image-save"
                          title="把这张图另存到别处"
                          onClick={() => {
                            void window.kaiLocal.saveImageAs(message.attachment!.id, message.attachment!.name).then((outcome) => {
                              if (!outcome.ok && !outcome.cancelled) setBootError(outcome.message || "这张图没存成。");
                            });
                          }}
                        >
                          另存
                        </button>
                        {message.attachment.previewDataUrl
                          ? (
                            <button
                              type="button"
                              className="image-zoom"
                              title="点开看大图"
                              onClick={() => setZoomedImage({
                                src: message.attachment!.previewDataUrl,
                                name: message.attachment!.name,
                              })}
                            >
                              <img src={message.attachment.previewDataUrl} alt={message.attachment.name} />
                            </button>
                          )
                          : <div className="message-image-placeholder"><ImagePlus size={19} /> 图片附件</div>}
                        <figcaption>{message.attachment.name} · {message.attachment.width}×{message.attachment.height}</figcaption>
                      </figure>
                    )}
                    {message.reasoning?.trim() ? (
                      <details className="reasoning-block">
                        <summary>思考过程（{message.reasoning.trim().length} 字）</summary>
                        <div>{message.reasoning.trim()}</div>
                      </details>
                    ) : null}
                    {message.pending && requestStartedAt.current > 0 && (
                      <span className="pending-elapsed">
                        {Math.max(0, Math.floor((Date.now() - requestStartedAt.current) / 1000))} 秒
                      </span>
                    )}
                    {message.pending && !message.content ? (
                      <span className="thinking"><i /><i /><i /></span>
                    ) : message.role === "assistant" ? (
                      <>
                      {(() => {
                        // 长回答给个小目录。标题少于三个就不给——
                        // 两条的目录不解决问题，只占地方。
                        const outline = message.role === "assistant" && !message.pending
                          ? extractOutline(message.id, message.content)
                          : [];
                        if (!outline.length) return null;
                        return (
                          <details className="answer-outline">
                            <summary>这段有 {outline.length} 节</summary>
                            <ol>
                              {outline.map((item) => (
                                <li key={item.id} style={{ paddingLeft: `${(item.level - 1) * 12}px` }}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      // 按标题文字在渲染结果里找对应的 h 标签。
                                      // 用文字找而不是记 DOM 引用：回答是流式渲染的，
                                      // 节点会被反复替换，存引用会指向已经不在的东西。
                                      const host = document.getElementById(`msg-${message.id}`);
                                      const heading = [...(host?.querySelectorAll("h1,h2,h3,h4") || [])]
                                        .find((node) => node.textContent?.trim() === item.text);
                                      heading?.scrollIntoView({ block: "start", behavior: "smooth" });
                                    }}
                                  >
                                    {item.text}
                                  </button>
                                </li>
                              ))}
                            </ol>
                          </details>
                        );
                      })()}
                      {message.error && message.content.trim() && !message.pending && (
                        <div className="partial-note">这条中途停了，上面是已经生成的部分。</div>
                      )}
                      {(message.modelLabel || message.elapsedMs || describeLength(message.content)) && (
                        <div className="from-model">
                          {message.modelLabel && <>来自 {message.modelLabel}</>}
                          {message.modelLabel && message.elapsedMs ? " · " : ""}
                          {message.elapsedMs ? `${(message.elapsedMs / 1000).toFixed(1)} 秒` : ""}
                          {message.elapsedMs && message.content.length > 50
                            ? ` · ${Math.round(message.content.length / (message.elapsedMs / 1000))} 字/秒`
                            : ""}
                          {describeLength(message.content) ? ` · ${describeLength(message.content)}` : ""}
                        </div>
                      )}
                      <MarkdownAnswer content={message.content} folded={!expandedMessages.has(message.id)} onExpand={() => {
                        setExpandedMessages((current) => new Set(current).add(message.id));
                      }} />
                      </>
                    ) : (
                      <p>{message.content}</p>
                    )}
                    {message.toolCalls?.length ? (
                      <ToolReceiptList
                        receipts={message.toolCalls}
                        runId={message.runId}
                        onRollback={rollbackToolCall}
                        onRollbackRun={rollbackAgentRun}
                        onDecide={decideToolCall}
                      />
                    ) : null}
                    {message.completion ? <CompletionEvidenceCard evidence={message.completion} /> : null}
                    {message.continuable && message.runId ? (
                      <ResumeCheckpointStatus run={agentRuns.find((run) => run.id === message.runId)} />
                    ) : null}
                    {message.role === "assistant" && !message.pending && message.content && !requestId && (
                      <div className="message-actions">
                        <span
                          className="drag-out"
                          draggable
                          title="按住拖到别的应用里去"
                          onDragStart={(event) => {
                            event.dataTransfer.setData("text/plain", message.content);
                            event.dataTransfer.effectAllowed = "copy";
                          }}
                        >
                          <GripVertical size={13} />
                        </span>
                        <button
                          type="button"
                          title="把这段回答变成可以直接编辑的文档"
                          onClick={() => { setOpenArtifact(null); setOpenCanvas({
                            title: activeConversation?.title || "文档",
                            text: message.content,
                          }); }}
                        >
                          <PenLine size={13} /> 在画布里改
                        </button>
                        <button
                          type="button"
                          className={speakingId === message.id ? "on" : ""}
                          title={speakingId === message.id ? "停下" : "念给我听"}
                          onClick={() => {
                            if (speakingId === message.id) {
                              void window.kaiLocal.stopSpeak();
                              setSpeakingId(null);
                              return;
                            }
                            setSpeakingId(message.id);
                            void window.kaiLocal.startSpeak({ text: message.content, messageId: message.id })
                              .then((outcome) => {
                                if (!outcome.ok) {
                                  setSpeakingId(null);
                                  setBootError(outcome.message || "念不了这段");
                                }
                              });
                          }}
                        >
                          {speakingId === message.id ? <Square size={13} /> : <Volume2 size={13} />}
                          {speakingId === message.id ? "停下" : "读出来"}
                        </button>
                        <button
                          type="button"
                          className={message.starred ? "on" : ""}
                          title={message.starred ? "取消收藏" : "收藏这条回答"}
                          onClick={() => updateConversation(activeConversation!.id, (conversation) => ({
                            ...conversation,
                            messages: conversation.messages.map((item) => (
                              item.id === message.id ? { ...item, starred: !item.starred } : item
                            )),
                          }))}
                        >
                          <Star size={13} /> {message.starred ? "已收藏" : "收藏"}
                        </button>
                        <button type="button" title="复制" onClick={() => copyMessage(message)}>
                          <Copy size={13} /> {copiedId === message.id ? "已复制" : "复制"}
                        </button>
                        <button
                          type="button"
                          title="把刚才那个问题原样再问一遍（换个模型时有用）"
                          onClick={() => {
                            const asked = [...(activeConversation?.messages || [])]
                              .reverse()
                              .find((item) => item.role === "user" && item.content.trim());
                            if (asked) void send(asked.content);
                          }}
                        >
                          <Repeat size={13} /> 再问一次
                        </button>
                        {(
                          <>
                            <button
                              type="button"
                              title="太长了，要一版短的"
                              onClick={() => send("上面那段太长了。用三句话之内重说一遍，只留最要紧的。")}
                            >
                              <Minus size={13} /> 短一点
                            </button>
                            <button
                              type="button"
                              title="说得太笼统，要展开"
                              onClick={() => send("上面那段说得太笼统了。展开讲，给具体的例子和数字，不要泛泛而谈。")}
                            >
                              <Plus size={13} /> 详细点
                            </button>
                            <button type="button" title="用同一个问题重新生成" onClick={() => regenerate(message.id)}>
                              <RefreshCw size={13} /> 重新生成
                            </button>
                            <button type="button" title="从这里分出一段新对话，原来这段不动" onClick={() => branchConversation(message.id)}>
                              <GitBranch size={13} /> 分支
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {followups.messageId === message.id && followups.items.length > 0 && !requestId && (
                      <div className="followups" aria-label="接着问">
                        <span>接着问</span>
                        {followups.items.map((item) => (
                          <button
                            type="button"
                            key={item}
                            onClick={() => {
                              setFollowups({ messageId: "", items: [] });
                              void send(item);
                            }}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    )}
                    {artifactsByMessage.get(message.id)?.map((artifact) => (
                      <button
                        className={`artifact-chip ${openArtifact?.id === artifact.id ? "active" : ""}`}
                        type="button"
                        key={artifact.id}
                        onClick={() => { setOpenCanvas(null); setOpenArtifact((current) => (current?.id === artifact.id ? null : artifact)); }}
                      >
                        <FileCode2 size={14} />
                        <span>
                          <strong>{artifact.title}</strong>
                          <small>{artifactSummary(artifact)}</small>
                        </span>
                        <em>{openArtifact?.id === artifact.id ? "关闭" : "在侧栏打开"}</em>
                      </button>
                    ))}
                    {message.memorySuggestions?.length ? (
                      <div className="memory-suggest" aria-label="要不要记住">
                        <span>要不要记住这些？</span>
                        {message.memorySuggestions.map((suggestion) => (
                          <button
                            type="button"
                            key={suggestion.content}
                            onClick={async () => {
                                  await window.kaiLocal.createMemory({
                                    content: suggestion.content,
                                    kind: suggestion.kind,
                                    pinned: false,
                                    source: {
                                      kind: "conversation",
                                      conversationId: activeConversation.id,
                                      messageId: message.id,
                                      modelLabel: message.modelLabel || "unknown",
                                    },
                                    scope: activeConversation.projectId
                                      ? { kind: "project", id: activeConversation.projectId }
                                      : { kind: "conversation", id: activeConversation.id },
                                  }).catch(() => {});
                              setMemories(await window.kaiLocal.listMemories(true).catch(() => []));
                              setConversations((current) => current.map((conversation) => ({
                                ...conversation,
                                messages: conversation.messages.map((item) => (
                                  item.id === message.id
                                    ? {
                                        ...item,
                                        memorySuggestions: item.memorySuggestions?.filter(
                                          (entry) => entry.content !== suggestion.content,
                                        ),
                                      }
                                    : item
                                )),
                              })));
                            }}
                          >
                            <Plus size={11} /> <b>{suggestion.label}</b> {suggestion.content}
                          </button>
                        ))}
                        <button
                          className="memory-suggest-dismiss"
                          type="button"
                          onClick={() => setConversations((current) => current.map((conversation) => ({
                            ...conversation,
                            messages: conversation.messages.map((item) => (
                              item.id === message.id ? { ...item, memorySuggestions: [] } : item
                            )),
                          })))}
                        >
                          都不用
                        </button>
                      </div>
                    ) : null}
                    {message.continuable && !requestId && (
                      message.continueReason === "truncated" ? (
                        <button
                          className="continue-task"
                          type="button"
                          title="上面这段被长度限制掐断了，停在半句话上"
                          onClick={() => void resumeTask(message)}
                        >
                          <ArrowUp size={13} /> 话没说完，接着写
                        </button>
                      ) : (
                        <button
                          className="continue-task"
                          type="button"
                          onClick={() => void resumeTask(message)}
                        >
                          <ArrowUp size={13} /> 继续这个任务
                        </button>
                      )
                    )}
                    {message.citations?.length ? (
                      <div className="citation-list" aria-label="资料出处">
                        <span>出处</span>
                        {message.citations.map((citation) => (
                          <span className="citation" key={citation.index} title={citation.absolutePath}>
                            <b>{citation.index}</b>{citation.file} · {citation.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {message.sources?.length ? (
                      <div className="source-list" aria-label="联网来源">
                        <span>来源</span>
                        {message.sources.map((source, sourceIndex) => (
                          <button
                            type="button"
                            key={`${source.url}-${sourceIndex}`}
                            title={`${source.title}\n${source.url}`}
                            data-tip={new URL(source.url).hostname}
                            onClick={() => window.kaiLocal.openSource(source.url)}
                          >
                            <b>{sourceIndex + 1}</b><span>{source.title}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {message.role === "user" && !message.pending && message.content && !requestId && (
                    <div className="message-actions outside">
                      <button type="button" title="复制" onClick={() => copyMessage(message)}>
                        <Copy size={13} /> {copiedId === message.id ? "已复制" : "复制"}
                      </button>
                      {(
                        <button type="button" title="改一下这个问题再问" onClick={() => startEdit(message)}>
                          <Pencil size={13} /> 编辑重发
                        </button>
                      )}
                      {message.content.trim().length >= 8 && (
                        <button
                          type="button"
                          title="把这个问法存起来，以后敲 / 就能调出来"
                          onClick={() => {
                            const label = window.prompt("给这条常用语起个短名字：", message.content.trim().slice(0, 12));
                            if (label === null || !label.trim()) return;
                            setPrompts((current) => [createPrompt(label.trim().slice(0, 20), message.content.trim()), ...current]);
                            setStorageWarning(`已存成常用语「${label.trim().slice(0, 20)}」，输入框敲 / 可以调出来。`);
                          }}
                        >
                          <Bookmark size={13} /> 存成常用语
                        </button>
                      )}
                    </div>
                  )}
                </article>
                </Fragment>
              ))}
              {revisionPreview?.conversationId === activeConversation.id && (
                <aside className="revision-preview" aria-live="polite">
                  <div className="revision-preview-head">
                    <span>{revisionPreview.kind === "edit" ? "正在试写修改后的版本" : "正在生成另一版"}</span>
                    <small>上面的原对话暂时不动</small>
                  </div>
                  {revisionPreview.assistant.content
                    ? <MarkdownAnswer content={revisionPreview.assistant.content} folded={false} onExpand={() => {}} />
                    : <span className="thinking"><i /><i /><i /></span>}
                </aside>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="hero-art"><img src="./logos/kaii-k-a.svg" alt="kaii-agent" /></div>
              <div className="empty-title">
              <h1>{greetingNow()}</h1>
              <p className="empty-date">{new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</p>
              {(() => {
                const dayStart = new Date();
                dayStart.setHours(0, 0, 0, 0);
                const before = conversations
                  .filter((item) => !item.deletedAt && !item.ephemeral && !item.archived && item.messages.length && item.updatedAt < dayStart.getTime())
                  .sort((a, b) => b.updatedAt - a.updatedAt)[0];
                if (!before) return null;
                return (
                  <button
                    type="button"
                    className="empty-resume"
                    onClick={() => {
                      setActiveId(before.id);
                    }}
                  >
                    接着上次：{before.title.slice(0, 18)}
                  </button>
                );
              })()}
              </div>
              <div className="suggestions">
                {suggestions.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => send(suggestion)}>
                    <span className="paper-pin" aria-hidden="true"><i /></span>
                    <span className="suggestion-copy">{suggestion}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        {quoteTarget && (
          <button
            className="quote-button"
            type="button"
            style={{ left: `${quoteTarget.x}px`, top: `${quoteTarget.y + 14}px` }}
            onClick={() => {
              const quoted = quoteTarget.text.split("\n").map((line) => `> ${line}`).join("\n");
              setDraft((current) => (current.trim() ? `${current.trim()}\n\n${quoted}\n\n` : `${quoted}\n\n`));
              setQuoteTarget(null);
              window.getSelection()?.removeAllRanges();
              requestAnimationFrame(() => composer.current?.focus());
            }}
          >
            <Quote size={12} /> 引用这段追问
          </button>
        )}

        {scrollOverflow && (
          <div
            className="scroll-rail"
            ref={scrollRail}
            aria-label={("对话滚动条")}
          >
            <button
              className="scroll-thumb"
              type="button"
              aria-label={("拖动浏览长对话")}
              aria-valuemin={0}
              aria-valuemax={Math.max(0, scrollState.scrollHeight - scrollState.clientHeight)}
              aria-valuenow={Math.round(scrollState.scrollTop)}
              role="scrollbar"
              style={{ height: `${scrollThumbHeight}%`, top: `${scrollThumbTop}%` }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                scrollDrag.current = {
                  pointerId: event.pointerId,
                  startY: event.clientY,
                  startScroll: chatScroll.current?.scrollTop || 0,
                };
              }}
              onPointerMove={(event) => {
                const drag = scrollDrag.current;
                const node = chatScroll.current;
                const rail = scrollRail.current;
                if (!drag || drag.pointerId !== event.pointerId || !node || !rail) return;
                const railHeight = rail.getBoundingClientRect().height;
                const thumbHeight = railHeight * (scrollThumbHeight / 100);
                const scrollRange = Math.max(1, node.scrollHeight - node.clientHeight);
                const travel = Math.max(1, railHeight - thumbHeight);
                node.scrollTop = drag.startScroll + ((event.clientY - drag.startY) / travel) * scrollRange;
              }}
              onPointerUp={(event) => {
                if (scrollDrag.current?.pointerId === event.pointerId) scrollDrag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                scrollDrag.current = null;
              }}
            />
          </div>
        )}

        {scrollAwayFromBottom && Boolean(activeConversation?.messages.length) && (
          <button
            className="jump-latest"
            type="button"
            onClick={() => {
              followLatest.current = true;
              chatScroll.current?.scrollTo({ top: chatScroll.current.scrollHeight, behavior: "auto" });
              updateScrollState();
            }}
          >
            <ArrowDown size={14} /> 回到最新
          </button>
        )}

        {bootError && (
          <div className="inline-error" role="alert" aria-live="polite">
            <span>{bootError}</span><button type="button" onClick={() => setBootError(null)}><X size={15} /></button>
          </div>
        )}

        {storageWarning && (
          <div className="inline-error inline-warning" role="status" aria-live="polite">
            <span>{storageWarning}</span><button type="button" onClick={() => setStorageWarning(null)}><X size={15} /></button>
          </div>
        )}

        {(
        <section className="composer-wrap" ref={composerWrap}>
          {((null))}
          {editSession?.conversationId === activeConversation?.id && (
            <div className="edit-session" role="status">
              <span><Pencil size={12} /> 正在修改这条问题</span>
              <button type="button" disabled={Boolean(requestId)} onClick={cancelEdit}>
                <X size={12} /> 取消
              </button>
            </div>
          )}
          <div className="composer-tools">
            <div className="composer-left">
            <div className="skill-picker">
              <button type="button" disabled={false} aria-expanded={skillMenuOpen} aria-haspopup="menu" onClick={() => setSkillMenuOpen((value) => !value)}>
                <FilePenLine size={14} /> {((selectedSkill?.name || "普通聊天"))} <ChevronDown size={13} />
              </button>
              {skillMenuOpen && (
                <div className="skill-menu" role="menu">
                  <button type="button" className={!selectedSkill ? "selected" : ""} onClick={() => changeSkill("none")}>
                    <span><strong>普通聊天</strong><small>自然对话</small></span>
                  </button>
                  {skills.map((skill) => (
                    <button type="button" className={skill.id === selectedSkill?.id ? "selected" : ""} key={skill.id} onClick={() => changeSkill(skill.id)}>
                      <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="model-picker">
              <button
                className={localOnly ? "offline" : undefined}
                type="button"
                aria-expanded={modelMenuOpen}
                aria-haspopup="menu"
                aria-label={localOnly ? "当前仅使用本机模型" : "选择模型"}
                disabled={Boolean(requestId)}
                onClick={() => {
                  setModelMenuOpen((value) => !value);
                  if (!catalog.length) void window.kaiLocal.fetchModelCatalog().then(setCatalog).catch(() => {});
                }}
              >
                {localOnly ? `仅本机 · ${localModelShortStatus}` : activeConversation?.provider ? currentModelLabel : "自动"}
                {!localOnly && routedReason && !activeConversation?.provider ? <em className="routed-why">{routedReason}</em> : null}
                <ChevronDown size={12} />
              </button>
              {modelMenuOpen && (
                <div className="model-menu" role="menu">
                  <div className={`model-menu-note${localOnly ? " offline" : ""}`}>
                    {localOnly
                      ? "仅本机模式正在生效：主聊天不会访问云端模型或联网搜索。原来的模型选择没有丢，退出后会恢复。"
                      : "云端模型会收到本轮问题及用到的附件、记忆和资料片段。"}
                  </div>
                  <div className="model-group">
                    <button
                      type="button"
                      className={localOnly || !activeConversation?.provider ? "selected" : ""}
                      disabled={localOnly}
                      onClick={() => {
                        if (!activeConversation) return;
                        updateConversation(activeConversation.id, (conversation) => ({
                          ...conversation,
                          provider: undefined,
                          model: undefined,
                        }));
                        setModelMenuOpen(false);
                      }}
                    >
                      <strong>{localOnly ? "仅本机" : "自动"}</strong>
                      <small>{localOnly ? "主聊天固定走本机" : "按任务选择"}</small>
                    </button>
                  </div>
                  {catalog.length ? catalog.map((section) => (
                    <div className="model-group" key={section.group}>
                      <div className="model-group-head">{section.group}</div>
                      {section.items.map((item) => (
                        <button
                          type="button"
                          key={`${item.provider}-${item.model}`}
                          className={
                            (localOnly
                              ? item.provider === "local"
                              : (activeConversation?.provider || "local") === item.provider
                                && (activeConversation?.model || "") === item.model) ? "selected" : ""
                          }
                          disabled={!item.configured || (localOnly && item.provider !== "local")}
                          onClick={() => item.configured && (!localOnly || item.provider === "local") && chooseModel(item.provider, item.model)}
                        >
                          <strong>{item.label}</strong>
                          <small>{localOnly && item.provider !== "local"
                            ? "仅本机模式下暂停"
                            : item.configured ? item.note : "需要先填 API key"}</small>
                        </button>
                      ))}
                    </div>
                  )) : <div className="model-loading">正在读取可用模型…</div>}
                </div>
              )}
            </div>
            <div className="prompt-picker" onClick={keepMenuClickInside}>
              <button
                type="button"
                aria-expanded={promptMenuOpen}
                title="我的指令：常用的要求存起来，一键塞进输入框"
                aria-label="我的指令"
                data-tip="我的指令"
                onClick={() => setPromptMenuOpen((value) => !value)}
              >
                <BookmarkPlus size={15} />
                {prompts.length > 0 && <b>{prompts.length}</b>}
              </button>
              {promptMenuOpen && (
                <div className="prompt-menu" role="menu">
                  {prompts.length ? sortPrompts(prompts).map((item) => (
                    <div className="prompt-row" key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          // 把 {{今天}} 这类变量填掉再塞进去。
                          const filled = fillPromptVariables(item.body, {
                            selection: window.getSelection()?.toString().trim() || undefined,
                          });
                          setDraft((current) => (current.trim() ? `${filled}\n\n${current.trim()}` : filled));
                          setPrompts((current) => current.map((entry) => (
                            entry.id === item.id ? { ...entry, useCount: entry.useCount + 1 } : entry
                          )));
                          setPromptMenuOpen(false);
                          requestAnimationFrame(() => composer.current?.focus());
                        }}
                      >
                        <strong>{item.label}</strong>
                        <small>{item.body.length > 48 ? `${item.body.slice(0, 48)}…` : item.body}</small>
                      </button>
                      <button
                        className="prompt-remove"
                        type="button"
                        aria-label={`删掉${item.label}`}
                        onClick={() => setPrompts((current) => current.filter((entry) => entry.id !== item.id))}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )) : <div className="prompt-empty">还没有指令</div>}
                  <div className="prompt-vars">
                    支持 <code>{"{{今天}}"}</code> <code>{"{{现在}}"}</code> <code>{"{{星期}}"}</code> <code>{"{{选中}}"}</code>
                  </div>
                  <button
                    className="prompt-save"
                    type="button"
                    disabled={!draft.trim()}
                    onClick={() => {
                      setPrompts((current) => [createPrompt(draft.trim().slice(0, 20), draft.trim()), ...current]);
                      setPromptMenuOpen(false);
                    }}
                  >
                    <BookmarkPlus size={12} /> 保存当前输入
                  </button>
                </div>
              )}
            </div>
            </div>
            {speechNote && (
              <div className="speech-note" role="alert">
                {speechNote}
                <button type="button" aria-label="关掉这条提示" onClick={() => setSpeechNote(null)}><X size={11} /></button>
              </div>
            )}
            <button
              type="button"
              className="composer-grow"
              aria-label={tallComposer ? "把输入框收回去" : "把输入框拉大"}
              data-tip={tallComposer ? "收回去" : "拉大输入框"}
              aria-pressed={tallComposer}
              onClick={() => setTallComposer((value) => !value)}
            >
              {tallComposer ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            </button>
            {contextPressure && (
              <span className="context-warn" title="太早的内容会被裁掉，模型看不到了">
                这段很长了
              </span>
            )}
            {draft.length > 600 && (
              <span className="draft-count" title="问题太长时模型容易抓不住重点">
                {draft.length} 字
              </span>
            )}
            <div className="tool-buttons" aria-label="增强能力">
              <button
                type="button"
                className={listening ? "listening" : ""}
                disabled={Boolean(requestId)}
                title={listening ? "在听，再点一下停。说完静两秒也会自己停" : "用说的"}
                aria-label={listening ? "停止听写" : "用说的"}
                data-tip={listening ? "停止听写" : "用说的"}
                aria-pressed={listening}
                onClick={async () => {
                  setSpeechNote(null);
                  if (listening) {
                    await window.kaiLocal.stopSpeech();
                    return;
                  }
                  draftBeforeSpeech.current = draft;
                  setListening(true);
                  // 输入框里已经写着英文的话，多半接下来也说英文。
                  // 猜错的代价只是这一句识别得差，比每次去设置里切省事。
                  const latin = (draft.match(/[A-Za-z]/g) || []).length;
                  const cjk = (draft.match(/[一-鿿]/g) || []).length;
                  const outcome = await window.kaiLocal.startSpeech({
                    locale: latin > 8 && latin > cjk * 2 ? "en-US" : "zh-CN",
                  });
                  if (!outcome.ok) {
                    setListening(false);
                    setSpeechNote(outcome.message || "开不了听写。");
                  }
                }}
              >
                {listening ? <span className="mic-pulse" aria-hidden /> : <Mic size={15} />}
              </button>
              <button
                type="button"
                className={attachment ? "active" : ""}
                disabled={imageBusy || Boolean(requestId) || initialState?.capabilities.vision !== true}
                title={initialState?.capabilities.vision === true ? "挑一张图" : "本机识图组件不可用"}
                aria-label="挑一张图"
                data-tip="挑一张图"
                onClick={chooseImage}
              >
                {imageBusy ? <LoaderCircle className="spin" size={15} /> : <ImagePlus size={15} />}
              </button>
              <button
                type="button"
                disabled={imageBusy || Boolean(requestId) || initialState?.capabilities.vision !== true}
                title="截一块屏幕。在别的应用里按 ⌃⌘K 也行"
                aria-label="截图"
                data-tip="截图"
                onClick={captureScreen}
              >
                <Crop size={15} />
              </button>
              <button
                type="button"
                className={documentAttachment ? "active" : ""}
                disabled={documentBusy || Boolean(requestId) || initialState?.capabilities.document !== true}
                title={initialState?.capabilities.document === true ? "选一份文档" : "本机读文档组件不可用"}
                aria-label="选一份文档"
                data-tip="选一份文档"
                onClick={chooseDocument}
              >
                {documentBusy ? <LoaderCircle className="spin" size={15} /> : <FileText size={15} />}
              </button>

              <span className="tool-divider" aria-hidden />

              <button
                type="button"
                className={!localOnly && webEnabled ? "active" : ""}
                disabled={Boolean(localOnly || requestId || preparingConversationId)}
                title={localOnly ? "仅本机模式下，主聊天不会联网搜索" : "自动联网。需要新信息时会搜索，并在回答里列出来源"}
                aria-label={localOnly ? "自动联网已暂停：仅本机模式" : "自动联网"}
                data-tip={localOnly ? "仅本机时暂停" : "自动联网"}
                aria-pressed={!localOnly && webEnabled}
                onClick={() => setWebEnabled((value) => !value)}
              >
                <Globe2 size={15} />
              </button>
              <button
                type="button"
                className={knowledgeEnabled ? "active" : ""}
                disabled={Boolean(requestId)}
                title={libraries.some((item) => item.enabled && item.indexedAt)
                  ? "翻我的资料"
                  : "还没建索引，点一下去加"}
                aria-label="翻我的资料"
                data-tip="翻我的资料"
                aria-pressed={knowledgeEnabled}
                onClick={() => {
                  if (!libraries.some((item) => item.enabled && item.indexedAt)) {
                    setKnowledgeOpen(true);
                    return;
                  }
                  setKnowledgeEnabled((value) => !value);
                }}
              >
                <Library size={15} />
              </button>
              <button
                type="button"
                className={memoryEnabled ? "active" : ""}
                disabled={false}
                title="用记忆"
                aria-label="用记忆"
                data-tip="用记忆"
                aria-pressed={memoryEnabled}
                onClick={openMemoryPanel}
              >
                <Brain size={15} />
              </button>
              {toolsEnabled && (
                <button
                  type="button"
                  className={missionMode ? "active" : ""}
                  disabled={Boolean(requestId)}
                  title="做完为止：先列计划再逐步做，中途失败自己换做法"
                  aria-label="做完为止"
                  data-tip="做完为止"
                  aria-pressed={missionMode}
                  onClick={() => setMissionMode((value) => !value)}
                >
                  <Target size={15} />
                </button>
              )}

              <span className="tool-divider" aria-hidden />

              <button
                type="button"
                disabled={Boolean(requestId)}
                title="比一比：同一个问题让两个模型一起答"
                aria-label="比一比"
                data-tip="比一比"
                onClick={() => {
                  if (!catalog.length) void window.kaiLocal.fetchModelCatalog().then(setCatalog).catch(() => {});
                  setCompareOpen(true);
                }}
              >
                <Columns2 size={15} />
              </button>
            </div>
          </div>
          {toolsEnabled && activeWorkspace && (
            <div className="agent-hint">
              工程模式开着：kaii 会真的去读 <b>{activeWorkspace.path}</b>
              {activeWorkspace.writable ? "，并且可以改文件、跑白名单命令。每一步都有记录，可以单独撤销。" : "，当前只读，不会改动任何文件。"}
              <button type="button" onClick={() => setWorkspaceOpen(true)}>管理</button>
            </div>
          )}
          {documentAttachments.length > 1 && (
            <small className="attachment-total">
              共 {documentAttachments.length} 份 · 合计 {documentAttachments.reduce((total, doc) => total + (doc.characters || 0), 0)} 字
              <button
                type="button"
                className="attachment-clear"
                onClick={() => {
                  for (const doc of [...documentAttachments]) removeDocumentAttachment(doc.id);
                }}
              >
                全部移除
              </button>
            </small>
          )}
          {documentAttachments.map((doc) => (
            <div className="attachment-chip document-chip" key={doc.id}>
              <span className="document-chip-icon"><FileText size={18} /></span>
              <button
                type="button"
                className="document-chip-body"
                title="点开看这份文档的结构，还能在里面搜"
                onClick={() => setPeekDocument(doc)}
              >
                <strong>{doc.name}{doc.sheetName ? `（${doc.sheetName}）` : ""}</strong>
                <small>
                  {doc.kind === "pdf" ? `${doc.pageCount} 页` : `${doc.characters} 字`}
                  {doc.truncated ? " · 已截断" : ""}
                  {doc.reused ? " · 直接用了上次的解析" : " · 在本机读的"}
                  {documentAttachments.length > 1 ? ` · 共 ${documentAttachments.length} 份一起问` : ""}
                </small>
              </button>
              <button
                type="button"
                aria-label={`移除${doc.name}`}
                onClick={() => removeDocumentAttachment(doc.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {attachment && (
            <div className="attachment-chip">
              <img src={attachment.previewDataUrl} alt="" />
              <span>
                <strong>{attachment.name}</strong>
                <small>
                  {attachment.width && attachment.height ? `${attachment.width}×${attachment.height} · ` : ""}
                  {attachment.ocrPreview || attachment.labelPreview || "读好了"}
                </small>
              </span>
              <button type="button" aria-label="移除图片" onClick={discardAttachment}><X size={14} /></button>
            </div>
          )}
          {pageHints.length > 0 && (
            <div className="mention-menu" role="listbox" aria-label="存下来的网页">
              {pageHints.map((page) => (
                <button
                  type="button"
                  role="option"
                  key={page.id}
                  onClick={() => void applyPageHint(page)}
                >
                  <b>@</b>
                  <span>{page.title}</span>
                  <small>{page.characters} 字</small>
                </button>
              ))}
            </div>
          )}
          {fileHints.length > 0 && (
            <div className="mention-menu" role="listbox" aria-label="工作区文件">
              {fileHints.map((file, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === fileHintIndex}
                  className={index === fileHintIndex ? "selected" : ""}
                  key={file.path}
                  onMouseEnter={() => setFileHintIndex(index)}
                  onClick={() => applyFileHint(file.path)}
                >
                  {file.path}
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            {(instantHit || cleanable || (jsonPretty && jsonPretty !== draft.trim())) && (
              <div className="instant-bar">
                {instantHit && (
                  <button
                    type="button"
                    title={instantHit.kind === "random" ? "本机生成，没经过任何模型；点一下填进输入框" : "本机算的，没经过模型；点一下填进输入框"}
                    onClick={() => {
                      setDraft(instantHit.answer);
                      requestAnimationFrame(() => composer.current?.focus());
                    }}
                  >
                    <Zap size={11} /> {instantHit.answer}
                  </button>
                )}
                {instantHit?.kind === "random" && (
                  <button type="button" title="不满意就再摇一个" onClick={() => setDraft((current) => `${current} `)}>
                    换一个
                  </button>
                )}
                {cleanable && (
                  <button type="button" title="去掉多余空行、行尾空白，全角字母数字转半角" onClick={() => setDraft(cleanable)}>
                    清理文本
                  </button>
                )}
                {jsonPretty && jsonPretty !== draft.trim() && (
                  <button type="button" title="排成两格缩进的 JSON" onClick={() => setDraft(jsonPretty)}>
                    格式化 JSON
                  </button>
                )}
              </div>
            )}
            {draft.length > 300 && (
              <div className="draft-count" title={`粗估 ${Math.round(draft.length / 1.6)} token（按中文 1.6 字/token 估，只是量级）`}>{draft.length} 字</div>
            )}
            {slashHits.length > 0 && (
              <div className="slash-hints">
                {slashHits.map((item, index) => (
                  <button type="button" key={item.id} onClick={() => {
                    setDraft(item.body);
                    requestAnimationFrame(() => composer.current?.focus());
                  }}>
                    {index === 0 ? <b>Tab</b> : null} /{item.label}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={composer}
              disabled={bootPhase !== "ready"}
              className={tallComposer ? "tall" : ""}
              value={draft}
              rows={1}
              placeholder={browsingWithoutModel ? "可以先写下问题，接入模型后发送……" : usingCloud || modelState.status === "ready"
                ? (toolsEnabled && activeWorkspace ? "说点什么…… 用 @ 点名文件" : "说点什么……")
                : "输入问题，发送时会启动模型……"}
              onChange={(event) => {
                historyBack.current = 0;
                setDraft(event.target.value);
              }}
              onPaste={async (event) => {
                // 剪贴板里是图片的话直接收下。截了图不存文件、
                // 从聊天软件里复制一张图——这两种情况手上根本没有"文件"。
                const hasImage = [...event.clipboardData.items].some((item) => item.type.startsWith("image/"));
                if (hasImage && !imageBusy && !requestId) {
                  event.preventDefault();
                  setImageBusy(true);
                  try {
                    const outcome = await window.kaiLocal.imageFromClipboard();
                    if (outcome.ok && outcome.attachment) {
                      const previous = attachment;
                      setAttachment(outcome.attachment);
                      if (previous) void window.kaiLocal.discardImage(previous.id).catch(() => {});
                    } else if (outcome.message) {
                      setBootError(outcome.message);
                    }
                  } finally {
                    setImageBusy(false);
                  }
                  return;
                }

                // 粘一大段文字进来时收成附件。几千字堆在输入框里，
                // 既看不清自己要问什么，也没法翻回去看粘了什么。
                const text = event.clipboardData.getData("text/plain");
                if (text.length < PASTE_AS_DOCUMENT_CHARACTERS || documentBusy || requestId) return;
                event.preventDefault();
                setDocumentBusy(true);
                try {
                  const firstLine = text.trim().split("\n")[0].slice(0, 24) || "粘贴的内容";
                  const outcome = await window.kaiLocal.documentFromText({ text, name: firstLine });
                  if (!outcome.ok || !outcome.attachment) {
                    // 收不下就照常粘进去，别把用户的内容弄丢。
                    setDraft((current) => current + text);
                    return;
                  }
                  addDocumentAttachment(outcome.attachment);
                } finally {
                  setDocumentBusy(false);
                }
              }}
              onKeyDown={(event) => {
                // ⌘B 加粗、⌘E 变行内代码：包住选中的那段。
                // 没选中就插一对记号并把光标放中间，接着打字就在里面。
                if ((event.metaKey || event.ctrlKey) && !event.shiftKey && /^[be]$/i.test(event.key)) {
                  event.preventDefault();
                  const node = event.currentTarget;
                  const mark = event.key.toLowerCase() === "b" ? "**" : "`";
                  const start = node.selectionStart ?? 0;
                  const end = node.selectionEnd ?? 0;
                  const picked = draft.slice(start, end);
                  const next = `${draft.slice(0, start)}${mark}${picked}${mark}${draft.slice(end)}`;
                  setDraft(next);
                  requestAnimationFrame(() => {
                    node.focus();
                    const caret = start + mark.length + picked.length;
                    node.setSelectionRange(picked ? caret + mark.length : caret, picked ? caret + mark.length : caret);
                  });
                  return;
                }
                // Esc 连按两下清空输入框（单击保留原行为，不误伤）
                if (event.key === "Escape") {
                  const now = Date.now();
                  if (draft && now - lastEscAt.current < 450) {
                    setDraft("");
                    lastEscAt.current = 0;
                    return;
                  }
                  lastEscAt.current = now;
                }
                // ⌘⇧V：把剪贴板文字直接发出去，一步到位
                if (event.key.toLowerCase() === "v" && event.metaKey && event.shiftKey) {
                  event.preventDefault();
                  void navigator.clipboard.readText().then((text) => {
                    if (text.trim() && !requestId) void send(text.trim());
                  }).catch(() => setBootError("读不到剪贴板。"));
                  return;
                }
                // 斜杠短语：Tab 展开第一条命中的常用语
                if (event.key === "Tab" && slashHits.length > 0) {
                  event.preventDefault();
                  setDraft(slashHits[0].body);
                  return;
                }
                if (fileHints.length > 0) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setFileHintIndex((value) => (value + 1) % fileHints.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setFileHintIndex((value) => (value - 1 + fileHints.length) % fileHints.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setFileHints([]);
                    return;
                  }
                  if ((event.key === "Tab" || event.key === "Enter") && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    applyFileHint(fileHints[fileHintIndex].path);
                    return;
                  }
                }
                // 空输入框里用 ↑/↓ 翻之前问过的话。
                if (event.key === "ArrowUp" && !draft && !requestId) {
                  const asked = (activeConversation?.messages || [])
                    .filter((item) => item.role === "user" && item.content.trim());
                  const previous = asked.at(-1 - historyBack.current);
                  if (previous) {
                    event.preventDefault();
                    historyBack.current += 1;
                    setDraft(previous.content);
                    return;
                  }
                }
                if (event.key === "ArrowDown" && historyBack.current > 0) {
                  event.preventDefault();
                  historyBack.current -= 1;
                  const asked = (activeConversation?.messages || [])
                    .filter((item) => item.role === "user" && item.content.trim());
                  setDraft(historyBack.current === 0 ? "" : (asked.at(-historyBack.current)?.content ?? ""));
                  return;
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {requestId ? (
              <button className="send-button stop" type="button" aria-label="停止生成" onClick={stopGeneration}><CircleStop size={18} /></button>
            ) : preparingConversationId ? (
              <button className="send-button" type="button" aria-label="正在准备" disabled><LoaderCircle className="spin" size={18} /></button>
            ) : (
              <button
                className={sendHolding ? "send-button hold" : "send-button"}
                type="button"
                aria-label="发送"
                title={localOnly ? "发送（仅本机模式不会联网）" : webEnabled ? "发送。长按＝这一条不联网发" : "发送。长按＝这一条联网发"}
                disabled={bootPhase !== "ready" || (!draft.trim() && !attachment && !documentAttachment)}
                onPointerDown={() => {
                  if (localOnly) return;
                  sendHoldTimer.current = window.setTimeout(() => {
                    sendHoldArmed.current = true;
                    setSendHolding(true);
                  }, 500);
                }}
                onPointerLeave={() => {
                  if (sendHoldTimer.current) window.clearTimeout(sendHoldTimer.current);
                  sendHoldArmed.current = false;
                  setSendHolding(false);
                }}
                onClick={() => {
                  if (sendHoldTimer.current) window.clearTimeout(sendHoldTimer.current);
                  if (!localOnly && sendHoldArmed.current) {
                    sendWebOnce.current = !webEnabled;
                    sendHoldArmed.current = false;
                    setSendHolding(false);
                  }
                  void send();
                }}
              ><ArrowUp size={18} /></button>
            )}
          </div>
        </section>
        )}
      </main>

      {taskWorkbenchOpen && (
        <div
          className="modal-backdrop task-workbench-backdrop"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (privacyApproval) resolvePrivacyApproval(false);
            setTaskWorkbenchOpen(false);
          }}
        >
          <div className="task-workbench-dialog" role="dialog" aria-modal="true" aria-label="任务与结果">
            <TaskWorkbench
              activeEntry={taskEntry}
              tasks={taskWorkbenchTasks}
              results={taskWorkbenchResults}
              privacyPreview={privacyApproval ? {
                destination: privacyApproval.destination,
                summary: privacyApproval.attachmentLabels.some((item) => item.startsWith("文档：") || item.startsWith("图片："))
                  ? "下面只预览这次会发给云端的对话和项目文字。历史消息也已算入，其中的凭据会先替换成占位符；附件正文不在这份逐字预览中。"
                  : "下面是这次会发给云端的对话和项目文字。历史消息也已算入；凭据会先替换成占位符。",
                items: [
                  `${privacyApproval.messageCount} 段对话正文`,
                  ...privacyApproval.attachmentLabels,
                  ...(privacyApproval.preview.findings.length
                    ? [`识别并脱敏 ${privacyApproval.preview.findings.length} 处敏感内容`]
                    : ["未识别到密钥、证件号或常见个人信息"]),
                ],
                payloadPreview: privacyApproval.preview.redactedText,
                warning: privacyApproval.attachmentLabels.some((item) => item.startsWith("文档：") || item.startsWith("图片："))
                  ? "附件内容会在本机读取后加入模型上下文，但附件正文尚未在这里逐字预览，也未经过上方的密钥和个人信息扫描。请根据附件名称和规模决定是否继续。"
                  : privacyApproval.preview.findings.some((item) => item.category === "secret")
                    ? "密钥类内容即使确认发送，也只会发送脱敏占位符。"
                    : undefined,
              } : null}
              onEntryChange={startWorkbenchEntry}
              onAction={(action, result) => { void handleTaskWorkbenchAction(action, result); }}
              onPrivacyConfirm={() => {
                resolvePrivacyApproval(true);
                setTaskWorkbenchOpen(false);
              }}
              onPrivacyCancel={() => {
                resolvePrivacyApproval(false);
                setTaskWorkbenchOpen(false);
              }}
              onClose={() => {
                if (privacyApproval) resolvePrivacyApproval(false);
                setTaskWorkbenchOpen(false);
              }}
            />
          </div>
        </div>
      )}

      {peekDocument && (
        <DocumentPeek
          attachment={peekDocument}
          onClose={() => setPeekDocument(null)}
          onFocusSection={async (label) => {
            const outcome = await window.kaiLocal.sliceDocumentSection(peekDocument.id, label);
            if (!outcome.ok || !outcome.attachment) {
              setBootError(outcome.message || "这段没切出来");
              return;
            }
            // 换成只含这一段的派生记录，原来那份整体的还在盘上（想换回去重新挂就行）。
            setDocumentAttachments((current) => current.map((item) => (
              item.id === peekDocument.id ? outcome.attachment! : item
            )));
            setPeekDocument(null);
            requestAnimationFrame(() => composer.current?.focus());
          }}
          onPickSheet={async (sheetName) => {
            const outcome = await window.kaiLocal.pickDocumentSheet(peekDocument.id, sheetName);
            if (!outcome.ok || !outcome.attachment) {
              setBootError(outcome.message || "这张工作表没读出来");
              return;
            }
            // 换成只含这张工作表的那份，原来的整份记录留着（可能还要换回来）。
            setDocumentAttachments((current) => current.map((item) => (
              item.id === peekDocument.id ? outcome.attachment! : item
            )));
            setPeekDocument(outcome.attachment);
          }}
        />
      )}

      {trashOpen && (
        <TrashPanel
          conversations={conversations}
          onClose={() => setTrashOpen(false)}
          onRestore={restoreChat}
          onPurge={purgeChat}
        />
      )}

      {auditOpen && (
        <AuditPanel
          onClose={() => setAuditOpen(false)}
          onResume={resumeRunById}
          busy={Boolean(requestId || preparingConversationId)}
        />
      )}

      {reviewOpen && (
        <ReviewPanel
          conversations={conversations}
          onClose={() => setReviewOpen(false)}
          onSummarize={async (topics) => {
            const outcome = await window.kaiLocal.summarizeReview(topics);
            if (!outcome.ok || !outcome.text) throw new Error(outcome.message || "没总结出来");
            return outcome.text;
          }}
        />
      )}

      {zoomedImage && (
        <div className="image-lightbox" onClick={() => setZoomedImage(null)} role="dialog" aria-label={zoomedImage.name}>
          <img src={zoomedImage.src} alt={zoomedImage.name} />
          <span>点一下关掉</span>
        </div>
      )}

      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}

      {starredOpen && (
        <StarredPanel
          conversations={conversations}
          onClose={() => setStarredOpen(false)}
          onJump={(conversationId, messageId) => {
            setStarredOpen(false);
            setActiveId(conversationId);
            requestAnimationFrame(() => {
              document.getElementById(`msg-${messageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
            });
          }}
          onUnstar={(conversationId, messageId) => updateConversation(conversationId, (conversation) => ({
            ...conversation,
            messages: conversation.messages.map((item) => (
              item.id === messageId ? { ...item, starred: false } : item
            )),
          }))}
        />
      )}

      {readLaterOpen && (
        <ReadLaterPanel
          pages={savedPages}
          onClose={() => setReadLaterOpen(false)}
          onChange={setSavedPages}
          onAttach={async (page) => {
            setReadLaterOpen(false);
            setDocumentBusy(true);
            try {
              const outcome = await window.kaiLocal.attachSavedPage(page.id);
              if (!outcome.ok || !outcome.attachment) {
                setBootError(outcome.message || "这一篇读不出来");
                return;
              }
              addDocumentAttachment(outcome.attachment);
              requestAnimationFrame(() => composer.current?.focus());
            } finally {
              setDocumentBusy(false);
            }
          }}
        />
      )}

      {compareOpen && (
        <ComparePanel
          catalog={catalog}
          initialQuestion={draft}
          onClose={() => setCompareOpen(false)}
          onKeep={(question, answer, label) => {
            setCompareOpen(false);
            if (!activeConversation) return;
            const now = Date.now();
            // 把问题和选中的那个回答一起放进对话，并注明是谁答的——
            // 过两天回头看，得知道这段是比出来的、来自哪个模型。
            updateConversation(activeConversation.id, (conversation) => ({
              ...conversation,
              updatedAt: now,
              messages: [
                ...conversation.messages,
                { id: crypto.randomUUID(), role: "user", content: question, createdAt: now },
                { id: crypto.randomUUID(), role: "assistant", content: answer, createdAt: now + 1, modelLabel: label },
              ],
            }));
            setDraft("");
          }}
        />
      )}

      {paletteOpen && <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />}

      {scheduleOpen && (
        <SchedulePanel
          schedules={schedules}
          onClose={() => setScheduleOpen(false)}
          onChange={setSchedules}
          modelChoices={[
            { provider: "local", model: "", label: "本机 Qwen3-8B" },
            ...catalog.flatMap((section) => section.items
              .filter((item) => item.configured && item.provider !== "local")
              .map((item) => ({ provider: item.provider, model: item.model, label: item.label }))),
          ]}
          onResultToChat={(schedule, resultText) => {
            // 把这次结果变成一段新对话，带着上下文接着问。
            setScheduleOpen(false);
            const now = Date.now();
            const conversation = newConversation();
            conversation.title = `${schedule.label} · ${new Date(now).toLocaleDateString("zh-CN")}`;
            conversation.messages = [
              { id: randomId("msg"), role: "user", content: schedule.prompt, createdAt: now },
              { id: randomId("msg"), role: "assistant", content: resultText, createdAt: now + 1 },
            ];
            setConversations((current) => [conversation, ...current]);
            setActiveId(conversation.id);
            requestAnimationFrame(() => composer.current?.focus());
          }}
        />
      )}

      {batchOpen && <BatchPanel actions={quickActions} onClose={() => setBatchOpen(false)} />}

      {knowledgeOpen && (
        <KnowledgePanel
          libraries={libraries}
          onClose={() => setKnowledgeOpen(false)}
          onAdd={async () => {
            const added = await window.kaiLocal.addKnowledge();
            if (added) setLibraries(added.libraries);
          }}
          onLibrariesChange={setLibraries}
          onRemove={async (id) => setLibraries(await window.kaiLocal.removeKnowledge(id))}
          onToggle={async (id, enabled) => setLibraries(await window.kaiLocal.toggleKnowledge(id, enabled))}
          onIndex={async (id) => {
            const result = await window.kaiLocal.indexKnowledge(id);
            setLibraries(result.libraries);
          }}
        />
      )}

      {projectPanelOpen && (
        <ProjectPanel
          projects={projects}
          counts={projectCounts}
          onClose={() => setProjectPanelOpen(false)}
          onCreate={(name) => {
            const project = createProject(name);
            setProjects((current) => [project, ...current]);
            // 建完就把当前这段对话放进去，省一步手动归档。
            if (activeConversation && !activeConversation.projectId) moveConversation(activeConversation.id, project.id);
          }}
          onRename={(id, name) => setProjects((current) => current.map((project) => (
            project.id === id ? { ...project, name: normalizeProjectName(name) || project.name, updatedAt: Date.now() } : project
          )))}
          onDefaultModel={(id, provider, model) => {
            setProjects((current) => current.map((item) => (
              item.id === id
                ? { ...item, defaultProvider: provider || undefined, defaultModel: model || undefined, updatedAt: Date.now() }
                : item
            )));
          }}
          modelChoices={[
            { provider: "local", model: "", label: "本机 Qwen3-8B" },
            ...catalog.flatMap((section) => section.items
              .filter((item) => item.configured && item.provider !== "local")
              .map((item) => ({ provider: item.provider, model: item.model, label: item.label }))),
          ]}
          onInstructions={(id, instructions) => setProjects((current) => current.map((project) => (
            project.id === id ? { ...project, instructions, updatedAt: Date.now() } : project
          )))}
          onAddDocument={async (id) => {
            const added = await window.kaiLocal.chooseAndReadDocument();
            if (!added) return;
            setProjects((current) => current.map((project) => (
              project.id === id
                ? {
                    ...project,
                    documents: [...project.documents, {
                      id: added.id,
                      name: added.name,
                      kind: added.kind,
                      pageCount: added.pageCount,
                      characters: added.characters,
                    }].slice(0, 8),
                    updatedAt: Date.now(),
                  }
                : project
            )));
          }}
          onRemoveDocument={(id, documentId) => {
            void window.kaiLocal.discardDocument(documentId).catch(() => {});
            setProjects((current) => current.map((project) => (
              project.id === id
                ? { ...project, documents: project.documents.filter((item) => item.id !== documentId), updatedAt: Date.now() }
                : project
            )));
          }}
          onDelete={(id) => {
            setProjects((current) => current.filter((project) => project.id !== id));
            // 项目没了，里面的对话变成未分组，不跟着删。
            setConversations((current) => current.map((conversation) => (
              conversation.projectId === id ? { ...conversation, projectId: undefined } : conversation
            )));
          }}
        />
      )}

      {openArtifact && <ArtifactPanel artifact={openArtifact} onClose={() => setOpenArtifact(null)} />}

      {openCanvas && (
        <CanvasPanel
          title={openCanvas.title}
          initialText={openCanvas.text}
          onClose={() => setOpenCanvas(null)}
        />
      )}

      {memoryOpen && (
        <MemoryPanel
          entries={memories}
          enabled={memoryEnabled}
          onEnabledChange={setMemoryEnabled}
          onClose={() => setMemoryOpen(false)}
          onCreate={async (payload) => {
            await window.kaiLocal.createMemory(payload);
            setMemories(await window.kaiLocal.listMemories(true));
          }}
          onUpdate={async (id, patch) => {
            await window.kaiLocal.updateMemory(id, patch);
            setMemories(await window.kaiLocal.listMemories(true));
          }}
          onArchive={async (id, archived) => {
            await window.kaiLocal.archiveMemory(id, archived);
            setMemories(await window.kaiLocal.listMemories(true));
          }}
        />
      )}

      {workspaceOpen && (
        <WorkspacePanel
          state={workspaces}
          allowedCommands={allowedCommands}
          onStateChange={(next) => {
            setWorkspaces(next);
            if (!next.activeId) setToolsEnabled(false);
          }}
          onClose={() => setWorkspaceOpen(false)}
        />
      )}

      {browsingWithoutModel && (
        <aside className="browse-model-notice" aria-label="模型设置提示">
          <span>先看看界面，接入模型后就能提问。</span>
          <button type="button" onClick={() => setWelcomeOpen(true)}>接入模型</button>
        </aside>
      )}

      {settingsOpen && settings && (
        <SettingsPanel
          settings={settings}
          skills={skills}
          modelState={modelState}
          searchProviders={searchProviders}
          quickHotkeys={initialState?.quickHotkeys || []}
          quickHotkeyState={quickHotkeyState}
          trayState={trayState}
          providerList={providerList}
          setProviderList={setProviderList}
          onBackup={() => buildBackup(conversations, projects, prompts)}
          onRestoreBackup={restoreFromBackup}
          onImportConversations={importConversations}
          onSkillsChange={setSkills}
          onExportAll={exportAllConversations}
          onSweep={async () => {
            const imageIds = conversations.flatMap((c) => c.messages.flatMap((m) => (m.attachment ? [m.attachment.id] : [])));
            const conversationDocumentIds = conversations.flatMap((c) => c.messages.flatMap((m) => (m.document ? [m.document.id] : [])));
            const projectDocumentIds = projects.flatMap((project) => project.documents.map((document) => document.id));
            const documentIds = [...new Set([...conversationDocumentIds, ...projectDocumentIds])];
            const result = await window.kaiLocal.sweepStorage({ imageIds, documentIds });
            const total = result.images + result.documents + result.temp;
            setStorageWarning(total
              ? `清掉了 ${result.images} 张图、${result.documents} 份文档、${result.temp} 个临时文件。`
              : "没有可清的，本来就很干净。");
          }}
          onRestore={(text) => { void restoreFromBackup(text); }}
          onExport={() => exportConversations(conversations)}
          onClose={() => setSettingsOpen(false)}
          onSave={async (patch) => {
            const result = await window.kaiLocal.updateSettings(patch);
            setSettings(result.settings);
            setSkills(result.skills);
            if (result.quickHotkeyState) setQuickHotkeyState(result.quickHotkeyState);
            document.documentElement.dataset.theme = result.settings.theme;
          }}
        />
      )}
    </div>
  );
}


function MemoryPanel({
  entries,
  enabled,
  onEnabledChange,
  onClose,
  onCreate,
  onUpdate,
  onArchive,
}: {
  entries: MemoryEntry[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
  onCreate: (payload: { content: string; kind: MemoryEntry["kind"]; pinned: boolean }) => Promise<void>;
  onUpdate: (id: string, patch: { content: string; kind: MemoryEntry["kind"]; pinned: boolean }) => Promise<void>;
  onArchive: (id: string, archived: boolean) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryEntry["kind"]>("note");
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const resetEditor = () => {
    setEditingId(null);
    setContent("");
    setKind("note");
    setPinned(false);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="memory-panel" role="dialog" aria-modal="true" aria-label="kaii-agent 记忆库">
        <header>
          <div><h2>记忆</h2></div>
          <button className="icon-button" type="button" aria-label="关闭记忆库" onClick={onClose}><X size={18} /></button>
        </header>
        <label className="memory-toggle">
          <span><strong>回答时使用记忆</strong><small>只读取你在这里明确保存的内容</small></span>
          <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        </label>
        <div className="memory-compose">
          <textarea value={content} maxLength={4000} placeholder="例如：我偏好简洁直接的回答。" onChange={(event) => setContent(event.target.value)} />
          <div>
            <select value={kind} onChange={(event) => setKind(event.target.value as MemoryEntry["kind"])}>
              <option value="note">笔记</option>
              <option value="preference">偏好</option>
              <option value="project">项目</option>
              <option value="fact">事实</option>
            </select>
            <label><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> 置顶</label>
            <button type="button" disabled={busy || !content.trim()} onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (editingId) await onUpdate(editingId, { content: content.trim(), kind, pinned });
                else await onCreate({ content: content.trim(), kind, pinned });
                resetEditor();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : "这条记忆没有保存");
              } finally {
                setBusy(false);
              }
            }}>{busy ? "保存中" : editingId ? "保存修改" : "记住"}</button>
            {editingId && <button type="button" disabled={busy} onClick={resetEditor}>取消修改</button>}
          </div>
        </div>
        {error && <p className="memory-error" role="alert">{error}</p>}
        <div className="memory-list">
          {entries.length ? entries.map((entry) => (
            <article key={entry.id}>
              <span>{entry.kind === "preference" ? "偏好" : entry.kind === "project" ? "项目" : entry.kind === "fact" ? "事实" : "笔记"}{entry.pinned ? " · 置顶" : ""}{entry.archived ? " · 已移出" : ""}</span>
              <p>{entry.content}</p>
              <small className="memory-provenance">
                来源：{entry.source?.kind === "conversation" ? "对话" : entry.source?.kind === "capsule" ? "核验任务" : "手动记录"}
                {entry.scope?.kind === "project" ? " · 项目内" : entry.scope?.kind === "conversation" ? " · 本段对话" : " · 全局"}
                {entry.status === "superseded" ? " · 已被替代" : entry.status === "disputed" ? " · 有争议" : " · 有效"}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </small>
              {entry.archived ? (
                <button type="button" disabled={busy} onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await onArchive(entry.id, false);
                  } catch (caught) {
                    setError(caught instanceof Error ? caught.message : "这条记忆没有恢复");
                  } finally {
                    setBusy(false);
                  }
                }}>恢复到记忆</button>
              ) : (
                <div style={{ position: "absolute", top: 15, right: 7, display: "flex", gap: 8 }}>
                  <button type="button" style={{ position: "static" }} disabled={busy} onClick={() => {
                    setEditingId(entry.id);
                    setContent(entry.content);
                    setKind(entry.kind);
                    setPinned(entry.pinned);
                  }}>编辑</button>
                  <button type="button" style={{ position: "static" }} disabled={busy} onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await onArchive(entry.id, true);
                      if (editingId === entry.id) resetEditor();
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : "这条记忆没有移出");
                    } finally {
                      setBusy(false);
                    }
                  }}><Trash2 size={13} /> 移出记忆</button>
                </div>
              )}
            </article>
          )) : <div className="memory-empty">还没有保存任何记忆。</div>}
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({
  settings,
  skills,
  modelState,
  searchProviders,
  onRestoreBackup,
  onImportConversations,
  onSkillsChange,
  onExportAll,
  quickHotkeys,
  quickHotkeyState,
  trayState,
  providerList,
  setProviderList,
  onBackup,
  onSweep,
  onRestore,
  onExport,
  onClose,
  onSave,
}: {
  settings: AppSettings;
  skills: SkillInfo[];
  modelState: ModelState;
  searchProviders: SearchProviderInfo[];
  quickHotkeys: QuickHotkeyInfo[];
  quickHotkeyState: QuickHotkeyState | null;
  trayState: TrayState | null;
  providerList: ProviderInfo[];
  setProviderList: (providers: ProviderInfo[]) => void;
  onBackup: () => string;
  onSweep: () => Promise<void>;
  onRestore: (text: string) => void;
  onExport: () => string;
  onClose: () => void;
  onSave: (patch: Partial<AppSettings>) => Promise<void>;
  onRestoreBackup: (content: string) => Promise<{ conversations: number; projects: number; prompts: number } | null>;
  onImportConversations: (incoming: Conversation[]) => ChatGptImportOutcome;
  onSkillsChange: (skills: SkillInfo[]) => void;
  onExportAll: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [lockEnabled, setLockEnabled] = useState(false);
  const [usage, setUsage] = useState<{ total: number; items: { name: string; bytes: number }[] } | null>(null);
  const [autoBackups, setAutoBackups] = useState<{ name: string; savedAt: number; bytes: number; ok: boolean }[]>([]);
  const [appInfo, setAppInfo] = useState<{ version: string; electron: string } | null>(null);
  const [usageSummary, setUsageSummary] = useState<{ today: Record<string, number>; week: Record<string, number> } | null>(null);
  const [dataDir, setDataDir] = useState("");
  // 技能自管理：新建/查看/删除都在这儿，不用再去文件夹里放 .md。
  const [skillDraft, setSkillDraft] = useState<{ name: string; description: string; body: string } | null>(null);
  const [errorLog, setErrorLog] = useState<{ at: number; text: string }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("kaii.errorlog.v1") || "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    void window.kaiLocal.lockStatus().then((status) => setLockEnabled(status.enabled)).catch(() => {});
    void window.kaiLocal.storageUsage().then(setUsage).catch(() => {});
    void window.kaiLocal.listAutoBackups().then(setAutoBackups).catch(() => {});
    void window.kaiLocal.appInfo().then(setAppInfo).catch(() => {});
    void window.kaiLocal.usageSummary().then(setUsageSummary).catch(() => {});
    void window.kaiLocal.dataDirectory().then(setDataDir).catch(() => {});
  }, []);
  // 系统里有哪些声音，开一次面板问一次就够，它不会中途变。
  const [voices, setVoices] = useState<{ name: string; locale: string }[]>([]);
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string; fix: string }[]>([]);
  const [modelLogs, setModelLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const onDiagnose = async () => {
    const result = await window.kaiLocal.runDiagnose();
    setChecks(result.checks);
  };
  useEffect(() => { void window.kaiLocal.listVoices().then(setVoices).catch(() => {}); }, []);
  const [saving, setSaving] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedProvider = searchProviders.find((provider) => provider.id === draft.searchProvider);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = async (kind: "serverBinary" | "modelPath" | "skillDirectory") => {
    const selected = await window.kaiLocal.chooseFile(kind);
    if (selected) setDraft((current) => ({ ...current, [kind]: selected }));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="kaii-agent 设置">
        <header>
          <div><h2>设置</h2></div>
          <button className="icon-button" type="button" aria-label="关闭设置" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="settings-status">
          <Cpu size={20} />
          <div>
            <strong>{modelLabel(modelState)}</strong>
            <span>{modelState.detail}</span>
          </div>
        </div>

        <div className="settings-model-extra">
          <div className="settings-section-title">模型杂项</div>
          <div className="settings-actions">
            <button
              type="button"
              onClick={async () => {
                // 一键重启：模型偶尔会答着答着变慢（KV 缓存碎了），
                // 重启比排查快。
                await window.kaiLocal.stopModel();
                await window.kaiLocal.startModel().catch(() => {});
              }}
            >
              重启本机模型
            </button>
            <button
              type="button"
              onClick={() => {
                // 各家上新模型不会通知我们，手动刷一次清单。
                void window.kaiLocal.fetchModelCatalog().then(() => {
                  setDraft((current) => ({ ...current }));
                });
              }}
            >
              刷新云端模型清单
            </button>
            <select
              value={String(draft.scheduleGraceMinutes ?? 5)}
              aria-label="定时任务补跑窗口"
              onChange={(event) => setDraft({ ...draft, scheduleGraceMinutes: Number(event.target.value) })}
            >
              <option value="5">补跑窗口：5 分钟</option>
              <option value="30">补跑窗口：30 分钟</option>
              <option value="120">补跑窗口：2 小时</option>
            </select>
            <select
              value={String(draft.chatTimeoutMinutes ?? 0)}
              aria-label="单次回答最多等多久"
              onChange={(event) => setDraft({ ...draft, chatTimeoutMinutes: Number(event.target.value) })}
            >
              <option value="0">超时：默认（10 分钟）</option>
              <option value="3">超时：3 分钟</option>
              <option value="20">超时：20 分钟</option>
              <option value="45">超时：45 分钟</option>
            </select>
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={Boolean(draft.cloudReceipt)}
              onChange={(event) => setDraft({ ...draft, cloudReceipt: event.target.checked })}
            />
            显示模型用量
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              defaultChecked={localStorage.getItem("kaii.dingdone.v1") === "1"}
              onChange={(event) => {
                if (event.target.checked) localStorage.setItem("kaii.dingdone.v1", "1");
                else localStorage.removeItem("kaii.dingdone.v1");
              }}
            />
            后台回答完成提示音
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              defaultChecked={localStorage.getItem("kaii.calm.v1") === "1"}
              onChange={(event) => {
                if (event.target.checked) {
                  localStorage.setItem("kaii.calm.v1", "1");
                  document.documentElement.dataset.calm = "1";
                } else {
                  localStorage.removeItem("kaii.calm.v1");
                  delete document.documentElement.dataset.calm;
                }
              }}
            />
            减少动画
          </label>
          {usageSummary && Object.keys(usageSummary.week).length > 0 && (
            <small>
              近七天用了：
              {Object.entries(usageSummary.week)
                .sort((a, b) => b[1] - a[1])
                .map(([provider, count]) => `${provider === "local" ? "本机" : provider} ${count} 次`)
                .join(" · ")}
            </small>
          )}
        </div>

        <div className="settings-diagnose">
          <div className="settings-section-title">外观</div>
          <div className="settings-actions">
            <select
              defaultValue={document.documentElement.dataset.fontscale || "normal"}
              aria-label="正文字号"
              onChange={(event) => {
                const value = event.target.value;
                if (value === "normal") {
                  delete document.documentElement.dataset.fontscale;
                  localStorage.removeItem("kaii.fontscale.v1");
                } else {
                  document.documentElement.dataset.fontscale = value;
                  localStorage.setItem("kaii.fontscale.v1", value);
                }
              }}
            >
              <option value="small">字号：小</option>
              <option value="normal">字号：标准</option>
              <option value="big">字号：大</option>
            </select>
            <select
              defaultValue={document.documentElement.dataset.density || "cozy"}
              aria-label="排版密度"
              onChange={(event) => {
                const value = event.target.value;
                if (value === "cozy") {
                  delete document.documentElement.dataset.density;
                  localStorage.removeItem("kaii.density.v1");
                } else {
                  document.documentElement.dataset.density = value;
                  localStorage.setItem("kaii.density.v1", value);
                }
              }}
            >
              <option value="cozy">密度：宽松</option>
              <option value="compact">密度：紧凑</option>
            </select>
          </div>
          <div className="settings-actions">
            <button
              type="button"
              title="字号、密度、动画、侧栏宽度、分组折叠全部回默认"
              onClick={() => {
                for (const key of ["kaii.fontscale.v1", "kaii.density.v1", "kaii.calm.v1", "kaii.sidebarWidth.v1", "kaii.collapsedGroups.v1"]) {
                  localStorage.removeItem(key);
                }
                delete document.documentElement.dataset.fontscale;
                delete document.documentElement.dataset.density;
                delete document.documentElement.dataset.calm;
                window.alert("外观已回默认。侧栏宽度和分组折叠重开应用后生效。");
              }}
            >
              外观全部回默认
            </button>
          </div>
        </div>

        <div className="settings-diagnose">
          <div className="settings-section-title">应用锁</div>
          <div className="settings-actions">
            {lockEnabled ? (
              <button
                type="button"
                onClick={() => {
                  const code = window.prompt("输入现在的锁码来关掉应用锁：", "");
                  if (code === null) return;
                  void window.kaiLocal.clearLock(code).then((outcome) => {
                    if (outcome.ok) setLockEnabled(false);
                    else window.alert(outcome.message || "锁没关掉。");
                  });
                }}
              >
                关掉应用锁
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  const code = window.prompt("设一个 4-8 位数字锁码（开屏时要输）：", "");
                  if (code === null || !code.trim()) return;
                  void window.kaiLocal.setLock(code.trim()).then((outcome) => {
                    if (outcome.ok) setLockEnabled(true);
                    else window.alert(outcome.message || "锁没设上。");
                  });
                }}
              >
                设一个开屏锁码
              </button>
            )}
          </div>
        </div>

        <div className="settings-diagnose">
          <div className="settings-section-title">存储与备份</div>
          {usage && (
            <small>
              本机数据 {(usage.total / 1024 / 1024).toFixed(1)} MB
            </small>
          )}
          <small>
            自动备份：
            {autoBackups.length
              ? `现有 ${autoBackups.length} 份，最新 ${autoBackups[0].name.replace(/^auto-|\.json$/g, "")}${autoBackups[0].ok ? "（校验通过）" : "（校验失败）"}`
              : "暂无备份"}
          </small>
          {autoBackups.some((item) => item.ok) && (
            <div className="settings-actions">
              <button
                type="button"
                onClick={async () => {
                  const usable = autoBackups.find((item) => item.ok);
                  if (!usable) return;
                  if (!window.confirm(`把 ${usable.name.replace(/^auto-|\.json$/g, "")} 这份备份合并进现在的数据？只添不删：现有的东西一样不动，备份里已存在的条目跳过。`)) return;
                  const outcome = await window.kaiLocal.readAutoBackup(usable.name);
                  if (!outcome.ok || !outcome.content) {
                    window.alert(outcome.message || "这份备份读不出来。");
                    return;
                  }
                  const added = await onRestoreBackup(outcome.content);
                  if (!added) {
                    window.alert("这份备份的内容格式不认识，没有动任何数据。");
                    return;
                  }
                  window.alert(`恢复完成：新增对话 ${added.conversations} 段、项目 ${added.projects} 个、常用语 ${added.prompts} 条。已存在的都跳过了。`);
                }}
              >
                从最新备份恢复（只添不删）
              </button>
            </div>
          )}
          <div className="settings-actions">
            <button
              type="button"
              title="每段对话一个 .md，打包成一个 zip"
              onClick={() => void onExportAll()}
            >
              全部对话导成 zip
            </button>
            <button type="button" onClick={() => void window.kaiLocal.openDataDir()}>
              打开数据目录
            </button>
            <button
              type="button"
              title="把数据目录的路径复制走"
              onClick={() => {
                if (dataDir) void navigator.clipboard.writeText(dataDir);
              }}
            >
              复制路径
            </button>
            <button
              type="button"
              onClick={async () => {
                const payload = await window.kaiLocal.exportSettings();
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `kaii-settings-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                URL.revokeObjectURL(link.href);
              }}
            >
              导出设置
            </button>
            <button
              type="button"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    const payload = JSON.parse(await file.text());
                    if (!window.confirm("用这份文件覆盖当前设置并重载应用？（不含 API key，key 不会被动到）")) return;
                    const outcome = await window.kaiLocal.importSettings(payload);
                    if (outcome.ok) window.location.reload();
                    else window.alert(outcome.message || "设置没导入成。");
                  } catch {
                    window.alert("这不是一份能读的设置文件。");
                  }
                };
                input.click();
              }}
            >
              导入设置
            </button>
            <button
              type="button"
              title="ChatGPT 官方导出 zip 里的 conversations.json；只搬当前对话线，放弃的分支不搬"
              onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    const { conversations, skipped } = parseChatGptExport(await file.text());
                    const outcome = onImportConversations(conversations);
                    window.alert(describeChatGptImport(outcome, skipped));
                  } catch (error) {
                    window.alert(error instanceof Error ? error.message : "这份文件读不了。");
                  }
                };
                input.click();
              }}
            >
              从 ChatGPT 导入
            </button>
          </div>
          {errorLog.length > 0 && (
            <details className="settings-errorlog">
              <summary>最近的错误（{errorLog.length} 条）</summary>
              <ul>
                {errorLog.slice(0, 10).map((entry, index) => (
                  <li key={index}>
                    <small>{new Date(entry.at).toLocaleString("zh-CN")}</small> {entry.text}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  localStorage.removeItem("kaii.errorlog.v1");
                  setErrorLog([]);
                }}
              >
                清空
              </button>
            </details>
          )}
          {appInfo && <small>kaii-agent {appInfo.version} · Electron {appInfo.electron}</small>}
        </div>

        <div className="settings-diagnose">
          <div className="settings-section-title">模型运行日志</div>
          <div className="path-field">
            <button type="button" onClick={async () => {
              if (logsOpen) {
                setLogsOpen(false);
                return;
              }
              setLogError(null);
              try {
                setModelLogs(await window.kaiLocal.getModelLogs());
                setLogsOpen(true);
              } catch (error) {
                setLogError(error instanceof Error ? error.message : "日志没有读出来");
              }
            }}>{logsOpen ? "收起日志" : "查看运行日志"}</button>
          </div>
          {logError && <small>{logError}</small>}
          {logsOpen && (
            <ul className="diagnose-list">
              {modelLogs.length
                ? modelLogs.map((line, index) => <li key={`${index}-${line.slice(0, 32)}`}><span><small>{line}</small></span></li>)
                : <li><span><small>还没有运行日志。</small></span></li>}
            </ul>
          )}
        </div>

        <div className="settings-diagnose">
          <div className="settings-section-title">自检</div>
          <div className="path-field">
            <button type="button" onClick={() => void onDiagnose()}>查一遍哪里不对</button>
          </div>
          {checks.length > 0 && (
            <ul className="diagnose-list">
              {checks.map((check) => (
                <li key={check.name} className={check.ok ? "ok" : "bad"}>
                  <b>{check.ok ? "✓" : "✗"}</b>
                  <span>
                    <strong>{check.name}</strong>
                    <small>{check.detail}{check.fix ? ` — ${check.fix}` : ""}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="settings-sweep">
          <div className="settings-section-title">清理</div>
          <div className="path-field">
            <button type="button" onClick={() => void onSweep()}>清理临时文件</button>
          </div>
        </div>

        <div className="settings-speak">
          <div className="settings-section-title">朗读</div>
          <div className="path-field">
            <select
              value={draft.speakVoice}
              aria-label="朗读的声音"
              onChange={(event) => setDraft({ ...draft, speakVoice: event.target.value })}
            >
              <option value="">自动选择</option>
              {voices.map((voice) => (
                <option value={voice.name} key={`${voice.name}-${voice.locale}`}>
                  {voice.name}（{voice.locale}）
                </option>
              ))}
            </select>
            <select
              value={String(draft.speakRate)}
              aria-label="语速"
              onChange={(event) => setDraft({ ...draft, speakRate: Number(event.target.value) })}
            >
              <option value="0">正常语速</option>
              <option value="160">慢一点</option>
              <option value="240">快一点</option>
              <option value="300">很快</option>
            </select>
          </div>
          <small>{voices.length} 个声音</small>
        </div>

        <div className="settings-backup">
          <div className="settings-section-title">备份</div>
          <div className="path-field">
            <button
              type="button"
              onClick={() => {
                const blob = new Blob([onBackup()], { type: "application/json;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = `kaii-备份-${new Date().toISOString().slice(0, 10)}.json`;
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              导出全部对话和项目
            </button>
            <label className="restore-button">
              恢复
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  onRestore(await file.text());
                }}
              />
            </label>
          </div>
        </div>

        <div className="settings-providers">
          <div className="settings-section-title">API KEY</div>
          {providerList.filter((item) => item.needsKey).map((item) => (
            <label key={item.id}>
              <span>{item.label}</span>
                  <div className="path-field">
                    <input
                  type="password"
                  placeholder={item.configured ? item.maskedKey : "粘贴后按回车"}
                  autoComplete="off"
                  disabled={item.configured && editingKey !== item.id}
                  onKeyDown={async (event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const value = event.currentTarget.value.trim();
                    if (!value) return;
                    const result = await window.kaiLocal.setProviderKey(item.id, value);
                    setProviderList(result.providers);
                    setEditingKey(null);
                    event.currentTarget.value = "";
                      }}
                    />
                    {item.configured && <div className="key-actions">
                      {item.configured && editingKey !== item.id && (
                        <button type="button" onClick={() => setEditingKey(item.id)}>换一个</button>
                      )}
                      <button
                          type="button"
                          className={confirmClearKey === item.id ? "danger" : ""}
                          onClick={async () => {
                            // 手一滑就把 key 删了，还得重新去官网翻一遍。多一步确认。
                            if (confirmClearKey !== item.id) {
                              setConfirmClearKey(item.id);
                              window.setTimeout(() => setConfirmClearKey((current) => (current === item.id ? null : current)), 4000);
                              return;
                            }
                            const result = await window.kaiLocal.setProviderKey(item.id, "");
                            setProviderList(result.providers);
                            setConfirmClearKey(null);
                          }}
                        >
                          {confirmClearKey === item.id ? "确认删除" : "删除"}
                      </button>
                    </div>}
                  </div>
            </label>
          ))}
        </div>

        <div className="settings-grid">
          <label className="full"><span>GGUF 模型</span><div className="path-field"><input value={draft.modelPath} onChange={(event) => setDraft({ ...draft, modelPath: event.target.value })} /><button type="button" onClick={() => choose("modelPath")}>选择</button></div></label>
          <label className="full"><span>llama-server</span><div className="path-field"><input value={draft.serverBinary} onChange={(event) => setDraft({ ...draft, serverBinary: event.target.value })} /><button type="button" onClick={() => choose("serverBinary")}>选择</button></div></label>
          <div className="settings-section-title">技能</div>
          <div className="settings-skills">
            {skills.length ? skills.map((skill) => (
              <div className="settings-skill-row" key={skill.id}>
                <span>
                  <strong>{skill.name}</strong>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const outcome = await window.kaiLocal.readSkill(skill.fileName);
                    if (!outcome.ok || !outcome.body) {
                      window.alert(outcome.message || "这条技能读不出来。");
                      return;
                    }
                    // 去掉 frontmatter 再给人看：那三行是给程序读的。
                    const body = outcome.body.replace(/^---[\s\S]*?\n---\s*\n/, "").trim();
                    setSkillDraft({ name: skill.name, description: skill.description, body });
                  }}
                >
                  改
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={async () => {
                    if (!window.confirm(`删掉技能「${skill.name}」？会挪进技能文件夹的 .trash 里，需要时还能捞回来。`)) return;
                    const outcome = await window.kaiLocal.discardSkill(skill.fileName);
                    if (outcome.ok && outcome.skills) onSkillsChange(outcome.skills);
                    else window.alert(outcome.message || "没删掉。");
                  }}
                >
                  删掉
                </button>
              </div>
            )) : <small>暂无技能</small>}
          </div>
          <div className="settings-actions">
            <button type="button" onClick={() => setSkillDraft({ name: "", description: "", body: "" })}>
              写一条技能
            </button>
          </div>
          {skillDraft && (
            <div className="settings-skill-editor">
              <input
                value={skillDraft.name}
                placeholder="技能名称"
                maxLength={40}
                onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })}
              />
              <input
                value={skillDraft.description}
                placeholder="描述（选填）"
                maxLength={80}
                onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })}
              />
              <textarea
                value={skillDraft.body}
                rows={6}
                placeholder="技能指令"
                onChange={(event) => setSkillDraft({ ...skillDraft, body: event.target.value })}
              />
              <div className="settings-actions">
                <button
                  type="button"
                  onClick={async () => {
                    const outcome = await window.kaiLocal.writeSkill(skillDraft);
                    if (!outcome.ok) {
                      window.alert(outcome.message || "没写成。");
                      return;
                    }
                    if (outcome.skills) onSkillsChange(outcome.skills);
                    setSkillDraft(null);
                  }}
                >
                  存下来
                </button>
                <button type="button" onClick={() => setSkillDraft(null)}>取消</button>
              </div>
            </div>
          )}

          <label className="full"><span>技能文件夹</span><div className="path-field"><input value={draft.skillDirectory} onChange={(event) => setDraft({ ...draft, skillDirectory: event.target.value })} /><button type="button" onClick={() => choose("skillDirectory")}>选择</button></div><small>已识别 {skills.length} 个技能</small></label>
          <label><span>端口</span><input type="number" value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></label>
          <label><span>上下文长度</span><input type="number" value={draft.contextSize} onChange={(event) => setDraft({ ...draft, contextSize: Number(event.target.value) })} /></label>
          <label><span>温度</span><input type="number" min="0" max="2" step="0.05" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} /></label>
          <label><span>最长回答</span><input type="number" value={draft.maxTokens} onChange={(event) => setDraft({ ...draft, maxTokens: Number(event.target.value) })} /></label>
          <label><span>主题</span><select value={draft.theme} onChange={(event) => setDraft({ ...draft, theme: event.target.value as AppSettings["theme"] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label className="toggle-row"><span><strong>打开应用时启动模型</strong><small>约 5 GB 内存</small></span><input type="checkbox" checked={draft.autoStart} onChange={(event) => setDraft({ ...draft, autoStart: event.target.checked })} /></label>
          <label className="toggle-row">
            <span>
              <strong>剪贴板快捷处理</strong>
              <small>
                {quickHotkeyState && !quickHotkeyState.registered && draft.quickEnabled
                  ? quickHotkeyState.reason === "taken"
                    ? "快捷键已被占用"
                    : quickHotkeyState.reason === "invalid"
                      ? "快捷键注册失败"
                      : ""
                  : ""}
              </small>
            </span>
            <input type="checkbox" checked={draft.quickEnabled} onChange={(event) => setDraft({ ...draft, quickEnabled: event.target.checked })} />
          </label>
          <label>
            <span>快捷键</span>
            <div className="path-field">
              <select
                value={draft.quickHotkey}
                disabled={!draft.quickEnabled}
                onChange={(event) => setDraft({ ...draft, quickHotkey: event.target.value })}
              >
                {quickHotkeys.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
              </select>
              <button type="button" onClick={() => window.kaiLocal.openQuickWindow()}>试一下</button>
            </div>
            <small>
              {trayState && !trayState.created ? `菜单栏图标没出来：${trayState.reason || "原因未知"}。` : ""}
              {draft.quickEnabled
                ? quickHotkeyState?.registered
                  ? "已启用"
                  : "注册失败"
                : "已关闭"}
            </small>
          </label>
          <label>
            <span>联网来源</span>
            <select value={draft.searchProvider} onChange={(event) => setDraft({ ...draft, searchProvider: event.target.value })}>
              {searchProviders.map((provider) => (
                <option value={provider.id} key={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <label><span>工具最多轮数</span><input type="number" min="1" max="12" value={draft.agentMaxRounds} onChange={(event) => setDraft({ ...draft, agentMaxRounds: Number(event.target.value) })} /></label>
          <label>
            <span>改文件前</span>
            <select value={draft.agentApproval} onChange={(event) => setDraft({ ...draft, agentApproval: event.target.value as AppSettings["agentApproval"] })}>
              <option value="ask">每次问我</option>
              <option value="auto">直接执行</option>
            </select>
          </label>
          {selectedProvider?.needsEndpoint && (
            <label className="full">
              <span>SearXNG 地址</span>
              <input value={draft.searxngEndpoint} placeholder="https://你的实例" onChange={(event) => setDraft({ ...draft, searxngEndpoint: event.target.value })} />
            </label>
          )}
          <label className="toggle-row"><span><strong>搜索失败时退回维基百科</strong></span><input type="checkbox" checked={draft.searchFallback} onChange={(event) => setDraft({ ...draft, searchFallback: event.target.checked })} /></label>
          <div className="full settings-export">
            <span><strong>导出全部对话</strong></span>
            <button type="button" onClick={() => {
              const blob = new Blob([onExport()], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `kaii-conversations-${new Date().toISOString().slice(0, 10)}.json`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}><Download size={14} /> 导出</button>
          </div>
        </div>

        <footer>
          {saveError && <p className="memory-error settings-save-error" role="alert">{saveError}</p>}
          <button className="secondary" type="button" onClick={onClose}>先不改</button>
          <button className="primary" type="button" disabled={saving} onClick={async () => {
            setSaving(true);
            setSaveError(null);
            try {
              await onSave(draft);
              onClose();
            } catch (error) {
              setSaveError(error instanceof Error ? error.message : "设置没有保存成功");
            } finally {
              setSaving(false);
            }
          }}>{saving ? "正在保存" : "保存设置"}</button>
        </footer>
      </section>
    </div>
  );
}
