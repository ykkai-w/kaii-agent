const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const originalLoad = Module._load;
const previousTestMode = process.env.KAII_ELECTRON_TEST;
process.env.KAII_ELECTRON_TEST = "1";
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp/kaii-test", isPackaged: false, on() {}, whenReady: async () => {} },
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

const mainPath = path.resolve(__dirname, "../../electron/main.cjs");
const { __test: subject } = require(mainPath);
const workspace = require("../../electron/lib/workspace.cjs");
const agentTools = require("../../electron/lib/agent-tools.cjs");
const agentProtocol = require("../../electron/lib/agent.cjs");
const audit = require("../../electron/lib/audit.cjs");
const memory = require("../../electron/lib/memory.cjs");
const diff = require("../../electron/lib/diff.cjs");

Module._load = originalLoad;
if (previousTestMode === undefined) delete process.env.KAII_ELECTRON_TEST;
else process.env.KAII_ELECTRON_TEST = previousTestMode;

const temporaryDirectories = [];

function tempSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-agent-test-"));
  temporaryDirectories.push(base);
  const project = path.join(base, "project");
  const userData = path.join(base, "userdata");
  fs.mkdirSync(project);
  fs.mkdirSync(userData);
  return { base, project: fs.realpathSync(project), userData: fs.realpathSync(userData) };
}

test.after(() => {
  memory.resetMemoryDatabaseCache();
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

test("workspace grant refuses system roots, home and kaii's own data directory", () => {
  const { base, project, userData } = tempSandbox();
  for (const forbidden of ["/", os.homedir(), path.join(os.homedir(), "Library"), userData]) {
    assert.throws(() => workspace.assertGrantableDirectory(forbidden, userData), /不能|授权/);
  }
  // 真实攻击面：旧实现只禁 userData 本身和子目录，却允许授权它的父目录。
  // 一旦授权 base，工程模式的 read_file 就可以读 userdata/credentials.json。
  fs.writeFileSync(path.join(userData, "credentials.json"), '{"deepseek":"fake-regression-key"}\n');
  assert.throws(() => workspace.assertGrantableDirectory(base, userData), /包含它的上层目录/);
  assert.throws(() => workspace.addWorkspace(userData, base), /包含它的上层目录/);
  assert.throws(() => workspace.assertGrantableDirectory("relative/path", userData), /绝对路径/);
  assert.equal(workspace.assertGrantableDirectory(project, userData), project);
});

test("legacy workspace state cannot retain a parent of userData", () => {
  const { base, project, userData } = tempSandbox();
  const unsafeId = "11111111-1111-4111-8111-111111111111";
  const safeId = "22222222-2222-4222-8222-222222222222";
  fs.writeFileSync(path.join(userData, "workspaces.json"), `${JSON.stringify({
    schemaVersion: 1,
    roots: [
      { id: unsafeId, path: base, label: "unsafe", writable: false, addedAt: 1 },
      { id: safeId, path: project, label: "safe", writable: false, addedAt: 2 },
    ],
    activeId: unsafeId,
  })}\n`);

  const state = workspace.listWorkspaces(userData);
  assert.deepEqual(state.roots.map((root) => root.id), [safeId]);
  assert.equal(state.activeId, safeId, "危险的历史授权被丢弃后要切到安全工作区");
});

test("workspace state stores roots, active selection and write permission", () => {
  const { project, userData } = tempSandbox();
  const added = workspace.addWorkspace(userData, project);
  assert.equal(added.roots.length, 1);
  assert.equal(added.roots[0].writable, false);
  assert.equal(added.activeId, added.roots[0].id);
  const id = added.roots[0].id;
  assert.equal(workspace.setWorkspaceWritable(userData, id, true).roots[0].writable, true);
  assert.equal(workspace.activeWorkspace(userData).path, project);
  assert.equal(fs.statSync(path.join(userData, "workspaces.json")).mode & 0o777, 0o600);
  assert.equal(workspace.removeWorkspace(userData, id).roots.length, 0);
  assert.equal(workspace.activeWorkspace(userData), null);
});

test("workspace paths cannot escape the granted root", () => {
  const { base, project } = tempSandbox();
  fs.writeFileSync(path.join(base, "secret.txt"), "不该被读到");
  fs.writeFileSync(path.join(project, "inside.txt"), "可以读");
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(project, "link.txt"));

  for (const bad of ["../secret.txt", "/etc/hosts", "sub/../../secret.txt"]) {
    assert.throws(() => workspace.resolveInWorkspace(project, bad), /越出工作区|只能使用工作区内/);
  }
  assert.throws(() => workspace.readTextFile(project, "link.txt"), /链接越出工作区/);
  assert.equal(workspace.readTextFile(project, "inside.txt").content, "可以读");
  const created = workspace.resolveInWorkspace(project, "a/b/c.txt", { mustExist: false });
  assert.equal(created.exists, false);
  assert.equal(created.absolute, path.join(project, "a/b/c.txt"));
});

test("workspace listing ignores heavy directories and refuses binary reads", () => {
  const { project } = tempSandbox();
  fs.mkdirSync(path.join(project, "node_modules"));
  fs.writeFileSync(path.join(project, "node_modules", "junk.js"), "x");
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(project, "blob.bin"), Buffer.from([1, 0, 2, 0]));

  const listed = workspace.listDirectory(project, ".");
  assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ["blob.bin", "src"]);
  assert.equal(workspace.walkFiles(project).files.some((file) => file.path.startsWith("node_modules")), false);
  assert.throws(() => workspace.readTextFile(project, "blob.bin"), /二进制/);
});

test("glob matching supports the shapes the model actually writes", () => {
  const cases = [
    ["src/a.ts", "**/*.ts", true],
    ["src/lib/a.ts", "**/*.ts", true],
    ["a.ts", "**/*.ts", true],
    ["src/lib/a.ts", "src/*.ts", false],
    ["src/lib/a.ts", "src/**/*.ts", true],
    ["a.md", "*.ts", false],
    ["ab.ts", "?b.ts", true],
    ["abc.ts", "?b.ts", false],
  ];
  for (const [candidate, glob, expected] of cases) {
    assert.equal(workspace.matchesGlob(candidate, glob), expected, `${glob} vs ${candidate}`);
  }
});

test("unified diff reports real line changes", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\nTWO\nthree\nfour\n";
  const patch = diff.unifiedDiff(before, after, { path: "demo.txt" });
  assert.match(patch, /^--- a\/demo\.txt/m);
  assert.match(patch, /^-two$/m);
  assert.match(patch, /^\+TWO$/m);
  assert.match(patch, /^\+four$/m);
  assert.deepEqual(diff.diffStats(before, after), { added: 2, removed: 1 });
  assert.equal(diff.unifiedDiff("same", "same"), "");
});

test("tool calls are validated before anything runs", () => {
  assert.throws(() => agentTools.validateToolCall({ tool: "rm_rf", args: {} }), /没有这个工具/);
  assert.throws(() => agentTools.validateToolCall({ tool: "read_file", args: [] }), /args 必须是对象/);
  assert.throws(() => agentTools.validateToolCall({ tool: "read_file", args: {}, extra: 1 }), /未知字段/);
  assert.deepEqual(
    agentTools.validateToolCall({ tool: "read_file", args: { path: "a.ts" } }),
    { tool: "read_file", args: { path: "a.ts" } },
  );
  assert.equal(agentTools.listTools().some((tool) => tool.write), false);
  assert.equal(agentTools.listTools({ writable: true }).some((tool) => tool.id === "apply_patch"), true);
});

test("read-only workspaces refuse every writing tool", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "hello\n");
  const context = { root: project, writable: false, userDataPath: userData, callId: "call-ro" };
  await assert.rejects(
    agentTools.executeToolCall({ tool: "apply_patch", args: { path: "a.txt", find: "hello", replace: "hi" } }, context),
    /只读/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "run_test", args: { command: "npm", args: ["test"] } }, context),
    /只读/,
  );
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "hello\n");
});

test("apply_patch demands a unique anchor, a fresh sha and leaves a rollback snapshot", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "alpha\nbeta\nalpha\n");
  const context = (callId) => ({ root: project, writable: true, userDataPath: userData, callId });

  await assert.rejects(
    agentTools.executeToolCall({ tool: "apply_patch", args: { path: "a.txt", find: "alpha", replace: "x" } }, context("c1")),
    /出现多次/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "apply_patch", args: { path: "a.txt", find: "缺失", replace: "x" } }, context("c2")),
    /找不到/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "apply_patch", args: { path: "a.txt", content: "全新" } }, context("c3")),
    /expect_sha256/,
  );
  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "a.txt", content: "全新", expect_sha256: "0".repeat(64) } },
      context("c4"),
    ),
    /文件已经变了/,
  );

  const applied = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "a.txt", find: "beta", replace: "BETA" } },
    context("c5"),
  );
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "alpha\nBETA\nalpha\n");
  assert.match(applied.detail, /^-beta$/m);
  assert.ok(applied.snapshotPath);

  const created = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "docs/new.md", content: "# 新建\n" } },
    context("c6"),
  );
  assert.equal(fs.existsSync(path.join(project, "docs/new.md")), true);

  assert.deepEqual(agentTools.rollbackSnapshot(project, applied.snapshotPath), { ok: true, action: "restored", path: "a.txt" });
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "alpha\nbeta\nalpha\n");
  assert.deepEqual(agentTools.rollbackSnapshot(project, created.snapshotPath), { ok: true, action: "deleted", path: "docs/new.md" });
  assert.equal(fs.existsSync(path.join(project, "docs/new.md")), false);
});

test("run_test only accepts allow-listed binaries, arguments and git subcommands", async () => {
  const { project, userData } = tempSandbox();
  const context = { root: project, writable: true, userDataPath: userData, callId: "call-run" };
  await assert.rejects(
    agentTools.executeToolCall({ tool: "run_test", args: { command: "rm", args: ["-rf", "/"] } }, context),
    /不允许运行 rm/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "run_test", args: { command: "npm", args: ["test; rm -rf /"] } }, context),
    /命令参数无效/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "run_test", args: { command: "git", args: ["push"] } }, context),
    /只允许这些子命令/,
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "run_test", args: { command: "npm", args: ["test"], timeout_ms: 10 } }, context),
    /timeout_ms无效/,
  );
});

test("update_plan keeps at most one step in progress", async () => {
  const { project, userData } = tempSandbox();
  const context = { root: project, writable: false, userDataPath: userData, callId: "call-plan" };
  await assert.rejects(
    agentTools.executeToolCall({ tool: "update_plan", args: { steps: [{ title: "a", status: "doing" }, { title: "b", status: "doing" }] } }, context),
    /最多只能有一步/,
  );
  const result = await agentTools.executeToolCall(
    { tool: "update_plan", args: { steps: [{ title: "读代码", status: "done" }, { title: "改代码", status: "doing" }] } },
    context,
  );
  assert.equal(result.summary, "计划 1/2 完成");
  assert.equal(result.meta.steps.length, 2);
});

test("streaming scanner separates prose from the tool block", () => {
  const scanner = agentProtocol.createToolCallScanner();
  let visible = "";
  for (const chunk of ["先看目录。", "<use_", 'tool>\n{"tool":"list_dir","arg', 's":{"path":"src"}}\n</use_', "tool>这段不该显示"]) {
    visible += scanner.push(chunk).visible;
  }
  const tail = scanner.finish();
  visible += tail.visible;
  assert.equal(visible, "先看目录。");
  assert.deepEqual(
    agentTools.validateToolCall(agentProtocol.parseToolCallBlock(tail.toolCall)),
    { tool: "list_dir", args: { path: "src" } },
  );

  const cut = agentProtocol.createToolCallScanner();
  cut.push('说明<use_tool>{"tool":"list_dir","args":{}}');
  const cutTail = cut.finish();
  assert.equal(cutTail.unterminated, true);
  assert.deepEqual(agentProtocol.parseToolCallBlock(cutTail.toolCall), { tool: "list_dir", args: {} });

  const plain = agentProtocol.createToolCallScanner();
  assert.equal(plain.push("普通回答").visible + plain.finish().visible, "普通回答");
});

