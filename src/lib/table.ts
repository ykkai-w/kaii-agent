// 表格排序与导出。纯函数放在这里而不是塞进那个含 JSX 的组件里——
// Node 的类型剥离不处理 JSX，放在组件里就只能靠正则匹配源码来"测"，
// 那种断言又脆又测不到真行为。（safeFileName 当初就是这么挪出来的。）

function toNumber(value: string): number | null {
  const cleaned = value.replace(/[,，\s%￥$元件个人次]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

// 排序要认得数字：`"1,200"` 和 `"￥800"` 按数值比，
// 纯文本按本地化比较（中文按拼音）。
export function compareCells(a: string, b: string): number {
  const left = toNumber(a);
  const right = toNumber(b);
  if (left !== null && right !== null) return left - right;
  // 数字排在文本前面：一列里混着「120」和「暂无」时，
  // 把「暂无」堆在一头比穿插在中间好读。
  if (left !== null) return -1;
  if (right !== null) return 1;
  return a.localeCompare(b, "zh-CN");
}

export function tableToCsv(headers: string[], rows: string[][]): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

// TSV：直接粘进 Excel / Numbers / 飞书表格用的。
// 单元格里的制表符和换行换成空格——TSV 没有转义语法，保结构优先。
export function tableToTsv(headers: string[], rows: string[][]): string {
  const clean = (cell: string) => cell.replace(/[\t\n\r]+/g, " ").trim();
  return [headers, ...rows].map((row) => row.map(clean).join("\t")).join("\n");
}
