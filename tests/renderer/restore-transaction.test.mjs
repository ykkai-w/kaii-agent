import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const restoreUrl = new URL("../../src/lib/restore.ts", import.meta.url);
const storageUrl = new URL("../../src/lib/storage.ts", import.meta.url);
const projectsUrl = new URL("../../src/lib/projects.ts", import.meta.url);
const promptsUrl = new URL("../../src/lib/prompts.ts", import.meta.url);
const {
  commitRestorePlan,
  planBackupRestore,
  readRestoreRawSnapshot,
  reconcilePendingRestore,
} = await import(fileURLToPath(restoreUrl));
const { CONVERSATIONS_KEY } = await import(fileURLToPath(storageUrl));
const { PROJECTS_KEY } = await import(fileURLToPath(projectsUrl));
const { PROMPTS_KEY } = await import(fileURLToPath(promptsUrl));

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  let failAt = null;
  let writes = 0;
  return {
    values,
    failOnWrite(number) { failAt = number; },
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      writes += 1;
      if (writes === failAt) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
    removeItem(key) {
      writes += 1;
      if (writes === failAt) throw new Error("QuotaExceededError");
      values.delete(key);
    },
  };
}

function conversation(id) {
  return { id, title: id, skillId: "none", createdAt: 1, updatedAt: 1, messages: [] };
}

function backup() {
  return JSON.stringify({
    app: "kaii",
    backupVersion: 1,
    exportedAt: "2026-08-30T00:00:00.000Z",
    conversations: [conversation("from-backup")],
    projects: [{ id: "p2", name: "备份项目", instructions: "", documents: [], createdAt: 2, updatedAt: 2 }],
    prompts: [{ id: "q2", label: "备份", body: "备份指令", createdAt: 2, useCount: 0 }],
  });
}

function current() {
  return {
    conversations: [conversation("current")],
    projects: [{ id: "p1", name: "现有项目", instructions: "", documents: [], createdAt: 1, updatedAt: 1 }],
    prompts: [{ id: "q1", label: "现有", body: "现有指令", createdAt: 1, useCount: 0 }],
  };
}

test("restore plan sanitizes once, merges by id and does not write", () => {
  const storage = memoryStorage({
    [CONVERSATIONS_KEY]: "{broken",
    [PROJECTS_KEY]: JSON.stringify(current().projects),
    [PROMPTS_KEY]: JSON.stringify(current().prompts),
  });
  const before = new Map(storage.values);
  const outcome = planBackupRestore(backup(), current(), storage, 100, "restore-1");
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.plan.counts, { conversations: 1, projects: 1, prompts: 1 });
  assert.deepEqual(storage.values, before, "plan phase must be read-only");
  assert.equal(outcome.plan.previous.conversations, "{broken");
  assert.match(outcome.plan.target.conversations, /from-backup/);
});

test("commit is exact and a reload sees all three collections", () => {
  const storage = memoryStorage({
    [CONVERSATIONS_KEY]: "{broken",
    [PROJECTS_KEY]: JSON.stringify(current().projects),
    [PROMPTS_KEY]: JSON.stringify(current().prompts),
  });
  const outcome = planBackupRestore(backup(), current(), storage, 100, "restore-2");
  assert.equal(outcome.ok, true);
  assert.deepEqual(commitRestorePlan(outcome.plan, storage), { ok: true });
  assert.deepEqual(readRestoreRawSnapshot(storage), outcome.plan.target);
  assert.deepEqual(JSON.parse(storage.getItem(PROJECTS_KEY)).map((item) => item.id), ["p1", "p2"]);
  assert.deepEqual(JSON.parse(storage.getItem(PROMPTS_KEY)).map((item) => item.id), ["q1", "q2"]);
  assert.deepEqual(JSON.parse(storage.getItem(CONVERSATIONS_KEY)).conversations.map((item) => item.id), ["current", "from-backup"]);
});

test("a mid-commit write failure restores the exact preimage", () => {
  const storage = memoryStorage({
    [CONVERSATIONS_KEY]: "{broken",
    [PROJECTS_KEY]: JSON.stringify(current().projects),
    [PROMPTS_KEY]: JSON.stringify(current().prompts),
  });
  const outcome = planBackupRestore(backup(), current(), storage, 100, "restore-3");
  assert.equal(outcome.ok, true);
  const before = outcome.plan.previous;
  storage.failOnWrite(3);
  const committed = commitRestorePlan(outcome.plan, storage);
  assert.equal(committed.ok, false);
  assert.deepEqual(readRestoreRawSnapshot(storage), before);
});

test("startup accepts a complete target and rolls a mixed state back", () => {
  const storage = memoryStorage({
    [CONVERSATIONS_KEY]: "{broken",
    [PROJECTS_KEY]: JSON.stringify(current().projects),
    [PROMPTS_KEY]: JSON.stringify(current().prompts),
  });
  const outcome = planBackupRestore(backup(), current(), storage, 100, "restore-4");
  assert.equal(outcome.ok, true);

  storage.setItem(CONVERSATIONS_KEY, outcome.plan.target.conversations);
  const mixed = reconcilePendingRestore(outcome.plan, storage);
  assert.deepEqual(mixed, { ok: true, action: "rolled_back" });
  assert.deepEqual(readRestoreRawSnapshot(storage), outcome.plan.previous);

  for (const [key, value] of [
    [CONVERSATIONS_KEY, outcome.plan.target.conversations],
    [PROJECTS_KEY, outcome.plan.target.projects],
    [PROMPTS_KEY, outcome.plan.target.prompts],
  ]) storage.setItem(key, value);
  const complete = reconcilePendingRestore(outcome.plan, storage);
  assert.deepEqual(complete, { ok: true, action: "committed" });
});

test("invalid backups fail before any write", () => {
  const storage = memoryStorage({ [CONVERSATIONS_KEY]: "keep" });
  const before = new Map(storage.values);
  const outcome = planBackupRestore("{no", current(), storage);
  assert.equal(outcome.ok, false);
  assert.deepEqual(storage.values, before);
});
