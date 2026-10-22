import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 直接加载渲染进程真正用的那几个 .ts，不另抄一份逻辑。
const paletteUrl = new URL("../../src/lib/palette.ts", import.meta.url);
const promptsUrl = new URL("../../src/lib/prompts.ts", import.meta.url);
const backupUrl = new URL("../../src/lib/backup.ts", import.meta.url);
const storageUrl = new URL("../../src/lib/storage.ts", import.meta.url);
const restoreUrl = new URL("../../src/lib/restore.ts", import.meta.url);

const { filterCommands, groupCommands, moveSelection, scoreCommand } = await import(fileURLToPath(paletteUrl));
const { createPrompt, loadPrompts, savePrompts, sortPrompts, MAX_PROMPTS, MAX_PROMPT_LABEL } = await import(fileURLToPath(promptsUrl));
const { buildBackup, parseBackup, BACKUP_VERSION } = await import(fileURLToPath(backupUrl));
const { fitsConversationStorage } = await import(fileURLToPath(storageUrl));
const { planBackupRestore } = await import(fileURLToPath(restoreUrl));

function command(id, label, extra = {}) {
  return { id, label, group: "常用", kind: "action", run: () => {}, ...extra };
}

// ── 命令面板 ───────────────────────────────────────────────

test("整段命中排在子序列命中前面", () => {
  const list = [
    command("a", "知识库"),
    command("b", "新建对话"),
    command("c", "定时任务"),
  ];
  const hits = filterCommands(list, "定时");
  assert.equal(hits[0].id, "c");
  assert.equal(hits.length, 1, "不该把不相干的命令也捞出来");
});

test("开头命中比中间命中排得靠前", () => {
  const start = command("start", "模型切换");
  const middle = command("middle", "换一个模型试试");
  assert.ok(
    scoreCommand(start, "模型") > scoreCommand(middle, "模型"),
    "开头命中的分数应该更高",
  );
});

test("中文不做子序列拆字，免得「新建对话」被「新话」匹配上", () => {
  const list = [command("a", "新建对话")];
  assert.equal(filterCommands(list, "新话").length, 0);
  assert.equal(filterCommands(list, "新建").length, 1);
});

test("拉丁字母走子序列，敲首字母也能找到", () => {
  const list = [command("a", "knowledge base")];
  assert.equal(filterCommands(list, "kb").length, 1);
});

test("keywords 让中文命令也能用拼音和英文找到", () => {
  const list = [command("a", "定时任务", { keywords: ["schedule", "dingshi", "cron"] })];
  for (const query of ["schedule", "dingshi", "cron"]) {
    assert.equal(filterCommands(list, query).length, 1, `${query} 没找到`);
  }
});

test("label 命中排在 keywords 命中前面", () => {
  const byLabel = command("a", "模型");
  const byKeyword = command("b", "自动挑", { keywords: ["模型"] });
  assert.ok(scoreCommand(byLabel, "模型") > scoreCommand(byKeyword, "模型"));
});

test("没有输入内容时，顺序就是调用方安排的顺序", () => {
  const list = [command("a", "第一"), command("b", "第二"), command("c", "第三")];
  assert.deepEqual(filterCommands(list, "").map((item) => item.id), ["a", "b", "c"]);
});

test("分组保留首次出现的次序，不会每次开面板都跳一下", () => {
  const list = [
    command("a", "一", { group: "常用" }),
    command("b", "二", { group: "换模型" }),
    command("c", "三", { group: "常用" }),
  ];
  const groups = groupCommands(list);
  assert.deepEqual(groups.map((entry) => entry.group), ["常用", "换模型"]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["a", "c"]);
});

test("上下键跳过不可选项", () => {
  const list = [
    command("a", "一"),
    command("b", "二", { disabled: true }),
    command("c", "三"),
  ];
  assert.equal(moveSelection(list, 0, 1), 2, "该跳过中间那条不可选的");
  assert.equal(moveSelection(list, 2, 1), 0, "到底了应该绕回开头");
  assert.equal(moveSelection(list, 0, -1), 2, "往上应该绕到末尾");
});

test("全都不可选时上下键停在原地，不会转圈卡死", () => {
  const list = [command("a", "一", { disabled: true }), command("b", "二", { disabled: true })];
  assert.equal(moveSelection(list, 0, 1), 0);
  assert.equal(moveSelection([], 0, 1), 0);
});

test("面板里的命令上限挡住了超长列表", () => {
  const list = Array.from({ length: 200 }, (_, index) => command(`c${index}`, `命令${index}`));
  assert.equal(filterCommands(list, "").length, 40);
});

// ── 我的指令 ───────────────────────────────────────────────

