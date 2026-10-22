import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { compareCells, tableToCsv, tableToTsv } from "../lib/table.ts";

// 回答里的表格：点表头排序、一键导 CSV。
//
// 模型给一张十几行的表之后，人第一件想做的事就是「按销量排一下」。
// 原来只能自己拿眼睛扫，或者再问它一遍。
//
// 排序规则要认得数字：`"1,200"` 和 `"￥800"` 按数值比，
// 纯文本按本地化比较（中文按拼音）。混着的话数字排在前面。

export default function SmartTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const result = compareCells(a[sort.column] ?? "", b[sort.column] ?? "");
      return sort.desc ? -result : result;
    });
    return copy;
  }, [rows, sort]);

  return (
    <div className="smart-table">
      <div className="smart-table-bar">
        <span>{rows.length} 行 · {headers.length} 列</span>
        <button
          type="button"
          title="复制整张表，直接粘进 Excel"
          onClick={() => void navigator.clipboard.writeText(tableToTsv(headers, sorted))}
        >
          复制
        </button>
        <button
          type="button"
          title="把这张表存成 CSV"
          onClick={() => {
            // 前面那个 BOM 是给 Excel 看的，没有它中文会乱码。
            const blob = new Blob([`﻿${tableToCsv(headers, sorted)}`], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "表格.csv";
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download size={11} /> CSV
        </button>
      </div>
      <div className="smart-table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={`${header}-${index}`}>
                  <button
                    type="button"
                    title="点一下按这一列排"
                    onClick={() => setSort((current) => (
                      current?.column === index
                        // 第三次点回到原始顺序：排错了想撤销时不用刷新。
                        ? (current.desc ? null : { column: index, desc: true })
                        : { column: index, desc: false }
                    ))}
                  >
                    {header}
                    {sort?.column === index && (sort.desc ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
