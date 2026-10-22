import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const org = await import(fileURLToPath(new URL("../../src/lib/organize.ts", import.meta.url)));
const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const componentSource = (name) => fs.readFileSync(new URL(`../../src/components/${name}.tsx`, import.meta.url), "utf8");

const make = (id, extra = {}) => ({
  id, title: id, messages: [], createdAt: 1, updatedAt: 1, skillId: "none", ...extra,
});

test("归档和回收站里的都不在主列表", () => {
  const list = [make("a"), make("b", { archived: true }), make("c", { deletedAt: Date.now() })];
  assert.deepEqual(list.filter(org.isVisible).map((item) => item.id), ["a"]);
});

test("标签统计不算归档和已删的", () => {
  const list = [
    make("a", { tags: ["要跟进", "重要"] }),
    make("b", { tags: ["要跟进"] }),
    make("c", { tags: ["不该算"], archived: true }),
    make("d", { tags: ["也不该算"], deletedAt: Date.now() }),
  ];
  assert.deepEqual(org.allTags(list), [
    { tag: "要跟进", count: 2 },
    { tag: "重要", count: 1 },
  ]);
});

test("再点一次同一个标签是去掉", () => {
  assert.deepEqual(org.toggleTag([], "重要"), ["重要"]);
  assert.deepEqual(org.toggleTag(["重要"], "重要"), []);
  // 空白和纯空格不算标签。
  assert.deepEqual(org.toggleTag([], "   "), []);
});

test("标签数量有上限，超了就不再加", () => {
  const full = ["1", "2", "3", "4", "5", "6", "7", "8"];
  assert.equal(org.toggleTag(full, "9").length, org.MAX_TAGS);
  // 但去掉已有的仍然有效。
  assert.equal(org.toggleTag(full, "1").length, 7);
});

test("选多个标签是「都要有」，不是「有一个就行」", () => {
  // 筛选的目的是缩小范围。或的语义会越筛越多，很反直觉。
  const one = make("a", { tags: ["x"] });
  const both = make("b", { tags: ["x", "y"] });
  assert.equal(org.matchesTags(one, ["x", "y"]), false);
  assert.equal(org.matchesTags(both, ["x", "y"]), true);
  // 没选标签时全都算符合。
  assert.equal(org.matchesTags(one, []), true);
});

test("回收站超过三十天才真删", () => {
  const now = Date.now();
  const list = [
    make("old", { deletedAt: now - 31 * 86_400_000 }),
    make("edge", { deletedAt: now - 29 * 86_400_000 }),
    make("alive", {}),
  ];
  assert.deepEqual(org.expiredInTrash(list, now), ["old"]);
});

test("删除是两步：先进回收站，再彻底删", () => {
  // 手滑删掉一段聊了两小时的对话是不可逆的损失，
  // 多按一次的代价几乎为零。这个不对称决定了该做两步。
  const block = app.slice(app.indexOf("const deleteChat = useCallback"), app.indexOf("const startModel"));
  assert.match(block, /deletedAt: Date\.now\(\)/);
  assert.equal(/current\.filter\(\(conversation\) => conversation\.id !== conversationId\)/.test(block), false,
    "deleteChat 还在直接过滤掉，那就是真删了");
  assert.match(block, /const purgeChat/);
  assert.match(block, /const restoreChat/);
});

test("彻底删除会问一次", () => {
  const trash = fs.readFileSync(new URL("../../src/components/TrashPanel.tsx", import.meta.url), "utf8");
  assert.match(trash, /window\.confirm/);
  assert.match(trash, /撤不回来/);
});

test("启动时清掉回收站里过期的", () => {
  assert.match(app, /expiredInTrash\(current\)/);
});

test("资料面板不能把本机索引说成云端零外发", () => {
  // 索引和原文件留在本机，但选了云端模型后，
  // 命中的段落会进入模型请求。不写这一句会让用户做错误的隐私判断。
  for (const name of ["KnowledgePanel", "ProjectPanel", "WorkspacePanel", "ReadLaterPanel"]) {
    assert.match(componentSource(name), /使用云端模型时/,
      `${name} 没说明云端模型会收到本轮用到的资料`);
  }
  assert.match(componentSource("KnowledgePanel"), /原文件不会修改/);
  assert.match(componentSource("WorkspacePanel"), /默认只读/);
});

test("面板空状态只说怎么用，不向用户解释设计理由", () => {
  const source = [
    "SchedulePanel", "ReadLaterPanel", "StarredPanel", "AuditPanel", "ReviewPanel", "ShortcutsPanel",
  ].map(componentSource).join("\n");
  for (const oldCopy of [
    "时间抽错了却默默存下来",
    "存多了之后一篇篇挂太笨",
    "比三个月后回想",
    "写个数字给你反而误导",
    "什么都能从这找",
  ]) {
    assert.equal(source.includes(oldCopy), false, `还残留自我解释文案：${oldCopy}`);
  }
});
