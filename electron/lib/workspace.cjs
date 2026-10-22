const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_WORKSPACES = 8;
const MAX_PATH_LENGTH = 4096;
const MAX_RELATIVE_LENGTH = 1024;
const MAX_READ_BYTES = 120_000;
const MAX_DIR_ENTRIES = 400;
const MAX_INDEX_FILES = 1200;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

const IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".cache", ".next", ".nuxt", ".turbo", ".parcel-cache",
  "node_modules", "bower_components", "vendor", "dist", "build", "out", "release", "target",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "venv", ".venv", "env",
  "DerivedData", "Pods", "Carthage", ".gradle", ".terraform", "coverage", ".DS_Store",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".ico", ".icns",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
  ".mp3", ".wav", ".flac", ".aac", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".class", ".pyc", ".wasm",
  ".sqlite", ".sqlite3", ".db", ".gguf", ".safetensors", ".pt", ".bin.gz", ".asar",
]);

function normalizeAbsolute(candidate, label) {
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || candidate.length > MAX_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(candidate)
    || !path.isAbsolute(candidate)
  ) {
    throw new TypeError(`${label}不是有效的绝对路径`);
  }
  return path.resolve(candidate);
}

function forbiddenRoots(userDataPath) {
  const home = os.homedir();
  const roots = [
    "/", "/System", "/Library", "/private", "/etc", "/var", "/usr", "/bin", "/sbin", "/opt", "/Applications", "/Volumes",
    home,
    path.join(home, "Library"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".config"),
  ];
  if (userDataPath) roots.push(path.resolve(userDataPath));
  return roots.map((item) => path.resolve(item));
}

function overlapsUserData(directory, userDataPath) {
  if (!userDataPath) return false;
  const normalizeForComparison = (value) => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  const resolved = normalizeForComparison(directory);
  const userData = normalizeForComparison(userDataPath);
  return resolved === userData
    || resolved.startsWith(`${userData}${path.sep}`)
    || userData.startsWith(`${resolved}${path.sep}`);
}

function assertGrantableDirectory(directory, userDataPath) {
  const resolved = normalizeAbsolute(directory, "工作区目录");
  for (const forbidden of forbiddenRoots(userDataPath)) {
    if (resolved === forbidden) throw new Error(`不能把 ${forbidden} 整个授权给 kaii，请选择具体项目文件夹`);
  }
  if (overlapsUserData(resolved, userDataPath)) {
    throw new Error("不能授权 kaii 自己的数据目录，也不能授权包含它的上层目录");
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error("这个文件夹不存在");
  }
  if (stat.isSymbolicLink()) throw new Error("工作区不能是符号链接");
  if (!stat.isDirectory()) throw new Error("工作区必须是文件夹");
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error("工作区路径包含链接跳转，请直接选择真实目录");
  return resolved;
}

function statePath(userDataPath) {
  return path.join(normalizeAbsolute(userDataPath, "应用数据目录"), "workspaces.json");
}

function readState(userDataPath) {
  const fallback = { schemaVersion: 1, roots: [], activeId: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(userDataPath), "utf8"));
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.roots)) return fallback;
  const roots = parsed.roots.flatMap((root) => {
    if (
      !root
      || typeof root !== "object"
      || typeof root.id !== "string"
      || !/^[0-9a-f-]{36}$/i.test(root.id)
      || typeof root.path !== "string"
      || !path.isAbsolute(root.path)
      || typeof root.label !== "string"
    ) return [];
    const resolved = path.resolve(root.path);
    // 旧版可能已经把 userData 的上层目录存进去。升级后不能继续信任这类历史授权，
    // 否则 read_file 仍然能穿过上层目录读到 credentials.json。
    if (overlapsUserData(resolved, userDataPath)) return [];
    return [{
      id: root.id,
      path: resolved,
      label: root.label.slice(0, 120),
      writable: root.writable === true,
      addedAt: Number.isFinite(root.addedAt) ? root.addedAt : 0,
    }];
  }).slice(0, MAX_WORKSPACES);
  const activeId = roots.some((root) => root.id === parsed.activeId) ? parsed.activeId : (roots[0]?.id ?? null);
  return { schemaVersion: 1, roots, activeId };
}

