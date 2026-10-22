#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function gitTrackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`无法读取 Git 索引：${String(result.stderr || "unknown error").trim()}`);
  }
  return result.stdout.split("\0").filter(Boolean).sort();
}

function isTextCandidate(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".icns", ".pdf", ".pkl", ".zip", ".gz"].includes(extension)) return false;
  let stat;
  try {
    stat = fs.statSync(path.join(root, relativePath));
  } catch {
    return false;
  }
  return stat.isFile() && stat.size <= MAX_SCAN_BYTES;
}

const tracked = gitTrackedFiles();
const trackedSet = new Set(tracked);
const blockers = [];
const warnings = [];

function add(collection, code, file, detail) {
  collection.push({ code, file, detail });
}

if (!trackedSet.has("LICENSE")) add(blockers, "LICENSE_MISSING", "LICENSE", "作者尚未选择许可证");

for (const required of [
  "SECURITY.md",
  "docs/ARCHITECTURE.md",
  "docs/AGENT-HARNESS.md",
  "docs/OPEN-SOURCE-SCOPE.md",
  "native/kaii-vision.swift",
  "native/kaii-doc.swift",
  "native/kaii-speech.swift",
]) {
  if (!trackedSet.has(required)) {
    add(blockers, "REQUIRED_SOURCE_NOT_TRACKED", required, fs.existsSync(path.join(root, required)) ? "文件存在但尚未进入 Git 索引" : "文件缺失");
  }
}

const privatePathRules = [
  [/^PROGRESS\.md$|^docs\/PROGRESS\.md$/, "PRIVATE_LEDGER_TRACKED", "历史进度账不进入公共快照"],
  [/(^|\/)HANDOVER-[^/]+\.md$/, "PRIVATE_HANDOVER_TRACKED", "本机交接件不进入公共快照"],
  [/(^|[-_/])dmrml?([-_/]|\.|$)/i, "DMR_PRIVATE_PATH_TRACKED", "DMR/DMRML 属于私有研究扩展"],
  [/^tests\/fixtures\/dmrml-historical-replay\//, "DMR_FIXTURE_TRACKED", "历史研究 fixture 不进入公共快照"],
  [/^resources\/bin\//, "COMPILED_HELPER_TRACKED", "公共仓库应从 Swift 源码重建 helper"],
  [/^public\/avatars\/loopy\./i, "ASSET_LICENSE_PENDING", "角色素材来源与许可尚未确认"],
  [/^scripts\/(probe-deepseek|run-xwlb)/, "PRIVATE_PROBE_TRACKED", "个人探针与研究脚本不进入公共快照"],
];

for (const relativePath of tracked) {
  for (const [pattern, code, detail] of privatePathRules) {
    if (pattern.test(relativePath)) add(blockers, code, relativePath, detail);
  }
}

for (const shellFile of ["src/App.tsx", "src/global.d.ts", "electron/main.cjs", "electron/preload.cjs", "package.json"]) {
  let content = "";
  try { content = fs.readFileSync(path.join(root, shellFile), "utf8"); } catch { continue; }
  if (/dmrml?/i.test(content)) add(blockers, "PRIVATE_EXTENSION_COUPLED", shellFile, "公共应用壳仍直接引用 DMRML");
}

const secretLikePatterns = [
  [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}/, "SECRET_LIKE_TEXT"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GITHUB_TOKEN_TEXT"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "PRIVATE_KEY_TEXT"],
];

// Exact synthetic credentials used by redaction tests. New literals still fail the audit.
const reviewedTestTokens = {
  "tests/electron/agent-workspace.test.cjs": ["1d1cf91207f11fee006ef08527de9a9f4b128b36c3c449714df0be28e48dc23d", "945bec408a1a9f3435afc0cd33b11ac36433085a57ec1bc7da7310dd46fc0083"],
  "tests/electron/main-boundaries.test.cjs": ["dc65c166aaed759767d2080bcd67aa0b56e689df232ab441a6cfda8783bd2a6d", "c578f4c3f3c06215ee5d1dcc04227d820d541457cfbc15a7b42c833ee1427d20", "7bfec99448d0b7801ec23c1ec31bfca1700838adfd0d4d4392bb4071a8df4f67"],
  "tests/electron/providers.test.cjs": ["66951bbf4121b90479d03d601be0b96e171b8fd5d5771afdbb2cd80950164dbe"],
};

for (const relativePath of tracked) {
  if (!isTextCandidate(relativePath)) continue;
  let content;
  try { content = fs.readFileSync(path.join(root, relativePath), "utf8"); } catch { continue; }
  if (content.includes("\0")) continue;
  const reviewed = new Set(reviewedTestTokens[relativePath] || []);
  content = content.replace(/sk-[A-Za-z0-9_-]{24,}/g, (value) => reviewed.has(crypto.createHash("sha256").update(value).digest("hex")) ? "SYNTHETIC_TEST_TOKEN" : value);
  if (relativePath === "tests/electron/knowledge.test.cjs") {
    const fixture = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\\nMIIB\\n-----END RSA PRIVATE KEY-----";
    content = content.replace(fixture, "SYNTHETIC_TEST_PEM");
  }
  if (/\/Users\/[^/]+\//.test(content)) add(blockers, "ABSOLUTE_USER_PATH", relativePath, "包含本机用户绝对路径；审计器不会输出原文");
  for (const [pattern, code] of secretLikePatterns) {
    if (pattern.test(content)) add(blockers, code, relativePath, "发现疑似敏感文本；审计器不会输出匹配值");
  }
}

if (!tracked.some((file) => file.startsWith(".github/workflows/"))) {
  add(warnings, "CI_MISSING", ".github/workflows", "公共快照可独立构建后再添加 macOS CI");
}
if (trackedSet.has("package.json")) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.private !== true) add(warnings, "PACKAGE_NOT_PRIVATE", "package.json", "桌面应用未准备发布 npm 包时应保持 private=true");
}

const report = {
  schemaVersion: 1,
  source: root,
  ready: blockers.length === 0,
  trackedFiles: tracked.length,
  blockerCount: blockers.length,
  warningCount: warnings.length,
  blockers,
  warnings,
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`Kaii public-release audit: ${report.ready ? "READY" : "NOT READY"}\n`);
  process.stdout.write(`tracked=${report.trackedFiles} blockers=${report.blockerCount} warnings=${report.warningCount}\n`);
  for (const item of blockers) process.stdout.write(`BLOCK ${item.code} | ${item.file} | ${item.detail}\n`);
  for (const item of warnings) process.stdout.write(`WARN  ${item.code} | ${item.file} | ${item.detail}\n`);
}

process.exitCode = report.ready ? 0 : 2;
