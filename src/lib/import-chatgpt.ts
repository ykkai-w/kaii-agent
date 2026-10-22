// 从 ChatGPT 官方导出里把会话搬进来。
//
// 官方导出是个 zip，里面的 conversations.json 是一棵消息树
// （mapping + current_node，因为「重新生成」会长出分支）。
// 我们取 current_node 往根回溯——那正是用户最后看到的那条线。
// 被放弃的分支不搬：搬过来也只会让人困惑「这条我没见过」。
//
// 立场：导入是合并（只添不删），失败的单条会话跳过并计数，
// 绝不因为一条坏数据放弃整批。

import type { ChatMessage, Conversation } from "../types";
import { fitsConversationStorage } from "./storage.ts";

interface ChatGptNode {
  id?: string;
  message?: {
    author?: { role?: string };
    create_time?: number | null;
    content?: { content_type?: string; parts?: unknown[] };
  } | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGptConversation {
  id?: unknown;
  conversation_id?: unknown;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  mapping?: Record<string, ChatGptNode>;
  current_node?: string | null;
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 官方 id 通常是 UUID，可以直接留下；如果未来的导出格式里
// 出现空格或路径符号，则改用确定性摘要，既不把外部字符串
// 直接当本地键，也不会让同一份导出每次生成新会话。
function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(code >>> 8);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function usableOfficialId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 512 ? trimmed : null;
}

function conversationId(item: ChatGptConversation): string {
  const official = usableOfficialId(item.conversation_id) || usableOfficialId(item.id);
  if (!official) return randomId("chatgpt");
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(official)) return `chatgpt-${official}`;
  return `chatgpt-${stableHash(official)}`;
}

function mappingNode(mapping: Record<string, ChatGptNode>, id: string): ChatGptNode | undefined {
  if (!Object.prototype.hasOwnProperty.call(mapping, id)) return undefined;
  const value: unknown = mapping[id];
  return isRecord(value) ? value as ChatGptNode : undefined;
}

// parent 和 children 是两套方向相反的树边，要分别检查。
// 不能把两套边合在一起，否则正常的父子关系也会被误判为两步环。
function assertAcyclic(
  mapping: Record<string, ChatGptNode>,
  edgesFor: (node: ChatGptNode) => string[],
): void {
  const state = new Map<string, "visiting" | "done">();
  for (const start of Object.keys(mapping)) {
    if (state.has(start) || !mappingNode(mapping, start)) continue;
    state.set(start, "visiting");
    const stack: Array<{ id: string; edges: string[]; next: number }> = [{
      id: start,
      edges: edgesFor(mappingNode(mapping, start)!),
      next: 0,
    }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.edges.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const target = frame.edges[frame.next];
      frame.next += 1;
      const targetNode = mappingNode(mapping, target);
      if (!targetNode) continue;
      const targetState = state.get(target);
      if (targetState === "visiting") throw new Error("会话消息树里有环。");
      if (targetState === "done") continue;
      state.set(target, "visiting");
      stack.push({ id: target, edges: edgesFor(targetNode), next: 0 });
    }
  }
}

// 一棵 mapping 树 → 当前对话线上的消息列表。
function linearize(item: ChatGptConversation): ChatMessage[] {
  const mapping = isRecord(item.mapping) ? item.mapping as Record<string, ChatGptNode> : {};
  assertAcyclic(mapping, (node) => typeof node.parent === "string" ? [node.parent] : []);
  assertAcyclic(mapping, (node) => (
    Array.isArray(node.children)
      ? node.children.filter((child): child is string => typeof child === "string")
      : []
  ));
  const chain: ChatGptNode[] = [];
  // 从 current_node 回溯到根。前面已检查整张图，这里再留一层
  // 就地防线，确保坏数据绝不会被放大成成千上万条重复消息。
  let cursor = typeof item.current_node === "string" ? item.current_node : null;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error("会话消息树里有环。");
    seen.add(cursor);
    const node = mappingNode(mapping, cursor);
    if (!node) break;
    chain.push(node);
    cursor = typeof node.parent === "string" ? node.parent : null;
  }
  chain.reverse();

  const messages: ChatMessage[] = [];
  for (const node of chain) {
    const message = node.message;
    if (!message) continue;
    const role = message.author?.role;
    // system/tool 消息是 ChatGPT 的内部脚手架，不搬。
    if (role !== "user" && role !== "assistant") continue;
    if (message.content?.content_type !== "text") continue;
    const text = (message.content.parts || [])
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();
    if (!text) continue;
    messages.push({
      id: randomId("imported"),
      role,
      content: text,
      createdAt: message.create_time ? Math.round(message.create_time * 1000) : Date.now(),
    });
  }
  return messages;
}

export interface ChatGptImportResult {
  conversations: Conversation[];
  skipped: number;
}

// 入口：conversations.json 的文本 → 本地会话数组。
// 解析不了整个文件时抛错（让界面明说「这不是那个文件」）；
// 单条会话坏了只计数跳过。
export function parseChatGptExport(raw: string): ChatGptImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("这不是能读的 JSON。要的是 ChatGPT 导出 zip 里的 conversations.json。");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("格式不认识：conversations.json 应当是一个会话数组。");
  }

  const conversations: Conversation[] = [];
  let skipped = 0;
  for (const entry of parsed) {
    try {
      const item = entry as ChatGptConversation;
      const messages = linearize(item);
      if (!messages.length) {
        skipped += 1;
        continue;
      }
      const createdAt = item.create_time ? Math.round(item.create_time * 1000) : messages[0].createdAt;
      conversations.push({
        id: conversationId(item),
        title: String(item.title || "从 ChatGPT 搬来的对话").slice(0, 60),
        messages,
        skillId: "none",
        createdAt,
        updatedAt: item.update_time ? Math.round(item.update_time * 1000) : createdAt,
        // 打个标签，搬来的一眼认得出，也方便整批筛选。
        tags: ["ChatGPT"],
      });
    } catch {
      skipped += 1;
    }
  }
  return { conversations, skipped };
}

export interface ChatGptImportPlan {
  accepted: Conversation[];
  duplicates: number;
  capacitySkipped: number;
}

/**
 * 只规划、不写盘：先去重，再按更新时间从新到旧尝试放入。
 * 同一时间保留官方导出的原顺序。每放一段都用真实持久化口径
 * 重算，因此 accepted 中的每一段都能和 current 一起在重启后留下。
 */
export function planChatGptImport(
  current: Conversation[],
  incoming: Conversation[],
): ChatGptImportPlan {
  const accepted: Conversation[] = [];
  const seen = new Set(current.map((conversation) => conversation.id));
  let duplicates = 0;
  let capacitySkipped = 0;
  const prioritized = incoming
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.conversation.updatedAt) ? left.conversation.updatedAt : 0;
      const rightTime = Number.isFinite(right.conversation.updatedAt) ? right.conversation.updatedAt : 0;
      return rightTime - leftTime || left.index - right.index;
    });

  for (const { conversation } of prioritized) {
    if (seen.has(conversation.id)) {
      duplicates += 1;
      continue;
    }
    // 就算这段因容量没放进去，同一批中同 id 的旧副本也不应
    // 取巧顶替它；优先级已经明确选了更新的那份。
    seen.add(conversation.id);
    if (!fitsConversationStorage([...current, ...accepted, conversation])) {
      capacitySkipped += 1;
      continue;
    }
    accepted.push(conversation);
  }

  return { accepted, duplicates, capacitySkipped };
}
