const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const documents = require("../../electron/lib/document.cjs");
const knowledge = require("../../electron/lib/knowledge.cjs");
const readlater = require("../../electron/lib/readlater.cjs");

function tempDir(prefix = "kaii-a-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── 复用缓存（110）───────────────────────────────────────

test("同一份文件第二次挂直接复用，不重新解析", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "内容。".repeat(100));
  const first = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  const second = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  assert.equal(second.reused, true);
  assert.equal(second.id, first.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("文件改过就必须重新解析——大小、修改时间任一变了都不算同一份", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "内容。".repeat(100));
  const first = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  fs.appendFileSync(file, "多了一段。");
  const second = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.reused, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 目录与搜索（101/106）────────────────────────────────

test("目录给出每段的名字、长度和开头", async () => {
  const dir = tempDir();
  const file = path.join(dir, "长文.txt");
  fs.writeFileSync(file, `${"第一章内容。".repeat(90)}\n\n${"第二章内容。".repeat(90)}`);
  const doc = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  const outline = documents.documentOutline(dir, doc.id);
  assert.ok(outline.sections.length >= 2);
  assert.ok(outline.sections[0].characters > 0);
  assert.ok(outline.sections[0].preview.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("文档内搜索带上下文，搜不到返回空", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, `前面的话。${"垫子。".repeat(60)}关键的那句话在这里。后面的话。`);
  const doc = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  const hits = documents.searchDocument(dir, doc.id, "关键的那句话");
  assert.equal(hits.length, 1);
  assert.match(hits[0].excerpt, /关键的那句话/);
  assert.deepEqual(documents.searchDocument(dir, doc.id, "不存在的词"), []);
  // 超长 query 直接拒绝，不去扫。
  assert.deepEqual(documents.searchDocument(dir, doc.id, "长".repeat(200)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 切段（102）──────────────────────────────────────────

test("切出的段是独立记录，不会被复用缓存误认成整份", async () => {
  const dir = tempDir();
  const file = path.join(dir, "长文.txt");
  fs.writeFileSync(file, `${"甲。".repeat(300)}\n\n${"乙。".repeat(300)}`);
  const doc = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir });
  const outline = documents.documentOutline(dir, doc.id);
  const slice = documents.sliceDocumentSection(dir, doc.id, outline.sections[1].label);
  assert.equal(slice.sectionCount, 1);
  assert.match(slice.name, /§/);
  // 派生记录 sourcePath 为空，复用缓存找的还是原来那份。
  const again = documents.findReusableDocument(dir, file, fs.lstatSync(file));
  assert.equal(again.id, doc.id);
  assert.throws(() => documents.sliceDocumentSection(dir, doc.id, "没有这段"), /没有叫/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 多文档协议（103）────────────────────────────────────

test("documentIds 校验：只认 user、最多 3 个、必须是 uuid", () => {
  const Module = require("node:module");
  const orig = Module._load;
  process.env.KAII_ELECTRON_TEST = "1";
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return {
      app: { getPath: () => "/tmp/kaii-test", isPackaged: false, on() {}, whenReady: async () => {} },
      BrowserWindow: class {}, dialog: {}, ipcMain: { handle() {} }, nativeTheme: {},
      Menu: {}, Tray: class {}, clipboard: {}, globalShortcut: { register: () => true, unregisterAll() {} },
      nativeImage: {}, screen: {}, shell: {},
    };
    return orig.call(this, request, parent, isMain);
  };
  const { __test: subject } = require("../../electron/main.cjs");
  Module._load = orig;

  const uuid = "11111111-1111-4111-8111-111111111111";
  const good = subject.validateChatPayload({
    requestId: "r1",
    messages: [{ role: "user", content: "问", documentIds: [uuid] }],
    skillId: "none",
    options: {},
  });
  assert.deepEqual(good.messages[0].documentIds, [uuid]);

  for (const bad of [
    [uuid, uuid, uuid, uuid],          // 超过 3 个
    ["不是uuid"],
    "不是数组",
  ]) {
    assert.throws(() => subject.validateChatPayload({
      requestId: "r1",
      messages: [{ role: "user", content: "问", documentIds: bad }],
      skillId: "none",
      options: {},
    }), /documentIds无效/, `该拒绝：${JSON.stringify(bad)}`);
  }
});

// ── 工作表（114）────────────────────────────────────────

test("挑了不存在的工作表要直说，并列出有哪些", async () => {
  const dir = tempDir();
  const file = path.join(dir, "表.csv");
  fs.writeFileSync(file, "城市,销量\n北京,120\n上海,90\n");
  // CSV 只有一张叫「表格」的工作表。挑一个不存在的名字必须报错并列出候选，
  // 静默回退到全部会让人以为挑选生效了。
  await assert.rejects(
    () => documents.extractAndStoreDocument({ filePath: file, userDataPath: dir, sheetName: "不存在" }),
    /没有叫「不存在」的工作表。有的是：表格/,
  );
  // 挑对了就正常出，记录里记着挑的是哪张。
  const picked = await documents.extractAndStoreDocument({ filePath: file, userDataPath: dir, sheetName: "表格" });
  assert.equal(picked.sheetName, "表格");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 知识库排除与过期（107/112）──────────────────────────

test("排除规则跳过命中的目录，且跟着 buildIndex 走", () => {
  const store = tempDir();
  const folder = tempDir("kaii-lib-");
  fs.writeFileSync(path.join(folder, "正式.txt"), "正式资料。");
  fs.mkdirSync(path.join(folder, "草稿"));
  fs.writeFileSync(path.join(folder, "草稿", "半成品.txt"), "别搜我。");
  const { library } = knowledge.addLibrary(store, folder);
  knowledge.setLibraryExcludes(store, library.id, ["草稿", "", "带/斜杠的不要"]);
  const updated = knowledge.listLibraries(store).find((item) => item.id === library.id);
  assert.deepEqual(updated.excludes, ["草稿"]);
  const collected = knowledge.collectFiles(folder, { excludes: updated.excludes });
  assert.equal(collected.files.length, 1);
  // buildIndex 的调用点也必须带排除规则（曾经替错过地方）。
  const source = fs.readFileSync(path.join(__dirname, "../../electron/lib/knowledge.cjs"), "utf8");
  assert.match(source, /collectFiles\(library\.path, \{ excludes: library\.excludes \}\)/);
  fs.rmSync(store, { recursive: true, force: true });
  fs.rmSync(folder, { recursive: true, force: true });
});

// ── 网页标签与摘要（108/109）────────────────────────────

test("网页标签：去空白、限长、上限 8 个", async () => {
  const dir = tempDir();
  const item = await readlater.savePage(dir, "https://example.com/a", {
    fetchPage: async () => ({ title: "文章", text: "正文。".repeat(60) }),
  });
  const pages = readlater.setPageTags(dir, item.id, ["  要跟进 ", "", "很长很长".repeat(10), "1", "2", "3", "4", "5", "6", "7"]);
  const saved = pages.find((page) => page.id === item.id);
  assert.equal(saved.tags.length, 8);
  assert.equal(saved.tags[0], "要跟进");
  assert.ok(saved.tags[1].length <= 16);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("摘要失败不影响保存——setPageSummary 只是补写", async () => {
  const dir = tempDir();
  const item = await readlater.savePage(dir, "https://example.com/a", {
    fetchPage: async () => ({ title: "文章", text: "正文。".repeat(60) }),
  });
  // 没写摘要之前就已经存好了。
  assert.equal(readlater.listPages(dir).length, 1);
  readlater.setPageSummary(dir, item.id, "这篇讲了一件事。");
  assert.equal(readlater.listPages(dir)[0].summary, "这篇讲了一件事。");
  fs.rmSync(dir, { recursive: true, force: true });
});
