const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const screenshot = require("../../electron/lib/screenshot.cjs");

function fakeSpawn(behaviour) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => { child.killedOnce = true; };
    queueMicrotask(() => behaviour(child, { command, args }));
    return child;
  };
}

test("框选、选窗口、整屏各自的参数", () => {
  // -x 不播快门声：半夜截个图不该响一声。
  assert.deepEqual(screenshot.captureArguments("/tmp/a.png", { mode: "region" }), ["-x", "-i", "/tmp/a.png"]);
  assert.deepEqual(screenshot.captureArguments("/tmp/a.png", { mode: "window" }), ["-x", "-i", "-W", "/tmp/a.png"]);
  // 整屏要用 -m（只截主显示器）。-S 是"窗口模式下改截屏幕"，拿来当整屏用是错的。
  assert.deepEqual(screenshot.captureArguments("/tmp/a.png", { mode: "screen" }), ["-x", "-m", "/tmp/a.png"]);
  assert.throws(() => screenshot.captureArguments("/tmp/a.png", { mode: "乱写" }), /截图方式无效/);
});

test("截图只落在临时目录，不会掉到桌面上", () => {
  const target = screenshot.temporaryTarget();
  assert.ok(target.startsWith(os.tmpdir()), `落在了 ${target}`);
  assert.ok(target.includes("kaii-截图-"));
  assert.ok(target.endsWith(".png"));
  // 两次不能撞名，否则连着截两张会互相覆盖。
  assert.notEqual(screenshot.temporaryTarget(), screenshot.temporaryTarget());
});

test("按 esc 取消是正常操作，不是错误", async () => {
  const result = await screenshot.capture({
    // 退出码 0 但没写文件，就是用户取消了。
    spawnImpl: fakeSpawn((child) => child.emit("close", 0)),
  });
  assert.deepEqual(result, { ok: false, cancelled: true });
  assert.equal(result.message, undefined, "取消不该带错误消息，界面上不能弹东西");
});

test("真的失败时给的是能照着做的话，不是错误码", async () => {
  const result = await screenshot.capture({
    spawnImpl: fakeSpawn((child) => child.emit("close", 1)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, undefined);
  assert.match(result.message, /屏幕录制/);
});

test("截图程序起不来时如实说明", async () => {
  const result = await screenshot.capture({
    spawnImpl: fakeSpawn((child) => child.emit("error", new Error("ENOENT"))),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /起不来/);
});

test("截出东西来了就返回路径", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-shot-"));
  const result = await screenshot.capture({
    tmpdir: dir,
    spawnImpl: fakeSpawn((child, { args }) => {
      fs.writeFileSync(args.at(-1), "假装这是一张 png");
      child.emit("close", 0);
    }),
  });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.filePath));
  assert.equal(screenshot.discard(result.filePath), true);
  assert.equal(fs.existsSync(result.filePath), false, "用完没删掉");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("空文件当没截成，不会把 0 字节的东西当图片送下去", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-shot-"));
  const result = await screenshot.capture({
    tmpdir: dir,
    spawnImpl: fakeSpawn((child, { args }) => {
      fs.writeFileSync(args.at(-1), "");
      child.emit("close", 0);
    }),
  });
  assert.deepEqual(result, { ok: false, cancelled: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("删除只认自己造的文件，不会误删别的东西", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-shot-"));
  const innocent = path.join(dir, "用户的重要文件.png");
  fs.writeFileSync(innocent, "别删我");
  assert.equal(screenshot.discard(innocent), false);
  assert.equal(fs.existsSync(innocent), true, "误删了不是自己造的文件");
  assert.equal(screenshot.discard(""), false);
  assert.equal(screenshot.discard(null), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("截图前把主窗口让开，截完再放回来", () => {
  // 主窗口挡着要截的东西是最常见的情况。这段逻辑在 main.cjs 里，钉住它的形状。
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  const block = main.slice(main.indexOf("async function captureAndAttach"), main.indexOf('ipcMain.handle("image:discard"'));
  assert.match(block, /mainWindow\.hide\(\)/);
  assert.match(block, /finally/);
  assert.match(block, /mainWindow\.show\(\)/);
  // 原始截图不留在临时目录里。
  assert.match(block, /screenshot\.discard\(shot\.filePath\)/);
});

test("关掉剪贴板浮窗不会把截图快捷键一起关掉", () => {
  // 这两个功能没关系。截图快捷键原来写在 applyQuickHotkey 里面，
  // 而那个函数在 quickEnabled 为 false 时会提前 return——
  // 结果是用户一关浮窗，⌃⌘K 就悄悄失效了。
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  const body = main.slice(main.indexOf("function applyQuickHotkey"));
  const end = body.indexOf("\n}\n");
  const applyBody = body.slice(0, end);

  const registerAt = applyBody.indexOf("registerScreenshotHotkey()");
  const earlyReturnAt = applyBody.indexOf('return { registered: false, reason: "disabled" }');
  assert.ok(registerAt >= 0, "applyQuickHotkey 里没有注册截图快捷键");
  assert.ok(earlyReturnAt >= 0, "提前 return 那一支不见了，这条测试要重写");
  assert.ok(registerAt < earlyReturnAt, "截图快捷键注册排在提前 return 之后，关掉浮窗就失效了");
});

test("截图快捷键真的被注册了，不是写了没人调", () => {
  // 这个项目出过"函数写了但从没被调用"的问题，钉住整条链路。
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  assert.match(main, /function registerScreenshotHotkey/);
  assert.match(main, /globalShortcut\.register\("Control\+Command\+K"/);
  assert.match(main, /webContents\.send\("screenshot:requested"\)/);
  // preload 要把订阅暴露出去
  const preload = fs.readFileSync(path.join(__dirname, "../../electron/preload.cjs"), "utf8");
  assert.match(preload, /onScreenshotRequested/);
  assert.match(preload, /screenshot:requested/);
  // 界面要真的订阅了它
  const app = fs.readFileSync(path.join(__dirname, "../../src/App.tsx"), "utf8");
  assert.match(app, /onScreenshotRequested\(\(\) => \{/);
  assert.match(app, /activeConversation\.detachedContext/, "历史扩展对话继续保持只读");
  assert.match(app, /void captureScreen\(\)/);
});
