import type { Conversation } from "../types";

export const LEGACY_CONVERSATIONS_KEY = "kai-local.conversations.v1";
export const CONVERSATIONS_KEY = "kai-local.conversations.v2";
const ACTIVE_KEY = "kai-local.active-conversation.v1";

export const STORAGE_SCHEMA_VERSION = 2;
export const MAX_CONVERSATIONS = 80;
export const MAX_STORAGE_BYTES = 4_000_000;

export interface StorageResult {
  ok: boolean;
  bytes: number;
  droppedConversations: number;
  droppedMessages: number;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type StoredMessage = Conversation["messages"][number];
type StoredDocument = NonNullable<StoredMessage["document"]>;
type StoredAttachment = NonNullable<StoredMessage["attachment"]>;
type StoredSource = NonNullable<StoredMessage["sources"]>[number];
type StoredToolCall = NonNullable<StoredMessage["toolCalls"]>[number];
type StoredCitation = NonNullable<StoredMessage["citations"]>[number];
type StoredMemorySuggestion = NonNullable<StoredMessage["memorySuggestions"]>[number];

function finiteNumber(value: unknown, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function parseDocument(value: unknown): StoredDocument | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const kind = value.kind === "pdf" || value.kind === "office" || value.kind === "table" ? value.kind : "text";
  const sheetNames = Array.isArray(value.sheetNames)
    ? value.sheetNames.filter((item): item is string => typeof item === "string").slice(0, 200).map((item) => item.slice(0, 200))
    : undefined;
  return {
    id: value.id,
    name: value.name.slice(0, 240),
    kind,
    pageCount: finiteNumber(value.pageCount),
    characters: finiteNumber(value.characters),
    sectionCount: finiteNumber(value.sectionCount),
    truncated: value.truncated === true,
    preview: typeof value.preview === "string" ? value.preview.slice(0, 4000) : "",
    sheetNames,
    sheetName: typeof value.sheetName === "string" ? value.sheetName.slice(0, 200) : undefined,
    reused: value.reused === true ? true : undefined,
  };
}

function parseAttachment(value: unknown): StoredAttachment | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name.slice(0, 240),
    previewDataUrl: typeof value.previewDataUrl === "string" ? value.previewDataUrl : "",
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
    ocrPreview: typeof value.ocrPreview === "string" ? value.ocrPreview.slice(0, 4000) : "",
    labelPreview: typeof value.labelPreview === "string" ? value.labelPreview.slice(0, 2000) : "",
  };
}

function parseSource(value: unknown): StoredSource | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.url !== "string") return undefined;
  return {
    title: value.title.slice(0, 500),
    url: value.url.slice(0, 4096),
    snippet: typeof value.snippet === "string" ? value.snippet.slice(0, 4000) : "",
    searchedAt: typeof value.searchedAt === "string" ? value.searchedAt.slice(0, 100) : "",
    provider: typeof value.provider === "string" ? value.provider.slice(0, 80) : undefined,
  };
}

const TOOL_CALL_STATUSES = new Set(["waiting", "running", "ok", "error", "cancelled", "denied", "blocked"]);

function parseToolCall(value: unknown): StoredToolCall | undefined {
  if (
    !isRecord(value)
    || typeof value.callId !== "string"
    || typeof value.tool !== "string"
    || !TOOL_CALL_STATUSES.has(String(value.status))
  ) return undefined;
  const meta = isRecord(value.meta)
    ? {
        steps: Array.isArray(value.meta.steps)
          ? value.meta.steps.flatMap((step) => (
              isRecord(step)
              && typeof step.title === "string"
              && (step.status === "todo" || step.status === "doing" || step.status === "done")
                ? [{
                    title: step.title.slice(0, 1000),
                    status: step.status as "todo" | "doing" | "done",
                  }]
                : []
            )).slice(0, 100)
          : undefined,
        added: Number.isFinite(value.meta.added) ? Number(value.meta.added) : undefined,
        removed: Number.isFinite(value.meta.removed) ? Number(value.meta.removed) : undefined,
        exitCode: value.meta.exitCode === null || Number.isFinite(value.meta.exitCode)
          ? value.meta.exitCode as number | null
          : undefined,
        timedOut: typeof value.meta.timedOut === "boolean" ? value.meta.timedOut : undefined,
      }
    : undefined;
  return {
    callId: value.callId.slice(0, 128),
    tool: value.tool.slice(0, 100),
    title: typeof value.title === "string" ? value.title.slice(0, 1000) : value.tool.slice(0, 100),
    intent: typeof value.intent === "string" ? value.intent.slice(0, 4000) : "",
    args: isRecord(value.args) ? value.args : {},
    status: value.status as StoredToolCall["status"],
    write: value.write === true,
    summary: typeof value.summary === "string" ? value.summary.slice(0, 4000) : "",
    detail: typeof value.detail === "string" ? value.detail.slice(0, 4000) : "",
    changedPath: typeof value.changedPath === "string" ? value.changedPath.slice(0, 4096) : value.changedPath === null ? null : undefined,
    canRollback: value.canRollback === true ? true : undefined,
    rolledBack: value.rolledBack === true ? true : undefined,
    previewInvalid: value.previewInvalid === true ? true : undefined,
    durationMs: Number.isFinite(value.durationMs) ? Number(value.durationMs) : undefined,
    meta,
  };
}