test("agent system prompt names the workspace, the gate and the project notes", () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "KAII.md"), "# 这个项目\n用 npm test 跑测试。\n");
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, agentMaxRounds: 4 };
  const context = subject.resolveAgentContext(userData, { useTools: true }, settings);
  assert.equal(context.workspace.path, project);
  assert.equal(context.maxRounds, 4);
  assert.equal(context.projectNotes.fileName, "KAII.md");
  assert.match(context.basePrompt, /工作区：/);
  assert.match(context.basePrompt, /未开启，只能读/);
  assert.match(context.basePrompt, /npm test 跑测试/);
  assert.match(context.basePrompt, /最多 4 轮/);
  assert.equal(subject.resolveAgentContext(userData, { useTools: false }, settings), null);
});

function sseResponse(text) {
  const payload = text.split("").map((character) => (
    `data: ${JSON.stringify({ choices: [{ delta: { content: character } }] })}\n\n`
  )).join("");
  return new Response(`${payload}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function senderRecorder() {
  const events = [];
  return {
    events,
    sender: { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) },
  };
}

test("the agent loop really runs a tool and feeds the true result back to the model", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "answer.txt"), "真实内容是 42\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);

  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentMaxRounds: 3 };
  const prompts = [];
  let completions = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    prompts.push(JSON.parse(options.body));
    completions += 1;
    if (completions === 1) {
      return sseResponse('我先读文件。<use_tool>{"tool":"read_file","args":{"path":"answer.txt"}}</use_tool>');
    }
    return sseResponse("文件里写的是 42。");
  };

  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-agent-1",
    messages: [{ role: "user", content: "answer.txt 里写了什么？" }],
    skillId: "none",
    options: { useTools: true },
  }, { settings, fetchImpl, userDataPath: userData });

  assert.equal(result.ok, true);
  assert.equal(result.toolRounds, 1);
  assert.equal(completions, 2);

  const chunks = events.filter((event) => event.channel === "chat:chunk").map((event) => event.payload.content).join("");
  assert.match(chunks, /我先读文件。/);
  assert.doesNotMatch(chunks, /use_tool/);
  assert.match(chunks, /文件里写的是 42。/);

  const toolEvents = events.filter((event) => event.channel === "chat:tool");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0].payload.status, "running");
  assert.equal(toolEvents[1].payload.status, "ok");
  assert.equal(toolEvents[1].payload.tool, "read_file");
  assert.match(toolEvents[1].payload.detail, /真实内容是 42/);

  const agentStart = events.find((event) => event.channel === "chat:agent-start");
  assert.equal(agentStart.payload.workspace.path, project);

  const secondPrompt = prompts[1];
  const feedback = secondPrompt.messages.at(-1);
  assert.equal(feedback.role, "user");
  assert.match(feedback.content, /\[工具结果 read_file\]/);
  assert.match(feedback.content, /真实内容是 42/);
  assert.match(secondPrompt.messages.at(-2).content, /use_tool/);
  assert.deepEqual(secondPrompt.stop, ["</use_tool>"]);

  const recorded = audit.listToolCalls(userData, { limit: 10 });
  assert.equal(recorded[0].tool, "read_file");
  assert.equal(recorded[0].status, "ok");
  const runs = audit.listRuns(userData, { limit: 5 });
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].rounds, 1);
});

test("completion is verified only by a successful check after the latest file change", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const answer = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "auto", agentMaxRounds: 4 };
  const { events, sender } = senderRecorder();

  const result = await subject.streamChat(sender, {
    requestId: "req-completion-verified",
    messages: [{ role: "user", content: "把 answer 改成 2 并检查" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const answer = 1;","replace":"const answer = 2;"}}</use_tool>',
      '<use_tool>{"tool":"run_test","args":{"command":"node","args":["--check","a.js"]}}</use_tool>',
      "改好了，检查也通过了。",
    ]),
  });

  const completion = events.find((event) => event.channel === "chat:done").payload.completion;
  assert.deepEqual(completion.changedPaths, ["a.js"]);
  assert.equal(completion.state, "verified");
  assert.equal(completion.checks.length, 1);
  assert.match(completion.checks[0].summary, /node --check a\.js/);
  assert.deepEqual(
    { ok: completion.checks[0].ok, timedOut: completion.checks[0].timedOut },
    { ok: true, timedOut: false },
  );
  assert.deepEqual(result.completion, completion);
  assert.deepEqual(audit.listRuns(userData, { limit: 1 })[0].completion, completion);
});

test("a check from before the latest file change cannot verify that change", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const answer = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "auto", agentMaxRounds: 4 };
  const { events, sender } = senderRecorder();

  await subject.streamChat(sender, {
    requestId: "req-completion-stale-check",
    messages: [{ role: "user", content: "先检查再修改" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"run_test","args":{"command":"node","args":["--check","a.js"]}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const answer = 1;","replace":"const answer = 2;"}}</use_tool>',
      "改好了。",
    ]),
  });

  const completion = events.find((event) => event.channel === "chat:done").payload.completion;
  assert.deepEqual(completion, { state: "unverified", changedPaths: ["a.js"], checks: [] });
  assert.deepEqual(audit.listRuns(userData, { limit: 1 })[0].completion, completion);
});

test("the latest post-change check must exit zero and must not time out", () => {
  const tracker = subject.createCompletionTracker();
  tracker.recordSuccess("apply_patch", { changedPath: "a.js" });
  tracker.recordSuccess("run_test", {
    summary: "node --check a.js → 超时",
    meta: { exitCode: null, timedOut: true },
  });
  assert.deepEqual(tracker.snapshot("answer"), {
    state: "unverified",
    changedPaths: ["a.js"],
    checks: [{ summary: "node --check a.js → 超时", ok: false, timedOut: true }],
  });

  tracker.recordSuccess("run_test", {
    summary: "node --check a.js → 成功",
    meta: { exitCode: 0, timedOut: false },
  });
  assert.equal(tracker.snapshot("answer").state, "verified", "最近一次有效检查可以覆盖上一次超时");

  tracker.recordSuccess("apply_patch", { changedPath: "b.js" });
  tracker.recordSuccess("run_test", {
    summary: "node --check b.js → 退出码 1",
    meta: { exitCode: 1, timedOut: false },
  });
  assert.deepEqual(tracker.snapshot("answer"), {
    state: "unverified",
    changedPaths: ["a.js", "b.js"],
    checks: [{ summary: "node --check b.js → 退出码 1", ok: false, timedOut: false }],
  });
});

test("the full human-writing skill cannot rewrite the local text tool protocol", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "answer.txt"), "协议保留了\n");
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentMaxRounds: 3 };
  const bodies = [];
  let round = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response('{"data":[{"id":"qwen-test"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    bodies.push(JSON.parse(options.body));
    round += 1;
    return round === 1
      ? sseResponse('<use_tool>{"tool":"read_file","args":{"path":"answer.txt"}}</use_tool>')
      : sseResponse("文件里写着协议保留了。");
  };

  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-human-agent",
    messages: [{ role: "user", content: "读取 answer.txt" }],
    skillId: "human-writing",
    options: { useTools: true },
  }, { settings, fetchImpl, userDataPath: userData });

  assert.equal(result.ok, true);
  assert.equal(result.toolRounds, 1);
  assert.ok(events.some((event) => event.channel === "chat:tool" && event.payload.status === "ok"));
  const system = bodies[0].messages[0].content;
  assert.equal((system.match(/【说人话】/g) || []).length, 1);
  assert.match(system, /当前启用技能：写作润色/);
  assert.match(system, /工具调用阶段以工具协议为最高格式约束/);
  assert.ok(system.lastIndexOf("【格式边界】") > system.indexOf("当前启用技能：写作润色"));
  assert.match(bodies[1].messages.at(-1).content, /协议保留了/);
});

test("DeepSeek text calls and Kimi/GLM native calls survive the shared writing core", async () => {
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 65_536, maxTokens: 1024 };
  const fitted = subject.fitPromptToContext(
    [{ role: "user", content: "读文件" }],
    { text: "完整写作规则", mode: "full", name: "写作润色" },
    settings,
    { basePrompt: "这是工程模式。", outputMode: "agent", contextWindow: 65_536 },
  );
  assert.equal((fitted.systemContent.match(/【说人话】/g) || []).length, 1);
  assert.ok(fitted.systemContent.lastIndexOf("【格式边界】") > fitted.systemContent.indexOf("完整写作规则"));

  const nativeEvent = `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{
      index: 0,
      id: "call_1",
      function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
    }] } }],
  })}\n\ndata: [DONE]\n\n`;
  for (const provider of ["moonshot", "zhipu"]) {
    const result = await subject.runModelRound({
      settings,
      fetchImpl: async () => new Response(nativeEvent, { status: 200, headers: { "content-type": "text/event-stream" } }),
      signal: new AbortController().signal,
      modelId: `${provider}-model`,
      systemContent: fitted.systemContent,
      messages: fitted.messages,
      agentMode: true,
      onVisible() {},
      endpoint: { baseUrl: "https://example.invalid/v1", headers: {}, cloud: true, preferNativeTools: true },
      nativeTools: agentTools.toolDefinitions({ writable: false }),
    });
    assert.equal(result.nativeCall.name, "read_file", `${provider} 没保住原生工具名`);
    assert.equal(result.nativeCall.args, '{"path":"src/a.ts"}');
  }

  const deepseekText = '<use_tool>{"tool":"read_file","args":{"path":"src/a.ts"}}</use_tool>';
  const textResult = await subject.runModelRound({
    settings,
    fetchImpl: async () => sseResponse(deepseekText),
    signal: new AbortController().signal,
    modelId: "deepseek-model",
    systemContent: fitted.systemContent,
    messages: fitted.messages,
    agentMode: true,
    onVisible() {},
    endpoint: { baseUrl: "https://example.invalid/v1", headers: {}, cloud: true, preferNativeTools: false },
    nativeTools: agentTools.toolDefinitions({ writable: false }),
  });
  assert.deepEqual(agentProtocol.parseToolCallBlock(textResult.toolCallBlock), {
    tool: "read_file",
    args: { path: "src/a.ts" },
  });
});

test("a broken tool call is reported instead of silently retried", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentMaxRounds: 3 };
  let completions = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    void options;
    completions += 1;
    if (completions === 1) return sseResponse('<use_tool>{"tool":"delete_everything","args":{}}</use_tool>');
    return sseResponse("这个工具不存在，我换个办法。");
  };

  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-agent-2",
    messages: [{ role: "user", content: "删掉所有文件" }],
    skillId: "none",
    options: { useTools: true },
  }, { settings, fetchImpl, userDataPath: userData });

  assert.equal(result.ok, true);
  const toolEvents = events.filter((event) => event.channel === "chat:tool");
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].payload.status, "error");
  assert.match(toolEvents[0].payload.summary, /没有这个工具/);
});

test("tool mode stops at the configured round limit", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "x\n");
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentMaxRounds: 2 };
  let completions = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    completions += 1;
    return sseResponse('<use_tool>{"tool":"read_file","args":{"path":"a.txt"}}</use_tool>');
  };

  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-agent-3",
    messages: [{ role: "user", content: "一直读" }],
    skillId: "none",
    options: { useTools: true },
  }, { settings, fetchImpl, userDataPath: userData });

  assert.equal(result.ok, true);
  assert.equal(result.toolRounds, 2);
  assert.equal(completions, 3);
  const done = events.find((event) => event.channel === "chat:done");
  assert.equal(done.payload.stopReason, "max-rounds");
  assert.equal(events.filter((event) => event.channel === "chat:tool" && event.payload.status === "ok").length, 2);
});

test("asking for tools without a granted workspace fails loudly", async () => {
  subject.resetState();
  const { userData } = tempSandbox();
  const settings = { ...subject.DEFAULT_SETTINGS };
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-agent-4",
    messages: [{ role: "user", content: "看看我的项目" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: async (url) => (url.endsWith("/health")
      ? new Response("ok", { status: 200 })
      : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /还没有授权工作区/);
  assert.equal(events.some((event) => event.channel === "chat:tool"), false);
});

test("normal chat never enters tool mode", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024 };
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    bodies.push(JSON.parse(options.body));
    return sseResponse('这里出现 <use_tool> 只是普通文字。');
  };
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-plain",
    messages: [{ role: "user", content: "随便聊聊" }],
    skillId: "none",
    options: {},
  }, { settings, fetchImpl, userDataPath: userData });
  assert.equal(result.ok, true);
  assert.equal(bodies[0].stop, undefined);
  assert.equal(events.some((event) => event.channel === "chat:tool"), false);
  const chunks = events.filter((event) => event.channel === "chat:chunk").map((event) => event.payload.content).join("");
  assert.match(chunks, /use_tool/);
});

test("settings validate the new search and agent knobs", () => {
  assert.equal(subject.validateSearchProvider("wikipedia"), "wikipedia");
  assert.throws(() => subject.validateSearchProvider("google"), /searchProvider无效/);
  assert.equal(subject.validateSearxngEndpoint(""), "");
  assert.equal(subject.validateSearxngEndpoint("https://searx.example.org/"), "https://searx.example.org");
  assert.throws(() => subject.validateSearxngEndpoint("http://searx.example.org"), /https/);
  assert.throws(() => subject.validateSearxngEndpoint("https://127.0.0.1"), /https/);
  assert.throws(
    () => subject.validateFullSettings({ ...subject.DEFAULT_SETTINGS, searchProvider: "searxng", searxngEndpoint: "" }),
    /实例地址/,
  );
  assert.throws(
    () => subject.validateFullSettings({ ...subject.DEFAULT_SETTINGS, agentMaxRounds: 99 }),
    /agentMaxRounds超出范围/,
  );
  assert.deepEqual(
    subject.sanitizeSettingsPatch({ searchProvider: "wikipedia", searchFallback: false, agentMaxRounds: 3 }),
    { searchProvider: "wikipedia", searchFallback: false, agentMaxRounds: 3 },
  );
});

test("audit records survive a crash as interrupted instead of running", () => {
  const { project, userData } = tempSandbox();
  const runId = audit.startRun(userData, { requestId: "req-x", workspacePath: project, goal: "做点事" });
  audit.startToolCall(userData, { runId, requestId: "req-x", tool: "read_file", workspacePath: project, args: {} });
  const marked = audit.markInterruptedRuns(userData);
  assert.equal(marked.runs, 1);
  assert.equal(marked.calls, 1);
  assert.equal(audit.listRuns(userData)[0].status, "interrupted");
  assert.equal(audit.listToolCalls(userData)[0].status, "cancelled");
});

test("legacy audit databases gain completion evidence without losing old runs", () => {
  const { project, userData } = tempSandbox();
  const database = memory.openMemoryDatabase(userData);
  database.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      workspace_path TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','done','error','cancelled','interrupted')),
      rounds INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT ''
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO agent_runs(id,request_id,created_at,workspace_path,goal,status,rounds,detail)
    VALUES('legacy-run','legacy-request',1,?,'旧任务','done',1,'answer')
  `).run(project);

  const runId = audit.startRun(userData, {
    requestId: "req-migrated",
    workspacePath: project,
    goal: "改完并检查",
  });
  const completion = {
    state: "verified",
    changedPaths: ["a.js"],
    checks: [{ summary: "node --check a.js → 成功", ok: true, timedOut: false }],
  };
  audit.finishRun(userData, runId, { status: "done", rounds: 2, detail: "answer", completion });

  const runs = audit.listRuns(userData, { limit: 10 });
  assert.deepEqual(runs.find((run) => run.id === runId).completion, completion);
  assert.equal(runs.find((run) => run.id === "legacy-run").completion, null);
  assert.equal(runs.find((run) => run.id === "legacy-run").checkpoint, null);
  assert.equal(runs.find((run) => run.id === "legacy-run").parentRunId, null);
  assert.equal(runs.find((run) => run.id === "legacy-run").resumedFrom, null);
  assert.equal(runs.find((run) => run.id === "legacy-run").resumedBy, null);
  const columns = memory.openMemoryDatabase(userData).prepare("PRAGMA table_info(agent_runs)").all().map((column) => column.name);
  assert.equal(columns.includes("checkpoint_json"), true);
  assert.equal(columns.includes("parent_run_id"), true);
  assert.equal(columns.includes("resumed_from_run_id"), true);
  assert.equal(columns.includes("resumed_by_run_id"), true);
});

