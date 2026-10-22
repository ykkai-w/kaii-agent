const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const documents = require("./document.cjs");

// 本地知识库：授权一个文件夹，把里面的文档全部抽成段落存下来，
// 之后提问时跨文件找相关段落，并且回答里能指出这句话是从哪份文件哪一页来的。
//
// 和"项目常驻资料"的区别是规模：那边是手动挂几份，这边是一整个文件夹几十份。
// 所以索引要落盘、要能增量更新、要能看见进度，不能每次提问现读。

const MAX_LIBRARIES = 6;
const MAX_FILES_PER_LIBRARY = 400;
const MAX_INDEX_CHARACTERS = 4_000_000;
const MAX_DEPTH = 6;
const DEFAULT_CONTEXT_BYTES = 6000;

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".svn", "dist", "build", "target", "__pycache__",
  ".venv", "venv", ".next", ".cache", "Library", ".Trash",
]);

function knowledgeRoot(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("知识库目录无效");
  return path.join(userDataPath, "knowledge");
}

function registryPath(userDataPath) {
  return path.join(knowledgeRoot(userDataPath), "libraries.json");
}

function indexPath(userDataPath, libraryId) {
  return path.join(knowledgeRoot(userDataPath), `${libraryId}.json`);
}

function validateLibraryId(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("知识库ID无效");
  return id;
}

