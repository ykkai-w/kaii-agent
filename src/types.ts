export type Role = "user" | "assistant";

export interface WebSource {
  title: string;
  url: string;
  snippet: string;
  searchedAt: string;
  provider?: string;
}

export type ToolCallStatus = "waiting" | "running" | "ok" | "error" | "cancelled" | "denied" | "blocked";

export interface PlanStep {
  title: string;
  status: "todo" | "doing" | "done";
}

export interface ToolCallReceipt {
  callId: string;
  tool: string;
  title: string;
  intent: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  write: boolean;
  summary: string;
  detail: string;
  changedPath?: string | null;
  canRollback?: boolean;
  rolledBack?: boolean;
  previewInvalid?: boolean;
  durationMs?: number;
  meta?: { steps?: PlanStep[]; added?: number; removed?: number; exitCode?: number | null; timedOut?: boolean };
}

export interface WorkspaceRoot {
  id: string;
  path: string;
  label: string;
  writable: boolean;
  addedAt: number;
  exists: boolean;
}

export interface WorkspaceState {
  roots: WorkspaceRoot[];
  activeId: string | null;
}

export interface WorkspaceSummary {
  fileCount: number;
  truncated: boolean;
  totalBytes: number;
  topExtensions: Array<{ extension: string; count: number }>;
  topLevelFiles: string[];
}

export interface WorkspaceDetail {
  id: string;
  label: string;
  path: string;
  writable: boolean;
  summary: WorkspaceSummary;
  projectNotes: { fileName: string; content: string; truncated: boolean } | null;
}

export interface ToolInfo {
  id: string;
  title: string;
  write: boolean;
  usage: string;
}

export interface SearchProviderInfo {
  id: string;
  label: string;
  detail: string;
  needsEndpoint: boolean;
}

export interface AuditEntry {
  id: string;
  runId: string;
  requestId: string;
  createdAt: number;
  finishedAt: number | null;
  tool: string;
  workspacePath: string;
  args: Record<string, unknown>;
  status: string;
  summary: string;
  detail: string;
  changedPath: string | null;
  snapshotPath: string | null;
  rolledBack: boolean;
}

export interface ImageAttachment {
  id: string;
  name: string;
  previewDataUrl: string;
  width: number;
  height: number;
  ocrPreview: string;
  labelPreview: string;
}

export interface SavedPage {
  tags?: string[];
  /** 模型顺手写的两句摘要。生成失败就没有。 */
  summary?: string;
  id: string;
  url: string;
  title: string;
  characters: number;
  savedAt: number;
  excerpt: string;
}

export interface DocumentAttachment {
  id: string;
  name: string;
  kind: "pdf" | "office" | "text" | "table";
  pageCount: number;
  characters: number;
  sectionCount: number;
  truncated: boolean;
  preview: string;
  /** xlsx 有多张工作表时列出名字，界面靠它提供「只看某一张」。 */
  sheetNames?: string[];
  /** 只提取了某一张工作表时记下是哪张。 */
  sheetName?: string;
  /** 这次是直接复用上次的解析结果（同路径同大小同修改时间）。 */
  reused?: boolean;
}

export interface ProviderModelInfo {
  id: string;
  label: string;
}

export interface ScheduleResult {
  at: number;
  ok: boolean;
  text: string;
  error: string;
  unread: boolean;
}

export interface Schedule {
  /** 每月几号（1-28）。every 为 month 时有效。 */
  dayOfMonth?: number;
  /** 到点跑的时候带不带联网 / 翻资料。 */
  useWeb?: boolean;
  useKnowledge?: boolean;
  /** 结果里出现这个词才通知。空 = 每次都通知。 */
  notifyKeyword?: string;
  /** 暂停到这个时刻（毫秒）。 */
  pausedUntil?: number;
  id: string;
  label: string;
  prompt: string;
  every: "hour" | "day" | "week" | "month";
  hour: number;
  minute: number;
  weekday: number;
  provider: string;
  model: string;
  enabled: boolean;
  lastRunAt: number;
  nextRunAt: number;
  results: ScheduleResult[];
}

export interface MemorySuggestion {
  kind: MemoryEntry["kind"];
  label: string;
  content: string;
}

export interface KnowledgeLibrary {
  /** 排除规则：目录名或文件名片段，命中就跳过。 */
  excludes?: string[];
  /** 文件夹里有比索引更新的文件，该重建了。 */
  stale?: boolean;
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  fileCount: number;
  sectionCount: number;
  /** 索引里一共多少字。算是「这个库有多大」的直观量级。 */
  characters?: number;
  indexedAt: number;
  skipped: Array<{ path: string; reason: string }>;
  exists: boolean;
}