function writeState(userDataPath, state) {
  const target = statePath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function describeRoot(root) {
  let exists = true;
  try {
    exists = fs.statSync(root.path).isDirectory();
  } catch {
    exists = false;
  }
  return { ...root, exists };
}

function listWorkspaces(userDataPath) {
  const state = readState(userDataPath);
  return { roots: state.roots.map(describeRoot), activeId: state.activeId };
}

function activeWorkspace(userDataPath) {
  const state = readState(userDataPath);
  const root = state.roots.find((item) => item.id === state.activeId);
  return root ? describeRoot(root) : null;
}

function addWorkspace(userDataPath, directory, { writable = false } = {}) {
  if (typeof writable !== "boolean") throw new TypeError("writable无效");
  const resolved = assertGrantableDirectory(directory, userDataPath);
  const state = readState(userDataPath);
  const existing = state.roots.find((root) => root.path === resolved);
  if (existing) {
    existing.writable = existing.writable || writable;
    state.activeId = existing.id;
    writeState(userDataPath, state);
    return listWorkspaces(userDataPath);
  }
  if (state.roots.length >= MAX_WORKSPACES) throw new RangeError(`最多同时授权${MAX_WORKSPACES}个工作区`);
  const root = {
    id: crypto.randomUUID(),
    path: resolved,
    label: path.basename(resolved).slice(0, 120) || resolved,
    writable,
    addedAt: Date.now(),
  };
  state.roots.push(root);
  state.activeId = root.id;
  writeState(userDataPath, state);
  return listWorkspaces(userDataPath);
}

function validateWorkspaceId(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("工作区ID无效");
  return id;
}

function removeWorkspace(userDataPath, id) {
  const workspaceId = validateWorkspaceId(id);
  const state = readState(userDataPath);
  const next = state.roots.filter((root) => root.id !== workspaceId);
  if (next.length === state.roots.length) throw new Error("工作区不存在");
  state.roots = next;
  if (state.activeId === workspaceId) state.activeId = next[0]?.id ?? null;
  writeState(userDataPath, state);
  return listWorkspaces(userDataPath);
}

function setWorkspaceWritable(userDataPath, id, writable) {
  const workspaceId = validateWorkspaceId(id);
  if (typeof writable !== "boolean") throw new TypeError("writable无效");
  const state = readState(userDataPath);
  const root = state.roots.find((item) => item.id === workspaceId);
  if (!root) throw new Error("工作区不存在");
  root.writable = writable;
  writeState(userDataPath, state);
  return listWorkspaces(userDataPath);
}

function setActiveWorkspace(userDataPath, id) {
  if (id === null) {
    const state = readState(userDataPath);
    state.activeId = null;
    writeState(userDataPath, state);
    return listWorkspaces(userDataPath);
  }
  const workspaceId = validateWorkspaceId(id);
  const state = readState(userDataPath);
  if (!state.roots.some((root) => root.id === workspaceId)) throw new Error("工作区不存在");
  state.activeId = workspaceId;
  writeState(userDataPath, state);
  return listWorkspaces(userDataPath);
}

function normalizeRelative(relativePath) {
  if (relativePath === undefined || relativePath === null || relativePath === "") return ".";
  if (typeof relativePath !== "string" || relativePath.length > MAX_RELATIVE_LENGTH || /[\u0000-\u001f\u007f]/.test(relativePath)) {
    throw new TypeError("路径无效");
  }
  if (path.isAbsolute(relativePath)) throw new Error("只能使用工作区内的相对路径");
  const normalized = path.normalize(relativePath).replace(/^\.\/+/, "");
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("路径越出工作区");
  return normalized === "" ? "." : normalized;
}

function resolveInWorkspace(rootPath, relativePath, { mustExist = true } = {}) {
  const root = normalizeAbsolute(rootPath, "工作区根目录");
  const relative = normalizeRelative(relativePath);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("路径越出工作区");
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    if (mustExist) throw new Error("这个路径不存在");
    // 目标还不存在时，向上找到最近一个真实存在的祖先目录，把它 realpath 之后再拼回剩下的层级，
    // 这样既支持新建多级目录，也不会让链接把路径带出工作区。
    const missing = [];
    let ancestor = target;
    let ancestorReal = null;
    while (ancestor !== path.dirname(ancestor)) {
      if (ancestor.length < root.length) throw new Error("路径越出工作区");
      try {
        ancestorReal = fs.realpathSync(ancestor);
        break;
      } catch {
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    if (!ancestorReal) throw new Error("路径越出工作区");
    if (ancestorReal !== root && !ancestorReal.startsWith(`${root}${path.sep}`)) throw new Error("路径越出工作区");
    const absolute = path.join(ancestorReal, ...missing);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("路径越出工作区");
    return { root, relative: path.relative(root, absolute), absolute, exists: false };
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error("路径通过链接越出工作区");
  return { root, relative: real === root ? "." : path.relative(root, real), absolute: real, exists: true };
}

function isIgnoredName(name, isDirectory) {
  if (name.startsWith(".") && name !== ".gitignore" && name !== ".env.example") {
    if (isDirectory) return true;
    if (![".gitignore", ".editorconfig", ".prettierrc", ".eslintrc"].includes(name)) return true;
  }
  return isDirectory && IGNORED_DIRECTORIES.has(name);
}

function looksBinary(absolutePath) {
  if (BINARY_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) return true;
  let handle;
  try {
    handle = fs.openSync(absolutePath, "r");
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
    const read = fs.readSync(handle, buffer, 0, BINARY_PROBE_BYTES, 0);
    return buffer.subarray(0, read).includes(0);
  } catch {
    return true;
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch {}
  }
}

function listDirectory(rootPath, relativePath = ".", { limit = MAX_DIR_ENTRIES } = {}) {
  const target = resolveInWorkspace(rootPath, relativePath);
  const stat = fs.statSync(target.absolute);
  if (!stat.isDirectory()) throw new Error("这不是文件夹");
  const entries = fs.readdirSync(target.absolute, { withFileTypes: true });
  const visible = [];
  let ignored = 0;
  for (const entry of entries) {
    const isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink() || isIgnoredName(entry.name, isDirectory)) {
      ignored += 1;
      continue;
    }
    let size = 0;
    if (!isDirectory) {
      try { size = fs.statSync(path.join(target.absolute, entry.name)).size; } catch { size = 0; }
    }
    visible.push({
      name: entry.name,
      path: target.relative === "." ? entry.name : `${target.relative}/${entry.name}`,
      kind: isDirectory ? "dir" : "file",
      size,
    });
  }
  visible.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "dir" ? -1 : 1));
  return {
    path: target.relative,
    entries: visible.slice(0, limit),
    truncated: visible.length > limit,
    ignored,
  };
}

