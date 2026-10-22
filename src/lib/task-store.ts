import {
  migrateTaskCapsule,
  serializeTaskCapsule,
  type TaskCapsule,
} from "./task-capsule.ts";

export const TASK_STORE_KEY = "kaii.task-capsules.v1";
export const TASK_STORE_VERSION = 1;
export const MAX_TASK_CAPSULES = 100;
export const MAX_TASK_STORE_BYTES = 2_500_000;

export interface TaskStoreSnapshot {
  status: "missing" | "valid" | "unsupported" | "corrupt";
  capsules: TaskCapsule[];
  rejected: number;
  version?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseTaskStore(raw: string | null): TaskStoreSnapshot {
  if (!raw) return { status: "missing", capsules: [], rejected: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", capsules: [], rejected: 0 };
  }
  if (!isRecord(parsed)) return { status: "corrupt", capsules: [], rejected: 0 };
  if (parsed.version !== TASK_STORE_VERSION) {
    return { status: "unsupported", capsules: [], rejected: 0, version: parsed.version };
  }
  if (!Array.isArray(parsed.capsules) || parsed.capsules.length > MAX_TASK_CAPSULES) {
    return { status: "corrupt", capsules: [], rejected: 0, version: parsed.version };
  }
  const capsules: TaskCapsule[] = [];
  let rejected = 0;
  for (const value of parsed.capsules) {
    const migrated = migrateTaskCapsule(value);
    if ((migrated.status === "valid" || migrated.status === "migrated") && migrated.capsule) {
      capsules.push(migrated.capsule);
    } else {
      rejected += 1;
    }
  }
  // 根结构是我们认识的，但任意一条胶囊损坏都不可静默改写原库。
  return { status: rejected ? "corrupt" : "valid", capsules, rejected, version: parsed.version };
}

export function loadTaskCapsulesWithStatus(storage: Pick<Storage, "getItem"> = localStorage): TaskStoreSnapshot {
  try {
    return parseTaskStore(storage.getItem(TASK_STORE_KEY));
  } catch {
    return { status: "corrupt", capsules: [], rejected: 0 };
  }
}

export function serializeTaskStore(capsules: TaskCapsule[]): string {
  if (capsules.length > MAX_TASK_CAPSULES) throw new RangeError(`任务胶囊最多保留 ${MAX_TASK_CAPSULES} 条。`);
  const stableCapsules = capsules.map((capsule) => JSON.parse(serializeTaskCapsule(capsule)) as TaskCapsule);
  const raw = JSON.stringify({ version: TASK_STORE_VERSION, savedAt: Date.now(), capsules: stableCapsules });
  if (raw.length > MAX_TASK_STORE_BYTES) throw new RangeError("任务胶囊已超过本机安全容量。");
  return raw;
}

export function saveTaskCapsules(
  capsules: TaskCapsule[],
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): { ok: true; bytes: number } | { ok: false; error: string } {
  const existing = loadTaskCapsulesWithStatus(storage);
  if (existing.status === "unsupported" || existing.status === "corrupt") {
    return { ok: false, error: "任务胶囊库的版本或完整性异常，已保留原字节并暂停自动保存。" };
  }
  try {
    const raw = serializeTaskStore(capsules);
    storage.setItem(TASK_STORE_KEY, raw);
    const verified = parseTaskStore(storage.getItem(TASK_STORE_KEY));
    if (verified.status !== "valid" || verified.capsules.length !== capsules.length) {
      throw new Error("回读不一致");
    }
    return { ok: true, bytes: raw.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "写入失败";
    return { ok: false, error: `任务胶囊没有保存成功（${message}）。` };
  }
}

export function upsertTaskCapsule(capsules: TaskCapsule[], incoming: TaskCapsule): TaskCapsule[] {
  const at = capsules.findIndex((capsule) => capsule.id === incoming.id);
  const next = at < 0
    ? [incoming, ...capsules]
    : capsules.map((capsule, index) => (index === at ? incoming : capsule));
  return next
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .slice(0, MAX_TASK_CAPSULES);
}
