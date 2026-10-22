const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("kaiLocal", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  prepareRestoreTransaction: (payload) => ipcRenderer.invoke("restore:prepare", payload),
  resolveRestoreTransaction: (id, resolution) => ipcRenderer.invoke("restore:resolve", id, resolution),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  chooseFile: (kind) => ipcRenderer.invoke("dialog:choose-file", kind),
  chooseAndAnalyzeImage: () => ipcRenderer.invoke("image:choose-analyze"),
  chooseAndReadDocument: () => ipcRenderer.invoke("document:choose-read"),
  handleDroppedFile: (filePath) => ipcRenderer.invoke("file:drop", filePath),
  // 沙箱渲染进程拿不到 File.path，必须由 preload 用 webUtils 换取真实路径。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getQuickState: () => ipcRenderer.invoke("quick:state"),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  fetchModelCatalog: () => ipcRenderer.invoke("providers:catalog"),
  routeModel: (payload) => ipcRenderer.invoke("providers:route", payload),
  listSchedules: () => ipcRenderer.invoke("schedule:list"),
  addSchedule: (input) => ipcRenderer.invoke("schedule:add", input),
  updateSchedule: (id, patch) => ipcRenderer.invoke("schedule:update", id, patch),
  removeSchedule: (id) => ipcRenderer.invoke("schedule:remove", id),
  pauseSchedule: (id, untilMs) => ipcRenderer.invoke("schedule:pause", id, untilMs),
  markScheduleRead: (id) => ipcRenderer.invoke("schedule:read", id),
  runScheduleNow: (id) => ipcRenderer.invoke("schedule:run-now", id),
  onScheduleUpdated: (listener) => subscribe("schedule:updated", listener),
  onScheduleOpen: (listener) => subscribe("schedule:open", listener),
  runCompare: (payload) => ipcRenderer.invoke("compare:run", payload),
  cancelCompare: () => ipcRenderer.invoke("compare:cancel"),
  onCompareChunk: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("compare:chunk", listener);
    return () => ipcRenderer.removeListener("compare:chunk", listener);
  },
  onCompareReasoning: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("compare:reasoning", listener);
    return () => ipcRenderer.removeListener("compare:reasoning", listener);
  },
  onCompareDone: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("compare:done", listener);
    return () => ipcRenderer.removeListener("compare:done", listener);
  },
  onCompareError: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("compare:error", listener);
    return () => ipcRenderer.removeListener("compare:error", listener);
  },
  checkCanvasConsistency: (text) => ipcRenderer.invoke("canvas:consistency", text),
  suggestFollowups: (payload) => ipcRenderer.invoke("followups:suggest", payload),
  summarizeReview: (topics) => ipcRenderer.invoke("review:summarize", topics),
  parseSchedule: (sentence) => ipcRenderer.invoke("schedule:parse", sentence),
  imageFromClipboard: () => ipcRenderer.invoke("image:from-clipboard"),
  documentFromText: (payload) => ipcRenderer.invoke("document:from-text", payload),
  setMiniWindow: (mini) => ipcRenderer.invoke("window:mini", mini),
  runDiagnose: () => ipcRenderer.invoke("diagnose:run"),
  sweepStorage: (referenced) => ipcRenderer.invoke("storage:sweep", referenced),
  listSavedPages: () => ipcRenderer.invoke("readlater:list"),
  saveWebPage: (url) => ipcRenderer.invoke("readlater:save", url),
  removeSavedPage: (id) => ipcRenderer.invoke("readlater:remove", id),
  savedPageText: (id) => ipcRenderer.invoke("readlater:text", id),
  previewKnowledge: (question) => ipcRenderer.invoke("knowledge:preview", question),
  saveImageAs: (id, suggestedName) => ipcRenderer.invoke("image:save-as", id, suggestedName),
  imageText: (id) => ipcRenderer.invoke("image:text", id),
  documentOutline: (id) => ipcRenderer.invoke("document:outline", id),
  sliceDocumentSection: (id, label) => ipcRenderer.invoke("document:slice-section", id, label),
  searchDocument: (id, query) => ipcRenderer.invoke("document:search", id, query),
  pickDocumentSheet: (id, sheetName) => ipcRenderer.invoke("document:pick-sheet", id, sheetName),
  setKnowledgeExcludes: (id, excludes) => ipcRenderer.invoke("knowledge:set-excludes", id, excludes),
  setSavedPageTags: (id, tags) => ipcRenderer.invoke("readlater:set-tags", id, tags),
  summarizeConversation: (text) => ipcRenderer.invoke("chat:summary", text),
  writeAutoBackup: (content) => ipcRenderer.invoke("backup:auto-write", content),
  listAutoBackups: () => ipcRenderer.invoke("backup:auto-list"),
  readAutoBackup: (name) => ipcRenderer.invoke("backup:auto-read", name),
  storageUsage: () => ipcRenderer.invoke("storage:usage"),
  usageSummary: () => ipcRenderer.invoke("usage:summary"),
  appInfo: () => ipcRenderer.invoke("app:info"),
  openDataDir: () => ipcRenderer.invoke("app:open-data"),
  dataDirectory: () => ipcRenderer.invoke("app:data-dir"),
  exportSettings: () => ipcRenderer.invoke("settings:export"),
  importSettings: (payload) => ipcRenderer.invoke("settings:import", payload),
  writeSkill: (draft) => ipcRenderer.invoke("skill:write", draft),
  readSkill: (fileName) => ipcRenderer.invoke("skill:read", fileName),
  discardSkill: (fileName) => ipcRenderer.invoke("skill:discard", fileName),
  lockStatus: () => ipcRenderer.invoke("lock:status"),
  setLock: (code) => ipcRenderer.invoke("lock:set", code),
  verifyLock: (code) => ipcRenderer.invoke("lock:verify", code),
  clearLock: (code) => ipcRenderer.invoke("lock:clear", code),
  onSavedPagesUpdated: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("readlater:updated", listener);
    return () => ipcRenderer.removeListener("readlater:updated", listener);
  },
  attachSavedPage: (id) => ipcRenderer.invoke("readlater:attach", id),
  savedPagesToKnowledge: () => ipcRenderer.invoke("readlater:to-knowledge"),
  startSpeak: (payload) => ipcRenderer.invoke("speak:start", payload),
  stopSpeak: () => ipcRenderer.invoke("speak:stop"),
  listVoices: () => ipcRenderer.invoke("speak:voices"),
  onSpeakDone: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("speak:done", listener);
    return () => ipcRenderer.removeListener("speak:done", listener);
  },
  exportPdf: (payload) => ipcRenderer.invoke("export:pdf", payload),
  captureScreenshot: (mode) => ipcRenderer.invoke("screenshot:capture", mode),
  onScreenshotRequested: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("screenshot:requested", listener);
    return () => ipcRenderer.removeListener("screenshot:requested", listener);
  },
  startSpeech: (options) => ipcRenderer.invoke("speech:start", options),
  stopSpeech: () => ipcRenderer.invoke("speech:stop"),
  onSpeechEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("speech:event", listener);
    return () => ipcRenderer.removeListener("speech:event", listener);
  },
  listKnowledge: () => ipcRenderer.invoke("knowledge:list"),
  addKnowledge: () => ipcRenderer.invoke("knowledge:add"),
  removeKnowledge: (id) => ipcRenderer.invoke("knowledge:remove", id),
  toggleKnowledge: (id, enabled) => ipcRenderer.invoke("knowledge:toggle", id, enabled),
  indexKnowledge: (id) => ipcRenderer.invoke("knowledge:index", id),
  onKnowledgeProgress: (listener) => subscribe("knowledge:progress", listener),
  onChatKnowledge: (listener) => subscribe("chat:knowledge", listener),
  onChatMentions: (listener) => subscribe("chat:mentions", listener),
  fetchProviderModels: (providerId) => ipcRenderer.invoke("providers:models", providerId),
  setProviderKey: (providerId, key) => ipcRenderer.invoke("providers:set-key", providerId, key),
  listCanvasActions: () => ipcRenderer.invoke("canvas:actions"),
  runCanvasAction: (payload) => ipcRenderer.invoke("canvas:run", payload),
  applyCanvasReplacement: (payload) => ipcRenderer.invoke("canvas:apply", payload),
  suggestTitle: (payload) => ipcRenderer.invoke("chat:title", payload),
  suggestMemories: (payload) => ipcRenderer.invoke("memory:suggest", payload),
  runQuickAction: (payload) => ipcRenderer.invoke("quick:run", payload),
  copyQuickResult: (text) => ipcRenderer.invoke("quick:copy", text),
  closeQuickWindow: () => ipcRenderer.invoke("quick:close"),
  openQuickWindow: () => ipcRenderer.invoke("quick:open"),
  onQuickClip: (listener) => subscribe("quick:clip", listener),
  discardDocument: (id) => ipcRenderer.invoke("document:discard", id),
  pruneDocuments: (keepIds) => ipcRenderer.invoke("document:prune", keepIds),
  discardImage: (id) => ipcRenderer.invoke("image:discard", id),
  pruneImages: (referencedIds) => ipcRenderer.invoke("image:prune", referencedIds),
  listWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  removeWorkspace: (id) => ipcRenderer.invoke("workspace:remove", id),
  setActiveWorkspace: (id) => ipcRenderer.invoke("workspace:set-active", id),
  setWorkspaceWritable: (id, writable) => ipcRenderer.invoke("workspace:set-writable", id, writable),
  getWorkspaceSummary: (id) => ipcRenderer.invoke("workspace:summary", id),
  initProjectNotes: (id) => ipcRenderer.invoke("workspace:init-notes", id),
  listWorkspaceFiles: (query) => ipcRenderer.invoke("workspace:files", query),
  approveToolCall: (callId, approved) => ipcRenderer.invoke("agent:approve", callId, approved),
  listToolCalls: (limit) => ipcRenderer.invoke("audit:list", limit),
  listAgentRuns: (limit) => ipcRenderer.invoke("audit:runs", limit),
  getAgentRun: (runId) => ipcRenderer.invoke("audit:get-run", runId),
  rollbackToolCall: (callId) => ipcRenderer.invoke("audit:rollback", callId),
  rollbackAgentRun: (runId) => ipcRenderer.invoke("audit:rollback-run", runId),
  listMemories: (includeArchived = false) => ipcRenderer.invoke("memory:list", includeArchived),
  createMemory: (payload) => ipcRenderer.invoke("memory:create", payload),
  updateMemory: (id, patch) => ipcRenderer.invoke("memory:update", id, patch),
  archiveMemory: (id, archived = true) => ipcRenderer.invoke("memory:archive", id, archived),
  openSource: (url) => ipcRenderer.invoke("source:open", url),
  startModel: () => ipcRenderer.invoke("model:start"),
  stopModel: () => ipcRenderer.invoke("model:stop"),
  getModelStatus: () => ipcRenderer.invoke("model:status"),
  getLocalModelIdentity: () => ipcRenderer.invoke("model:identity"),
  getModelLogs: () => ipcRenderer.invoke("model:logs"),
  sendMessage: (payload) => ipcRenderer.invoke("chat:send", payload),
  cancelMessage: (requestId) => ipcRenderer.invoke("chat:cancel", requestId),
  onModelStatus: (listener) => subscribe("model:status-changed", listener),
  onChatChunk: (listener) => subscribe("chat:chunk", listener),
  onChatReasoning: (listener) => subscribe("chat:reasoning", listener),
  onChatSources: (listener) => subscribe("chat:sources", listener),
  onChatTool: (listener) => subscribe("chat:tool", listener),
  onAgentStart: (listener) => subscribe("chat:agent-start", listener),
  onChatDone: (listener) => subscribe("chat:done", listener),
  onChatError: (listener) => subscribe("chat:error", listener),
});