function parseCitation(value: unknown): StoredCitation | undefined {
  if (!isRecord(value) || !Number.isFinite(value.index) || typeof value.file !== "string" || typeof value.label !== "string") {
    return undefined;
  }
  return {
    index: Number(value.index),
    library: typeof value.library === "string" ? value.library.slice(0, 500) : "",
    file: value.file.slice(0, 1000),
    absolutePath: typeof value.absolutePath === "string" ? value.absolutePath.slice(0, 4096) : "",
    label: value.label.slice(0, 1000),
  };
}

function parseMemorySuggestion(value: unknown): StoredMemorySuggestion | undefined {
  if (
    !isRecord(value)
    || !["note", "preference", "project", "fact"].includes(String(value.kind))
    || typeof value.label !== "string"
    || typeof value.content !== "string"
  ) return undefined;
  return {
    kind: value.kind as StoredMemorySuggestion["kind"],
    label: value.label.slice(0, 500),
    content: value.content.slice(0, 8000),
  };
}

function parseCompletion(message: Record<string, unknown>): Conversation["messages"][number]["completion"] {
  const value = message.completion;
  if (!isRecord(value) || !["verified", "unverified", "partial", "read-only"].includes(String(value.state))) {
    return undefined;
  }
  if (!Array.isArray(value.changedPaths) || !Array.isArray(value.checks)) return undefined;
  const changedPaths = value.changedPaths
    .filter((item): item is string => typeof item === "string" && Boolean(item))
    .slice(0, 200)
    .map((item) => item.slice(0, 4096));
  const checks = value.checks.flatMap((check) => {
    if (!isRecord(check) || typeof check.summary !== "string" || typeof check.ok !== "boolean" || typeof check.timedOut !== "boolean") {
      return [];
    }
    return [{ summary: check.summary.slice(0, 2000), ok: check.ok, timedOut: check.timedOut }];
  }).slice(0, 20);
  return {
    state: value.state as "verified" | "unverified" | "partial" | "read-only",
    changedPaths,
    checks,
  };
}

