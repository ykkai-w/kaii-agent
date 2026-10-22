const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { truncateDiff, unifiedDiff, diffStats } = require("./diff.cjs");
const workspace = require("./workspace.cjs");

const MAX_MODEL_OUTPUT_BYTES = 6000;
const MAX_DETAIL_BYTES = 60_000;
const MAX_WRITE_BYTES = 400_000;
const DEFAULT_COMMAND_TIMEOUT = 120_000;
const MAX_COMMAND_TIMEOUT = 600_000;
const BASE_COMMAND_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const HOMEBREW_OPT = "/opt/homebrew/opt";
const MAX_EXTRA_PATH_ENTRIES = 20;
const PROCESS_TREE_EXIT_WAIT_MS = 1500;
const RUN_PROCESS_TOKEN_ENV = "KAII_RUN_PROCESS_TOKEN";
const POSIX_PROCESS_CLEANUP_SCOPE = "process-group+tagged-descendants";
const WINDOWS_PROCESS_CLEANUP_SCOPE = "os-process-tree";
const PROCESS_SCAN_TIMEOUT_MS = 1200;
const PROCESS_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const PROCESS_SCAN_MAX_LINE_BYTES = 4 * 1024 * 1024;
const WORKSPACE_SCAN_MAX_FILES = 50_000;
const WORKSPACE_SCAN_MAX_DIRECTORIES = 20_000;
const WORKSPACE_SCAN_MAX_DEPTH = 64;
const WORKSPACE_SCAN_DIRECTORY_CONCURRENCY = 32;
const WORKSPACE_SCAN_ENTRY_CONCURRENCY = 256;
const MAX_SAFE_TRACKED_READ_BYTES = 32 * 1024 * 1024;
const KEG_TOOLCHAINS = new Set(["node", "python", "go", "rust", "swift", "make", "git", "yarn", "pnpm", "ruby", "openjdk", "llvm"]);
const activeCommandAborts = new Set();
const activeCommandSettlements = new Set();

// Homebrew 的 keg-only 工具链（node@22、python@3.12 等）不在 /opt/homebrew/bin 里，
// 只有 /opt/homebrew/opt/<包>/bin。这里只扫这一层，且只收白名单工具链，
// 不递归、也不读用户 shell 的 PATH，避免把任意注入路径带进子进程。
function discoverCommandPath() {
  let kegs = [];
  try {
    kegs = fs.readdirSync(HOMEBREW_OPT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .filter((entry) => KEG_TOOLCHAINS.has(entry.name.split("@")[0]))
      .map((entry) => path.join(HOMEBREW_OPT, entry.name, "bin"))
      .filter((candidate) => {
        try {
          return fs.statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      })
      .slice(0, MAX_EXTRA_PATH_ENTRIES);
  } catch {
    kegs = [];
  }
  return [BASE_COMMAND_PATH, ...kegs].join(":");
}

let cachedCommandPath = null;

function commandPath() {
  if (cachedCommandPath === null) cachedCommandPath = discoverCommandPath();
  return cachedCommandPath;
}

const ALLOWED_COMMANDS = Object.freeze({
  npm: { label: "npm" },
  npx: { label: "npx" },
  pnpm: { label: "pnpm" },
  yarn: { label: "yarn" },
  node: { label: "node" },
  python3: { label: "python3" },
  pytest: { label: "pytest" },
  ruff: { label: "ruff" },
  eslint: { label: "eslint" },
  tsc: { label: "tsc" },
  go: { label: "go" },
  cargo: { label: "cargo" },
  make: { label: "make" },
  swift: { label: "swift" },
  git: { label: "git", subcommands: new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch", "blame"]) },
});

const ARGUMENT_PATTERN = /^[\w@./:=,+-]{1,200}$/;

function truncateToUtf8Bytes(text, maxBytes) {
  const value = String(text);
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

// 路径类工具统一走这里：找不到就顺手把工作区里最像的路径带回去，
// 让模型下一轮直接改对，而不是白白烧掉一次调用。
function withPathHint(root, wanted, action) {
  try {
    return action();
  } catch (error) {
    if (!/不存在/.test(error?.message || "")) throw error;
    const suggestions = workspace.suggestPaths(root, wanted);
    if (!suggestions.length) {
      throw new Error(`${error.message}：${wanted}。先用 list_dir 看看这个工作区里到底有什么。`);
    }
    throw new Error(`${error.message}：${wanted}。工作区里最接近的是：\n${suggestions.map((item) => `- ${item}`).join("\n")}`);
  }
}

function assertArgs(args, allowed, required = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("工具参数必须是对象");
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new TypeError(`工具参数含未知字段：${key}`);
  }
  for (const key of required) {
    if (args[key] === undefined) throw new TypeError(`缺少工具参数：${key}`);
  }
  return args;
}

function optionalInteger(value, key, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${key}无效`);
  return value;
}

function optionalBoolean(value, key, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${key}无效`);
  return value;
}

function requireString(value, key, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) throw new TypeError(`${key}无效`);
  return value;
}

function normalizeWhitespace(text) {
  return text.replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
}

// 8B 模型最常见的失败不是想错，而是把原文抄歪一两个空格。
// 精确匹配失败时，这里做两件事：先试"忽略空白差异"的唯一定位，
// 再退一步把文件里最像的那几行原样回给模型，让它照抄，而不是瞎猜第二遍。
function locateAnchor(text, find) {
  const exactFirst = text.indexOf(find);
  if (exactFirst >= 0) {
    if (text.indexOf(find, exactFirst + 1) >= 0) {
      return { kind: "ambiguous", message: "find 的内容在文件里出现多次，请加上更多上下文让它唯一" };
    }
    return { kind: "exact", start: exactFirst, end: exactFirst + find.length };
  }

  const findKey = normalizeWhitespace(find);
  if (findKey) {
    const lines = text.split("\n");
    const findLineCount = find.split("\n").length;
    const hits = [];
    for (let start = 0; start + findLineCount <= lines.length; start += 1) {
      const window = lines.slice(start, start + findLineCount).join("\n");
      if (normalizeWhitespace(window) !== findKey) continue;
      const offset = lines.slice(0, start).reduce((total, line) => total + line.length + 1, 0);
      hits.push({ start: offset, end: offset + window.length, line: start + 1 });
      if (hits.length > 1) break;
    }
    if (hits.length === 1) {
      return { kind: "whitespace", start: hits[0].start, end: hits[0].end, line: hits[0].line };
    }
    if (hits.length > 1) {
      return { kind: "ambiguous", message: "忽略空白后 find 仍然命中多处，请加上更多上下文" };
    }
  }

  return { kind: "missing", message: describeNearest(text, find) };
}

function describeNearest(text, find) {
  const lines = text.split("\n");
  const findLines = find.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!findLines.length) return "find 的内容在文件里找不到。";
  const probe = findLines[0];
  const probeTokens = new Set(probe.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length > 1));
  let best = { score: 0, index: -1 };
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate) continue;
    let score = 0;
    if (candidate === probe) score = 1000;
    else {
      const candidateTokens = new Set(candidate.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length > 1));
      for (const token of probeTokens) if (candidateTokens.has(token)) score += token.length;
    }
    if (score > best.score) best = { score, index };
  }
  if (best.index < 0 || best.score < 2) {
    return "find 的内容在文件里找不到，文件里也没有相近的行。请先 read_file 看真实内容再原样复制。";
  }
  const from = Math.max(0, best.index - 2);
  const to = Math.min(lines.length, best.index + Math.max(3, findLines.length + 1));
  const excerpt = lines.slice(from, to)
    .map((line, offset) => `${String(from + offset + 1).padStart(5, " ")}| ${line}`)
    .join("\n");
  return [
    "find 的内容在文件里找不到。文件里最接近的是这一段，请从这里逐字复制（含缩进）：",
    excerpt,
  ].join("\n");
}

