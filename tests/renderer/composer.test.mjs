import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { fillPromptVariables } = await import(fileURLToPath(new URL("../../src/lib/prompts.ts", import.meta.url)));
const { keepMenuClickInside } = await import(fileURLToPath(new URL("../../src/lib/menu-events.ts", import.meta.url)));
const {
  commitChatRevision,
  continuationReasonForStop,
  disableResumedRunInRevision,
  prepareChatRevision,
  recoverableRevisionAssistant,
  revisionBlocksConversationMutation,
  revisionOutboundMessages,
  shouldEnrichRevisionResult,
} = await import(fileURLToPath(new URL("../../src/lib/chat-revisions.ts", import.meta.url)));
const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
const auditPanel = fs.readFileSync(new URL("../../src/components/AuditPanel.tsx", import.meta.url), "utf8");
const types = fs.readFileSync(new URL("../../src/types.ts", import.meta.url), "utf8");
const globals = fs.readFileSync(new URL("../../src/global.d.ts", import.meta.url), "utf8");
const { agentRunResumeAvailability } = await import(fileURLToPath(new URL("../../src/types.ts", import.meta.url)));

test("指令变量填得对", () => {
  const now = new Date();
  assert.match(fillPromptVariables("今天是 {{今天}}"), new RegExp(`${now.getFullYear()}年`));
  assert.match(fillPromptVariables("{{星期}}"), /^星期[日一二三四五六]$/);
  assert.match(fillPromptVariables("{{现在}}"), /^\d{2}:\d{2}$/);
  assert.equal(fillPromptVariables("改写：{{选中}}", { selection: "这段话" }), "改写：这段话");
});

test("认不出的变量原样留着，不悄悄换成空", () => {
  // 换成空的话用户会以为自己指令写错了，而不是这里不支持。
  assert.equal(fillPromptVariables("未知 {{乱写}}"), "未知 {{乱写}}");
  // 没有选中内容时也保持原样，让人看得出是「这次没选中」。
  assert.equal(fillPromptVariables("{{选中}}"), "{{选中}}");
});

test("我的指令点自己时不被全局关闭，点外面才关", () => {
  let stopped = false;
  keepMenuClickInside({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);

  // 纯函数必须真接到 picker 容器，这样按钮、菜单和删除键
  // 都不会再冒泡到 window 的“关闭菜单”监听器。
  assert.match(app, /className="prompt-picker" onClick=\{keepMenuClickInside\}/);
  assert.match(app, /window\.addEventListener\("click", closeMenus\)/);
});

function revisionConversation() {
  return {
    id: "source-chat",
    title: "原对话",
    skillId: "none",
    createdAt: 1,
    updatedAt: 6,
    messages: [
      { id: "u1", role: "user", content: "第一问", createdAt: 1 },
      { id: "a1", role: "assistant", content: "第一答", createdAt: 2 },
      { id: "u2", role: "user", content: "原来的第二问", createdAt: 3 },
      { id: "a2", role: "assistant", content: "必须保留的旧回答", createdAt: 4 },
      { id: "u3", role: "user", content: "后面的追问", createdAt: 5 },
      { id: "a3", role: "assistant", content: "后面的回答", createdAt: 6 },
    ],
  };
}

test("编辑重发先做不可变计划，成功才生成分支", () => {
  const source = revisionConversation();
  const before = JSON.stringify(source);
  const originalMessages = source.messages;
  const plan = prepareChatRevision(source, { kind: "edit", targetMessageId: "u2" }, {
    content: "修改后的第二问",
    branchId: "branch-edit",
    userMessageId: "u-edit",
    assistantMessageId: "a-edit",
    createdAt: 20,
  });
  assert.ok(plan);
  assert.deepEqual(revisionOutboundMessages(plan).map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "修改后的第二问" },
  ], "发送上下文必须停在被编辑问题之前，不能夹带旧回答和后续消息");
  assert.equal(JSON.stringify(source), before, "进入编辑和准备发送都不能截断原历史");
  assert.strictEqual(source.messages, originalMessages, "失败时不用回拼数组，原消息数组本来就没动");

  const branch = commitChatRevision(source, plan, {
    ...plan.assistantMessage,
    content: "修改后的回答",
    pending: false,
  }, 30);
  assert.equal(JSON.stringify(source), before, "成功提交分支也不能改写原对话");
  assert.strictEqual(source.messages, originalMessages);
  assert.deepEqual(branch.messages.map(({ content }) => content), ["第一问", "第一答", "修改后的第二问", "修改后的回答"]);
  assert.deepEqual(branch.branchedFrom, { conversationId: "source-chat", title: "原对话" });
});

