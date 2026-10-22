import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { recentTopics, summarizeUsage } =
  await import(fileURLToPath(new URL("../../src/lib/usage.ts", import.meta.url)));
const { groupConversations } =
  await import(fileURLToPath(new URL("../../src/lib/projects.ts", import.meta.url)));
const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});
after(async () => vite.close());
const { projectToHtml } = await vite.ssrLoadModule("/src/lib/export-document.tsx");

const DAY = 86_400_000;

function conversation(id, { provider = "local", days = 0, turns = 1, pinned = false, title = id } = {}) {
  const at = Date.now() - days * DAY;
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ id: `${id}-u${index}`, role: "user", content: "问题", createdAt: at });
    messages.push({ id: `${id}-a${index}`, role: "assistant", content: "回答内容", createdAt: at });
  }
  return { id, title, provider, createdAt: at, updatedAt: at, skillId: "none", messages, pinned: pinned || undefined };
}

// ── 用量 ───────────────────────────────────────────────────

test("只数窗口期内的回答", () => {
  const usage = summarizeUsage([
    conversation("a", { days: 2, turns: 3 }),
    conversation("b", { days: 60, turns: 5 }),
  ], 30);
  assert.equal(usage.turns, 3, "60 天前的不该算进最近 30 天");
  assert.equal(usage.conversations, 1);
});

test("按模型分开数，多的排前面", () => {
  const usage = summarizeUsage([
    conversation("a", { provider: "local", turns: 1 }),
    conversation("b", { provider: "zhipu", turns: 4 }),
  ], 30);
  assert.equal(usage.byModel[0].label, "GLM");
  assert.equal(usage.byModel[0].turns, 4);
  assert.equal(usage.byModel[1].label, "Qwen3-8B");
});

test("消息自己记了模型的话，以它为准", () => {
  // 「比一比」里选中的回答会带 modelLabel，那才是真正答这条的模型。
  const one = conversation("a", { provider: "local", turns: 1 });
  one.messages[1].modelLabel = "DeepSeek V4";
  const usage = summarizeUsage([one], 30);
  assert.equal(usage.byModel[0].label, "DeepSeek V4");
});

test("用户说的话不算回答，空回答也不算", () => {
  const one = conversation("a", { turns: 1 });
  one.messages.push({ id: "x", role: "assistant", content: "", createdAt: Date.now() });
  assert.equal(summarizeUsage([one], 30).turns, 1);
});

test("没有数据时不炸", () => {
  const usage = summarizeUsage([], 30);
  assert.equal(usage.turns, 0);
  assert.deepEqual(usage.byModel, []);
  assert.equal(usage.busiestDay, null);
});

test("最忙的一天算的是当天的回答条数", () => {
  const usage = summarizeUsage([
    conversation("a", { days: 1, turns: 5 }),
    conversation("b", { days: 3, turns: 2 }),
  ], 30);
  assert.equal(usage.busiestDay.turns, 5);
});

test("这周的题目按新旧排，只取有来有回的", () => {
  const bare = conversation("bare", { days: 1, turns: 0 });
  bare.messages = [{ id: "only", role: "user", content: "只问了没答", createdAt: Date.now() }];
  const topics = recentTopics([
    conversation("old", { days: 20, turns: 1, title: "很久以前" }),
    conversation("new", { days: 1, turns: 1, title: "这周的" }),
    bare,
  ], 7);
  assert.equal(topics.length, 1);
  assert.match(topics[0], /这周的/);
});

// ── 置顶 ───────────────────────────────────────────────────

test("置顶的对话单独一组排最上面", () => {
  const groups = groupConversations([
    conversation("a", { days: 0 }),
    conversation("b", { days: 1, pinned: true }),
  ], []);
  assert.equal(groups[0].pinned, true);
  assert.deepEqual(groups[0].conversationIds, ["b"]);
  // 置顶的不该在别的组里再出现一次。
  const rest = groups.slice(1).flatMap((group) => group.conversationIds);
  assert.equal(rest.includes("b"), false);
});

test("没有置顶的时候不会多出一个空组", () => {
  const groups = groupConversations([conversation("a")], []);
  assert.equal(groups.some((group) => group.pinned), false);
});

test("置顶的项目对话也归到置顶组，不留在项目里", () => {
  const inProject = conversation("p1", { pinned: true });
  inProject.projectId = "proj";
  const groups = groupConversations([inProject], [{ id: "proj", name: "项目", instructions: "", createdAt: 1, documents: [] }]);
  assert.equal(groups[0].pinned, true);
  assert.deepEqual(groups[0].conversationIds, ["p1"]);
});

// ── 导出 ───────────────────────────────────────────────────

test("整个项目导出：有目录，每段对话只留一份落款", () => {
  const early = conversation("early", { title: "早", days: 2 });
  const late = conversation("late", { title: "晚", days: 1 });
  const html = projectToHtml("项目", [late, early], { footer: "项目落款" });
  assert.match(html, /class="project-toc"/);
  assert.match(html, /<li>早<\/li><li>晚<\/li>/);
  assert.ok(html.indexOf(">早<\/h1>") < html.indexOf(">晚<\/h1>"));
  assert.equal((html.match(/class="doc-foot"/g) || []).length, 1);
  assert.equal((html.match(/项目落款/g) || []).length, 1);
});

test("清理只碰三类文件，不碰对话、记忆、凭据和存下来的网页", () => {
  const main = fs.readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
  const block = main.slice(main.indexOf('ipcMain.handle("storage:sweep"'), main.indexOf('ipcMain.handle("readlater:list"'));
  assert.match(block, /pruneOrphanImages/);
  assert.match(block, /collectReferencedDocuments/);
  assert.match(block, /kaii-截图-|kaii-paste-/);
  for (const token of ["conversations", "credentials", "memory", "readlater.json"]) {
    assert.equal(block.includes(token), false, `清理动了不该动的：${token}`);
  }
  // 只删一小时以前的临时文件，别把正在用的那份删了。
  assert.match(block, /3600_000/);
});
