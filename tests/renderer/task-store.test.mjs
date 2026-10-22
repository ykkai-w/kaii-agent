import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const capsuleUrl = new URL("../../src/lib/task-capsule.ts", import.meta.url);
const storeUrl = new URL("../../src/lib/task-store.ts", import.meta.url);
const { capsuleInput, createTaskCapsule, previewPrivacy, privacyInventory } = await import(fileURLToPath(capsuleUrl));
const {
  TASK_STORE_KEY,
  loadTaskCapsulesWithStatus,
  parseTaskStore,
  saveTaskCapsules,
  upsertTaskCapsule,
} = await import(fileURLToPath(storeUrl));

function storage(raw = null) {
  const map = new Map(raw === null ? [] : [[TASK_STORE_KEY, raw]]);
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    map,
  };
}

function capsule(id = "task-1", updatedAt = 1) {
  const preview = previewPrivacy("分析这份文档");
  return createTaskCapsule({
    id,
    createdAt: 1,
    updatedAt,
    target: "分析这份文档",
    inputs: [capsuleInput("input-1", "问题", "分析这份文档")],
    route: { provider: "local", model: "qwen", local: true },
    routingReason: "仅本机",
    privacy: privacyInventory(preview, 1, { reviewedAt: 1, approvedForSend: true }),
  });
}

test("task store round-trips only validated capsules", () => {
  const target = storage();
  assert.equal(saveTaskCapsules([capsule()], target).ok, true);
  const loaded = loadTaskCapsulesWithStatus(target);
  assert.equal(loaded.status, "valid");
  assert.equal(loaded.capsules[0].id, "task-1");
});

test("unknown root versions and damaged children fail closed", () => {
  assert.equal(parseTaskStore(JSON.stringify({ version: 99, capsules: [] })).status, "unsupported");
  const damaged = JSON.stringify({ version: 1, capsules: [{ schemaVersion: 2, id: "broken" }] });
  assert.equal(parseTaskStore(damaged).status, "corrupt");
  const target = storage(damaged);
  const before = target.getItem(TASK_STORE_KEY);
  assert.equal(saveTaskCapsules([capsule()], target).ok, false);
  assert.equal(target.getItem(TASK_STORE_KEY), before);
});

test("upsert keeps newest first without duplicating an id", () => {
  const next = upsertTaskCapsule([capsule("a", 1), capsule("b", 2)], capsule("a", 3));
  assert.deepEqual(next.map((item) => item.id), ["a", "b"]);
  assert.equal(next[0].updatedAt, 3);
});