test("常用的指令排前面，一样常用的按新旧", () => {
  const list = [
    { id: "a", label: "少用", body: "x", createdAt: 300, useCount: 1 },
    { id: "b", label: "常用", body: "y", createdAt: 100, useCount: 9 },
    { id: "c", label: "同样少用但新", body: "z", createdAt: 400, useCount: 1 },
  ];
  assert.deepEqual(sortPrompts(list).map((item) => item.id), ["b", "c", "a"]);
  assert.deepEqual(list.map((item) => item.id), ["a", "b", "c"], "sortPrompts 不该改动传进来的数组");
});

test("没写标题时拿正文开头当标题，超过 20 字就截断", () => {
  const short = createPrompt("", "用学术语气改写");
  assert.equal(short.label, "用学术语气改写", "没超长就不该截");
  assert.equal(short.useCount, 0);

  const long = createPrompt("", "用学术语气改写这段话，禁止形容词堆砌，也不要用被动语态");
  assert.equal(long.label.length, MAX_PROMPT_LABEL);
  assert.equal(long.label, "用学术语气改写这段话，禁止形容词堆砌，也");
  assert.equal(long.body.length, 27, "只截标题，正文要完整留着");
});

test("正文首尾空白会被去掉", () => {
  assert.equal(createPrompt("改写", "  改得口语一点  ").body, "改得口语一点");
});

test("读取时丢掉形状不对的条目，不整份报废", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  store.set("kaii.prompts.v1", JSON.stringify([
    { id: "good", label: "好的", body: "一句话", createdAt: 1, useCount: 0 },
    { id: "no-body" },
    { body: "没有 id" },
    { id: "blank", body: "   " },
  ]));
  const loaded = loadPrompts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "good");
});

test("坏掉的 localStorage 内容读成空数组，不抛异常", () => {
  const store = new Map([["kaii.prompts.v1", "{不是 JSON"]]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.deepEqual(loadPrompts(), []);
});

test("存不下时返回失败而不是崩掉界面", () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
  };
  const result = savePrompts([{ id: "a", label: "一", body: "x", createdAt: 0, useCount: 0 }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /没有保存成功/);
});

test("超过上限的部分不会写进去", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const many = Array.from({ length: MAX_PROMPTS + 10 }, (_, index) => ({
    id: `p${index}`, label: `第${index}`, body: "x", createdAt: index, useCount: 0,
  }));
  savePrompts(many);
  assert.equal(JSON.parse(store.get("kaii.prompts.v1")).length, MAX_PROMPTS);
});

// ── 备份与恢复 ─────────────────────────────────────────────

const sampleConversation = {
  id: "c1",
  title: "一段对话",
  createdAt: 1,
  updatedAt: 2,
  skillId: "none",
  messages: [{
    id: "m1",
    role: "user",
    content: "看看这张图",
    createdAt: 1,
    attachment: { name: "图.png", mimeType: "image/png", previewDataUrl: "data:image/png;base64,AAAA", storedPath: "x" },
  }],
};

test("备份里没有 API key，也没有 key 长得像的东西", () => {
  const text = buildBackup([sampleConversation], [], []);
  for (const token of ["apiKey", "api_key", "sk-", "credentials"]) {
    assert.equal(text.includes(token), false, `备份里出现了 ${token}`);
  }
});

test("图片预览的 data URL 不跟着备份走", () => {
  const text = buildBackup([sampleConversation], [], []);
  assert.equal(text.includes("data:image/png;base64"), false, "几张图就能把备份撑到几十兆");
  // 但附件本身的记录要留着，否则恢复后连"这里曾经有张图"都看不出来。
  assert.ok(text.includes("图.png"));
});

test("备份文件自带附件与项目资料不含正文的明确说明", () => {
  const payload = JSON.parse(buildBackup([sampleConversation], [], []));
  assert.ok(Array.isArray(payload.limitations));
  assert.match(payload.limitations.join("\n"), /图片分析记录/);
  assert.match(payload.limitations.join("\n"), /文档正文/);
  assert.match(payload.limitations.join("\n"), /项目常驻资料/);
});

test("导出的备份能被自己读回来", () => {
  const prompts = [{ id: "p1", label: "改写", body: "口语一点", createdAt: 1, useCount: 3 }];
  const projects = [{ id: "j1", name: "论文", instructions: "", createdAt: 1, documents: [] }];
  const result = parseBackup(buildBackup([sampleConversation], projects, prompts));
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { conversations: 1, projects: 1, prompts: 1 });
  assert.equal(result.conversations[0].messages[0].content, "看看这张图");
  assert.equal(fitsConversationStorage(result.conversations), true, "读回来的对话必须能安全走后续保存链");
});

