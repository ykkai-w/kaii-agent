const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const agentTools = require("../../electron/lib/agent-tools.cjs");

const originalLoad = Module._load;
const previousTestMode = process.env.KAII_ELECTRON_TEST;
process.env.KAII_ELECTRON_TEST = "1";
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp/kaii-process-test", isPackaged: false, on() {}, whenReady: async () => {} },
      BrowserWindow: class {},
      dialog: {},
      ipcMain: { handle() {} },
      nativeTheme: {},
      nativeImage: {},
      shell: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { __test: mainSubject } = require("../../electron/main.cjs");
Module._load = originalLoad;
if (previousTestMode === undefined) delete process.env.KAII_ELECTRON_TEST;
else process.env.KAII_ELECTRON_TEST = previousTestMode;

const temporaryDirectories = [];
const emergencyProcessGroups = new Set();
const emergencyProcessIds = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(`${label}超时${lastError ? `：${lastError.message}` : ""}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function createProcessTreeFixture(label, {
  parentExitsAfterChildReady = false,
  childDetached = false,
  childClearsRunToken = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kaii-process-tree-${label}-`));
  temporaryDirectories.push(root);
  const project = path.join(root, "project");
  const userDataPath = path.join(root, "userdata");
  fs.mkdirSync(project);
  fs.mkdirSync(userDataPath);

  const parentScript = path.join(project, "parent.cjs");
  const childScript = path.join(project, "child.cjs");
  const parentPidPath = path.join(project, "parent.pid");
  const childStatePath = path.join(project, "child.json");
  const heartbeatPath = path.join(project, "heartbeat.log");

  fs.writeFileSync(childScript, [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    `const statePath = ${JSON.stringify(childStatePath)};`,
    `const heartbeatPath = ${JSON.stringify(heartbeatPath)};`,
    'const server = net.createServer((socket) => socket.end("alive"));',
    'server.listen(0, "127.0.0.1", () => {',
    '  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: server.address().port }));',
    '  fs.appendFileSync(heartbeatPath, "x");',
    '  process.send?.("ready");',
    '});',
    'setInterval(() => fs.appendFileSync(heartbeatPath, "x"), 20);',
    '',
  ].join("\n"));

  const parentLines = [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `const childScript = ${JSON.stringify(childScript)};`,
    `const parentPidPath = ${JSON.stringify(parentPidPath)};`,
    'fs.writeFileSync(parentPidPath, String(process.pid));',
  ];
  const childEnv = childClearsRunToken
    ? ', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "KAII_RUN_PROCESS_TOKEN"))'
    : "";
  if (parentExitsAfterChildReady) {
    parentLines.push(
      `const child = spawn(process.execPath, [childScript], { detached: ${childDetached}, stdio: ["ignore", "ignore", "ignore", "ipc"]${childEnv} });`,
      ...(childDetached ? ['child.unref();'] : []),
      'child.once("message", () => {',
      '  child.disconnect();',
      '  process.exit(0);',
      '});',
    );
  } else {
    parentLines.push(
      `const child = spawn(process.execPath, [childScript], { detached: ${childDetached}, stdio: "ignore"${childEnv} });`,
      ...(childDetached ? ['child.unref();'] : []),
      'setInterval(() => {}, 1000);',
    );
  }
  fs.writeFileSync(parentScript, `${parentLines.join("\n")}\n`);

  return { project, userDataPath, parentScript, parentPidPath, childStatePath, heartbeatPath };
}

async function waitForFixture(fixture) {
  return waitUntil(() => {
    if (!fs.existsSync(fixture.parentPidPath) || !fs.existsSync(fixture.childStatePath)) return null;
    const parentPid = Number(fs.readFileSync(fixture.parentPidPath, "utf8"));
    const child = JSON.parse(fs.readFileSync(fixture.childStatePath, "utf8"));
    if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(child.pid) || !Number.isSafeInteger(child.port)) return null;
    emergencyProcessGroups.add(parentPid);
    emergencyProcessIds.add(parentPid);
    emergencyProcessIds.add(child.pid);
    return { parentPid, childPid: child.pid, port: child.port };
  }, "等待父孙进程启动");
}

async function assertFixtureStopped(fixture, running) {
  await waitUntil(
    () => !processExists(running.parentPid) && !processExists(running.childPid),
    "等待父孙进程退出",
  );
  assert.equal(await canConnect(running.port), false, "孙进程的监听端口应已释放");
  const firstSize = fs.existsSync(fixture.heartbeatPath) ? fs.statSync(fixture.heartbeatPath).size : 0;
  await delay(160);
  const secondSize = fs.existsSync(fixture.heartbeatPath) ? fs.statSync(fixture.heartbeatPath).size : 0;
  assert.equal(secondSize, firstSize, "孙进程的心跳文件不应继续增长");
  emergencyProcessGroups.delete(running.parentPid);
  emergencyProcessIds.delete(running.parentPid);
  emergencyProcessIds.delete(running.childPid);
}

