const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const asar = require("@electron/asar");

const ROOT = path.resolve(__dirname, "../..");
const DIST = path.join(ROOT, "dist");
const INPUT_FILES = [
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
];

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function currentBuildInputs() {
  const candidates = [
    ...INPUT_FILES.map((name) => path.join(ROOT, name)),
    ...filesUnder(path.join(ROOT, "src")),
    ...filesUnder(path.join(ROOT, "public")),
  ];
  const files = {};
  for (const absolute of candidates.filter(fs.existsSync).sort()) {
    files[path.relative(ROOT, absolute).split(path.sep).join("/")] = sha256(absolute);
  }
  return files;
}

test("test:main 自动发现公开应用的主进程测试，研究模块单独保留", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const command = String(pkg.scripts?.["test:main"] || "");
  assert.equal(command, "node scripts/test-main.cjs");
  const runner = fs.readFileSync(path.join(ROOT, "scripts/test-main.cjs"), "utf8");
  assert.match(runner, /"--test", "--test-concurrency=1"/, "主进程测试必须串行");
  const listing = spawnSync(process.execPath, ["scripts/test-main.cjs", "--list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const discovered = fs.readdirSync(path.join(ROOT, "tests", "electron"))
    .filter((file) => file.endsWith(".test.cjs") && !/dmrml/i.test(file))
    .sort().map((file) => `tests/electron/${file}`);
  assert.ok(discovered.length > 0, "tests/electron 下没有发现主进程测试");
  assert.deepEqual(JSON.parse(listing.stdout), discovered);
  assert.ok(pkg.build.files.includes("!electron/lib/dmr*"));
});

test("dist 带着可复算的当前源码指纹，不靠 mtime 猜是否新鲜", () => {
  const manifestPath = path.join(DIST, "build-inputs.sha256.json");
  assert.ok(fs.existsSync(manifestPath), "构建没有产生输入指纹");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.files, currentBuildInputs(), "dist 不是由当前 src/public/config/package 生成的");
  assert.ok(Object.keys(manifest.files).length >= 20, "指纹清单异常地空");
});

