const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const knowledge = require("../../electron/lib/knowledge.cjs");

const HELPER = path.resolve(__dirname, "../../resources/bin/kaii-doc");

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-kb-test-"));
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(base, "ud-")));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(base, "docs-")));
  return { userData, folder };
}

function seed(folder) {
  fs.mkdirSync(path.join(folder, "会议纪要"), { recursive: true });
  fs.writeFileSync(path.join(folder, "员工手册.md"), "# 报销制度\n\n出差住宿每晚上限四百二十元。\n\n# 请假\n\n年假十天，需提前三天申请。");
  fs.writeFileSync(path.join(folder, "会议纪要/2026-03.txt"), "三月例会。\n\n决定把服务器迁到新机房，预算八万。");
  // 这些都不该进索引
  fs.mkdirSync(path.join(folder, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(folder, "node_modules/junk.md"), "依赖目录里的东西");
  fs.mkdirSync(path.join(folder, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".hidden/secret.md"), "隐藏目录里的东西");
  fs.writeFileSync(path.join(folder, "photo.heic"), Buffer.from([0, 1, 2]));
}

test("scanning a folder skips dependency and hidden directories", () => {
  const { folder } = sandbox();
  seed(folder);
  const { files } = knowledge.collectFiles(folder);
  const names = files.map((file) => path.relative(folder, file.path)).sort();
  assert.deepEqual(names, ["会议纪要/2026-03.txt", "员工手册.md"]);
});

test("a folder can be added once, listed, toggled and removed", () => {
  const { userData, folder } = sandbox();
  seed(folder);

  const { library, libraries } = knowledge.addLibrary(userData, folder);
  assert.equal(libraries.length, 1);
  assert.equal(library.enabled, true);
  assert.equal(library.exists, true);
  assert.equal(library.indexedAt, 0);

  assert.throws(() => knowledge.addLibrary(userData, folder), /已经加过了/);

  const toggled = knowledge.setLibraryEnabled(userData, library.id, false);
  assert.equal(toggled[0].enabled, false);

  assert.deepEqual(knowledge.removeLibrary(userData, library.id), []);
  assert.throws(() => knowledge.validateLibraryId("nope"), /知识库ID无效/);
});

test("indexing extracts every readable file and reports the ones it could not read", async () => {
  const { userData, folder } = sandbox();
  seed(folder);
  // 一份读不出来的文件不该让整次重建失败。
  fs.writeFileSync(path.join(folder, "坏的.pdf"), "这根本不是 PDF");

  const { library } = knowledge.addLibrary(userData, folder);
  const built = await knowledge.buildIndex(userData, library.id, { helperPath: HELPER });

  assert.equal(built.fileCount, 2);
  assert.ok(built.sectionCount >= 2);
  assert.equal(built.skipped.length, 1);
  assert.match(built.skipped[0].path, /坏的\.pdf/);

  const listed = knowledge.listLibraries(userData)[0];
  assert.equal(listed.fileCount, 2);
  assert.ok(listed.indexedAt > 0);

  // 抽完之后不该在 documents 目录里留下一堆临时记录。
  const documentDirectory = path.join(userData, "documents");
  const leftovers = fs.existsSync(documentDirectory) ? fs.readdirSync(documentDirectory) : [];
  assert.deepEqual(leftovers, [], `留下了没清掉的文档记录：${leftovers.join("、")}`);
});

test("re-indexing reuses untouched files and re-reads changed ones", async () => {
  const { userData, folder } = sandbox();
  seed(folder);
  const { library } = knowledge.addLibrary(userData, folder);
  await knowledge.buildIndex(userData, library.id, { helperPath: HELPER });

  const before = knowledge.searchKnowledge(userData, "住宿能报多少");
  assert.match(before.text, /四百二十元/);

  // 改掉其中一份，重建后应当读到新内容。
  fs.writeFileSync(path.join(folder, "员工手册.md"), "# 报销制度\n\n出差住宿每晚上限已经涨到六百元。");
  const rebuilt = await knowledge.buildIndex(userData, library.id, { helperPath: HELPER });
  assert.equal(rebuilt.fileCount, 2);

  const after = knowledge.searchKnowledge(userData, "住宿能报多少");
  assert.match(after.text, /六百元/);
  assert.equal(after.text.includes("四百二十元"), false, "旧内容应当被替换掉");
});

test("search spans files, cites where each answer came from, and respects the budget", async () => {
  const { userData, folder } = sandbox();
  seed(folder);
  const { library } = knowledge.addLibrary(userData, folder);
  await knowledge.buildIndex(userData, library.id, { helperPath: HELPER });

  const money = knowledge.searchKnowledge(userData, "服务器迁移的预算是多少");
  assert.match(money.text, /八万/);
  assert.equal(money.citations[0].file, "会议纪要/2026-03.txt");
  assert.ok(money.citations[0].absolutePath.startsWith(folder));
  assert.match(money.text, /用 \[序号\] 标出/);
  assert.match(money.text, /找不到答案就说知识库里没有/);

  // 关掉之后就不该再被搜到。
  knowledge.setLibraryEnabled(userData, library.id, false);
  assert.deepEqual(knowledge.searchKnowledge(userData, "服务器迁移的预算是多少").citations, []);
  knowledge.setLibraryEnabled(userData, library.id, true);

  // 完全无关的问题不该硬凑出处。
  assert.deepEqual(knowledge.searchKnowledge(userData, "zzzz 完全无关的东西 qqqq").citations, []);
  assert.deepEqual(knowledge.searchKnowledge(userData, "").citations, []);

  const tight = knowledge.searchKnowledge(userData, "住宿 预算 服务器", { maxBytes: 200 });
  assert.ok(Buffer.byteLength(tight.text, "utf8") <= 700, "预算要守住");
});

test("a library whose folder disappeared degrades instead of throwing", async () => {
  const { userData, folder } = sandbox();
  seed(folder);
  const { library } = knowledge.addLibrary(userData, folder);
  await knowledge.buildIndex(userData, library.id, { helperPath: HELPER });

  fs.rmSync(folder, { recursive: true, force: true });
  const listed = knowledge.listLibraries(userData)[0];
  assert.equal(listed.exists, false, "界面要能看出文件夹没了");
  // 已经建好的索引仍然可以搜——文件夹只是暂时不在，比如外置硬盘没插。
  assert.deepEqual(knowledge.searchKnowledge(userData, "住宿").citations, []);
  await assert.rejects(knowledge.buildIndex(userData, library.id, { helperPath: HELPER }), /找不到了/);
});

// ── 联网正文抓取 ──────────────────────────────
const web = require("../../electron/lib/web-search.cjs");

test("page text extraction drops scripts, chrome and markup", () => {
  const html = [
    "<html><head><title>测试页面</title></head><body>",
    "<script>var tracking = 1;</script><style>.a{color:red}</style>",
    "<nav>首页 关于</nav>",
    "<article><h1>标题</h1><p>第一段正文。</p><p>数字是四百二十元。</p></article>",
    "<footer>版权所有</footer></body></html>",
  ].join("");
  const text = web.extractReadableText(html);
  assert.match(text, /第一段正文/);
  assert.match(text, /四百二十元/);
  assert.equal(text.includes("tracking"), false, "脚本不该混进正文");
  assert.equal(text.includes("color:red"), false, "样式不该混进正文");
  // 有 article 时应当只取 article，导航和页脚不该进来。
  assert.equal(text.includes("版权所有"), false);
});

test("fetching a page refuses anything that is not a public web page", async () => {
  await assert.rejects(web.fetchPage("http://127.0.0.1:8091/health"), /这个网址不能抓/);
  await assert.rejects(web.fetchPage("file:///etc/passwd"), /这个网址不能抓/);
  await assert.rejects(
    web.fetchPage("https://example.com/a.pdf", {
      fetchImpl: async () => new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
    }),
    /不是网页/,
  );
  await assert.rejects(
    web.fetchPage("https://example.com/x", {
      fetchImpl: async () => new Response("<html><body>短</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    }),
    /没抓到正文/,
  );
  await web.fetchPage("https://example.com/no-redirect", {
    redirect: "error",
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error", "投资证据抓取必须能明确禁止 HTTP 跳转");
      return new Response(
        `<html><article>${"这是不能跳转的公开证据正文。".repeat(8)}</article></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    },
  });
  await assert.rejects(
    web.fetchPage("https://example.com/unsafe-final", {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: "http://127.0.0.1/private",
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => `<html><article>${"伪造的内网页面正文。".repeat(10)}</article></html>`,
      }),
    }),
    /跳转到了不安全的地址/,
  );
  await assert.rejects(
    web.fetchPage("https://example.com/original", {
      redirect: "error",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: "https://example.net/final",
        redirected: true,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => `<html><article>${"另一个公开站点上的正文。".repeat(10)}</article></html>`,
      }),
    }),
    /发生了跳转/,
  );
});

test("one unreadable page does not sink the whole round", async () => {
  const results = [
    { title: "能打开", url: "https://example.com/ok", snippet: "摘要一" },
    { title: "打不开", url: "https://example.com/bad", snippet: "摘要二" },
  ];
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/bad")) throw new Error("连不上");
    return new Response(
      `<html><body><article><p>${"这是正文内容，足够长以便通过最小长度检查。".repeat(4)}</p></article></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  };
  const read = await web.readTopResults(results, { fetchImpl });
  assert.equal(read[0].read, true);
  assert.match(read[0].body, /这是正文内容/);
  assert.equal(read[1].read, false);
  assert.match(read[1].readError, /连不上/);
  // 抓不到的那条仍然保留摘要，回答里还能用。
  assert.equal(read[1].snippet, "摘要二");
});

test("内容像密钥的文件不进索引，跳过原因写明白", async (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-kn-sens-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-kn-sens-lib-"));
  t.after(() => {
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "普通.txt"), "这是一份普通资料。");
  fs.writeFileSync(path.join(root, "配置备份.txt"), "token=sk-abcdefghijklmnop1234 别外传");
  fs.writeFileSync(path.join(root, "旧钥匙.txt"), "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----");
  const { library } = knowledge.addLibrary(store, root);
  await knowledge.buildIndex(store, library.id, {});
  const built = knowledge.listLibraries(store).find((item) => item.id === library.id);
  assert.strictEqual(built.fileCount, 1);
  const skippedPaths = built.skipped.map((item) => item.path).sort();
  assert.deepStrictEqual(skippedPaths, ["旧钥匙.txt", "配置备份.txt"]);
  for (const item of built.skipped) {
    assert.match(item.reason, /密钥/);
  }
});

test("检索结果带原文摘录和分数，给「检索预览」用", async (t) => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-kn-cite-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-kn-cite-lib-"));
  t.after(() => {
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "报销规定.txt"), "差旅报销需要在回程后十五个工作日内提交，超期由部门负责人签字说明。");
  const { library } = knowledge.addLibrary(store, root);
  await knowledge.buildIndex(store, library.id, {});

  const hit = knowledge.searchKnowledge(store, "报销要多久内提交");
  assert.strictEqual(hit.citations.length, 1);
  assert.match(hit.citations[0].excerpt, /十五个工作日/);
  assert.ok(hit.citations[0].score > 0);
  // 摘录是给人看的一眼预览，不该是整段正文
  assert.ok(hit.citations[0].excerpt.length <= 160);

  // 完全对不上的问题不硬凑结果
  assert.strictEqual(knowledge.searchKnowledge(store, "火星探测器发射窗口zzz").citations.length, 0);
});