const SYNTAX_CHECKS = Object.freeze({
  ".json": "json",
  ".js": "node",
  ".cjs": "node",
  ".mjs": "node",
  ".py": "python",
});

// 写完立刻验一遍语法。小模型很容易把 replace 写成"新代码 + 原代码"，
// 结果留下重复的函数体或重复声明。这种结构性破坏不该指望模型自己发现，
// 系统查出来就立刻还原，并把真实报错交回去，让它知道自己刚才干了什么。
function verifySyntaxAfterWrite(absolutePath, spawnImpl = require("node:child_process").spawnSync) {
  const kind = SYNTAX_CHECKS[path.extname(absolutePath).toLowerCase()];
  if (!kind) return { checked: false, ok: true };

  if (kind === "json") {
    try {
      JSON.parse(fs.readFileSync(absolutePath, "utf8"));
      return { checked: true, ok: true };
    } catch (error) {
      return { checked: true, ok: false, message: `JSON 解析失败：${error.message}` };
    }
  }

  const binary = resolveCommandBinary(kind === "node" ? "node" : "python3");
  if (!binary) return { checked: false, ok: true };
  const args = kind === "node"
    ? ["--check", absolutePath]
    : ["-c", "import ast,sys; p=sys.argv[1]; ast.parse(open(p, encoding='utf-8').read(), filename=p)", absolutePath];
  const result = spawnImpl(binary, args, {
    cwd: path.dirname(absolutePath),
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: commandPath(), HOME: process.env.HOME || "", PYTHONDONTWRITEBYTECODE: "1" },
  });

  // 关键区分：检查器"没能给出结论"和"给出了不合法的结论"是两回事。
  // 机器繁忙时 node --check 可能超时或被信号打断，这时 status 不是 0，
  // 但那不代表代码有问题。把这种情况当成语法错误，就会把一次正确的修改白白回滚掉。
  if (result.error || result.signal || typeof result.status !== "number") {
    return { checked: false, ok: true, inconclusive: true };
  }
  if (result.status === 0) return { checked: true, ok: true };
  const detail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(0, 12).join("\n");
  return { checked: true, ok: false, message: detail || `语法检查返回 ${result.status}` };
}

const MAX_GUIDANCE_LINES = 140;

// 补丁失败后，与其让模型再花一轮 read_file，不如当场把带行号的真实内容塞回去，
// 并明确要求下一次改用按行替换——这是它最不容易写错的编辑方式。
function lineNumberedGuidance(absolutePath, relativePath) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch {
    return "";
  }
  const lines = text.split("\n");
  const shown = lines.slice(0, MAX_GUIDANCE_LINES)
    .map((line, index) => `${String(index + 1).padStart(5, " ")}| ${line}`)
    .join("\n");
  return [
    "",
    `下一次请改用按行替换，不要再用 find/replace。${relativePath} 现在的真实内容（带行号）：`,
    shown,
    lines.length > MAX_GUIDANCE_LINES ? `…（还有 ${lines.length - MAX_GUIDANCE_LINES} 行没显示）` : "",
    "",
    `照这个格式发：{"tool": "apply_patch", "args": {"path": "${relativePath}", "start_line": 起始行, "end_line": 结束行, "content": "这几行的新内容"}}`,
    "content 里的换行写成 \\n。start_line 到 end_line 这几行会被整段换掉，不要在 content 里重复它们。",
  ].filter(Boolean).join("\n");
}

function snapshotRoot(userDataPath) {
  return path.join(userDataPath, "snapshots");
}