test("KaTeX 的真实构建产物只有 woff2，单文档导出用的字体已内联", () => {
  const assets = filesUnder(path.join(DIST, "assets"));
  const oldFonts = assets.filter((file) => /\.(?:woff|ttf)$/i.test(file));
  const woff2 = assets.filter((file) => /\.woff2$/i.test(file));
  assert.deepEqual(oldFonts, [], `仍打包了无用字体：${oldFonts.map(path.basename).join(", ")}`);
  // Size3 的 woff2 小于 Vite 默认 4K 阈值，会直接进主 CSS；
  // 其余 19 个是独立文件。验的是最终引用总数，不把“文件数”误当完整性。
  const styles = assets.filter((file) => /\.css$/i.test(file)).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const cssEmbeddedWoff2 = styles.match(/data:font\/woff2;base64,/g) || [];
  assert.equal(woff2.length + cssEmbeddedWoff2.length, 20);

  const javascript = assets.filter((file) => /\.js$/i.test(file)).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const embedded = javascript.match(/data:font\/woff2;base64,/g) || [];
  assert.equal(embedded.length, 20, `导出样式本应内联 20 个字体，实际 ${embedded.length}`);

  assert.equal(/url\([^)]*\.(?:woff|ttf)(?:[?#)]|$)/i.test(styles), false, "CSS 仍引用 woff/ttf");
});

test("electron-builder 合同包含三个原生 helper，且当前二进制真的可执行", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const resources = new Map((pkg.build.extraResources || []).map((item) => [item.to, item.from]));
  for (const helper of ["kaii-vision", "kaii-doc", "kaii-speech"]) {
    assert.equal(resources.get(`bin/${helper}`), `resources/bin/${helper}`, `${helper} 没进 extraResources`);
    const binary = path.join(ROOT, "resources", "bin", helper);
    const source = path.join(ROOT, "native", `${helper}.swift`);
    assert.ok(fs.existsSync(binary), `${helper} 不存在`);
    fs.accessSync(binary, fs.constants.X_OK);
    const magic = fs.readFileSync(binary).subarray(0, 4).toString("hex");
    assert.ok(["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(magic), `${helper} 不是 Mach-O`);
    assert.ok(fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs, `${helper} 比 Swift 源码旧，未重编译`);
  }
});

test("应用内标志和 macOS 图标来自同一份圆环闪电 Logo", (t) => {
  const svgPath = path.join(ROOT, "public", "logos", "kaii-k-a.svg");
  const svg = fs.readFileSync(svgPath, "utf8");
  assert.match(svg, /<title[^>]*>一个圆环与一道闪电组成的 kaii 标志<\/title>/);
  assert.equal((svg.match(/data-part="bolt-ink"/g) || []).length, 1, "主图只能有一道闪电");
  assert.equal((svg.match(/data-part="circle-ink"/g) || []).length, 1, "主图只能有一个圆环");
  assert.equal((svg.match(/data-part="circle-carrier"/g) || []).length, 1, "圆环也要有米白套印底");
  const ringPath = svg.match(/data-part="circle-ink"[^>]*d="([^"]+)"/)?.[1] || "";
  assert.equal((ringPath.match(/\bL\b/g) || []).length, 0, "圆环不能再用密集折线做出皱边");
  assert.equal((ringPath.match(/C/g) || []).length, 8, "圆环应由内外两圈圆润曲线组成");
  assert.match(svg, /data-part="circle-ink" fill-rule="evenodd"/, "不规则圆环的内孔必须真实镂空");
  assert.equal(/<use\b|rotate\(/i.test(svg), false, "Logo 不应再靠旋转复制构件形成对称环");
  assert.match(svg, /fill="#6A9BCC"/, "缺少 sky 蓝地色");
  assert.match(svg, /fill="#FAF9F5"[^>]*transform="translate\(12 9\)"/, "缺少米白错位担体");
  assert.match(svg, /fill="#141413"/, "缺少墨色主体");
  assert.equal(/<text\b/i.test(svg), false, "Logo 里不该有文字");

  const preview = path.join(ROOT, "public", "logos", "kaii-k-a.png");
  const icon = path.join(ROOT, "resources", "kaii.icns");
  const iconSource = path.join(ROOT, "design", "kaii.iconset", "icon_512x512@2x.png");
  for (const file of [preview, icon, iconSource]) assert.ok(fs.existsSync(file), `缺少图标产物：${file}`);
  assert.ok(fs.statSync(preview).mtimeMs >= fs.statSync(svgPath).mtimeMs, "PNG 比 Logo SVG 旧");
  assert.ok(fs.statSync(icon).mtimeMs >= fs.statSync(svgPath).mtimeMs, "ICNS 比 Logo SVG 旧");

  if (process.platform === "darwin") {
    const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-logo-render-"));
    t.after(() => fs.rmSync(renderDir, { recursive: true, force: true }));
    const rendered = path.join(renderDir, "logo.png");
    const result = spawnSync("sips", ["-s", "format", "png", svgPath, "--out", rendered], { stdio: "ignore" });
    assert.equal(result.status, 0, "sips 没能渲染 Logo SVG");
    assert.deepEqual(fs.readFileSync(preview), fs.readFileSync(rendered), "Logo PNG 不是当前 SVG 的确定性渲染结果");
  }
});

test("临时组装 app.asar 后可列表、可解包，关键内容与入包前逐字节一致", async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kaii-asar-smoke-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const stage = path.join(work, "app");
  fs.mkdirSync(stage, { recursive: true });
  for (const directory of ["dist", "electron", "resources"]) {
    fs.cpSync(path.join(ROOT, directory), path.join(stage, directory), {
      recursive: true,
      filter: (source) => !/^electron\/lib\/dmr/i.test(path.relative(ROOT, source).split(path.sep).join("/")),
    });
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(stage, "package.json"));

  const archive = path.join(work, "app.asar");
  await asar.createPackage(stage, archive);
  const listed = new Set(asar.listPackage(archive));
  assert.equal([...listed].some((file) => /^\/electron\/lib\/dmr/i.test(file)), false);
  for (const required of [
    "/dist/index.html",
    "/dist/build-inputs.sha256.json",
    "/electron/main.cjs",
    "/electron/preload.cjs",
    "/resources/bin/kaii-vision",
    "/resources/bin/kaii-doc",
    "/resources/bin/kaii-speech",
  ]) assert.ok(listed.has(required), `asar 缺少 ${required}`);

  for (const relative of [
    "dist/index.html",
    "dist/build-inputs.sha256.json",
    "electron/main.cjs",
    "electron/preload.cjs",
    "resources/bin/kaii-vision",
    "resources/bin/kaii-doc",
    "resources/bin/kaii-speech",
  ]) {
    const unpacked = asar.extractFile(archive, relative);
    const original = fs.readFileSync(path.join(stage, relative));
    assert.equal(Buffer.compare(unpacked, original), 0, `解包后内容变了：${relative}`);
  }

  const unpackedRoot = path.join(work, "unpacked");
  asar.extractAll(archive, unpackedRoot);
  assert.equal(sha256(path.join(unpackedRoot, "dist", "index.html")), sha256(path.join(DIST, "index.html")));
});

test("dist/index.html 引用的每个本地构建文件都真实存在", () => {
  const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
  const references = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(references.length >= 2, "index.html 没有主 JS/CSS 引用");
  for (const reference of references) {
    assert.ok(fs.existsSync(path.join(DIST, reference)), `index.html 指向不存在的产物：${reference}`);
  }

  const syntax = spawnSync("/bin/bash", ["-n", path.join(ROOT, "scripts", "repack-desktop.sh")], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr || "repack-desktop.sh 语法错误");

  const smoke = spawnSync("/bin/bash", [path.join(ROOT, "scripts", "repack-desktop.sh"), "package-test"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, KAII_REPACK_SMOKE_ONLY: "1" },
  });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout || "repack smoke 失败");
  assert.match(smoke.stdout, /repack smoke PASS/);
});
