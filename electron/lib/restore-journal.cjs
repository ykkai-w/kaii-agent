const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VERSION = 1;
const MAX_RAW_BYTES = 12_000_000;
const SNAPSHOT_KEYS = ["conversations", "legacyConversations", "projects", "prompts"];

function assertUserDataPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath) || userDataPath.length > 4096) {
    throw new TypeError("恢复日志目录无效");
  }
}

function journalDirectory(userDataPath) {
  assertUserDataPath(userDataPath);
  return path.join(userDataPath, "recovery", "restore-transactions");
}

function assertId(id) {
  if (typeof id !== "string" || !/^[0-9a-z][0-9a-z-]{2,127}$/i.test(id)) throw new TypeError("恢复事务 ID 无效");
  return id;
}

function validateSnapshot(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}无效`);
  if (Object.keys(value).some((key) => !SNAPSHOT_KEYS.includes(key))) throw new TypeError(`${label}含未知字段`);
  const clean = {};
  let bytes = 0;
  for (const key of SNAPSHOT_KEYS) {
    const item = value[key];
    if (item !== null && typeof item !== "string") throw new TypeError(`${label}.${key}无效`);
    bytes += item === null ? 0 : Buffer.byteLength(item, "utf8");
    clean[key] = item;
  }
  if (bytes > MAX_RAW_BYTES) throw new RangeError(`${label}超过恢复日志容量`);
  return clean;
}

function validatePrepared(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("恢复事务无效");
  const allowed = new Set(["version", "id", "createdAt", "status", "previous", "target"]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new TypeError(`恢复事务含未知字段：${key}`);
  if (payload.version !== VERSION) throw new TypeError("恢复事务版本无效");
  if (payload.status !== undefined && payload.status !== "prepared") throw new TypeError("恢复事务状态无效");
  if (!Number.isFinite(payload.createdAt) || payload.createdAt <= 0) throw new TypeError("恢复事务时间无效");
  return {
    version: VERSION,
    id: assertId(payload.id),
    createdAt: Number(payload.createdAt),
    status: "prepared",
    previous: validateSnapshot(payload.previous, "previous"),
    target: validateSnapshot(payload.target, "target"),
  };
}

function atomicWriteJson(target, payload) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function pendingPath(userDataPath, id) {
  return path.join(journalDirectory(userDataPath), `${assertId(id)}.pending.json`);
}

function prepareRestoreTransaction(userDataPath, payload) {
  const clean = validatePrepared(payload);
  const target = pendingPath(userDataPath, clean.id);
  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    if (JSON.stringify(existing) === JSON.stringify(clean)) return { ok: true, id: clean.id, alreadyPrepared: true };
    throw new Error("同名恢复事务已存在");
  }
  atomicWriteJson(target, clean);
  // 不只信 write/rename 没报错：当场读回和逐字比较。
  const reloaded = JSON.parse(fs.readFileSync(target, "utf8"));
  if (JSON.stringify(reloaded) !== JSON.stringify(clean)) throw new Error("恢复日志回读不一致");
  return { ok: true, id: clean.id, alreadyPrepared: false };
}

function listPendingFiles(userDataPath) {
  const directory = journalDirectory(userDataPath);
  try {
    return fs.readdirSync(directory)
      .filter((name) => /^[0-9a-z][0-9a-z-]{2,127}\.pending\.json$/i.test(name))
      .map((name) => ({ name, path: path.join(directory, name), mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function readPendingRestoreTransaction(userDataPath) {
  for (const entry of listPendingFiles(userDataPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(entry.path, "utf8"));
      const clean = validatePrepared(parsed);
      return clean;
    } catch {
      // 一份损坏日志不应隐藏更早的可恢复事务。
    }
  }
  return null;
}

function resolveRestoreTransaction(userDataPath, id, resolution) {
  assertUserDataPath(userDataPath);
  assertId(id);
  if (resolution !== "committed" && resolution !== "rolled_back") throw new TypeError("恢复事务结果无效");
  const source = pendingPath(userDataPath, id);
  if (!fs.existsSync(source)) return { ok: true, id, resolution, missing: true };
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  const clean = validatePrepared(parsed);
  const resolved = { ...clean, status: resolution, resolvedAt: Date.now() };
  const destination = path.join(journalDirectory(userDataPath), `${id}.${resolution}.json`);
  atomicWriteJson(destination, resolved);
  fs.unlinkSync(source);
  return { ok: true, id, resolution, missing: false };
}

module.exports = {
  MAX_RAW_BYTES,
  VERSION,
  journalDirectory,
  prepareRestoreTransaction,
  readPendingRestoreTransaction,
  resolveRestoreTransaction,
  validatePrepared,
};
