const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openMemoryDatabase } = require("./memory.cjs");

const MAX_SUMMARY = 2000;
const MAX_DETAIL = 60_000;
const MAX_ARGS_JSON = 20_000;
const MAX_CHANGED_PATHS = 200;
const MAX_CHECKPOINT_HASH_BYTES = 32 * 1024 * 1024;
const TOOL_STATUS = new Set(["running", "ok", "error", "denied", "cancelled"]);
const RUN_STATUS = new Set(["running", "done", "error", "cancelled", "interrupted"]);
const COMPLETION_STATE = new Set(["verified", "unverified", "partial", "read-only"]);
const CHECKPOINT_STOP_REASON = new Set([
  "running", "answer", "max-rounds", "stuck", "interrupted", "cancelled", "error", "truncated",
]);
const PLAN_STATUS = new Set(["todo", "doing", "done"]);

const prepared = new WeakSet();

function openAuditDatabase(userDataPath) {
  const database = openMemoryDatabase(userDataPath);
  if (prepared.has(database)) return database;
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      workspace_path TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','done','error','cancelled','interrupted')),
      rounds INTEGER NOT NULL DEFAULT 0,
      detail TEXT NOT NULL DEFAULT '',
      completion_json TEXT NOT NULL DEFAULT '',
      checkpoint_json TEXT NOT NULL DEFAULT '',
      parent_run_id TEXT,
      resumed_from_run_id TEXT,
      resumed_by_run_id TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      tool TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','ok','error','denied','cancelled')),
      summary TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      changed_path TEXT,
      snapshot_path TEXT,
      rolled_back INTEGER NOT NULL DEFAULT 0 CHECK(rolled_back IN (0,1))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tool_calls_recent ON tool_calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS tool_calls_by_run ON tool_calls(run_id, created_at);
  `);
  const runColumns = new Set(database.prepare("PRAGMA table_info(agent_runs)").all().map((column) => column.name));
  if (!runColumns.has("completion_json")) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN completion_json TEXT NOT NULL DEFAULT ''");
  }
  if (!runColumns.has("checkpoint_json")) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT ''");
  }
  if (!runColumns.has("parent_run_id")) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT");
  }
  if (!runColumns.has("resumed_from_run_id")) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN resumed_from_run_id TEXT");
  }
  if (!runColumns.has("resumed_by_run_id")) {
    database.exec("ALTER TABLE agent_runs ADD COLUMN resumed_by_run_id TEXT");
  }
  prepared.add(database);
  return database;
}

function clamp(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function scrubCheckpointText(value, maxLength) {
  return clamp(value, maxLength)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bAIza[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(api[_ -]?key|authorization|bearer|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function normalizeRunId(value, label, { optional = true } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new TypeError(`${label}无效`);
  return value;
}

function normalizeCheckpoint(checkpoint) {
  if (checkpoint === undefined || checkpoint === null) return null;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) throw new TypeError("任务检查点无效");
  const allowed = new Set([
    "goal", "workspace", "plan", "changedPaths", "lastCheck", "failureSummaries", "stopReason", "mutationEpoch",
    "workspaceDirty",
  ]);
  for (const key of Object.keys(checkpoint)) if (!allowed.has(key)) throw new TypeError(`任务检查点含未知字段：${key}`);

  const goal = scrubCheckpointText(checkpoint.goal, MAX_SUMMARY).trim();
  if (!goal) throw new TypeError("任务检查点目标无效");
  const workspace = checkpoint.workspace;
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) throw new TypeError("任务检查点工作区无效");
  for (const key of Object.keys(workspace)) if (!["id", "realpath"].includes(key)) throw new TypeError("任务检查点工作区含未知字段");
  const workspaceId = normalizeRunId(workspace.id, "工作区ID", { optional: false });
  if (typeof workspace.realpath !== "string" || !workspace.realpath || workspace.realpath.length > 4096
    || !workspace.realpath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(workspace.realpath)) {
    throw new TypeError("任务检查点工作区路径无效");
  }

  if (!Array.isArray(checkpoint.plan) || checkpoint.plan.length > 12) throw new TypeError("任务检查点计划无效");
  const plan = checkpoint.plan.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new TypeError("任务检查点计划无效");
    for (const key of Object.keys(step)) if (!["title", "status"].includes(key)) throw new TypeError("任务检查点计划含未知字段");
    const title = scrubCheckpointText(step.title, 200).trim();
    if (!title || !PLAN_STATUS.has(step.status)) throw new TypeError("任务检查点计划无效");
    return { title, status: step.status };
  });

  if (!Array.isArray(checkpoint.changedPaths) || checkpoint.changedPaths.length > MAX_CHANGED_PATHS) {
    throw new TypeError("任务检查点改动路径无效");
  }
  const changedPaths = [];
  const seenPaths = new Set();
  for (const item of checkpoint.changedPaths) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("任务检查点改动路径无效");
    for (const key of Object.keys(item)) if (!["path", "sha256", "exists", "stale"].includes(key)) throw new TypeError("任务检查点改动路径含未知字段");
    const safePath = scrubCheckpointText(item.path, 1024);
    if (!safePath || safePath.startsWith("/") || /[\u0000-\u001f\u007f]/.test(safePath)) {
      throw new TypeError("任务检查点改动路径无效");
    }
    if (item.sha256 !== null && (typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(item.sha256))) {
      throw new TypeError("任务检查点文件摘要无效");
    }
    if (typeof item.exists !== "boolean" || typeof item.stale !== "boolean") throw new TypeError("任务检查点文件状态无效");
    // 超大文件不能为了做检查点而整块读进内存。它仍然明确记为“存在”，
    // 但没有摘要时必须保持 stale，恢复后也不会自动开放写入。
    if (!item.exists && item.sha256 !== null) throw new TypeError("任务检查点文件状态不一致");
    if (item.exists && item.sha256 === null && item.stale !== true) throw new TypeError("任务检查点文件状态不一致");
    if (seenPaths.has(safePath)) continue;
    seenPaths.add(safePath);
    changedPaths.push({ path: safePath, sha256: item.sha256?.toLowerCase() ?? null, exists: item.exists, stale: item.stale });
  }

  let lastCheck = null;
  if (checkpoint.lastCheck !== undefined && checkpoint.lastCheck !== null) {
    const check = checkpoint.lastCheck;
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new TypeError("任务检查点检查结果无效");
    for (const key of Object.keys(check)) if (!["summary", "ok", "timedOut", "mutationEpoch"].includes(key)) throw new TypeError("任务检查点检查结果含未知字段");
    if (typeof check.ok !== "boolean" || typeof check.timedOut !== "boolean"
      || !Number.isInteger(check.mutationEpoch) || check.mutationEpoch < 0 || check.mutationEpoch > 1_000_000) {
      throw new TypeError("任务检查点检查结果无效");
    }
    lastCheck = {
      summary: scrubCheckpointText(check.summary, MAX_SUMMARY).split("\n", 1)[0] || "检查没有返回摘要",
      ok: check.ok,
      timedOut: check.timedOut,
      mutationEpoch: check.mutationEpoch,
    };
  }

  if (!Array.isArray(checkpoint.failureSummaries) || checkpoint.failureSummaries.length > 12) {
    throw new TypeError("任务检查点失败摘要无效");
  }
  const failureSummaries = checkpoint.failureSummaries.map((failure) => {
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) throw new TypeError("任务检查点失败摘要无效");
    for (const key of Object.keys(failure)) if (!["tool", "path", "summary"].includes(key)) throw new TypeError("任务检查点失败摘要含未知字段");
    if (typeof failure.tool !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(failure.tool)) throw new TypeError("任务检查点失败工具无效");
    const safeFailurePath = failure.path === null || failure.path === undefined
      ? null
      : scrubCheckpointText(failure.path, 1024);
    if (safeFailurePath !== null && (!safeFailurePath || safeFailurePath.startsWith("/")
      || /[\u0000-\u001f\u007f]/.test(safeFailurePath))) {
      throw new TypeError("任务检查点失败路径无效");
    }
    const summary = scrubCheckpointText(failure.summary, 500).split("\n", 1)[0].trim();
    if (!summary) throw new TypeError("任务检查点失败摘要无效");
    return { tool: failure.tool, path: safeFailurePath, summary };
  });

  if (!CHECKPOINT_STOP_REASON.has(checkpoint.stopReason)) throw new TypeError("任务检查点停止原因无效");
  if (!Number.isInteger(checkpoint.mutationEpoch) || checkpoint.mutationEpoch < 0 || checkpoint.mutationEpoch > 1_000_000) {
    throw new TypeError("任务检查点修改代数无效");
  }
  if (lastCheck && lastCheck.mutationEpoch > checkpoint.mutationEpoch) throw new TypeError("任务检查点检查代数无效");
  if (checkpoint.workspaceDirty !== undefined && typeof checkpoint.workspaceDirty !== "boolean") {
    throw new TypeError("任务检查点工作区状态无效");
  }
  return {
    goal,
    workspace: { id: workspaceId, realpath: workspace.realpath },
    plan,
    changedPaths,
    lastCheck,
    failureSummaries,
    stopReason: checkpoint.stopReason,
    mutationEpoch: checkpoint.mutationEpoch,
    workspaceDirty: checkpoint.workspaceDirty === true,
  };
}

function parseCheckpoint(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeCheckpoint(JSON.parse(value));
  } catch {
    return null;
  }
}

function startRun(userDataPath, {
  requestId,
  workspacePath,
  goal,
  checkpoint = null,
}) {
  const database = openAuditDatabase(userDataPath);
  const id = crypto.randomUUID();
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  database.prepare(`
    INSERT INTO agent_runs(
      id,request_id,created_at,workspace_path,goal,status,rounds,detail,
      checkpoint_json,parent_run_id,resumed_from_run_id
    )
    VALUES(?,?,?,?,?,'running',0,'',?,?,?)
  `).run(
    id,
    String(requestId).slice(0, 128),
    Date.now(),
    clamp(workspacePath, 4096),
    scrubCheckpointText(goal, MAX_SUMMARY),
    normalizedCheckpoint ? JSON.stringify(normalizedCheckpoint) : "",
    null,
    null,
  );
  return id;
}

function isRowResumable(row, checkpoint = parseCheckpoint(row?.checkpoint_json)) {
  return Boolean(row && checkpoint && !row.resumed_by_run_id) && (
    row.status === "interrupted"
    || (row.status === "done" && ["max-rounds", "stuck", "truncated"].includes(checkpoint.stopReason))
  );
}

function startResumedRun(userDataPath, {
  requestId,
  workspacePath,
  goal,
  checkpoint,
  resumedFrom,
}) {
  const sourceId = normalizeRunId(resumedFrom, "恢复来源ID", { optional: false });
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  if (!normalizedCheckpoint) throw new TypeError("任务检查点无效");
  if (clamp(workspacePath, 4096) !== normalizedCheckpoint.workspace.realpath) {
    throw new Error("恢复任务的工作区与检查点不一致");
  }
  const database = openAuditDatabase(userDataPath);
  const childId = crypto.randomUUID();
  let rootId = null;
  database.exec("BEGIN IMMEDIATE");
  try {
    const parent = database.prepare("SELECT * FROM agent_runs WHERE id=?").get(sourceId);
    const parentCheckpoint = parent ? parseCheckpoint(parent.checkpoint_json) : null;
    if (!parent) throw new Error("找不到要恢复的工程任务");
    if (!isRowResumable(parent, parentCheckpoint)) {
      if (parent.resumed_by_run_id) throw new Error("这次工程任务已经被继续过，不能重复恢复");
      throw new Error("这次工程任务已经干净结束，不能恢复");
    }
    if (
      parentCheckpoint.workspace.id !== normalizedCheckpoint.workspace.id
      || parentCheckpoint.workspace.realpath !== normalizedCheckpoint.workspace.realpath
      || parent.workspace_path !== workspacePath
    ) {
      throw new Error("恢复任务的工作区与原任务不一致");
    }
    rootId = parent.parent_run_id || parent.id;
    database.prepare(`
      INSERT INTO agent_runs(
        id,request_id,created_at,workspace_path,goal,status,rounds,detail,
        checkpoint_json,parent_run_id,resumed_from_run_id,resumed_by_run_id
      )
      VALUES(?,?,?,?,?,'running',0,'',?,?,?,NULL)
    `).run(
      childId,
      String(requestId).slice(0, 128),
      Date.now(),
      clamp(workspacePath, 4096),
      scrubCheckpointText(goal, MAX_SUMMARY),
      JSON.stringify(normalizedCheckpoint),
      rootId,
      sourceId,
    );
    const claim = database.prepare(`
      UPDATE agent_runs SET resumed_by_run_id=? WHERE id=? AND resumed_by_run_id IS NULL
    `).run(childId, sourceId);
    if (Number(claim.changes) !== 1) throw new Error("这次工程任务已经被继续过，不能重复恢复");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { id: childId, parentRunId: rootId, resumedFrom: sourceId };
}

function normalizeCompletion(completion) {
  if (completion === undefined || completion === null) return null;
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) {
    throw new TypeError("完成证据无效");
  }
  if (!COMPLETION_STATE.has(completion.state)) throw new TypeError("完成证据状态无效");
  if (!Array.isArray(completion.changedPaths) || completion.changedPaths.length > 200) {
    throw new TypeError("完成证据路径无效");
  }
  const changedPaths = [];
  const seen = new Set();
  for (const value of completion.changedPaths) {
    if (typeof value !== "string" || !value || value.length > 4096) throw new TypeError("完成证据路径无效");
    if (!seen.has(value)) changedPaths.push(value);
    seen.add(value);
  }
  if (!Array.isArray(completion.checks) || completion.checks.length > 20) {
    throw new TypeError("完成证据检查无效");
  }
  const checks = completion.checks.map((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)
      || typeof check.summary !== "string" || typeof check.ok !== "boolean" || typeof check.timedOut !== "boolean") {
      throw new TypeError("完成证据检查无效");
    }
    return { summary: clamp(check.summary, MAX_SUMMARY), ok: check.ok, timedOut: check.timedOut };
  });
  return { state: completion.state, changedPaths, checks };
}

function parseCompletion(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeCompletion(JSON.parse(value));
  } catch {
    return null;
  }
}

function saveRunCheckpoint(userDataPath, runId, { rounds = 0, checkpoint }) {
  const id = normalizeRunId(runId, "任务ID", { optional: false });
  const normalized = normalizeCheckpoint(checkpoint);
  if (!normalized) throw new TypeError("任务检查点无效");
  const database = openAuditDatabase(userDataPath);
  const result = database.prepare("UPDATE agent_runs SET rounds=?,checkpoint_json=? WHERE id=? AND status='running'")
    .run(Math.max(0, Math.trunc(rounds)), JSON.stringify(normalized), id);
  if (Number(result.changes) !== 1) throw new Error("任务已经结束或不存在，不能再保存检查点");
  return normalized;
}

function finishRun(userDataPath, runId, {
  status,
  rounds = 0,
  detail = "",
  completion = null,
  checkpoint = undefined,
}) {
  if (!RUN_STATUS.has(status)) throw new TypeError("运行状态无效");
  const database = openAuditDatabase(userDataPath);
  const normalizedCompletion = normalizeCompletion(completion);
  const normalizedCheckpoint = checkpoint === undefined ? undefined : normalizeCheckpoint(checkpoint);
  const result = database.prepare(`
    UPDATE agent_runs
    SET status=?,rounds=?,detail=?,completion_json=?,checkpoint_json=COALESCE(?,checkpoint_json),finished_at=?
    WHERE id=?
  `)
    .run(
      status,
      Math.max(0, Math.trunc(rounds)),
      clamp(detail, MAX_SUMMARY),
      normalizedCompletion ? JSON.stringify(normalizedCompletion) : "",
      normalizedCheckpoint === undefined ? null : (normalizedCheckpoint ? JSON.stringify(normalizedCheckpoint) : ""),
      Date.now(),
      runId,
    );
  if (Number(result.changes) !== 1) throw new Error("任务不存在");
}

function pendingMutationState(run, call) {
  if (call.tool !== "apply_patch") return null;
  let args;
  try {
    args = JSON.parse(call.args_json);
  } catch {
    return null;
  }
  if (!args || typeof args.path !== "string" || !args.path || args.path.length > 1024
    || path.isAbsolute(args.path) || /[\u0000-\u001f\u007f]/.test(args.path)) return null;
  const relative = path.normalize(args.path).replace(/^\.\/+/, "");
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  const root = path.resolve(run.workspace_path);
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) return null;
  let exists = false;
  let sha256 = null;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      exists = true;
      if (stat.size <= MAX_CHECKPOINT_HASH_BYTES) {
        const handle = fs.openSync(target, "r");
        try {
          const hash = crypto.createHash("sha256");
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let position = 0;
          while (position < stat.size) {
            const read = fs.readSync(handle, buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (read < 1) break;
            hash.update(buffer.subarray(0, read));
            position += read;
          }
          if (position === stat.size) sha256 = hash.digest("hex");
        } finally {
          fs.closeSync(handle);
        }
      }
    }
  } catch {}
  return { path: relative, sha256, exists, stale: true };
}

function markInterruptedRuns(userDataPath) {
  const database = openAuditDatabase(userDataPath);
  const now = Date.now();
  let result;
  let calls;
  database.exec("BEGIN IMMEDIATE");
  try {
    const running = database.prepare("SELECT * FROM agent_runs WHERE status='running'").all();
    const pendingCalls = database.prepare(`
      SELECT tool,args_json FROM tool_calls WHERE run_id=? AND status='running' ORDER BY created_at
    `);
    const updateCheckpoint = database.prepare("UPDATE agent_runs SET checkpoint_json=? WHERE id=?");
    for (const row of running) {
      let checkpoint = parseCheckpoint(row.checkpoint_json);
      // 历史坏记录也必须结束 running。原始 JSON 留在库里供人工审计，
      // 但不把无法验证的内容转成可自动恢复检查点。
      if (!checkpoint) continue;
      const changedPaths = checkpoint.changedPaths.map((item) => ({ ...item }));
      const byPath = new Map(changedPaths.map((item) => [item.path, item]));
      const failureSummaries = checkpoint.failureSummaries.map((item) => ({ ...item }));
      let recovered = 0;
      for (const call of pendingCalls.all(row.id)) {
        if (call.tool === "run_test") {
          checkpoint.workspaceDirty = true;
          failureSummaries.push({
            tool: "run_test",
            path: null,
            summary: "应用退出时测试命令仍在运行，工作区可能被它改过；恢复后必须先重扫工作区",
          });
          recovered += 1;
          continue;
        }
        const state = pendingMutationState(row, call);
        if (!state) continue;
        const existing = byPath.get(state.path);
        if (existing) Object.assign(existing, state);
        else if (changedPaths.length < MAX_CHANGED_PATHS) {
          changedPaths.push(state);
          byPath.set(state.path, state);
        } else {
          // 路径本身仍保留在 running tool_calls.args_json 里；检查点用整个
          // 工作区 dirty 覆盖它，绝不因第 201 项让启动事务回滚或悄悄开放写入。
          checkpoint.workspaceDirty = true;
        }
        failureSummaries.push({
          tool: call.tool,
          path: state.path,
          summary: "应用退出时这次写入是否完整落盘无法确认，恢复前必须重新读取",
        });
        recovered += 1;
      }
      checkpoint = normalizeCheckpoint({
        ...checkpoint,
        changedPaths,
        lastCheck: recovered ? null : checkpoint.lastCheck,
        failureSummaries: failureSummaries.slice(-12),
        stopReason: "interrupted",
        mutationEpoch: Math.min(1_000_000, checkpoint.mutationEpoch + recovered),
        workspaceDirty: checkpoint.workspaceDirty,
      });
      updateCheckpoint.run(JSON.stringify(checkpoint), row.id);
    }
    result = database.prepare(
      "UPDATE agent_runs SET status='interrupted',finished_at=? ,detail='应用退出时这次任务还没有结束' WHERE status='running'",
    ).run(now);
    calls = database.prepare(
      "UPDATE tool_calls SET status='cancelled',finished_at=?,summary='应用退出时这次调用还没有结束' WHERE status='running'",
    ).run(now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { runs: Number(result.changes), calls: Number(calls.changes) };
}

function startToolCall(userDataPath, { runId, requestId, tool, workspacePath, args }) {
  const database = openAuditDatabase(userDataPath);
  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO tool_calls(id,run_id,request_id,created_at,tool,workspace_path,args_json,status)
    VALUES(?,?,?,?,?,?,?,'running')
  `).run(
    id,
    String(runId).slice(0, 64),
    String(requestId).slice(0, 128),
    Date.now(),
    String(tool).slice(0, 64),
    clamp(workspacePath, 4096),
    clamp(JSON.stringify(args ?? {}), MAX_ARGS_JSON),
  );
  return id;
}