function readJson(target, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function listLibraries(userDataPath) {
  const stored = readJson(registryPath(userDataPath), { libraries: [] });
  const libraries = Array.isArray(stored.libraries) ? stored.libraries : [];
  return libraries.flatMap((item) => {
    if (!item || typeof item.id !== "string" || typeof item.path !== "string") return [];
    let exists = false;
    try {
      exists = fs.statSync(item.path).isDirectory();
    } catch {}
    return [{
      id: item.id,
      path: item.path,
      label: item.label || path.basename(item.path),
      enabled: item.enabled !== false,
      excludes: Array.isArray(item.excludes)
        ? item.excludes.filter((name) => typeof name === "string" && name.trim()).slice(0, 20)
        : [],
      fileCount: Number.isFinite(item.fileCount) ? item.fileCount : 0,
      sectionCount: Number.isFinite(item.sectionCount) ? item.sectionCount : 0,
      characters: Number.isFinite(item.characters) ? item.characters : 0,
      indexedAt: Number.isFinite(item.indexedAt) ? item.indexedAt : 0,
      skipped: Array.isArray(item.skipped) ? item.skipped : [],
      exists,
    }];
  });
}

function saveLibraries(userDataPath, libraries) {
  writeJsonAtomic(registryPath(userDataPath), { schemaVersion: 1, libraries });
  return listLibraries(userDataPath);
}

function addLibrary(userDataPath, folderPath) {
  if (typeof folderPath !== "string" || !path.isAbsolute(folderPath)) throw new TypeError("文件夹路径无效");
  const resolved = fs.realpathSync(folderPath);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("这不是一个文件夹");

  const existing = listLibraries(userDataPath);
  if (existing.some((item) => item.path === resolved)) throw new Error("这个文件夹已经加过了");
  if (existing.length >= MAX_LIBRARIES) throw new RangeError(`最多同时用 ${MAX_LIBRARIES} 个知识库`);

  const library = {
    id: crypto.randomUUID(),
    path: resolved,
    label: path.basename(resolved),
    enabled: true,
    excludes: [],
    fileCount: 0,
    sectionCount: 0,
    characters: 0,
    indexedAt: 0,
    skipped: [],
  };
  saveLibraries(userDataPath, [...existing.map(stripRuntime), library]);
  // 返回的必须和列表里的同一个形状，否则调用方拿到的对象少字段（比如 exists）。
  const libraries = listLibraries(userDataPath);
  return { library: libraries.find((item) => item.id === library.id), libraries };
}

function stripRuntime(item) {
  const { exists, ...rest } = item;
  void exists;
  return rest;
}

function removeLibrary(userDataPath, libraryId) {
  const id = validateLibraryId(libraryId);
  const remaining = listLibraries(userDataPath).filter((item) => item.id !== id);
  try {
    fs.unlinkSync(indexPath(userDataPath, id));
  } catch {}
  return saveLibraries(userDataPath, remaining.map(stripRuntime));
}

function setLibraryEnabled(userDataPath, libraryId, enabled) {
  const id = validateLibraryId(libraryId);
  if (typeof enabled !== "boolean") throw new TypeError("enabled无效");
  const libraries = listLibraries(userDataPath).map((item) => (item.id === id ? { ...item, enabled } : item));
  return saveLibraries(userDataPath, libraries.map(stripRuntime));
}

// 每个库自己的排除规则：按目录名或文件名片段跳过。
// 场景：资料文件夹里混着一个「草稿」子目录不想被搜到。
// 只做包含匹配，不做通配符——通配符要先学才会用，目录名人人都会写。
function setLibraryExcludes(userDataPath, libraryId, excludes) {
  const id = validateLibraryId(libraryId);
  if (!Array.isArray(excludes)) throw new TypeError("excludes无效");
  const cleaned = excludes
    .map((name) => String(name).trim())
    .filter((name) => name && name.length <= 60 && !name.includes("/"))
    .slice(0, 20);
  const libraries = listLibraries(userDataPath).map((item) => (
    item.id === id ? { ...item, excludes: cleaned } : item
  ));
  return saveLibraries(userDataPath, libraries.map(stripRuntime));
}

// 索引是不是旧的：文件夹里有没有比 indexedAt 更新的文件。
// 只抽查前 200 个，全走一遍的话大文件夹每次列个清单都要几秒。
function isIndexStale(library) {
  if (!library.indexedAt || !library.exists) return false;
  try {
    const files = collectFiles(library.path, { maxFiles: 200, excludes: library.excludes });
    return files.files.some((file) => file.mtimeMs > library.indexedAt);
  } catch {
    return false;
  }
}

// 走一遍文件夹，只收能读的文档类型。跳过依赖目录和隐藏目录，
// 否则一个前端项目能扫出几万个文件，全是噪音。
function collectFiles(rootPath, { maxFiles = MAX_FILES_PER_LIBRARY, excludes = [] } = {}) {
  const excludeList = excludes.filter(Boolean);
  const isExcluded = (name) => excludeList.some((pattern) => name.includes(pattern));
  const supported = new Set(documents.supportedExtensions().map((extension) => `.${extension}`));
  const found = [];
  let truncated = false;

  const walk = (directory, depth) => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      if (isExcluded(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!supported.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        continue;
      }
      if (stat.size < 1 || stat.size > documents.MAX_DOCUMENT_BYTES) continue;
      found.push({ path: target, size: stat.size, mtimeMs: stat.mtimeMs });
      if (found.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  walk(rootPath, 0);
  return { files: found, truncated };
}

// 建索引。已经索引过且没改动过的文件直接复用，改过的重抽。
// 一份读不出来（扫描版 PDF、加密文档）不该让整次重建失败，记下来跳过就是了。
async function buildIndex(userDataPath, libraryId, { helperPath, onProgress = null } = {}) {
  const id = validateLibraryId(libraryId);
  const library = listLibraries(userDataPath).find((item) => item.id === id);
  if (!library) throw new Error("这个知识库不存在");
  if (!library.exists) throw new Error("这个文件夹已经找不到了");

  const previous = readJson(indexPath(userDataPath, id), { files: {} });
  const previousFiles = previous.files && typeof previous.files === "object" ? previous.files : {};

  const { files, truncated } = collectFiles(library.path, { excludes: library.excludes });
  const nextFiles = {};
  const skipped = [];
  let characters = 0;
  let sectionCount = 0;

  for (const [index, file] of files.entries()) {
    if (onProgress) onProgress({ done: index, total: files.length, current: path.basename(file.path) });
    const relative = path.relative(library.path, file.path);
    const cached = previousFiles[relative];
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
      nextFiles[relative] = cached;
      characters += cached.characters || 0;
      sectionCount += cached.sections?.length || 0;
      continue;
    }
    if (characters >= MAX_INDEX_CHARACTERS) {
      skipped.push({ path: relative, reason: "索引已经装满" });
      continue;
    }
    try {
      const extracted = await documents.extractAndStoreDocument({
        filePath: file.path,
        userDataPath,
        helperPath,
      });
      const record = documents.loadDocumentRecord(userDataPath, extracted.id);
      // 段落存进索引后就不需要那份独立的文档记录了，删掉免得越堆越多。
      documents.discardDocument(userDataPath, extracted.id);
      // 内容里有长得像私钥/API key 的东西就不进索引。
      // 索引会整段被送进模型（本机或云端），密钥不该出现在那条路上。
      const sensitive = record.sections.some((section) =>
        /-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}/.test(section.text));
      if (sensitive) {
        skipped.push({ path: relative, reason: "内容里有像密钥的东西，为安全跳过了" });
        continue;
      }
      nextFiles[relative] = {
        name: record.name,
        kind: record.kind,
        pageCount: record.pageCount,
        characters: record.characters,
        mtimeMs: file.mtimeMs,
        size: file.size,
        sections: record.sections,
      };
      characters += record.characters;
      sectionCount += record.sections.length;
    } catch (error) {
      skipped.push({ path: relative, reason: error?.message || "读不出来" });
    }
  }

  writeJsonAtomic(indexPath(userDataPath, id), { schemaVersion: 1, files: nextFiles });
  const libraries = listLibraries(userDataPath).map((item) => (item.id === id
    ? {
      ...stripRuntime(item),
      fileCount: Object.keys(nextFiles).length,
      sectionCount,
      characters,
      indexedAt: Date.now(),
      skipped: skipped.slice(0, 40),
    }
    : stripRuntime(item)));
  saveLibraries(userDataPath, libraries);

  return {
    fileCount: Object.keys(nextFiles).length,
    sectionCount,
    characters,
    skipped,
    truncated,
    libraries: listLibraries(userDataPath),
  };
}

function questionGrams(text) {
  const normalized = String(text || "").toLocaleLowerCase("zh-CN");
  const values = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) || []);
  const compact = normalized.replace(/\s+/g, "");
  for (let index = 0; index < compact.length - 1; index += 1) {
    const gram = compact.slice(index, index + 2);
    if (/^[\p{L}\p{N}]{2}$/u.test(gram)) values.add(gram);
  }
  return values;
}

