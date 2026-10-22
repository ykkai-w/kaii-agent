// 命令面板的匹配规则。
//
// 单独拎出来是为了能测：排序对不对，光看界面很难说清，
// 但写成断言就一目了然。
//
// 中文没法做前缀缩写（"新建对话" 的首字母不是 xjdh），所以每条命令
// 自带一串 keywords，把拼音、英文、可能的叫法都塞进去。
// 匹配时 label 和 keywords 一起看，但 label 命中给的分更高——
// 用户看得见的是 label，让它先排上来才不别扭。

export type CommandKind = "action" | "model" | "conversation" | "prompt";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  kind: CommandKind;
  keywords?: string[];
  disabled?: boolean;
  run: () => void;
}

export interface ScoredCommand {
  command: PaletteCommand;
  score: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

// 子序列匹配：输入的每个字都要在目标里按顺序出现。
// 连着命中的加分，所以 "know" 匹配 "knowledge" 会比匹配 "k...n...o...w" 高。
function subsequenceScore(haystack: string, needle: string): number {
  let at = 0;
  let score = 0;
  let streak = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return 0;
    streak = found === at ? streak + 1 : 0;
    score += 1 + streak;
    at = found + 1;
  }
  return score;
}

export function scoreCommand(command: PaletteCommand, query: string): number {
  const needle = normalize(query);
  if (!needle) return 1;

  const label = normalize(command.label);
  // 整段命中最靠谱，排最前；越靠开头分越高。
  if (label.startsWith(needle)) return 1000 - label.length;
  if (label.includes(needle)) return 800 - label.indexOf(needle);

  for (const keyword of command.keywords || []) {
    const key = normalize(keyword);
    if (key.startsWith(needle)) return 600 - key.length;
    if (key.includes(needle)) return 500 - key.indexOf(needle);
  }

  const hint = normalize(command.hint || "");
  if (hint.includes(needle)) return 300 - hint.indexOf(needle);

  // 子序列只对拉丁字母有意义。中文一个字就是一个词，
  // 拆成子序列会把 "新建对话" 匹配成 "新话"，全是噪音。
  if (/^[a-z0-9]+$/.test(needle)) {
    const loose = subsequenceScore(label, needle);
    if (loose) return loose;
  }
  return 0;
}

// 最近用过的命令 id（新的在前）。只在没输入内容时用来提一提顺序——
// 一旦开始打字，匹配分数说了算，不能让"最近用过"盖过用户明确要找的东西。
export function applyRecency(commands: PaletteCommand[], recentIds: string[]): PaletteCommand[] {
  if (!recentIds.length) return commands;
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  // 稳定排序：没用过的保持原有次序，用过的按最近程度插到前面。
  return [...commands].sort((a, b) => {
    const left = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const right = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

export function filterCommands(commands: PaletteCommand[], query: string, limit = 40): PaletteCommand[] {
  const scored: ScoredCommand[] = [];
  for (const command of commands) {
    const score = scoreCommand(command, query);
    if (score > 0) scored.push({ command, score });
  }
  // 稳定排序：同分时保持传进来的顺序，这样没输入内容时
  // 面板呈现的就是调用方安排好的次序，不会每次开都跳一下。
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.command);
}

export function groupCommands(commands: PaletteCommand[]): { group: string; items: PaletteCommand[] }[] {
  const groups: { group: string; items: PaletteCommand[] }[] = [];
  for (const command of commands) {
    const existing = groups.find((entry) => entry.group === command.group);
    if (existing) existing.items.push(command);
    else groups.push({ group: command.group, items: [command] });
  }
  return groups;
}

// 上下键在「跳过不可选项」的前提下移动。全都不可选时返回原位，
// 免得按住方向键陷进死循环。
export function moveSelection(commands: PaletteCommand[], current: number, delta: number): number {
  if (!commands.length) return 0;
  let next = current;
  for (let step = 0; step < commands.length; step += 1) {
    next = (next + delta + commands.length) % commands.length;
    if (!commands[next].disabled) return next;
  }
  return current;
}