function writeSnapshot(userDataPath, callId, relativePath, existingContent) {
  const directory = path.join(snapshotRoot(userDataPath), callId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "before.bin");
  if (existingContent === null) fs.writeFileSync(path.join(directory, "created.marker"), "", { mode: 0o600 });
  else fs.writeFileSync(target, existingContent, { mode: 0o600 });
  fs.writeFileSync(
    path.join(directory, "meta.json"),
    `${JSON.stringify({ schemaVersion: 1, callId, relativePath, existed: existingContent !== null }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return directory;
}

function rollbackSnapshot(rootPath, snapshotPath) {
  const meta = JSON.parse(fs.readFileSync(path.join(snapshotPath, "meta.json"), "utf8"));
  if (!meta || meta.schemaVersion !== 1 || typeof meta.relativePath !== "string") throw new Error("快照记录无效");
  const target = workspace.resolveInWorkspace(rootPath, meta.relativePath, { mustExist: false });
  if (!meta.existed) {
    try {
      fs.unlinkSync(target.absolute);
    } catch {}
    return { ok: true, action: "deleted", path: meta.relativePath };
  }
  const before = fs.readFileSync(path.join(snapshotPath, "before.bin"));
  fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
  fs.writeFileSync(target.absolute, before);
  return { ok: true, action: "restored", path: meta.relativePath };
}

function waitForChildClose(child, {
  timeoutMs = PROCESS_TREE_EXIT_WAIT_MS,
  isClosed = () => false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.("close", onClose);
      child.removeListener?.("error", onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(false);
    if (isClosed()) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once?.("close", onClose);
    child.once?.("error", onError);
    // close 可能刚好发生在上面的首次检查与绑定监听之间。
    if (isClosed()) queueMicrotask(onClose);
  });
}

async function waitForClosedOrThrow(child, isChildClosed) {
  const closed = await waitForChildClose(child, { isClosed: isChildClosed });
  if (!closed) throw new Error(`等待命令进程退出超过 ${PROCESS_TREE_EXIT_WAIT_MS}ms`);
}

function runProcessToken() {
  return crypto.randomBytes(32).toString("hex");
}

function redactRunProcessToken(text, token) {
  const value = String(text ?? "");
  return token ? value.split(token).join("[内部运行标记]") : value;
}

// run_test 可以运行编译器和测试框架；它们不保证只改一个文件。安全快照不能
// 复用界面索引的忽略规则：build/dist/target/node_modules、隐藏目录和深层目录
// 都可能被命令写入。这里遍历全部真实目录项；任何权限失败、越出工作区或
// 断开的符号链接、特殊文件、容量或深度边界都会令 complete=false，调用方据此
// 永久锁住当前任务。工作区内的符号链接（如 node_modules/.bin）记录链接本身；
// 其目标会在真实目录位置另行被遍历，不沿链接重复扫描。
// 为控制开销，不在每次命令前后重读整棵树的文件内容；用 inode、大小、
// mtimeNs 与不可由普通用户伪造回旧值的 ctimeNs 捕获常规内容替换。元数据查询
// 有界并发，避免大型 node_modules 把界面卡住几十秒。这不是容器隔离。
async function snapshotWorkspaceForRun(rootPath) {
  const entries = new Map();
  const root = path.resolve(rootPath);
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return { entries, complete: false };
  }
  const queue = [{ absolute: root, relative: "", depth: 0 }];
  let queueIndex = 0;
  let complete = true;
  let directoryCount = 0;
  let fileCount = 0;
  while (queueIndex < queue.length) {
    const directoryBatch = queue.slice(queueIndex, queueIndex + WORKSPACE_SCAN_DIRECTORY_CONCURRENCY);
    queueIndex += directoryBatch.length;
    directoryCount += directoryBatch.length;
    if (directoryCount > WORKSPACE_SCAN_MAX_DIRECTORIES) {
      complete = false;
      break;
    }
    const directoryResults = await Promise.all(directoryBatch.map(async (current) => {
      try {
        const children = await fs.promises.readdir(current.absolute, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name, "en"));
        return { current, children };
      } catch {
        return { current, children: null };
      }
    }));
    for (const { current, children } of directoryResults) {
      if (!children) {
        complete = false;
        continue;
      }
      for (let offset = 0; offset < children.length; offset += WORKSPACE_SCAN_ENTRY_CONCURRENCY) {
        const childBatch = children.slice(offset, offset + WORKSPACE_SCAN_ENTRY_CONCURRENCY);
        const inspected = await Promise.all(childBatch.map(async (child) => {
          const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
          const absolute = path.join(current.absolute, child.name);
          if (relative.length > 1024 || /[\u0000-\u001f\u007f]/.test(relative)) {
            return { relative, absolute, invalid: true };
          }
          try {
            const stat = await fs.promises.lstat(absolute, { bigint: true });
            if (!stat.isSymbolicLink()) return { relative, absolute, stat };
            const [linkText, realTarget] = await Promise.all([
              fs.promises.readlink(absolute),
              fs.promises.realpath(absolute),
            ]);
            return { relative, absolute, stat, linkText, realTarget };
          } catch {
            return { relative, absolute, invalid: true };
          }
        }));
        for (const item of inspected) {
          const { relative, absolute, stat } = item;
          if (item.invalid || !stat) {
            complete = false;
            continue;
          }
          if (stat.isSymbolicLink()) {
            fileCount += 1;
            if (fileCount > WORKSPACE_SCAN_MAX_FILES) {
              complete = false;
              queueIndex = queue.length;
              break;
            }
            const targetInsideRoot = item.realTarget === realRoot || item.realTarget.startsWith(`${realRoot}${path.sep}`);
            if (!targetInsideRoot) {
              complete = false;
              continue;
            }
            entries.set(relative, [
              "symlink", String(stat.dev), String(stat.ino), String(stat.size),
              String(stat.mtimeNs), String(stat.ctimeNs), JSON.stringify(item.linkText),
            ].join(":"));
            continue;
          }
          if (stat.isDirectory()) {
            if (current.depth >= WORKSPACE_SCAN_MAX_DEPTH) {
              complete = false;
              continue;
            }
            queue.push({ absolute, relative, depth: current.depth + 1 });
            continue;
          }
          if (!stat.isFile()) {
            complete = false;
            continue;
          }
          fileCount += 1;
          if (fileCount > WORKSPACE_SCAN_MAX_FILES) {
            complete = false;
            queueIndex = queue.length;
            break;
          }
          entries.set(relative, [
            "file", String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs),
          ].join(":"));
        }
        if (fileCount > WORKSPACE_SCAN_MAX_FILES) break;
      }
      if (fileCount > WORKSPACE_SCAN_MAX_FILES) break;
    }
    if (fileCount > WORKSPACE_SCAN_MAX_FILES) break;
  }
  return { entries, complete };
}

function diffWorkspaceSnapshots(before, after, { limit = 201 } = {}) {
  const changed = [];
  const allPaths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const relativePath of [...allPaths].sort((a, b) => a.localeCompare(b, "en"))) {
    if (before.entries.get(relativePath) === after.entries.get(relativePath)) continue;
    if (changed.length < limit) changed.push(relativePath);
    else break;
  }
  return {
    paths: changed.slice(0, Math.max(0, limit - 1)),
    overflow: changed.length >= limit,
    dirty: !before.complete || !after.complete || changed.length >= limit,
    scanComplete: before.complete && after.complete,
  };
}

function trackActiveCommand(promise, abort) {
  activeCommandAborts.add(abort);
  const settlement = promise.then(() => undefined, () => undefined).finally(() => {
    activeCommandAborts.delete(abort);
    activeCommandSettlements.delete(settlement);
  });
  activeCommandSettlements.add(settlement);
  return promise;
}

async function abortAndWaitForActiveCommands({ timeoutMs = 4000 } = {}) {
  for (const abort of [...activeCommandAborts]) abort();
  const pending = [...activeCommandSettlements];
  if (!pending.length) return { complete: true, pending: 0 };
  let timer;
  const completed = await Promise.race([
    Promise.all(pending).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return { complete: completed, pending: completed ? 0 : activeCommandSettlements.size };
}

function internalPsBinary() {
  for (const candidate of ["/bin/ps", "/usr/bin/ps"]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function lineContainsRunProcessToken(line, token) {
  const match = /^\s*(\d+)\s+([\s\S]*)$/.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
  const marker = `${RUN_PROCESS_TOKEN_ENV}=${token}`;
  let offset = -1;
  while ((offset = match[2].indexOf(marker, offset + 1)) >= 0) {
    const before = offset === 0 ? " " : match[2][offset - 1];
    const afterOffset = offset + marker.length;
    const after = afterOffset === match[2].length ? " " : match[2][afterOffset];
    if (/\s/.test(before) && /\s/.test(after)) return pid;
  }
  return null;
}

// macOS 没有 /proc/<pid>/environ，只能通过 ps -E 看进程启动时的环境。
// 这里逐行检查随机标记，内存里不保留全量输出，也绝不把其他进程的环境
// 带到日志、错误或工具返回值里。token 不放进 ps 的 argv/env，避免扫描器命中自己。
function scanRunProcessIds(token, { pids = null } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token)) return Promise.reject(new Error("内部运行标记无效"));
  const binary = internalPsBinary();
  if (!binary) return Promise.reject(new Error("找不到系统进程检查器"));

  const selected = Array.isArray(pids)
    ? [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid))]
    : null;
  if (selected && selected.length === 0) return Promise.resolve([]);

  const flags = process.platform === "darwin" ? ["-Eww"] : ["eww"];
  const psArgs = selected
    ? [...flags, "-p", selected.join(","), "-o", "pid=,command="]
    : [...flags, "-axo", "pid=,command="];

  return new Promise((resolve, reject) => {
    let scanner;
    try {
      scanner = spawn(binary, psArgs, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      });
    } catch {
      reject(new Error("进程检查器无法启动"));
      return;
    }

    const found = new Set();
    let carry = "";
    let bytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve([...found]);
    };
    const inspectLine = (line) => {
      const pid = lineContainsRunProcessToken(line, token);
      if (pid !== null) found.add(pid);
    };
    const timer = setTimeout(() => {
      try { scanner.kill("SIGKILL"); } catch {}
      finish(new Error("进程标记检查超时"));
    }, PROCESS_SCAN_TIMEOUT_MS);

    scanner.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > PROCESS_SCAN_MAX_BYTES) {
        try { scanner.kill("SIGKILL"); } catch {}
        finish(new Error("进程标记检查量过大"));
        return;
      }
      carry += chunk.toString("utf8");
      let newline;
      while ((newline = carry.indexOf("\n")) >= 0) {
        inspectLine(carry.slice(0, newline));
        carry = carry.slice(newline + 1);
      }
      if (Buffer.byteLength(carry, "utf8") > PROCESS_SCAN_MAX_LINE_BYTES) {
        try { scanner.kill("SIGKILL"); } catch {}
        finish(new Error("单个进程的启动环境过大，无法安全检查"));
      }
    });
    scanner.once("error", () => finish(new Error("进程检查器运行失败")));
    scanner.once("close", (code) => {
      if (settled) return;
      if (carry) inspectLine(carry);
      // BSD ps 在 -p 列表刚好全部退出时可能返回 1，这和“没命中”等价。
      if (code !== 0 && !(selected && found.size === 0 && code === 1)) {
        finish(new Error(`进程检查器退出码 ${code}`));
        return;
      }
      finish(null);
    });
  });
}

async function verifyRunProcessIds(token, pids) {
  const found = new Set();
  // 不把过长 PID 列表塞进内部 ps 的 argv。正常一次运行只会有几个。
  for (let index = 0; index < pids.length; index += 64) {
    const batch = await scanRunProcessIds(token, { pids: pids.slice(index, index + 64) });
    for (const pid of batch) found.add(pid);
  }
  return [...found];
}

async function terminateRunProcesses(token) {
  const deadline = Date.now() + PROCESS_TREE_EXIT_WAIT_MS;
  let emptyPasses = 0;
  let lastFound = [];
  while (Date.now() < deadline) {
    const candidates = await scanRunProcessIds(token);
    lastFound = candidates;
    if (candidates.length === 0) {
      emptyPasses += 1;
      // 连续两次为空，避免刚好错过正在 fork/setsid 的子进程。
      if (emptyPasses >= 2) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }

    emptyPasses = 0;
    // PID 可能在“全量扫描”到“发信号”之间被复用。临发信号前再按 PID
    // 检查一遍随机标记，不会因进程名、命令行或父 PID 猜测而误杀。
    const verified = await verifyRunProcessIds(token, candidates);
    const failures = [];
    for (const pid of verified) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") failures.push(`${pid}: ${error?.code || error?.message || "失败"}`);
      }
    }
    if (failures.length) throw new Error(`清理本次运行的脱离进程失败：${failures.join("、")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const remaining = await scanRunProcessIds(token);
  if (remaining.length) lastFound = remaining;
  if (lastFound.length) {
    throw new Error(`等待本次运行的脱离进程退出超过 ${PROCESS_TREE_EXIT_WAIT_MS}ms（${lastFound.slice(0, 8).join("、")}）`);
  }
}

function terminateWindowsProcessTree(child, { isChildClosed = () => false } = {}) {
  return new Promise((resolve, reject) => {
    const pid = Number(child?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      try { child?.kill?.("SIGKILL"); } catch {}
      waitForClosedOrThrow(child, isChildClosed).then(resolve, reject);
      return;
    }

    // Windows 没有 POSIX 进程组信号。taskkill /T 会按父子关系收掉整棵树，
    // 这是内部收尾，不会扩大 run_test 对用户开放的命令白名单，也不经过 shell。
    let killer;
    try {
      killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try { child.kill("SIGKILL"); } catch {}
      waitForClosedOrThrow(child, isChildClosed).then(
        () => reject(new Error("Windows 进程树清理器 taskkill 无法启动，只能确认直接子进程已退出")),
        reject,
      );
      return;
    }

    let killerSettled = false;
    const finishKiller = (error, code) => {
      if (killerSettled) return;
      killerSettled = true;
      clearTimeout(killerTimer);
      try { child.kill("SIGKILL"); } catch {}
      waitForClosedOrThrow(child, isChildClosed).then(() => {
        if (error) reject(new Error(`Windows 进程树清理器失败：${error.message}`));
        else if (code !== 0) reject(new Error(`Windows 进程树清理器退出码 ${code}`));
        else resolve();
      }, reject);
    };
    const killerTimer = setTimeout(
      () => finishKiller(new Error(`taskkill 超过 ${PROCESS_TREE_EXIT_WAIT_MS}ms 未退出`), null),
      PROCESS_TREE_EXIT_WAIT_MS,
    );
    killer.once("error", (error) => finishKiller(error, null));
    killer.once("close", (code) => finishKiller(null, code));
  });
}

async function terminateProcessTree(child, {
  processGroup = false,
  isChildClosed = () => false,
  runToken = null,
} = {}) {
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child, { isChildClosed });
    return;
  }

  const pid = Number(child?.pid);
  let killedGroup = false;
  const cleanupErrors = [];
  // detached:true 让直接子进程成为新进程组的组长。只对这个已隔离、
  // 且组号与我们刚 spawn 出来的 pid 相同的组发信号，避免误伤 kaii 自身。
  if (processGroup && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(-pid, "SIGKILL");
      killedGroup = true;
    } catch (error) {
      // ESRCH 表示这个独立组已经没有任何成员，等价于清理完成。
      // EPERM 却表示组可能仍在，必须把它报出来，不能假装没有残留。
      if (error?.code !== "ESRCH") {
        cleanupErrors.push(`清理进程组 ${pid} 失败：${error?.message || error}`);
      }
      killedGroup = true;
    }
  }
  if (!killedGroup) {
    try { child?.kill?.("SIGKILL"); } catch {}
  }

  // 孙进程可以 setsid/detached 逃出上面的专属进程组。每次 run_test
  // 都有一个 256-bit 随机标记，只清理继承了这个标记的进程。必须先做
  // 这一步再等 close：否则脱离孙进程持有 stdout/stderr 管道时，close 永远等不到。
  // 这不是容器/job object：项目代码若主动删除标记后再 setsid，macOS 没有一个
  // 无特权且不误杀的通用办法把它找回。因此返回的 cleanupScope 刻意写成
  // process-group+tagged-descendants，不宣称能收回显式规避这两层约束的恶意进程。
  if (runToken) {
    try {
      await terminateRunProcesses(runToken);
    } catch (error) {
      cleanupErrors.push(error?.message || "清理本次运行的脱离进程失败");
    }
  }
  try {
    await waitForClosedOrThrow(child, isChildClosed);
  } catch (error) {
    cleanupErrors.push(error?.message || "等待命令进程退出失败");
  }
  if (cleanupErrors.length) throw new Error(cleanupErrors.join("；"));
}

