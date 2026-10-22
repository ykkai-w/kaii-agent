import type { Conversation } from "../types";
import { parseBackup } from "./backup.ts";
import {
  buildConversationStoragePayload,
  CONVERSATIONS_KEY,
  fitsConversationStorage,
  LEGACY_CONVERSATIONS_KEY,
} from "./storage.ts";
import { MAX_PROJECTS, PROJECTS_KEY, type Project } from "./projects.ts";
import { MAX_PROMPTS, PROMPTS_KEY, type SavedPrompt } from "./prompts.ts";

export const RESTORE_TRANSACTION_VERSION = 1;

export interface RestoreCollections {
  conversations: Conversation[];
  projects: Project[];
  prompts: SavedPrompt[];
}

export interface RestoreRawSnapshot {
  conversations: string | null;
  legacyConversations: string | null;
  projects: string | null;
  prompts: string | null;
}

export interface RestoreTransactionPlan {
  version: typeof RESTORE_TRANSACTION_VERSION;
  id: string;
  createdAt: number;
  previous: RestoreRawSnapshot;
  target: RestoreRawSnapshot;
  next: RestoreCollections;
  counts: { conversations: number; projects: number; prompts: number };
}

export type RestorePlanResult =
  | { ok: true; plan: RestoreTransactionPlan }
  | { ok: false; error: string };

export interface RestoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): { items: T[]; added: number } {
  const seen = new Set(current.map((item) => item.id));
  const additions = incoming.filter((item) => !seen.has(item.id) && seen.add(item.id));
  return { items: [...current, ...additions], added: additions.length };
}

export function readRestoreRawSnapshot(storage: RestoreStorage = localStorage): RestoreRawSnapshot {
  return {
    conversations: storage.getItem(CONVERSATIONS_KEY),
    legacyConversations: storage.getItem(LEGACY_CONVERSATIONS_KEY),
    projects: storage.getItem(PROJECTS_KEY),
    prompts: storage.getItem(PROMPTS_KEY),
  };
}

function serializeCollections(collections: RestoreCollections): RestoreRawSnapshot {
  return {
    conversations: buildConversationStoragePayload(collections.conversations),
    // 新事务一律落到 v2，旧 key 在提交后移除。
    legacyConversations: null,
    projects: JSON.stringify(collections.projects),
    prompts: JSON.stringify(collections.prompts),
  };
}

export function planBackupRestore(
  content: string,
  current: RestoreCollections,
  storage: RestoreStorage = localStorage,
  now = Date.now(),
  id = crypto.randomUUID(),
): RestorePlanResult {
  const parsed = parseBackup(content);
  if (!parsed.ok) return { ok: false, error: parsed.error || "这份备份读不了。" };

  const conversations = mergeById(current.conversations, parsed.conversations);
  const projects = mergeById(current.projects, parsed.projects);
  const prompts = mergeById(current.prompts, parsed.prompts);
  const next: RestoreCollections = {
    conversations: conversations.items,
    projects: projects.items,
    prompts: prompts.items,
  };

  // 不在恢复时静默裁掉超量条目。只有“全部能落盘”才允许提交。
  if (next.projects.length > MAX_PROJECTS) {
    return { ok: false, error: `恢复后会有 ${next.projects.length} 个项目，超过上限 ${MAX_PROJECTS}。原数据没有改动。` };
  }
  if (next.prompts.length > MAX_PROMPTS) {
    return { ok: false, error: `恢复后会有 ${next.prompts.length} 条常用语，超过上限 ${MAX_PROMPTS}。原数据没有改动。` };
  }
  if (!fitsConversationStorage(next.conversations)) {
    return { ok: false, error: "恢复后的对话超过本机安全容量。原数据没有改动，可先导出或整理旧对话。" };
  }

  return {
    ok: true,
    plan: {
      version: RESTORE_TRANSACTION_VERSION,
      id,
      createdAt: now,
      previous: readRestoreRawSnapshot(storage),
      target: serializeCollections(next),
      next,
      counts: {
        conversations: conversations.added,
        projects: projects.added,
        prompts: prompts.added,
      },
    },
  };
}