async function forceStopEscapedFixture(fixture, running) {
  try { process.kill(-running.childPid, "SIGKILL"); } catch {}
  try { process.kill(running.childPid, "SIGKILL"); } catch {}
  await waitUntil(() => !processExists(running.childPid), "等待边界 PoC 孙进程退出");
  assert.equal(await canConnect(running.port), false, "边界 PoC 的监听端口应已释放");
  const firstSize = fs.existsSync(fixture.heartbeatPath) ? fs.statSync(fixture.heartbeatPath).size : 0;
  await delay(160);
  const secondSize = fs.existsSync(fixture.heartbeatPath) ? fs.statSync(fixture.heartbeatPath).size : 0;
  assert.equal(secondSize, firstSize, "边界 PoC 的心跳应已停止");
  emergencyProcessGroups.delete(running.parentPid);
  emergencyProcessIds.delete(running.parentPid);
  emergencyProcessIds.delete(running.childPid);
}

function runFixture(fixture, { signal, timeoutMs }) {
  return agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: [fixture.parentScript], timeout_ms: timeoutMs } },
    {
      root: fixture.project,
      writable: true,
      userDataPath: fixture.userDataPath,
      callId: `process-tree-${Date.now()}`,
      signal,
    },
  );
}

test.after(() => {
  if (process.platform !== "win32") {
    for (const pid of emergencyProcessGroups) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
    for (const pid of emergencyProcessIds) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

test("run_test abort kills the parent and descendant process group", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("abort");
  const controller = new AbortController();
  const runningPromise = runFixture(fixture, { signal: controller.signal, timeoutMs: 10_000 });
  const running = await waitForFixture(fixture);
  assert.equal(await canConnect(running.port), true, "测试前要确认孙进程真的在监听");

  controller.abort();
  await assert.rejects(runningPromise, (error) => error?.name === "AbortError");
  await assertFixtureStopped(fixture, running);
});

test("run_test timeout kills the parent and descendant process group", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("timeout");
  const runningPromise = runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 1000 });
  const running = await waitForFixture(fixture);
  assert.equal(await canConnect(running.port), true, "测试前要确认孙进程真的在监听");

  const result = await runningPromise;
  assert.equal(result.meta.timedOut, true);
  assert.equal(result.meta.exitCode, null);
  await assertFixtureStopped(fixture, running);
});

test("run_test still returns successful command output", async () => {
  const fixture = createProcessTreeFixture("success");
  const successScript = path.join(fixture.project, "success.cjs");
  fs.writeFileSync(successScript, 'process.stdout.write("ordinary success\\n");\n');
  const result = await agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: [successScript], timeout_ms: 5000 } },
    {
      root: fixture.project,
      writable: true,
      userDataPath: fixture.userDataPath,
      callId: "process-tree-success",
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.meta.exitCode, 0);
  assert.equal(result.meta.timedOut, false);
  assert.match(result.detail, /ordinary success/);
});

test("run_test preserves exit 0 but cleans descendants left by a normally exited parent", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("normal-exit", { parentExitsAfterChildReady: true });
  const result = await runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 5000 });
  const running = await waitForFixture(fixture);

  // 孙进程只有在 listen 回调中写完状态和第一次心跳后，才会通知父进程 0 退出。
  assert.ok(fs.statSync(fixture.heartbeatPath).size > 0, "清理前孙进程应已启动心跳");
  assert.equal(result.meta.exitCode, 0, "清理后台孙进程不得改掉父进程的真实退出码");
  assert.equal(result.meta.timedOut, false);
  assert.equal(result.meta.cleanupError, null);
  await assertFixtureStopped(fixture, running);
});

test("run_test abort also kills a real detached grandchild outside the parent process group", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("detached-abort", { childDetached: true });
  const controller = new AbortController();
  const runningPromise = runFixture(fixture, { signal: controller.signal, timeoutMs: 10_000 });
  const running = await waitForFixture(fixture);
  assert.equal(await canConnect(running.port), true, "测试前要确认 detached 孙进程真的在监听");

  controller.abort();
  await assert.rejects(runningPromise, (error) => error?.name === "AbortError");
  await assertFixtureStopped(fixture, running);
});

test("run_test timeout also kills a real detached grandchild", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("detached-timeout", { childDetached: true });
  const runningPromise = runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 1000 });
  const running = await waitForFixture(fixture);
  assert.equal(await canConnect(running.port), true, "测试前要确认 detached 孙进程真的在监听");

  const result = await runningPromise;
  assert.equal(result.meta.timedOut, true);
  assert.equal(result.meta.exitCode, null);
  assert.equal(result.meta.cleanupError, null);
  await assertFixtureStopped(fixture, running);
});