function walkFiles(rootPath, { maxFiles = MAX_INDEX_FILES, maxDepth = 12 } = {}) {
  const root = normalizeAbsolute(rootPath, "工作区根目录");
  const files = [];
  let truncated = false;
  const queue = [{ absolute: root, relative: "", depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (current.depth > maxDepth) continue;
    let entries;
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return { root, files, truncated };
      }
      const isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink() || isIgnoredName(entry.name, isDirectory)) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (isDirectory) {
        queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(absolute).size; } catch { continue; }
      files.push({ path: relative, size, extension: path.extname(entry.name).toLowerCase() });
    }
  }
  return { root, files, truncated };
}

function summarizeWorkspace(rootPath, { maxFiles = MAX_INDEX_FILES, maxListed = 60 } = {}) {
  const { files, truncated } = walkFiles(rootPath, { maxFiles });
  const byExtension = new Map();
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    const key = file.extension || "(无扩展名)";
    byExtension.set(key, (byExtension.get(key) || 0) + 1);
  }
  const topExtensions = [...byExtension.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([extension, count]) => ({ extension, count }));
  const interesting = files
    .filter((file) => file.path.split("/").length <= 2)
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
    .slice(0, maxListed)
    .map((file) => file.path);
  return { fileCount: files.length, truncated, totalBytes, topExtensions, topLevelFiles: interesting };
}

// 路径写错时，与其只回一句"不存在"，不如把工作区里最像的几个路径摆出来。
// 小模型经常只是把目录层级猜错一层，看到真实路径就能自己纠正。
function suggestPaths(rootPath, wanted, { limit = 5 } = {}) {
  const needle = String(wanted || "").toLowerCase();
  const base = needle.split("/").pop() || needle;
  if (!base) return [];
  const { files } = walkFiles(rootPath, { maxFiles: 600 });
  const scored = files.map((file) => {
    const lower = file.path.toLowerCase();
    const fileBase = lower.split("/").pop();
    let score = 0;
    if (lower === needle) score = 100;
    else if (fileBase === base) score = 60;
    else if (fileBase.includes(base) || base.includes(fileBase)) score = 30;
    else if (lower.includes(base)) score = 10;
    return { path: file.path, score };
  }).filter((item) => item.score > 0);
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((item) => item.path);
}

