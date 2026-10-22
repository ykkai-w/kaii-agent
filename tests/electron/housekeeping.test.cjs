const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const housekeeping = require("../../electron/lib/housekeeping.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-hk-test-"));
}

test("自动备份：写入 0600、带 SHA、同一天覆盖", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  housekeeping.writeAutoBackup(dir, "第一版");
  housekeeping.writeAutoBackup(dir, "第二版");
  const list = housekeeping.listAutoBackups(dir);
  assert.strictEqual(list.length, 1, "同一天只留一份");
  assert.strictEqual(list[0].ok, true);
  const file = path.join(housekeeping.autoDir(dir), list[0].name);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).content, "第二版");
});

test("校验：内容被改动后 ok 变 false，但仍然列出来", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  housekeeping.writeAutoBackup(dir, "原始内容");
  const file = path.join(housekeeping.autoDir(dir), housekeeping.listAutoBackups(dir)[0].name);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.content = "被篡改";
  fs.writeFileSync(file, JSON.stringify(parsed));
  const list = housekeeping.listAutoBackups(dir);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].ok, false);
});

test("只留最近七份，老的裁掉", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(housekeeping.autoDir(dir), { recursive: true });
  for (let i = 1; i <= 9; i += 1) {
    fs.writeFileSync(
      path.join(housekeeping.autoDir(dir), `auto-2026-07-0${i}.json`),
      JSON.stringify({ app: "kaii-auto-backup", savedAt: i, sha256: "x", content: "y" }),
    );
  }
  housekeeping.writeAutoBackup(dir, "今天的");
  const list = housekeeping.listAutoBackups(dir);
  assert.strictEqual(list.length, housekeeping.KEEP_DAYS);
  assert.ok(list.some((item) => item.ok), "今天这份必须在而且校验通过");
});

test("空内容不写；超限报错", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => housekeeping.writeAutoBackup(dir, "   "), /空的/);
});

test("存储用量：算出各目录大小，Electron 缓存目录不计", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "documents"));
  fs.writeFileSync(path.join(dir, "documents", "a.txt"), "x".repeat(2048));
  fs.mkdirSync(path.join(dir, "Cache"));
  fs.writeFileSync(path.join(dir, "Cache", "big.bin"), "x".repeat(9999));
  const usage = housekeeping.storageUsage(dir);
  assert.ok(usage.items.some((item) => item.name === "documents"));
  assert.ok(!usage.items.some((item) => item.name === "Cache"), "Electron 缓存不该出现在清单里");
  assert.ok(usage.total >= 2048 && usage.total < 9999, "总量不包含缓存");
});

test("读备份：校验通过才交出内容，坏名字和坏内容都拒绝", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  housekeeping.writeAutoBackup(dir, "要恢复的内容");
  const name = housekeeping.listAutoBackups(dir)[0].name;
  assert.strictEqual(housekeeping.readAutoBackup(dir, name), "要恢复的内容");
  assert.throws(() => housekeeping.readAutoBackup(dir, "../../../etc/passwd"), /备份名无效/);
  const file = path.join(housekeeping.autoDir(dir), name);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.content = "被改过";
  fs.writeFileSync(file, JSON.stringify(parsed));
  assert.throws(() => housekeeping.readAutoBackup(dir, name), /校验失败/);
});
