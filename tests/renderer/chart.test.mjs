import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const {
  axisRange, extractCharts, formatTick, niceStep, parseChartSpec, pieLayout, seriesColor, toCsv,
} = await import(fileURLToPath(new URL("../../src/lib/chart.ts", import.meta.url)));

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});
after(async () => vite.close());
const { default: ChartBlock } = await vite.ssrLoadModule("/src/components/ChartBlock.tsx");

// ── 解析 ───────────────────────────────────────────────────

test("正常的图表规格能解析出来", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "bar", title: "月度销量", labels: ["1月", "2月"],
    series: [{ name: "销量", values: [120, 150] }], unit: "件",
  }));
  assert.equal(spec.type, "bar");
  assert.deepEqual(spec.labels, ["1月", "2月"]);
  assert.deepEqual(spec.series[0].values, [120, 150]);
});

test("模型常写的脏数字能认出来", () => {
  // "1,200"、"￥800"、"35%" 这几种写法模型天天写。
  const spec = parseChartSpec(JSON.stringify({
    type: "bar", labels: ["a", "b", "c"],
    series: [{ name: "金额", values: ["1,200", "￥800", "35%"] }],
  }));
  assert.deepEqual(spec.series[0].values, [1200, 800, 35]);
});

test("认不出来的值当缺失，不当 0", () => {
  // 当 0 会把柱子画到底、把平均值带偏，比留个缺口糟糕得多。
  const spec = parseChartSpec(JSON.stringify({
    type: "line", labels: ["a", "b", "c"],
    series: [{ name: "x", values: [10, "暂无", 30] }],
  }));
  assert.equal(spec.series[0].values[1], null);
  assert.notEqual(spec.series[0].values[1], 0);
});

test("折线遇到 null 会真的断开，不会连成一条假趋势", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "line",
    labels: ["1 月", "2 月", "3 月"],
    series: [{ name: "值", values: [10, null, 30] }],
  }));
  const html = renderToStaticMarkup(React.createElement(ChartBlock, { spec }));
  assert.equal((html.match(/<polyline\b/g) || []).length, 0, "两个孤立点被跨 null 连起来了");
  assert.equal((html.match(/<circle\b/g) || []).length, 2, "缺失值不该吞掉两边的真实点");
});

test("一组折线有两段连续数据时渲染成两条 polyline", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "line",
    labels: ["a", "b", "c", "d", "e"],
    series: [{ name: "值", values: [10, 20, null, 30, 40] }],
  }));
  const html = renderToStaticMarkup(React.createElement(ChartBlock, { spec }));
  const segments = [...html.matchAll(/<polyline\b[^>]*\bpoints="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(segments.length, 2);
  assert.equal(segments.every((points) => points.trim().split(/\s+/).length === 2), true);
  assert.equal((html.match(/<circle\b/g) || []).length, 4);
});

test("值比标签少会被补齐，不会按下标取到 undefined", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "bar", labels: ["a", "b", "c", "d"],
    series: [{ name: "x", values: [1, 2] }],
  }));
  assert.equal(spec.series[0].values.length, 4);
  assert.equal(spec.series[0].values[3], null);
});

test("形状不对的整块拒绝，不半渲染一张错图", () => {
  const bad = [
    "{不是 JSON",
    JSON.stringify({ type: "散点图", labels: ["a"], series: [{ values: [1] }] }),
    JSON.stringify({ type: "bar", labels: [], series: [{ values: [1] }] }),
    JSON.stringify({ type: "bar", labels: ["a"], series: [] }),
    JSON.stringify({ type: "bar", labels: ["a"], series: [{ name: "x", values: ["全是废话"] }] }),
    JSON.stringify([1, 2, 3]),
  ];
  for (const text of bad) assert.equal(parseChartSpec(text), null, `本该拒绝：${text.slice(0, 40)}`);
});

test("饼图里有负数就拒绝——扇形表示不了负数", () => {
  assert.equal(parseChartSpec(JSON.stringify({
    type: "pie", labels: ["a", "b"], series: [{ name: "x", values: [10, -5] }],
  })), null);
  // 柱状图有负数是正常的，不该被拒。
  assert.ok(parseChartSpec(JSON.stringify({
    type: "bar", labels: ["a", "b"], series: [{ name: "x", values: [10, -5] }],
  })));
});

