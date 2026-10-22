const fs = require("node:fs");
const path = require("node:path");

// 技能的读写。以前只能读——想加一条得自己去目录里放 .md 文件，
// 等于「有这个能力但没人用得上」。这里补上写的那一半。
//
// 安全立场：文件名由应用生成（技能名 → 安全片段），**绝不拿用户输入直接拼路径**；
// 写之前再核一次落点确实在技能目录里（防 ../ 穿越），不在就拒绝。

const MAX_SKILL_NAME = 40;
const MAX_SKILL_BODY = 60_000;

// 技能名 → 文件名。只留字母数字和中日韩，其余折成连字符。
// 折完为空（比如全是标点）就用时间戳兜底，不产出无名文件。
function skillFileName(rawName) {
  const cleaned = String(rawName ?? "")
    .slice(0, MAX_SKILL_NAME)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return `${cleaned || `skill-${Date.now()}`}.md`;
}

// 落点必须在技能目录内（解析软链和 .. 之后再判）。
function resolveInside(directory, fileName) {
  const base = fs.realpathSync(directory);
  const target = path.resolve(base, fileName);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("这个技能文件名不合法。");
  }
  return target;
}

function writeSkill(directory, { name, description, body }) {
  const title = String(name ?? "").trim().slice(0, MAX_SKILL_NAME);
  if (!title) throw new Error("技能得有个名字。");
  const text = String(body ?? "").trim().slice(0, MAX_SKILL_BODY);
  // 门槛按中文来定：一句像样的中文指令通常六七个字就成立
  //（「整理成决定待办风险三段」），按 10 字卡会把正常输入拦掉。
  if (text.length < 6) throw new Error("技能内容太短了，写清楚要它怎么做。");

  fs.mkdirSync(directory, { recursive: true });
  const fileName = skillFileName(title);
  const target = resolveInside(directory, fileName);
  // frontmatter 里的值不能带换行，否则会把结构撑破。
  const oneLine = (value) => String(value ?? "").replace(/\r?\n/g, " ").trim();
  const markdown = [
    "---",
    `name: ${oneLine(title)}`,
    `description: ${oneLine(description) || "自己写的技能"}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, markdown, { mode: 0o600 });
  fs.renameSync(temp, target);
  return { fileName };
}

function readSkillBody(directory, fileName) {
  const target = resolveInside(directory, path.basename(String(fileName ?? "")));
  return fs.readFileSync(target, "utf8");
}

// 删技能只挪进目录里的 .trash/，不真删——手滑删掉自己写了半天的提示词
// 是不可逆的损失，而多留一个文件夹几乎没有代价。
function discardSkill(directory, fileName) {
  const target = resolveInside(directory, path.basename(String(fileName ?? "")));
  const trash = path.join(fs.realpathSync(directory), ".trash");
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.renameSync(target, path.join(trash, `${stamp}-${path.basename(target)}`));
  return { trashed: true };
}

module.exports = { MAX_SKILL_BODY, MAX_SKILL_NAME, discardSkill, readSkillBody, skillFileName, writeSkill };
