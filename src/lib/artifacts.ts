import { EXTENSIONS, normalizeLanguageName } from "./languages.ts";

// 回答里出现成段的代码或文档时，塞在对话流里既难读也难用。
// 这里把它们挑出来，交给右侧面板完整展示、复制、另存为文件。
// 判定刻意保守：短片段留在原地，只有真正"值得单独打开"的才升级。

const MIN_LINES = 12;
const MIN_CHARACTERS = 400;

export interface Artifact {
  id: string;
  messageId: string;
  index: number;
  language: string | null;
  code: string;
  lineCount: number;
  title: string;
  fileName: string;
}

function titleFor(language: string | null, code: string): string {
  const firstMeaningful = code.split("\n").map((line) => line.trim()).find(Boolean) || "";
  // 优先用代码里能认出来的名字，认不出来就退回语言名。
  const named = firstMeaningful.match(
    /(?:function|class|def|const|let|var|interface|type|struct|fn|func)\s+([A-Za-z_$][\w$]*)/,
  );
  if (named) return named[1];
  const heading = firstMeaningful.match(/^#{1,3}\s+(.{1,24})/);
  if (heading) return heading[1].trim();
  return language ? language : "文本";
}

export function extractArtifacts(messageId: string, content: string): Artifact[] {
  if (!content.includes("```")) return [];
  const artifacts: Artifact[] = [];
  // 只认成对的围栏，落单的开头不当作代码块，避免流式输出到一半就误判。
  const pattern = /```([\w+#.-]*)[ \t]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(content)) !== null) {
    const code = match[2].replace(/\n$/, "");
    const lineCount = code.split("\n").length;
    if (lineCount < MIN_LINES && code.length < MIN_CHARACTERS) {
      index += 1;
      continue;
    }
    const language = normalizeLanguageName(match[1] || null);
    const title = titleFor(language, code);
    const extension = (language && EXTENSIONS[language]) || "txt";
    artifacts.push({
      id: `${messageId}-artifact-${index}`,
      messageId,
      index,
      language,
      code,
      lineCount,
      title,
      fileName: `${title.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "kaii"}.${extension}`,
    });
    index += 1;
  }
  return artifacts;
}

export function artifactSummary(artifact: Artifact): string {
  const size = artifact.code.length > 1000
    ? `${(artifact.code.length / 1000).toFixed(1)}k 字符`
    : `${artifact.code.length} 字符`;
  return `${artifact.lineCount} 行 · ${size}${artifact.language ? ` · ${artifact.language}` : ""}`;
}
