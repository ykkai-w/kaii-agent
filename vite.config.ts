import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUILD_INPUT_FILES = [
  "index.html",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
];

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}

// dist 里带上“它究竟由哪些当前源码生成”的可复算指纹。
// 打包脚本不再用 mtime 猜新旧：测试会在入包前逐文件重算这份清单。
export function collectBuildInputHashes(root = process.cwd()) {
  const candidates = [
    ...BUILD_INPUT_FILES.map((name) => path.join(root, name)),
    ...filesUnder(path.join(root, "src")),
    ...filesUnder(path.join(root, "public")),
  ];
  const files: Record<string, string> = {};
  for (const absolute of candidates.filter((name) => fs.existsSync(name)).sort()) {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    files[relative] = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
  }
  return { schemaVersion: 1, files };
}

export function buildInputManifest() {
  return {
    name: "build-input-manifest",
    apply: "build" as const,
    generateBundle(this: { emitFile: (asset: { type: "asset"; fileName: string; source: string }) => void }) {
      this.emitFile({
        type: "asset",
        fileName: "build-inputs.sha256.json",
        source: `${JSON.stringify(collectBuildInputHashes(), null, 2)}\n`,
      });
    },
  };
}

// KaTeX 的样式表给每种字体都列了 woff2 / woff / ttf 三份。
// Chromium 永远挑第一个能用的，也就是 woff2，另外两份从头到尾不会被请求，
// 却实打实地躺在包里（这里量过：woff 336K + ttf 540K）。
// 这个插件在打包前把非 woff2 的那几个 src 去掉，字体文件也就不会被 vite 收进产物。
// 写成插件而不是维护一份改过的 CSS 副本，是为了升级 KaTeX 时不用重新改一遍。
export function katexWoff2Only() {
  return {
    name: "katex-woff2-only",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const [filePath, query = ""] = id.split("?", 2);
      if (!filePath.includes("katex") || !filePath.endsWith(".css")) return null;
      let trimmed = code.replace(
        /url\(([^)]*\.woff2)\)\s*format\("woff2"\)(?:\s*,\s*url\([^)]*\)\s*format\("[^"]*"\))+/g,
        'url($1) format("woff2")',
      );

      // `?inline` 那份 CSS 会被写进单个可分享 HTML 和 PDF 的 <style> 里。
      // 如果还留着对 dist/assets 的 URL，HTML 发到另一台电脑就会丢字体，
      // data: 页面打 PDF 时也可能被 Chromium 拒绝跨源读 file: 字体。
      if (query.split("&").includes("inline")) {
        trimmed = trimmed.replace(/url\((['"]?)([^)'"\s]+\.woff2)\1\)/g, (_match, _quote, rawUrl) => {
          if (/^(?:data:|https?:|\/\/)/i.test(rawUrl)) return _match;
          const fontPath = path.resolve(path.dirname(filePath), decodeURIComponent(rawUrl));
          const data = fs.readFileSync(fontPath).toString("base64");
          return `url("data:font/woff2;base64,${data}")`;
        });
      }
      return trimmed === code ? null : { code: trimmed, map: null };
    },
  };
}

export default defineConfig({
  plugins: [katexWoff2Only(), react(), buildInputManifest()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