test("an interrupted checkpoint survives restart and resumes as a new related run", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  const workspaceId = added.roots[0].id;
  workspace.setWorkspaceWritable(userData, workspaceId, true);
  const parentId = audit.startRun(userData, {
    requestId: "req-before-restart",
    workspacePath: project,
    goal: "继续检查文件",
    checkpoint: {
      goal: "继续检查文件",
      workspace: { id: workspaceId, realpath: project },
      plan: [{ title: "读取 a.js", status: "doing" }],
      changedPaths: [],
      lastCheck: null,
      failureSummaries: [],
      stopReason: "running",
      mutationEpoch: 0,
    },
  });
  audit.saveRunCheckpoint(userData, parentId, {
    rounds: 1,
    checkpoint: audit.getRun(userData, parentId).checkpoint,
  });
  assert.deepEqual(audit.markInterruptedRuns(userData), { runs: 1, calls: 0 });
  assert.equal(audit.getRun(userData, parentId).resumable, true);
  assert.equal(audit.getRun(userData, parentId).checkpoint.stopReason, "interrupted");

  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 3 };
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-after-restart",
    messages: [{ role: "user", content: "继续刚才的任务" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parentId,
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
      "检查完了。",
    ]),
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.runId, parentId, "恢复必须新建 run，不能覆盖旧 run");
  const child = audit.getRun(userData, result.runId);
  assert.equal(child.parentRunId, parentId);
  assert.equal(child.resumedFrom, parentId);
  assert.equal(audit.getRun(userData, parentId).status, "interrupted");
  assert.equal(audit.getRun(userData, parentId).resumedBy, result.runId);
  assert.equal(audit.getRun(userData, parentId).resumable, false);
  const started = events.find((event) => event.channel === "chat:agent-start").payload;
  assert.equal(started.runId, result.runId);
  assert.equal(started.resumedFrom, parentId);

  const repeated = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-after-restart-again",
    messages: [{ role: "user", content: "再继续一次" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parentId,
  }, { settings, userDataPath: userData, fetchImpl: agentFetch(["不该请求模型"]) });
  assert.equal(repeated.ok, false);
  assert.match(repeated.message, /已经被继续过|不能重复恢复/);
});

test("claiming a resumable parent and creating its child is atomic", async () => {
  const { project, userData } = tempSandbox();
  const workspaceId = workspace.addWorkspace(userData, project).roots[0].id;
  const checkpoint = {
    goal: "继续任务",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: [],
    lastCheck: null,
    failureSummaries: [],
    stopReason: "max-rounds",
    mutationEpoch: 0,
  };
  const parentId = audit.startRun(userData, {
    requestId: "req-atomic-parent",
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint,
  });
  audit.finishRun(userData, parentId, { status: "done", detail: "max-rounds", checkpoint });

  const startChild = (requestId) => audit.startResumedRun(userData, {
    requestId,
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint: { ...checkpoint, stopReason: "running" },
    resumedFrom: parentId,
  });
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => startChild("req-atomic-a")),
    Promise.resolve().then(() => startChild("req-atomic-b")),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.match(attempts.find((attempt) => attempt.status === "rejected").reason.message, /已经被继续过|重复恢复/);
  const child = attempts.find((attempt) => attempt.status === "fulfilled").value;
  const parent = audit.getRun(userData, parentId);
  assert.equal(parent.resumedBy, child.id);
  assert.equal(parent.resumable, false);
  assert.equal(audit.getRun(userData, child.id).resumedFrom, parentId);
  assert.throws(() => startChild("req-atomic-c"), /已经被继续过|重复恢复/);
});

test("a resumed child interrupted by model discovery keeps the checkpoint recoverable", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const workspaceId = workspace.addWorkspace(userData, project).roots[0].id;
  const checkpoint = {
    goal: "继续工程任务",
    workspace: { id: workspaceId, realpath: project },
    plan: [{ title: "继续检查", status: "doing" }],
    changedPaths: [],
    lastCheck: null,
    failureSummaries: [],
    stopReason: "max-rounds",
    mutationEpoch: 0,
  };
  const parentId = audit.startRun(userData, {
    requestId: "req-infra-parent",
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint,
  });
  audit.finishRun(userData, parentId, { status: "done", detail: "max-rounds", checkpoint });
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-infra-child",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parentId,
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto" },
    userDataPath: userData,
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models")) return new Response("model service failed", { status: 503 });
      throw new Error("首轮模型不该在 /v1/models 失败后继续");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.resumable, true);
  assert.equal(result.continueReason, "interrupted");
  assert.match(result.runId, /^[0-9a-f-]{36}$/i);
  const errorEvent = events.find((event) => event.channel === "chat:error").payload;
  assert.equal(errorEvent.runId, result.runId);
  assert.equal(errorEvent.resumable, true);
  assert.equal(errorEvent.continueReason, "interrupted");
  const parent = audit.getRun(userData, parentId);
  const child = audit.getRun(userData, result.runId);
  assert.equal(parent.resumedBy, child.id);
  assert.equal(parent.resumable, false);
  assert.equal(child.status, "interrupted");
  assert.equal(child.resumable, true);
  assert.equal(child.checkpoint.stopReason, "interrupted");
  assert.deepEqual(child.checkpoint.plan, checkpoint.plan);
});

test("an engineering SSE deadline preserves partial output and leaves a resumable interrupted run", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const { events, sender } = senderRecorder();
  const partialAnswer = "工程部分输出";
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response('{"data":[{"id":"qwen-test"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/chat/completions")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: partialAnswer } }] })}\n\n`,
          ));
          options.signal.addEventListener("abort", () => {
            controller.error(new TypeError("invalid_argument"));
          }, { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await subject.streamChat(sender, {
    requestId: "engineering-deadline",
    messages: [{ role: "user", content: "检查这个工程" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto" },
    userDataPath: userData,
    fetchImpl,
    requestTimeoutMs: 250,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.partial, true);
  assert.equal(result.resumable, true);
  assert.equal(result.continueReason, "interrupted");
  assert.match(result.runId, /^[0-9a-f-]{36}$/i);
  const keptPartial = events.filter((event) => event.channel === "chat:chunk").map((event) => event.payload.content).join("");
  assert.equal(keptPartial, partialAnswer, "工程协议扫描器暂存的回答尾巴也必须在超时前保留");
  const errorEvent = events.find((event) => event.channel === "chat:error");
  assert.ok(errorEvent);
  assert.equal(errorEvent.payload.interrupted, true);
  assert.equal(errorEvent.payload.partial, true);
  assert.equal(errorEvent.payload.runId, result.runId);
  assert.equal(errorEvent.payload.resumable, true);
  const run = audit.getRun(userData, result.runId);
  assert.equal(run.status, "interrupted");
  assert.equal(run.resumable, true);
  assert.equal(run.checkpoint.stopReason, "interrupted");
  assert.equal(subject.requestControllers.size, 0);
});

test("startup reconstructs a conservative stale path when apply_patch wrote before its receipt", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const granted = workspace.addWorkspace(userData, project);
  const workspaceId = granted.roots[0].id;
  workspace.setWorkspaceWritable(userData, workspaceId, true);
  const checkpoint = {
    goal: "把 a 改成 2",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: [],
    lastCheck: null,
    failureSummaries: [],
    stopReason: "running",
    mutationEpoch: 0,
  };
  const runId = audit.startRun(userData, {
    requestId: "req-crash-gap",
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint,
  });
  const callId = audit.startToolCall(userData, {
    runId,
    requestId: "req-crash-gap",
    tool: "apply_patch",
    workspacePath: project,
    args: { path: "a.js", find: "const a = 1;", replace: "const a = 2;" },
  });
  const actual = await agentTools.executeToolCall({
    tool: "apply_patch",
    args: { path: "a.js", find: "const a = 1;", replace: "const a = 2;" },
  }, {
    root: project,
    writable: true,
    userDataPath: userData,
    callId,
    signal: new AbortController().signal,
  });
  assert.equal(actual.changedPath, "a.js");
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 2;\n");
  // 模拟写盘完成后、receipt + checkpoint 事务提交前进程退出。
  audit.markInterruptedRuns(userData);
  const interrupted = audit.getRun(userData, runId);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.resumable, true);
  assert.equal(interrupted.checkpoint.mutationEpoch, 1);
  assert.deepEqual(interrupted.checkpoint.changedPaths, [{
    path: "a.js",
    sha256: workspace.readTextFile(project, "a.js").sha256,
    exists: true,
    stale: true,
  }]);
  assert.match(interrupted.checkpoint.failureSummaries[0].summary, /写入是否完整落盘无法确认/);

  const { events, sender } = senderRecorder();
  const resumed = await subject.streamChat(sender, {
    requestId: "req-crash-gap-resume",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: runId,
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 4 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 2;","replace":"const a = 3;"}}</use_tool>',
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 2;","replace":"const a = 3;"}}</use_tool>',
      "完成。",
    ]),
  });
  assert.equal(resumed.ok, true);
  const firstWrite = events.find((event) => event.channel === "chat:tool" && event.payload.tool === "apply_patch");
  assert.equal(firstWrite.payload.status, "blocked");
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 3;\n");
});

