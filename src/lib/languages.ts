// 语言名归一化。刻意不依赖 highlight.js：侧栏提取、文件后缀这些地方都要用它，
// 但它们不该为了认个名字就把整个高亮库拖进来。
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  py3: "python",
  sh: "bash",
  zsh: "bash",
  console: "shell",
  html: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  toml: "ini",
  conf: "ini",
  patch: "diff",
  "c++": "cpp",
  golang: "go",
  rs: "rust",
  kt: "java",
  psql: "sql",
  mysql: "sql",
};

export const EXTENSIONS: Record<string, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  json: "json",
  bash: "sh",
  shell: "sh",
  css: "css",
  scss: "scss",
  xml: "html",
  markdown: "md",
  yaml: "yml",
  ini: "ini",
  sql: "sql",
  go: "go",
  rust: "rs",
  java: "java",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  r: "R",
  diff: "diff",
};

export function normalizeLanguageName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = String(raw).trim().toLowerCase().replace(/^language-/, "");
  if (!name) return null;
  return ALIASES[name] || name;
}
