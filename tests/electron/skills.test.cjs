const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const skills = require("../../electron/lib/skills.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-skills-"));
}

test("写技能：frontmatter 完整、0600、文件名由技能名安全生成", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { fileName } = skills.writeSkill(dir, {
    name: "会议纪要整理", description: "把转写整理成纪要", body: "整理成：决定/待办/风险三段。",
  });
  assert.strictEqual(fileName, "会议纪要整理.md");
  const target = path.join(dir, fileName);
  assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  const text = fs.readFileSync(target, "utf8");
  assert.match(text, /^---\nname: 会议纪要整理\ndescription: 把转写整理成纪要\n---\n/);
  assert.match(text, /决定\/待办\/风险/);
});

test("路径穿越写不出去：../ 被折成普通文件名，落点仍在技能目录内", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "..", "被穿越.md");
  skills.writeSkill(dir, { name: "../../被穿越", body: "内容够长，可以通过校验的正文。" });
  assert.ok(!fs.existsSync(outside), "绝不能写到技能目录外面");
  assert.deepStrictEqual(fs.readdirSync(dir), ["被穿越.md"]);
});

test("frontmatter 不被换行撑破：名字和描述里的换行折成空格", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { fileName } = skills.writeSkill(dir, {
    name: "多行名字", description: "第一行\n第二行\n---\nname: 假冒", body: "正文内容够长，能过校验。",
  });
  const text = fs.readFileSync(path.join(dir, fileName), "utf8");
  const blocks = text.match(/^---\s*$/gm) || [];
  assert.strictEqual(blocks.length, 2, "frontmatter 分隔符只能有两条");
  assert.match(text, /description: 第一行 第二行 --- name: 假冒/);
});

test("太短或没名字的技能拒收", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => skills.writeSkill(dir, { name: "", body: "内容够长的正文，能过校验。" }), /名字/);
  assert.throws(() => skills.writeSkill(dir, { name: "短", body: "太短" }), /太短/);
});

test("删技能是挪进 .trash，不是真删", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { fileName } = skills.writeSkill(dir, { name: "待删技能", body: "这段内容会被挪进回收夹。" });
  skills.discardSkill(dir, fileName);
  assert.ok(!fs.existsSync(path.join(dir, fileName)));
  const trashed = fs.readdirSync(path.join(dir, ".trash"));
  assert.strictEqual(trashed.length, 1);
  assert.match(trashed[0], /待删技能\.md$/);
});

test("全是标点的名字不产出无名文件", (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { fileName } = skills.writeSkill(dir, { name: "!!!???", body: "正文内容够长，能过校验。" });
  assert.match(fileName, /^skill-\d+\.md$/);
});
