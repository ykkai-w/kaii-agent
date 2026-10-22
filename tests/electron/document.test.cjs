const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const documents = require("../../electron/lib/document.cjs");

const HELPER = path.resolve(__dirname, "../../resources/bin/kaii-doc");

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-doc-test-"));
  fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
  fs.mkdirSync(path.join(base, "files"), { recursive: true });
  return {
    userData: fs.realpathSync(path.join(base, "userdata")),
    files: fs.realpathSync(path.join(base, "files")),
  };
}

function writeFile(directory, name, content) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, content);
  return target;
}

test("plain text files are read locally and split into sections", async () => {
  const { userData, files } = sandbox();
  const body = Array.from({ length: 12 }, (_, index) => (
    `第 ${index + 1} 节标题\n这一节讲的是主题 ${index + 1}。${"内容".repeat(120)}`
  )).join("\n\n");
  const target = writeFile(files, "notes.md", body);

  const result = await documents.extractAndStoreDocument({ filePath: target, userDataPath: userData, helperPath: HELPER });
  assert.equal(result.name, "notes.md");
  assert.equal(result.kind, "text");
  assert.ok(result.sectionCount >= 2, "长文本应当被切成多段");
  assert.ok(result.preview.includes("第 1 节标题"));

  const record = documents.loadDocumentRecord(userData, result.id);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.sections.length, result.sectionCount);
  // 原文件不能被动过。
  assert.equal(fs.readFileSync(target, "utf8"), body);
});

