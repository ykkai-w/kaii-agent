// 把数据画成图。
//
// 模型在回答里吐一个 ```chart 围栏，里面是一小段 JSON，这里解析出来画成 SVG。
// 不引图表库：一个只在本机跑的应用不该为画三种图背上一整棵依赖树，
// 而且 CSP 也不允许外部脚本。
//
// 几何计算全是纯函数，因为这部分光看图看不出对错——
// 坐标轴刻度选得好不好、负数怎么摆、只有一个点怎么办，写成断言才说得清。

export type ChartKind = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartKind;
  title: string;
  labels: string[];
  series: ChartSeries[];
  unit: string;
}

export interface ChartBlock {
  id: string;
  messageId: string;
  index: number;
  spec: ChartSpec;
}

const MAX_POINTS = 60;
const MAX_SERIES = 6;
const MAX_PIE_SLICES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // 模型经常把数字写成 "1,200" 或 "￥800" 或 "35%"。能认就认，
    // 认不出来当缺失，而不是当 0——当 0 会把平均值和图形都带偏。
    const cleaned = value.replace(/[,，\s%￥$元件个]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// 解析要宽容：模型写出来的 JSON 常常缺字段、类型不对、数量对不齐。
// 能修的修（补齐、截断），修不了的整块拒绝，绝不半渲染一张错图。
export function parseChartSpec(raw: string): ChartSpec | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const type = parsed.type;
  if (type !== "bar" && type !== "line" && type !== "pie") return null;

  const labels = (Array.isArray(parsed.labels) ? parsed.labels : [])
    .map((item) => String(item ?? "").slice(0, 24))
    .slice(0, MAX_POINTS);
  if (!labels.length) return null;

  const rawSeries = Array.isArray(parsed.series) ? parsed.series : [];
  const series: ChartSeries[] = [];
  for (const item of rawSeries.slice(0, MAX_SERIES)) {
    if (!isRecord(item)) continue;
    const values = (Array.isArray(item.values) ? item.values : [])
      .map(toFiniteNumber)
      .slice(0, labels.length);
    if (!values.some((value) => value !== null)) continue;
    // 值比标签少就补齐成缺失，不能让后面按下标取到 undefined。
    while (values.length < labels.length) values.push(null);
    series.push({
      name: String(item.name ?? "").slice(0, 24) || `系列${series.length + 1}`,
      values: values as number[],
    });
  }
  if (!series.length) return null;

  // 饼图只画一组数，而且负数没法用扇形表示。
  if (type === "pie" && series[0].values.some((value) => typeof value === "number" && value < 0)) {
    return null;
  }

  return {
    type,
    title: String(parsed.title ?? "").slice(0, 60),
    labels,
    series: type === "pie" ? series.slice(0, 1) : series,
    unit: String(parsed.unit ?? "").slice(0, 8),
  };
}

export function extractCharts(messageId: string, content: string): ChartBlock[] {
  if (!content.includes("```chart")) return [];
  const blocks: ChartBlock[] = [];
  // 只认成对的围栏。流式输出到一半时开头已经出现但结尾还没到，
  // 这时不该抢先画一张残缺的图。
  const pattern = /```chart[ \t]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(content))) {
    const spec = parseChartSpec(match[1]);
    if (spec) blocks.push({ id: `${messageId}-chart-${index}`, messageId, index, spec });
    index += 1;
  }
  return blocks;
}

// ── 坐标轴 ────────────────────────────────────────────────

// 挑“看着顺眼”的刻度间隔：1、2、5 乘以 10 的幂。
// 直接把范围等分会得到 0、3.33、6.67 这种没人想读的刻度。
export function niceStep(span: number, targetCount: number): number {
  if (!(span > 0) || !(targetCount > 0)) return 1;
  const rough = span / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const stepped = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return stepped * magnitude;
}

export interface AxisRange {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

// 柱状图的纵轴必须从 0 起。截断的纵轴会把 3% 的差看成 3 倍，
// 这是图表里最常见的一种骗人做法，不能默认就这么画。
export function axisRange(values: number[], { zeroBased = true, tickCount = 4 } = {}): AxisRange {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return { min: 0, max: 1, step: 1, ticks: [0, 1] };

  let low = Math.min(...usable);
  let high = Math.max(...usable);
  if (zeroBased) {
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  // 所有值都一样时给一点上下空间，否则图形会是一条贴着轴的线。
  if (low === high) {
    if (low === 0) return { min: 0, max: 1, step: 0.5, ticks: [0, 0.5, 1] };
    const pad = Math.abs(low) * 0.5;
    low -= pad;
    high += pad;
    if (zeroBased) low = Math.min(0, low);
  }

  const step = niceStep(high - low, tickCount);
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // 浮点累加会漂：0.1 加十次不等于 1。用整数下标乘出来。
  const count = Math.round((max - min) / step);
  for (let index = 0; index <= count; index += 1) {
    ticks.push(Number((min + index * step).toPrecision(12)));
  }
  return { min, max, step, ticks };
}

export function formatTick(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 100_000_000) return `${Number((value / 100_000_000).toFixed(2))}亿`;
  if (magnitude >= 10_000) return `${Number((value / 10_000).toFixed(2))}万`;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(2)));
}

// ── 饼图 ──────────────────────────────────────────────────

export interface PieSlice {
  label: string;
  value: number;
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
}

function arcPath(cx: number, cy: number, radius: number, start: number, end: number): string {
  // 整圆用一段弧画不出来（起点终点重合），拆成两个半圆。
  if (end - start >= Math.PI * 2 - 1e-9) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx} ${cy + radius}`
      + ` A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius} Z`;
  }
  const x1 = cx + radius * Math.sin(start);
  const y1 = cy - radius * Math.cos(start);
  const x2 = cx + radius * Math.sin(end);
  const y2 = cy - radius * Math.cos(end);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
}

