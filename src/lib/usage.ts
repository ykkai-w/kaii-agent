import type { Conversation } from "../types";

// 用量统计：这些天到底在用哪个模型、聊了多少。
//
// 不接任何计费接口——各家的价格随时在变，写死一个数字迟早是错的，
// 而且误导比不给更糟。这里只数自己这边看得见的：多少次、多少字。

export interface ModelUsage {
  label: string;
  turns: number;
  characters: number;
}

export interface UsageSummary {
  days: number;
  conversations: number;
  turns: number;
  characters: number;
  byModel: ModelUsage[];
  busiestDay: { date: string; turns: number } | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  local: "Qwen3-8B",
  deepseek: "DeepSeek",
  moonshot: "Kimi",
  zhipu: "GLM",
};

export function summarizeUsage(conversations: Conversation[], days = 30): UsageSummary {
  const since = Date.now() - days * 86_400_000;
  const byModel = new Map<string, ModelUsage>();
  const byDay = new Map<string, number>();
  let turns = 0;
  let characters = 0;
  let touched = 0;

  for (const conversation of conversations) {
    let counted = false;
    for (const message of conversation.messages) {
      if (message.role !== "assistant" || message.createdAt < since || !message.content) continue;
      counted = true;
      turns += 1;
      characters += message.content.length;

      // 每条消息不一定记了模型，退回这段对话选的那个。
      const label = message.modelLabel
        || PROVIDER_LABELS[conversation.provider || "local"]
        || conversation.provider
        || "Qwen3-8B";
      const entry = byModel.get(label) || { label, turns: 0, characters: 0 };
      entry.turns += 1;
      entry.characters += message.content.length;
      byModel.set(label, entry);

      const date = new Date(message.createdAt).toISOString().slice(0, 10);
      byDay.set(date, (byDay.get(date) ?? 0) + 1);
    }
    if (counted) touched += 1;
  }

  let busiestDay: UsageSummary["busiestDay"] = null;
  for (const [date, count] of byDay) {
    if (!busiestDay || count > busiestDay.turns) busiestDay = { date, turns: count };
  }

  return {
    days,
    conversations: touched,
    turns,
    characters,
    byModel: [...byModel.values()].sort((a, b) => b.turns - a.turns),
    busiestDay,
  };
}

// 给「每周回顾」用：把这周聊过的题目拢出来，交给模型总结。
export function recentTopics(conversations: Conversation[], days = 7, limit = 40): string[] {
  const since = Date.now() - days * 86_400_000;
  return conversations
    .filter((conversation) => conversation.updatedAt >= since && conversation.messages.length > 1)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((conversation) => {
      const firstAsk = conversation.messages.find((message) => message.role === "user")?.content || "";
      return `${conversation.title || "未命名"}：${firstAsk.replace(/\s+/g, " ").slice(0, 80)}`;
    });
}
