import type {
  AppSettings,
  AgentRunSummary,
  AuditEntry,
  ChatRequest,
  CompletionEvidence,
  ImageAttachment,
  InitialState,
  MemoryEntry,
  ModelState,
  SkillInfo,
  ToolCallReceipt,
  WebSource,
  WorkspaceDetail,
  WorkspaceState,
} from "./types";

declare global {
  interface Window {
    kaiLocal: {
      getState(): Promise<InitialState>;
      prepareRestoreTransaction(payload: {
        version: number;
        id: string;
        createdAt: number;
        previous: import("./types").RestoreRawSnapshot;
        target: import("./types").RestoreRawSnapshot;
      }): Promise<{ ok: true; id: string; alreadyPrepared: boolean }>;
      resolveRestoreTransaction(
        id: string,
        resolution: "committed" | "rolled_back",
      ): Promise<{ ok: true; id: string; resolution: string; missing: boolean }>;
      updateSettings(patch: Partial<AppSettings>): Promise<{ settings: AppSettings; skills: SkillInfo[]; quickHotkeyState?: QuickHotkeyState }>;
      chooseFile(kind: "serverBinary" | "modelPath" | "skillDirectory"): Promise<string | null>;
      chooseAndAnalyzeImage(): Promise<ImageAttachment | null>;
      chooseAndReadDocument(): Promise<DocumentAttachment | null>;
      pathForFile(file: File): string;
      handleDroppedFile(filePath: string): Promise<
        { kind: "image"; attachment: ImageAttachment } | { kind: "document"; document: DocumentAttachment } | { kind: "knowledge"; library: KnowledgeLibrary; libraries: KnowledgeLibrary[] }
      >;
      getQuickState(): Promise<QuickState>;
      listSchedules(): Promise<Schedule[]>;
      addSchedule(input: Partial<Schedule>): Promise<Schedule[]>;
      updateSchedule(id: string, patch: Partial<Schedule>): Promise<Schedule[]>;
      pauseSchedule(id: string, untilMs: number): Promise<Schedule[]>;
      removeSchedule(id: string): Promise<Schedule[]>;
      markScheduleRead(id: string): Promise<Schedule[]>;
      runScheduleNow(id: string): Promise<Schedule[]>;
      onScheduleUpdated(listener: (schedules: Schedule[]) => void): () => void;
      onScheduleOpen(listener: () => void): () => void;
      listKnowledge(): Promise<KnowledgeLibrary[]>;
      addKnowledge(): Promise<{ library: KnowledgeLibrary; libraries: KnowledgeLibrary[] } | null>;
      removeKnowledge(id: string): Promise<KnowledgeLibrary[]>;
      toggleKnowledge(id: string, enabled: boolean): Promise<KnowledgeLibrary[]>;
      indexKnowledge(id: string): Promise<{ fileCount: number; sectionCount: number; libraries: KnowledgeLibrary[] }>;
      onKnowledgeProgress(listener: (payload: { libraryId: string; done: number; total: number; current: string }) => void): () => void;
      onChatKnowledge(listener: (payload: { requestId: string; citations: KnowledgeCitation[] }) => void): () => void;
      onChatMentions(listener: (payload: {
        requestId: string;
        mentions: Array<{ path: string; ok: boolean; totalLines?: number; error?: string }>;
      }) => void): () => void;
      listProviders(): Promise<ProviderInfo[]>;
      fetchModelCatalog(): Promise<CatalogSection[]>;
      routeModel(payload: { question: string; hasImage?: boolean; attachedCharacters?: number; conversationCharacters?: number; useTools?: boolean; manual?: { provider: string; model: string } | null }): Promise<{ provider: string; model: string; reason: string; auto: boolean }>;
      fetchProviderModels(providerId: string): Promise<{ ok: boolean; models: ProviderModelInfo[]; live: boolean; message?: string }>;
      setProviderKey(providerId: string, key: string): Promise<{ ok: boolean; providerId: string; configured: boolean; providers: ProviderInfo[] }>;
      listCanvasActions(): Promise<CanvasActionInfo[]>;
      runCanvasAction(payload: { requestId: string; action: string; document: string; start: number; end: number; note?: string }): Promise<{ ok: boolean; message?: string }>;
      applyCanvasReplacement(payload: { document: string; start: number; end: number; replacement: string }): Promise<{ document: string; replaced: string; start: number; end: number }>;
      suggestTitle(payload: { question: string; answer: string }): Promise<{ ok: boolean; title: string }>;
      suggestMemories(payload: { question: string; answer: string; provider?: string; model?: string }): Promise<{ suggestions: MemorySuggestion[] }>;
      runQuickAction(payload: { requestId: string; action: string; text: string }): Promise<{ ok: boolean; message?: string }>;
      copyQuickResult(text: string): Promise<{ ok: boolean }>;
      closeQuickWindow(): Promise<{ ok: boolean }>;
      openQuickWindow(): Promise<{ ok: boolean }>;
      onQuickClip(listener: (payload: { text: string }) => void): () => void;
      discardDocument(id: string): Promise<{ ok: boolean; removed: boolean }>;
      pruneDocuments(keepIds: string[]): Promise<{ removed: number }>;
      discardImage(id: string): Promise<{ ok: boolean; id: string; removed: number }>;
      pruneImages(referencedIds: string[]): Promise<{ ok: boolean; removed: number }>;
      listMemories(includeArchived?: boolean): Promise<MemoryEntry[]>;
      createMemory(payload: {
        content: string;
        kind: MemoryEntry["kind"];
        pinned?: boolean;
        source?: MemoryEntry["source"];
        scope?: MemoryEntry["scope"];
        status?: MemoryEntry["status"];
        supersedes?: string | null;
        reason?: string | null;
      }): Promise<MemoryEntry>;
      updateMemory(id: string, patch: Partial<Pick<MemoryEntry, "content" | "kind" | "pinned" | "source" | "scope" | "status" | "supersedes" | "reason">>): Promise<MemoryEntry>;
      archiveMemory(id: string, archived?: boolean): Promise<{ ok: boolean; id: string; archived: boolean }>;
      listWorkspaces(): Promise<WorkspaceState>;
      chooseWorkspace(): Promise<WorkspaceState | null>;
      removeWorkspace(id: string): Promise<WorkspaceState>;
      setActiveWorkspace(id: string | null): Promise<WorkspaceState>;
      setWorkspaceWritable(id: string, writable: boolean): Promise<WorkspaceState>;
      getWorkspaceSummary(id?: string | null): Promise<WorkspaceDetail>;
      initProjectNotes(id?: string | null): Promise<{ ok: boolean; path: string }>;
      listWorkspaceFiles(query?: string): Promise<Array<{ path: string; size: number }>>;
      approveToolCall(callId: string, approved: boolean): Promise<{ ok: boolean; found: boolean }>;
      listToolCalls(limit?: number): Promise<AuditEntry[]>;
      listAgentRuns(limit?: number): Promise<AgentRunSummary[]>;
      getAgentRun(runId: string): Promise<AgentRunSummary | null>;
      rollbackToolCall(callId: string): Promise<{ ok: boolean; action: string; path: string }>;
      rollbackAgentRun(runId: string): Promise<{
        ok: boolean;
        restored: Array<{ path: string; action: string }>;
        failed: Array<{ path: string | null; message: string }>;
      }>;
      openSource(url: string): Promise<{ ok: boolean }>;
      startModel(): Promise<ModelState>;
      stopModel(): Promise<ModelState>;
      getModelStatus(): Promise<ModelState>;
      getLocalModelIdentity(): Promise<{ ready: boolean; model: string; message?: string }>;
      getModelLogs(): Promise<string[]>;
      sendMessage(payload: ChatRequest): Promise<{ ok: boolean; requestId: string; message?: string }>;
      cancelMessage(requestId: string): Promise<{ ok: boolean }>;
      onModelStatus(listener: (state: ModelState) => void): () => void;
      onChatChunk(listener: (payload: { requestId: string; content: string }) => void): () => void;
      onChatReasoning(listener: (payload: { requestId: string; content: string }) => void): () => void;
      onChatSources(listener: (payload: { requestId: string; sources: WebSource[] }) => void): () => void;
      onChatTool(listener: (payload: ToolCallReceipt & { requestId: string }) => void): () => void;
      onAgentStart(listener: (payload: {
        requestId: string;
        runId: string;
        resumedFrom?: string | null;
        workspace: { label: string; path: string; writable: boolean };
        maxRounds: number;
        projectNotes: string | null;
      }) => void): () => void;
      onChatDone(listener: (payload: {
        requestId: string;
        skillMode: string;
        skillName: string;
        sources: WebSource[];
        memoryCount: number;
        toolRounds?: number;
        stopReason?: string;
        resumedFrom?: string | null;
        completion?: CompletionEvidence | null;
        provider?: string;
        model?: string;
      }) => void): () => void;
      runCompare(payload: {
        question: string;
        targets: { provider: string; model: string }[];
      }): Promise<{ ok: boolean; message?: string }>;
      cancelCompare(): Promise<{ ok: boolean }>;
      onCompareChunk(listener: (payload: { side: "left" | "right"; content: string }) => void): () => void;
      onCompareReasoning(listener: (payload: { side: "left" | "right"; reasoning: string }) => void): () => void;
      onCompareDone(listener: (payload: { side: "left" | "right"; elapsedMs: number }) => void): () => void;
      onCompareError(listener: (payload: { side: "left" | "right"; cancelled: boolean; message: string }) => void): () => void;
      checkCanvasConsistency(text: string): Promise<{ ok: boolean; report?: string; message?: string }>;
      suggestFollowups(payload: { question: string; answer: string }): Promise<{ ok: boolean; items: string[] }>;
      summarizeReview(topics: string[]): Promise<{ ok: boolean; text?: string; message?: string }>;
      parseSchedule(sentence: string): Promise<{
        ok: boolean;
        message?: string;
        draft?: { label: string; prompt: string; every: string; hour: number; minute: number; weekday: number };
      }>;
      imageFromClipboard(): Promise<{ ok: boolean; message?: string; attachment?: ImageAttachment }>;
      documentFromText(payload: { text: string; name: string }): Promise<{
        ok: boolean;
        message?: string;
        attachment?: DocumentAttachment;
      }>;
      setMiniWindow(mini: boolean): Promise<{ ok: boolean; mini: boolean }>;
      runDiagnose(): Promise<{
        ok: boolean;
        checks: { name: string; ok: boolean; detail: string; fix: string }[];
      }>;
      sweepStorage(referenced: { imageIds: string[]; documentIds: string[] }): Promise<{
        ok: boolean; images: number; documents: number; temp: number;
      }>;
      listSavedPages(): Promise<SavedPage[]>;
      saveWebPage(url: string): Promise<{ ok: boolean; message?: string; item?: SavedPage; items?: SavedPage[] }>;
      removeSavedPage(id: string): Promise<SavedPage[]>;
      savedPagesToKnowledge(): Promise<{ ok: boolean; message?: string; libraries?: KnowledgeLibrary[]; count?: number }>;
      documentOutline(id: string): Promise<{
        id: string; name: string; kind: string; truncated: boolean; sheetNames: string[];
        sections: { label: string; characters: number; preview: string }[];
      }>;
      sliceDocumentSection(id: string, label: string): Promise<{ ok: boolean; message?: string; attachment?: DocumentAttachment }>;
      searchDocument(id: string, query: string): Promise<{ label: string; excerpt: string }[]>;
      pickDocumentSheet(id: string, sheetName: string): Promise<{ ok: boolean; message?: string; attachment?: DocumentAttachment }>;
      setKnowledgeExcludes(id: string, excludes: string[]): Promise<KnowledgeLibrary[]>;
      setSavedPageTags(id: string, tags: string[]): Promise<SavedPage[]>;
      savedPageText(id: string): Promise<string>;
      previewKnowledge(question: string): Promise<{
        index: number; library: string; file: string; label: string; excerpt?: string; score?: number;
      }[]>;
      saveImageAs(id: string, suggestedName: string): Promise<{ ok: boolean; cancelled?: boolean; message?: string }>;
      imageText(id: string): Promise<string>;
      summarizeConversation(text: string): Promise<{ ok: boolean; summary?: string; message?: string }>;
      writeAutoBackup(content: string): Promise<{ ok: boolean; day?: string; message?: string }>;
      listAutoBackups(): Promise<{ name: string; savedAt: number; bytes: number; ok: boolean }[]>;
      readAutoBackup(name: string): Promise<{ ok: boolean; content?: string; message?: string }>;
      storageUsage(): Promise<{ total: number; items: { name: string; bytes: number }[] }>;
      usageSummary(): Promise<{ today: Record<string, number>; week: Record<string, number> }>;
      appInfo(): Promise<{ version: string; electron: string; node: string; chrome: string }>;
      openDataDir(): Promise<{ ok: boolean; message?: string }>;
      dataDirectory(): Promise<string>;
      exportSettings(): Promise<{ app: string; exportedAt: string; settings: AppSettings }>;
      importSettings(payload: unknown): Promise<{ ok: boolean; settings?: AppSettings; message?: string }>;
      writeSkill(draft: { name: string; description: string; body: string }): Promise<{ ok: boolean; fileName?: string; skills?: SkillInfo[]; message?: string }>;
      readSkill(fileName: string): Promise<{ ok: boolean; body?: string; message?: string }>;
      discardSkill(fileName: string): Promise<{ ok: boolean; skills?: SkillInfo[]; message?: string }>;
      lockStatus(): Promise<{ enabled: boolean }>;
      setLock(code: string): Promise<{ ok: boolean; enabled?: boolean; message?: string }>;
      verifyLock(code: string): Promise<{ ok: boolean }>;
      clearLock(code: string): Promise<{ ok: boolean; enabled?: boolean; message?: string }>;
      onSavedPagesUpdated(listener: (pages: SavedPage[]) => void): () => void;
      attachSavedPage(id: string): Promise<{ ok: boolean; message?: string; attachment?: DocumentAttachment }>;
      startSpeak(payload: { text: string; messageId: string }): Promise<{ ok: boolean; message?: string; characters?: number }>;
      stopSpeak(): Promise<{ ok: boolean }>;
      listVoices(): Promise<{ name: string; locale: string }[]>;
      onSpeakDone(listener: (payload: { messageId: string }) => void): () => void;
      exportPdf(payload: { html: string; fileName: string }): Promise<{
        ok: boolean;
        cancelled?: boolean;
        message?: string;
        filePath?: string;
      }>;
      captureScreenshot(mode?: "region" | "window" | "screen"): Promise<{
        ok: boolean;
        cancelled?: boolean;
        message?: string;
        attachment?: ImageAttachment;
      }>;
      onScreenshotRequested(listener: () => void): () => void;
      startSpeech(options?: { locale?: string; maxSeconds?: number }): Promise<{ ok: boolean; message?: string }>;
      stopSpeech(): Promise<{ ok: boolean }>;
      onSpeechEvent(listener: (payload: {
        type: "ready" | "partial" | "final" | "error";
        text?: string;
        code?: string;
        message?: string;
        reason?: string;
        on_device?: boolean;
        locale?: string;
      }) => void): () => void;
      onChatError(listener: (payload: {
        requestId: string;
        message: string;
        cancelled: boolean;
        runId?: string;
        resumable?: boolean;
        continueReason?: "interrupted";
      }) => void): () => void;
    };
  }
}

export {};