function finishToolCall(userDataPath, callId, { status, summary = "", detail = "", changedPath = null, snapshotPath = null }) {
  if (!TOOL_STATUS.has(status)) throw new TypeError("工具状态无效");
  const database = openAuditDatabase(userDataPath);
  database.prepare(`
    UPDATE tool_calls SET status=?,summary=?,detail=?,changed_path=?,snapshot_path=?,finished_at=? WHERE id=?
  `).run(
    status,
    clamp(summary, MAX_SUMMARY),
    clamp(detail, MAX_DETAIL),
    changedPath ? clamp(changedPath, 4096) : null,
    snapshotPath ? clamp(snapshotPath, 4096) : null,
    Date.now(),
    callId,
  );
}

function finishToolCallWithCheckpoint(userDataPath, callId, toolResult, { runId, rounds = 0, checkpoint }) {
  if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) throw new TypeError("工具结果无效");
  const { status, summary = "", detail = "", changedPath = null, snapshotPath = null } = toolResult;
  if (!TOOL_STATUS.has(status)) throw new TypeError("工具状态无效");
  const id = normalizeRunId(runId, "任务ID", { optional: false });
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  if (!normalizedCheckpoint) throw new TypeError("任务检查点无效");
  const database = openAuditDatabase(userDataPath);
  database.exec("BEGIN IMMEDIATE");
  try {
    const callResult = database.prepare(`
      UPDATE tool_calls SET status=?,summary=?,detail=?,changed_path=?,snapshot_path=?,finished_at=? WHERE id=?
    `).run(
      status,
      clamp(summary, MAX_SUMMARY),
      clamp(detail, MAX_DETAIL),
      changedPath ? clamp(changedPath, 4096) : null,
      snapshotPath ? clamp(snapshotPath, 4096) : null,
      Date.now(),
      callId,
    );
    if (Number(callResult.changes) !== 1) throw new Error("工具调用不存在");
    const runResult = database.prepare("UPDATE agent_runs SET rounds=?,checkpoint_json=? WHERE id=? AND status='running'")
      .run(Math.max(0, Math.trunc(rounds)), JSON.stringify(normalizedCheckpoint), id);
    if (Number(runResult.changes) !== 1) throw new Error("任务已经结束或不存在，不能再保存检查点");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return normalizedCheckpoint;
}

