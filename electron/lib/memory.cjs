const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_MEMORY_COUNT = 200;
const MAX_MEMORY_LENGTH = 4000;
const MAX_CONTEXT_BYTES = 6000;
const MEMORY_STATES = new Set(["valid", "superseded", "disputed"]);

const databaseCache = new Map();

function assertUserDataPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath) || userDataPath.length > 4096) {
    throw new TypeError("记忆目录无效");
  }
}

function databasePath(userDataPath) {
  assertUserDataPath(userDataPath);
  return path.join(userDataPath, "data", "kaii.sqlite3");
}

function openMemoryDatabase(userDataPath) {
  const target = databasePath(userDataPath);
  if (databaseCache.has(target)) return databaseCache.get(target);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(target);
  database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND ${MAX_MEMORY_LENGTH}),
      kind TEXT NOT NULL CHECK(kind IN ('note','preference','project','fact')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memories_active_updated ON memories(archived, pinned DESC, updated_at DESC);
  `);
  const columns = new Set(database.prepare("PRAGMA table_info(memories)").all().map((row) => row.name));
  const migrations = [
    ["source_json", "TEXT NOT NULL DEFAULT '{\"kind\":\"user\"}'"],
    ["scope_kind", "TEXT NOT NULL DEFAULT 'global'"],
    ["scope_id", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'valid'"],
    ["supersedes", "TEXT"],
    ["reason", "TEXT"],
  ];
  for (const [column, definition] of migrations) {
    if (!columns.has(column)) database.exec(`ALTER TABLE memories ADD COLUMN ${column} ${definition}`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      memory_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('created','updated','archived','restored')),
      occurred_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_audit_by_memory ON memory_audit_events(memory_id, sequence);
  `);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    database.close();
    throw new Error("无法保护记忆数据库权限");
  }
  databaseCache.set(target, database);
  return database;
}

function normalizeContent(content) {
  if (typeof content !== "string") throw new TypeError("记忆内容必须是文字");
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized.length > MAX_MEMORY_LENGTH || /\u0000/.test(normalized)) {
    throw new RangeError("记忆内容长度无效");
  }
  return normalized;
}

function normalizeKind(kind) {
  const value = kind ?? "note";
  if (!["note", "preference", "project", "fact"].includes(value)) throw new TypeError("记忆类型无效");
  return value;
}

function normalizeSource(source) {
  const value = source ?? { kind: "user" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("记忆来源无效");
  const keys = Object.keys(value);
  if (!keys.length || keys.length > 12 || typeof value.kind !== "string" || !value.kind.trim() || value.kind.length > 80) throw new TypeError("记忆来源无效");
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new TypeError("记忆来源无效"); }
  if (!encoded || encoded.length > 4000 || encoded.includes("\\u0000")) throw new TypeError("记忆来源无效");
  return JSON.parse(encoded);
}

function normalizeScope(scope) {
  const value = scope ?? { kind: "global", id: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("记忆范围无效");
  if (value.kind === "global" && value.id === null) return { kind: "global", id: null };
  if (!["project", "conversation"].includes(value.kind) || typeof value.id !== "string" || !value.id.trim() || value.id.length > 200) {
    throw new TypeError("记忆范围无效");
  }
  return { kind: value.kind, id: value.id.trim() };
}

function normalizeTraceFields(payload, current = null) {
  const source = payload.source === undefined && current ? JSON.parse(current.source_json) : normalizeSource(payload.source);
  const scope = payload.scope === undefined && current ? { kind: current.scope_kind, id: current.scope_id } : normalizeScope(payload.scope);
  const status = payload.status === undefined && current ? current.status : (payload.status ?? "valid");
  if (!MEMORY_STATES.has(status)) throw new TypeError("记忆状态无效");
  const supersedes = payload.supersedes === undefined && current ? current.supersedes : (payload.supersedes ?? null);
  if (supersedes !== null && (typeof supersedes !== "string" || !/^[0-9a-f-]{36}$/i.test(supersedes))) throw new TypeError("supersedes无效");
  const reason = payload.reason === undefined && current ? current.reason : (payload.reason ?? null);
  if (reason !== null && (typeof reason !== "string" || !reason.trim() || reason.length > 2000)) throw new TypeError("记忆原因无效");
  if (status !== "valid" && reason === null) throw new TypeError("非valid记忆必须说明原因");
  return { source, scope, status, supersedes, reason: reason && reason.trim() };
}

function rowToMemory(row) {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? null,
    useCount: row.use_count,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    source: JSON.parse(row.source_json),
    scope: { kind: row.scope_kind, id: row.scope_id ?? null },
    status: row.status,
    supersedes: row.supersedes ?? null,
    reason: row.reason ?? null,
  };
}

