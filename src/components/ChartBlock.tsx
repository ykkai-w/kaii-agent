import { BarChart3, Download, Table, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import type { ChartSpec } from "../lib/chart.ts";
import { axisRange, formatTick, pieLayout, seriesColor, toCsv } from "../lib/chart.ts";

const WIDTH = 560;
const HEIGHT = 260;
const PADDING = { top: 18, right: 14, bottom: 34, left: 46 };

const plotWidth = WIDTH - PADDING.left - PADDING.right;
const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

// 标签太密就隔几个显示一个，否则底下会糊成一片。
function labelStride(count: number): number {
  if (count <= 8) return 1;
  return Math.ceil(count / 8);
}

// 折线遇到缺失值必须断开。把 null 简单 filter 掉再画一条 polyline，
// 会把“10、缺测、30”画成一条连续上升趋势，这比不画更会误导人。
function finiteRuns(values: number[]): { index: number; value: number }[][] {
  const runs: { index: number; value: number }[][] = [];
  let current: { index: number; value: number }[] = [];
  values.forEach((value, index) => {
    if (Number.isFinite(value)) {
      current.push({ index, value });
      return;
    }
    if (current.length) runs.push(current);
    current = [];
  });
  if (current.length) runs.push(current);
  return runs;
}

export default function ChartBlock({ spec }: { spec: ChartSpec }) {
  // 柱状还是折线，用户可以自己换——同一组数按大小看和按时间看
  // 常常是两种完全不同的判断。饼图不参与这个切换。
  const [kind, setKind] = useState<ChartSpec["type"]>(spec.type);
  const [showData, setShowData] = useState(false);
  const flat = useMemo(
    () => spec.series.flatMap((item) => item.values).filter((value) => Number.isFinite(value)),
    [spec],
  );
  // 折线图允许不从 0 起（看趋势时贴着 0 画会把变化压扁），
  // 柱状图必须从 0 起——截断的柱子会把 3% 的差看成 3 倍。
  const range = useMemo(
    () => axisRange(flat, { zeroBased: kind === "bar" }),
    [flat, kind],
  );
  const slices = useMemo(
    () => (spec.type === "pie" ? pieLayout(spec.labels, spec.series[0].values) : []),
    [spec],
  );

  const toY = (value: number) =>
    PADDING.top + plotHeight - ((value - range.min) / (range.max - range.min)) * plotHeight;

  const download = () => {
    const blob = new Blob([`﻿${toCsv(spec)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${spec.title || "图表数据"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const stride = labelStride(spec.labels.length);

  return (
    <figure className="chart-block">
      <figcaption>
        <span>{spec.title || "图"}</span>
        {spec.type !== "pie" && (
          <button
            type="button"
            title={kind === "bar" ? "换成折线看趋势" : "换成柱状比大小"}
            onClick={() => setKind(kind === "bar" ? "line" : "bar")}
          >
            {kind === "bar" ? <TrendingUp size={12} /> : <BarChart3 size={12} />}
            {kind === "bar" ? "折线" : "柱状"}
          </button>
        )}
        <button type="button" title="看原始数字" onClick={() => setShowData((value) => !value)}>
          <Table size={12} /> {showData ? "收起" : "数字"}
        </button>
        <button type="button" title="把这张图的数据存成 CSV" onClick={download}>
          <Download size={12} /> 数据
        </button>
      </figcaption>

      {kind === "pie" ? (
        <div className="chart-pie">
          <svg viewBox="0 0 180 180" role="img" aria-label={spec.title || "饼图"}>
            {slices.map((slice, index) => (
              <path key={slice.label} d={slice.path} fill={seriesColor(index)} stroke="var(--surface)" strokeWidth="1" />
            ))}
          </svg>
          <ul className="chart-legend">
            {slices.map((slice, index) => (
              <li key={slice.label}>
                <i style={{ background: seriesColor(index) }} />
                <span>{slice.label}</span>
                <b>{Math.round(slice.share * 1000) / 10}%</b>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={spec.title || "图表"}>
          {range.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                y1={toY(tick)}
                x2={WIDTH - PADDING.right}
                y2={toY(tick)}
                stroke="var(--line)"
                strokeWidth="1"
                // 0 那条线要看得出来，不然有负数时分不清上下。
                strokeDasharray={tick === 0 ? undefined : "2 4"}
              />
              <text x={PADDING.left - 7} y={toY(tick) + 3.5} textAnchor="end" className="chart-tick">
                {formatTick(tick)}
              </text>
            </g>
          ))}

          {kind === "bar" && spec.series.map((series, seriesIndex) => {
            const groupWidth = plotWidth / spec.labels.length;
            const barWidth = Math.max(2, (groupWidth * 0.68) / spec.series.length);
            return series.values.map((value, index) => {
              if (!Number.isFinite(value)) return null;
              const groupLeft = PADDING.left + index * groupWidth + groupWidth * 0.16;
              const zero = toY(0);
              const top = toY(value);
              return (
                <rect
                  key={`${series.name}-${index}`}
                  x={groupLeft + seriesIndex * barWidth}
                  y={Math.min(top, zero)}
                  width={barWidth - 1}
                  height={Math.max(1, Math.abs(zero - top))}
                  fill={seriesColor(seriesIndex)}
                  rx="1"
                >
                  <title>{`${spec.labels[index]} · ${series.name}：${value}${spec.unit}`}</title>
                </rect>
              );
            });
          })}

          {kind === "line" && spec.series.map((series, seriesIndex) => {
            const step = spec.labels.length > 1 ? plotWidth / (spec.labels.length - 1) : 0;
            const runs = finiteRuns(series.values);
            return (
              <g key={series.name}>
                {runs.filter((run) => run.length > 1).map((run, runIndex) => (
                  <polyline
                    key={`${series.name}-run-${runIndex}`}
                    points={run.map(({ index, value }) => (
                      `${PADDING.left + index * step},${toY(value)}`
                    )).join(" ")}
                    fill="none"
                    stroke={seriesColor(seriesIndex)}
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                ))}
                {series.values.map((value, index) => (Number.isFinite(value) ? (
                  <circle
                    key={index}
                    cx={PADDING.left + index * step}
                    cy={toY(value)}
                    r="2.6"
                    fill={seriesColor(seriesIndex)}
                  >
                    <title>{`${spec.labels[index]} · ${series.name}：${value}${spec.unit}`}</title>
                  </circle>
                ) : null))}
              </g>
            );
          })}

          {spec.labels.map((label, index) => {
            if (index % stride !== 0) return null;
            const x = kind === "bar"
              ? PADDING.left + (index + 0.5) * (plotWidth / spec.labels.length)
              : PADDING.left + index * (spec.labels.length > 1 ? plotWidth / (spec.labels.length - 1) : 0);
            return (
              <text key={label + index} x={x} y={HEIGHT - 13} textAnchor="middle" className="chart-tick">
                {label.length > 6 ? `${label.slice(0, 6)}…` : label}
              </text>
            );
          })}
        </svg>
      )}

      {kind !== "pie" && spec.series.length > 1 && (
        <ul className="chart-legend">
          {spec.series.map((series, index) => (
            <li key={series.name}>
              <i style={{ background: seriesColor(index) }} />
              <span>{series.name}</span>
            </li>
          ))}
        </ul>
      )}
      {showData && (
        <div className="chart-data">
          <table>
            <thead>
              <tr><th /> {spec.series.map((item) => <th key={item.name}>{item.name}</th>)}</tr>
            </thead>
            <tbody>
              {spec.labels.map((label, index) => (
                <tr key={label + index}>
                  <th>{label}</th>
                  {spec.series.map((item) => (
                    <td key={item.name}>
                      {Number.isFinite(item.values[index]) ? item.values[index] : "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
