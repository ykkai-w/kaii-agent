const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 可靠性杂务：每日自动备份（留七天）、备份校验、存储用量。
//
// 自动备份的立场：它是「用户忘了手动备份」的兜底，不是同步盘。
// 每天最多一份，只留最近七份，写进 userData/backups/，带 SHA-256，
// 恢复前能先验完整性——备份最怕的不是没有，是要用时才发现是坏的。

const AUTO_DIR = "backups";
const KEEP_DAYS = 7;
const MAX_BACKUP_BYTES = 80 * 1024 * 1024;

function autoDir(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("目录无效");
  return path.join(userDataPath, AUTO_DIR);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// 一天一份：同一天再写就覆盖当天那份（内容以最后一次为准）。
function writeAutoBackup(userDataPath, content) {
  const body = String(content ?? "");
  if (!body.trim()) throw new Error("备份内容是空的，不写。");
  if (Buffer.byteLength(body, "utf8") > MAX_BACKUP_BYTES) throw new RangeError("备份太大，先清理一些对话或附件。");
  const dir = autoDir(userDataPath);
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(dir, `auto-${day}.json`);
  const envelope = { app: "kaii-auto-backup", savedAt: Date.now(), sha256: sha256(body), content: body };
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(envelope), { mode: 0o600 });
  fs.renameSync(temp, target);
  // 只留最近七份。按文件名排序即按日期排序。
  const kept = fs.readdirSync(dir).filter((name) => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  for (const name of kept.slice(0, Math.max(0, kept.length - KEEP_DAYS))) {
    fs.unlinkSync(path.join(dir, name));
  }
  return { file: target, day };
}

// 列出并逐份校验。坏的照样列出来并标明——沉默丢弃等于骗人。
function listAutoBackups(userDataPath) {
  const dir = autoDir(userDataPath);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^auto-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse();
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const ok = typeof parsed?.content === "string" && parsed?.sha256 === sha256(parsed.content);
      return { name, savedAt: Number(parsed?.savedAt) || 0, bytes: fs.statSync(file).size, ok };
    } catch {
      return { name, savedAt: 0, bytes: 0, ok: false };
    }
  });
}

function directorySize(target, depthLeft) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    try {
      if (entry.isDirectory()) {
        if (depthLeft > 0) total += directorySize(full, depthLeft - 1);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // 读不到的跳过，别让一个坏文件毁掉整个统计。
    }
  }
  return total;
}

// 数据目录里什么占地方。只看第一层的条目，各自往下最多再走 6 层。
function storageUsage(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("目录无效");
  let entries = [];
  try {
    entries = fs.readdirSync(userDataPath, { withFileTypes: true });
  } catch {
    return { total: 0, items: [] };
  }
  const items = [];
  for (const entry of entries) {
    // Electron 自己的缓存目录体积大又不归我们管，跳过免得吓人。
    if (/^(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|Shared Dictionary|Session Storage|Local Storage|IndexedDB)$/i.test(entry.name)) continue;
    const full = path.join(userDataPath, entry.name);
    try {
      const bytes = entry.isDirectory() ? directorySize(full, 6) : fs.statSync(full).size;
      if (bytes > 0) items.push({ name: entry.name, bytes });
    } catch {
      // 跳过。
    }
  }
  items.sort((a, b) => b.bytes - a.bytes);
  return { total: items.reduce((sum, item) => sum + item.bytes, 0), items: items.slice(0, 10) };
}

// 读一份自动备份的内容。名字必须是我们自己的命名格式（防路径穿越），
// SHA 对不上就拒绝交出——坏备份宁可报错也不能拿去恢复。
function readAutoBackup(userDataPath, name) {
  if (typeof name !== "string" || !/^auto-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
    throw new TypeError("备份名无效");
  }
  const parsed = JSON.parse(fs.readFileSync(path.join(autoDir(userDataPath), name), "utf8"));
  if (typeof parsed?.content !== "string" || parsed?.sha256 !== sha256(parsed.content)) {
    throw new Error("这份备份校验失败（内容和指纹对不上），不能用来恢复。");
  }
  return parsed.content;
}

module.exports = { KEEP_DAYS, autoDir, listAutoBackups, readAutoBackup, storageUsage, writeAutoBackup };