// 跨所有启用的知识库找相关段落。命中要带出处：哪个库、哪份文件、第几页。
function searchKnowledge(userDataPath, question, { maxBytes = DEFAULT_CONTEXT_BYTES, maxPerFile = 2 } = {}) {
  const grams = questionGrams(question);
  if (!grams.size) return { text: "", citations: [] };

  const candidates = [];
  for (const library of listLibraries(userDataPath)) {
    if (!library.enabled || !library.exists) continue;
    const index = readJson(indexPath(userDataPath, library.id), { files: {} });
    for (const [relative, file] of Object.entries(index.files || {})) {
      if (!Array.isArray(file?.sections)) continue;
      file.sections.forEach((section, position) => {
        const haystack = String(section.text).toLocaleLowerCase("zh-CN");
        let score = 0;
        for (const gram of grams) {
          if (!haystack.includes(gram)) continue;
          score += gram.length >= 3 ? 4 : 1;
        }
        if (score <= 0) return;
        candidates.push({ library, relative, file, section, position, score });
      });
    }
  }
  if (!candidates.length) return { text: "", citations: [] };

  candidates.sort((a, b) => b.score - a.score);
  const perFile = new Map();
  const picked = [];
  let bytes = 0;
  for (const item of candidates) {
    const key = `${item.library.id}:${item.relative}`;
    const taken = perFile.get(key) || 0;
    if (taken >= maxPerFile) continue;
    const cost = Buffer.byteLength(item.section.text, "utf8") + 80;
    if (bytes + cost > maxBytes) continue;
    perFile.set(key, taken + 1);
    picked.push(item);
    bytes += cost;
  }
  if (!picked.length) return { text: "", citations: [] };

  const citations = picked.map((item, index) => ({
    index: index + 1,
    library: item.library.label,
    file: item.relative,
    absolutePath: path.join(item.library.path, item.relative),
    label: item.section.label,
    // 摘录给「检索预览」用：让人看见真的会被送出去的是哪几段文字。
    excerpt: String(item.section.text).replace(/\s+/g, " ").slice(0, 160),
    score: item.score,
  }));

  const blocks = picked.map((item, index) => (
    `[${index + 1}] ${item.relative} · ${item.section.label}\n${item.section.text}`
  ));

  return {
    text: [
      "从你的知识库里按这次的问题找到这些段落：",
      "",
      blocks.join("\n\n"),
      "",
      "回答时用 [序号] 标出你用了哪一条。找不到答案就说知识库里没有，不要靠印象补。",
    ].join("\n"),
    citations,
  };
}

module.exports = {
  DEFAULT_CONTEXT_BYTES,
  MAX_FILES_PER_LIBRARY,
  MAX_LIBRARIES,
  addLibrary,
  buildIndex,
  collectFiles,
  indexPath,
  knowledgeRoot,
  listLibraries,
  registryPath,
  removeLibrary,
  searchKnowledge,
  isIndexStale,
  setLibraryEnabled,
  setLibraryExcludes,
  validateLibraryId,
};
