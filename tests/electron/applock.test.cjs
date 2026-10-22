const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const applock = require("../../electron/lib/applock.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-applock-"));
}

test("没设锁时：状态关着，任何码都放行", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(applock.lockStatus(dir).enabled, false);
  assert.strictEqual(applock.verifyLockCode(dir, "0000"), true);
});

test("设锁：对码放行、错码拦下、文件是 0600", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  applock.setLockCode(dir, "24680");
  assert.strictEqual(applock.lockStatus(dir).enabled, true);
  assert.strictEqual(applock.verifyLockCode(dir, "24680"), true);
  assert.strictEqual(applock.verifyLockCode(dir, "11111"), false);
  assert.strictEqual(applock.verifyLockCode(dir, ""), false);
  const mode = fs.statSync(applock.lockPath(dir)).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test("锁文件里没有明文码，只有加盐哈希", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  applock.setLockCode(dir, "13579");
  const raw = fs.readFileSync(applock.lockPath(dir), "utf8");
  assert.ok(!raw.includes("13579"), "明文码出现在锁文件里");
  const parsed = JSON.parse(raw);
  assert.match(parsed.hash, /^[0-9a-f]{64}$/);
  assert.match(parsed.salt, /^[0-9a-f]{32}$/);
});

test("关锁要先给对码；给错码锁还在", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  applock.setLockCode(dir, "8888");
  assert.throws(() => applock.clearLockCode(dir, "9999"), /锁码不对/);
  assert.strictEqual(applock.lockStatus(dir).enabled, true);
  applock.clearLockCode(dir, "8888");
  assert.strictEqual(applock.lockStatus(dir).enabled, false);
});

test("码的格式：4-8 位数字，别的不收", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => applock.setLockCode(dir, "123"), /4 到 8 位/);
  assert.throws(() => applock.setLockCode(dir, "123456789"), /4 到 8 位/);
  assert.throws(() => applock.setLockCode(dir, "abcd"), /4 到 8 位/);
});