test("重新生成不发送旧回答，失败时旧回答仍原样可见", () => {
  const source = revisionConversation();
  const before = structuredClone(source);
  const plan = prepareChatRevision(source, { kind: "regenerate", targetMessageId: "a2" }, {
    content: "原来的第二问",
    branchId: "branch-regenerate",
    userMessageId: "u-regenerate",
    assistantMessageId: "a-regenerate",
    createdAt: 40,
  });
  assert.ok(plan);
  const outbound = revisionOutboundMessages(plan);
  assert.deepEqual(outbound.map(({ content }) => content), ["第一问", "第一答", "原来的第二问"]);
  assert.equal(outbound.some(({ content }) => content === "必须保留的旧回答"), false);
  assert.equal(outbound.some(({ content }) => content === "后面的追问"), false);

  // 路由、模型启动、IPC 或生成失败时不会调用 commit；源对象就是完整恢复点。
  assert.deepEqual(source, before);
  assert.equal(source.messages.find(({ id }) => id === "a2")?.content, "必须保留的旧回答");
});

test("可恢复的改写错误原子落成可见分支，原对话不变", () => {
  const source = {
    ...revisionConversation(),
    pinned: true,
    archived: true,
    deletedAt: 99,
  };
  const before = structuredClone(source);
  const plan = prepareChatRevision(source, { kind: "edit", targetMessageId: "u2" }, {
    content: "改写后的问题",
    branchId: "branch-recoverable",
    userMessageId: "u-recoverable",
    assistantMessageId: "a-recoverable",
    createdAt: 50,
  });
  assert.ok(plan);
  const interrupted = recoverableRevisionAssistant({
    ...plan.assistantMessage,
    content: "已经做了一半",
    reasoning: "部分推理",
    toolCalls: [{ callId: "call-1", name: "read_file", status: "done" }],
    completion: { status: "partial", summary: "已检查一部分" },
    runId: "run-new",
    continuable: true,
    continueReason: "interrupted",
  }, "这次暂停了，可以从这里继续。");
  assert.ok(interrupted);
  const branch = commitChatRevision(source, plan, interrupted, 60);

  assert.deepEqual(source, before, "分支失败不能篡改原对话或其隐藏状态");
  assert.deepEqual(branch.messages.map(({ content }) => content), ["第一问", "第一答", "改写后的问题", "已经做了一半"]);
  assert.equal(branch.messages.at(-1)?.pending, false);
  assert.equal(branch.messages.at(-1)?.error, true);
  assert.equal(branch.messages.at(-1)?.runId, "run-new");
  assert.equal(branch.messages.at(-1)?.continuable, true);
  assert.equal(branch.messages.at(-1)?.continueReason, "interrupted");
  assert.equal(branch.messages.at(-1)?.reasoning, "部分推理");
  assert.equal(branch.messages.at(-1)?.completion?.status, "partial");
  assert.equal(branch.archived, false, "分支必须在主列表可见");
  assert.equal(branch.deletedAt, undefined);
  assert.equal(branch.pinned, false);
  assert.deepEqual(branch.branchedFrom, { conversationId: source.id, title: source.title });
});