export function pieLayout(
  labels: string[],
  values: number[],
  { cx = 90, cy = 90, radius = 78 } = {},
): PieSlice[] {
  const pairs = labels
    .map((label, index) => ({ label, value: Number.isFinite(values[index]) ? values[index] : 0 }))
    .filter((item) => item.value > 0);
  if (!pairs.length) return [];

  pairs.sort((a, b) => b.value - a.value);
  // 切片太多就没法看了，尾巴并成"其他"。
  let shown = pairs;
  if (pairs.length > MAX_PIE_SLICES) {
    const head = pairs.slice(0, MAX_PIE_SLICES - 1);
    const tail = pairs.slice(MAX_PIE_SLICES - 1);
    shown = [...head, { label: "其他", value: tail.reduce((sum, item) => sum + item.value, 0) }];
  }

  const total = shown.reduce((sum, item) => sum + item.value, 0);
  let angle = 0;
  return shown.map((item) => {
    const sweep = (item.value / total) * Math.PI * 2;
    const slice: PieSlice = {
      label: item.label,
      value: item.value,
      share: item.value / total,
      startAngle: angle,
      endAngle: angle + sweep,
      path: arcPath(cx, cy, radius, angle, angle + sweep),
    };
    angle += sweep;
    return slice;
  });
}

// 配色跟着主题走，用 CSS 变量，深浅色都不用改。
export const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

// 导出成 CSV，图旁边给一个下载入口：看到的图能直接变成能算的数。
export function toCsv(spec: ChartSpec): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const header = ["", ...spec.series.map((item) => item.name)].map(escape).join(",");
  const rows = spec.labels.map((label, index) => [
    escape(label),
    ...spec.series.map((item) => (Number.isFinite(item.values[index]) ? String(item.values[index]) : "")),
  ].join(","));
  return [header, ...rows].join("\n");
}

export type ChartSegment =
  | { kind: "text"; text: string }
  | { kind: "chart"; spec: ChartSpec };

// 把一段回答切成「文字 / 图 / 文字」。图要单独拎出来，
// 否则 Markdown 渲染器会把那段 JSON 当普通代码块原样贴出来。
export function splitChartSegments(content: string): ChartSegment[] {
  if (!content.includes("```chart")) return [{ kind: "text", text: content }];
  const segments: ChartSegment[] = [];
  const pattern = /```chart[ \t]*\n([\s\S]*?)```[ \t]*\n?/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const spec = parseChartSpec(match[1]);
    // 解析不出来的就原样留着当文字。宁可让用户看到一段 JSON，
    // 也好过悄悄吞掉模型说的话。
    if (!spec) continue;
    const before = content.slice(cursor, match.index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    segments.push({ kind: "chart", spec });
    cursor = match.index + match[0].length;
  }
  const rest = content.slice(cursor);
  if (rest.trim()) segments.push({ kind: "text", text: rest });
  return segments.length ? segments : [{ kind: "text", text: content }];
}
