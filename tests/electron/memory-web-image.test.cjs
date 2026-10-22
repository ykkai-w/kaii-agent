const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const memory = require("../../electron/lib/memory.cjs");
const web = require("../../electron/lib/web-search.cjs");
const image = require("../../electron/lib/image-analysis.cjs");

const temporaryDirectories = [];

function tempDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-feature-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

test.after(() => {
  memory.resetMemoryDatabaseCache();
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

test("memory CRUD is explicit, persistent and archived instead of deleted", () => {
  const userData = tempDirectory();
  const created = memory.createMemory(userData, { content: "我偏好简洁的纸感界面", kind: "preference", pinned: true });
  assert.equal(created.content, "我偏好简洁的纸感界面");
  assert.equal(created.pinned, true);
  assert.equal(memory.listMemories(userData).length, 1);
  const updated = memory.updateMemory(userData, created.id, { content: "我偏好简洁、克制的纸感界面" });
  assert.match(updated.content, /克制/);
  memory.archiveMemory(userData, created.id, true);
  assert.equal(memory.listMemories(userData).length, 0);
  assert.equal(memory.listMemories(userData, { includeArchived: true })[0].archived, true);
  memory.archiveMemory(userData, created.id, false);
  assert.equal(memory.listMemories(userData).length, 1);
  const mode = fs.statSync(memory.databasePath(userData)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("memory validation and retrieval are bounded", () => {
  const userData = tempDirectory();
  const a = memory.createMemory(userData, { content: "kaii 项目使用 Electron", kind: "project" });
  memory.createMemory(userData, { content: "写作时避免套话", kind: "preference", pinned: true });
  assert.throws(() => memory.createMemory(userData, { content: "" }));
  assert.throws(() => memory.createMemory(userData, { content: "x", extra: true }));
  const selected = memory.selectRelevantMemories(memory.listMemories(userData), "kaii 用什么框架？", { limit: 1 });
  assert.equal(selected[0].id, a.id);
  const isolated = tempDirectory();
  memory.createMemory(isolated, { content: "DMR 项目使用 Python", kind: "project" });
  assert.deepEqual(memory.selectRelevantMemories(memory.listMemories(isolated), "今天天气怎么样？"), []);
});

test("memory provenance is backward compatible and audit history is append-only", () => {
  const userData = tempDirectory();
  const legacyStyle = memory.createMemory(userData, { content: "旧调用无需新字段" });
  assert.deepEqual(legacyStyle.source, { kind: "user" });
  assert.deepEqual(legacyStyle.scope, { kind: "global", id: null });
  assert.equal(legacyStyle.status, "valid");

  const sourced = memory.createMemory(userData, {
    content: "DMR 实验结果来自回测回执",
    kind: "fact",
    source: { kind: "task-capsule", capsuleId: "capsule-1", receiptId: "receipt-1" },
    scope: { kind: "project", id: "dmr-ml" },
    supersedes: legacyStyle.id,
    reason: "新回执替代旧记录",
  });
  assert.equal(sourced.supersedes, legacyStyle.id);
  assert.equal(sourced.scope.id, "dmr-ml");
  assert.deepEqual(memory.selectRelevantMemories(memory.listMemories(userData), "旧调用").map((item) => item.id), []);

  const disputed = memory.updateMemory(userData, sourced.id, { status: "disputed", reason: "需要独立复核" });
  assert.equal(disputed.status, "disputed");
  memory.archiveMemory(userData, sourced.id);
  const events = memory.listMemoryAuditEvents(userData, { memoryId: sourced.id });
  assert.deepEqual(events.map((event) => event.action), ["created", "updated", "archived"]);
  assert.equal(events[0].snapshot.status, "valid");
  assert.equal(events[1].snapshot.status, "disputed");
  assert.ok(events[0].sequence < events[1].sequence && events[1].sequence < events[2].sequence);
  assert.throws(() => memory.createMemory(userData, { content: "bad", status: "disputed" }), /原因/);
  assert.throws(() => memory.createMemory(userData, { content: "bad", scope: { kind: "project", id: "" } }), /范围/);
});

test("relevance retrieval excludes superseded and disputed memories by default", () => {
  const userData = tempDirectory();
  const valid = memory.createMemory(userData, { content: "kaii 使用 Electron 框架", kind: "project" });
  memory.createMemory(userData, { content: "kaii 使用 Electron 框架（已失效）", status: "superseded", reason: "新证据已替代" });
  memory.createMemory(userData, { content: "kaii 使用 Electron 框架（有争议）", status: "disputed", reason: "来源尚未核实" });
  const selected = memory.selectRelevantMemories(memory.listMemories(userData), "kaii Electron");
  assert.deepEqual(selected.map((item) => item.id), [valid.id]);
  // 旧的纯内存调用方没有 status，仍按 valid 处理。
  assert.equal(memory.selectRelevantMemories([{ ...valid, status: undefined }], "kaii Electron").length, 1);
});

test("DuckDuckGo parser decodes results and rejects private URLs", () => {
  const html = `
    <a rel="nofollow" class="result__a" href="https://example.com/a?x=1&amp;y=2">示例 &amp; 页面</a>
    <a class="result__snippet" href="https://example.com/a">这是 <b>公开</b> 摘要。</a>
    <a rel="nofollow" class="result__a" href="http://127.0.0.1/private">私网</a>
    <a class="result__snippet">不得出现</a>
  `;
  assert.deepEqual(web.parseDuckDuckGoHtml(html), [{
    title: "示例 & 页面",
    url: "https://example.com/a?x=1&y=2",
    snippet: "这是 公开 摘要。",
  }]);
  const schemeRelative = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fdoc">文档</a><a class="result__snippet">说明</a>';
  assert.deepEqual(web.parseDuckDuckGoHtml(schemeRelative), [{
    title: "文档",
    url: "https://example.net/doc",
    snippet: "说明",
  }]);
  for (const value of ["file:///etc/passwd", "http://localhost/a", "http://192.168.1.1/a", "https://user:pass@example.com/"]) {
    assert.equal(web.safePublicUrl(value), null);
  }
});

test("web search is opt-in infrastructure with bounded HTML", async () => {
  const html = '<a class="result__a" href="https://example.org/">结果</a><a class="result__snippet">摘要</a>';
  const results = await web.searchWeb("测试", {
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
    },
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.org/");
  await assert.rejects(web.searchWeb("x", {
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  }), /未知格式/);
});

test("image context labels the local Vision boundary honestly", () => {
  const context = image.formatImageContext({
    name: "note.png",
    width: 640,
    height: 480,
    ocrText: "项目进度",
    classifications: [{ label: "document", confidence: 0.91 }],
  });
  assert.match(context, /项目进度/);
  assert.match(context, /macOS Vision/);
  assert.match(context, /不是多模态大模型/);
});