function rowToToolCall(row) {
  let args = {};
  try {
    args = JSON.parse(row.args_json);
  } catch {
    args = {};
  }
  return {
    id: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
    tool: row.tool,
    workspacePath: row.workspace_path,
    args,
    status: row.status,
    summary: row.summary,
    detail: row.detail,
    changedPath: row.changed_path ?? null,
    snapshotPath: row.snapshot_path ?? null,
    rolledBack: Boolean(row.rolled_back),
  };
}

function listToolCalls(userDataPath, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError("limit无效");
  const database = openAuditDatabase(userDataPath);
  return database.prepare("SELECT * FROM tool_calls ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToToolCall);
}

function getToolCall(userDataPath, callId) {
  const database = openAuditDatabase(userDataPath);
  const row = database.prepare("SELECT * FROM tool_calls WHERE id=?").get(String(callId));
  return row ? rowToToolCall(row) : null;
}

function listRunToolCalls(userDataPath, runId) {
  const database = openAuditDatabase(userDataPath);
  return database.prepare("SELECT * FROM tool_calls WHERE run_id=? ORDER BY created_at").all(String(runId)).map(rowToToolCall);
}

function markRolledBack(userDataPath, callId) {
  const database = openAuditDatabase(userDataPath);
  const result = database.prepare("UPDATE tool_calls SET rolled_back=1 WHERE id=?").run(String(callId));
  if (Number(result.changes) !== 1) throw new Error("找不到这次工具调用");
  return { ok: true, id: callId };
}

function rowToRun(row) {
  const checkpoint = parseCheckpoint(row.checkpoint_json);
  const completion = parseCompletion(row.completion_json);
  const resumable = isRowResumable(row, checkpoint);
  return {
    id: row.id,
    requestId: row.request_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
    workspacePath: row.workspace_path,
    goal: row.goal,
    status: row.status,
    rounds: row.rounds,
    detail: row.detail,
    completion,
    checkpoint,
    parentRunId: row.parent_run_id ?? null,
    resumedFrom: row.resumed_from_run_id ?? null,
    resumedBy: row.resumed_by_run_id ?? null,
    resumable,
  };
}

function getRun(userDataPath, runId) {
  const id = normalizeRunId(runId, "任务ID", { optional: false });
  const database = openAuditDatabase(userDataPath);
  const row = database.prepare("SELECT * FROM agent_runs WHERE id=?").get(id);
  return row ? rowToRun(row) : null;
}

function listRuns(userDataPath, { limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("limit无效");
  const database = openAuditDatabase(userDataPath);
  return database.prepare("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?").all(limit).map(rowToRun);
}

module.exports = {
  finishRun,
  finishToolCall,
  finishToolCallWithCheckpoint,
  getRun,
  getToolCall,
  listRunToolCalls,
  listRuns,
  listToolCalls,
  markInterruptedRuns,
  markRolledBack,
  openAuditDatabase,
  saveRunCheckpoint,
  startResumedRun,
  startRun,
  startToolCall,
};