test("resume refuses a different active workspace and a removed authorization", async () => {
  subject.resetState();
  const { base, project, userData } = tempSandbox();
  const other = path.join(base, "other-project");
  fs.mkdirSync(other);
  const otherRealpath = fs.realpathSync(other);
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  fs.writeFileSync(path.join(other, "b.js"), "const b = 1;\n");
  const first = workspace.addWorkspace(userData, project);
  const firstId = first.roots[0].id;
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 1 };
  const initial = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-resume-origin",
    messages: [{ role: "user", content: "读一下 a.js" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
    ]),
  });
  assert.equal(audit.getRun(userData, initial.runId).resumable, true);

  workspace.addWorkspace(userData, otherRealpath);
  const wrongWorkspace = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-resume-wrong-workspace",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: initial.runId,
  }, { settings, userDataPath: userData, fetchImpl: agentFetch(["不该请求模型"]) });
  assert.equal(wrongWorkspace.ok, false);
  assert.match(wrongWorkspace.message, /当前工作区不是|原工作区/);

  workspace.removeWorkspace(userData, firstId);
  const unauthorized = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-resume-unauthorized",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: initial.runId,
  }, { settings, userDataPath: userData, fetchImpl: agentFetch(["不该请求模型"]) });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.message, /当前工作区不是|授权|原工作区/);
});

test("a drifted file is stale on resume and no write runs before read_file", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const firstSettings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 1 };
  const parent = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-stale-parent",
    messages: [{ role: "user", content: "把 a 改成 2" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings: firstSettings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 1;","replace":"const a = 2;"}}</use_tool>',
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
    ]),
  });
  assert.equal(parent.stopReason, "max-rounds");
  fs.writeFileSync(path.join(project, "a.js"), "const a = 3;\n", "utf8");

  const settings = { ...firstSettings, agentMaxRounds: 4 };
  const { events, sender } = senderRecorder();
  const resumed = await subject.streamChat(sender, {
    requestId: "req-stale-child",
    messages: [{ role: "user", content: "继续完成" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parent.runId,
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 3;","replace":"const a = 4;"}}</use_tool>',
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 3;","replace":"const a = 4;"}}</use_tool>',
      "继续完成了。",
    ]),
  });

  assert.equal(resumed.ok, true);
  const started = events.find((event) => event.channel === "chat:agent-start").payload;
  assert.deepEqual(started.stalePaths, ["a.js"]);
  const toolEvents = events.filter((event) => event.channel === "chat:tool");
  assert.equal(toolEvents[0].payload.status, "blocked");
  assert.match(toolEvents[0].payload.detail, /先逐一 read_file/);
  assert.equal(toolEvents.some((event) => event.payload.tool === "read_file" && event.payload.status === "ok"), true);
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 4;\n");
  const checkpoint = audit.getRun(userData, resumed.runId).checkpoint;
  assert.equal(checkpoint.changedPaths[0].stale, false);
  assert.equal(checkpoint.changedPaths[0].sha256, workspace.readTextFile(project, "a.js").sha256);
});

test("a failed read_file never clears stale or unlocks a resumed write", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  const workspaceId = added.roots[0].id;
  workspace.setWorkspaceWritable(userData, workspaceId, true);
  const oldSha = workspace.readTextFile(project, "a.js").sha256;
  const checkpoint = {
    goal: "继续修改 a.js",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: [{ path: "a.js", sha256: oldSha, exists: true, stale: false }],
    lastCheck: null,
    failureSummaries: [],
    stopReason: "max-rounds",
    mutationEpoch: 1,
  };
  const parentId = audit.startRun(userData, {
    requestId: "req-failed-read-parent",
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint,
  });
  audit.finishRun(userData, parentId, { status: "done", detail: "max-rounds", checkpoint });
  fs.writeFileSync(path.join(project, "a.js"), Buffer.from([0, 1, 2, 3]));

  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 3 };
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-failed-read-child",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parentId,
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","content":"const a = 4;\\n","expect_sha256":"0000000000000000000000000000000000000000000000000000000000000000"}}</use_tool>',
      "仍然不能写。",
    ]),
  });
  assert.equal(result.ok, true);
  const toolEvents = events.filter((event) => event.channel === "chat:tool");
  assert.equal(toolEvents.some((event) => event.payload.tool === "read_file" && event.payload.status === "error"), true);
  const blockedWrite = toolEvents.find((event) => event.payload.tool === "apply_patch" && event.payload.status === "blocked");
  assert.ok(blockedWrite);
  assert.match(blockedWrite.payload.detail, /先逐一 read_file/);
  assert.equal(audit.getRun(userData, result.runId).checkpoint.changedPaths[0].stale, true);
  assert.deepEqual(fs.readFileSync(path.join(project, "a.js")), Buffer.from([0, 1, 2, 3]));
});

test("checkpoint is a strict safe summary and clean finishes cannot be resumed", async () => {
  subject.resetState();
  const providers = require("../../electron/lib/providers.cjs");
  const { project, userData } = tempSandbox();
  const fakeKey = "sk-checkpoint-secret-0123456789";
  providers.setApiKey(userData, "deepseek", fakeKey);
  fs.writeFileSync(path.join(project, "note.txt"), `private tool output ${fakeKey}\n`);
  const added = workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 3 };
  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-safe-checkpoint",
    messages: [{ role: "user", content: `检查 note.txt，不要泄漏 ${fakeKey}` }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      `<use_tool>{"tool":"update_plan","args":{"steps":[{"title":"读取 ${fakeKey}","status":"doing"}]}}</use_tool>`,
      '<use_tool>{"tool":"read_file","args":{"path":"note.txt"}}</use_tool>',
      "检查完了。",
    ]),
  });
  const run = audit.getRun(userData, result.runId);
  const serialized = JSON.stringify(run.checkpoint);
  assert.equal(serialized.includes(fakeKey), false);
  assert.equal(serialized.includes("private tool output"), false, "完整工具输出不能进入 checkpoint");
  assert.deepEqual(Object.keys(run.checkpoint).sort(), [
    "changedPaths", "failureSummaries", "goal", "lastCheck", "mutationEpoch", "plan", "stopReason", "workspace", "workspaceDirty",
  ]);
  assert.equal(run.resumable, false, "正常 read-only 结束不能恢复");
  const refused = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-resume-clean",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: run.id,
  }, { settings, userDataPath: userData, fetchImpl: agentFetch(["不该请求模型"]) });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /干净结束|不能恢复/);
});

test("the 201st newly written path is rejected before disk and the run stays resumable", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const added = workspace.addWorkspace(userData, project);
  const workspaceId = added.roots[0].id;
  workspace.setWorkspaceWritable(userData, workspaceId, true);
  const checkpoint = {
    goal: "继续批量改文件",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: Array.from({ length: 200 }, (_value, index) => ({
      path: `already-${String(index).padStart(3, "0")}.txt`, sha256: null, exists: false, stale: false,
    })),
    lastCheck: null,
    failureSummaries: [],
    stopReason: "max-rounds",
    mutationEpoch: 200,
    workspaceDirty: false,
  };
  const parentId = audit.startRun(userData, {
    requestId: "cap-parent",
    workspacePath: project,
    goal: checkpoint.goal,
    checkpoint,
  });
  audit.finishRun(userData, parentId, { status: "done", detail: "max-rounds", checkpoint });

  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "cap-child",
    messages: [{ role: "user", content: "继续写第 201 个文件" }],
    skillId: "none",
    options: { useTools: true },
    resumeRunId: parentId,
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto", agentMaxRounds: 2 },
    userDataPath: userData,
    fetchImpl: agentFetch(['<use_tool>{"tool":"apply_patch","args":{"path":"too-many.txt","content":"must not exist\\n"}}</use_tool>']),
  });

  assert.equal(result.ok, false);
  assert.equal(result.resumable, true);
  assert.match(result.message, /第 201 个新文件没有写入/);
  assert.equal(fs.existsSync(path.join(project, "too-many.txt")), false);
  const child = audit.getRun(userData, result.runId);
  assert.equal(child.status, "interrupted");
  assert.equal(child.resumable, true);
  assert.equal(child.checkpoint.changedPaths.length, 200);
});

test("startup archives a legacy 201-path checkpoint instead of leaving it running forever", () => {
  const { project, userData } = tempSandbox();
  const database = audit.openAuditDatabase(userData);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rawCheckpoint = {
    goal: "legacy overflow",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: Array.from({ length: 201 }, (_value, index) => ({
      path: `legacy-${index}.txt`, sha256: null, exists: false, stale: false,
    })),
    lastCheck: null,
    failureSummaries: [],
    stopReason: "running",
    mutationEpoch: 201,
    workspaceDirty: false,
  };
  database.prepare(`
    INSERT INTO agent_runs(id,request_id,created_at,workspace_path,goal,status,checkpoint_json)
    VALUES(?,?,?,?,?,'running',?)
  `).run(id, "legacy-overflow", Date.now(), project, "legacy overflow", JSON.stringify(rawCheckpoint));

  assert.deepEqual(audit.markInterruptedRuns(userData), { runs: 1, calls: 0 });
  const archived = audit.getRun(userData, id);
  assert.equal(archived.status, "interrupted");
  assert.equal(archived.checkpoint, null);
  assert.equal(archived.resumable, false, "无法验证的历史记录不能自动恢复写入");
  const stored = database.prepare("SELECT checkpoint_json FROM agent_runs WHERE id=?").get(id);
  assert.equal(JSON.parse(stored.checkpoint_json).changedPaths.length, 201, "原始异常路径不能被静默截掉");
});

test("checkpoint hashing never reads a sparse multi-gigabyte file into memory", async () => {
  const { project, userData } = tempSandbox();
  const hugePath = path.join(project, "huge.bin");
  const handle = fs.openSync(hugePath, "w");
  fs.ftruncateSync(handle, 3 * 1024 * 1024 * 1024);
  fs.closeSync(handle);
  const originalRead = fs.readFileSync;
  fs.readFileSync = function guardedRead(candidate, ...args) {
    if (path.resolve(String(candidate)) === hugePath) assert.fail("超大检查点文件不得调用 readFileSync");
    return originalRead.call(this, candidate, ...args);
  };
  try {
    assert.deepEqual(subject.workspaceFileState(project, "huge.bin"), {
      path: "huge.bin", sha256: null, exists: true, stale: true,
    });
    await assert.rejects(
      agentTools.executeToolCall(
        { tool: "read_file", args: { path: "huge.bin" } },
        { root: project, writable: false, userDataPath: userData, signal: new AbortController().signal },
      ),
      /不会读取，也不会解除写入锁/,
    );
    const checkpoint = {
      goal: "crash while writing huge file",
      workspace: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", realpath: project },
      plan: [], changedPaths: [], lastCheck: null, failureSummaries: [],
      stopReason: "running", mutationEpoch: 0, workspaceDirty: false,
    };
    const runId = audit.startRun(userData, {
      requestId: "huge-run", workspacePath: project, goal: checkpoint.goal, checkpoint,
    });
    audit.startToolCall(userData, {
      runId, requestId: "huge-run", tool: "apply_patch", workspacePath: project, args: { path: "huge.bin" },
    });
    audit.markInterruptedRuns(userData);
    assert.deepEqual(audit.getRun(userData, runId).checkpoint.changedPaths[0], {
      path: "huge.bin", sha256: null, exists: true, stale: true,
    });
  } finally {
    fs.readFileSync = originalRead;
  }
});

test("run_test file mutations enter changedPaths and advance the checkpoint epoch", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const script = path.join(project, "mutate.cjs");
  fs.writeFileSync(script, 'require("node:fs").writeFileSync("generated.txt", "made by test\\n");\n');
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "run-test-mutation",
    messages: [{ role: "user", content: "运行这个检查" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto", agentMaxRounds: 3 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      `<use_tool>{"tool":"run_test","args":{"command":"node","args":[${JSON.stringify(script)}]}}</use_tool>`,
      "检查结束。",
    ]),
  });
  assert.equal(result.ok, true);
  const checkpoint = audit.getRun(userData, result.runId).checkpoint;
  assert.deepEqual(checkpoint.changedPaths.map((item) => item.path), ["generated.txt"]);
  assert.equal(checkpoint.changedPaths[0].exists, true);
  assert.equal(checkpoint.changedPaths[0].stale, false);
  assert.equal(checkpoint.mutationEpoch, 1);
  assert.equal(checkpoint.workspaceDirty, false);
});