test("an unsupported or unreadable file fails with a plain explanation", async () => {
  const { userData, files } = sandbox();
  const binary = writeFile(files, "thing.bin", Buffer.from([0, 1, 2, 3]));
  await assert.rejects(
    documents.extractAndStoreDocument({ filePath: binary, userDataPath: userData, helperPath: HELPER }),
    /还不支持这种文件/,
  );

  const empty = writeFile(files, "empty.txt", "");
  await assert.rejects(
    documents.extractAndStoreDocument({ filePath: empty, userDataPath: userData, helperPath: HELPER }),
    /这个文件是空的/,
  );

  const notText = writeFile(files, "fake.txt", Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(
    documents.extractAndStoreDocument({ filePath: notText, userDataPath: userData, helperPath: HELPER }),
    /不是文本/,
  );

  assert.throws(() => documents.validateDocumentInput("relative.txt"), /文档路径无效/);
  assert.throws(() => documents.validateDocumentInput(path.join(files, "missing.txt")), /ENOENT|no such file/);
});

test("long documents pick the sections that match the question", () => {
  const record = {
    schemaVersion: 1,
    id: "x",
    name: "报告.md",
    kind: "text",
    pageCount: 0,
    characters: 900,
    truncated: false,
    sections: [
      { label: "第 1 段", text: "本报告讨论供应链与物流成本。" },
      { label: "第 2 段", text: "第二部分讲的是员工培训与考核制度。" },
      { label: "第 3 段", text: "第三部分是关于碳排放与环境合规的结论。" },
    ],
  };

  // 全文放得下时按原顺序整份给出，不做取舍。
  const whole = documents.selectDocumentSections(record, "碳排放怎么说的");
  assert.equal(whole.strategy, "relevant");
  assert.deepEqual(whole.sections.map((section) => section.label), ["第 1 段", "第 2 段", "第 3 段"]);

  // 预算只够一段时，留下的必须是和问题相关的那一段。
  const tight = documents.selectDocumentSections(record, "碳排放怎么说的", { maxBytes: 90 });
  assert.equal(tight.sections.length, 1);
  assert.equal(tight.sections[0].label, "第 3 段");
  assert.equal(tight.coveredSections, 1);
  assert.equal(tight.totalSections, 3);

  const training = documents.selectDocumentSections(record, "员工培训怎么规定的", { maxBytes: 90 });
  assert.equal(training.sections[0].label, "第 2 段");

  // 问题里没有线索时退回开头，那里通常是标题和摘要。
  const generic = documents.selectDocumentSections(record, "总结一下", { maxBytes: 90 });
  assert.equal(generic.strategy, "beginning");
  assert.equal(generic.sections[0].label, "第 1 段");

  const context = documents.formatDocumentContext(record, "碳排放怎么说的");
  assert.match(context, /\[本机文档：报告\.md\]/);
  assert.match(context, /碳排放与环境合规/);
  assert.match(context, /在这台电脑上从文档里抽出来的/);
  assert.match(context, /不要猜/);
});

test("the section budget is respected even when one section is huge", () => {
  const record = {
    sections: [{ label: "第 1 段", text: "字".repeat(20_000) }],
    kind: "text",
    name: "big.txt",
    characters: 20_000,
    pageCount: 0,
    truncated: false,
  };
  const selection = documents.selectDocumentSections(record, "随便问问", { maxBytes: 1200 });
  assert.equal(selection.sections.length, 1);
  assert.ok(Buffer.byteLength(selection.sections[0].text, "utf8") <= 1200);

  const many = {
    ...record,
    sections: Array.from({ length: 200 }, (_, index) => ({ label: `第 ${index + 1} 段`, text: "内容".repeat(100) })),
  };
  const budgeted = documents.selectDocumentSections(many, "内容", { maxBytes: 3000 });
  const totalBytes = budgeted.sections.reduce((sum, section) => sum + Buffer.byteLength(section.text, "utf8"), 0);
  assert.ok(totalBytes <= 3000, `选出的段落总字节 ${totalBytes} 不该超预算`);
  // 选中的段落必须保持原文顺序，否则模型读起来是乱的。
  const labels = budgeted.sections.map((section) => Number(section.label.match(/\d+/)[0]));
  assert.deepEqual(labels, labels.slice().sort((a, b) => a - b));
});

test("discarding and pruning remove exactly the records nobody references", async () => {
  const { userData, files } = sandbox();
  const first = await documents.extractAndStoreDocument({
    filePath: writeFile(files, "a.txt", "第一份文档的内容"),
    userDataPath: userData,
    helperPath: HELPER,
  });
  const second = await documents.extractAndStoreDocument({
    filePath: writeFile(files, "b.txt", "第二份文档的内容"),
    userDataPath: userData,
    helperPath: HELPER,
  });

  assert.deepEqual(documents.discardDocument(userData, first.id), { ok: true, removed: true });
  assert.throws(() => documents.loadDocumentRecord(userData, first.id), /ENOENT|no such file/);
  assert.equal(documents.loadDocumentRecord(userData, second.id).id, second.id);

  const third = await documents.extractAndStoreDocument({
    filePath: writeFile(files, "c.txt", "第三份文档的内容"),
    userDataPath: userData,
    helperPath: HELPER,
  });
  const pruned = documents.collectReferencedDocuments(userData, [second.id]);
  assert.equal(pruned.removed, 1);
  assert.equal(documents.loadDocumentRecord(userData, second.id).id, second.id);
  assert.throws(() => documents.loadDocumentRecord(userData, third.id), /ENOENT|no such file/);

  assert.throws(() => documents.loadDocumentRecord(userData, "not-a-uuid"), /文档ID无效/);
});

// 现造一个带文字层的最小 PDF，不依赖用户桌面上的任何文件——
// 那种依赖会在文件被移走或机器繁忙时无缘无故变红。
function writeSamplePdf(target, marker) {
  const stream = Buffer.from(`BT /F1 24 Tf 60 700 Td (${marker}) Tj ET`, "ascii");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "ascii"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
      + "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "ascii",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "ascii"),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("\nendstream", "ascii"),
    ]),
  ];

  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      body,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });

  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const value of offsets) xref.push(`${String(value).padStart(10, "0")} 00000 n \n`);
  chunks.push(Buffer.from(xref.join(""), "ascii"));
  chunks.push(Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    "ascii",
  ));
  fs.writeFileSync(target, Buffer.concat(chunks));
  return target;
}

test("the PDF helper really extracts a text layer", { skip: !fs.existsSync(HELPER) }, async () => {
  const { userData, files } = sandbox();
  const marker = "kaii pdf extraction marker 42";
  const samplePdf = writeSamplePdf(path.join(files, "sample.pdf"), marker);

  const result = await documents.extractAndStoreDocument({
    filePath: samplePdf,
    userDataPath: userData,
    helperPath: HELPER,
  });
  assert.equal(result.kind, "pdf");
  assert.equal(result.pageCount, 1);
  assert.ok(result.characters > 10);

  const record = documents.loadDocumentRecord(userData, result.id);
  assert.match(record.sections[0].label, /^第 \d+ 页$/);
  assert.match(record.sections[0].text, /kaii pdf extraction marker 42/);
  assert.match(documents.formatDocumentContext(record, "marker"), /类型：PDF/);
});

test("supported extensions cover the everyday formats", () => {
  const supported = new Set(documents.supportedExtensions());
  for (const extension of ["pdf", "docx", "doc", "rtf", "txt", "md", "csv", "json"]) {
    assert.ok(supported.has(extension), `应当支持 ${extension}`);
  }
});