test("备份深层坏数据被清洗：null 消息和非字符正文不会进界面", () => {
  const payload = {
    app: "kaii",
    backupVersion: BACKUP_VERSION,
    conversations: [{
      ...sampleConversation,
      messages: [
        null,
        { id: "bad-content", role: "user", content: 42, createdAt: 1 },
        {
          id: "safe",
          role: "assistant",
          content: "这条能恢复",
          createdAt: 2,
          toolCalls: [null, { callId: "broken", tool: "read_file", status: "ok", detail: 9 }],
          document: { id: "doc-1" },
          attachment: { id: "img-1", name: "图.png", width: "wide" },
        },
      ],
    }],
    projects: [{ id: "project-1", name: "项目", documents: [null, { id: "doc-1" }] }],
    prompts: [{ id: "prompt-1", body: "可用正文", label: 99 }],
  };
  const result = parseBackup(JSON.stringify(payload));
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { conversations: 1, projects: 1, prompts: 1 });
  assert.deepEqual(result.conversations[0].messages.map((message) => message.id), ["safe"]);
  assert.equal(result.conversations[0].messages[0].toolCalls.length, 1);
  assert.equal(result.conversations[0].messages[0].toolCalls[0].detail, "");
  assert.equal(result.conversations[0].messages[0].document, undefined);
  assert.equal(result.conversations[0].messages[0].attachment.name, "图.png");
  assert.equal(result.conversations[0].messages[0].attachment.width, 0);
  assert.deepEqual(result.projects[0].documents, []);
  assert.equal(result.prompts[0].label, "可用正文");
  assert.equal(fitsConversationStorage(result.conversations), true);
  assert.doesNotThrow(() => buildBackup(result.conversations, result.projects, result.prompts));
});

test("不是 kaii 的文件会被整份拒绝，而不是恢复出半份数据", () => {
  const cases = [
    ["{不是 JSON", /不是合法的 JSON/],
    ["[1,2,3]", /不是 kaii 的备份/],
    [JSON.stringify({ app: "别的应用", backupVersion: 1 }), /不是 kaii 导出的/],
    [JSON.stringify({ app: "kaii", backupVersion: 99 }), /认不了/],
  ];
  for (const [text, pattern] of cases) {
    const result = parseBackup(text);
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
    assert.deepEqual(result.conversations, [], "拒绝的备份不该带出任何数据");
    assert.deepEqual(result.counts, { conversations: 0, projects: 0, prompts: 0 });
  }
});

test("单条形状不对的记录被丢掉，其余照常恢复", () => {
  const text = JSON.stringify({
    app: "kaii",
    backupVersion: BACKUP_VERSION,
    conversations: [sampleConversation, { id: "坏的" }, { title: "没有 id", messages: [] }],
    projects: [{ id: "j1", name: "论文" }, { id: "没名字" }],
    prompts: [{ id: "p1", body: "一句话" }, { label: "没有 id" }],
  });
  const result = parseBackup(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { conversations: 1, projects: 1, prompts: 1 });
});

test("恢复是合并：事务计划按 id 去重，现有条目优先且规划阶段不写盘", () => {
  const existing = { ...sampleConversation, title: "现有标题" };
  const fresh = { ...sampleConversation, id: "fresh-chat", title: "新搬来的" };
  const backup = JSON.stringify({
    app: "kaii",
    backupVersion: BACKUP_VERSION,
    conversations: [{ ...sampleConversation, title: "备份里的同 id 标题" }, fresh],
    projects: [],
    prompts: [],
  });
  let writes = 0;
  const storage = {
    getItem: () => null,
    setItem: () => { writes += 1; },
    removeItem: () => { writes += 1; },
  };
  const outcome = planBackupRestore(backup, { conversations: [existing], projects: [], prompts: [] }, storage, 1, "merge-contract");
  assert.equal(outcome.ok, true);
  assert.equal(writes, 0);
  const restored = JSON.parse(outcome.plan.target.conversations).conversations;
  assert.deepEqual(restored.map((item) => item.id), [sampleConversation.id, "fresh-chat"]);
  assert.equal(restored[0].title, "现有标题", "同 id 时不能拿备份覆盖现有内容");
});

test("命令面板：最近用过的提到前面，没用过的保持原次序", async () => {
  const { applyRecency } = await import("../../src/lib/palette.ts");
  const make = (id) => ({ id, label: id, group: "常用", kind: "action", run: () => {} });
  const commands = [make("a"), make("b"), make("c"), make("d")];
  const ordered = applyRecency(commands, ["c", "a"]);
  assert.deepEqual(ordered.map((item) => item.id), ["c", "a", "b", "d"]);
  // 没有历史就原样返回，不做任何重排
  assert.deepEqual(applyRecency(commands, []).map((item) => item.id), ["a", "b", "c", "d"]);
});
