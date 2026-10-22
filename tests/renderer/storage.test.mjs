import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// storage.ts 是渲染进程模块。这里用 Node 自带的类型剥离直接加载源文件，
// 测的就是界面真正用的那份代码，不额外复制一份逻辑。
const storageUrl = new URL("../../src/lib/storage.ts", import.meta.url);
void path.dirname(fileURLToPath(import.meta.url));
const storage = await import(storageUrl.href);
const projects = await import(new URL("../../src/lib/projects.ts", import.meta.url).href);

function installLocalStorage({ quotaBytes = Infinity } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      let total = String(value).length;
      for (const [existingKey, existingValue] of store) if (existingKey !== key) total += existingValue.length;
      if (total > quotaBytes) {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
  };
  return store;
}

function conversation(id, messageCount, contentLength = 20) {
  return {
    id,
    title: `对话 ${id}`,
    skillId: "none",
    createdAt: 1,
    updatedAt: 2,
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      id: `${id}-m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: "字".repeat(contentLength),
      createdAt: index,
    })),
  };
}

test("v1 conversations migrate into the versioned envelope on first save", () => {
  const store = installLocalStorage();
  store.set("kai-local.conversations.v1", JSON.stringify([conversation("a", 2)]));

  const loaded = storage.loadConversations();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].messages.length, 2);

  const result = storage.saveConversations(loaded);
  assert.equal(result.ok, true);
  assert.equal(store.has("kai-local.conversations.v1"), false);
  const written = JSON.parse(store.get("kai-local.conversations.v2"));
  assert.equal(written.schemaVersion, storage.STORAGE_SCHEMA_VERSION);
  assert.equal(written.conversations.length, 1);
});

test("an unknown schema version is never half-read or overwritten by the empty fallback", () => {
  const store = installLocalStorage();
  const original = JSON.stringify({ schemaVersion: 99, conversations: [conversation("a", 2)] });
  store.set("kai-local.conversations.v2", original);
  const inspected = storage.loadConversationsWithStatus();
  assert.equal(inspected.status, "unsupported");
  assert.equal(inspected.schemaVersion, 99);
  assert.deepEqual(inspected.conversations, []);
  assert.deepEqual(storage.loadConversations(), []);
  const result = storage.saveConversations([conversation("fallback", 0)]);
  assert.equal(result.ok, false);
  assert.match(result.error, /保留原数据/);
  assert.equal(store.get("kai-local.conversations.v2"), original);
});

test("malformed current storage is preserved instead of silently replaced", () => {
  const store = installLocalStorage();
  store.set("kai-local.conversations.v2", "{broken");
  assert.equal(storage.loadConversationsWithStatus().status, "corrupt");
  const result = storage.saveConversations([conversation("fallback", 0)]);
  assert.equal(result.ok, false);
  assert.equal(store.get("kai-local.conversations.v2"), "{broken");
});

test("status-aware parser distinguishes missing, valid, unsupported and corrupt without storage I/O", () => {
  assert.equal(storage.parseConversationStorage(null).status, "missing");
  assert.equal(storage.parseConversationStorage(JSON.stringify({
    schemaVersion: storage.STORAGE_SCHEMA_VERSION,
    conversations: [conversation("valid", 1)],
  })).status, "valid");
  assert.equal(storage.parseConversationStorage(JSON.stringify({ schemaVersion: 77, conversations: [] })).status, "unsupported");
  assert.equal(storage.parseConversationStorage("{bad").status, "corrupt");
  assert.equal(storage.parseConversationStorage(JSON.stringify({
    schemaVersion: storage.STORAGE_SCHEMA_VERSION,
    conversations: [{ ...conversation("half", 1), messages: [null] }],
  })).status, "corrupt", "内层记录坏了也不能伪装成可安全清理附件的完整历史");
});

test("malformed rows are dropped without losing the rest of the history", () => {
  const store = installLocalStorage();
  store.set("kai-local.conversations.v2", JSON.stringify({
    schemaVersion: 2,
    conversations: [
      conversation("good", 2),
      { id: "broken" },
      { ...conversation("half", 1), messages: [{ id: "x" }, { id: "ok", role: "user", content: "在", createdAt: 1 }] },
    ],
  }));
  const loaded = storage.loadConversations();
  assert.deepEqual(loaded.map((item) => item.id), ["good", "half"]);
  assert.equal(loaded[1].messages.length, 1);
});

test("image previews never reach local storage", () => {
  const store = installLocalStorage();
  const withImage = conversation("a", 1);
  withImage.messages[0].attachment = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "x.png",
    previewDataUrl: "data:image/jpeg;base64,AAAA",
    width: 1,
    height: 1,
    ocrPreview: "",
    labelPreview: "",
  };
  storage.saveConversations([withImage]);
  const written = store.get("kai-local.conversations.v2");
  assert.equal(written.includes("base64,AAAA"), false);
  assert.equal(JSON.parse(written).conversations[0].messages[0].attachment.id, "11111111-1111-1111-1111-111111111111");
});

test("all conversation and message UI state survives a save and reload round trip", () => {
  installLocalStorage();
  const item = conversation("complete", 2);
  item.provider = "zhipu";
  item.model = "glm-5.2";
  item.branchedFrom = { conversationId: "parent", title: "原对话" };
  item.detachedContext = true;
  Object.assign(item.messages[1], {
    citations: [{ index: 1, library: "资料", file: "a.md", absolutePath: "/tmp/a.md", label: "第1段" }],
    memorySuggestions: [{ kind: "preference", label: "偏好", content: "回答简洁" }],
    runId: "run-1",
    continuable: true,
    continueReason: "truncated",
    reasoning: "这是独立保存的思考过程",
    usedModel: "glm-5.2",
    completion: {
      state: "verified",
      changedPaths: ["src/App.tsx"],
      checks: [{ summary: "npm test 通过", ok: true, timedOut: false }],
    },
  });

  assert.equal(storage.saveConversations([item]).ok, true);
  const loaded = storage.loadConversations()[0];
  assert.equal(loaded.provider, "zhipu");
  assert.equal(loaded.model, "glm-5.2");
  assert.deepEqual(loaded.branchedFrom, item.branchedFrom);
  assert.equal(loaded.detachedContext, true);
  for (const key of ["citations", "memorySuggestions", "runId", "continuable", "continueReason", "reasoning", "usedModel", "completion"]) {
    assert.deepEqual(loaded.messages[1][key], item.messages[1][key], `${key} 刷新后丢了`);
  }
});

test("retired extension history stays readable without retaining its live binding", () => {
  const old = { ...conversation("legacy-private", 2), dmrmlFingerprint: "a".repeat(64) };
  const parsed = storage.parseConversationStorage(JSON.stringify({ schemaVersion: 2, conversations: [old] }));
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.conversations[0].detachedContext, true);
  assert.equal(parsed.conversations[0].dmrmlFingerprint, undefined);
  const messageContent = ({ id, role, content, createdAt }) => ({ id, role, content, createdAt });
  assert.deepEqual(parsed.conversations[0].messages.map(messageContent), old.messages.map(messageContent));
  const reloaded = storage.parseConversationStorage(storage.buildConversationStoragePayload(parsed.conversations));
  assert.equal(reloaded.conversations[0].detachedContext, true);
  assert.deepEqual(reloaded.conversations[0].messages.map(messageContent), old.messages.map(messageContent));
});

test("启动时只清理多余的纯空壳，并优先保留当前对话", () => {
  const empty = (id, updatedAt) => ({
    id,
    title: "新对话",
    skillId: "none",
    createdAt: updatedAt,
    updatedAt,
    messages: [],
  });
  const configured = { ...empty("configured", 50), provider: "deepseek", model: "deepseek-v4-flash", projectId: "p1" };
  const pinned = { ...empty("pinned", 40), pinned: true };
  const real = conversation("real", 2);
  const input = [empty("newest", 30), configured, pinned, real, empty("active", 10), empty("old", 1)];

  const activeKept = storage.pruneRedundantEmptyConversations(input, "active");
  assert.deepEqual(activeKept.map((item) => item.id), ["pinned", "real", "active"]);

  const newestKept = storage.pruneRedundantEmptyConversations(input, "real");
  assert.deepEqual(newestKept.map((item) => item.id), ["configured", "pinned", "real"]);
  assert.deepEqual(storage.pruneRedundantEmptyConversations([configured, real], null), [configured, real]);
  assert.equal(storage.isDefaultEmptyConversation(configured), true, "继承模型和项目也不该让空对话越堆越多");
  assert.equal(storage.isDefaultEmptyConversation(pinned), false, "用户明确整理过的空对话仍然保留");
});

test("上次生成中的回答重载后明确标成中断，不伪装成完成", () => {
  installLocalStorage();
  const item = conversation("interrupted", 2);
  item.messages[1].content = "已经写到一半";
  item.messages[1].pending = true;

  assert.equal(storage.saveConversations([item]).ok, true);
  const restored = storage.loadConversations()[0].messages[1];
  assert.equal(restored.pending, false);
  assert.equal(restored.error, true);
  assert.equal(restored.continuable, true);
  assert.equal(restored.continueReason, "interrupted");
  assert.match(restored.content, /上次在生成中中断/);
});

test("超过会话上限时裁掉的数量会如实报告", () => {
  const store = installLocalStorage();
  const items = Array.from({ length: storage.MAX_CONVERSATIONS + 5 }, (_value, index) => conversation(`limit-${index}`, 1));
  const result = storage.saveConversations(items);
  assert.equal(result.ok, true);
  assert.equal(result.droppedConversations, 5);
  assert.equal(JSON.parse(store.get("kai-local.conversations.v2")).conversations.length, storage.MAX_CONVERSATIONS);
});

test("pure capacity preflight follows the real persistence limits and ignores ephemeral chats", () => {
  assert.equal(storage.fitsConversationStorage([conversation("small", 2)]), true);
  const overCount = Array.from({ length: storage.MAX_CONVERSATIONS + 1 }, (_value, index) => conversation(`c${index}`, 1));
  assert.equal(storage.fitsConversationStorage(overCount), false);
  const ephemeral = overCount.map((item) => ({ ...item, ephemeral: true }));
  assert.equal(storage.fitsConversationStorage([...ephemeral, conversation("kept", 1)]), true);
  assert.equal(
    storage.fitsConversationStorage([conversation("too-big", 1, storage.MAX_STORAGE_BYTES + 1000)]),
    false,
  );
});

test("project spreadsheet attachments keep their table kind after reload", () => {
  installLocalStorage();
  const project = {
    id: "p1",
    name: "表格项目",
    instructions: "",
    documents: [{ id: "d1", name: "数据.xlsx", kind: "table", pageCount: 0, characters: 120 }],
    createdAt: 1,
    updatedAt: 2,
  };
  assert.equal(projects.saveProjects([project]).ok, true);
  assert.equal(projects.loadProjects()[0].documents[0].kind, "table");
});

test("oversized histories are trimmed before writing and the trim is reported", () => {
  installLocalStorage();
  const heavy = Array.from({ length: 30 }, (_value, index) => conversation(`c${index}`, 40, 4000));
  const result = storage.saveConversations(heavy);
  assert.equal(result.ok, true);
  assert.ok(result.bytes <= storage.MAX_STORAGE_BYTES, `${result.bytes} bytes written`);
  assert.ok(result.droppedConversations > 0);
});

test("a full disk surfaces a readable error instead of throwing into the UI", () => {
  installLocalStorage({ quotaBytes: 200 });
  const result = storage.saveConversations([conversation("a", 6, 200)]);
  assert.equal(result.ok, false);
  assert.match(result.error, /存储已满/);
});

test("saving the active conversation id never throws when storage is full", () => {
  installLocalStorage({ quotaBytes: 1 });
  assert.doesNotThrow(() => storage.saveActiveConversationId("chat-1"));
});

test("export keeps a stable envelope and attachment ids can be collected for pruning", () => {
  installLocalStorage();
  const withImage = conversation("a", 1);
  withImage.messages[0].attachment = {
    id: "22222222-2222-2222-2222-222222222222",
    name: "y.png",
    previewDataUrl: "data:x",
    width: 1,
    height: 1,
    ocrPreview: "",
    labelPreview: "",
  };
  const exported = JSON.parse(storage.exportConversations([withImage, conversation("b", 1)]));
  assert.equal(exported.app, "kaii");
  assert.equal(exported.schemaVersion, storage.STORAGE_SCHEMA_VERSION);
  assert.equal(exported.conversations.length, 2);
  assert.equal(exported.conversations[0].messages[0].attachment.previewDataUrl, "");
  assert.deepEqual(
    storage.referencedAttachmentIds([withImage, conversation("b", 1)]),
    ["22222222-2222-2222-2222-222222222222"],
  );
});

test("对话的一句话摘要进白名单，超长的截断，垃圾值丢掉", async () => {
  const storage = await import("../../src/lib/storage.ts");
  const conversation = {
    id: "s1",
    title: "带摘要",
    messages: [],
    skillId: "none",
    createdAt: 1,
    updatedAt: 1,
    summary: "这段在聊怎么给论文起标题。" + "长".repeat(300),
  };
  storage.saveConversations([conversation]);
  const reloaded = storage.loadConversations();
  assert.equal(reloaded[0].summary.length, 200);
  assert.ok(reloaded[0].summary.startsWith("这段在聊"));

  storage.saveConversations([{ ...conversation, summary: "   " }]);
  assert.equal(storage.loadConversations()[0].summary, undefined);
});
