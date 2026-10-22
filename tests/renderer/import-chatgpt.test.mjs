import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const { parseChatGptExport, planChatGptImport } = await import("../../src/lib/import-chatgpt.ts");
const { fitsConversationStorage, MAX_STORAGE_BYTES } = await import("../../src/lib/storage.ts");
const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

// 按官方导出的真实形状造 fixture：mapping 树 + current_node，
// 带一条被放弃的重新生成分支。
function fixture() {
  return JSON.stringify([{
    conversation_id: "official-conversation-123",
    title: "搬家测试对话",
    create_time: 1723900000,
    update_time: 1723903600,
    current_node: "n4",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["n1"] },
      n1: { id: "n1", message: { author: { role: "system" }, content: { content_type: "text", parts: ["系统提示"] } }, parent: "root", children: ["n2"] },
      n2: { id: "n2", message: { author: { role: "user" }, create_time: 1723900100, content: { content_type: "text", parts: ["第一个问题"] } }, parent: "n1", children: ["n3", "n3b"] },
      n3b: { id: "n3b", message: { author: { role: "assistant" }, create_time: 1723900150, content: { content_type: "text", parts: ["被放弃的第一版回答"] } }, parent: "n2", children: [] },
      n3: { id: "n3", message: { author: { role: "assistant" }, create_time: 1723900200, content: { content_type: "text", parts: ["重新生成后的回答"] } }, parent: "n2", children: ["n4"] },
      n4: { id: "n4", message: { author: { role: "user" }, create_time: 1723900300, content: { content_type: "text", parts: ["追问", "第二段"] } }, parent: "n3", children: [] },
    },
  }, {
    title: "空会话",
    mapping: { root: { id: "root", message: null, parent: null, children: [] } },
    current_node: "root",
  }]);
}

test("current_node 回溯：只搬用户看到的那条线，放弃的分支不搬", () => {
  const { conversations, skipped } = parseChatGptExport(fixture());
  assert.equal(conversations.length, 1);
  assert.equal(skipped, 1);
  const [conv] = conversations;
  assert.equal(conv.title, "搬家测试对话");
  assert.equal(conv.id, "chatgpt-official-conversation-123", "官方 conversation id 会变成稳定的本地 id");
  assert.deepEqual(conv.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(conv.messages[1].content, "重新生成后的回答");
  assert.ok(!conv.messages.some((m) => m.content.includes("被放弃")));
  assert.ok(!conv.messages.some((m) => m.content.includes("系统提示")), "system 消息不搬");
  assert.equal(conv.messages[2].content, "追问\n第二段", "多 parts 拼接");
  assert.equal(conv.createdAt, 1723900000000, "秒转毫秒");
  assert.deepEqual(conv.tags, ["ChatGPT"]);
});

test("坏输入：非 JSON 与非数组都明确报错", () => {
  assert.throws(() => parseChatGptExport("不是json"), /conversations\.json/);
  assert.throws(() => parseChatGptExport('{"a":1}'), /会话数组/);
});

test("parent 环会让整段坏会话跳过，不会放大成重复消息", () => {
  const raw = JSON.stringify([{
    title: "环", current_node: "a",
    mapping: {
      a: { id: "a", message: { author: { role: "user" }, content: { content_type: "text", parts: ["x"] } }, parent: "b", children: [] },
      b: { id: "b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["y"] } }, parent: "a", children: [] },
    },
  }]);
  const { conversations, skipped } = parseChatGptExport(raw);
  assert.equal(conversations.length, 0);
  assert.equal(skipped, 1);
});

test("children 环也会让整段坏会话跳过", () => {
  const raw = JSON.stringify([{
    title: "children 环", current_node: "a",
    mapping: {
      a: { id: "a", message: { author: { role: "user" }, content: { content_type: "text", parts: ["x"] } }, parent: null, children: ["b"] },
      b: { id: "b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["y"] } }, parent: null, children: ["a"] },
    },
  }]);
  const { conversations, skipped } = parseChatGptExport(raw);
  assert.equal(conversations.length, 0);
  assert.equal(skipped, 1);
});

test("同一份官方导出重复解析得到同一 id，规划时如实计入重复", () => {
  const first = parseChatGptExport(fixture()).conversations;
  const second = parseChatGptExport(fixture()).conversations;
  assert.equal(first[0].id, second[0].id);
  assert.deepEqual(planChatGptImport(first, second), {
    accepted: [],
    duplicates: 1,
    capacitySkipped: 0,
  });

  const unsafe = JSON.parse(fixture());
  unsafe[0].conversation_id = "../有空格/🔒";
  const unsafeFirst = parseChatGptExport(JSON.stringify(unsafe)).conversations[0].id;
  const unsafeSecond = parseChatGptExport(JSON.stringify(unsafe)).conversations[0].id;
  assert.equal(unsafeFirst, unsafeSecond, "不安全的官方 id 也会稳定映射");
  assert.match(unsafeFirst, /^chatgpt-[a-z0-9_-]+$/i, "本地 id 不携带路径符号或空格");
});

function localConversation(id, updatedAt, content = "x") {
  return {
    id,
    title: id,
    skillId: "none",
    createdAt: updatedAt,
    updatedAt,
    messages: [{ id: `${id}-message`, role: "user", content, createdAt: updatedAt }],
  };
}

test("80 段上限前先保留较新导入，同时保证 accepted 全部能落盘", () => {
  const current = Array.from({ length: 79 }, (_value, index) => localConversation(`current-${index}`, index));
  const older = localConversation("older", 100);
  const newer = localConversation("newer", 200);
  const plan = planChatGptImport(current, [older, newer]);
  assert.deepEqual(plan.accepted.map((conversation) => conversation.id), ["newer"]);
  assert.equal(plan.duplicates, 0);
  assert.equal(plan.capacitySkipped, 1);
  assert.equal(current.length + plan.accepted.length, 80);
  assert.equal(fitsConversationStorage([...current, ...plan.accepted]), true);
});

test("字节容量不足时也先保留较新导入，而不是依赖保存时裁掉", () => {
  const current = [localConversation("base", 1, "b".repeat(MAX_STORAGE_BYTES - 700_000))];
  const older = localConversation("older-large", 100, "o".repeat(400_000));
  const newer = localConversation("newer-large", 200, "n".repeat(400_000));
  assert.equal(fitsConversationStorage([...current, newer]), true, "任一候选单独都能放下");
  assert.equal(fitsConversationStorage([...current, newer, older]), false, "两段一起超过真实序列化上限");

  const plan = planChatGptImport(current, [older, newer]);
  assert.deepEqual(plan.accepted.map((conversation) => conversation.id), ["newer-large"]);
  assert.equal(plan.capacitySkipped, 1);
  assert.equal(fitsConversationStorage([...current, ...plan.accepted]), true);
});

test("两个界面入口都按容量计划导入并如实报告结果", () => {
  const importer = app.slice(app.indexOf("const importConversations"), app.indexOf("const cycleProjectColor"));
  assert.match(importer, /conversationStorageBlocked\.current/);
  assert.match(importer, /planChatGptImport\(conversationsRef\.current, incoming\)/);
  assert.match(importer, /plan\.accepted\.length/);
  assert.match(importer, /conversationsRef\.current = next/);
  assert.match(importer, /storageBlocked: false/);

  assert.equal((app.match(/describeChatGptImport\(outcome, skipped\)/g) || []).length, 2);
  assert.match(app, /实际搬来/);
  assert.match(app, /本机容量不足没有搬入/);
  assert.match(app, /已经存在/);
});