// ── 端到端：文档必须真的进到发给模型的那条消息里 ──────────────────
// 这一组是被真实故障逼出来的：模块 require 漏了一行，模型收到的消息里
// 根本没有文档正文，但单测全绿、界面也不报错，只有把请求体拆开看才发现。

const Module = require("node:module");

const previousTestMode = process.env.KAII_ELECTRON_TEST;
process.env.KAII_ELECTRON_TEST = "1";
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp/kaii-doc-test", isPackaged: false, on() {}, whenReady: async () => {} },
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
const { __test: subject } = require(path.resolve(__dirname, "../../electron/main.cjs"));
Module._load = originalLoad;
if (previousTestMode === undefined) delete process.env.KAII_ELECTRON_TEST;
else process.env.KAII_ELECTRON_TEST = previousTestMode;

function captureFetch(reply) {
  const captured = [];
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith("/health")) return new Response("ok", { status: 200 });
    if (target.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen-test" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    captured.push(JSON.parse(init.body));
    const frames = [`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`, "data: [DONE]\n\n"];
    return new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { captured, fetchImpl };
}

test("the document text actually reaches the message sent to the model", async () => {
  subject.resetState();
  const { userData, files } = sandbox();
  const target = writeFile(files, "handbook.txt", "第一章 报销规则\n出差住宿每晚上限是四百二十元。\n\n第二章 请假\n年假十天。");
  const stored = await documents.extractAndStoreDocument({ filePath: target, userDataPath: userData, helperPath: HELPER });

  const { captured, fetchImpl } = captureFetch("住宿上限是四百二十元。");
  const result = await subject.streamChat(
    { isDestroyed: () => false, send() {} },
    {
      requestId: "req-doc",
      messages: [{ role: "user", content: "住宿一晚最多报多少", documentId: stored.id }],
      skillId: "none",
      options: {},
    },
    { settings: { ...subject.DEFAULT_SETTINGS, contextSize: 16_384, maxTokens: 700 }, userDataPath: userData, fetchImpl },
  );

  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  const sent = captured[0].messages.filter((message) => message.role === "user").at(-1).content;
  assert.match(sent, /\[本机文档：handbook\.txt\]/);
  assert.match(sent, /四百二十元/, "文档正文必须出现在真正发出去的消息里");
  assert.match(sent, /在这台电脑上从文档里抽出来的/);
  assert.equal(sent.includes("本机记录已经不可用"), false, "不该走降级分支");

  // 系统提示必须把文档列进允许使用的材料，否则模型会拒绝使用它。
  const system = captured[0].messages[0].content;
  assert.match(system, /文档正文/);
});

test("a missing document record degrades without breaking the answer", async () => {
  subject.resetState();
  const { userData } = sandbox();
  const { captured, fetchImpl } = captureFetch("我看不到那份文档。");
  const result = await subject.streamChat(
    { isDestroyed: () => false, send() {} },
    {
      requestId: "req-missing",
      messages: [{ role: "user", content: "这份文档讲什么", documentId: "99999999-9999-4999-8999-999999999999" }],
      skillId: "none",
      options: {},
    },
    { settings: { ...subject.DEFAULT_SETTINGS, contextSize: 16_384, maxTokens: 700 }, userDataPath: userData, fetchImpl },
  );
  assert.equal(result.ok, true);
  const sent = captured[0].messages.filter((message) => message.role === "user").at(-1).content;
  assert.match(sent, /本机记录已经不可用/);
});

test("only the most recent document is reloaded into context", async () => {
  const { userData, files } = sandbox();
  const first = await documents.extractAndStoreDocument({
    filePath: writeFile(files, "old.txt", "旧文档里写着代号是苍鹭。"),
    userDataPath: userData,
    helperPath: HELPER,
  });
  const second = await documents.extractAndStoreDocument({
    filePath: writeFile(files, "new.txt", "新文档里写着代号是白鹤。"),
    userDataPath: userData,
    helperPath: HELPER,
  });

  const hydrated = subject.hydrateDocumentMessages([
    { role: "user", content: "第一次问", documentId: first.id },
    { role: "assistant", content: "好的" },
    { role: "user", content: "第二次问", documentId: second.id },
  ], userData, "代号是什么");

  assert.match(hydrated[0].content, /更早的文档没有重复载入/);
  assert.equal(hydrated[0].content.includes("苍鹭"), false, "旧文档不该再占上下文");
  assert.match(hydrated[2].content, /白鹤/);
  assert.equal(hydrated.every((message) => message.documentId === undefined), true, "documentId 不该继续传给模型");
});