function runAllowedCommand({ command, args, cwd, timeoutMs, signal, spawnImpl = spawn }) {
  let abortForShutdown = () => {};
  const promise = new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const cleanupScope = processGroup ? POSIX_PROCESS_CLEANUP_SCOPE : WINDOWS_PROCESS_CLEANUP_SCOPE;
    const runToken = processGroup ? runProcessToken() : null;
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      detached: processGroup,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: commandPath(),
        HOME: process.env.HOME || "",
        LANG: "en_US.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        ...(runToken ? { [RUN_PROCESS_TOKEN_ENV]: runToken } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let terminating = false;
    let childClosed = false;
    child.once("close", () => {
      childClosed = true;
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(Object.assign(error, { cleanupScope }));
      else resolve(value ? {
        ...value,
        stdout: redactRunProcessToken(value.stdout, runToken),
        stderr: redactRunProcessToken(value.stderr, runToken),
        cleanupScope,
      } : value);
    };
    const stopTree = (reason) => {
      if (settled || terminating) return;
      terminating = true;
      terminateProcessTree(child, { processGroup, isChildClosed: () => childClosed, runToken }).then(
        () => {
          if (reason === "abort") {
            finish(Object.assign(new Error("命令已取消"), { name: "AbortError" }));
            return;
          }
          finish(null, {
            timedOut: reason === "timeout",
            code: null,
            stdout,
            stderr: reason === "output" ? `${stderr}\n[输出过大，已强制停止]` : stderr,
          });
        },
        (error) => {
          const cleanupError = error?.message || "未知清理错误";
          if (reason === "abort") {
            finish(Object.assign(
              new Error(`命令已取消，但后台进程清理失败：${cleanupError}`),
              { name: "AbortError", cleanupError },
            ));
            return;
          }
          finish(null, {
            timedOut: reason === "timeout",
            code: null,
            stdout,
            stderr: `${stderr}${stderr ? "\n" : ""}[后台进程清理失败：${cleanupError}]`,
            cleanupError,
          });
        },
      );
    };
    const onAbort = () => stopTree("abort");
    abortForShutdown = onAbort;
    const timer = setTimeout(() => stopTree("timeout"), timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (target, chunk) => {
      if (settled) return;
      bytes += chunk.length;
      const text = chunk.toString("utf8");
      if (target === "out") stdout = `${stdout}${text}`.slice(-MAX_DETAIL_BYTES);
      else stderr = `${stderr}${text}`.slice(-MAX_DETAIL_BYTES);
      if (bytes > MAX_DETAIL_BYTES * 8 && !terminating) {
        stopTree("output");
      }
    };
    child.stdout.on("data", (chunk) => collect("out", chunk));
    child.stderr.on("data", (chunk) => collect("err", chunk));
    child.once("error", (error) => {
      if (terminating) return;
      const pid = Number(child?.pid);
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        finish(new Error(`命令无法启动：${error.message}`));
        return;
      }
      terminating = true;
      terminateProcessTree(child, { processGroup, isChildClosed: () => childClosed, runToken }).then(
        () => finish(new Error(`命令运行失败：${error.message}`)),
        (cleanupFailure) => finish(Object.assign(
          new Error(`命令运行失败，且后台进程清理失败：${cleanupFailure?.message || "未知清理错误"}`),
          { cleanupError: cleanupFailure?.message || "未知清理错误" },
        )),
      );
    });
    child.once("exit", (code, signalName) => {
      if (terminating) return;
      terminating = true;
      const originalStatus = { timedOut: false, code, signal: signalName };
      // 直接子进程正常退出时，同组的后台孙进程可能仍在跑。
      // 保留原退出码，但在返回前仍然清掉这个专属进程组的剩余成员。
      terminateProcessTree(child, { processGroup, isChildClosed: () => childClosed, runToken }).then(
        () => finish(null, { ...originalStatus, stdout, stderr }),
        (error) => {
          const cleanupError = error?.message || "未知清理错误";
          finish(null, {
            ...originalStatus,
            stdout,
            stderr: `${stderr}${stderr ? "\n" : ""}[后台进程清理失败：${cleanupError}]`,
            cleanupError,
          });
        },
      );
    });
  });
  return trackActiveCommand(promise, () => abortForShutdown());
}

