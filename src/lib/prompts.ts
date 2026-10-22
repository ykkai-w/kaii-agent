// 我的指令：把常用的要求存下来，一键塞进输入框。
// 例如「用学术语气改写，禁止形容词堆砌」这种每次都要打一遍的话。

export interface SavedPrompt {
  id: string;
  label: string;
  body: string;
  createdAt: number;
  useCount: number;
}

export const PROMPTS_KEY = "kaii.prompts.v1";
export const MAX_PROMPTS = 30;
export const MAX_PROMPT_LABEL = 20;
export const MAX_PROMPT_BODY = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadPrompts(): SavedPrompt[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROMPTS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedPrompt[] => {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.body !== "string") return [];
      const body = item.body.slice(0, MAX_PROMPT_BODY);
      if (!body.trim()) return [];
      return [{
        id: item.id,
        label: String(item.label ?? "").slice(0, MAX_PROMPT_LABEL) || body.slice(0, MAX_PROMPT_LABEL),
        body,
        createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : 0,
        useCount: Number.isFinite(item.useCount) ? Number(item.useCount) : 0,
      }];
    }).slice(0, MAX_PROMPTS);
  } catch {
    return [];
  }
}

export function savePrompts(prompts: SavedPrompt[]): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(prompts.slice(0, MAX_PROMPTS)));
    return { ok: true };
  } catch {
    return { ok: false, error: "指令没有保存成功。" };
  }
}

export function createPrompt(label: string, body: string): SavedPrompt {
  const text = body.trim().slice(0, MAX_PROMPT_BODY);
  return {
    id: `prompt-${crypto.randomUUID()}`,
    label: label.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_LABEL) || text.slice(0, MAX_PROMPT_LABEL),
    body: text,
    createdAt: Date.now(),
    useCount: 0,
  };
}

// 指令里的变量。写「帮我把 {{选中}} 改得口语一点」比每次手动粘一遍省事，
// 而 {{今天}} 让「今天的日程」这类指令不用每次改日期。
//
// 刻意只做四个：变量一多就成了模板语言，用户得先学它才能用。
export function fillPromptVariables(body: string, context: { selection?: string; draft?: string } = {}): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  return body
    .replaceAll("{{今天}}", `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`)
    .replaceAll("{{现在}}", `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replaceAll("{{星期}}", `星期${weekdays[now.getDay()]}`)
    // 认不出来的变量原样留着，不要悄悄换成空——
    // 用户会以为指令写错了，而不是这里不支持。
    .replaceAll("{{选中}}", context.selection ?? "{{选中}}");
}

// 常用的排前面，同样常用的按新旧。用得多的应该越来越好点到。
export function sortPrompts(prompts: SavedPrompt[]): SavedPrompt[] {
  return [...prompts].sort((a, b) => b.useCount - a.useCount || b.createdAt - a.createdAt);
}