function appendAuditEvent(database, action, memory) {
  database.prepare("INSERT INTO memory_audit_events(event_id,memory_id,action,occurred_at,snapshot_json) VALUES(?,?,?,?,?)")
    .run(crypto.randomUUID(), memory.id, action, Date.now(), JSON.stringify(memory));
}

function listMemoryAuditEvents(userDataPath, { memoryId = null } = {}) {
  if (memoryId !== null && (typeof memoryId !== "string" || !/^[0-9a-f-]{36}$/i.test(memoryId))) throw new TypeError("记忆ID无效");
  const database = openMemoryDatabase(userDataPath);
  const rows = memoryId === null
    ? database.prepare("SELECT * FROM memory_audit_events ORDER BY sequence").all()
    : database.prepare("SELECT * FROM memory_audit_events WHERE memory_id=? ORDER BY sequence").all(memoryId);
  return rows.map((row) => ({ sequence: row.sequence, eventId: row.event_id, memoryId: row.memory_id, action: row.action, occurredAt: row.occurred_at, snapshot: JSON.parse(row.snapshot_json) }));
}

function listMemories(userDataPath, { includeArchived = false } = {}) {
  const database = openMemoryDatabase(userDataPath);
  const rows = includeArchived
    ? database.prepare("SELECT * FROM memories ORDER BY archived, pinned DESC, updated_at DESC").all()
    : database.prepare("SELECT * FROM memories WHERE archived=0 ORDER BY pinned DESC, updated_at DESC").all();
  return rows.map(rowToMemory);
}

function createMemory(userDataPath, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("记忆请求无效");
  const allowed = new Set(["content", "kind", "pinned", "source", "scope", "status", "supersedes", "reason"]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new TypeError(`记忆请求含未知字段：${key}`);
  const database = openMemoryDatabase(userDataPath);
  const count = Number(database.prepare("SELECT count(*) AS n FROM memories WHERE archived=0").get().n);
  if (count >= MAX_MEMORY_COUNT) throw new RangeError(`最多保存${MAX_MEMORY_COUNT}条记忆`);
  const content = normalizeContent(payload.content);
  const kind = normalizeKind(payload.kind);
  if (payload.pinned !== undefined && typeof payload.pinned !== "boolean") throw new TypeError("pinned无效");
  const trace = normalizeTraceFields(payload);
  const now = Date.now();
  const id = crypto.randomUUID();
  if (trace.supersedes && !database.prepare("SELECT 1 FROM memories WHERE id=?").get(trace.supersedes)) throw new Error("被替代的记忆不存在");
  database.prepare(`
    INSERT INTO memories(id,content,kind,created_at,updated_at,pinned,archived,source_json,scope_kind,scope_id,status,supersedes,reason)
    VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?)
  `).run(id, content, kind, now, now, payload.pinned ? 1 : 0, JSON.stringify(trace.source), trace.scope.kind, trace.scope.id, trace.status, trace.supersedes, trace.reason);
  const created = rowToMemory(database.prepare("SELECT * FROM memories WHERE id=?").get(id));
  appendAuditEvent(database, "created", created);
  return created;
}

function updateMemory(userDataPath, id, patch) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("记忆ID无效");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("记忆更新无效");
  const allowed = new Set(["content", "kind", "pinned", "source", "scope", "status", "supersedes", "reason"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new TypeError(`记忆更新含未知字段：${key}`);
  const database = openMemoryDatabase(userDataPath);
  const current = database.prepare("SELECT * FROM memories WHERE id=?").get(id);
  if (!current) throw new Error("记忆不存在");
  const content = patch.content === undefined ? current.content : normalizeContent(patch.content);
  const kind = patch.kind === undefined ? current.kind : normalizeKind(patch.kind);
  const pinned = patch.pinned === undefined ? current.pinned : (typeof patch.pinned === "boolean" ? Number(patch.pinned) : (() => { throw new TypeError("pinned无效"); })());
  const trace = normalizeTraceFields(patch, current);
  if (trace.supersedes === id) throw new TypeError("记忆不能替代自己");
  if (trace.supersedes && !database.prepare("SELECT 1 FROM memories WHERE id=?").get(trace.supersedes)) throw new Error("被替代的记忆不存在");
  database.prepare("UPDATE memories SET content=?,kind=?,pinned=?,updated_at=?,source_json=?,scope_kind=?,scope_id=?,status=?,supersedes=?,reason=? WHERE id=?")
    .run(content, kind, pinned, Date.now(), JSON.stringify(trace.source), trace.scope.kind, trace.scope.id, trace.status, trace.supersedes, trace.reason, id);
  const updated = rowToMemory(database.prepare("SELECT * FROM memories WHERE id=?").get(id));
  appendAuditEvent(database, "updated", updated);
  return updated;
}

function archiveMemory(userDataPath, id, archived = true) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("记忆ID无效");
  if (typeof archived !== "boolean") throw new TypeError("archived无效");
  const database = openMemoryDatabase(userDataPath);
  const result = database.prepare("UPDATE memories SET archived=?,updated_at=? WHERE id=?")
    .run(archived ? 1 : 0, Date.now(), id);
  if (Number(result.changes) !== 1) throw new Error("记忆不存在");
  const snapshot = rowToMemory(database.prepare("SELECT * FROM memories WHERE id=?").get(id));
  appendAuditEvent(database, archived ? "archived" : "restored", snapshot);
  return { ok: true, id, archived };
}

function grams(text) {
  const normalized = String(text).toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
  const values = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) || []);
  const compact = normalized.replace(/\s+/g, "");
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    if (/^[\p{L}\p{N}]{2}$/u.test(gram)) values.add(gram);
  }
  return { normalized, values };
}