test("空的可恢复改写也保留继续入口，普通错误仍不建分支", () => {
  const source = revisionConversation();
  const plan = prepareChatRevision(source, { kind: "regenerate", targetMessageId: "a2" }, {
    content: "原来的第二问",
    branchId: "branch-empty",
    userMessageId: "u-empty",
    assistantMessageId: "a-empty",
    createdAt: 70,
  });
  assert.ok(plan);
  const recoverable = recoverableRevisionAssistant({
    ...plan.assistantMessage,
    runId: "run-empty",
    continuable: true,
    continueReason: "truncated",
  }, "这次暂停了，可以从这里继续。");
  assert.equal(recoverable?.content, "这次暂停了，可以从这里继续。");
  assert.equal(recoverable?.runId, "run-empty");
  assert.equal(recoverable?.error, true);
  assert.equal(recoverableRevisionAssistant(plan.assistantMessage, "不会用到"), null);
  assert.equal(recoverableRevisionAssistant({ ...plan.assistantMessage, continuable: true }, "没有检查点"), null,
    "没有 runId 不能造出点不动的假继续入口");
  assert.equal(continuationReasonForStop("truncated"), "truncated");
  assert.equal(continuationReasonForStop("max-rounds"), "rounds");
  assert.equal(continuationReasonForStop("stuck"), "rounds", "stuck 的审计任务也必须留恢复入口");
  assert.equal(continuationReasonForStop("answer"), null);
  assert.equal(shouldEnrichRevisionResult(true, "truncated"), false);
  assert.equal(shouldEnrichRevisionResult(true, "max-rounds"), false);
  assert.equal(shouldEnrichRevisionResult(true, "stuck"), false);
  assert.equal(shouldEnrichRevisionResult(true, "answer"), true);
  assert.equal(shouldEnrichRevisionResult(false, "stuck"), true, "普通对话保持既有行为");
});

test("恢复改写会永久关掉旧入口，且只锁住改写源对话", () => {
  const source = revisionConversation();
  source.messages[1] = { ...source.messages[1], runId: "run-old", continuable: true };
  const plan = prepareChatRevision(source, { kind: "edit", targetMessageId: "u2" }, {
    content: "再改一次",
    branchId: "branch-resumed",
    userMessageId: "u-resumed",
    assistantMessageId: "a-resumed",
    createdAt: 80,
  });
  assert.ok(plan);
  const nextPlan = disableResumedRunInRevision(plan, "run-old");
  assert.equal(plan.prefixMessages[1].continuable, true, "不能回头改写已冻结计划");
  assert.equal(nextPlan.prefixMessages[1].continuable, false);
  const branch = commitChatRevision(source, nextPlan, { ...nextPlan.assistantMessage, content: "续上了" }, 90);
  assert.equal(branch.messages.find(({ runId }) => runId === "run-old")?.continuable, false);
  assert.equal(revisionBlocksConversationMutation(source.id, source.id), true);
  assert.equal(revisionBlocksConversationMutation(source.id, "another-chat"), false);
  assert.equal(revisionBlocksConversationMutation(null, source.id), false);
});

test("编辑态有明确取消入口，普通流式失败只清临时结果", () => {
  const editBlock = app.slice(app.indexOf("const startEdit"), app.indexOf("const send = useCallback"));
  assert.doesNotMatch(editBlock, /messages:\s*conversation\.messages\.slice/, "点编辑时不能先截历史");
  assert.match(editBlock, /setEditSession/);
  assert.match(editBlock, /const cancelEdit/);
  assert.match(app, /className="edit-session"[\s\S]*?onClick=\{cancelEdit\}/);
  assert.match(app, /const recoverable = completed && revisionError[\s\S]*?recoverableRevisionAssistant/);
  assert.match(app, /revisionStage\.current = null;[\s\S]*?setRevisionPreview\(null\)/);
});

test("每段对话记自己的草稿", () => {
  // 原来是全局一个 draft，切走再切回来打了一半的字就没了。
  assert.match(app, /draftsByConversation = useRef\(new Map<string, string>\(\)\)/);
  const block = app.slice(app.indexOf("// 切换对话时把当前草稿收起来"), app.indexOf("// 切换对话时把当前草稿收起来") + 1100);
  assert.match(block, /draftsByConversation\.current\.set\([\s\S]*?previousActiveId\.current,[\s\S]*?leavingEdit \? editSession\.previousDraft : draft/);
  assert.match(block, /setDraft\(draftsByConversation\.current\.get\(activeId\) \?\? ""\)/);
  // draft 不能进依赖，否则每打一个字就跑一遍。
  assert.match(block, /\}, \[activeId\]\)/);
});