test("只认成对的围栏，流式输出到一半不会抢先画残图", () => {
  const half = '这是分析\n```chart\n{"type":"bar","labels":["a"],"series":[{"name":"x","values":[1]}]}';
  assert.deepEqual(extractCharts("m1", half), []);
  const whole = `${half}\n\`\`\`\n后面还有字`;
  assert.equal(extractCharts("m1", whole).length, 1);
});

test("一条消息里的多张图各自有 id", () => {
  const one = '```chart\n{"type":"bar","labels":["a"],"series":[{"name":"x","values":[1]}]}\n```';
  const blocks = extractCharts("m1", `${one}\n文字\n${one}`);
  assert.equal(blocks.length, 2);
  assert.notEqual(blocks[0].id, blocks[1].id);
});

test("坏掉的那张被跳过，好的那张照画", () => {
  const good = '```chart\n{"type":"bar","labels":["a"],"series":[{"name":"x","values":[1]}]}\n```';
  const bad = "```chart\n{坏掉了}\n```";
  assert.equal(extractCharts("m1", `${bad}\n${good}`).length, 1);
});

// ── 坐标轴 ─────────────────────────────────────────────────

test("刻度间隔挑的是看着顺眼的数", () => {
  // 直接等分会得到 3.33、6.67 这种没人想读的刻度。
  // 25 不属于 1/2/5 家族，span=100 要 4 格时正确答案是 20（5 格），
  // 而不是 50（只剩 2 格）。
  assert.equal(niceStep(100, 4), 20);
  assert.equal(niceStep(10, 4), 2);
  assert.equal(niceStep(1, 4), 0.2);
  // 每种情形都不该稀到只剩两三格。
  for (const [span, want] of [[100, 4], [97, 4], [3, 5], [12345, 4]]) {
    const count = span / niceStep(span, want);
    assert.ok(count >= want * 0.6 && count <= want * 2.5, `span=${span} 分成了 ${count} 格`);
  }
  for (const step of [niceStep(97, 4), niceStep(3, 5), niceStep(12345, 4)]) {
    const normalized = step / 10 ** Math.floor(Math.log10(step));
    assert.ok([1, 2, 5, 10].includes(Math.round(normalized * 1e9) / 1e9), `${step} 不是 1/2/5 系`);
  }
});

test("柱状图纵轴从 0 起——截断的柱子会把 3% 的差看成 3 倍", () => {
  const range = axisRange([100, 103], { zeroBased: true });
  assert.equal(range.min, 0);
  // 折线图看趋势，允许不从 0 起，否则变化会被压扁。
  assert.ok(axisRange([100, 103], { zeroBased: false }).min > 0);
});

test("有负数时上下都留住", () => {
  const range = axisRange([-30, 50], { zeroBased: true });
  assert.ok(range.min <= -30);
  assert.ok(range.max >= 50);
  assert.ok(range.ticks.includes(0), "有正有负时必须画出 0 那条线");
});

test("所有值一样时也画得出来，不会是贴着轴的一条线", () => {
  const range = axisRange([7, 7, 7], { zeroBased: false });
  assert.ok(range.max > range.min);
  const zeros = axisRange([0, 0], { zeroBased: true });
  assert.ok(zeros.max > zeros.min);
});

test("没有数据时不炸", () => {
  const range = axisRange([], {});
  assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max));
  assert.ok(range.max > range.min);
});

test("刻度不会被浮点累加带跑偏", () => {
  // 0.1 加十次不等于 1。这里必须是整数下标乘出来的。
  const range = axisRange([0, 1], { zeroBased: true, tickCount: 10 });
  for (const tick of range.ticks) {
    assert.equal(String(tick).length <= 6, true, `${tick} 是浮点漂移出来的`);
  }
});

test("大数字缩成万和亿", () => {
  assert.equal(formatTick(12000), "1.2万");
  assert.equal(formatTick(250000000), "2.5亿");
  assert.equal(formatTick(42), "42");
  assert.equal(formatTick(3.14159), "3.14");
});

// ── 饼图 ───────────────────────────────────────────────────