function parseMessage(message: unknown): StoredMessage | undefined {
  if (
    !isRecord(message)
    || typeof message.id !== "string"
    || !["user", "assistant"].includes(String(message.role))
    || typeof message.content !== "string"
    || !Number.isFinite(message.createdAt)
  ) return undefined;
  const wasPending = message.pending === true;
  const interruptedNote = "（上次在生成中中断）";
  const content = wasPending
    ? (message.content.trim() ? `${message.content.trimEnd()}\n\n${interruptedNote}` : interruptedNote)
    : message.content;
  const documents = Array.isArray(message.documents)
    ? message.documents.flatMap((item) => {
        const parsed = parseDocument(item);
        return parsed ? [parsed] : [];
      }).slice(0, 20)
    : undefined;
  const sources = Array.isArray(message.sources)
    ? message.sources.flatMap((item) => {
        const parsed = parseSource(item);
        return parsed ? [parsed] : [];
      }).slice(0, 100)
    : undefined;
  const toolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls.flatMap((item) => {
        const parsed = parseToolCall(item);
        return parsed ? [parsed] : [];
      }).slice(0, 200)
    : undefined;
  const citations = Array.isArray(message.citations)
    ? message.citations.flatMap((item) => {
        const parsed = parseCitation(item);
        return parsed ? [parsed] : [];
      }).slice(0, 100)
    : undefined;
  const memorySuggestions = Array.isArray(message.memorySuggestions)
    ? message.memorySuggestions.flatMap((item) => {
        const parsed = parseMemorySuggestion(item);
        return parsed ? [parsed] : [];
      }).slice(0, 100)
    : undefined;
  return {
    id: message.id,
    role: message.role as "user" | "assistant",
    content,
    createdAt: Number(message.createdAt),
    pending: false,
    error: wasPending || Boolean(message.error),
    documents: documents?.length ? documents : undefined,
    document: parseDocument(message.document),
    attachment: parseAttachment(message.attachment),
    sources: sources?.length ? sources : undefined,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    // 这里是白名单：不写进来的字段一刷新就没了。
    citations: citations?.length ? citations : undefined,
    memorySuggestions: memorySuggestions?.length ? memorySuggestions : undefined,
    modelLabel: typeof message.modelLabel === "string" ? message.modelLabel.slice(0, 40) : undefined,
    runId: typeof message.runId === "string" ? message.runId.slice(0, 128) : undefined,
    starred: message.starred === true ? true : undefined,
    elapsedMs: Number.isFinite(message.elapsedMs) ? Number(message.elapsedMs) : undefined,
    continuable: wasPending || message.continuable === true ? true : undefined,
    continueReason: wasPending
      ? "interrupted"
      : message.continueReason === "rounds" || message.continueReason === "truncated" || message.continueReason === "interrupted"
        ? message.continueReason
        : undefined,
    reasoning: typeof message.reasoning === "string" ? message.reasoning : undefined,
    usedModel: typeof message.usedModel === "string" ? message.usedModel.slice(0, 200) : undefined,
    completion: parseCompletion(message),
  };
}

export interface ConversationSanitizeResult {
  conversations: Conversation[];
  rootValid: boolean;
  rejectedConversations: number;
  rejectedMessages: number;
  truncatedConversations: number;
}

/**
 * 把磁盘或备份里的 unknown 数据收窄成渲染端可安全使用的形状。
 * 返回拒绝计数，让上层能在发现半损数据时 fail closed，而不是把空数组当成真实空历史。
 */
export function sanitizeConversations(raw: unknown, maxConversations = MAX_CONVERSATIONS): ConversationSanitizeResult {
  if (!Array.isArray(raw)) {
    return {
      conversations: [],
      rootValid: false,
      rejectedConversations: 0,
      rejectedMessages: 0,
      truncatedConversations: 0,
    };
  }
  const conversations: Conversation[] = [];
  let rejectedConversations = 0;
  let rejectedMessages = 0;
  let truncatedConversations = 0;
  for (const conversation of raw) {
    if (
      !isRecord(conversation)
      || typeof conversation.id !== "string"
      || typeof conversation.title !== "string"
      || typeof conversation.skillId !== "string"
      || !Number.isFinite(conversation.createdAt)
      || !Number.isFinite(conversation.updatedAt)
      || !Array.isArray(conversation.messages)
    ) {
      rejectedConversations += 1;
      continue;
    }
    if (conversations.length >= maxConversations) {
      truncatedConversations += 1;
      continue;
    }
    const messages: StoredMessage[] = [];
    for (const message of conversation.messages) {
      const parsed = parseMessage(message);
      if (parsed) messages.push(parsed);
      else rejectedMessages += 1;
    }
    conversations.push({
      id: conversation.id,
      title: conversation.title,
      titleAuto: conversation.titleAuto === true,
      projectId: typeof conversation.projectId === "string" ? conversation.projectId : undefined,
      provider: typeof conversation.provider === "string" ? conversation.provider.slice(0, 80) : undefined,
      model: typeof conversation.model === "string" ? conversation.model.slice(0, 200) : undefined,
      branchedFrom: isRecord(conversation.branchedFrom)
        && typeof conversation.branchedFrom.conversationId === "string"
        && typeof conversation.branchedFrom.title === "string"
        ? {
            conversationId: conversation.branchedFrom.conversationId.slice(0, 128),
            title: conversation.branchedFrom.title.slice(0, 200),
          }
        : undefined,
      detachedContext: conversation.detachedContext === true
        || (typeof conversation.dmrmlFingerprint === "string" && /^[0-9a-f]{64}$/.test(conversation.dmrmlFingerprint))
        ? true : undefined,
      skillId: conversation.skillId,
      createdAt: Number(conversation.createdAt),
      pinned: conversation.pinned === true ? true : undefined,
      noBackup: conversation.noBackup === true ? true : undefined,
      summary: typeof conversation.summary === "string" && conversation.summary.trim()
        ? conversation.summary.slice(0, 200)
        : undefined,
      maxTokensOverride: Number.isInteger(conversation.maxTokensOverride) && Number(conversation.maxTokensOverride) > 0
        ? Number(conversation.maxTokensOverride)
        : undefined,
      // 白名单：不写在这里的字段一刷新就没了。
      tags: Array.isArray(conversation.tags)
        ? conversation.tags.filter((tag) => typeof tag === "string" && tag.trim()).slice(0, 8).map((tag) => tag.slice(0, 16))
        : undefined,
      archived: conversation.archived === true ? true : undefined,
      deletedAt: Number.isFinite(conversation.deletedAt) ? Number(conversation.deletedAt) : undefined,
      updatedAt: Number(conversation.updatedAt),
      messages,
    });
  }
  return { conversations, rootValid: true, rejectedConversations, rejectedMessages, truncatedConversations };
}

