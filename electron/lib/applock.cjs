const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 应用锁：开屏要输一个 4-8 位数字才能看到对话。
//
// 老实说清楚它是什么：**防路人，不防黑客**。同事路过、家人借电脑，
// 挡的是这种场景。数据文件本身没有加密，懂行的人绕过它不难。
// 界面上也这么写，不给用户虚假的安全感。
//
// 码不落盘明文：存 scrypt 加盐哈希，单独一个 0600 文件。
// 忘了码怎么办：删掉 userData 里的 applock.json 就解开——
// 这正是"防路人"级别应有的后门，写在提示里。

const CODE_PATTERN = /^[0-9]{4,8}$/;

function lockPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("目录无效");
  return path.join(userDataPath, "applock.json");
}

function hashCode(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString("hex");
}

function lockStatus(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(userDataPath), "utf8"));
    return { enabled: typeof parsed?.hash === "string" && typeof parsed?.salt === "string" };
  } catch {
    return { enabled: false };
  }
}

function setLockCode(userDataPath, rawCode) {
  const code = String(rawCode ?? "");
  if (!CODE_PATTERN.test(code)) throw new Error("锁码要 4 到 8 位数字。");
  const salt = crypto.randomBytes(16).toString("hex");
  const target = lockPath(userDataPath);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, salt, hash: hashCode(code, salt) })}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
  return { enabled: true };
}

function verifyLockCode(userDataPath, rawCode) {
  const code = String(rawCode ?? "");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath(userDataPath), "utf8"));
  } catch {
    return true; // 没设锁就等于开着门。
  }
  if (typeof parsed?.hash !== "string" || typeof parsed?.salt !== "string") return true;
  if (!CODE_PATTERN.test(code)) return false;
  const attempt = Buffer.from(hashCode(code, parsed.salt), "hex");
  const stored = Buffer.from(parsed.hash, "hex");
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

// 关锁要先给出正确的码，不然任何能点到设置的人都能把锁摘了。
function clearLockCode(userDataPath, rawCode) {
  if (!lockStatus(userDataPath).enabled) return { enabled: false };
  if (!verifyLockCode(userDataPath, rawCode)) throw new Error("锁码不对，没有关。");
  fs.unlinkSync(lockPath(userDataPath));
  return { enabled: false };
}

module.exports = { clearLockCode, lockPath, lockStatus, setLockCode, verifyLockCode };
