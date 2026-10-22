import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const shortcuts = fs.readFileSync(new URL("../../src/components/ShortcutsPanel.tsx", import.meta.url), "utf8");
const codeBlockView = await import(new URL("../../src/lib/code-block-view.ts", import.meta.url).href);

test("追问建议失败时静默，不打扰主流程", () => {
  const block = main.slice(main.indexOf('ipcMain.handle("followups:suggest"'), main.indexOf('ipcMain.handle("review:summarize"'));
  // 要不到建议是小事，绝不能因此让这一轮看起来出错了。
  assert.match(block, /catch \{[\s\S]*?return \{ ok: false, items: \[\] \}/);
  // 每条限长，不然会冒出一整段话当"建议"。
  assert.match(block, /line\.length <= 40/);
  assert.match(block, /slice\(0, 3\)/);
});

test("追问建议只在回答够长时才要", () => {
  // 一句"好的"后面接三个追问很傻。
  assert.match(app, /answer\.length > 80/);
});

test("⌘F 找当前对话，⇧⌘F 才搜全部历史", () => {
  // 「刚才那句话在哪」比「哪段对话提过」常见得多。
  const start = app.indexOf('key === "f" && event.shiftKey');
  assert.ok(start > 0, "⇧⌘F 分支不见了");
  const plain = app.indexOf('} else if (key === "f") {');
  assert.ok(plain > start, "⌘F 分支要排在 ⇧⌘F 后面，否则永远进不去");
  assert.match(app.slice(plain, plain + 400), /setInChatFind/);

  // 速查面板和命令面板不能继续教旧手势。
  assert.match(shortcuts, /\["⌘F", "在当前对话里找"\]/);
  assert.match(shortcuts, /\["⇧⌘F", "搜全部历史对话"\]/);
  const historyCommandAt = app.indexOf('{ id: "search", label: "搜索历史对话"');
  assert.ok(historyCommandAt > 0, "命令面板里的历史搜索不见了");
  assert.match(app.slice(historyCommandAt, historyCommandAt + 220), /hint: "⇧⌘F"/);
});

test("定时任务只重试临时性的失败，而且只重试一次", () => {
  const schedules = fs.readFileSync(new URL("../../electron/lib/schedules.cjs", import.meta.url), "utf8");
  const block = schedules.slice(schedules.indexOf("const RETRIABLE"), schedules.indexOf("function recordRun"));
  assert.match(block, /attempts < 1/, "不能无限重试");
  // 模型说不出话、参数写错了，重试一百次也是一样的结果。
  for (const transient of ["超时", "429", "503"]) {
    assert.ok(new RegExp(transient).test(block), `${transient} 该算临时问题`);
  }
});

test("自检把磁盘排第一，并给出能照做的建议", () => {
  const block = main.slice(main.indexOf('ipcMain.handle("diagnose:run"'), main.indexOf('ipcMain.handle("storage:sweep"'));
  // 磁盘满了会让别的检查报出看不懂的错——这事真发生过。
  assert.ok(block.indexOf("磁盘空间") < block.indexOf("本机模型"), "磁盘该排第一");
  // 每项都要有 fix，只说"不行"等于没说。
  const items = block.match(/checks\.push\(/g) || [];
  assert.ok(items.length >= 4);
  assert.match(block, /fix:/);
});

test("代码块换行是开关，不是默认", () => {
  // 换行会打乱缩进结构，不能替用户决定。
  assert.deepEqual(codeBlockView.INITIAL_CODE_BLOCK_VIEW, { wrapped: false, numbered: false });
  assert.match(app, /useState<CodeBlockViewState>\(INITIAL_CODE_BLOCK_VIEW\)/);
  assert.match(css, /\.code-block\.wrap pre \{ white-space: pre-wrap/);
});

test("对话内查找整段点亮，不逐字高亮", () => {
  // 一段回答里同一个词可能出现十几次，全标出来反而看不清哪条是哪条。
  assert.match(css, /\.message\.found \{/);
  assert.match(app, /message\.content\.toLowerCase\(\)\.includes\(inChatFind\.toLowerCase\(\)\)/);
});

test("重命名时按 esc 是放弃，不是存一个改了一半的名字", () => {
  const start = app.indexOf("rename-input");
  const block = app.slice(start, app.indexOf(") : (", start));
  assert.match(block, /event\.currentTarget\.value = conversation\.title/);
});

test("清理和自检都不碰凭据", () => {
  for (const name of ["storage:sweep", "diagnose:run"]) {
    const start = main.indexOf(`ipcMain.handle("${name}"`);
    const block = main.slice(start, start + 2600);
    assert.equal(/getApiKey|credentials\.json|setApiKey/.test(block), false, `${name} 碰到了凭据`);
  }
});
