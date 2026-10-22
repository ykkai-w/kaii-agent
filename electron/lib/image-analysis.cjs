const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_HELPER_OUTPUT = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".tif", ".tiff"]);

function imageDirectory(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("图片目录无效");
  return path.join(userDataPath, "images");
}

function validateImageId(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError("图片ID无效");
  return id;
}

function validateImageInput(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new TypeError("图片路径无效");
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("只支持 PNG、JPEG、HEIC、WebP 和 TIFF 图片");
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("图片必须是普通文件");
  if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new RangeError("图片大小必须小于20MB");
  return { extension, stat };
}

function runVisionHelper(helperPath, imagePath, { timeoutMs = 20_000, spawnImpl = spawn } = {}) {
  if (typeof helperPath !== "string" || !path.isAbsolute(helperPath)) return Promise.reject(new TypeError("识图程序路径无效"));
  const helperStat = fs.statSync(helperPath);
  if (!helperStat.isFile()) return Promise.reject(new Error("本机识图程序不存在"));
  fs.accessSync(helperPath, fs.constants.X_OK);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(helperPath, [imagePath], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("本机识图超时"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_HELPER_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error("本机识图输出过大"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(0, 4096);
    });
    child.once("error", (error) => finish(new Error(`本机识图启动失败：${error.message}`)));
    child.once("exit", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout.toString("utf8"));
      } catch {
        finish(new Error("本机识图返回了无效结果"));
        return;
      }
      if (code !== 0 || !parsed?.ok) {
        const detail = parsed?.error?.message || stderr.toString("utf8").trim() || "本机识图失败";
        finish(new Error(detail));
        return;
      }
      finish(null, parsed);
    });
  });
}

function validateAnalysis(result) {
  if (!result || result.ok !== true || !Number.isInteger(result.width) || !Number.isInteger(result.height)) {
    throw new Error("本机识图结果结构无效");
  }
  if (result.width < 1 || result.height < 1 || result.width * result.height > MAX_IMAGE_PIXELS) {
    throw new RangeError("图片像素尺寸超出限制");
  }
  const ocrText = typeof result.ocr?.text === "string" ? result.ocr.text.slice(0, 20_000) : "";
  const classifications = Array.isArray(result.classifications)
    ? result.classifications.slice(0, 15).flatMap((item) => (
      item && typeof item.label === "string" && Number.isFinite(item.confidence)
        ? [{ label: item.label.slice(0, 160), confidence: Math.max(0, Math.min(1, item.confidence)) }]
        : []
    ))
    : [];
  return { width: result.width, height: result.height, ocrText, classifications };
}

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

async function analyzeAndStoreImage({ filePath, userDataPath, helperPath, nativeImage, spawnImpl }) {
  const { extension } = validateImageInput(filePath);
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") throw new Error("图片预览组件不可用");
  const image = nativeImage.createFromPath(filePath);
  if (!image || image.isEmpty()) throw new Error("无法读取这张图片");
  const size = image.getSize();
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new RangeError("图片像素尺寸超出限制");
  }
  const directory = imageDirectory(userDataPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const id = crypto.randomUUID();
  const storedImage = path.join(directory, `${id}${extension}`);
  const recordPath = path.join(directory, `${id}.json`);
  fs.copyFileSync(filePath, storedImage, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(storedImage, 0o600);
  try {
    const raw = await runVisionHelper(helperPath, storedImage, { spawnImpl });
    const analysis = validateAnalysis(raw);
    const scale = Math.min(1, 480 / Math.max(size.width, size.height));
    const preview = scale < 1
      ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" })
      : image;
    const previewDataUrl = `data:image/jpeg;base64,${preview.toJPEG(76).toString("base64")}`;
    const record = {
      schemaVersion: 1,
      id,
      name: path.basename(filePath).slice(0, 240),
      extension,
      storedImage,
      createdAt: Date.now(),
      ...analysis,
    };
    writeJsonAtomic(recordPath, record);
    const labelText = analysis.classifications.slice(0, 4).map((item) => item.label).join("、");
    return {
      id,
      name: record.name,
      previewDataUrl,
      width: analysis.width,
      height: analysis.height,
      ocrPreview: analysis.ocrText.slice(0, 180),
      labelPreview: labelText,
    };
  } catch (error) {
    try { fs.unlinkSync(storedImage); } catch {}
    try { fs.unlinkSync(recordPath); } catch {}
    throw error;
  }
}

function loadImageRecord(userDataPath, id) {
  const safeId = validateImageId(id);
  const target = path.join(imageDirectory(userDataPath), `${safeId}.json`);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || parsed.id !== safeId) throw new Error("图片识别记录无效");
  return parsed;
}

