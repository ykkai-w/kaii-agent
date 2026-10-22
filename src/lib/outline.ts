// 长回答的小目录。
//
// 一段两千字带六个小标题的回答，在对话流里只能从头滚到尾。
// 抽出标题做成目录，点了跳过去——这是长文最缺的那一步。
//
// 只认 Markdown 的 # 标题，不猜「看起来像标题的粗体行」：
// 猜错的目录比没有目录更烦，点了跳到不相干的地方。

export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  /** 在原文里的字符位置，用来算滚动目标。 */
  at: number;
}

const MIN_HEADINGS = 3;

export function extractOutline(messageId: string, content: string): OutlineItem[] {
  if (!content.includes("#")) return [];
  const items: OutlineItem[] = [];
  // 只认行首的 #，且后面必须跟空格——`#hashtag` 不是标题。
  const pattern = /^(#{1,4})\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  let index = 0;
  let insideFence = false;

  // 代码块里的 # 是注释不是标题。先把围栏位置记下来。
  const fences: [number, number][] = [];
  const fencePattern = /```[\s\S]*?```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fencePattern.exec(content))) {
    fences.push([fence.index, fence.index + fence[0].length]);
  }

  while ((match = pattern.exec(content))) {
    const at = match.index;
    insideFence = fences.some(([start, end]) => at >= start && at < end);
    if (insideFence) continue;
    const text = match[2].replace(/[*_`]/g, "").trim();
    if (!text) continue;
    items.push({
      id: `${messageId}-h${index}`,
      level: match[1].length,
      text: text.slice(0, 60),
      at,
    });
    index += 1;
  }

  // 只有一两个标题时目录没有意义，反而占地方。
  return items.length >= MIN_HEADINGS ? items : [];
}

// 大致读完要多久。中文按每分钟 400 字算——
// 这是个粗数，写成「大约」而不是精确的分秒，免得显得比实际更准。
export function readingMinutes(content: string): number {
  const cjk = (content.match(/[一-鿿]/g) || []).length;
  const words = content.replace(/[一-鿿]/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

export function describeLength(content: string): string {
  const characters = content.length;
  if (characters < 400) return "";
  return `${characters} 字 · 大约读 ${readingMinutes(content)} 分钟`;
}