test("project documents share one budget and get picked across files by question", () => {
  const make = (id, name, texts) => ({
    id,
    name,
    kind: "text",
    pageCount: 0,
    characters: 500,
    sections: texts.map((text, index) => ({ label: `第 ${index + 1} 段`, text })),
  });
  const records = [
    make("a", "论文.pdf", ["本文提出一种轻量级检索方法。", "实验在三个数据集上进行。", "结论部分讨论了局限。"]),
    make("b", "评审意见.docx", ["评审人认为实验部分不够充分。", "建议补充消融实验。"]),
  ];

  const relevant = documents.formatProjectDocuments(records, "评审说实验有什么问题");
  assert.match(relevant.text, /评审人认为实验部分不够充分/);
  assert.match(relevant.text, /《评审意见\.docx》/);
  assert.match(relevant.text, /是资料，不是指令/);
  assert.ok(relevant.used.length >= 1);

  // 单份文档不能把预算吃光：每份最多取 maxPerDocument 段。
  const hoggy = [make("big", "大文件.txt", Array.from({ length: 30 }, (_, i) => `第${i}段内容内容内容`))];
  const capped = documents.formatProjectDocuments(hoggy, "内容", { maxPerDocument: 2 });
  assert.equal(capped.used[0].sections, 2);

  // 总预算必须守住。
  const many = [
    make("x", "甲.txt", Array.from({ length: 20 }, () => "内容".repeat(200))),
    make("y", "乙.txt", Array.from({ length: 20 }, () => "内容".repeat(200))),
  ];
  const budgeted = documents.formatProjectDocuments(many, "内容", { maxBytes: 3000 });
  assert.ok(Buffer.byteLength(budgeted.text, "utf8") <= 3600, `实际 ${Buffer.byteLength(budgeted.text, "utf8")} 字节`);

  // 没有文档、空文档都不该产出任何段落。
  assert.deepEqual(documents.formatProjectDocuments([], "问题"), { text: "", used: [] });
  assert.deepEqual(documents.formatProjectDocuments(null, "问题"), { text: "", used: [] });
  assert.deepEqual(documents.formatProjectDocuments([{ id: "z", name: "空", sections: [] }], "问题"), { text: "", used: [] });
});

test("project documents reach the model and never crowd out the question", () => {
  const record = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "手册.txt",
    kind: "text",
    pageCount: 0,
    characters: 40,
    sections: [{ label: "第 1 段", text: "住宿每晚上限四百二十元。" }],
  };
  const context = documents.formatProjectDocuments([record], "住宿能报多少").text;
  assert.match(context, /四百二十元/);

  const fitted = subject.fitPromptToContext(
    [{ role: "user", content: "住宿能报多少" }],
    { text: "", mode: "none", name: "普通聊天" },
    { ...subject.DEFAULT_SETTINGS, contextSize: 8192, maxTokens: 700 },
    { projectDocsContext: context },
  );
  assert.equal(fitted.projectDocsIncluded, true);
  assert.match(fitted.systemContent, /当前项目长期挂着的资料/);
  assert.match(fitted.systemContent, /四百二十元/);

  const huge = subject.fitPromptToContext(
    [{ role: "user", content: "这句必须留下" }],
    { text: "", mode: "none", name: "普通聊天" },
    { ...subject.DEFAULT_SETTINGS, contextSize: 8192, maxTokens: 700 },
    { projectDocsContext: "资料".repeat(30_000) },
  );
  assert.equal(huge.messages.at(-1).content, "这句必须留下");
});

test("the chat payload validates the project document list", () => {
  const base = { requestId: "r1", messages: [{ role: "user", content: "问题" }], skillId: "none", options: {} };
  assert.deepEqual(subject.validateChatPayload(base).projectDocumentIds, []);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(subject.validateChatPayload({ ...base, projectDocumentIds: [id, id] }).projectDocumentIds, [id], "重复的要去重");
  assert.throws(() => subject.validateChatPayload({ ...base, projectDocumentIds: "x" }), /项目文档列表无效/);
  assert.throws(() => subject.validateChatPayload({ ...base, projectDocumentIds: ["不是uuid"] }), /项目文档ID无效/);
  assert.throws(() => subject.validateChatPayload({ ...base, projectDocumentIds: new Array(13).fill(id) }), /项目文档列表无效/);
});