test("run_test safety scan sees build, hidden, dependency and directories deeper than the UI index", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const deepRelative = Array.from({ length: 15 }, (_value, index) => `d${index}`).join("/");
  const script = path.join(project, "mutate-blind-spots.cjs");
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    `const targets = ${JSON.stringify([
      "build/victim.txt",
      ".hidden/victim.txt",
      "node_modules/pkg/victim.txt",
      `${deepRelative}/victim.txt`,
    ])};`,
    'for (const target of targets) { fs.mkdirSync(require("node:path").dirname(target), { recursive: true }); fs.writeFileSync(target, "changed\\n"); }',
    "",
  ].join("\n"));
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "run-test-blind-spots",
    messages: [{ role: "user", content: "运行可能写构建目录的检查" }],
    skillId: "none", options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto", agentMaxRounds: 3 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      `<use_tool>{"tool":"run_test","args":{"command":"node","args":[${JSON.stringify(script)}]}}</use_tool>`,
      "检查结束。",
    ]),
  });
  assert.equal(result.ok, true);
  const checkpoint = audit.getRun(userData, result.runId).checkpoint;
  assert.deepEqual(checkpoint.changedPaths.map((item) => item.path).sort(), [
    ".hidden/victim.txt",
    "build/victim.txt",
    `${deepRelative}/victim.txt`,
    "node_modules/pkg/victim.txt",
  ].sort());
  assert.equal(checkpoint.workspaceDirty, false, "真正全覆盖且不足 200 项时仍应可正常继续");
});

test("an internal dependency symlink is tracked without making run_test dirty", async () => {
  const { project, userData } = tempSandbox();
  const packageDirectory = path.join(project, "node_modules", "pkg");
  const binDirectory = path.join(project, "node_modules", ".bin");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "cli.cjs"), "console.log('ok');\n");
  fs.symlinkSync("../pkg/cli.cjs", path.join(binDirectory, "pkg-cli"));
  const snapshot = await agentTools.snapshotWorkspaceForRun(project);
  assert.equal(snapshot.complete, true);
  assert.match(snapshot.entries.get("node_modules/.bin/pkg-cli"), /^symlink:/);
  const result = await agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: ["--version"] } },
    { root: project, writable: true, userDataPath: userData, signal: new AbortController().signal },
  );
  assert.equal(result.meta.workspaceScanComplete, true);
  assert.equal(result.meta.workspaceDirty, false);
  assert.deepEqual(result.meta.workspaceChanges, []);
});

test("an external symlink or other rejected scan boundary makes run_test fail closed", async () => {
  const { base, project, userData } = tempSandbox();
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "victim.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(project, "blind-link"));
  assert.equal((await agentTools.snapshotWorkspaceForRun(project)).complete, false);
  const result = await agentTools.executeToolCall(
    { tool: "run_test", args: { command: "node", args: ["--version"] } },
    { root: project, writable: true, userDataPath: userData, signal: new AbortController().signal },
  );
  assert.equal(result.meta.workspaceScanComplete, false);
  assert.equal(result.meta.workspaceDirty, true);
  assert.deepEqual(result.meta.workspaceChanges, []);
  assert.equal(fs.readFileSync(path.join(outside, "victim.txt"), "utf8"), "outside\n");

  const { project: brokenProject } = tempSandbox();
  fs.symlinkSync("missing-target", path.join(brokenProject, "broken-link"));
  assert.equal((await agentTools.snapshotWorkspaceForRun(brokenProject)).complete, false, "断链不得被当成已全量扫描");
});

test("run_test creating 201 files locks the workspace and leaves a resumable bounded checkpoint", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const script = path.join(project, "fanout.cjs");
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    'for (let index = 0; index < 201; index += 1) fs.writeFileSync(`fan-${String(index).padStart(3, "0")}.txt`, "x\\n");',
    "",
  ].join("\n"));
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "run-test-fanout",
    messages: [{ role: "user", content: "运行批量生成检查" }],
    skillId: "none", options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto", agentMaxRounds: 2 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      `<use_tool>{"tool":"run_test","args":{"command":"node","args":[${JSON.stringify(script)}]}}</use_tool>`,
    ]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.resumable, true);
  assert.equal(fs.existsSync(path.join(project, "fan-200.txt")), true, "命令边界不是文件系统沙箱，需诚实检测已落盘变化");
  const run = audit.getRun(userData, result.runId);
  assert.equal(run.status, "interrupted");
  assert.equal(run.checkpoint.changedPaths.length, 200);
  assert.equal(run.checkpoint.workspaceDirty, true);
  assert.equal(run.resumable, true);
});

test("a run_test found running after a crash makes the resumed run permanently read-only", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  const added = workspace.addWorkspace(userData, project);
  const workspaceId = added.roots[0].id;
  workspace.setWorkspaceWritable(userData, workspaceId, true);
  const checkpoint = {
    goal: "resume after test crash",
    workspace: { id: workspaceId, realpath: project },
    plan: [], changedPaths: [], lastCheck: null, failureSummaries: [],
    stopReason: "running", mutationEpoch: 0, workspaceDirty: false,
  };
  const parentId = audit.startRun(userData, {
    requestId: "test-crash-parent", workspacePath: project, goal: checkpoint.goal, checkpoint,
  });
  audit.startToolCall(userData, {
    runId: parentId, requestId: "test-crash-parent", tool: "run_test", workspacePath: project,
    args: { command: "node", args: ["--version"] },
  });
  // 模拟崩溃前的测试进程已经改了一个检查点不知道的文件。
  fs.writeFileSync(path.join(project, "victim.txt"), "unknown crash result\n");
  audit.markInterruptedRuns(userData);
  const interrupted = audit.getRun(userData, parentId);
  assert.equal(interrupted.checkpoint.workspaceDirty, true);
  assert.equal(interrupted.resumable, true);
  assert.match(subject.formatResumeContext({ checkpoint: interrupted.checkpoint }), /本次恢复只能查看/);
  assert.match(subject.formatResumeContext({ checkpoint: interrupted.checkpoint }), /另开新的工程任务/);

  const recorded = senderRecorder();
  const result = await subject.streamChat(recorded.sender, {
    requestId: "test-crash-child",
    messages: [{ role: "user", content: "继续" }],
    skillId: "none", options: { useTools: true }, resumeRunId: parentId,
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto", agentMaxRounds: 5 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"victim.txt","find":"unknown crash result","replace":"changed too early"}}</use_tool>',
      '<use_tool>{"tool":"list_dir","args":{"path":"."}}</use_tool>',
      '<use_tool>{"tool":"read_file","args":{"path":"victim.txt"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"victim.txt","find":"unknown crash result","replace":"changed after read"}}</use_tool>',
      "我只能查看；需要另开工程任务才能继续修改。",
    ]),
  });
  assert.equal(result.ok, true);
  const toolEvents = recorded.events.filter((event) => event.channel === "chat:tool");
  const blockedWrites = toolEvents.filter((event) => event.payload.tool === "apply_patch" && event.payload.status === "blocked");
  assert.equal(blockedWrites.length, 2, "目录扫描和读取文件都不能解除未知改动锁");
  assert.match(blockedWrites[0].payload.detail, /本次恢复只能查看/);
  assert.equal(toolEvents.some((event) => event.payload.tool === "list_dir" && event.payload.status === "ok"), true);
  assert.equal(toolEvents.some((event) => event.payload.tool === "read_file" && event.payload.status === "ok"), true);
  assert.equal(fs.readFileSync(path.join(project, "victim.txt"), "utf8"), "unknown crash result\n");
  assert.equal(audit.getRun(userData, result.runId).checkpoint.workspaceDirty, true);
});

test("renderer destruction leaves an engineering checkpoint interrupted and resumable", async () => {
  subject.resetState();
  const { EventEmitter } = require("node:events");
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const events = [];
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => events.push({ channel, payload });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("renderer gone"), { name: "AbortError" })), { once: true });
      });
    }
    throw new Error("不应进入模型生成");
  };
  const running = subject.streamChat(sender, {
    requestId: "renderer-crash-agent",
    messages: [{ role: "user", content: "检查项目" }],
    skillId: "none", options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, agentApproval: "auto" },
    userDataPath: userData,
    fetchImpl,
  });
  while (!events.some((event) => event.channel === "chat:agent-start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  sender.emit("destroyed");
  const result = await running;
  assert.equal(result.cancelled, false);
  assert.equal(result.resumable, true);
  const run = audit.getRun(userData, result.runId);
  assert.equal(run.status, "interrupted");
  assert.equal(run.resumable, true);
});

test("a credential embedded in a failed tool path never enters the checkpoint", async () => {
  subject.resetState();
  const providers = require("../../electron/lib/providers.cjs");
  const { project, userData } = tempSandbox();
  const fakeKey = "sk-failure-path-secret-0123456789";
  providers.setApiKey(userData, "deepseek", fakeKey);
  workspace.addWorkspace(userData, project);
  const result = await subject.streamChat(senderRecorder().sender, {
    requestId: "req-secret-failure-path",
    messages: [{ role: "user", content: "读一下缺失文件" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings: { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 2 },
    userDataPath: userData,
    fetchImpl: agentFetch([
      `<use_tool>{"tool":"read_file","args":{"path":"missing-${fakeKey}.txt"}}</use_tool>`,
      "文件不存在。",
    ]),
  });
  assert.equal(result.ok, true);
  const run = audit.getRun(userData, result.runId);
  assert.equal(JSON.stringify(run.checkpoint).includes(fakeKey), false);
  assert.equal(run.checkpoint.failureSummaries.length, 1);
  assert.match(run.checkpoint.failureSummaries[0].path, /已隐藏|REDACTED/);
});

test("a captured agent context cannot outlive workspace authorization or write permission", async () => {
  subject.resetState();
  const first = tempSandbox();
  fs.writeFileSync(path.join(first.project, "a.txt"), "before\n");
  const granted = workspace.addWorkspace(first.userData, first.project);
  const context = subject.resolveAgentContext(first.userData, { useTools: true }, {
    ...subject.DEFAULT_SETTINGS,
    agentApproval: "auto",
  });
  workspace.removeWorkspace(first.userData, granted.roots[0].id);
  const revoked = await subject.performToolCall({
    sender: senderRecorder().sender,
    requestId: "req-live-revoked",
    runId: null,
    block: '<use_tool>{"tool":"read_file","args":{"path":"a.txt"}}</use_tool>'.slice(10, -11),
    nativeCall: null,
    agentContext: context,
    userDataPath: first.userData,
    signal: new AbortController().signal,
    history: agentProtocol.createCallHistory(),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.blocked, true);
  assert.match(revoked.modelText, /授权已经撤销/);

  const second = tempSandbox();
  fs.writeFileSync(path.join(second.project, "a.txt"), "before\n");
  const writable = workspace.addWorkspace(second.userData, second.project);
  workspace.setWorkspaceWritable(second.userData, writable.roots[0].id, true);
  const writeContext = subject.resolveAgentContext(second.userData, { useTools: true }, {
    ...subject.DEFAULT_SETTINGS,
    agentApproval: "auto",
  });
  workspace.setWorkspaceWritable(second.userData, writable.roots[0].id, false);
  const locked = await subject.performToolCall({
    sender: senderRecorder().sender,
    requestId: "req-live-readonly",
    runId: null,
    block: '{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}',
    nativeCall: null,
    agentContext: writeContext,
    userDataPath: second.userData,
    signal: new AbortController().signal,
    history: agentProtocol.createCallHistory(),
  });
  assert.equal(locked.ok, false);
  assert.equal(locked.blocked, true);
  assert.match(locked.modelText, /关闭改写权限/);
  assert.equal(fs.readFileSync(path.join(second.project, "a.txt"), "utf8"), "before\n");
});

test("revoking write permission while approval waits prevents the approved write", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const granted = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, granted.roots[0].id, true);
  const context = subject.resolveAgentContext(userData, { useTools: true }, {
    ...subject.DEFAULT_SETTINGS,
    agentApproval: "ask",
  });
  const { events, sender } = senderRecorder();
  const pending = subject.performToolCall({
    sender,
    requestId: "req-live-approval",
    runId: "run-live-approval",
    block: '{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}',
    nativeCall: null,
    agentContext: context,
    userDataPath: userData,
    signal: new AbortController().signal,
    history: agentProtocol.createCallHistory(),
  });
  while (!events.some((event) => event.channel === "chat:tool" && event.payload.status === "waiting")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const waiting = events.find((event) => event.channel === "chat:tool" && event.payload.status === "waiting");
  workspace.setWorkspaceWritable(userData, granted.roots[0].id, false);
  assert.deepEqual(subject.resolveToolApproval(waiting.payload.callId, true), { ok: true, found: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.modelText, /关闭改写权限/);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "before\n");
});

test("truncated agent output remains resumable but error and cancellation do not", () => {
  const { project, userData } = tempSandbox();
  const workspaceId = workspace.addWorkspace(userData, project).roots[0].id;
  const baseCheckpoint = {
    goal: "完成工程任务",
    workspace: { id: workspaceId, realpath: project },
    plan: [],
    changedPaths: [],
    lastCheck: null,
    failureSummaries: [],
    stopReason: "running",
    mutationEpoch: 0,
  };
  for (const [name, status, stopReason, expected] of [
    ["truncated", "done", "truncated", true],
    ["error", "error", "error", false],
    ["cancelled", "cancelled", "cancelled", false],
  ]) {
    const runId = audit.startRun(userData, {
      requestId: `req-${name}`,
      workspacePath: project,
      goal: baseCheckpoint.goal,
      checkpoint: baseCheckpoint,
    });
    audit.finishRun(userData, runId, {
      status,
      detail: stopReason,
      checkpoint: { ...baseCheckpoint, stopReason },
    });
    assert.equal(audit.getRun(userData, runId).resumable, expected, name);
  }
});

test("@ mentions inline real file content through the same path jail", () => {
  const { project } = tempSandbox();
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "a.ts"), "export const answer = 42;\n");

  assert.deepEqual(agentProtocol.extractMentions("看看 @src/a.ts 和 @README.md 行不行"), ["src/a.ts", "README.md"]);
  assert.deepEqual(agentProtocol.extractMentions("邮箱是 me@example.com"), []);
  assert.deepEqual(agentProtocol.extractMentions("试试 @../../etc/passwd"), []);
  assert.deepEqual(agentProtocol.extractMentions("试试 @/etc/passwd"), []);

  const resolved = agentProtocol.readMentionedFiles(project, "解释一下 @src/a.ts。");
  assert.equal(resolved.mentions[0].ok, true);
  assert.match(resolved.context, /export const answer = 42;/);

  const missing = agentProtocol.readMentionedFiles(project, "看 @src/nope.ts");
  assert.equal(missing.mentions[0].ok, false);
  assert.match(missing.context, /读不出来/);
});