export interface KnowledgeCitation {
  index: number;
  library: string;
  file: string;
  absolutePath: string;
  label: string;
}

export interface CatalogItem {
  provider: string;
  model: string;
  label: string;
  note: string;
  configured: boolean;
  needsKey: boolean;
}

export interface CatalogSection {
  group: string;
  items: CatalogItem[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  detail: string;
  cloud: boolean;
  needsKey: boolean;
  configured: boolean;
  maskedKey: string;
  models: ProviderModelInfo[];
}

export interface CanvasActionInfo {
  id: string;
  label: string;
  hint: string;
}

export interface QuickActionInfo {
  id: string;
  label: string;
  hint: string;
}

export interface QuickHotkeyInfo {
  id: string;
  label: string;
}

export interface QuickHotkeyState {
  registered: boolean;
  reason?: string;
}

export interface TrayState {
  created: boolean;
  reason?: string;
}

export interface QuickState {
  clip: string;
  actions: QuickActionInfo[];
  hotkeys: QuickHotkeyInfo[];
  hotkey: string;
  enabled: boolean;
  hotkeyState: QuickHotkeyState;
  modelState: ModelState;
}

export interface MemoryEntry {
  id: string;
  content: string;
  kind: "note" | "preference" | "project" | "fact";
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
  pinned: boolean;
  archived: boolean;
  source: { kind: string; [key: string]: unknown };
  scope: { kind: "global" | "project" | "conversation"; id: string | null };
  status: "valid" | "superseded" | "disputed";
  supersedes: string | null;
  reason: string | null;
}

export type CompletionEvidenceState = "verified" | "unverified" | "partial" | "read-only";

export interface CompletionEvidence {
  state: CompletionEvidenceState;
  changedPaths: string[];
  checks: Array<{
    summary: string;
    ok: boolean;
    timedOut: boolean;
  }>;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
  attachment?: ImageAttachment;
  document?: DocumentAttachment;
  /** 一次挂多份时的完整列表。document 保留为最后一份，兼容老记录。 */
  documents?: DocumentAttachment[];
  sources?: WebSource[];
  toolCalls?: ToolCallReceipt[];
  citations?: KnowledgeCitation[];
  memorySuggestions?: MemorySuggestion[];
  /** 这条回答出自哪个模型。目前只有「比一比」里选中的回答会带上。 */
  modelLabel?: string;
  runId?: string;
  /** 加了星的回答会进「收藏」，翻回去找不用一段段翻。 */
  /** 这条回答花了多久。慢的时候用户会怀疑是不是卡了。 */
  elapsedMs?: number;
  starred?: boolean;
  continuable?: boolean;
  /** 为什么能接着写：轮数用尽，还是被长度限制掐断了。 */
  continueReason?: "rounds" | "truncated" | "interrupted";
  /** 推理型模型的思考过程，和答案分开存，默认折叠。 */
  reasoning?: string;
  usedModel?: string;
  /** 任务做到哪一步的可审计证据；“检查通过”不等于声称代码一定正确。 */
  completion?: CompletionEvidence;
}

export interface Conversation {
  /** 不留记录：这段对话不写盘，关掉应用就没了。 */
  ephemeral?: boolean;
  /** 这段对话不进备份文件（本机照常保存）。 */
  noBackup?: boolean;
  /** 这段对话临时压低回答长度（token）。0/undefined = 用设置里的。只许调小。 */
  maxTokensOverride?: number;
  /** 置顶的对话永远排在最上面，不跟着更新时间往下掉。 */
  pinned?: boolean;
  /** 标签。项目是"归属"（一段对话只能在一个项目里），
      标签是"性质"（可以有好几个），两者解决的不是同一件事。 */
  tags?: string[];
  /** 归档：不删，但从主列表里收起来。 */
  archived?: boolean;
  /** 删掉的时间。回收站里的东西保留三十天。 */
  deletedAt?: number;
  id: string;
  title: string;
  /** 标题是否已经由模型生成过；只做一次，避免每轮都去起名。 */
  titleAuto?: boolean;
  /** 这段对话用哪个模型来源；缺省是本机。 */
  provider?: string;
  model?: string;
  /** 所属项目；未分组时为空。 */
  projectId?: string;
  /** 从哪段对话分出来的，用来在侧栏显示关系。 */
  branchedFrom?: { conversationId: string; title: string };
  /** 用户主动点出来的一句话摘要，显示在对话顶部。 */
  summary?: string;
  /** 已移除专属扩展的历史对话，仅保留本机查阅。 */
  detachedContext?: boolean;
  messages: ChatMessage[];
  skillId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ModelState {
  /** 模型进程占了多少内存（MB）。只有本机进程是自己拉的才有。 */
  rssMb?: number;
  status: "stopped" | "starting" | "ready" | "stopping" | "error";
  detail: string;
  owned: boolean;
}

export interface AppSettings {
  serverBinary: string;
  modelPath: string;
  skillDirectory: string;
  port: number;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  temperature: number;
  maxTokens: number;
  autoStart: boolean;
  theme: "system" | "light" | "dark";
  searchProvider: string;
  searchFallback: boolean;
  searxngEndpoint: string;
  agentMaxRounds: number;
  agentApproval: "ask" | "auto";
  /** 朗读用哪把嗓子。空字符串＝按内容自动挑。 */
  /** 单次回答最多等几分钟。0 = 默认上限。 */
  chatTimeoutMinutes: number;
  /** 开机/唤醒后允许补跑迟到多久的任务（分钟）。 */
  scheduleGraceMinutes: number;
  /** 断网模式：只用本机模型。 */
  localOnly: boolean;
  /** 发云端前把内容量报出来。 */
  cloudReceipt: boolean;
  speakVoice: string;
  /** 语速（每分钟词数）。0＝系统默认。 */
  speakRate: number;
  quickEnabled: boolean;
  quickHotkey: string;
}

export interface SkillInfo {
  id: string;
  fileName: string;
  name: string;
  description: string;
  characters: number;
  loadingMode: "full" | "focused";
}

export interface RestoreRawSnapshot {
  conversations: string | null;
  legacyConversations: string | null;
  projects: string | null;
  prompts: string | null;
}

export interface PendingRestoreTransaction {
  version: number;
  id: string;
  createdAt: number;
  status: "prepared";
  previous: RestoreRawSnapshot;
  target: RestoreRawSnapshot;
}

export interface InitialState {
  settings: AppSettings;
  modelState: ModelState;
  skills: SkillInfo[];
  platform: string;
  arch: string;
  capabilities: {
    memory: boolean;
    vision: boolean;
    document: boolean;
    web: boolean;
    tools: boolean;
  };
  searchProviders: SearchProviderInfo[];
  quickActions: QuickActionInfo[];
  quickHotkeys: QuickHotkeyInfo[];
  quickHotkeyState: QuickHotkeyState;
  trayState: TrayState;
  providers: ProviderInfo[];
  workspaces: WorkspaceState;
  tools: ToolInfo[];
  allowedCommands: string[];
  projectNoteFiles: string[];
  pendingRestore: PendingRestoreTransaction | null;
}

/**
 * 工程任务在审计库里的可恢复摘要。checkpoint 的具体内容只留在
 * 主进程，渲染进程只需要知道“有没有”，不展示命令、路径或隐藏提示。
 */
export interface AgentRunSummary {
  id: string;
  goal: string;
  status: string;
  rounds: number;
  createdAt: number;
  checkpoint?: {
    goal: string;
    workspace: { id: string; realpath: string };
    plan: Array<{ title: string; status: "todo" | "doing" | "done" }>;
    changedPaths: Array<{ path: string; sha256: string | null; exists: boolean; stale: boolean }>;
    lastCheck: { summary: string; ok: boolean; timedOut: boolean; mutationEpoch: number } | null;
    failureSummaries: Array<{ tool: string; path: string | null; summary: string }>;
    stopReason: string;
    mutationEpoch: number;
    /** 测试命令可能改动了未能逐项登记的文件；写操作保持锁定，直到主进程完成安全重扫。 */
    workspaceDirty: boolean;
  } | null;
  parentRunId?: string | null;
  resumedFrom?: string | null;
  resumable?: boolean;
}

export type AgentRunResumeAvailability = "hidden" | "disabled" | "ready";

/**
 * 恢复入口的规则只放在一处：未通过主进程校验的记录不显示；
 * 当前有任务时仍显示入口，但不允许并发启动第二个。
 */
export function agentRunResumeAvailability(
  run: Pick<AgentRunSummary, "resumable">,
  busy: boolean,
): AgentRunResumeAvailability {
  if (run.resumable !== true) return "hidden";
  return busy ? "disabled" : "ready";
}

export interface ChatRequest {
  requestId: string;
  messages: Array<{ role: Role; content: string; attachmentId?: string; documentId?: string; documentIds?: string[] }>;
  skillId: string;
  options: {
    useMemory: boolean;
    useWeb: boolean;
    useTools: boolean;
    useKnowledge?: boolean;
    mission?: boolean;
    /** 这一条临时压低回答长度。只许小于设置值。 */
    maxTokens?: number;
  };
  projectContext?: string;
  projectDocumentIds?: string[];
  provider?: string;
  model?: string;
  /** 从已保存的工程任务恢复；不用一句模糊的“继续”假装恢复。 */
  resumeRunId?: string;
}