test("扇形角度加起来正好是一整圈", () => {
  const slices = pieLayout(["a", "b", "c"], [1, 2, 3]);
  assert.equal(slices.length, 3);
  assert.ok(Math.abs(slices.at(-1).endAngle - Math.PI * 2) < 1e-9, "最后一片没有收口");
  assert.ok(Math.abs(slices.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9);
});

test("从大到小排，切片太多就并成其他", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `第${i}`);
  const values = labels.map((_, i) => i + 1);
  const slices = pieLayout(labels, values);
  assert.equal(slices.length, 8);
  assert.equal(slices.at(-1).label, "其他");
  assert.ok(slices[0].value > slices[1].value, "没有从大到小排");
  assert.ok(Math.abs(slices.reduce((sum, s) => sum + s.share, 0) - 1) < 1e-9, "并成其他之后占比不对了");
});

test("只有一个值时画出一个整圆，不是一条缝", () => {
  const slices = pieLayout(["全部"], [100]);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].share, 1);
  // 整圆用一段弧画不出来（起点终点重合），必须拆成两段。
  assert.equal((slices[0].path.match(/A /g) || []).length, 2);
});

test("零和负数不进饼图", () => {
  assert.deepEqual(pieLayout(["a", "b"], [0, 0]), []);
  assert.equal(pieLayout(["a", "b", "c"], [10, 0, -5]).length, 1);
});

// ── 其他 ───────────────────────────────────────────────────

test("配色够用且会循环，不会越界拿到 undefined", () => {
  assert.equal(typeof seriesColor(0), "string");
  assert.equal(seriesColor(0), seriesColor(6));
  assert.equal(typeof seriesColor(999), "string");
});

test("图旁边能把数据导成 CSV", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "bar", title: "销量", labels: ["1月", "2月"],
    series: [{ name: "北京", values: [1, 2] }, { name: "上海", values: [3, 4] }],
  }));
  assert.equal(toCsv(spec), ",北京,上海\n1月,1,3\n2月,2,4");
});

test("CSV 里带逗号和引号的名字会被正确转义", () => {
  const spec = parseChartSpec(JSON.stringify({
    type: "bar", labels: ['他说"好"', "北京,上海"],
    series: [{ name: "数量", values: [1, 2] }],
  }));
  const lines = toCsv(spec).split("\n");
  assert.equal(lines[1], '"他说""好""",1');
  assert.equal(lines[2], '"北京,上海",2');
});

test("回答被切成文字和图交替的段落", async () => {
  const { splitChartSegments } = await import(fileURLToPath(new URL("../../src/lib/chart.ts", import.meta.url)));
  const content = '先看结论。\n\n```chart\n{"type":"bar","labels":["a","b"],"series":[{"name":"x","values":[1,2]}]}\n```\n\n所以是这样。';
  const segments = splitChartSegments(content);
  assert.deepEqual(segments.map((s) => s.kind), ["text", "chart", "text"]);
  assert.match(segments[0].text, /先看结论/);
  assert.match(segments[2].text, /所以是这样/);
});

test("没有图的回答原样返回一段", async () => {
  const { splitChartSegments } = await import(fileURLToPath(new URL("../../src/lib/chart.ts", import.meta.url)));
  assert.deepEqual(splitChartSegments("就是一段普通的话"), [{ kind: "text", text: "就是一段普通的话" }]);
});

test("解析不出来的图原样留成文字，不悄悄吞掉模型说的话", async () => {
  const { splitChartSegments } = await import(fileURLToPath(new URL("../../src/lib/chart.ts", import.meta.url)));
  const content = "前面\n```chart\n{坏掉了}\n```\n后面";
  const segments = splitChartSegments(content);
  assert.equal(segments.every((s) => s.kind === "text"), true);
  assert.ok(segments.map((s) => s.text).join("").includes("坏掉了"));
});

test("一段里两张图都切得出来", async () => {
  const { splitChartSegments } = await import(fileURLToPath(new URL("../../src/lib/chart.ts", import.meta.url)));
  const one = '```chart\n{"type":"pie","labels":["a"],"series":[{"name":"x","values":[1]}]}\n```';
  const segments = splitChartSegments(`${one}\n中间\n${one}`);
  assert.deepEqual(segments.map((s) => s.kind), ["chart", "text", "chart"]);
});