test("run_test keeps exit 0 while cleaning a detached grandchild after normal exit", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("detached-normal-exit", {
    parentExitsAfterChildReady: true,
    childDetached: true,
  });
  const result = await runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 5000 });
  const running = await waitForFixture(fixture);

  assert.ok(fs.statSync(fixture.heartbeatPath).size > 0, "清理前 detached 孙进程应已启动心跳");
  assert.equal(result.meta.exitCode, 0, "清理 detached 孙进程不得改掉父进程的真实退出码");
  assert.equal(result.meta.timedOut, false);
  assert.equal(result.meta.cleanupError, null);
  assert.equal(result.meta.cleanupScope, "process-group+tagged-descendants");
  await assertFixtureStopped(fixture, running);
});

test("run_test reports the honest boundary when code clears the tag before detaching", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("detached-cleared-token-boundary", {
    parentExitsAfterChildReady: true,
    childDetached: true,
    childClearsRunToken: true,
  });
  const result = await runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 5000 });
  const running = await waitForFixture(fixture);

  try {
    assert.equal(result.meta.exitCode, 0);
    assert.equal(result.meta.cleanupError, null);
    assert.equal(result.meta.cleanupScope, "process-group+tagged-descendants");
    assert.equal(processExists(running.childPid), true, "显式清除标记后 setsid 超出当前可安全承诺的范围");
    assert.equal(await canConnect(running.port), true, "边界 PoC 应确认孙进程确实逃出，不能把测试写成假绿");
    assert.ok(fs.statSync(fixture.heartbeatPath).size > 0, "边界 PoC 孙进程应真实写过心跳");
  } finally {
    await forceStopEscapedFixture(fixture, running);
  }
});

test("run_test never returns its internal process token in command output", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("token-redaction");
  const script = path.join(fixture.project, "print-token.cjs");
  fs.writeFileSync(script, 'process.stdout.write(process.env.KAII_RUN_PROCESS_TOKEN || "missing");\n');
  const result = await agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: [script], timeout_ms: 5000 } },
    {
      root: fixture.project,
      writable: true,
      userDataPath: fixture.userDataPath,
      callId: "process-tree-token-redaction",
      signal: new AbortController().signal,
    },
  );

  assert.equal(result.meta.exitCode, 0);
  assert.match(result.detail, /\[内部运行标记\]/);
  assert.doesNotMatch(result.detail, /[a-f0-9]{64}/, "高熵 token 不应进入界面或审计详情");
});

test("run_test exposes cleanup timeout without replacing the real exit code", { skip: process.platform === "win32" }, async () => {
  const fixture = createProcessTreeFixture("cleanup-warning");
  const fakeChild = new EventEmitter();
  fakeChild.pid = 2_000_000_000;
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.stdout = new PassThrough();
  fakeChild.stderr = new PassThrough();
  fakeChild.kill = () => true;
  const spawnImpl = () => {
    queueMicrotask(() => {
      fakeChild.exitCode = 0;
      fakeChild.emit("exit", 0, null);
      // 故意不发 close：模拟管道/进程树没有彻底收尾。
    });
    return fakeChild;
  };

  const result = await agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: ["--version"], timeout_ms: 5000 } },
    {
      root: fixture.project,
      writable: true,
      userDataPath: fixture.userDataPath,
      callId: "process-tree-cleanup-warning",
      signal: new AbortController().signal,
      spawnImpl,
    },
  );
  assert.equal(result.meta.exitCode, 0);
  assert.match(result.meta.cleanupError, /等待命令进程退出超过/);
  assert.match(result.detail, /后台进程清理失败/);
});

test("graceful app shutdown waits for a real detached run_test grandchild to be reclaimed", { skip: process.platform === "win32" }, async () => {
  mainSubject.resetState();
  const fixture = createProcessTreeFixture("app-quit", { childDetached: true });
  const runningPromise = runFixture(fixture, { signal: new AbortController().signal, timeoutMs: 10_000 });
  const running = await waitForFixture(fixture);
  assert.equal(await canConnect(running.port), true, "退出前孙进程必须真实监听");

  let prevented = 0;
  let quits = 0;
  const cleanup = await mainSubject.beginGracefulQuit(
    { preventDefault() { prevented += 1; } },
    { appImpl: { quit() { quits += 1; } }, timeoutMs: 4000 },
  );
  assert.deepEqual(cleanup, { complete: true, pending: 0 });
  assert.equal(prevented, 1);
  assert.equal(quits, 1, "只能在进程树清理完成后重新触发退出");
  await assert.rejects(runningPromise, (error) => error?.name === "AbortError");
  await assertFixtureStopped(fixture, running);
  assert.equal(agentTools.ALLOWED_COMMANDS.taskkill, undefined, "Windows 收尾不能变成用户可调用命令");
});