test("older tool output is folded instead of dropped", () => {
  const messages = [
    { role: "user", content: "开始" },
    { role: "assistant", content: "调用" },
    { role: "user", content: "[工具结果 read_file]\n第一轮很长的输出\nA\nB\nC\nD" },
    { role: "assistant", content: "再调用" },
    { role: "user", content: "[工具结果 search_text]\n第二轮很长的输出\nA\nB\nC\nD" },
    { role: "assistant", content: "又调用" },
    { role: "user", content: "[工具结果 run_test]\n第三轮很长的输出\nA\nB\nC\nD" },
  ];
  const folded = agentProtocol.compactAgentConversation(messages, { keepRecentRounds: 2 });
  assert.equal(folded.compacted, 1);
  assert.match(folded.messages[2].content, /^\[工具结果 read_file\]/);
  assert.match(folded.messages[2].content, /详细输出已折叠/);
  assert.doesNotMatch(folded.messages[2].content, /第一轮很长的输出/);
  assert.match(folded.messages[4].content, /第二轮很长的输出/);
  assert.match(folded.messages[6].content, /第三轮很长的输出/);
  assert.equal(agentProtocol.compactAgentConversation(messages.slice(0, 3)).compacted, 0);
});

function agentFetch(script) {
  let index = 0;
  return async (url) => {
    if (url.endsWith("/health")) return new Response("ok", { status: 200 });
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = script[Math.min(index, script.length - 1)];
    index += 1;
    return sseResponse(body);
  };
}

test("a write tool waits for the user and a refusal is reported truthfully to the model", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "ask" };

  const { events, sender } = senderRecorder();
  const chat = subject.streamChat(sender, {
    requestId: "req-approval-deny",
    messages: [{ role: "user", content: "把 before 改成 after" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}</use_tool>',
      "好的，我没有改动这个文件。",
    ]),
  });

  const waiting = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const event = events.find((item) => item.channel === "chat:tool" && item.payload.status === "waiting");
      if (event) {
        clearInterval(timer);
        resolve(event);
      }
    }, 5);
  });
  assert.equal(waiting.payload.tool, "apply_patch");
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "before\n");

  assert.deepEqual(subject.resolveToolApproval(waiting.payload.callId, false), { ok: true, found: true });
  const result = await chat;

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "before\n");
  const denied = events.filter((event) => event.channel === "chat:tool" && event.payload.status === "denied");
  assert.equal(denied.length, 1);
  assert.match(denied[0].payload.summary, /拒绝/);
  assert.equal(audit.listToolCalls(userData, { limit: 1 })[0].status, "denied");
});

test("approving a write tool lets it run and the file really changes", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "ask" };

  const { events, sender } = senderRecorder();
  const chat = subject.streamChat(sender, {
    requestId: "req-approval-allow",
    messages: [{ role: "user", content: "把 before 改成 after" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}</use_tool>',
      "已经改好了。",
    ]),
  });

  const waiting = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const event = events.find((item) => item.channel === "chat:tool" && item.payload.status === "waiting");
      if (event) {
        clearInterval(timer);
        resolve(event);
      }
    }, 5);
  });
  subject.resolveToolApproval(waiting.payload.callId, true);
  const result = await chat;

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "after\n");
  assert.equal(events.some((event) => event.channel === "chat:tool" && event.payload.status === "ok"), true);
});

test("auto mode skips the prompt but read-only tools never ask in the first place", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "auto" };

  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-approval-auto",
    messages: [{ role: "user", content: "改掉它" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}</use_tool>',
      "改好了。",
    ]),
  });

  assert.equal(result.ok, true);
  assert.equal(events.some((event) => event.channel === "chat:tool" && event.payload.status === "waiting"), false);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "after\n");
});

test("a pending approval is refused when the user stops generation", async () => {
  subject.resetState();
  const controller = new AbortController();
  const pending = subject.requestToolApproval("11111111-1111-1111-1111-111111111111", controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { approved: false, reason: "cancelled" });
  assert.deepEqual(subject.resolveToolApproval("11111111-1111-1111-1111-111111111111", true), { ok: false, found: false });
});

test("an unanswered approval times out as a refusal, never as a silent yes", async () => {
  subject.resetState();
  const decision = await subject.requestToolApproval("22222222-2222-2222-2222-222222222222", undefined, { timeoutMs: 30 });
  assert.deepEqual(decision, { approved: false, reason: "timeout" });
});

test("agentApproval is validated like every other setting", () => {
  assert.equal(subject.DEFAULT_SETTINGS.agentApproval, "ask");
  assert.throws(() => subject.validateFullSettings({ ...subject.DEFAULT_SETTINGS, agentApproval: "always" }), /agentApproval无效/);
  assert.deepEqual(subject.sanitizeSettingsPatch({ agentApproval: "auto" }), { agentApproval: "auto" });
  assert.throws(() => subject.sanitizeSettingsPatch({ agentApproval: "yolo" }), /agentApproval值无效/);
});

test("a denied or failed tool result tells the model it did not happen", () => {
  const denied = agentProtocol.formatToolResultMessage({ tool: "apply_patch", ok: false, denied: true, text: "你拒绝了这次改动" });
  assert.match(denied, /用户拒绝/);
  assert.match(denied, /这次改动没有发生/);
  assert.match(denied, /不要把没做成的事说成已完成/);

  const failed = agentProtocol.formatToolResultMessage({ tool: "run_test", ok: false, text: "命令无法启动" });
  assert.match(failed, /调用失败/);
  assert.match(failed, /实际什么都没有发生/);
  assert.match(failed, /不说明整个任务做不了/);
  assert.match(failed, /不要假装成功/);

  const fine = agentProtocol.formatToolResultMessage({ tool: "read_file", ok: true, text: "内容" });
  assert.match(fine, /请根据这个真实结果继续/);
  assert.doesNotMatch(fine, /没有发生/);
});

test("the agent prompt forbids reporting refused work as done", () => {
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const context = subject.resolveAgentContext(userData, { useTools: true }, { ...subject.DEFAULT_SETTINGS });
  assert.match(context.basePrompt, /被用户拒绝、报错、超时的改动一律算没做成/);
  assert.match(context.basePrompt, /绝对不能描述成已完成/);
});

test("a refusal reaches the model as a denial, not as a generic failure", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "ask" };

  const prompts = [];
  const { events, sender } = senderRecorder();
  const chat = subject.streamChat(sender, {
    requestId: "req-denied-feedback",
    messages: [{ role: "user", content: "改掉它" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/health")) return new Response("ok", { status: 200 });
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      prompts.push(JSON.parse(options.body));
      return prompts.length === 1
        ? sseResponse('<use_tool>{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}</use_tool>')
        : sseResponse("没有改成，你拒绝了这次改动。");
    },
  });

  const waiting = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const event = events.find((item) => item.channel === "chat:tool" && item.payload.status === "waiting");
      if (event) {
        clearInterval(timer);
        resolve(event);
      }
    }, 5);
  });
  subject.resolveToolApproval(waiting.payload.callId, false);
  await chat;

  const feedback = prompts[1].messages.at(-1).content;
  assert.match(feedback, /用户拒绝/);
  assert.match(feedback, /这次改动没有发生，文件仍然是原样/);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "before\n");
});

test("a wrong anchor gets the real nearby lines back instead of a bare failure", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "calc.js"), [
    "function add(a, b) {",
    "  return a - b;",
    "}",
    "",
    "module.exports = { add };",
    "",
  ].join("\n"));
  const context = { root: project, writable: true, userDataPath: userData, callId: "call-near" };

  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "calc.js", find: "return a-b;", replace: "return a + b;" } },
      context,
    ),
    (error) => {
      assert.match(error.message, /最接近的是这一段/);
      assert.match(error.message, /return a - b;/);
      assert.match(error.message, /^\s+2\| /m);
      return true;
    },
  );
  assert.match(fs.readFileSync(path.join(project, "calc.js"), "utf8"), /return a - b;/);

  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "calc.js", find: "完全无关的内容 zzz", replace: "x" } },
      context,
    ),
    /没有相近的行/,
  );
});

test("only whitespace differences are forgiven, and the receipt says so", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "function go() {\n    return 1;\n}\n");
  const context = { root: project, writable: true, userDataPath: userData, callId: "call-ws" };

  const result = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "a.js", find: "function go() {\n  return 1;\n}", replace: "function go() {\n    return 2;\n}" } },
    context,
  );
  assert.match(result.summary, /改写 a\.js/);
  assert.match(result.detail, /空白和原文不完全一致/);
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "function go() {\n    return 2;\n}\n");

  assert.deepEqual(agentTools.locateAnchor("abc", "abc"), { kind: "exact", start: 0, end: 3 });
  assert.equal(agentTools.locateAnchor("x\nx\n", "x").kind, "ambiguous");
});

test("edits apply several changes at once and never leave a half-written file", async () => {
  const { project, userData } = tempSandbox();
  const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  fs.writeFileSync(path.join(project, "v.js"), original);
  const context = (callId) => ({ root: project, writable: true, userDataPath: userData, callId });

  const applied = await agentTools.executeToolCall({
    tool: "apply_patch",
    args: {
      path: "v.js",
      edits: [
        { find: "const a = 1;", replace: "const a = 10;" },
        { find: "const c = 3;", replace: "const c = 30;" },
      ],
    },
  }, context("call-multi"));
  assert.match(applied.summary, /\+2 -2/);
  assert.equal(fs.readFileSync(path.join(project, "v.js"), "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n");

  fs.writeFileSync(path.join(project, "v.js"), original);
  await assert.rejects(
    agentTools.executeToolCall({
      tool: "apply_patch",
      args: {
        path: "v.js",
        edits: [
          { find: "const a = 1;", replace: "const a = 99;" },
          { find: "这一行根本不存在 qqq", replace: "x" },
        ],
      },
    }, context("call-multi-fail")),
    /第 2 处修改失败/,
  );
  assert.equal(fs.readFileSync(path.join(project, "v.js"), "utf8"), original, "任一处失败时整个文件必须保持原样");

  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "v.js", find: "x", edits: [{ find: "y", replace: "z" }] } },
      context("call-both"),
    ),
    /四选一/,
  );
});

