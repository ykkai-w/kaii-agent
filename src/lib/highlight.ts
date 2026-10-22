import hljs from "highlight.js/lib/core";
import { normalizeLanguageName } from "./languages.ts";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// 只注册用得上的语言。全量 highlight.js 要一兆多，而这里九成场景就是
// JS/TS/Python/JSON/Shell/Markdown 这几种。
const LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ["bash", bash],
  ["c", c],
  ["cpp", cpp],
  ["css", css],
  ["diff", diff],
  ["go", go],
  ["ini", ini],
  ["java", java],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["python", python],
  ["r", r],
  ["rust", rust],
  ["scss", scss],
  ["shell", shell],
  ["sql", sql],
  ["swift", swift],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
];

for (const [name, definition] of LANGUAGES) hljs.registerLanguage(name, definition);

export function resolveLanguage(raw: string | null | undefined): string | null {
  const resolved = normalizeLanguageName(raw);
  return resolved && hljs.getLanguage(resolved) ? resolved : null;
}

export interface HighlightResult {
  html: string;
  language: string | null;
}

// 返回的是 highlight.js 生成的 HTML。它只会产出 <span class="hljs-…"> 包裹，
// 输入里的尖括号会被转义，所以不会把模型输出当成标记执行。
export function highlightCode(code: string, rawLanguage?: string | null): HighlightResult {
  const language = resolveLanguage(rawLanguage);
  if (!language) return { html: escapeHtml(code), language: null };
  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
    return { html: value, language };
  } catch {
    return { html: escapeHtml(code), language: null };
  }
}

export function escapeHtml(text: string): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function listSupportedLanguages(): string[] {
  return LANGUAGES.map(([name]) => name);
}
