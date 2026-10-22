// 可视化测试用的假 IPC。只在预览环境加载，绝不进包。
(() => {
  const url = new URL(window.location.href);
  const view = url.searchParams.get("view") || "";
  const firstRun = view === "welcome" || view === "browse";

  const settings = {
    serverBinary: "/opt/homebrew/bin/llama-server", modelPath: "/models/qwen3-8b.gguf",
    skillDirectory: "/tmp/skills", port: 8080, contextSize: 8192, gpuLayers: 99, threads: 6,
    temperature: 0.7, maxTokens: 2048, autoStart: false, theme: "light",
    searchProvider: "duckduckgo", searchFallback: true, searxngEndpoint: "",
    agentMaxRounds: 12, agentApproval: "ask", chatTimeoutMinutes: 0, scheduleGraceMinutes: 5,
    localOnly: view === "localonly", cloudReceipt: true, speakVoice: "", speakRate: 0,
    quickEnabled: true, quickHotkey: "Alt+Command+K",
  };
  const state = {
    settings,
    modelState: { status: "ready", detail: "模型就绪", running: true, rssMb: 5321 },
    skills: [
      { id: "meeting", fileName: "会议纪要整理.md", name: "会议纪要整理", description: "把转写整理成纪要", characters: 320, loadingMode: "full" },
      { id: "polish", fileName: "润色.md", name: "中文润色", description: "更自然的中文", characters: 210, loadingMode: "full" },
    ], platform: "darwin", arch: "arm64",
    capabilities: { memory: true, vision: true, document: true, web: true, tools: true },
    searchProviders: [{ id: "duckduckgo", label: "DuckDuckGo", requiresEndpoint: false }],
    quickActions: [
      { id: "polish", label: "润色", hint: "" }, { id: "translate", label: "翻译", hint: "" },
      { id: "bilingual", label: "对照翻译", hint: "" }, { id: "t2s", label: "转简体", hint: "" },
    ],
    quickHotkeys: [{ id: "Alt+Command+K", label: "⌥⌘K" }],
    quickHotkeyState: { registered: true, reason: "" },
    trayState: { created: true, reason: "" },
    providers: [
      { id: "local", label: "本机 Qwen3-8B", detail: "不离开这台电脑", cloud: false, needsKey: false, configured: true, maskedKey: "", models: [] },
      { id: "deepseek", label: "DeepSeek", detail: "云端模型", cloud: true, needsKey: true, configured: true, maskedKey: "****abcd1234", models: [{ id: "deepseek-chat", label: "deepseek-chat" }] },
      { id: "moonshot", label: "Kimi", detail: "云端模型", cloud: true, needsKey: true, configured: false, maskedKey: "", models: [] },
      { id: "zhipu", label: "智谱 GLM", detail: "云端模型", cloud: true, needsKey: true, configured: false, maskedKey: "", models: [] },
    ],
    workspaces: { roots: [], activeId: null },
    tools: [], allowedCommands: [], projectNoteFiles: [],
  };

  if (firstRun) {
    state.modelState = { status: "stopped", detail: "尚未配置本机模型", running: false, rssMb: 0 };
    state.providers.forEach((provider) => { if (provider.cloud) provider.configured = false; });
    if (view === "welcome") localStorage.removeItem("kaii.onboarding.v1");
    else localStorage.setItem("kaii.onboarding.v1", "browse");
  } else {
    localStorage.setItem("kaii.onboarding.v1", "configured");
  }

  const knowledge = [{
    id: "lib1", path: "/tmp/kaii-demo/资料/合同", label: "合同", enabled: true,
    fileCount: 42, sectionCount: 380, characters: 412345, indexedAt: Date.now() - 7200e3,
    skipped: [{ path: "旧扫描.pdf", reason: "提取不出文字" }], exists: true, stale: view === "stale",
    excludes: ["草稿"],
  }];
  const schedules = [
    { id: "s1", label: "每日晨报", prompt: "总结昨天的科技新闻", every: "day", hour: 8, minute: 30,
      enabled: true, provider: "deepseek", model: "deepseek-chat", useWeb: true, notifyKeyword: "",
      nextRunAt: Date.now() + 3600e3, results: [
        { at: Date.now() - 86400e3, ok: true, text: "昨天的三条要闻：……", error: "", unread: true },
        { at: Date.now() - 2 * 86400e3, ok: false, text: "", error: "网络超时", unread: false },
      ] },
    { id: "s2", label: "周报提醒", prompt: "提醒我写周报", every: "week", hour: 17, minute: 0, weekday: 5,
      enabled: false, results: [], nextRunAt: 0 },
  ];
  if (view === "showcase") {
    Object.assign(knowledge[0], {
      path: "/tmp/kaii-demo/资料/产品文档", label: "示例资料", fileCount: 3,
      sectionCount: 12, characters: 0, skipped: [], excludes: ["草稿", "旧版"],
    });
    schedules.splice(0, schedules.length,
      { id: "s1", label: "每周写作回顾 · 示例", prompt: "提醒我整理本周文稿，列出下一篇要查的资料。", every: "week", hour: 18, minute: 0, weekday: 5, enabled: true, provider: "deepseek", model: "deepseek-chat", useWeb: false, results: [], nextRunAt: Date.now() + 86400e3 },
      { id: "s2", label: "资料整理提醒 · 示例", prompt: "提醒我把本周新增的资料归入项目。", every: "week", hour: 10, minute: 0, weekday: 1, enabled: false, results: [], nextRunAt: 0 },
    );
  }
  const savedPages = [
    { id: "11111111-1111-4111-8111-111111111111", url: "https://example.com/a", title: "一篇讲本地模型量化的文章",
      characters: 8321, savedAt: Date.now() - 3600e3, excerpt: "量化是把权重从 16 位压到 4 位……", tags: ["模型"], summary: "" },
  ];

  // 事件总线：sendMessage 之后按真实节奏回流式片段，核心链路能在预览里走通。
  const listeners = { chunk: [], done: [], error: [], reasoning: [], sources: [], knowledge: [], tool: [], mentions: [],
    cchunk: [], cdone: [], cerror: [], creasoning: [] };
  const on = (kind) => (fn) => { listeners[kind].push(fn); return () => { listeners[kind] = listeners[kind].filter((f) => f !== fn); }; };
  const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));

  const noop = async () => ({});
  const api = new Proxy({}, { get: (_t, prop) => {
    if (typeof prop !== "string") return undefined;
    if (prop.startsWith("on")) return () => () => {};
    return noop;
  } });

  const overrides = {
    getState: async () => state,
    updateSettings: async (patch) => { Object.assign(settings, patch); return { settings: { ...settings }, skills: [], quickHotkeyState: state.quickHotkeyState }; },
    getModelStatus: async () => state.modelState,
    lockStatus: async () => ({ enabled: view === "lock" }),
    verifyLock: async (code) => ({ ok: code === "2468" }),
    listSchedules: async () => schedules,
    listKnowledge: async () => knowledge,
    listSavedPages: async () => savedPages,
    listProviders: async () => state.providers,
    setProviderKey: async (id, key) => {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) throw new Error("unknown provider");
      provider.configured = Boolean(key);
      provider.maskedKey = key ? "已保存" : "";
      return { ok: true, providerId: id, configured: provider.configured, providers: state.providers };
    },
    listMemories: async () => [],
    listAgentRuns: async () => [],
    listVoices: async () => [],
    listWorkspaces: async () => state.workspaces,
    listAutoBackups: async () => [{ name: "auto-2026-08-18.json", savedAt: Date.now() - 86400e3, bytes: 45230, ok: true }],
    storageUsage: async () => ({ total: 34.6e6, items: [
      { name: "documents", bytes: 21e6 }, { name: "images", bytes: 8e6 }, { name: "backups", bytes: 5.6e6 }] }),
    appInfo: async () => ({ version: "0.9.0", electron: "38.2.0", node: "22", chrome: "140" }),
    usageSummary: async () => ({ today: { local: 4 }, week: { local: 22, deepseek: 6 } }),
    dataDirectory: async () => "~/Library/Application Support/kaii-demo",
    previewKnowledge: async () => view === "showcase" ? [
      { index: 1, library: "示例资料", file: "使用说明.md", label: "模型设置", excerpt: "在首次设置中选择 DeepSeek、GLM 或 Kimi，粘贴对应的 API key。其他服务可以稍后在设置里添加。" },
      { index: 2, library: "示例资料", file: "写作流程.md", label: "资料准备", excerpt: "将经常查阅的文件放入资料目录，建立索引。提问前可以先预览检索到的片段。" },
    ] : [
      { index: 1, library: "合同", file: "报销规定.txt", label: "第 2 段", excerpt: "差旅报销需要在回程后十五个工作日内提交……" },
    ],
    documentOutline: async () => ({ id: "d1", name: "说明书.pdf", kind: "pdf", truncated: false, sheetNames: [],
      sections: [{ label: "第 1 部分", characters: 1200, preview: "这一部分介绍安装步骤" }] }),
    fetchModelCatalog: async () => [
      { group: "本机", items: [
        { provider: "local", model: "", label: "本机 Qwen3-8B", note: "不离开这台电脑", configured: true, needsKey: false },
      ] },
      { group: "云端", items: [
        { provider: "deepseek", model: "deepseek-chat", label: view === "showcase" ? "DeepSeek · 界面演示" : "DeepSeek V3", note: "日常问答", configured: true, needsKey: true },
        { provider: "zhipu", model: "glm-4.5", label: view === "showcase" ? "GLM · 界面演示" : "GLM-4.5", note: "复杂分析", configured: true, needsKey: true },
      ] },
    ],
    routeModel: async () => ({ provider: "local", model: "", reason: "纯文字问题，本机就够" }),
    suggestFollowups: async () => ({ ok: true, items: [] }),
    runDiagnose: async () => ({ checks: [] }),
    getQuickState: async () => ({ actions: state.quickActions, hotkeys: state.quickHotkeys, hotkey: "Alt+Command+K", clip: "" }),
    onChatChunk: on("chunk"),
    onChatDone: on("done"),
    onChatError: on("error"),
    onChatReasoning: on("reasoning"),
    onChatSources: on("sources"),
    onChatKnowledge: on("knowledge"),
    onChatTool: on("tool"),
    onChatMentions: on("mentions"),
    sendMessage: async (payload) => {
      const id = payload.requestId;
      const pieces = ["这是", "预览环境里", "的模拟回答：", "收到「", String(payload.messages?.at(-1)?.content || "").slice(0, 24), "」。\n\n- 流式分片正常\n- 完成事件正常"];
      let at = 0;
      const timer = setInterval(() => {
        if (at < pieces.length) {
          emit("chunk", { requestId: id, content: pieces[at] });
          at += 1;
          return;
        }
        clearInterval(timer);
        emit("done", { requestId: id, skillMode: "none", skillName: "", sources: [], memoryCount: 0, provider: "local", model: "qwen3-8b" });
      }, 120);
      return { ok: true, requestId: id };
    },
    cancelMessage: async (id) => { emit("error", { requestId: id, message: "已停止", cancelled: true }); return { ok: true }; },
    documentFromText: async ({ text, name }) => ({ ok: true, attachment: {
      id: crypto.randomUUID(), name: name || "粘贴的内容", kind: "text", pageCount: 0,
      characters: (text || "").length, truncated: false, reused: false, sheetName: "", sheetNames: [],
    } }),
    addSchedule: async (draft) => { schedules.push({ id: crypto.randomUUID(), results: [], enabled: true, nextRunAt: Date.now() + 3600e3, ...draft }); return schedules; },
    updateSchedule: async (id, patch) => { const it = schedules.find(s => s.id === id); Object.assign(it, patch); return schedules; },
    removeSchedule: async (id) => { const at = schedules.findIndex(s => s.id === id); schedules.splice(at, 1); return schedules; },
    pauseSchedule: async (id, until) => { const it = schedules.find(s => s.id === id); it.pausedUntil = until; return schedules; },
    markScheduleRead: async (id) => { const it = schedules.find(s => s.id === id); it.results.forEach(r => r.unread = false); return schedules; },
    runScheduleNow: async () => schedules,
    writeSkill: async ({ name, description }) => {
      state.skills.push({ id: String(name), fileName: `${name}.md`, name, description: description || "自己写的技能", characters: 200, loadingMode: "full" });
      return { ok: true, fileName: `${name}.md`, skills: state.skills };
    },
    readSkill: async () => ({ ok: true, body: "---\nname: 演示技能\ndescription: 演示\n---\n\n把转写整理成决定/待办/风险三段。" }),
    discardSkill: async (fileName) => { state.skills = state.skills.filter((s) => s.fileName !== fileName); return { ok: true, skills: state.skills }; },
    onCompareChunk: on("cchunk"),
    onCompareDone: on("cdone"),
    onCompareError: on("cerror"),
    onCompareReasoning: on("creasoning"),
    runCompare: async ({ targets }) => {
      targets.forEach((target, index) => {
        const side = `c${index}`;
        let sent = 0;
        const pieces = view === "showcase" ? [index === 0
          ? "### 示例文案 A\n\n把日常用到的 AI 功能放进一个桌面窗口。\n\n"
          : "### 示例文案 B\n\n从一份资料，接着完成提问和写作。\n\n",
          index === 0
            ? "接入自己的模型账号，读文件、比较回答，再把内容放进画布修改。\n\n"
            : "导入文档后先问几个问题，找到有用的段落，再整理成一份文稿。\n\n",
          "*这里使用固定演示文本，展示并排阅读和选用回答的操作。*",
        ] : [`${target.provider} 的答案：`, "第一点……", "第二点……"];
        const timer = setInterval(() => {
          if (sent < pieces.length) { emit("cchunk", { side, content: pieces[sent] }); sent += 1; return; }
          clearInterval(timer);
          emit("cdone", { side, elapsedMs: view === "showcase" ? 0 : 800 + index * 300, model: target.model || "默认" });
        }, 100 + index * 40);
      });
      return { ok: true };
    },
    cancelCompare: async () => ({ ok: true }),
    // 真实契约：runQuickAction 等流式发完才 resolve（BatchPanel 依赖这一点，
    // resolve 后立刻读累计的 streamed）。mock 必须遵守同样的时序。
    runQuickAction: async ({ requestId, action, text }) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const showcaseTranslations = {
        "Keep your notes in one place.": "把笔记放在一起，随时查阅。",
        "Compare answers side by side.": "并排查看回答，选用合适的内容。",
        "Turn a draft into a document.": "将草稿整理成文档。",
      };
      const content = view === "showcase"
        ? `演示译文 · ${showcaseTranslations[String(text)] || String(text)}`
        : `【${action}】处理结果：${String(text).slice(0, 18)}……`;
      emit("chunk", { requestId, content });
      await new Promise((resolve) => setTimeout(resolve, 80));
      emit("done", { requestId, skillMode: "none", skillName: "", sources: [], memoryCount: 0 });
      return { ok: true };
    },
    setLock: async () => ({ ok: true, enabled: true }),
    clearLock: async () => ({ ok: true, enabled: false }),
    setMiniWindow: async (mini) => ({ ok: true, mini: Boolean(mini) }),
    savedPageText: async () => "量化是把权重从 16 位压到 4 位来省显存的做法。\n\n实测 Q4_K_M 在 8B 模型上几乎无损。",
    attachSavedPage: async (id) => ({ ok: true, attachment: {
      id, name: "一篇讲本地模型量化的文章", kind: "text", pageCount: 0,
      characters: 8321, truncated: false, reused: true, sheetName: "", sheetNames: [],
    } }),
    imageText: async () => "发票号 INV-2026-0818\n金额 ￥1,200.00\n开票日期 2026-08-18",
    saveImageAs: async () => ({ ok: true }),
    searchDocument: async () => [{ label: "第 1 部分", excerpt: "安装步骤里提到先装依赖" }],
    pickDocumentSheet: async () => ({ ok: true }),
    sliceDocumentSection: async () => ({ ok: true }),
    listCanvasActions: async () => [
      { id: "polish", label: "润色", hint: "" },
      { id: "shorten", label: "精简", hint: "" },
      { id: "continue", label: "接着写", hint: "" },
    ],
    runCanvasAction: async () => ({ ok: true, requestId: "" }),
    checkCanvasConsistency: async () => ({ ok: true, report: "没发现明显不一致" }),
    listToolCalls: async () => [],
    getModelLogs: async () => [],
    suggestMemories: async () => ({ ok: true, items: [] }),
    exportPdf: async () => ({ ok: true }),
  };
  window.__calls = [];
  window.kaiLocal = new Proxy(overrides, { get: (t, prop) => {
    const fn = t[prop] || api[prop];
    if (typeof fn !== "function") return fn;
    return (...args) => { window.__calls.push(String(prop)); return fn(...args); };
  } });

  // 会话与项目种子：主界面要有东西可看
  const now = Date.now();
  const longCode = Array.from({ length: 60 }, (_, i) => `SETTING_${i} = ${i * 3}  # 配置项第 ${i} 行`).join("\n");
  const messages = [
    { id: "m1", role: "user", content: "帮我把这段 Python 优化一下，再给个对比表", createdAt: now - 86400e3 * 2 },
    { id: "m2", role: "assistant", createdAt: now - 86400e3 * 2, modelLabel: "本机 Qwen3-8B", elapsedMs: 5200, starred: true,
      content: "优化点有两个：`列表推导` 替代循环，`lru_cache` 缓存重复计算。\n\n```python\nfrom functools import lru_cache\n\n@lru_cache(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n```\n\n| 方案 | 耗时 | 内存 |\n|---|---|---|\n| 原始递归 | 4.2s | 12MB |\n| lru_cache | 0.01s | 14MB |\n\n公式表示复杂度从 $O(2^n)$ 降到 $O(n)$。" },
    { id: "m2b", role: "user", content: "把完整配置文件贴给我看看", createdAt: now - 86400e3 * 2 + 60e3 },
    { id: "m2c", role: "assistant", createdAt: now - 86400e3 * 2 + 120e3, modelLabel: "本机 Qwen3-8B", elapsedMs: 9800,
      content: "完整配置在这（60 行）：\n\n```python\n" + longCode + "\n```\n\n改前三行就够。" },
    { id: "mi1", role: "user", content: "看看这张发票", createdAt: now - 7200e3,
      attachment: { id: "22222222-2222-4222-8222-222222222222", name: "发票.png", previewDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8//8/AzGAiShVowqHl0IAiEEDHcHCUCQAAAAASUVORK5CYII=",
        width: 800, height: 600, ocrPreview: "发票号 INV-2026-0818…", labelPreview: "" } },
    { id: "m3", role: "user", content: "很好，那这个能用到我们的账单模块吗", createdAt: now - 3600e3 },
    { id: "m4", role: "assistant", createdAt: now - 3600e3, modelLabel: "本机 Qwen3-8B", elapsedMs: 3900,
      content: "可以。账单模块里 `calculate_totals` 每次都重算整月数据，加缓存后只在数据变更时失效即可。链接参考 [官方文档](https://docs.python.org/3/library/functools.html)。" },
  ];
  const conversations = [
    { id: "c9", title: "被删掉的旧对话", messages: [
      { id: "z1", role: "user", content: "临时问题", createdAt: now - 86400e3 * 12 },
    ], skillId: "none", createdAt: now - 86400e3 * 12, updatedAt: now - 86400e3 * 12, deletedAt: now - 86400e3 * 2 },
    { id: "c1", title: "Python 性能优化", messages, skillId: "none", createdAt: now - 86400e3 * 2, updatedAt: now - 3600e3,
      summary: "讨论用 lru_cache 优化递归和账单模块", projectId: "p1" },
    { id: "c2", title: "旅行计划草稿", messages: [
      { id: "n1", role: "user", content: "帮我列一个五天的川西行程", createdAt: now - 86400e3 * 5 },
      { id: "n2", role: "assistant", content: "第一天：成都出发……", createdAt: now - 86400e3 * 5 },
    ], skillId: "none", createdAt: now - 86400e3 * 6, updatedAt: now - 86400e3 * 5, pinned: true },
    { id: "c3", title: "上周的会议纪要", messages: [
      { id: "o1", role: "user", content: "整理这份纪要", createdAt: now - 86400e3 * 9 },
      { id: "o2", role: "assistant", content: "三个决定：……", createdAt: now - 86400e3 * 9 },
    ], skillId: "none", createdAt: now - 86400e3 * 9, updatedAt: now - 86400e3 * 9, tags: ["工作"] },
  ];
  if (view === "showcase") {
    conversations.splice(0, conversations.length, {
      id: "c1", title: "kaii 使用说明", skillId: "none", projectId: "p1",
      provider: "deepseek", model: "deepseek-chat", createdAt: now, updatedAt: now,
      messages: [
        { id: "showcase-user", role: "user", content: "把 kaii 的入门步骤整理成一份短说明。", createdAt: now },
        { id: "showcase-answer", role: "assistant", modelLabel: "演示内容", createdAt: now,
          content: "# 从第一条提问开始\n\nkaii 把常用的 AI 工作放在同一个窗口。接入自己的模型账号后，就可以提问、读文件和整理写作内容。\n\n## 选择模型\n\n在首次设置中选择 DeepSeek、GLM 或 Kimi，粘贴对应的 API key。选一家即可，其他服务可以稍后在设置里添加。\n\n## 带着资料提问\n\n导入一份文档，先查看提取内容，再写下问题。经常使用的资料可以放进项目或建立本机知识库。\n\n## 把回答改成文稿\n\n将回答放入画布，直接调整文字，选中段落后继续改写。完成后导出 Markdown、Word 或 PDF。\n\n## 留下任务记录\n\n重复操作可以批量处理，也可以设为定时任务。任务工作台集中显示运行进展和结果。" },
      ],
    });
  }
  if (view === "empty" || firstRun) {
    localStorage.removeItem("kai-local.conversations.v2");
    localStorage.removeItem("kai-local.active-conversation.v1");
    localStorage.removeItem("kaii.drafts.v1");
  } else {
    localStorage.setItem("kai-local.conversations.v2", JSON.stringify({ schemaVersion: 2, savedAt: now, conversations }));
  }
  localStorage.setItem("kai-local.active-conversation.v1", view === "empty" || firstRun ? "none-such" : "c1");
  localStorage.setItem("kaii.projects.v1", JSON.stringify([
    { id: "p1", name: view === "showcase" ? "产品文档" : "工程优化", instructions: "", documents: [], createdAt: now - 86400e3 * 10, updatedAt: now, color: "#587851" },
    { id: "p2", name: "生活", instructions: "", documents: [], createdAt: now - 86400e3 * 20, updatedAt: now - 86400e3 * 3 },
  ]));
  localStorage.setItem("kaii.prompts.v1", JSON.stringify([
    { id: "pr1", label: "翻译成英文", body: "把下面这段翻译成英文，保持语气：", createdAt: now, useCount: 5 },
    { id: "pr2", label: "周报模板", body: "按「本周完成/下周计划/风险」整理：", createdAt: now, useCount: 2 },
  ]));
})();
