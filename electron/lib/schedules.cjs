const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 定时任务：让 kaii 到点自己跑一次，结果攒着，回来一起看。
//
// 刻意做得很克制：只支持"每天几点""每小时""每周几几点"这三种，
// 不做 cron 表达式。个人用途里真正会用到的就这几种，而 cron 写错了
// 还得调半天。所有判断都基于本机时间，不联网校时。

const MAX_SCHEDULES = 20;
const MAX_PROMPT_LENGTH = 2000;
const MAX_RESULTS_KEPT = 20;

function schedulesPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("定时任务目录无效");
  return path.join(userDataPath, "schedules.json");
}

function readStore(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(schedulesPath(userDataPath), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { schedules: [] };
  } catch {
    return { schedules: [] };
  }
}

function writeStore(userDataPath, store) {
  const target = schedulesPath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function validateSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("定时任务无效");
  const label = String(input.label ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("要让它做什么？先写一句");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new RangeError("这段话太长了");

  const every = input.every;
  if (!["hour", "day", "week", "month"].includes(every)) throw new TypeError("重复方式无效");

  // 每月只支持 1-28 号：29/30/31 在短月会整月漏跑，
  // 与其做"最后一天"这种规则，不如直接不许选。
  const dayOfMonth = Number(input.dayOfMonth ?? 1);
  if (every === "month" && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new RangeError("每月只能选 1 到 28 号");
  }

  const hour = Number(input.hour);
  const minute = Number(input.minute);
  if (every !== "hour" && (!Number.isInteger(hour) || hour < 0 || hour > 23)) throw new RangeError("小时无效");
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError("分钟无效");

  const weekday = Number(input.weekday);
  if (every === "week" && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new RangeError("星期无效");

  return {
    label: label || prompt.slice(0, 20),
    prompt,
    every,
    hour: every === "hour" ? 0 : hour,
    minute,
    weekday: every === "week" ? weekday : 0,
    provider: typeof input.provider === "string" ? input.provider : "",
    model: typeof input.model === "string" ? input.model : "",
    dayOfMonth: every === "month" ? dayOfMonth : 0,
    // 到点跑的时候要不要带联网 / 翻资料。
    useWeb: input.useWeb === true,
    useKnowledge: input.useKnowledge === true,
    // 结果里出现这个词才通知（空 = 每次都通知）。
    // 场景：「盯着某个价格，跌破了才告诉我」。
    notifyKeyword: typeof input.notifyKeyword === "string" ? input.notifyKeyword.trim().slice(0, 40) : "",
    enabled: input.enabled !== false,
  };
}

// 下一次该在什么时候跑。从 `from` 往后找第一个满足条件的时刻，
// 永远返回未来的时间点，不会算出一个已经过去的。
function nextRunAt(schedule, from = Date.now()) {
  const base = new Date(from);
  const candidate = new Date(base);
  candidate.setSeconds(0, 0);

  if (schedule.every === "hour") {
    candidate.setMinutes(schedule.minute);
    if (candidate.getTime() <= from) candidate.setHours(candidate.getHours() + 1);
    return candidate.getTime();
  }

  candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.every === "day") {
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  if (schedule.every === "month") {
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
    candidate.setDate(schedule.dayOfMonth || 1);
    // setDate 在目标日大于当月天数时会溢出到下月，但 1-28 不会。
    if (candidate.getTime() <= from) {
      candidate.setMonth(candidate.getMonth() + 1, schedule.dayOfMonth || 1);
    }
    return candidate.getTime();
  }

  // 每周：先挪到目标星期，再确认是不是已经过了。
  const dayGap = (schedule.weekday - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + dayGap);
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

function listSchedules(userDataPath) {
  const store = readStore(userDataPath);
  const schedules = Array.isArray(store.schedules) ? store.schedules : [];
  return schedules.flatMap((item) => {
    if (!item || typeof item.id !== "string" || typeof item.prompt !== "string") return [];
    return [{
      ...item,
      pausedUntil: Number.isFinite(item.pausedUntil) ? Number(item.pausedUntil) : 0,
      nextRunAt: item.enabled ? nextRunAt(item) : 0,
      results: Array.isArray(item.results) ? item.results.slice(-MAX_RESULTS_KEPT) : [],
    }];
  });
}

function saveSchedules(userDataPath, schedules) {
  writeStore(userDataPath, { schemaVersion: 1, schedules });
  return listSchedules(userDataPath);
}

function addSchedule(userDataPath, input) {
  const existing = listSchedules(userDataPath);
  if (existing.length >= MAX_SCHEDULES) throw new RangeError(`最多 ${MAX_SCHEDULES} 个定时任务`);
  const schedule = { id: crypto.randomUUID(), ...validateSchedule(input), lastRunAt: 0, results: [] };
  return saveSchedules(userDataPath, [...existing, schedule]);
}

function updateSchedule(userDataPath, id, patch) {
  const schedules = listSchedules(userDataPath).map((item) => {
    if (item.id !== id) return item;
    if (Object.keys(patch).length === 1 && typeof patch.enabled === "boolean") {
      return { ...item, enabled: patch.enabled };
    }
    return { ...item, ...validateSchedule({ ...item, ...patch }) };
  });
  return saveSchedules(userDataPath, schedules);
}

function removeSchedule(userDataPath, id) {
  return saveSchedules(userDataPath, listSchedules(userDataPath).filter((item) => item.id !== id));
}

// 记一次运行结果。成功失败都记，失败也要留下原因——
// 定时任务是背着人跑的，出了问题必须能回头查。
// 失败了要不要再试一次。网络抖一下就整轮作废，第二天才知道，太亏。
// 只重试一次，而且只重试"看起来像临时问题"的：连不上、超时、限流。
// 模型说不出话、参数写错了，重试一百次也是一样的结果。
const RETRIABLE = /超时|timeout|ECONN|network|fetch failed|429|502|503|504|没连上/i;

function shouldRetry(errorMessage, attempts) {
  return attempts < 1 && RETRIABLE.test(String(errorMessage ?? ""));
}

function recordRun(userDataPath, id, result) {
  const schedules = listSchedules(userDataPath).map((item) => {
    if (item.id !== id) return item;
    const entry = {
      at: Date.now(),
      ok: result.ok === true,
      text: String(result.text ?? "").slice(0, 4000),
      error: result.ok === true ? "" : String(result.error ?? "没跑成").slice(0, 300),
      unread: true,
    };
    const results = [...item.results, entry].slice(-MAX_RESULTS_KEPT);
    // 连着失败三次就自动停用。任务坏了还每天跑，攒一屏的失败没有意义；
    // 停用的原因写进最后一条结果里，用户看得到为什么。
    const trailingFails = (() => {
      let count = 0;
      for (let index = results.length - 1; index >= 0; index -= 1) {
        if (results[index].ok) break;
        count += 1;
      }
      return count;
    })();
    const autoDisabled = !entry.ok && trailingFails >= 3;
    if (autoDisabled) {
      results[results.length - 1] = {
        ...entry,
        error: `${entry.error}（连续失败 3 次，这个任务已经自动停用。修好后手动打开。）`,
      };
    }
    return {
      ...item,
      enabled: autoDisabled ? false : item.enabled,
      lastRunAt: entry.at,
      results,
    };
  });
  return saveSchedules(userDataPath, schedules);
}

// 暂停到某个时刻。休假一周不想让早报白跑，回来自动恢复。
function pauseUntil(userDataPath, id, untilMs) {
  if (!Number.isInteger(untilMs) || untilMs < 0) throw new TypeError("暂停时间无效");
  const schedules = listSchedules(userDataPath).map((item) => (
    item.id === id ? { ...item, pausedUntil: untilMs } : item
  ));
  return saveSchedules(userDataPath, schedules);
}

function markRead(userDataPath, id) {
  const schedules = listSchedules(userDataPath).map((item) => (
    item.id === id ? { ...item, results: item.results.map((entry) => ({ ...entry, unread: false })) } : item
  ));
  return saveSchedules(userDataPath, schedules);
}

// 到点了该跑哪些。允许一点点迟到（应用刚启动、机器刚唤醒），
// 但迟到太久就跳过这一次，免得开机时一次性补跑一堆。
function dueSchedules(userDataPath, now = Date.now(), { graceMs = 5 * 60_000 } = {}) {
  return listSchedules(userDataPath).filter((item) => {
    if (!item.enabled) return false;
    // 暂停到某天：还没到就当不存在。
    if (item.pausedUntil && now < item.pausedUntil) return false;
    const previous = nextRunAt(item, item.lastRunAt || (now - 24 * 3600_000));
    return previous <= now && now - previous <= graceMs;
  });
}

function unreadCount(userDataPath) {
  return listSchedules(userDataPath).reduce(
    (total, item) => total + item.results.filter((entry) => entry.unread).length,
    0,
  );
}

module.exports = {
  MAX_SCHEDULES,
  addSchedule,
  dueSchedules,
  listSchedules,
  markRead,
  nextRunAt,
  pauseUntil,
  recordRun,
  removeSchedule,
  schedulesPath,
  shouldRetry,
  unreadCount,
  updateSchedule,
  validateSchedule,
};