test("a write is previewed as a real diff before anyone approves it", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "p.txt"), "old\n");
  const context = { root: project, writable: true, userDataPath: userData, callId: "call-preview" };

  const preview = await agentTools.previewToolCall(
    { tool: "apply_patch", args: { path: "p.txt", find: "old", replace: "new" } },
    context,
  );
  assert.match(preview.summary, /改写 p\.txt：\+1 -1/);
  assert.match(preview.detail, /^-old$/m);
  assert.match(preview.detail, /^\+new$/m);
  assert.equal(fs.readFileSync(path.join(project, "p.txt"), "utf8"), "old\n", "预览绝不能写盘");

  const commandPreview = await agentTools.previewToolCall(
    { tool: "run_test", args: { command: "npm", args: ["test"] } },
    context,
  );
  assert.match(commandPreview.summary, /npm test/);
  assert.match(commandPreview.detail, /工作目录：/);

  const broken = await agentTools.previewToolCall(
    { tool: "apply_patch", args: { path: "p.txt", find: "不存在 zzz", replace: "x" } },
    context,
  );
  assert.equal(broken.invalid, true);

  assert.equal(await agentTools.previewToolCall({ tool: "read_file", args: { path: "p.txt" } }, context), null);
});

test("the waiting card carries the diff, not just the intent", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "before\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 1024, agentApproval: "ask" };

  const { events, sender } = senderRecorder();
  const chat = subject.streamChat(sender, {
    requestId: "req-preview",
    messages: [{ role: "user", content: "改掉它" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.txt","find":"before","replace":"after"}}</use_tool>',
      "好的。",
    ]),
  });

  const waiting = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const event = events.find((item) => item.channel === "chat:tool" && item.payload.status === "waiting");
      if (event) {
        clearInterval(timer);
        resolve(event);
      }
    }, 5);
  });
  assert.match(waiting.payload.detail, /^-before$/m);
  assert.match(waiting.payload.detail, /^\+after$/m);
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "before\n");
  subject.resolveToolApproval(waiting.payload.callId, true);
  await chat;
  assert.equal(fs.readFileSync(path.join(project, "a.txt"), "utf8"), "after\n");
});

test("check_project recognises the project and suggests real commands", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({
    name: "demo",
    scripts: { test: "node --test", build: "vite build" },
  }));
  const result = await agentTools.executeToolCall(
    { tool: "check_project", args: {} },
    { root: project, writable: false, userDataPath: userData, callId: "call-check" },
  );
  assert.match(result.modelText, /Node 项目（demo）/);
  assert.match(result.modelText, /可用脚本：test、build/);
  assert.match(result.modelText, /"command": "npm", "args": \["test"\]/);
  assert.equal(agentTools.listTools().some((tool) => tool.id === "check_project"), true);
});

test("one task's whole set of changes can be undone in reverse order", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "one.txt"), "1\n");
  fs.writeFileSync(path.join(project, "two.txt"), "2\n");
  const runId = audit.startRun(userData, { requestId: "req-run", workspacePath: project, goal: "改两个文件" });

  const snapshots = [];
  for (const [file, replacement] of [["one.txt", "ONE"], ["two.txt", "TWO"]]) {
    const callId = audit.startToolCall(userData, { runId, requestId: "req-run", tool: "apply_patch", workspacePath: project, args: { path: file } });
    const result = await agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: file, find: file === "one.txt" ? "1" : "2", replace: replacement } },
      { root: project, writable: true, userDataPath: userData, callId },
    );
    audit.finishToolCall(userData, callId, { status: "ok", summary: result.summary, detail: result.detail, changedPath: result.changedPath, snapshotPath: result.snapshotPath });
    snapshots.push({ callId, snapshotPath: result.snapshotPath });
  }
  assert.equal(fs.readFileSync(path.join(project, "one.txt"), "utf8"), "ONE\n");
  assert.equal(fs.readFileSync(path.join(project, "two.txt"), "utf8"), "TWO\n");

  const calls = audit.listRunToolCalls(userData, runId).filter((call) => call.snapshotPath && !call.rolledBack);
  assert.equal(calls.length, 2);
  for (const call of calls.reverse()) {
    agentTools.rollbackSnapshot(call.workspacePath, call.snapshotPath);
    audit.markRolledBack(userData, call.id);
  }
  assert.equal(fs.readFileSync(path.join(project, "one.txt"), "utf8"), "1\n");
  assert.equal(fs.readFileSync(path.join(project, "two.txt"), "utf8"), "2\n");
  assert.equal(audit.listRunToolCalls(userData, runId).every((call) => call.rolledBack), true);
});

test("the prompt shows the model a worked example instead of only rules", () => {
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const context = subject.resolveAgentContext(userData, { useTools: true }, { ...subject.DEFAULT_SETTINGS });
  assert.match(context.basePrompt, /一个文件里要改好几个短片段时，用 edits 一次发完/);
  assert.match(context.basePrompt, /"tool": "apply_patch", "args": \{"path": "src\/a\.ts", "edits"/);
  assert.match(context.basePrompt, /典型流程（照着做）/);
  assert.match(context.basePrompt, /check_project/);
});

test("a missing git repository is reported as harmless, not as a blocker", async () => {
  const { project, userData } = tempSandbox();
  const result = await agentTools.executeToolCall(
    { tool: "git_status", args: {} },
    { root: project, writable: false, userDataPath: userData, callId: "call-git" },
  );
  assert.match(result.summary, /不是 Git 仓库|没有 git|读不到 Git 状态/);
  assert.match(result.modelText, /不影响|继续/);
});

test("the prompt tells the model that one failed step is not a failed task", () => {
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const context = subject.resolveAgentContext(userData, { useTools: true }, { ...subject.DEFAULT_SETTINGS });
  assert.match(context.basePrompt, /一个工具失败不等于整个任务失败/);
  assert.match(context.basePrompt, /换个工具或换个做法继续做完/);
  assert.match(context.basePrompt, /git_status 只用来看有哪些文件被改过/);
});

test("a patch that breaks syntax is rolled back automatically and reported honestly", async () => {
  const { project, userData } = tempSandbox();
  const original = [
    "function subtotal(items) {",
    "  let total = 0;",
    "  for (const item of items) {",
    "    total += item.price;",
    "  }",
    "  return total;",
    "}",
    "",
    "module.exports = { subtotal };",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(project, "cart.js"), original);
  const context = (callId) => ({ root: project, writable: true, userDataPath: userData, callId });

  // 这是 8B 最常犯的错：replace 里把 find 的原文又抄了一遍，留下两份函数体。
  await assert.rejects(
    agentTools.executeToolCall({
      tool: "apply_patch",
      args: {
        path: "cart.js",
        find: "  let total = 0;",
        replace: "  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }\n  return total;\n  let total = 0;",
      },
    }, context("call-broken")),
    (error) => {
      assert.match(error.message, /语法不合法，已经自动还原/);
      assert.match(error.message, /下一次请改用按行替换/);
      assert.match(error.message, /^\s+1\| function subtotal\(items\) \{$/m, "失败时要把带行号的真实内容一起交回去");
      assert.match(error.message, /"start_line": 起始行/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(project, "cart.js"), "utf8"), original, "语法坏掉时必须回到修改前");

  const good = await agentTools.executeToolCall({
    tool: "apply_patch",
    args: { path: "cart.js", find: "total += item.price;", replace: "total += item.price * item.quantity;" },
  }, context("call-good"));
  assert.match(good.summary, /改写 cart\.js/);
  assert.match(fs.readFileSync(path.join(project, "cart.js"), "utf8"), /item\.price \* item\.quantity/);

  fs.writeFileSync(path.join(project, "conf.json"), '{"a": 1}\n');
  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "conf.json", find: '{"a": 1}', replace: '{"a": 1,,}' } },
      context("call-json"),
    ),
    /JSON 解析失败/,
  );
  assert.equal(fs.readFileSync(path.join(project, "conf.json"), "utf8"), '{"a": 1}\n');

  fs.writeFileSync(path.join(project, "notes.md"), "# 标题\n");
  const markdown = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "notes.md", find: "# 标题", replace: "# 新标题 {{{" } },
    context("call-md"),
  );
  assert.match(markdown.summary, /改写 notes\.md/, "没有语法检查器的文件类型不该被拦住");
});

test("syntax verification only fires for the file types it really understands", () => {
  const { project } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.txt"), "随便什么内容 {{{");
  assert.deepEqual(agentTools.verifySyntaxAfterWrite(path.join(project, "a.txt")), { checked: false, ok: true });
  fs.writeFileSync(path.join(project, "b.json"), "{ not json");
  assert.equal(agentTools.verifySyntaxAfterWrite(path.join(project, "b.json")).ok, false);
  fs.writeFileSync(path.join(project, "c.js"), "const a = 1;\n");
  assert.equal(agentTools.verifySyntaxAfterWrite(path.join(project, "c.js")).ok, true);
  fs.writeFileSync(path.join(project, "d.py"), "answer = 42\n");
  assert.equal(agentTools.verifySyntaxAfterWrite(path.join(project, "d.py")).ok, true);
  assert.equal(fs.existsSync(path.join(project, "__pycache__")), false, "语法检查不得偷写 pyc");
});

test("a failed atomic rename leaves neither a changed target nor a kaii temp file", async () => {
  const { project, userData } = tempSandbox();
  const target = path.join(project, "locked.txt");
  fs.writeFileSync(target, "before\n");
  const originalRename = fs.renameSync;
  fs.renameSync = function failTargetRename(from, to) {
    if (path.resolve(String(to)) === target) throw Object.assign(new Error("simulated rename failure"), { code: "EACCES" });
    return originalRename.apply(this, arguments);
  };
  try {
    await assert.rejects(
      agentTools.executeToolCall(
        { tool: "apply_patch", args: { path: "locked.txt", find: "before", replace: "after" } },
        { root: project, writable: true, userDataPath: userData, callId: "rename-failure" },
      ),
      /simulated rename failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(target, "utf8"), "before\n");
  assert.deepEqual(fs.readdirSync(project).filter((name) => name.endsWith(".kaii-tmp")), []);
});

test("the prompt warns about the duplicate-body mistake before it happens", () => {
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const context = subject.resolveAgentContext(userData, { useTools: true }, { ...subject.DEFAULT_SETTINGS });
  assert.match(context.basePrompt, /replace 是【整段替换掉】find/);
  assert.match(context.basePrompt, /不要在 replace 里再把 find 的原文写一遍/);
  assert.match(context.basePrompt, /系统会自动查语法/);
});

test("line-range replacement lets the model edit without copying the original", async () => {
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "cart.js"), [
    "function subtotal(items) {",
    "  let total = 0;",
    "  for (const item of items) {",
    "    total += item.price;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n"));
  const context = (callId) => ({ root: project, writable: true, userDataPath: userData, callId });

  const result = await agentTools.executeToolCall({
    tool: "apply_patch",
    args: {
      path: "cart.js",
      start_line: 2,
      end_line: 5,
      content: "  let total = 0;\n  for (const item of items) {\n    total += item.price * item.quantity;\n  }",
    },
  }, context("call-lines"));

  assert.match(result.summary, /改写 cart\.js/);
  assert.match(result.detail, /按行替换：第 2-5 行/);
  assert.equal(fs.readFileSync(path.join(project, "cart.js"), "utf8"), [
    "function subtotal(items) {",
    "  let total = 0;",
    "  for (const item of items) {",
    "    total += item.price * item.quantity;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n"));

  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "cart.js", start_line: 99, content: "x" } },
      context("call-oob"),
    ),
    /超出文件范围/,
  );
  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "cart.js", start_line: 4, end_line: 2, content: "x" } },
      context("call-order"),
    ),
    /end_line 不能小于 start_line/,
  );
  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "cart.js", start_line: 2, find: "x", replace: "y" } },
      context("call-mixed"),
    ),
    /四选一/,
  );

  const deleted = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "cart.js", start_line: 8, end_line: 8, content: "" } },
    context("call-delete"),
  );
  assert.match(deleted.summary, /改写 cart\.js/);
});