export type ConversationStorageStatus = "missing" | "valid" | "unsupported" | "corrupt";

export interface ConversationStorageSnapshot extends ConversationSanitizeResult {
  status: ConversationStorageStatus;
  source: "current" | "legacy" | null;
  schemaVersion?: unknown;
}

function emptyStorageSnapshot(
  status: ConversationStorageStatus,
  source: ConversationStorageSnapshot["source"],
  schemaVersion?: unknown,
): ConversationStorageSnapshot {
  return {
    status,
    source,
    schemaVersion,
    conversations: [],
    rootValid: status === "missing",
    rejectedConversations: 0,
    rejectedMessages: 0,
    truncatedConversations: 0,
  };
}

/** 纯解析入口：不读写 localStorage，但会区分真空、未来版本与已损数据。 */
export function parseConversationStorage(
  raw: string | null,
  source: "current" | "legacy" = "current",
): ConversationStorageSnapshot {
  if (!raw) return emptyStorageSnapshot("missing", null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStorageSnapshot("corrupt", source);
  }

  if (source === "legacy") {
    const sanitized = sanitizeConversations(parsed);
    if (!sanitized.rootValid) return emptyStorageSnapshot("corrupt", source);
    const damaged = sanitized.rejectedConversations > 0
      || sanitized.rejectedMessages > 0
      || sanitized.truncatedConversations > 0;
    return { ...sanitized, status: damaged ? "corrupt" : "valid", source };
  }

  if (!isRecord(parsed)) return emptyStorageSnapshot("corrupt", source);
  if (parsed.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    return emptyStorageSnapshot("unsupported", source, parsed.schemaVersion);
  }
  const sanitized = sanitizeConversations(parsed.conversations);
  if (!sanitized.rootValid) return emptyStorageSnapshot("corrupt", source, parsed.schemaVersion);
  const damaged = sanitized.rejectedConversations > 0
    || sanitized.rejectedMessages > 0
    || sanitized.truncatedConversations > 0;
  return {
    ...sanitized,
    status: damaged ? "corrupt" : "valid",
    source,
    schemaVersion: parsed.schemaVersion,
  };
}

export function loadConversationsWithStatus(): ConversationStorageSnapshot {
  try {
    const current = localStorage.getItem(CONVERSATIONS_KEY);
    if (current) return parseConversationStorage(current, "current");
    const legacy = localStorage.getItem(LEGACY_CONVERSATIONS_KEY);
    if (!legacy) return emptyStorageSnapshot("missing", null);
    return parseConversationStorage(legacy, "legacy");
  } catch {
    return emptyStorageSnapshot("corrupt", "current");
  }
}

export function loadConversations(): Conversation[] {
  return loadConversationsWithStatus().conversations;
}

export function serializeConversationStorage(conversations: Conversation[]) {
  return JSON.stringify({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    savedAt: Date.now(),
    conversations,
  });
}