test("↑ 只在输入框空着时才调历史", () => {
  const renameBlock = app.slice(app.indexOf('className="rename-input"'), app.indexOf('className="conversation-more"'));
  const composerStart = app.indexOf("ref={composer}");
  const composerBlock = app.slice(composerStart, app.indexOf("{requestId ?", composerStart));
  assert.doesNotMatch(renameBlock, /historyBack|ArrowUp|ArrowDown/, "重命名框不能抢聊天历史键");
  assert.match(composerBlock, /event\.key === "ArrowUp" && !draft && !requestId/);
  assert.match(composerBlock, /event\.key === "ArrowDown" && historyBack\.current > 0/);
  assert.ok(composerBlock.indexOf("fileHints.length > 0") < composerBlock.indexOf('event.key === "ArrowUp" && !draft'), "@文件提示优先处理方向键");
  // 手动改字要把翻页位置归零，否则再按 ↑ 会跳到奇怪的地方。
  assert.match(app, /historyBack\.current = 0;\s*\n\s*setDraft\(event\.target\.value\)/);
});

test("会话行只留一个更多入口，所有操作都在同一菜单", () => {
  const start = app.indexOf('className={`conversation-row');
  const block = app.slice(start, app.indexOf("group-empty", start));
  assert.match(block, /className="conversation-more"/);
  assert.match(block, /className="conversation-menu"/);
  for (const label of ["改名", "移到项目", "PDF", "网页", "Markdown", "标签", "归档", "置顶", "删除"]) {
    assert.ok(block.includes(label), `菜单缺少 ${label}`);
  }
  for (const legacy of ["row-action", "row-project", "pin-chat", "delete-chat", "export-menu"]) {
    assert.equal(app.includes(legacy), false, `旧的透明点击区 ${legacy} 还在`);
  }
  assert.match(app, /if \(event\.key !== "Escape"\) return;[\s\S]*?setConversationMenu\(null\)/);
  const activeEffect = app.slice(app.indexOf("saveActiveConversationId(activeId)"), app.indexOf("saveActiveConversationId(activeId)") + 180);
  assert.match(activeEffect, /setConversationMenu\(null\)/, "切换对话必须关菜单");
});

