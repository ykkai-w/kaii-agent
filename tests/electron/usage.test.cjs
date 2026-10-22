const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const usage = require("../../electron/lib/usage.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-usage-"));
}

test("记两次同一家：当天计数是 2，lastUsedAt 更新，文件 0600", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  usage.recordProviderUse(dir, "deepseek");
  usage.recordProviderUse(dir, "deepseek");
  const today = new Date().toISOString().slice(0, 10);
  const state = usage.readUsage(dir);
  assert.strictEqual(state.daily[today].deepseek, 2);
  assert.ok(state.lastUsedAt.deepseek > Date.now() - 5000);
  assert.strictEqual(fs.statSync(usage.usagePath(dir)).mode & 0o777, 0o600);
});

test("老格式（provider→时间戳）迁移后时间不丢", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(usage.usagePath(dir), JSON.stringify({ kimi: 1755500000000 }));
  const state = usage.readUsage(dir);
  assert.strictEqual(state.lastUsedAt.kimi, 1755500000000);
  usage.recordProviderUse(dir, "kimi");
  assert.ok(usage.readUsage(dir).lastUsedAt.kimi > 1755500000000);
});

test("小结：今天和近七天分开算，只记次数不记内容", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  usage.recordProviderUse(dir, "local");
  usage.recordProviderUse(dir, "glm");
  const summary = usage.summarizeUsage(dir);
  assert.strictEqual(summary.today.local, 1);
  assert.strictEqual(summary.week.glm, 1);
  const raw = fs.readFileSync(usage.usagePath(dir), "utf8");
  assert.ok(!raw.includes("content") && !raw.includes("messages"), "不该有任何内容字段");
});