function writeRawSnapshot(snapshot: RestoreRawSnapshot, storage: RestoreStorage) {
  const writes: Array<[string, string | null]> = [
    [CONVERSATIONS_KEY, snapshot.conversations],
    [LEGACY_CONVERSATIONS_KEY, snapshot.legacyConversations],
    [PROJECTS_KEY, snapshot.projects],
    [PROMPTS_KEY, snapshot.prompts],
  ];
  for (const [key, value] of writes) {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

function snapshotsEqual(left: RestoreRawSnapshot, right: RestoreRawSnapshot): boolean {
  return left.conversations === right.conversations
    && left.legacyConversations === right.legacyConversations
    && left.projects === right.projects
    && left.prompts === right.prompts;
}

export function rollbackRestorePlan(
  plan: Pick<RestoreTransactionPlan, "version" | "previous">,
  storage: RestoreStorage = localStorage,
): { ok: true } | { ok: false; error: string } {
  if (plan.version !== RESTORE_TRANSACTION_VERSION) return { ok: false, error: "恢复事务版本无效。" };
  try {
    writeRawSnapshot(plan.previous, storage);
    if (!snapshotsEqual(readRestoreRawSnapshot(storage), plan.previous)) throw new Error("回读不一致");
    return { ok: true };
  } catch {
    return { ok: false, error: "本机数据没能回到恢复前的完整快照。" };
  }
}

/**
 * 主进程必须在调用前把 plan.previous/target 写入 0600 恢复日志。
 * 这里只做同步提交、精确回读和当场回滚。
 */
export function commitRestorePlan(
  plan: RestoreTransactionPlan,
  storage: RestoreStorage = localStorage,
): { ok: true } | { ok: false; error: string } {
  if (plan.version !== RESTORE_TRANSACTION_VERSION) return { ok: false, error: "恢复事务版本无效。" };
  if (!snapshotsEqual(readRestoreRawSnapshot(storage), plan.previous)) {
    return { ok: false, error: "准备恢复后本机数据又发生了变化，这次没有写入。" };
  }
  try {
    writeRawSnapshot(plan.target, storage);
    if (!snapshotsEqual(readRestoreRawSnapshot(storage), plan.target)) throw new Error("回读不一致");
    return { ok: true };
  } catch (error) {
    try {
      writeRawSnapshot(plan.previous, storage);
    } catch {
      return { ok: false, error: "恢复写入失败，且本机回滚也没有完成。重启 kaii 会根据封存日志复原。" };
    }
    const detail = error instanceof Error ? error.message : "写入失败";
    return { ok: false, error: `恢复没有提交，已回到原数据（${detail}）。` };
  }
}

export interface PendingRestoreTransaction {
  version: number;
  id: string;
  previous: RestoreRawSnapshot;
  target: RestoreRawSnapshot;
}

/** 启动时的崩溃恢复：四份 target 全中才承认提交，混合态一律回到完整旧快照。 */
export function reconcilePendingRestore(
  pending: PendingRestoreTransaction,
  storage: RestoreStorage = localStorage,
): { ok: true; action: "committed" | "rolled_back" } | { ok: false; error: string } {
  if (pending.version !== RESTORE_TRANSACTION_VERSION || typeof pending.id !== "string") {
    return { ok: false, error: "恢复日志版本无效。" };
  }
  const current = readRestoreRawSnapshot(storage);
  if (snapshotsEqual(current, pending.target)) return { ok: true, action: "committed" };
  try {
    writeRawSnapshot(pending.previous, storage);
    if (!snapshotsEqual(readRestoreRawSnapshot(storage), pending.previous)) throw new Error("回读不一致");
    return { ok: true, action: "rolled_back" };
  } catch {
    return { ok: false, error: "kaii 没能根据恢复日志还原完整旧数据，已暂停自动保存。" };
  }
}