test("顶栏只留迷你、仅本机、三态外观和设置", () => {
  const start = app.indexOf('className="topbar-actions"');
  const block = app.slice(start, app.indexOf("</header>", start));
  assert.equal((block.match(/<button/g) || []).length, 4);
  assert.doesNotMatch(block, /ClipboardList|复制整段/);
  assert.equal((block.match(/data-tip=/g) || []).length, 4);
  assert.match(block, /cycleTheme\(\)/);
  // 仅本机开关：图标和文字随状态换，且真的把 localOnly 写回设置。
  assert.match(block, /localOnly \? <WifiOff/);
  assert.match(block, /className={`icon-button network-mode/);
  assert.match(block, /localOnly && <span>仅本机<\/span>/);
  assert.match(block, /toggleLocalOnly\(\)/);
  const localOnlyToggle = app.slice(app.indexOf("const toggleLocalOnly"), app.indexOf("const toggleLocalOnly") + 1600);
  assert.match(localOnlyToggle, /updateSettings\(\{ localOnly: next \}\)/);
  assert.match(localOnlyToggle, /setLocalOnlyBusy\(true\)/);
  assert.match(localOnlyToggle, /sendWebOnce\.current = null/);
  assert.match(localOnlyToggle, /localOnlyBusy \|\| requestId/);
  assert.match(block, /disabled={!settings \|\| localOnlyBusy \|\| Boolean\(requestId\)}/);
  const theme = app.slice(app.indexOf("const cycleTheme"), app.indexOf("const cycleTheme") + 620);
  assert.match(theme, /"system" \? "dark"[\s\S]*?"dark" \? "light" : "system"/);
  assert.match(theme, /document\.documentElement\.dataset\.theme = result\.settings\.theme/);
  const title = app.slice(app.indexOf('className="topbar-title"'), start);
  assert.doesNotMatch(title, /<small>/, "顶栏不再显示第二行副标题");
});

test("设置保存失败留在固定底栏里", () => {
  const panel = app.slice(app.indexOf("function SettingsPanel"));
  const footer = panel.slice(panel.indexOf("<footer>"), panel.indexOf("</footer>") + 9);
  assert.match(footer, /settings-save-error/);
  assert.match(footer, /role="alert"/);
  assert.match(css, /\.settings-panel > footer \.settings-save-error/);
});

test("迷你窗口左上角菜单会回到完整窗口，不再点击无反应", () => {
  const start = app.indexOf('className="icon-button sidebar-toggle"');
  const block = app.slice(start, app.indexOf("</button>", start));
  assert.match(block, /miniMode \? "回到完整窗口并打开侧边栏" : "切换侧边栏"/);
  assert.match(block, /if \(miniMode\)/);
  assert.match(block, /setSidebarOpen\(true\)/);
  assert.match(block, /setMiniWindow\(false\)/);
});

test("API key 的两个操作收进同一组，不再掉到下一行错位", () => {
  const start = app.indexOf('className="settings-providers"');
  const block = app.slice(start, app.indexOf('className="settings-grid"', start));
  assert.match(block, /className="key-actions"/);
  assert.match(block, /item\.configured && editingKey !== item\.id/);
  assert.match(block, /item\.configured && <div className="key-actions">[\s\S]*?确认删除/);
});

test("侧边栏的次要功能收进一个工具菜单", () => {
  const start = app.indexOf('className="sidebar-footer"');
  const block = app.slice(start, app.indexOf("</aside>", start));
  assert.match(block, /className="sidebar-tools"/);
  assert.match(block, /className="sidebar-tools-menu"/);
  assert.equal((block.match(/className="utility-button"/g) || []).length, 1, "侧边栏底部不应再铺一长排按钮");
  for (const label of ["项目", "收藏", "网页", "定时", "批量", "设置"]) assert.ok(block.includes(label), `工具菜单缺少 ${label}`);
});

test("粘贴时图片优先于文字", () => {
  const block = app.slice(app.indexOf("onPaste={async"), app.indexOf("onPaste={async") + 1800);
  assert.ok(block.indexOf("hasImage") < block.indexOf('getData("text/plain")'), "图片分支要排在文字前面");
  assert.match(block, /event\.preventDefault\(\)/);
});

test("粘长文收不下时照常粘进去，不弄丢内容", () => {
  const block = app.slice(app.indexOf('getData("text/plain")'), app.indexOf('getData("text/plain")') + 1200);
  assert.match(block, /setDraft\(\(current\) => current \+ text\)/);
});

test("做完为止 + 可写工作区才确认，而且一段对话只问一次", () => {
  const block = app.slice(app.indexOf("// 工程模式带写权限"), app.indexOf("// 工程模式带写权限") + 900);
  assert.match(block, /toolsEnabled && missionMode && activeWorkspace\?\.writable/);
  assert.match(block, /confirmedMission\.current = true/);
  // 换对话要重置，否则换到别的工作区还当已经确认过。
  assert.match(app, /previousActiveId\.current = activeId;\s*\n\s*confirmedMission\.current = false/);
});

test("新对话会复用当前纯空壳，真新建时仍继承模型和项目", () => {
  const block = app.slice(app.indexOf("const createChat = useCallback"), app.indexOf("const paletteCommands = useMemo"));
  assert.match(block, /activeConversation\.messages\.length === 0/);
  assert.match(block, /!draft\.trim\(\)[\s\S]*?!attachment[\s\S]*?!documentAttachment/);
  assert.ok(block.indexOf("return;") < block.indexOf("const conversation = newConversation"), "空壳要在新建对话之前直接复用");
  assert.match(block, /conversation\.provider = activeConversation\?\.provider/);
  assert.match(block, /conversation\.model = activeConversation\?\.model/);
  assert.match(block, /activeConversation\?\.projectId/);
  const dependencyLine = block.slice(block.lastIndexOf("}, ["));
  assert.match(dependencyLine, /activeConversation/);
  for (const field of ["attachment", "documentAttachment", "draft"]) assert.match(dependencyLine, new RegExp(`\\b${field}\\b`));
});

test("自动联网默认开启，新建和发送后都不悄悄关掉", () => {
  assert.match(app, /\[webEnabled, setWebEnabled\] = useState\(true\)/);
  assert.doesNotMatch(app, /setWebEnabled\(false\)/);
  assert.match(app, /useMemory: sealedCloudTask \? false : memoryEnabled,/);
  // 长按发送可以临时反转一次，但默认路径必须仍然跟着 webEnabled 走，
  // 而且覆盖值读一次就清空，不许黏在后面的发送上。
  assert.match(app, /useWeb: sealedCloudTask \? false : localOnly \? false : \(webForThisSend \?\? webEnabled\),/);
  assert.match(app, /const webForThisSend = localOnly \? false : sendWebOnce\.current;\n\s*sendWebOnce\.current = null;/);
  assert.doesNotMatch(app, /dmrmlBinding|dmrmlRequestOptions/);
  assert.match(app, /aria-label={localOnly \? "自动联网已暂停：仅本机模式" : "自动联网"}/);
  assert.match(app, /data-tip={localOnly \? "仅本机时暂停" : "自动联网"}/);
});

test("仅本机模式在选择、发送与界面三处都真正收口", () => {
  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(sendBlock, /if \(localOnly\)/);
  assert.match(sendBlock, /provider = "local";\s*\n\s*model = undefined;/);
  assert.doesNotMatch(sendBlock, /dmrmlBinding/);

  const picker = app.slice(app.indexOf('className="model-picker"'), app.indexOf('className="prompt-picker"'));
  assert.match(picker, /localOnly \? `仅本机 · \$\{localModelShortStatus\}`/);
  assert.match(picker, /disabled={!item\.configured \|\| \(localOnly && item\.provider !== "local"\)}/);
  assert.match(picker, /主聊天不会访问云端模型或联网搜索/);

  const globeAt = app.indexOf("<Globe2");
  const webButton = app.slice(globeAt - 900, globeAt + 80);
  assert.match(webButton, /disabled={Boolean\(localOnly \|\|/);
  assert.match(webButton, /aria-pressed={!localOnly && webEnabled}/);
});

test("模型路由和启动期间有同步发送锁，但请求开始后仍显示停止键", () => {
  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(sendBlock, /requestId \|\| sendLock\.current/);
  assert.ok(sendBlock.indexOf("sendLock.current = true") < sendBlock.indexOf("routeModel("));
  assert.match(sendBlock, /setPreparingConversationId\(activeConversation\.id\)/);
  assert.match(sendBlock, /setRequestId\(incomingRequestId\)[\s\S]*?setPreparingConversationId\(null\)/);
  assert.match(sendBlock, /sendLock\.current = false[\s\S]*?setRequestId\(null\)/);

  const controls = app.slice(app.indexOf("{requestId ? (", app.indexOf("ref={composer}")), app.indexOf("</div>\n        </section>", app.indexOf("ref={composer}")));
  assert.ok(controls.indexOf('aria-label="停止生成"') < controls.indexOf("preparingConversationId ?"), "已发起请求时停止键优先");
  assert.match(controls, /aria-label="正在准备"[^>]*disabled/);
});

test("流式首块到达后仍保持 pending，只有 done/error 才能标成结束", () => {
  const chunk = app.slice(app.indexOf("const offChunk"), app.indexOf("const offReasoning"));
  assert.match(chunk, /content: message\.content \+ content/);
  assert.doesNotMatch(chunk, /pending:\s*false/);
  const finish = app.slice(app.indexOf("const finish ="), app.indexOf("// 首轮问答结束后"));
  assert.match(finish, /pending:\s*false/);
});

test("只附一份文档时也能发送", () => {
  const sendButton = app.slice(app.indexOf('aria-label="发送"'), app.indexOf('aria-label="发送"') + 260);
  assert.match(sendButton, /!draft\.trim\(\) && !attachment && !documentAttachment/);
  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(sendBlock, /documentAttachment \? "帮我看看这份文档/);
});

test("孤儿清理会保留项目常驻文档", () => {
  const start = app.indexOf("onSweep={async");
  const block = app.slice(start, app.indexOf("onRestore={", start));
  assert.match(block, /projects\.flatMap\(\(project\) => project\.documents\.map/);
  assert.match(block, /new Set\(\[\.\.\.conversationDocumentIds, \.\.\.projectDocumentIds\]\)/);
  assert.match(block, /sweepStorage\(\{ imageIds, documentIds \}\)/);
});

test("记忆编辑恢复和模型日志都有真正的 renderer 入口", () => {
  assert.match(app, /window\.kaiLocal\.updateMemory\(id, patch\)/);
  assert.match(app, /window\.kaiLocal\.archiveMemory\(id, archived\)/);
  assert.match(app, /listMemories\(true\)/);
  assert.match(app, /window\.kaiLocal\.getModelLogs\(\)/);
});

test("空对话不显示回到最新", () => {
  assert.match(app, /scrollAwayFromBottom && Boolean\(activeConversation\?\.messages\.length\)/);
});

test("听写语言靠已经打的字判断", () => {
  const block = app.slice(app.indexOf("// 输入框里已经写着英文"), app.indexOf("// 输入框里已经写着英文") + 500);
  assert.match(block, /latin > 8 && latin > cjk \* 2 \? "en-US" : "zh-CN"/);
});

test("继续工程任务传保存的 runId，不再只靠一句继续", () => {
  assert.match(types, /resumeRunId\?: string/);
  assert.match(globals, /getAgentRun\(runId: string\): Promise<AgentRunSummary \| null>/);
  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(sendBlock, /suggestion\?: string,[\s\S]*?resumeRunId\?: string,[\s\S]*?explicitRevision\?: ChatRevisionIntent/);
  assert.match(sendBlock, /useTools: toolsEnabled \|\| Boolean\(resumeRunId\)/);
  assert.match(sendBlock, /\.\.\.\(resumeRunId \? \{ resumeRunId \} : \{\}\)/);

  const resumeBlock = app.slice(app.indexOf("const resumeRunById = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(resumeBlock, /window\.kaiLocal\.getAgentRun\(runId\)/);
  assert.match(resumeBlock, /await send\(wording, runId\)/);
  assert.match(resumeBlock, /setActiveWorkspace\(savedWorkspaceId\)/, "恢复前自动切回原来已授权的工作区");
  assert.match(resumeBlock, /setToolsEnabled\(true\)/);
  assert.match(resumeBlock, /if \(!message\.runId\)[\s\S]*?await send\(wording\)/, "只有旧版无 runId 消息才保守退回文字续写");
  assert.match(resumeBlock, /resumeRunById\(message\.runId, wording\)/, "对话内继续与工程记录必须共用同一恢复流程");

  const continueBlock = app.slice(app.indexOf("{message.continuable && !requestId"), app.indexOf("{message.citations?.length"));
  assert.equal((continueBlock.match(/resumeTask\(message\)/g) || []).length, 2);
  assert.doesNotMatch(continueBlock, /send\("\u7ee7续/);
  const startEvent = app.slice(app.indexOf("const offAgentStart"), app.indexOf("const finish ="));
  assert.match(startEvent, /resumedFrom && message\.runId === resumedFrom/);
  assert.match(startEvent, /continuable: false/, "新 run 接上后要收起旧 checkpoint 的重复恢复入口");
});

test("工程记录只给可恢复任务显示继续，运行中禁用", () => {
  assert.equal(agentRunResumeAvailability({ resumable: false }, false), "hidden");
  assert.equal(agentRunResumeAvailability({}, false), "hidden");
  assert.equal(agentRunResumeAvailability({ resumable: true }, true), "disabled");
  assert.equal(agentRunResumeAvailability({ resumable: true }, false), "ready");

  assert.match(auditPanel, /type AgentRunSummary/);
  assert.match(auditPanel, /resumeAvailability !== "hidden"/);
  assert.match(auditPanel, /disabled=\{resumeAvailability !== "ready"\}/);
  assert.match(auditPanel, /await onResume\(runId\)/);
  assert.match(auditPanel, /if \(outcome\.ok\) onClose\(\)/, "任务一启动就要退出遮挡对话的面板");
  assert.match(auditPanel, /className="audit-error" role="alert"/);
  const panelCall = app.slice(app.indexOf("{auditOpen && ("), app.indexOf("{reviewOpen && ("));
  assert.match(panelCall, /onResume=\{resumeRunById\}/);
  assert.match(panelCall, /busy=\{Boolean\(requestId \|\| preparingConversationId\)\}/);
});

test("发送不等整轮 IPC 结束，恢复后能立刻看到停止键", () => {
  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("const resumeRunById"));
  assert.doesNotMatch(sendBlock, /await window\.kaiLocal\.sendMessage/, "IPC 整轮结束前不能一直占着恢复面板");
  assert.match(sendBlock, /const delivery = window\.kaiLocal\.sendMessage/);
  assert.match(sendBlock, /void delivery[\s\S]*?\.then\([\s\S]*?\.catch\(markSendFailure\)/, "后续 IPC 失败仍要完整收尾");
  assert.ok(sendBlock.indexOf("setRequestId(incomingRequestId)") < sendBlock.indexOf("const delivery = window.kaiLocal.sendMessage"), "调用 IPC 前就要切出停止键");
});

test("可恢复的工程错误会把 runId 写回消息后再收尾", () => {
  assert.match(globals, /runId\?: string;[\s\S]*?resumable\?: boolean;[\s\S]*?continueReason\?: "interrupted"/);
  const errorBlock = app.slice(app.indexOf("const offError = window.kaiLocal.onChatError"), app.indexOf("return () =>", app.indexOf("const offError")));
  assert.match(errorBlock, /target\?\.requestId === incoming && resumable && runId/);
  assert.match(errorBlock, /runId, continuable: true, continueReason: "interrupted"/);
  assert.ok(errorBlock.indexOf("setConversations") < errorBlock.indexOf("finish(incoming, message)"), "必须先保存恢复标记再结束流式任务");
});

test("启动是 loading ready error 三态，失败页可重试也可改设置", () => {
  assert.match(app, /bootPhase, setBootPhase\] = useState<"loading" \| "ready" \| "error">\("loading"\)/);
  const init = app.slice(app.indexOf("const initializeApp = useCallback"), app.indexOf("useEffect(() => {\n    void initializeApp"));
  assert.match(init, /setBootPhase\("loading"\)/);
  assert.match(init, /Promise\.race/);
  assert.match(init, /12_000/);
  assert.match(init, /clearTimeout\(timeout\)/, "IPC 卡住也要进可恢复错误页，定时器也要收回");
  assert.match(init, /setBootPhase\("ready"\)/);
  assert.match(init, /setBootPhase\("error"\)/);
  const failed = app.slice(app.indexOf('if (bootPhase === "error"'), app.indexOf("return (\n    <div\n      className={`app-shell"));
  assert.match(failed, /重试初始化/);
  assert.match(failed, /打开设置/);
  assert.match(failed, /<SettingsPanel/);
  assert.doesNotMatch(failed, /setBootFailure\(null\)[^]*?<X/, "启动错误不能关掉后变成假空白");

  const sendBlock = app.slice(app.indexOf("const send = useCallback"), app.indexOf("// 输入框里最后一个"));
  assert.match(sendBlock, /bootPhase !== "ready" \|\| !initialState/);
  const sendButton = app.slice(app.indexOf('aria-label="发送"'), app.indexOf('aria-label="发送"') + 400);
  assert.match(sendButton, /disabled=\{bootPhase !== "ready"/);
});