function selectRelevantMemories(memories, query, { limit = 6, maxBytes = MAX_CONTEXT_BYTES } = {}) {
  if (!Array.isArray(memories)) return [];
  const queryGrams = grams(query);
  const supersededIds = new Set(memories
    .filter((memory) => memory && !memory.archived && (memory.status === undefined || memory.status === "valid") && typeof memory.supersedes === "string")
    .map((memory) => memory.supersedes));
  const scored = memories.filter((memory) => memory && !memory.archived
    && (memory.status === undefined || memory.status === "valid")
    && !supersededIds.has(memory.id)).flatMap((memory) => {
    const candidate = grams(memory.content);
    let score = memory.pinned ? 2 : 0;
    let lexicalMatches = 0;
    if (queryGrams.normalized && candidate.normalized.includes(queryGrams.normalized)) {
      score += 100;
      lexicalMatches += 1;
    }
    for (const value of queryGrams.values) {
      if (!candidate.values.has(value)) continue;
      lexicalMatches += 1;
      score += value.length >= 3 ? 5 : 1;
    }
    if (!memory.pinned && lexicalMatches === 0) return [];
    return [{ memory, score }];
  }).sort((a, b) => b.score - a.score || Number(b.memory.pinned) - Number(a.memory.pinned) || b.memory.updatedAt - a.memory.updatedAt);

  const selected = [];
  let bytes = 0;
  for (const { memory } of scored) {
    if (selected.length >= limit) break;
    const cost = Buffer.byteLength(memory.content, "utf8") + 48;
    if (bytes + cost > maxBytes) continue;
    selected.push(memory);
    bytes += cost;
  }
  return selected;
}

function markMemoriesUsed(userDataPath, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const database = openMemoryDatabase(userDataPath);
  const update = database.prepare("UPDATE memories SET last_used_at=?,use_count=use_count+1 WHERE id=? AND archived=0");
  const now = Date.now();
  for (const id of ids) if (typeof id === "string") update.run(now, id);
}

function resetMemoryDatabaseCache() {
  for (const database of databaseCache.values()) database.close();
  databaseCache.clear();
}

module.exports = {
  MAX_CONTEXT_BYTES,
  MAX_MEMORY_COUNT,
  archiveMemory,
  createMemory,
  databasePath,
  listMemories,
  listMemoryAuditEvents,
  markMemoriesUsed,
  openMemoryDatabase,
  resetMemoryDatabaseCache,
  selectRelevantMemories,
  updateMemory,
};