function stripHeavyFields(conversations: Conversation[]): Conversation[] {
  return conversations.slice(0, MAX_CONVERSATIONS).map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      // 保留 pending 才能在崩溃后识别“上次没生成完”，重载时会转成可继续的中断态。
      pending: message.pending === true,
      // 预览图是几十 KB 的 data URL，只在内存里用，不写进 localStorage。
      attachment: message.attachment ? { ...message.attachment, previewDataUrl: "" } : undefined,
      toolCalls: message.toolCalls?.map((call) => ({ ...call, detail: call.detail.slice(0, 4000) })),
    })),
  }));
}

/**
 * 恢复事务需要先得到“将要写入的确切字节”，再封存新旧副本。
 * 这个入口与日常保存共用同一套去重字段和 schema，避免预检通过后
 * 真正落盘又变成另一份数据。
 */
export function buildConversationStoragePayload(conversations: Conversation[]): string {
  return serializeConversationStorage(stripHeavyFields(conversations.filter((item) => !item.ephemeral)));
}

/**
 * 只做容量预检，不读写 localStorage。导入前先问它，就不会把
 * “当前内存里看得见”错报成“重启后也已经保存”。
 */
export function fitsConversationStorage(conversations: Conversation[]): boolean {
  const persistable = conversations.filter((item) => !item.ephemeral);
  if (persistable.length > MAX_CONVERSATIONS) return false;
  try {
    return serializeConversationStorage(stripHeavyFields(persistable)).length <= MAX_STORAGE_BYTES;
  } catch {
    return false;
  }
}

export function saveConversations(conversations: Conversation[]): StorageResult {
  // 「不留记录」的对话不写盘。它只活在内存里，关掉应用就没了——
  // 这是它存在的意义，不是疏漏。
  conversations = conversations.filter((item) => !item.ephemeral);
  // 不认识的新版数据必须原样留着。旧逻辑会把它读成空历史，
  // App 首次渲染的自动保存随即又把原字节覆盖掉。这里在唯一写入口
  // fail closed：界面仍可打开，但不会用一张空白纸毁掉未来版数的数据。
  const current = localStorage.getItem(CONVERSATIONS_KEY);
  if (current) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (!isRecord(parsed) || parsed.schemaVersion !== STORAGE_SCHEMA_VERSION) {
        return {
          ok: false,
          bytes: current.length,
          droppedConversations: 0,
          droppedMessages: 0,
          error: "这份对话数据来自其他版本，kaii 已保留原数据，没有覆盖。",
        };
      }
    } catch {
      return {
        ok: false,
        bytes: current.length,
        droppedConversations: 0,
        droppedMessages: 0,
        error: "对话数据无法读取，kaii 已保留原数据，没有覆盖。",
      };
    }
  }
  let working = stripHeavyFields(conversations);
  let droppedConversations = Math.max(0, conversations.length - working.length);
  let droppedMessages = 0;

  // 先按整体字节裁剪：older 会话整条丢，最后一条会话则从最旧的消息开始丢。
  let payload = serializeConversationStorage(working);
  while (payload.length > MAX_STORAGE_BYTES) {
    if (working.length > 1) {
      working = working.slice(0, -1);
      droppedConversations += 1;
    } else if (working[0]?.messages.length > 2) {
      working = [{ ...working[0], messages: working[0].messages.slice(2) }];
      droppedMessages += 2;
    } else {
      break;
    }
    payload = serializeConversationStorage(working);
  }

  try {
    localStorage.setItem(CONVERSATIONS_KEY, payload);
    localStorage.removeItem(LEGACY_CONVERSATIONS_KEY);
    return { ok: true, bytes: payload.length, droppedConversations, droppedMessages };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const quotaExceeded = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
    return {
      ok: false,
      bytes: payload.length,
      droppedConversations,
      droppedMessages,
      error: quotaExceeded
        ? "本机存储已满，这次对话没有保存。可以先导出再删掉一些旧对话。"
        : "对话没有保存成功。",
    };
  }
}

/**
 * 没有任何消息的“新对话”可以回收。它可能从上一段继承了模型或项目，
 * 但连一句话都没有时，连点“新对话”不应该在侧边栏堆出一排空壳。
 * 置顶、标签、归档、回收站和分支是用户明确做过的整理动作，仍然保留。
 */
