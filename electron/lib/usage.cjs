const fs = require("node:fs");
const path = require("node:path");

// 各家模型的使用记录：最近一次什么时候用的 + 每天用了几次。
//
// 只记「哪家、哪天、几次」——不记问了什么。这份文件的用途是
// 「key 是不是还活着」和「这周都在用谁」，不是行为日志。

function usagePath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("目录无效");
  return path.join(userDataPath, "provider-usage.json");
}

function readUsage(userDataPath) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(usagePath(userDataPath), "utf8"));
  } catch {
    return { lastUsedAt: {}, daily: {} };
  }
  // 老格式：{ provider: 时间戳 }。迁移成新形状，别丢已有的时间。
  if (parsed && typeof parsed === "object" && !parsed.lastUsedAt && !parsed.daily) {
    const lastUsedAt = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isFinite(value)) lastUsedAt[key] = Number(value);
    }
    return { lastUsedAt, daily: {} };
  }
  return {
    lastUsedAt: parsed.lastUsedAt && typeof parsed.lastUsedAt === "object" ? parsed.lastUsedAt : {},
    daily: parsed.daily && typeof parsed.daily === "object" ? parsed.daily : {},
  };
}

function recordProviderUse(userDataPath, provider) {
  const name = String(provider || "local").slice(0, 40);
  const usage = readUsage(userDataPath);
  usage.lastUsedAt[name] = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  if (!usage.daily[day]) usage.daily[day] = {};
  usage.daily[day][name] = (usage.daily[day][name] || 0) + 1;
  // 只留最近 30 天，别让这个文件无限长。
  const days = Object.keys(usage.daily).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 30))) delete usage.daily[old];
  const target = usagePath(userDataPath);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(usage), { mode: 0o600 });
  fs.renameSync(temp, target);
  return usage;
}

// 给设置页看的小结：今天各家几次、近七天各家几次。
function summarizeUsage(userDataPath) {
  const usage = readUsage(userDataPath);
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const todayCounts = usage.daily[today] || {};
  const week = {};
  for (const [day, counts] of Object.entries(usage.daily)) {
    if (day < weekAgo) continue;
    for (const [provider, count] of Object.entries(counts)) {
      week[provider] = (week[provider] || 0) + count;
    }
  }
  return { today: todayCounts, week };
}

module.exports = { readUsage, recordProviderUse, summarizeUsage, usagePath };
