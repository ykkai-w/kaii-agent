import type { Conversation } from "../types";

// 对话的整理：标签、归档、回收站。
//
// 这三件事和「项目」解决的不是同一个问题：
// - 项目是**归属**，一段对话只能在一个项目里
// - 标签是**性质**，可以有好几个（「要跟进」「已解决」「重要」）
// - 归档是**收起来但别删**
// - 回收站是**删了还有后悔的余地**

export const TRASH_DAYS = 30;
export const MAX_TAGS = 8;

export function isVisible(conversation: Conversation): boolean {
  return !conversation.deletedAt && !conversation.archived;
}

export function isInTrash(conversation: Conversation): boolean {
  return Boolean(conversation.deletedAt);
}

// 回收站里超过三十天的才真删。这个期限是拍的，但要有一个——
// 永远不清理的话回收站就成了另一个垃圾堆。
export function expiredInTrash(conversations: Conversation[], now = Date.now()): string[] {
  return conversations
    .filter((item) => item.deletedAt && now - item.deletedAt > TRASH_DAYS * 86_400_000)
    .map((item) => item.id);
}

export function allTags(conversations: Conversation[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    if (!isVisible(conversation)) continue;
    for (const tag of conversation.tags || []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  // 用得多的排前面，一样多的按笔画（本地化）排，顺序稳定。
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-CN"));
}

export function toggleTag(tags: string[] | undefined, tag: string): string[] {
  const clean = tag.trim().slice(0, 16);
  if (!clean) return tags || [];
  const current = tags || [];
  if (current.includes(clean)) return current.filter((item) => item !== clean);
  // 上限是为了防止标签栏被撑爆，不是什么技术限制。
  return current.length >= MAX_TAGS ? current : [...current, clean];
}

// 按标签筛。选了多个标签时是「都要有」而不是「有一个就行」——
// 筛选的目的是缩小范围，或的语义会越筛越多，很反直觉。
export function matchesTags(conversation: Conversation, wanted: string[]): boolean {
  if (!wanted.length) return true;
  const tags = conversation.tags || [];
  return wanted.every((tag) => tags.includes(tag));
}