function imageFilesFor(userDataPath, id) {
  const safeId = validateImageId(id);
  const directory = imageDirectory(userDataPath);
  const files = [path.join(directory, `${safeId}.json`)];
  for (const extension of ALLOWED_EXTENSIONS) files.push(path.join(directory, `${safeId}${extension}`));
  return files;
}

function discardImage(userDataPath, id) {
  let removed = 0;
  for (const target of imageFilesFor(userDataPath, id)) {
    try {
      fs.unlinkSync(target);
      removed += 1;
    } catch {}
  }
  return { ok: true, id, removed };
}

function listStoredImageIds(userDataPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(imageDirectory(userDataPath), { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const base = entry.name.slice(0, entry.name.length - path.extname(entry.name).length);
    if (/^[0-9a-f-]{36}$/i.test(base)) ids.add(base);
  }
  return [...ids];
}

function pruneOrphanImages(userDataPath, referencedIds = [], { graceMs = 10 * 60_000, now = Date.now() } = {}) {
  if (!Array.isArray(referencedIds)) throw new TypeError("引用图片列表无效");
  const keep = new Set();
  for (const id of referencedIds) {
    if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) keep.add(id.toLowerCase());
  }
  const removedIds = [];
  for (const id of listStoredImageIds(userDataPath)) {
    if (keep.has(id.toLowerCase())) continue;
    let youngest = 0;
    for (const target of imageFilesFor(userDataPath, id)) {
      try {
        youngest = Math.max(youngest, fs.statSync(target).mtimeMs);
      } catch {}
    }
    if (youngest && now - youngest < graceMs) continue;
    discardImage(userDataPath, id);
    removedIds.push(id);
  }
  return { ok: true, removed: removedIds.length, removedIds };
}

function formatImageContext(record) {
  const labels = Array.isArray(record.classifications)
    ? record.classifications.slice(0, 10).map((item) => `${item.label}(${Math.round(item.confidence * 100)}%)`).join("、")
    : "";
  const ocr = typeof record.ocrText === "string" && record.ocrText.trim() ? record.ocrText.trim() : "未识别出文字";
  return [
    `[本机图片分析：${record.name}]`,
    `尺寸：${record.width}×${record.height}`,
    `通用画面标签：${labels || "无可靠标签"}`,
    `OCR文字：\n${ocr}`,
    "说明：以上来自 macOS Vision 的本机 OCR 与通用分类，不是多模态大模型对像素的完整理解。",
  ].join("\n");
}

const MAX_VISION_EDGE = 1400;
const MAX_VISION_BYTES = 4 * 1024 * 1024;

// 把存下来的原图做成可以直接发给多模态模型的 data URL。
// 缩到 1400 边长再压 JPEG：模型看图不需要原始分辨率，
// 而一张手机照片直接 base64 能有十几兆，白白拖慢一轮还可能被对方拒收。
function buildVisionImage(userDataPath, id, nativeImage) {
  const record = loadImageRecord(userDataPath, id);
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") throw new Error("图片组件不可用");
  const image = nativeImage.createFromPath(record.storedImage);
  if (!image || image.isEmpty()) throw new Error("这张图片读不出来");

  const size = image.getSize();
  const scale = Math.min(1, MAX_VISION_EDGE / Math.max(size.width, size.height));
  const prepared = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "good",
    })
    : image;

  let quality = 82;
  let buffer = prepared.toJPEG(quality);
  // 还是太大就再降两档质量，不再动尺寸——尺寸降太多会把图里的字糊掉。
  while (buffer.length > MAX_VISION_BYTES && quality > 50) {
    quality -= 16;
    buffer = prepared.toJPEG(quality);
  }
  if (buffer.length > MAX_VISION_BYTES) throw new Error("这张图片压缩后仍然太大");

  return {
    dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    name: record.name,
    bytes: buffer.length,
  };
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_VISION_BYTES,
  analyzeAndStoreImage,
  buildVisionImage,
  discardImage,
  formatImageContext,
  imageDirectory,
  imageFilesFor,
  listStoredImageIds,
  loadImageRecord,
  pruneOrphanImages,
  runVisionHelper,
  validateImageInput,
};