function resolveCommandBinary(command) {
  for (const directory of commandPath().split(":")) {
    const candidate = path.join(directory, command);
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const TOOLS = Object.freeze({
  list_dir: {
    id: "list_dir",
    title: "看目录",
    write: false,
    usage: 'list_dir {"path": "src"}',
    describe: (args) => `列出 ${args.path || "."}`,
    run(args, ctx) {
      assertArgs(args, new Set(["path"]));
      const result = withPathHint(ctx.root, args.path ?? ".", () => workspace.listDirectory(ctx.root, args.path ?? "."));
      const lines = result.entries.map((entry) => (
        entry.kind === "dir" ? `${entry.path}/` : `${entry.path}  ${entry.size}B`
      ));
      const text = [
        `目录 ${result.path}，共 ${result.entries.length} 项${result.truncated ? "（已截断）" : ""}${result.ignored ? `，忽略 ${result.ignored} 项` : ""}`,
        ...lines,
      ].join("\n");
      return { summary: `列出 ${result.path}：${result.entries.length} 项`, modelText: text, detail: text };
    },
  },
  read_file: {
    id: "read_file",
    title: "读文件",
    write: false,
    usage: 'read_file {"path": "src/App.tsx", "start_line": 1, "line_count": 120}',
    describe: (args) => `读取 ${args.path}`,
    run(args, ctx) {
      assertArgs(args, new Set(["path", "start_line", "line_count"]), ["path"]);
      const startLine = optionalInteger(args.start_line, "start_line", { min: 1, max: 1_000_000, fallback: 1 });
      const lineCount = optionalInteger(args.line_count, "line_count", { min: 1, max: 2000, fallback: 400 });
      const wanted = requireString(args.path, "path", 1024);
      const target = withPathHint(ctx.root, wanted, () => workspace.resolveInWorkspace(ctx.root, wanted));
      const stat = fs.statSync(target.absolute);
      if (!stat.isFile()) throw new Error("这不是文件");
      if (stat.size > MAX_SAFE_TRACKED_READ_BYTES) {
        throw new Error(`这个文件有 ${stat.size} 字节，超过工程检查点可安全核对的上限；不会读取，也不会解除写入锁`);
      }
      const file = withPathHint(ctx.root, wanted, () => workspace.readTextFile(ctx.root, wanted, { startLine, lineCount }));
      const numbered = file.content.split("\n")
        .map((line, index) => `${String(file.startLine + index).padStart(5, " ")}| ${line}`)
        .join("\n");
      const header = `文件 ${file.path}（共 ${file.totalLines} 行，本次 ${file.startLine}-${file.endLine}，sha256=${file.sha256.slice(0, 16)}）`;
      return {
        summary: `读取 ${file.path} 第 ${file.startLine}-${file.endLine} 行`,
        modelText: `${header}\n${numbered}`,
        detail: `${header}\n${numbered}`,
        meta: { sha256: file.sha256, totalLines: file.totalLines },
      };
    },
  },
  search_text: {
    id: "search_text",
    title: "搜代码",
    write: false,
    usage: 'search_text {"query": "fitPromptToContext", "glob": "**/*.cjs"}',
    describe: (args) => `搜索 ${args.query}`,
    run(args, ctx) {
      assertArgs(args, new Set(["query", "glob", "regex", "case_sensitive", "max_matches"]), ["query"]);
      const result = workspace.searchText(ctx.root, {
        query: requireString(args.query, "query", 400),
        glob: args.glob === undefined ? "" : requireString(args.glob, "glob", 200),
        regex: optionalBoolean(args.regex, "regex", false),
        caseSensitive: optionalBoolean(args.case_sensitive, "case_sensitive", false),
        maxMatches: optionalInteger(args.max_matches, "max_matches", { min: 1, max: 60, fallback: 40 }),
      });
      const lines = result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`);
      const text = lines.length
        ? `命中 ${result.matches.length} 处${result.truncated ? "（已截断）" : ""}，扫描 ${result.scannedFiles} 个文件\n${lines.join("\n")}`
        : `没有命中，扫描了 ${result.scannedFiles} 个文件`;
      return { summary: `搜索“${args.query}”：${result.matches.length} 处命中`, modelText: text, detail: text };
    },
  },
  update_plan: {
    id: "update_plan",
    title: "更新计划",
    write: false,
    usage: 'update_plan {"steps": [{"title": "读懂现有实现", "status": "done"}, {"title": "改 parser", "status": "doing"}]}',
    describe: (args) => `更新计划（${Array.isArray(args.steps) ? args.steps.length : 0} 步）`,
    run(args) {
      assertArgs(args, new Set(["steps"]), ["steps"]);
      if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 12) throw new TypeError("steps 必须是 1 到 12 项");
      const allowedStatus = new Set(["todo", "doing", "done"]);
      const steps = args.steps.map((step, index) => {
        if (!step || typeof step !== "object" || Array.isArray(step)) throw new TypeError(`第 ${index + 1} 步不是对象`);
        for (const key of Object.keys(step)) {
          if (!["title", "status"].includes(key)) throw new TypeError(`第 ${index + 1} 步含未知字段：${key}`);
        }
        const status = step.status === undefined ? "todo" : step.status;
        if (!allowedStatus.has(status)) throw new TypeError(`第 ${index + 1} 步的 status 必须是 todo/doing/done`);
        return { title: requireString(step.title, "title", 200), status };
      });
      if (steps.filter((step) => step.status === "doing").length > 1) throw new TypeError("同一时间最多只能有一步是 doing");
      const marks = { todo: "[ ]", doing: "[~]", done: "[x]" };
      const text = steps.map((step, index) => `${index + 1}. ${marks[step.status]} ${step.title}`).join("\n");
      const done = steps.filter((step) => step.status === "done").length;
      return {
        summary: `计划 ${done}/${steps.length} 完成`,
        modelText: `计划已记录：\n${text}\n继续执行下一步。`,
        detail: text,
        meta: { steps },
      };
    },
  },
  git_status: {
    id: "git_status",
    title: "看 Git",
    write: false,
    usage: 'git_status {}  （只用来看有哪些文件被改过，和能不能跑测试无关）',
    describe: () => "查看哪些文件被改过",
    async run(args, ctx) {
      assertArgs(args, new Set([]));
      const binary = resolveCommandBinary("git");
      if (!binary) {
        const text = "这台电脑上找不到 git。这不影响读文件、改文件和跑测试，继续用别的工具。";
        return { summary: "没有 git", modelText: text, detail: text };
      }
      const result = await runAllowedCommand({
        command: binary,
        args: ["status", "--porcelain=v1", "-b"],
        cwd: ctx.root,
        timeoutMs: 15_000,
        signal: ctx.signal,
        spawnImpl: ctx.spawnImpl,
      });
      if (result.code === 0) {
        const text = result.stdout.trim() || "工作区干净，没有未提交的改动";
        return { summary: "读取 Git 状态", modelText: text, detail: text };
      }
      const stderr = (result.stderr || "").trim();
      // "不是 Git 仓库"是很常见的正常情况，不能让模型误以为整个任务做不下去。
      if (/not a git repository/i.test(stderr)) {
        const text = "这个工作区不是 Git 仓库。这完全不影响读文件、改文件和跑测试，继续做你要做的事。";
        return { summary: "不是 Git 仓库（不影响其他操作）", modelText: text, detail: text };
      }
      const text = `git 返回 ${result.code}：${stderr || result.stdout.trim()}\n这只说明读不到 Git 状态，不影响读文件、改文件和跑测试。`;
      return { summary: "读不到 Git 状态（不影响其他操作）", modelText: text, detail: text };
    },
  },
  apply_patch: {
    id: "apply_patch",
    title: "改文件",
    write: true,
    usage: '按行替换（最稳，read_file 里的行号直接用）：apply_patch {"path": "src/a.ts", "start_line": 3, "end_line": 6, "content": "这几行的新内容"}\n     按原文替换：apply_patch {"path": "src/a.ts", "find": "原文片段", "replace": "新片段"}\n     一次改多处：apply_patch {"path": "src/a.ts", "edits": [{"find": "片段1", "replace": "新1"}, {"find": "片段2", "replace": "新2"}]}\n     新建或整体重写：apply_patch {"path": "新文件.md", "content": "全文", "expect_sha256": "已存在的文件必填"}',
    describe: (args) => `修改 ${args.path}`,
    plan(args, ctx) {
      assertArgs(args, new Set(["path", "find", "replace", "edits", "content", "expect_sha256", "start_line", "end_line"]), ["path"]);
      if (!ctx.writable) throw new Error("这个工作区只读，请先在工作区面板里打开“允许改写”");
      const relative = requireString(args.path, "path", 1024);
      const target = workspace.resolveInWorkspace(ctx.root, relative, { mustExist: false });
      const existed = target.exists && fs.statSync(target.absolute).isFile();
      const beforeBuffer = existed ? fs.readFileSync(target.absolute) : null;
      const beforeText = existed ? beforeBuffer.toString("utf8") : "";
      const beforeSha = existed ? crypto.createHash("sha256").update(beforeBuffer).digest("hex") : null;
      const shownPath = target.relative || relative;

      const hasLines = args.start_line !== undefined || args.end_line !== undefined;
      const hasEdits = args.edits !== undefined;
      const hasFind = args.find !== undefined;
      const hasContent = args.content !== undefined && !hasLines;
      const modes = [hasEdits, hasFind, hasContent, hasLines].filter(Boolean).length;
      if (modes !== 1) {
        throw new TypeError("四选一：start_line/end_line 按行替换、find/replace、edits 数组，或 content 全文");
      }

      let afterText;
      const notes = [];

      if (hasLines) {
        // 按行号替换：read_file 已经把行号打在每行前面了，模型只要说"换掉第几行到第几行"，
        // 不需要一字不差地把原文抄回来——这正是小模型最容易出错的地方。
        if (!existed) throw new Error("按行替换要求文件已经存在。新建文件请用 content。");
        if (workspace.looksBinary(target.absolute)) throw new Error("不改写二进制文件");
        const lines = beforeText.split("\n");
        const startLine = args.start_line;
        const endLine = args.end_line === undefined ? startLine : args.end_line;
        if (!Number.isInteger(startLine) || startLine < 1) throw new TypeError("start_line 必须是从 1 开始的整数");
        if (!Number.isInteger(endLine) || endLine < startLine) throw new TypeError("end_line 不能小于 start_line");
        if (startLine > lines.length) {
          throw new Error(`start_line=${startLine} 超出文件范围，这个文件只有 ${lines.length} 行。请先 read_file 看真实行号。`);
        }
        if (endLine > lines.length) {
          throw new Error(`end_line=${endLine} 超出文件范围，这个文件只有 ${lines.length} 行。请先 read_file 看真实行号。`);
        }
        const replacement = typeof args.content === "string"
          ? args.content
          : typeof args.replace === "string" ? args.replace : null;
        if (replacement === null) throw new TypeError("按行替换时要用 content 或 replace 给出这几行的新内容");
        if (replacement.length > MAX_WRITE_BYTES) throw new RangeError("替换内容过长");
        const replacedLines = replacement === "" ? [] : replacement.split("\n");
        afterText = [...lines.slice(0, startLine - 1), ...replacedLines, ...lines.slice(endLine)].join("\n");
        notes.push(`按行替换：第 ${startLine}-${endLine} 行（共 ${endLine - startLine + 1} 行）换成 ${replacedLines.length} 行`);
      } else if (hasEdits || hasFind) {
        if (!existed) throw new Error("要替换的文件不存在。新建文件请用 content。");
        if (workspace.looksBinary(target.absolute)) throw new Error("不改写二进制文件");
        const rawEdits = hasEdits ? args.edits : [{ find: args.find, replace: args.replace }];
        if (!Array.isArray(rawEdits) || rawEdits.length < 1 || rawEdits.length > 10) throw new TypeError("edits 必须是 1 到 10 项");
        afterText = beforeText;
        for (let index = 0; index < rawEdits.length; index += 1) {
          const edit = rawEdits[index];
          if (!edit || typeof edit !== "object" || Array.isArray(edit)) throw new TypeError(`第 ${index + 1} 处修改不是对象`);
          for (const key of Object.keys(edit)) {
            if (!["find", "replace"].includes(key)) throw new TypeError(`第 ${index + 1} 处修改含未知字段：${key}`);
          }
          const find = requireString(edit.find, `第 ${index + 1} 处的 find`, 20_000);
          const replace = typeof edit.replace === "string" ? edit.replace : "";
          if (replace.length > 40_000) throw new RangeError(`第 ${index + 1} 处的 replace 过长`);
          const anchor = locateAnchor(afterText, find);
          if (anchor.kind === "ambiguous" || anchor.kind === "missing") {
            const prefix = rawEdits.length > 1 ? `第 ${index + 1} 处修改失败：` : "";
            // edits 是全成或全不改，前面几处即使定位成功也不写盘。
            throw new Error(`${prefix}${anchor.message}${lineNumberedGuidance(target.absolute, relative)}`);
          }
          if (anchor.kind === "whitespace") {
            notes.push(`第 ${index + 1} 处的 find 空白和原文不完全一致，已按忽略空白的唯一命中定位到第 ${anchor.line} 行`);
          }
          afterText = `${afterText.slice(0, anchor.start)}${replace}${afterText.slice(anchor.end)}`;
        }
      } else {
        const content = typeof args.content === "string" ? args.content : "";
        if (content.length > MAX_WRITE_BYTES) throw new RangeError("content 过长");
        if (existed) {
          const expected = args.expect_sha256;
          if (typeof expected !== "string" || expected.length !== 64) {
            throw new TypeError("改写已存在的文件时必须提供 expect_sha256（先 read_file 拿到）");
          }
          if (expected.toLowerCase() !== beforeSha) throw new Error("文件已经变了，expect_sha256 不匹配，请重新 read_file");
        }
        afterText = content;
      }

      if (Buffer.byteLength(afterText, "utf8") > MAX_WRITE_BYTES) throw new RangeError("写入内容过大");
      const unchanged = afterText === beforeText;
      const diff = unchanged ? "" : unifiedDiff(beforeText, afterText, { path: shownPath });
      const stats = unchanged ? { added: 0, removed: 0 } : diffStats(beforeText, afterText);
      return { relative: shownPath, target, existed, beforeBuffer, beforeText, afterText, unchanged, diff, stats, notes };
    },
    preview(args, ctx) {
      const planned = this.plan(args, ctx);
      if (planned.unchanged) {
        return { summary: `${planned.relative} 内容不会有变化`, detail: "这次修改不会改变文件内容。" };
      }
      const shown = truncateDiff(planned.diff);
      return {
        summary: `${planned.existed ? "改写" : "新建"} ${planned.relative}：+${planned.stats.added} -${planned.stats.removed}`,
        detail: [planned.notes.join("\n"), shown.diff].filter(Boolean).join("\n"),
      };
    },
    run(args, ctx) {
      const planned = this.plan(args, ctx);
      if (planned.unchanged) {
        return {
          summary: `${planned.relative} 内容没有变化`,
          modelText: "文件内容没有变化，没有写入。不要重复同一个修改。",
          detail: "无改动",
        };
      }
      const snapshotPath = writeSnapshot(ctx.userDataPath, ctx.callId, planned.relative, planned.beforeBuffer);
      fs.mkdirSync(path.dirname(planned.target.absolute), { recursive: true });
      const temporary = `${planned.target.absolute}.${process.pid}.kaii-tmp`;
      try {
        fs.writeFileSync(temporary, planned.afterText, "utf8");
        fs.renameSync(temporary, planned.target.absolute);
      } finally {
        // rename 失败时只删掉本次精确命名的临时文件，绝不碰目标文件。
        try { fs.rmSync(temporary, { force: true }); } catch {}
      }

      const syntax = verifySyntaxAfterWrite(planned.target.absolute, ctx.spawnSyncImpl);
      if (syntax.checked && !syntax.ok) {
        rollbackSnapshot(ctx.root, snapshotPath);
        fs.rmSync(snapshotPath, { recursive: true, force: true });
        throw new Error([
          `这次修改让 ${planned.relative} 语法不合法，已经自动还原，文件回到修改前的样子。`,
          "真实报错：",
          syntax.message,
          "最常见的原因：你把新代码写在 find 之后，但原来的代码还留在那里，于是出现了两份。",
          lineNumberedGuidance(planned.target.absolute, planned.relative),
        ].filter(Boolean).join("\n"));
      }

      const afterSha = crypto.createHash("sha256").update(Buffer.from(planned.afterText, "utf8")).digest("hex");
      const shown = truncateDiff(planned.diff);
      const noteText = planned.notes.length ? `${planned.notes.join("\n")}\n` : "";
      return {
        summary: `${planned.existed ? "改写" : "新建"} ${planned.relative}：+${planned.stats.added} -${planned.stats.removed}`,
        modelText: `${noteText}已写入 ${planned.relative}。新的 sha256=${afterSha}\n差异：\n${shown.diff}`,
        detail: `${noteText}${shown.diff}`,
        changedPath: planned.relative,
        snapshotPath,
        meta: {
          added: planned.stats.added,
          removed: planned.stats.removed,
          sha256: afterSha,
          created: !planned.existed,
          notes: planned.notes,
        },
      };
    },
  },
  check_project: {
    id: "check_project",
    title: "认项目",
    write: false,
    usage: 'check_project {}',
    describe: () => "看看这个项目怎么测、怎么构建",
    run(args, ctx) {
      assertArgs(args, new Set([]));
      const findings = [];
      const suggestions = [];

      const readIfPresent = (relativePath) => {
        try {
          return workspace.readTextFile(ctx.root, relativePath, { maxBytes: 60_000 }).content;
        } catch {
          return null;
        }
      };

      const packageJson = readIfPresent("package.json");
      if (packageJson) {
        let parsed = null;
        try {
          parsed = JSON.parse(packageJson);
        } catch {
          findings.push("package.json 存在但不是合法 JSON");
        }
        if (parsed) {
          const scripts = parsed.scripts && typeof parsed.scripts === "object" ? Object.keys(parsed.scripts) : [];
          findings.push(`Node 项目${parsed.name ? `（${String(parsed.name).slice(0, 60)}）` : ""}，package.json 里有 ${scripts.length} 个脚本`);
          if (scripts.length) findings.push(`可用脚本：${scripts.slice(0, 20).join("、")}`);
          for (const candidate of ["test", "build", "lint", "typecheck"]) {
            if (scripts.includes(candidate)) suggestions.push(`run_test {"command": "npm", "args": ["run", "${candidate}"]}`);
          }
          if (scripts.includes("test")) suggestions.unshift('run_test {"command": "npm", "args": ["test"]}');
        }
      }
      if (readIfPresent("pyproject.toml")) {
        findings.push("Python 项目（有 pyproject.toml）");
        suggestions.push('run_test {"command": "pytest", "args": ["-q"]}');
      }
      if (readIfPresent("Cargo.toml")) {
        findings.push("Rust 项目（有 Cargo.toml）");
        suggestions.push('run_test {"command": "cargo", "args": ["test"]}');
      }
      if (readIfPresent("go.mod")) {
        findings.push("Go 项目（有 go.mod）");
        suggestions.push('run_test {"command": "go", "args": ["test", "./..."]}');
      }
      if (readIfPresent("Makefile")) {
        findings.push("有 Makefile");
        suggestions.push('run_test {"command": "make", "args": ["test"]}');
      }
      if (!findings.length) findings.push("没有认出常见的项目配置文件，测试命令需要问用户");

      const uniqueSuggestions = [...new Set(suggestions)];
      const text = [
        findings.join("\n"),
        uniqueSuggestions.length ? `建议的验证命令（挑一个，不要全跑）：\n${uniqueSuggestions.map((item) => `- ${item}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      return { summary: findings[0], modelText: text, detail: text };
    },
  },
  run_test: {
    id: "run_test",
    title: "跑命令",
    write: true,
    usage: 'run_test {"command": "npm", "args": ["run", "build"]}',
    describe: (args) => `运行 ${args.command} ${Array.isArray(args.args) ? args.args.join(" ") : ""}`.trim(),
    preview(args, ctx) {
      const validated = this.validate(args, ctx);
      return {
        summary: `在 ${path.basename(ctx.root)} 里运行：${validated.command} ${validated.commandArgs.join(" ")}`.trim(),
        detail: [
          `工作目录：${ctx.root}`,
          `实际执行：${validated.binary} ${validated.commandArgs.join(" ")}`.trim(),
          `超时：${Math.round(validated.timeoutMs / 1000)} 秒`,
          "不经过 shell，环境变量已最小化。",
        ].join("\n"),
      };
    },
    validate(args, ctx) {
      assertArgs(args, new Set(["command", "args", "timeout_ms"]), ["command"]);
      if (!ctx.writable) throw new Error("这个工作区只读，运行命令需要先在工作区面板里打开“允许改写”");
      const command = requireString(args.command, "command", 40);
      const rule = ALLOWED_COMMANDS[command];
      if (!rule) throw new Error(`不允许运行 ${command}。可用：${Object.keys(ALLOWED_COMMANDS).join("、")}`);
      const commandArgs = args.args === undefined ? [] : args.args;
      if (!Array.isArray(commandArgs) || commandArgs.length > 24) throw new TypeError("args无效");
      for (const item of commandArgs) {
        if (typeof item !== "string" || !ARGUMENT_PATTERN.test(item)) throw new TypeError(`命令参数无效：${String(item).slice(0, 40)}`);
      }
      if (rule.subcommands && !rule.subcommands.has(commandArgs[0])) {
        throw new Error(`${command} 只允许这些子命令：${[...rule.subcommands].join("、")}`);
      }
      const timeoutMs = optionalInteger(args.timeout_ms, "timeout_ms", {
        min: 1000,
        max: MAX_COMMAND_TIMEOUT,
        fallback: DEFAULT_COMMAND_TIMEOUT,
      });
      const binary = resolveCommandBinary(command);
      if (!binary) throw new Error(`这台电脑上找不到 ${command}`);
      return { command, commandArgs, timeoutMs, binary };
    },
    async run(args, ctx) {
      const { command, commandArgs, timeoutMs, binary } = this.validate(args, ctx);
      const started = Date.now();
      const before = await snapshotWorkspaceForRun(ctx.root);
      let result;
      let failure = null;
      try {
        result = await runAllowedCommand({
          command: binary,
          args: commandArgs,
          cwd: ctx.root,
          timeoutMs,
          signal: ctx.signal,
          spawnImpl: ctx.spawnImpl,
        });
      } catch (error) {
        failure = error;
      }
      const after = await snapshotWorkspaceForRun(ctx.root);
      const workspaceMutation = diffWorkspaceSnapshots(before, after);
      if (failure) {
        failure.workspaceChanges = workspaceMutation.paths;
        failure.workspaceDirty = workspaceMutation.dirty;
        failure.workspaceScanComplete = workspaceMutation.scanComplete;
        throw failure;
      }
      const durationMs = Date.now() - started;
      const status = result.timedOut ? "超时" : result.code === 0 ? "成功" : `退出码 ${result.code}`;
      const body = [
        `命令：${command} ${commandArgs.join(" ")}`.trim(),
        `结果：${status}，用时 ${(durationMs / 1000).toFixed(1)}s`,
        result.cleanupError ? `后台进程清理失败：${result.cleanupError}` : "",
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "stdout: 空",
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "stderr: 空",
      ].filter(Boolean).join("\n");
      return {
        summary: `${command} ${commandArgs.join(" ")}`.trim() + ` → ${status}`,
        modelText: body,
        detail: body,
        meta: {
          exitCode: result.code,
          timedOut: result.timedOut,
          durationMs,
          cleanupError: result.cleanupError || null,
          cleanupScope: result.cleanupScope,
          workspaceChanges: workspaceMutation.paths,
          workspaceDirty: workspaceMutation.dirty,
          workspaceScanComplete: workspaceMutation.scanComplete,
        },
      };
    },
  },
});

function listTools({ writable = false } = {}) {
  return Object.values(TOOLS)
    .filter((tool) => (writable ? true : !tool.write))
    .map(({ id, title, write, usage }) => ({ id, title, write, usage }));
}

function validateToolCall(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("工具调用必须是 JSON 对象");
  for (const key of Object.keys(raw)) {
    if (!["tool", "args"].includes(key)) throw new TypeError(`工具调用含未知字段：${key}`);
  }
  const tool = TOOLS[raw.tool];
  if (!tool) throw new TypeError(`没有这个工具：${String(raw.tool).slice(0, 40)}。可用：${Object.keys(TOOLS).join("、")}`);
  const args = raw.args === undefined ? {} : raw.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("args 必须是对象");
  return { tool: tool.id, args };
}

// 批准前的干跑：只算出这次改动到底会变成什么样，不碰磁盘。
// 拿不到预览（工具不支持或参数就不合法）时返回 null，让上层退回到只显示意图。
async function previewToolCall({ tool, args }, ctx) {
  const definition = TOOLS[tool];
  if (!definition || typeof definition.preview !== "function") return null;
  try {
    const preview = await definition.preview(args, ctx);
    const detail = truncateToUtf8Bytes(preview.detail ?? "", MAX_DETAIL_BYTES);
    return { summary: preview.summary ?? "", detail: detail.text };
  } catch (error) {
    return { summary: "这次调用还没执行就发现问题", detail: error?.message || "参数不合法", invalid: true };
  }
}

// 云端模型支持 OpenAI 风格的 tools 参数：由 API 约束输出结构，
// 比让模型自己写 <use_tool> 标签可靠得多——实测 Kimi 就是栽在"只宣布不发标签"上。
// 本机 llama-server 继续走文本协议，两条路共用同一套执行与审计。
const TOOL_SCHEMAS = Object.freeze({
  list_dir: {
    description: "列出工作区里某个目录的内容。不给 path 就列根目录。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "工作区内的相对路径，例如 src" } },
      additionalProperties: false,
    },
  },
  read_file: {
    description: "读取工作区里的一个文本文件，返回带行号的内容。改文件之前必须先读。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
        start_line: { type: "integer", description: "从第几行开始读，从 1 开始" },
        line_count: { type: "integer", description: "读多少行" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  search_text: {
    description: "在工作区里按关键词搜索，返回命中的文件、行号和整行内容。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜的文字" },
        path: { type: "string", description: "只搜这个子目录" },
        regex: { type: "boolean", description: "把 query 当正则处理" },
        max_results: { type: "integer" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  update_plan: {
    description: "记录或更新多步任务的计划。同一时间最多一步是 doing。",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              status: { type: "string", enum: ["todo", "doing", "done"] },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  git_status: {
    description: "看工作区里有哪些文件被改过。和能不能跑测试、能不能改文件无关。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  check_project: {
    description: "认一下这个项目是什么类型、怎么跑测试和构建。不知道测试命令时先用它。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  apply_patch: {
    description: [
      "修改工作区里的文件。四种方式选一种：",
      "1）按行替换（最稳）：给 start_line / end_line / content；",
      "2）按原文替换：给 find / replace，find 必须逐字复制且唯一；",
      "3）一次改多处：给 edits 数组；",
      "4）新建或整体重写：给 content，已存在的文件必须带 expect_sha256。",
      "写完系统会自动查语法，不合法会自动还原并把报错交回。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
        start_line: { type: "integer", description: "按行替换的起始行，从 1 开始" },
        end_line: { type: "integer", description: "按行替换的结束行，含这一行" },
        find: { type: "string", description: "要被替换掉的原文，必须逐字一致且在文件中唯一" },
        replace: { type: "string", description: "替换成什么。这是整段替换，不要在里面重复 find 的原文" },
        content: { type: "string", description: "按行替换时是这几行的新内容；新建文件时是全文" },
        expect_sha256: { type: "string", description: "整体重写已存在文件时必填，来自 read_file" },
        edits: {
          type: "array",
          description: "一次改同一个文件里的多处，全成或全不改",
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find"],
            additionalProperties: false,
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run_test: {
    description: "在工作区里运行一条白名单命令（npm、pytest、cargo、go 等），用来跑测试或构建。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "命令名，例如 npm" },
        args: { type: "array", items: { type: "string" }, description: "参数数组，例如 [\"test\"]" },
        timeout_ms: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
});

// 转成 OpenAI 的 tools 数组。只读工作区时不给写类工具，
// 让模型从一开始就看不到它做不到的事，而不是调用后再被拒绝。
function toolDefinitions({ writable = false } = {}) {
  return Object.entries(TOOL_SCHEMAS)
    .filter(([id]) => writable || !TOOLS[id].write)
    .map(([id, schema]) => ({
      type: "function",
      function: {
        name: id,
        description: `${TOOLS[id].title}：${schema.description}`,
        parameters: schema.parameters,
      },
    }));
}

async function executeToolCall({ tool, args }, ctx) {
  const definition = TOOLS[tool];
  if (!definition) throw new TypeError("没有这个工具");
  if (definition.write && !ctx.writable) throw new Error("这个工作区只读，kaii 不会改动任何文件");
  const started = Date.now();
  const result = await definition.run(args, ctx);
  const modelOutput = truncateToUtf8Bytes(result.modelText ?? "", ctx.maxModelBytes ?? MAX_MODEL_OUTPUT_BYTES);
  const detailOutput = truncateToUtf8Bytes(result.detail ?? result.modelText ?? "", MAX_DETAIL_BYTES);
  return {
    ok: true,
    tool,
    summary: result.summary ?? "完成",
    modelText: modelOutput.truncated ? `${modelOutput.text}\n…（输出过长，已截断）` : modelOutput.text,
    detail: detailOutput.text,
    changedPath: result.changedPath ?? null,
    snapshotPath: result.snapshotPath ?? null,
    meta: result.meta ?? {},
    durationMs: Date.now() - started,
  };
}

module.exports = {
  ALLOWED_COMMANDS,
  MAX_MODEL_OUTPUT_BYTES,
  TOOLS,
  TOOL_SCHEMAS,
  abortAndWaitForActiveCommands,
  describeNearest,
  executeToolCall,
  toolDefinitions,
  lineNumberedGuidance,
  listTools,
  locateAnchor,
  previewToolCall,
  resolveCommandBinary,
  rollbackSnapshot,
  verifySyntaxAfterWrite,
  runAllowedCommand,
  snapshotWorkspaceForRun,
  snapshotRoot,
  truncateToUtf8Bytes,
  validateToolCall,
};
