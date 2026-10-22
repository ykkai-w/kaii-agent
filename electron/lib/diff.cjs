const MAX_DIFF_CELLS = 4_000_000;
const MAX_DIFF_LINES = 4000;

function splitLines(text) {
  if (typeof text !== "string") throw new TypeError("差异输入必须是文字");
  return text.length === 0 ? [] : text.split("\n");
}

function longestCommonSubsequence(left, right) {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = left[i] === right[j]
        ? table[(i + 1) * columns + (j + 1)] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + (j + 1)]);
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      operations.push({ type: "equal", text: left[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + (j + 1)]) {
      operations.push({ type: "delete", text: left[i] });
      i += 1;
    } else {
      operations.push({ type: "insert", text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) operations.push({ type: "delete", text: left[i++] });
  while (j < right.length) operations.push({ type: "insert", text: right[j++] });
  return operations;
}

function diffLines(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);

  let middle;
  if ((oldMiddle.length + 1) * (newMiddle.length + 1) > MAX_DIFF_CELLS) {
    middle = [
      ...oldMiddle.map((text) => ({ type: "delete", text })),
      ...newMiddle.map((text) => ({ type: "insert", text })),
    ];
  } else {
    middle = longestCommonSubsequence(oldMiddle, newMiddle);
  }

  return [
    ...oldLines.slice(0, prefix).map((text) => ({ type: "equal", text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map((text) => ({ type: "equal", text })),
  ];
}

function buildHunks(operations, context) {
  const hunks = [];
  let oldLine = 1;
  let newLine = 1;
  let current = null;
  let trailingEqual = 0;
  const pending = [];

  const flush = () => {
    if (!current) return;
    while (current.lines.length && current.lines.at(-1).startsWith(" ") && current.trailing > context) {
      current.lines.pop();
      current.oldCount -= 1;
      current.newCount -= 1;
      current.trailing -= 1;
    }
    hunks.push(current);
    current = null;
  };

  for (const operation of operations) {
    if (operation.type === "equal") {
      if (current) {
        current.lines.push(` ${operation.text}`);
        current.oldCount += 1;
        current.newCount += 1;
        current.trailing += 1;
        if (current.trailing > context * 2) flush();
      } else {
        pending.push({ text: operation.text, oldLine, newLine });
        if (pending.length > context) pending.shift();
      }
      oldLine += 1;
      newLine += 1;
      trailingEqual += 1;
      continue;
    }
    trailingEqual = 0;
    if (!current) {
      const lead = pending.slice();
      current = {
        oldStart: lead[0]?.oldLine ?? oldLine,
        newStart: lead[0]?.newLine ?? newLine,
        oldCount: lead.length,
        newCount: lead.length,
        trailing: 0,
        lines: lead.map((item) => ` ${item.text}`),
      };
      pending.length = 0;
    }
    current.trailing = 0;
    if (operation.type === "delete") {
      current.lines.push(`-${operation.text}`);
      current.oldCount += 1;
      oldLine += 1;
    } else {
      current.lines.push(`+${operation.text}`);
      current.newCount += 1;
      newLine += 1;
    }
  }
  flush();
  void trailingEqual;
  return hunks;
}

function unifiedDiff(oldText, newText, { path: filePath = "file", context = 3 } = {}) {
  if (!Number.isInteger(context) || context < 0 || context > 10) throw new TypeError("context无效");
  if (oldText === newText) return "";
  const operations = diffLines(oldText, newText);
  const hunks = buildHunks(operations, context);
  if (!hunks.length) return "";
  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldCount} +${hunk.newCount === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newCount} @@`,
    ...hunk.lines,
  ]);
  return [...header, ...body].join("\n");
}

function diffStats(oldText, newText) {
  let added = 0;
  let removed = 0;
  for (const operation of diffLines(oldText, newText)) {
    if (operation.type === "insert") added += 1;
    if (operation.type === "delete") removed += 1;
  }
  return { added, removed };
}

function truncateDiff(diff, maxLines = MAX_DIFF_LINES) {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return { diff, truncated: false };
  return { diff: `${lines.slice(0, maxLines).join("\n")}\n… 差异过长，已截断`, truncated: true };
}

module.exports = {
  MAX_DIFF_LINES,
  diffLines,
  diffStats,
  truncateDiff,
  unifiedDiff,
};