test("a wrong path comes back with the real paths that exist", async () => {
  const { project, userData } = tempSandbox();
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src", "cart.js"), "const a = 1;\n");
  const context = { root: project, writable: false, userDataPath: userData, callId: "call-hint" };

  await assert.rejects(
    agentTools.executeToolCall({ tool: "read_file", args: { path: "cart.js" } }, context),
    (error) => {
      assert.match(error.message, /最接近的是/);
      assert.match(error.message, /src\/cart\.js/);
      return true;
    },
  );
  await assert.rejects(
    agentTools.executeToolCall({ tool: "read_file", args: { path: "完全没有的东西.zzz" } }, context),
    /先用 list_dir 看看/,
  );
  assert.deepEqual(workspace.suggestPaths(project, "cart.js"), ["src/cart.js"]);
});

test("the prompt teaches line-range editing first", () => {
  const { project, userData } = tempSandbox();
  workspace.addWorkspace(userData, project);
  const context = subject.resolveAgentContext(userData, { useTools: true }, { ...subject.DEFAULT_SETTINGS });
  assert.match(context.basePrompt, /改多行代码时，优先用按行替换/);
  assert.match(context.basePrompt, /"start_line": 2, "end_line": 5/);
});

test("a tool call with raw newlines inside a JSON string is repaired, not rejected", () => {
  const multiline = [
    '{"tool": "apply_patch", "args": {"path": "cart.js", "start_line": 2, "end_line": 5, "content": "  let total = 0;',
    "  for (const item of items) {",
    "    total += item.price * item.quantity;",
    '  }"}}',
  ].join("\n");
  const parsed = agentProtocol.parseToolCallBlock(multiline);
  assert.equal(parsed.tool, "apply_patch");
  assert.equal(parsed.args.start_line, 2);
  assert.equal(parsed.args.content.split("\n").length, 4);
  assert.match(parsed.args.content, /item\.price \* item\.quantity/);
  assert.deepEqual(agentTools.validateToolCall(parsed).tool, "apply_patch");

  // 合法 JSON 必须原样通过，修复只在第一次解析失败后才启动。
  assert.deepEqual(
    agentProtocol.parseToolCallBlock('{"tool":"read_file","args":{"path":"a.ts"}}'),
    { tool: "read_file", args: { path: "a.ts" } },
  );
  assert.deepEqual(
    agentProtocol.parseToolCallBlock('{"tool":"read_file","args":{"path":"a\\nb.ts"}}').args.path,
    "a\nb.ts",
  );
  assert.equal(agentProtocol.escapeRawControlCharsInStrings('{"a": 1}\n'), '{"a": 1}\n');

  assert.throws(
    () => agentProtocol.parseToolCallBlock('{"tool": "read_file", "args": {"path": }}'),
    /字符串里的换行必须写成/,
  );
  assert.throws(() => agentProtocol.parseToolCallBlock('完全不是 JSON'), /不是 JSON 对象/);
});

test("an identical failing call is blocked instead of burning another round", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 6 };

  const badCall = '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"这段根本不存在 zzz","replace":"x"}}</use_tool>';
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-repeat",
    messages: [{ role: "user", content: "改一下" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([badCall, badCall, badCall, "我做不到，原因是找不到那段内容。"]),
  });

  assert.equal(result.ok, true);
  const toolEvents = events.filter((item) => item.channel === "chat:tool");
  const errored = toolEvents.filter((item) => item.payload.status === "error");
  const blocked = toolEvents.filter((item) => item.payload.status === "blocked");
  assert.equal(errored.length, 1, "同一个失败调用只该真正执行一次");
  assert.equal(blocked.length, 2, "后面两次必须被拦下");
  assert.match(blocked[0].payload.summary, /重复的失败调用，已拦下/);
  assert.match(blocked[0].payload.detail, /重复同一个调用不会有不同结果/);
  assert.match(blocked[0].payload.detail, /换按行替换/);

  // 被拦下的调用不能写进审计里当成一次真实执行。
  const audited = audit.listToolCalls(userData, { limit: 20 }).filter((call) => call.tool === "apply_patch");
  assert.equal(audited.length, 1);
});

test("a different call after a failure still runs", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 6 };

  const { events, sender } = senderRecorder();
  await subject.streamChat(sender, {
    requestId: "req-recover",
    messages: [{ role: "user", content: "改一下" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"不存在 zzz","replace":"x"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","start_line":1,"end_line":1,"content":"const a = 2;"}}</use_tool>',
      "改好了。",
    ]),
  });

  const toolEvents = events.filter((item) => item.channel === "chat:tool");
  assert.equal(toolEvents.some((item) => item.payload.status === "blocked"), false, "参数不同就不该被拦");
  assert.equal(toolEvents.some((item) => item.payload.status === "ok"), true);
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 2;\n");
});

test("running out of rounds is reported as continuable, a clean finish is not", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  workspace.addWorkspace(userData, project);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 2 };

  const read = '<use_tool>{"tool":"read_file","args":{"path":"a.js"}}</use_tool>';
  const exhausted = senderRecorder();
  await subject.streamChat(exhausted.sender, {
    requestId: "req-exhaust",
    messages: [{ role: "user", content: "看看" }],
    skillId: "none",
    options: { useTools: true },
  }, { settings, userDataPath: userData, fetchImpl: agentFetch([read, read, read, read]) });

  const done = exhausted.events.find((item) => item.channel === "chat:done");
  assert.equal(done.payload.stopReason, "max-rounds");
  assert.equal(done.payload.toolRounds, 2);
  assert.deepEqual(done.payload.completion, { state: "read-only", changedPaths: [], checks: [] });
  const notice = exhausted.events.filter((item) => item.channel === "chat:chunk").map((item) => item.payload.content).join("");
  assert.match(notice, /继续这个任务/);

  const clean = senderRecorder();
  await subject.streamChat(clean.sender, {
    requestId: "req-clean",
    messages: [{ role: "user", content: "看看" }],
    skillId: "none",
    options: { useTools: true },
  }, { settings, userDataPath: userData, fetchImpl: agentFetch([read, "看完了。"]) });
  assert.equal(clean.events.find((item) => item.channel === "chat:done").payload.stopReason, "answer");
});

test("an unfinished run with real changes is partial even without a later check", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 1 };
  const { events, sender } = senderRecorder();

  await subject.streamChat(sender, {
    requestId: "req-completion-partial",
    messages: [{ role: "user", content: "改完再检查" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 1;","replace":"const a = 2;"}}</use_tool>',
      '<use_tool>{"tool":"run_test","args":{"command":"node","args":["--check","a.js"]}}</use_tool>',
    ]),
  });

  const done = events.find((item) => item.channel === "chat:done");
  assert.equal(done.payload.stopReason, "max-rounds");
  assert.deepEqual(done.payload.completion, { state: "partial", changedPaths: ["a.js"], checks: [] });
  assert.deepEqual(audit.listRuns(userData, { limit: 1 })[0].completion, done.payload.completion);
});

test("the call fingerprint distinguishes arguments, not just tool names", () => {
  const history = agentProtocol.createCallHistory();
  const call = { tool: "run_test", args: { command: "npm", args: ["test"] } };
  assert.equal(history.priorFailure(call), null);
  history.recordFailure(call, "退出码 1");
  assert.equal(history.priorFailure(call), "退出码 1");
  assert.equal(history.priorFailure({ tool: "run_test", args: { command: "npm", args: ["run", "build"] } }), null);
  history.recordSuccess(call);
  assert.equal(history.priorFailure(call), null, "成功之后不该再被当成失败");

  const noop = { tool: "apply_patch", args: { path: "a.js", find: "x", replace: "x" } };
  assert.equal(history.isRepeatedNoop(noop), false);
  history.recordNoop(noop);
  assert.equal(history.isRepeatedNoop(noop), true);
  assert.match(
    agentProtocol.formatRepeatedCallMessage({ tool: "apply_patch", kind: "noop" }),
    /那次没有改变任何东西/,
  );
});

test("after one anchor failure a file only accepts line-range edits", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\nconst b = 2;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 6 };

  const { events, sender } = senderRecorder();
  await subject.streamChat(sender, {
    requestId: "req-linemode",
    messages: [{ role: "user", content: "改一下" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"不存在 zzz","replace":"x"}}</use_tool>',
      // 参数不同，所以不是"重复调用"，但同一个文件已经禁用按原文定位。
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"const a = 1;","replace":"const a = 9;"}}</use_tool>',
      '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","start_line":1,"end_line":1,"content":"const a = 9;"}}</use_tool>',
      "改好了。",
    ]),
  });

  const toolEvents = events.filter((item) => item.channel === "chat:tool");
  const blocked = toolEvents.filter((item) => item.payload.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].payload.summary, /只接受按行替换/);
  assert.match(blocked[0].payload.detail, /先 read_file|start_line/);
  assert.match(blocked[0].payload.detail, /^\s+1\| const a = 1;$/m, "拦下时要把带行号的真实内容一起给出");
  // 按行替换仍然放行，文件最终被改对。
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 9;\nconst b = 2;\n");
});

test("two blocked calls in a row stop the loop instead of burning every round", async () => {
  subject.resetState();
  const { project, userData } = tempSandbox();
  fs.writeFileSync(path.join(project, "a.js"), "const a = 1;\n");
  const added = workspace.addWorkspace(userData, project);
  workspace.setWorkspaceWritable(userData, added.roots[0].id, true);
  const settings = { ...subject.DEFAULT_SETTINGS, contextSize: 32_768, maxTokens: 900, agentApproval: "auto", agentMaxRounds: 8 };

  const bad = '<use_tool>{"tool":"apply_patch","args":{"path":"a.js","find":"不存在 zzz","replace":"x"}}</use_tool>';
  const { events, sender } = senderRecorder();
  const result = await subject.streamChat(sender, {
    requestId: "req-stuck",
    messages: [{ role: "user", content: "改一下" }],
    skillId: "none",
    options: { useTools: true },
  }, {
    settings,
    userDataPath: userData,
    fetchImpl: agentFetch([bad, bad, bad, "我卡住了，没有改成。", "多余的回合不该被用到"]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopReason, "stuck");
  assert.equal(result.toolRounds, 3, "第三次被拦下就该收尾，不该跑满 8 轮");
  const text = events.filter((item) => item.channel === "chat:chunk").map((item) => item.payload.content).join("");
  assert.match(text, /已经停下工具，先给结论/);
  assert.match(text, /我卡住了，没有改成/);
  assert.equal(fs.readFileSync(path.join(project, "a.js"), "utf8"), "const a = 1;\n");
});

test("an inconclusive syntax check never rolls back a good edit", async () => {
  const { project, userData } = tempSandbox();
  const original = "const a = 1;\n";
  fs.writeFileSync(path.join(project, "ok.js"), original);

  // 机器繁忙时 node --check 可能超时或被信号打断。那说明"没查成"，不是"代码坏了"，
  // 把它当成语法错误就会把一次正确的修改白白回滚掉。
  const timedOut = () => ({ error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null, signal: null });
  const killed = () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" });
  const missing = () => ({ status: undefined, stdout: "", stderr: "" });

  for (const [name, impl] of [["超时", timedOut], ["被杀", killed], ["没有退出码", missing]]) {
    const verdict = agentTools.verifySyntaxAfterWrite(path.join(project, "ok.js"), impl);
    assert.equal(verdict.ok, true, `${name}时不该判定为语法错误`);
    assert.equal(verdict.checked, false, `${name}时应当标记为没查成`);
    assert.equal(verdict.inconclusive, true);
  }

  const applied = await agentTools.executeToolCall(
    { tool: "apply_patch", args: { path: "ok.js", find: "const a = 1;", replace: "const a = 2;" } },
    { root: project, writable: true, userDataPath: userData, callId: "call-inconclusive", spawnSyncImpl: timedOut },
  );
  assert.match(applied.summary, /改写 ok\.js/);
  assert.equal(fs.readFileSync(path.join(project, "ok.js"), "utf8"), "const a = 2;\n", "查不成时要保留改动，而不是回滚");

  // 真正查出语法错误时仍然必须回滚。
  const realFailure = () => ({ status: 1, signal: null, stdout: "", stderr: "SyntaxError: Unexpected token" });
  await assert.rejects(
    agentTools.executeToolCall(
      { tool: "apply_patch", args: { path: "ok.js", find: "const a = 2;", replace: "const a = ;" } },
      { root: project, writable: true, userDataPath: userData, callId: "call-real-bad", spawnSyncImpl: realFailure },
    ),
    /语法不合法，已经自动还原/,
  );
  assert.equal(fs.readFileSync(path.join(project, "ok.js"), "utf8"), "const a = 2;\n");
});