function readTextFile(rootPath, relativePath, { maxBytes = MAX_READ_BYTES, startLine = 1, lineCount = 0 } = {}) {
  const target = resolveInWorkspace(rootPath, relativePath);
  const stat = fs.statSync(target.absolute);
  if (!stat.isFile()) throw new Error("这不是文件");
  if (looksBinary(target.absolute)) throw new Error("这是二进制文件，kaii 不读取它的内容");
  if (!Number.isInteger(startLine) || startLine < 1) throw new TypeError("startLine无效");
  if (!Number.isInteger(lineCount) || lineCount < 0 || lineCount > 20_000) throw new TypeError("lineCount无效");
  const raw = fs.readFileSync(target.absolute);
  const truncatedByBytes = raw.length > maxBytes;
  const text = raw.subarray(0, maxBytes).toString("utf8");
  const allLines = text.split("\n");
  const totalLines = allLines.length;
  const from = Math.min(startLine, totalLines);
  const slice = lineCount > 0 ? allLines.slice(from - 1, from - 1 + lineCount) : allLines.slice(from - 1);
  return {
    path: target.relative,
    bytes: stat.size,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    startLine: from,
    endLine: from + slice.length - 1,
    totalLines,
    truncated: truncatedByBytes || slice.length < totalLines - (from - 1),
    content: slice.join("\n"),
  };
}

function compileSearchPattern(query, { regex = false, caseSensitive = false }) {
  if (typeof query !== "string" || !query.trim() || query.length > 400) throw new RangeError("搜索词长度无效");
  const flags = caseSensitive ? "g" : "gi";
  if (!regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  try {
    return new RegExp(query, flags);
  } catch {
    throw new TypeError("正则表达式无效");
  }
}

// Glob 先把 ** / * / ? 换成不可能出现在路径里的占位符，再一次性展开成正则，
// 避免后一步替换误伤前一步刚写进去的正则语法。
const GLOB_TOKENS = Object.freeze([
  { placeholder: String.fromCharCode(1), glob: "**/", regex: "(?:[^/]*/)*" },
  { placeholder: String.fromCharCode(2), glob: "**", regex: ".*" },
  { placeholder: String.fromCharCode(3), glob: "*", regex: "[^/]*" },
  { placeholder: String.fromCharCode(4), glob: "?", regex: "[^/]" },
]);

function matchesGlob(relativePath, glob) {
  if (!glob) return true;
  let pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  for (const token of GLOB_TOKENS) pattern = pattern.replaceAll(token.glob, token.placeholder);
  for (const token of GLOB_TOKENS) pattern = pattern.replaceAll(token.placeholder, token.regex);
  return new RegExp(`^${pattern}$`).test(relativePath);
}

function searchText(rootPath, { query, glob = "", regex = false, caseSensitive = false, maxMatches = MAX_SEARCH_MATCHES } = {}) {
  if (typeof glob !== "string" || glob.length > 200) throw new TypeError("glob无效");
  if (typeof regex !== "boolean" || typeof caseSensitive !== "boolean") throw new TypeError("搜索选项无效");
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_SEARCH_MATCHES) throw new TypeError("maxMatches无效");
  const pattern = compileSearchPattern(query, { regex, caseSensitive });
  const { root, files } = walkFiles(rootPath);
  const matches = [];
  let scanned = 0;
  let truncated = false;
  for (const file of files) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    if (!matchesGlob(file.path, glob)) continue;
    if (file.size > MAX_SEARCH_FILE_BYTES) continue;
    const absolute = path.join(root, file.path);
    if (looksBinary(absolute)) continue;
    let content;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      pattern.lastIndex = 0;
      if (!pattern.test(lines[index])) continue;
      matches.push({
        path: file.path,
        line: index + 1,
        text: lines[index].trim().slice(0, 300),
      });
    }
  }
  return { matches, scannedFiles: scanned, truncated };
}

module.exports = {
  BINARY_EXTENSIONS,
  IGNORED_DIRECTORIES,
  MAX_READ_BYTES,
  MAX_WORKSPACES,
  activeWorkspace,
  addWorkspace,
  assertGrantableDirectory,
  listDirectory,
  listWorkspaces,
  looksBinary,
  matchesGlob,
  normalizeRelative,
  readTextFile,
  removeWorkspace,
  resolveInWorkspace,
  searchText,
  setActiveWorkspace,
  suggestPaths,
  setWorkspaceWritable,
  summarizeWorkspace,
  walkFiles,
};
