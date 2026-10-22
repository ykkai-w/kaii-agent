import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// 消息两侧的身份必须一眼能分清：kaii 用应用标志，用户用蓝底圆形 Me。
const appSource = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const codeBlockView = await import(new URL("../../src/lib/code-block-view.ts", import.meta.url).href);

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cssSource.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `样式表里找不到规则 ${selector}`);
  return match[1];
}

function atRuleBody(header) {
  const start = cssSource.indexOf(header);
  assert.ok(start >= 0, `样式表里找不到 ${header}`);
  const open = cssSource.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < cssSource.length; index += 1) {
    if (cssSource[index] === "{") depth += 1;
    if (cssSource[index] === "}") depth -= 1;
    if (depth === 0) return cssSource.slice(open + 1, index);
  }
  assert.fail(`${header} 没有正确收尾`);
}

test("kaii 和 Me 头像放在各自的消息一侧", () => {
  assert.match(appSource, /className={`speaker-avatar \$\{message\.role\}`}/);
  assert.match(appSource, /aria-label=\{message\.role === "assistant" \? "kaii-agent" : "Me"\}/);
  assert.match(appSource, /message\.role === "assistant" \? <img src="\.\/logos\/kaii-k-a\.svg"/);
  assert.match(appSource, /<span>Me<\/span>/);

  const assistant = ruleBody(".speaker-avatar.assistant");
  assert.match(assistant, /grid-column:\s*1/);
  const user = ruleBody(".speaker-avatar.user");
  assert.match(user, /grid-column:\s*3/);
  assert.match(user, /border-radius:\s*50%/);
  assert.match(user, /background:\s*#6a9bcc/);
  assert.match(user, /font-style:\s*normal/);
});

test("气泡在中间列，Me 位于用户气泡右侧", () => {
  const message = ruleBody(".message");
  assert.match(message, /grid-template-columns:\s*36px minmax\(0,\s*1fr\) 36px/);
  assert.match(message, /column-gap:\s*11px/);

  const body = ruleBody(".message-body");
  assert.match(body, /grid-column:\s*2/);

  // 用户气泡的观感参数一个都不能变。
  const bubble = ruleBody(".message.user .message-body");
  assert.match(bubble, /justify-self:\s*end/);
  assert.match(bubble, /max-width:\s*88%/);
  assert.match(bubble, /padding:\s*11px 15px/);
  assert.match(bubble, /border-radius:\s*3px 11px 2px 8px/);
  assert.match(bubble, /transform:\s*rotate\(0\.18deg\)/);

  assert.match(body, /font-size:\s*15px/);
  assert.match(body, /line-height:\s*1\.92/);
});

test("400px 迷你窗口不会把正文放进已隐藏的侧栏列", () => {
  const tablet = atRuleBody("@media (max-width: 760px)");
  assert.match(
    tablet,
    /\.app-shell\.sidebar-visible,\s*\.app-shell\.sidebar-hidden\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    "侧栏 display:none 后必须改成单列，否则正文会落进 0px 列",
  );

  const mini = atRuleBody("@media (max-width: 460px)");
  const columns = mini.match(/\.message\s*\{[\s\S]*?grid-template-columns:\s*(\d+)px minmax\(0,\s*1fr\) (\d+)px;[\s\S]*?column-gap:\s*(\d+)px/);
  assert.ok(columns, "迷你消息必须有独立的窄屏列宽");
  const messageWidth = 400 - 20;
  const bodyWidth = messageWidth - Number(columns[1]) - Number(columns[2]) - Number(columns[3]) * 2;
  assert.ok(bodyWidth >= 300, `400px 窗口中正文只剩 ${bodyWidth}px`);
  assert.match(mini, /\.message-body\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(mini, /\.message-body pre,\s*\.code-block\s*\{[\s\S]*?max-width:\s*100%/);
});

test("迷你窗口的代码和输入工具可横滚且复制键仍在右下", () => {
  const mini = atRuleBody("@media (max-width: 460px)");
  assert.match(mini, /\.code-bar\s*\{[\s\S]*?position:\s*static;[\s\S]*?overflow-x:\s*auto/);
  assert.match(mini, /\.code-block \.code-copy\s*\{\s*opacity:\s*1/);
  assert.match(mini, /\.tool-buttons\s*\{[\s\S]*?flex:\s*1 1 100%;[\s\S]*?overflow-x:\s*auto/);
  assert.match(mini, /\.tool-buttons \[data-tip\]::after\s*\{\s*display:\s*none/);
  assert.match(mini, /\.topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(128px,\s*1fr\) minmax\(0,\s*auto\) minmax\(128px,\s*1fr\)/);
  assert.match(mini, /\.scroll-rail\s*\{[\s\S]*?right:\s*0;[\s\S]*?bottom:\s*calc\(var\(--composer-height,\s*160px\) \+ 12px\);[\s\S]*?width:\s*8px/);
  assert.match(mini, /\.scroll-thumb\s*\{[\s\S]*?left:\s*1px;[\s\S]*?width:\s*6px/);
  assert.match(mini, /\.jump-latest\s*\{[\s\S]*?bottom:\s*calc\(var\(--composer-height,\s*160px\) \+ 12px\)/);
  assert.match(mini, /\.inline-error\s*\{[\s\S]*?bottom:\s*calc\(var\(--composer-height,\s*160px\) \+ 12px\)/);

  const copy = ruleBody(".code-block .code-copy");
  assert.match(copy, /right:\s*10px/);
  assert.match(copy, /bottom:\s*18px/);
});

test("输入区占独立网格行，展开后不会盖住最后一条消息", () => {
  const main = ruleBody(".main-panel");
  assert.match(main, /grid-template-rows:\s*54px minmax\(0,\s*1fr\) auto/);
  assert.match(main, /container-type:\s*inline-size/);
  assert.match(ruleBody(".chat-scroll"), /grid-row:\s*2/);
  const composer = ruleBody(".composer-wrap");
  assert.match(composer, /position:\s*relative/);
  assert.match(composer, /grid-row:\s*3/);
  assert.doesNotMatch(composer, /bottom:\s*0/);
  for (const selector of [".scroll-rail", ".jump-latest", ".inline-error"]) {
    assert.match(ruleBody(selector), /grid-row:\s*2/, `${selector} 必须跟随对话行，而不是猜输入区高度`);
  }
  assert.doesNotMatch(ruleBody(".messages"), /padding:[^;]*205px/);
  assert.match(appSource, /new ResizeObserver\(sync\)/);
  assert.match(appSource, /style\.setProperty\("--composer-height"/);
  assert.match(appSource, /<section className="composer-wrap" ref={composerWrap}>/);
});

test("同一份 kaii 标志用于侧栏、首页、AI 头像、启动恢复页和锁屏", () => {
  const marks = appSource.match(/logos\/kaii-k-a\.svg/g) || [];
  assert.equal(marks.length, 5);
  assert.ok(appSource.includes('className="brand-mark"'));
  assert.ok(appSource.includes('className="hero-art"'));
});

test("工具回执后显示不夸大的完成证据", () => {
  const receipts = appSource.indexOf("<ToolReceiptList");
  const evidence = appSource.indexOf("<CompletionEvidenceCard", receipts);
  assert.ok(receipts >= 0 && evidence > receipts, "完成证据要跟在工具回执后面");
  for (const label of ["最近检查通过", "已改动，尚未检查", "任务只完成一部分", "只读完成"]) {
    assert.ok(appSource.includes(label), `缺少状态文案：${label}`);
  }
  assert.match(appSource, /改动 \{evidence\.changedPaths\.length\} 个文件/);
  assert.match(appSource, /最近检查：\{latestCheck\.summary\}/);
  assert.match(cssSource, /\.completion-evidence\s*\{/);
});

test("恢复卡只显示进度和文件漂移状态，不把内部检查点摊到对话里", () => {
  const start = appSource.indexOf("function ResumeCheckpointStatus");
  const block = appSource.slice(start, appSource.indexOf("export default function App", start));
  assert.match(block, /进度已保存/);
  assert.match(block, /文件有变化/);
  assert.match(block, /run\.checkpoint\.workspaceDirty/);
  assert.match(block, /这份进度只能查看；继续改动请另开工程任务/);
  assert.match(block, /个文件需要重新核对/);
  assert.match(block, /plan\.filter[\s\S]*?changedPaths\.filter/);
  for (const sensitive of ["realpath", "failureSummaries", "lastCheck.summary", "changedPaths.map", "run.goal"]) {
    assert.equal(block.includes(sensitive), false, `恢复状态不应显示 ${sensitive}`);
  }
  assert.match(cssSource, /\.resume-status\s*\{/);
  assert.match(cssSource, /\.resume-stale \.resume-dot/);
});

test("启动失败是一张独立纸感恢复页", () => {
  assert.match(cssSource, /\.boot-failed\s*\{/);
  const paper = ruleBody(".boot-paper");
  assert.match(paper, /border-radius:\s*4px 18px 5px 13px/);
  assert.match(paper, /box-shadow:/);
  assert.match(cssSource, /\.boot-actions\s*\{/);
});

// ── 历史搜索与 Markdown 导出 ──────────────────────────────
const storage = await import(new URL("../../src/lib/storage.ts", import.meta.url).href);

function chat(id, title, texts, updatedAt = 1) {
  return {
    id,
    title,
    skillId: "none",
    createdAt: 1,
    updatedAt,
    messages: texts.map((text, index) => ({
      id: `${id}-m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: text,
      createdAt: index,
    })),
  };
}

test("searching history finds the conversation and the exact message", () => {
  const conversations = [
    chat("a", "报销的事", ["出差住宿怎么报", "住宿每晚上限四百二十元。"], 20),
    chat("b", "周末计划", ["周末去哪玩", "可以去公园。"], 30),
    chat("c", "又问报销", ["报销发票要几联", "两联就够。"], 10),
  ];

  const hits = storage.searchConversations(conversations, "报销");
  assert.deepEqual(hits.map((hit) => hit.conversationId), ["a", "c"], "按最近更新排序");
  assert.equal(hits[0].messageId, null, "只命中标题时不跳转到消息");
  assert.equal(hits[1].matchCount, 2, "标题和正文各算一处");

  const inner = storage.searchConversations(conversations, "四百二十");
  assert.equal(inner.length, 1);
  assert.equal(inner[0].messageId, "a-m1");
  assert.match(inner[0].excerpt, /四百二十元/);

  assert.deepEqual(storage.searchConversations(conversations, "  "), []);
  assert.deepEqual(storage.searchConversations(conversations, "根本没有这个词"), []);
  // 大小写不敏感。
  assert.equal(storage.searchConversations([chat("d", "Note", ["Hello World"], 1)], "hello").length, 1);
});

test("a conversation exports to readable Markdown", () => {
  const conversation = chat("a", "报销的事", ["出差住宿怎么报", "每晚上限四百二十元。"], 20);
  conversation.messages[0].document = {
    id: "doc-1",
    name: "员工手册.pdf",
    kind: "pdf",
    pageCount: 12,
    characters: 900,
    sectionCount: 3,
    truncated: false,
    preview: "",
  };
  conversation.messages[1].sources = [{ title: "公司制度", url: "https://example.com/rule", snippet: "", searchedAt: "" }];

  const markdown = storage.conversationToMarkdown(conversation);
  assert.match(markdown, /^# 报销的事$/m);
  assert.match(markdown, /^## 我$/m);
  assert.match(markdown, /^## kaii$/m);
  assert.match(markdown, /> 附了文档：员工手册\.pdf/);
  assert.match(markdown, /每晚上限四百二十元。/);
  assert.match(markdown, /1\. \[公司制度\]\(https:\/\/example\.com\/rule\)/);
  assert.ok(markdown.endsWith("\n"));

  // 空消息不该在导出里留下空标题。
  const withBlank = chat("b", "空的", ["", ""], 1);
  assert.equal(storage.conversationToMarkdown(withBlank).includes("## 我"), false);
});

test("document attachments survive a save and reload round trip", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const conversation = chat("a", "文档问答", ["这份手册说了什么", "说了报销规则。"], 5);
  conversation.messages[0].document = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "手册.pdf",
    kind: "pdf",
    pageCount: 3,
    characters: 400,
    sectionCount: 2,
    truncated: false,
    preview: "报销",
  };

  storage.saveConversations([conversation]);
  const reloaded = storage.loadConversations();
  assert.equal(reloaded[0].messages[0].document.name, "手册.pdf");
  assert.deepEqual(storage.referencedDocumentIds(reloaded), ["11111111-1111-4111-8111-111111111111"]);
});

test("every CSS variable that is used is also defined somewhere", () => {
  // 首页图钉的"头针分家"就是这么来的：样式里写了 var(--paper-warm)，
  // 但这个变量从来没定义过，color-mix 整条声明失效，颈部变透明。
  // 这类问题不报错、不崩溃，只是悄悄少画一块，所以必须由测试兜住。
  const defined = new Set([...cssSource.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const used = new Set([...cssSource.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(\)|,)/gi)].map((match) => match[1]));
  const undefinedVars = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(undefinedVars, [], `样式表用到了没有定义的变量：${undefinedVars.join("、")}`);
  assert.ok(defined.size > 10, "应当确实解析到了变量定义");
});

test("the pin head, collar and needle form one connected shape", () => {
  const head = ruleBody(".paper-pin::before");
  const collar = ruleBody(".paper-pin i");
  const needle = ruleBody(".paper-pin::after");

  const px = (body, property) => {
    // top: 0 这种没有单位的写法也要认。
    const match = body.match(new RegExp(`(?:^|[;{\\s])${property}:\\s*(-?[\\d.]+)(px)?\\s*;`));
    assert.ok(match, `${property} 没找到`);
    return Number(match[1]);
  };

  const headBottom = px(head, "top") + px(head, "height");
  const collarTop = px(collar, "top");
  const collarBottom = collarTop + px(collar, "height");
  const needleTop = px(needle, "top");

  assert.ok(collarTop <= headBottom, `颈部起点 ${collarTop} 必须压在钉帽底 ${headBottom} 之内，不能悬空`);
  assert.ok(needleTop <= collarBottom, `针脚起点 ${needleTop} 必须压在颈部底 ${collarBottom} 之内，不能悬空`);
  // 颈部必须有真实填充，否则头和针中间会出现一段透明的空隙。
  assert.match(collar, /background:\s*color-mix\([^)]*\)/);
});

test("the user bubble contains only what the user typed", () => {
  // 操作按钮放进气泡会把气泡撑宽。用户那侧的按钮必须在 message-body 外面。
  // 气泡 div 现在带双击折叠等属性，锚定类名本身而不是整个开标签。
  const bodyStart = appSource.indexOf('className="message-body"');
  const outsideAt = appSource.indexOf('message-actions outside');
  const articleClose = appSource.indexOf("</article>", bodyStart);
  assert.ok(bodyStart > 0 && outsideAt > 0 && articleClose > 0);

  // 顺序必须是：气泡开始 → 气泡收尾 </div> → 气泡外的操作 → </article>
  assert.ok(bodyStart < outsideAt, "外部操作块应当在气泡之后");
  assert.ok(outsideAt < articleClose, "外部操作块应当仍在这条消息之内");
  assert.ok(appSource.slice(bodyStart, outsideAt).includes("</div>"), "气泡必须先收尾，操作才出现");

  // 编辑重发只应出现一次，且在气泡外那一块里。
  // 注释里提到这四个字不算——这里要管的是界面上真的渲染了几个。
  const withoutComments = appSource.replace(/^\s*\/\/.*$/gm, "");
  const edits = [...withoutComments.matchAll(/编辑重发/g)].map((match) => match.index);
  assert.equal(edits.length, 1, "界面上应当只有一处编辑重发");
  assert.ok(withoutComments.indexOf("message-actions outside") < edits[0], "编辑重发必须在气泡外");

  // 助手那侧的复制/重新生成留在正文内是合理的，那边本来就没有气泡边框。
  assert.ok(appSource.slice(bodyStart, outsideAt).includes("重新生成"));
  assert.match(appSource, /message\.role === "assistant" && !message\.pending/);
});

test("dropping a file is wired end to end, with the sandbox-safe path bridge", () => {
  const preloadSource = fs.readFileSync(new URL("../../electron/preload.cjs", import.meta.url), "utf8");

  // 沙箱渲染进程读不到 File.path，必须走 preload 的 webUtils 才能拿到真实路径。
  assert.match(preloadSource, /webUtils/);
  assert.match(preloadSource, /getPathForFile/);
  assert.match(preloadSource, /handleDroppedFile/);
  assert.equal(appSource.includes("event.dataTransfer.files[0].path"), false, "不能直接读 File.path，沙箱下拿不到");
  assert.match(appSource, /window\.kaiLocal\.pathForFile\(file\)/);

  // 只有真正拖文件才拦截，拖选中的文字不该被当成文件。
  assert.match(appSource, /event\.dataTransfer\.types\.includes\("Files"\)/);
  // enter/leave 会在子元素之间连续触发，必须计数抵消，否则高亮会闪。
  assert.match(appSource, /dragDepth\.current \+= 1/);
  assert.match(appSource, /dragDepth\.current = Math\.max\(0, dragDepth\.current - 1\)/);
  assert.match(appSource, /拿不到这些文件的路径/, "拿不到路径时要给出可操作的提示");
  // 现在一次能拖多个：全部循环收，串行 await（报错才分得清是哪个文件的），
  // 一次最多收 5 个。
  assert.match(appSource, /\.slice\(0, 5\)/);
  assert.match(appSource, /await acceptDroppedFile\(filePath\)/);

  const veil = ruleBody(".drop-veil");
  assert.match(veil, /position:\s*fixed/);
  assert.match(veil, /inset:\s*0/);
});

test("everyday keyboard shortcuts exist and stay out of the way", () => {
  // ⌘ 组合键才拦截；带 ctrl/alt 的组合留给系统和别的软件。
  assert.match(appSource, /if \(!event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey\) return;/);
  assert.match(appSource, /key === "n" && !event\.shiftKey/);
  assert.match(appSource, /key === "f"/);
  assert.match(appSource, /key === ","/);
  assert.match(appSource, /key === "k" && event\.shiftKey/);

  // Esc 只在真的在生成时才抢，且任何弹窗/菜单/候选框打开时都让位。
  assert.match(appSource, /if \(event\.key !== "Escape"\) return;/);
  assert.match(appSource, /document\.querySelector\("\[role='dialog'\], \[role='menu'\], \[role='listbox'\]"\)/);
  assert.match(appSource, /cancelMessage\(requestId\)/);
  assert.match(appSource, /overlay\.classList\.contains\("command-palette"\)/, "命令面板仍应支持 ⌘K 再按一次关闭");
});

test("损坏或更新版对话数据不会被空历史覆写，也不会触发附件清理", () => {
  assert.match(appSource, /loadConversationsWithStatus/);
  assert.match(appSource, /initialConversationStorage\.status === "unsupported" \|\| initialConversationStorage\.status === "corrupt"/);

  const saveAt = appSource.indexOf("const result = saveConversations(conversations)");
  assert.ok(saveAt > 0, "找不到对话自动保存");
  assert.match(appSource.slice(saveAt - 140, saveAt + 120), /if \(conversationStorageBlocked\.current\) return;/);

  const pruneAt = appSource.indexOf("window.kaiLocal.pruneImages");
  assert.ok(pruneAt > 0, "找不到启动附件清理");
  const pruneGuard = appSource.slice(pruneAt - 260, pruneAt + 500);
  assert.match(pruneGuard, /stored\.status === "valid" \|\| stored\.status === "missing"/);
  assert.match(pruneGuard, /referencedAttachmentIds\(stored\.conversations\)/);
  assert.match(pruneGuard, /pruneDocuments/);
});

test("code blocks in answers can be copied in one click", () => {
  assert.match(appSource, /pre: \(\{ children \}\) => <CodeBlock>/);
  assert.match(appSource, /function CodeBlock/);
  // 复制的是解析出来的原始代码，不是渲染后的 DOM 文本。
  assert.match(appSource, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(appSource, /function readCodeNode/);
  assert.match(appSource, /<\/button>\s*<\/div>\s*<button\s+type="button"\s+className="code-copy"/, "复制键应该在顶部工具栏外");
  assert.match(appSource, /className="code-copy"\s+aria-label="复制这段代码"/, "复制键必须保留可访问名称");
  const copy = ruleBody(".code-block .code-copy");
  assert.match(copy, /position:\s*absolute/);
  assert.match(copy, /right:\s*10px/);
  assert.match(copy, /bottom:\s*18px/);
  assert.doesNotMatch(copy, /top\s*:/, "复制键不能再占用顶部控件的位置");
  assert.match(copy, /opacity:\s*0/);
  assert.ok(cssSource.includes(".code-block:hover .code-copy"), "悬停才显示，不然会一直压在代码上");

  const codePre = ruleBody(".code-block pre");
  assert.match(codePre, /padding-bottom:\s*48px/, "底部要给复制键留空，不能挡住最后一行");
  const messagePre = ruleBody(".message-body pre");
  assert.match(messagePre, /overflow:\s*auto/, "长代码仍要能稳定横向滚动");
});

test("代码自动换行和行号在两个开启顺序下都互斥", () => {
  const { INITIAL_CODE_BLOCK_VIEW, toggleCodeBlockView } = codeBlockView;

  let wrapFirst = toggleCodeBlockView(INITIAL_CODE_BLOCK_VIEW, "wrap");
  assert.deepEqual(wrapFirst, { wrapped: true, numbered: false });
  wrapFirst = toggleCodeBlockView(wrapFirst, "numbers");
  assert.deepEqual(wrapFirst, { wrapped: false, numbered: true }, "开行号必须自动关换行");

  let numbersFirst = toggleCodeBlockView(INITIAL_CODE_BLOCK_VIEW, "numbers");
  assert.deepEqual(numbersFirst, { wrapped: false, numbered: true });
  numbersFirst = toggleCodeBlockView(numbersFirst, "wrap");
  assert.deepEqual(numbersFirst, { wrapped: true, numbered: false }, "开换行必须自动关行号");

  // 即使以后状态水合或重构绕过了初始值，reducer 也先把非法状态归一化。
  for (const action of ["wrap", "numbers"]) {
    const recovered = toggleCodeBlockView({ wrapped: true, numbered: true }, action);
    assert.equal(recovered.wrapped && recovered.numbered, false, `${action} 不能继续传播冲突状态`);
    assert.deepEqual(
      recovered,
      action === "wrap" ? { wrapped: true, numbered: false } : { wrapped: false, numbered: true },
    );
  }

  assert.match(appSource, /toggleCodeBlockView\(current, "numbers"\)/, "行号按钮必须走受测状态机");
  assert.match(appSource, /toggleCodeBlockView\(current, "wrap"\)/, "换行按钮必须走受测状态机");
});

test("syntax highlighting is wired with themed colours in both modes", () => {
  assert.match(appSource, /import \{ highlightCode \} from "\.\/lib\/highlight"/);
  assert.match(appSource, /highlightCode\(code, language\)/);
  // highlight.js 产出的是 hljs-* span，输入已转义，这里才敢用 dangerouslySetInnerHTML。
  assert.match(appSource, /dangerouslySetInnerHTML=\{\{ __html: highlighted\.html \}\}/);

  for (const token of ["--code-keyword", "--code-string", "--code-number", "--code-title", "--code-attr", "--code-muted"]) {
    // 浅色、深色、跟随系统三处都要定义，少一处就会在那个模式下变成继承色。
    const occurrences = (cssSource.match(new RegExp(`${token}:`, "g")) || []).length;
    assert.ok(occurrences >= 3, `${token} 只定义了 ${occurrences} 处，明暗模式会缺色`);
  }
  assert.ok(cssSource.includes(".hljs-keyword"), "缺少高亮样式");
  assert.ok(cssSource.includes(".hljs-string"), "缺少高亮样式");
});

// ── 侧栏预览（对标 Artifacts） ──────────────────────────────
const artifacts = await import(new URL("../../src/lib/artifacts.ts", import.meta.url).href);

test("only substantial code blocks get promoted to the side panel", () => {
  const short = "看这个：\n```js\nconst a = 1;\n```\n就这样。";
  assert.deepEqual(artifacts.extractArtifacts("m1", short), [], "短片段留在原地，不该升级");
  assert.deepEqual(artifacts.extractArtifacts("m1", "没有代码块的普通回答"), []);

  const body = Array.from({ length: 20 }, (_, index) => `  console.log(${index});`).join("\n");
  const long = `改好了：\n\`\`\`javascript\nfunction render() {\n${body}\n}\n\`\`\`\n跑一下试试。`;
  const found = artifacts.extractArtifacts("m2", long);
  assert.equal(found.length, 1);
  assert.equal(found[0].language, "javascript");
  assert.equal(found[0].title, "render", "标题应当从代码里认出函数名");
  assert.equal(found[0].fileName, "render.js");
  assert.ok(found[0].lineCount >= 20);
  assert.equal(found[0].code.includes("```"), false, "围栏本身不该进内容");
});

test("an unterminated fence is ignored so streaming never half-opens a panel", () => {
  // 流式输出到一半时只有开头的 ```，这时不能就判定成一个代码块。
  const streaming = "我来写：\n```python\ndef main():\n    print(1)\n";
  assert.deepEqual(artifacts.extractArtifacts("m3", streaming), []);
});

test("artifacts fall back sensibly when there is no language or name", () => {
  const plain = `\`\`\`\n${Array.from({ length: 15 }, (_, i) => `第 ${i} 行内容`).join("\n")}\n\`\`\``;
  const found = artifacts.extractArtifacts("m4", plain);
  assert.equal(found.length, 1);
  assert.equal(found[0].language, null);
  assert.equal(found[0].fileName.endsWith(".txt"), true);
  assert.match(artifacts.artifactSummary(found[0]), /^\d+ 行 · /);

  const markdown = `\`\`\`markdown\n# 项目说明\n${Array.from({ length: 14 }, () => "正文一行").join("\n")}\n\`\`\``;
  const doc = artifacts.extractArtifacts("m5", markdown);
  assert.equal(doc[0].title, "项目说明", "Markdown 用标题当名字");
  assert.equal(doc[0].fileName, "项目说明.md");
});

test("several artifacts in one answer get stable distinct ids", () => {
  const block = (name) => `\`\`\`python\ndef ${name}():\n${Array.from({ length: 14 }, () => "    pass").join("\n")}\n\`\`\``;
  const found = artifacts.extractArtifacts("m6", `${block("alpha")}\n\n中间说明\n\n${block("beta")}`);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((item) => item.title), ["alpha", "beta"]);
  assert.equal(new Set(found.map((item) => item.id)).size, 2);
  assert.deepEqual(artifacts.extractArtifacts("m6", `${block("alpha")}\n\n中间说明\n\n${block("beta")}`).map((i) => i.id), found.map((i) => i.id), "同样输入必须给出同样的 id");
});

test("the panel is wired into the chat and closes when switching conversations", () => {
  assert.match(appSource, /import ArtifactPanel from "\.\/components\/ArtifactPanel"/);
  assert.match(appSource, /artifactsByMessage\.get\(message\.id\)/);
  assert.match(appSource, /openArtifact && <ArtifactPanel/);
  // 切换对话必须关掉面板，否则看到的是上一段对话的内容。
  assert.match(appSource, /saveActiveConversationId\(activeId\);\s*\n\s*setOpenArtifact\(null\);/);
  // 只对写完的回答提取，避免流式输出时反复重算。
  assert.match(appSource, /message\.pending \|\| !message\.content\.includes\("```"\)/);
});

// ── 项目分组 ──────────────────────────────
const projectsLib = await import(new URL("../../src/lib/projects.ts", import.meta.url).href);

function installStorage() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  return store;
}

test("conversations group under projects, newest project first, loose ones last", () => {
  const projects = [
    { id: "p1", name: "改简历", instructions: "", createdAt: 1, updatedAt: 1 },
    { id: "p2", name: "写论文", instructions: "背景", createdAt: 2, updatedAt: 2 },
    { id: "p3", name: "空项目", instructions: "", createdAt: 3, updatedAt: 30 },
  ];
  const conversations = [
    { id: "c1", projectId: "p1", updatedAt: 10 },
    { id: "c2", projectId: "p2", updatedAt: 50 },
    { id: "c3", updatedAt: 20 },
    { id: "c4", projectId: "p1", updatedAt: 40 },
    { id: "c5", projectId: "已删掉的项目", updatedAt: 5 },
  ];

  const groups = projectsLib.groupConversations(conversations, projects);
  assert.deepEqual(groups.map((group) => group.project?.name ?? "未分组"), ["写论文", "改简历", "空项目", "未分组"]);
  assert.deepEqual(groups[0].conversationIds, ["c2"]);
  assert.deepEqual(groups[1].conversationIds, ["c1", "c4"]);
  assert.deepEqual(groups[2].conversationIds, [], "空项目也要露出来，否则像没建成功");
  // 指向已删项目的对话要落回未分组，不能凭空消失。
  assert.deepEqual(groups[3].conversationIds, ["c3", "c5"]);

  assert.deepEqual(projectsLib.groupConversations([], []), []);
});

test("project instructions are looked up safely", () => {
  const projects = [{ id: "p1", name: "改简历", instructions: "  目标是量化岗  ", createdAt: 1, updatedAt: 1 }];
  assert.equal(projectsLib.projectInstructionsFor(projects, "p1"), "目标是量化岗");
  assert.equal(projectsLib.projectInstructionsFor(projects, "不存在"), "");
  assert.equal(projectsLib.projectInstructionsFor(projects, undefined), "");
  assert.equal(projectsLib.projectInstructionsFor([], "p1"), "");
});

test("projects survive a save and reload, and junk is dropped", () => {
  installStorage();
  const project = projectsLib.createProject("  改  简历  ");
  assert.equal(project.name, "改 简历");
  assert.equal(project.instructions, "");

  projectsLib.saveProjects([project]);
  const reloaded = projectsLib.loadProjects();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].name, "改 简历");

  localStorage.setItem("kaii.projects.v1", JSON.stringify([
    { id: "ok", name: "正常", instructions: "x", createdAt: 1, updatedAt: 2 },
    { name: "缺 id", createdAt: 1 },
    "不是对象",
    { id: "缺时间", name: "x" },
  ]));
  assert.deepEqual(projectsLib.loadProjects().map((item) => item.id), ["ok"]);

  localStorage.setItem("kaii.projects.v1", "不是 JSON");
  assert.deepEqual(projectsLib.loadProjects(), []);

  assert.equal(projectsLib.createProject("   ").name, "新项目");
  assert.equal(projectsLib.normalizeProjectName("a".repeat(80)).length, projectsLib.MAX_PROJECT_NAME);
});

test("the chat request carries project background, and deleting a project keeps its chats", () => {
  // 项目背景每次提问都要带上，这正是"不用重复交代"的意思。
  assert.match(appSource, /const projectContextForSend = \(?projectInstructionsFor\(projects, activeConversation\.projectId\)/);
  assert.match(appSource, /const projectContext = targetProvider === "local"[\s\S]*?outboundPrivacy\.redactedMessages\[0\]/);
  assert.match(appSource, /\.\.\.\(projectContext \? \{ projectContext \} : \{\}\)/);
  // 删项目不该连带删对话，只把它们变成未分组。
  assert.match(appSource, /conversation\.projectId === id \? \{ \.\.\.conversation, projectId: undefined \}/);
  // 在项目里新建对话应当留在这个项目。
  assert.match(appSource, /newConversation\(activeConversation\?\.skillId \|\| "none", activeConversation\?\.projectId\)/);
});

test("project documents persist, cap out, and survive junk", () => {
  installStorage();
  const project = projectsLib.createProject("论文");
  assert.deepEqual(project.documents, []);

  const withDocs = {
    ...project,
    documents: Array.from({ length: 12 }, (_, index) => ({
      id: `doc-${index}`, name: `文件${index}.pdf`, kind: "pdf", pageCount: index, characters: 100,
    })),
  };
  projectsLib.saveProjects([withDocs]);
  const reloaded = projectsLib.loadProjects();
  assert.equal(reloaded[0].documents.length, projectsLib.MAX_PROJECT_DOCUMENTS, "超出上限要截断");
  assert.equal(reloaded[0].documents[0].name, "文件0.pdf");

  localStorage.setItem("kaii.projects.v1", JSON.stringify([{
    id: "p", name: "杂项", createdAt: 1, documents: [
      { id: "ok", name: "正常.txt", kind: "text", pageCount: 0, characters: 5 },
      { name: "缺 id" },
      "不是对象",
      { id: "怪类型", name: "x.bin", kind: "谁知道" },
    ],
  }]));
  const cleaned = projectsLib.loadProjects()[0].documents;
  assert.deepEqual(cleaned.map((item) => item.id), ["ok", "怪类型"]);
  assert.equal(cleaned[1].kind, "text", "认不出的类型退回 text");

  assert.deepEqual(projectsLib.projectDocumentIdsFor([withDocs], withDocs.id).slice(0, 2), ["doc-0", "doc-1"]);
  assert.deepEqual(projectsLib.projectDocumentIdsFor([withDocs], "不存在"), []);
  assert.deepEqual(projectsLib.projectDocumentIdsFor([], undefined), []);
});

test("long answers fold at a sentence boundary, short ones never fold", () => {
  // 折叠点要落在自然断句上，不能从半句话中间切开。
  assert.match(appSource, /const LONG_ANSWER_CHARACTERS = \d+;/);
  assert.match(appSource, /function foldPoint/);
  assert.match(appSource, /window\.search\(\/\\n\\n\|\[。！？\]/);
  assert.match(appSource, /展开全文（还有 \{content\.length - shown\.length\} 字）/);
  // 只有超过阈值才折。
  assert.match(appSource, /const tooLong = .*content\.length > LONG_ANSWER_CHARACTERS;/);
  // 带图的回答不折：折点落在 chart 围栏中间会把图切坏。
  assert.match(appSource, /const hasChart = content\.includes\("```chart"\);/);
  assert.match(appSource, /const tooLong = !hasChart &&/);
  // 展开状态按消息记，切换对话不该把别人的展开状态带过去。
  assert.match(appSource, /setExpandedMessages\(\(current\) => new Set\(current\)\.add\(message\.id\)\)/);
});

test("selecting text inside an answer offers a quote-and-ask action", () => {
  // 只认落在助手回答里的选区，选中侧栏或输入框的文字不该弹这个按钮。
  assert.match(appSource, /\.closest\?\.\("\.message\.assistant \.message-body"\)/);
  assert.match(appSource, /text\.length < 2 \|\| text\.length > 2000/);
  // 引用要变成 Markdown 引用块，并接在已有草稿后面而不是覆盖它。
  assert.match(appSource, /map\(\(line\) => `> \$\{line\}`\)/);
  assert.match(appSource, /current\.trim\(\) \? `\$\{current\.trim\(\)\}/);
  const quote = ruleBody(".quote-button");
  assert.match(quote, /position:\s*fixed/);
});

test("项目拖过一次后按 sortIndex 手动排序，没拖过仍按最近活跃", async () => {
  const { groupConversations } = await import("../../src/lib/projects.ts");
  const base = { instructions: "", documents: [], createdAt: 1, updatedAt: 1 };
  const conversations = [
    { id: "c1", projectId: "p1", updatedAt: 100 },
    { id: "c2", projectId: "p2", updatedAt: 900 },
  ];
  // 没有 sortIndex：p2 更近活跃，排前面
  const auto = groupConversations(conversations, [
    { ...base, id: "p1", name: "甲" },
    { ...base, id: "p2", name: "乙" },
  ]);
  assert.deepEqual(auto.map((group) => group.project?.id), ["p2", "p1"]);
  // 有 sortIndex：完全按用户拖出来的顺序，活跃度靠边站
  const manual = groupConversations(conversations, [
    { ...base, id: "p1", name: "甲", sortIndex: 0 },
    { ...base, id: "p2", name: "乙", sortIndex: 1 },
  ]);
  assert.deepEqual(manual.map((group) => group.project?.id), ["p1", "p2"]);
});

test("项目颜色点只收 #rrggbb，坏值一刷新就丢", async () => {
  const { loadProjects } = await import("../../src/lib/projects.ts");
  const base = { instructions: "", documents: [], createdAt: 1, updatedAt: 1 };
  globalThis.localStorage = {
    getItem: () => JSON.stringify([
      { ...base, id: "a", name: "好色", color: "#a9682f", sortIndex: 3 },
      { ...base, id: "b", name: "坏色", color: "javascript:alert(1)" },
    ]),
    setItem: () => {},
  };
  const loaded = loadProjects();
  assert.equal(loaded[0].color, "#a9682f");
  assert.equal(loaded[0].sortIndex, 3);
  assert.equal(loaded[1].color, undefined);
  delete globalThis.localStorage;
});

test("composer 是两列网格：插进去的提示条必须整行跨列，否则输入框被挤进 42px", () => {
  // 真实翻过车：立答条/斜杠条作为网格子项被自动放置，输入框塌进发送键那列。
  const instantRule = ruleBody(".instant-bar");
  const slashRule = ruleBody(".slash-hints");
  assert.match(instantRule, /grid-column:\s*1\s*\/\s*-1/);
  assert.match(slashRule, /grid-column:\s*1\s*\/\s*-1/);
});

test("空状态的问候容器占 title 网格区，日期不再被甩到 logo 下面", () => {
  assert.match(ruleBody(".empty-title"), /grid-area:\s*title/);
  assert.ok(appSource.includes('<div className="empty-title">'), "问候语要包进 empty-title 容器");
});