export function isDefaultEmptyConversation(conversation: Conversation): boolean {
  return conversation.messages.length === 0
    && conversation.title === "新对话"
    && conversation.skillId === "none"
    && !conversation.titleAuto
    && !conversation.tags?.length
    && !conversation.pinned
    && !conversation.archived
    && !conversation.deletedAt
    && !conversation.branchedFrom
    && !conversation.detachedContext;
}

/** 去掉多余的空壳：优先留当前对话，否则留最新的一个。 */
export function pruneRedundantEmptyConversations(conversations: Conversation[], activeId: string | null): Conversation[] {
  const emptyShells = conversations.filter(isDefaultEmptyConversation);
  if (emptyShells.length <= 1) return conversations;
  const activeShell = emptyShells.find((item) => item.id === activeId);
  const keep = activeShell || emptyShells.reduce((latest, item) => (
    item.updatedAt > latest.updatedAt
      || (item.updatedAt === latest.updatedAt && item.createdAt > latest.createdAt)
      ? item
      : latest
  ));
  return conversations.filter((item) => !isDefaultEmptyConversation(item) || item.id === keep.id);
}

export function exportConversations(conversations: Conversation[]) {
  return JSON.stringify({
    app: "kaii",
    schemaVersion: STORAGE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    conversations: stripHeavyFields(conversations),
  }, null, 2);
}

export function referencedDocumentIds(conversations: Conversation[]): string[] {
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.document?.id) ids.add(message.document.id);
    }
  }
  return [...ids];
}

export function referencedAttachmentIds(conversations: Conversation[]): string[] {
  const ids = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.attachment?.id) ids.add(message.attachment.id);
    }
  }
  return [...ids];
}

export function loadActiveConversationId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveConversationId(id: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // 活动会话 ID 丢了只影响下次打开时的默认选中，不值得打断当前对话。
  }
}

// 把一段对话导成 Markdown。用户真正会做的事是把某一次问答贴给别人，
// 所以默认导单段对话，而不是整个库。
export function conversationToMarkdown(conversation: Conversation): string {
  const stamp = new Date(conversation.createdAt).toLocaleString("zh-CN");
  const lines = [`# ${conversation.title}`, "", `导出时间：${new Date().toLocaleString("zh-CN")}`, `开始时间：${stamp}`, ""];
  for (const message of conversation.messages) {
    if (!message.content.trim()) continue;
    lines.push(message.role === "user" ? "## 我" : "## kaii", "");
    if (message.document) lines.push(`> 附了文档：${message.document.name}`, "");
    if (message.attachment) lines.push(`> 附了图片：${message.attachment.name}`, "");
    lines.push(message.content.trim(), "");
    if (message.sources?.length) {
      lines.push("来源：");
      for (const [index, source] of message.sources.entries()) {
        lines.push(`${index + 1}. [${source.title}](${source.url})`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface ConversationHit {
  conversationId: string;
  title: string;
  updatedAt: number;
  messageId: string | null;
  excerpt: string;
  matchCount: number;
}

// 会话多起来之后，"上次那个说法在哪一段对话里"是最常见的需求。
// 这里做的是朴素的大小写无关子串匹配，命中处给一小段上下文，能点着跳过去。
export function searchConversations(conversations: Conversation[], rawQuery: string, limit = 40): ConversationHit[] {
  const query = rawQuery.trim().toLocaleLowerCase("zh-CN");
  if (query.length < 1) return [];
  const hits: ConversationHit[] = [];

  for (const conversation of conversations) {
    let matchCount = 0;
    let firstMessageId: string | null = null;
    let excerpt = "";

    if (conversation.title.toLocaleLowerCase("zh-CN").includes(query)) {
      matchCount += 1;
      excerpt = conversation.title;
    }
    for (const message of conversation.messages) {
      const haystack = message.content.toLocaleLowerCase("zh-CN");
      const index = haystack.indexOf(query);
      if (index < 0) continue;
      matchCount += 1;
      if (!firstMessageId) {
        firstMessageId = message.id;
        const from = Math.max(0, index - 28);
        const raw = message.content.slice(from, index + query.length + 52).replace(/\s+/g, " ").trim();
        excerpt = `${from > 0 ? "…" : ""}${raw}${index + query.length + 52 < message.content.length ? "…" : ""}`;
      }
    }
    if (!matchCount) continue;
    hits.push({
      conversationId: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      messageId: firstMessageId,
      excerpt,
      matchCount,
    });
  }

  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
