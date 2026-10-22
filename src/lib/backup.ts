import type { Conversation } from "../types";
import {
  MAX_PROJECT_DOCUMENTS,
  MAX_PROJECT_INSTRUCTIONS,
  MAX_PROJECT_NAME,
  MAX_PROJECTS,
  type Project,
  type ProjectDocument,
} from "./projects.ts";
import { MAX_PROMPT_BODY, MAX_PROMPT_LABEL, MAX_PROMPTS, type SavedPrompt } from "./prompts.ts";
import { sanitizeConversations } from "./storage.ts";

// 备份与恢复：把这台电脑上的对话、项目和指令打成一个文件带走。
//
// 刻意不含 API key、记忆数据库和文档索引：
// key 属于凭据，记忆和索引在应用数据目录里另有位置，
// 把它们混进一个随手分享的文件里，是给自己埋雷。

export const BACKUP_VERSION = 1;

export interface BackupPayload {
  app: "kaii";
  backupVersion: number;
  exportedAt: string;
  conversations: Conversation[];
  projects: Project[];
  prompts: SavedPrompt[];
  /** 备份是可读 JSON，不把 userData 下的大文件偷偷塞进来。 */
  limitations?: string[];
}

export function buildBackup(
  conversations: Conversation[],
  projects: Project[],
  prompts: SavedPrompt[],
): string {
  // 标了「不进备份」的和「不留记录」的都不带走。
  conversations = conversations.filter((item) => !item.noBackup && !item.ephemeral);
  const payload: BackupPayload = {
    app: "kaii",
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    // 图片预览是 data URL，几张就能把备份撑到几十兆，去掉。
    conversations: conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        attachment: message.attachment ? { ...message.attachment, previewDataUrl: "" } : undefined,
      })),
    })),
    projects,
    prompts,
    limitations: [
      "不含 API key、记忆库和知识库索引。",
      "不含图片分析记录、文档正文和项目常驻资料正文；换机恢复后需重新添加这些文件。",
    ],
  };
  return JSON.stringify(payload, null, 2);
}

export interface RestoreResult {
  ok: boolean;
  error?: string;
  conversations: Conversation[];
  projects: Project[];
  prompts: SavedPrompt[];
  counts: { conversations: number; projects: number; prompts: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeProjectDocument(value: unknown): ProjectDocument | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name.slice(0, 240),
    kind: value.kind === "pdf" || value.kind === "office" || value.kind === "table" ? value.kind : "text",
    pageCount: Number.isFinite(value.pageCount) ? Number(value.pageCount) : 0,
    characters: Number.isFinite(value.characters) ? Number(value.characters) : 0,
  };
}

function sanitizeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Project[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
    const createdAt = Number.isFinite(item.createdAt) ? Number(item.createdAt) : 0;
    const documents = Array.isArray(item.documents)
      ? item.documents.flatMap((document) => {
          const parsed = sanitizeProjectDocument(document);
          return parsed ? [parsed] : [];
        }).slice(0, MAX_PROJECT_DOCUMENTS)
      : [];
    return [{
      id: item.id,
      name: item.name.slice(0, MAX_PROJECT_NAME),
      instructions: typeof item.instructions === "string"
        ? item.instructions.slice(0, MAX_PROJECT_INSTRUCTIONS)
        : "",
      documents,
      createdAt,
      updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : createdAt,
      defaultProvider: typeof item.defaultProvider === "string" ? item.defaultProvider.slice(0, 40) : undefined,
      defaultModel: typeof item.defaultModel === "string" ? item.defaultModel.slice(0, 120) : undefined,
      color: typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : undefined,
      sortIndex: Number.isFinite(item.sortIndex) ? Number(item.sortIndex) : undefined,
    }];
  }).slice(0, MAX_PROJECTS);
}

function sanitizePrompts(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SavedPrompt[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.body !== "string") return [];
    const body = item.body.slice(0, MAX_PROMPT_BODY);
    if (!body.trim()) return [];
    return [{
      id: item.id,
      label: (typeof item.label === "string" ? item.label : body).slice(0, MAX_PROMPT_LABEL),
      body,
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : 0,
      useCount: Number.isFinite(item.useCount) ? Math.max(0, Number(item.useCount)) : 0,
    }];
  }).slice(0, MAX_PROMPTS);
}

// 恢复时宁可少收也不错收：形状不对的整份拒绝，单条不合格的丢掉。
// 一个坏备份把现有数据冲掉，比恢复失败严重得多。
export function parseBackup(text: string): RestoreResult {
  const empty = { conversations: [], projects: [], prompts: [], counts: { conversations: 0, projects: 0, prompts: 0 } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "这个文件不是合法的 JSON。", ...empty };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "这个文件看起来不是 kaii 的备份。", ...empty };
  }
  const payload = parsed as Partial<BackupPayload>;
  if (payload.app !== "kaii") {
    return { ok: false, error: "这个文件不是 kaii 导出的。", ...empty };
  }
  if (payload.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `备份版本是 ${payload.backupVersion}，这个版本的 kaii 认不了。`, ...empty };
  }

  // 备份文件是外部输入。不能靠 TypeScript 的类型断言把原始对象直接塞进界面：
  // messages:[null] 这类内层坏数据会在下一次自动保存时直接抛错。三类数据都走与本机
  // 持久化相同的白名单和上限，单条坏记录丢掉，其余照常恢复。
  const conversations = sanitizeConversations(payload.conversations).conversations;
  const projects = sanitizeProjects(payload.projects);
  const prompts = sanitizePrompts(payload.prompts);

  return {
    ok: true,
    conversations,
    projects,
    prompts,
    counts: { conversations: conversations.length, projects: projects.length, prompts: prompts.length },
  };
}
