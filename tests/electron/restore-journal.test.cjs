const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const journal = require("../../electron/lib/restore-journal.cjs");

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kaii-restore-journal-"));
}

function payload(id = "restore-123") {
  return {
    version: 1,
    id,
    createdAt: 100,
    previous: { conversations: "old-c", legacyConversations: null, projects: "old-p", prompts: "old-q" },
    target: { conversations: "new-c", legacyConversations: null, projects: "new-p", prompts: "new-q" },
  };
}

test("prepare is durable, exact and idempotent", () => {
  const userData = tempDirectory();
  try {
    assert.deepEqual(journal.prepareRestoreTransaction(userData, payload()), {
      ok: true, id: "restore-123", alreadyPrepared: false,
    });
    assert.deepEqual(journal.prepareRestoreTransaction(userData, payload()), {
      ok: true, id: "restore-123", alreadyPrepared: true,
    });
    const pending = journal.readPendingRestoreTransaction(userData);
    assert.equal(pending.id, "restore-123");
    assert.deepEqual(pending.previous, payload().previous);
    const file = path.join(journal.journalDirectory(userData), "restore-123.pending.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("resolve writes a receipt before removing pending state", () => {
  const userData = tempDirectory();
  try {
    journal.prepareRestoreTransaction(userData, payload("restore-456"));
    const outcome = journal.resolveRestoreTransaction(userData, "restore-456", "committed");
    assert.equal(outcome.missing, false);
    assert.equal(journal.readPendingRestoreTransaction(userData), null);
    const receipt = JSON.parse(fs.readFileSync(path.join(journal.journalDirectory(userData), "restore-456.committed.json"), "utf8"));
    assert.equal(receipt.status, "committed");
    assert.ok(receipt.resolvedAt > 0);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("unknown fields and oversized or malformed snapshots fail closed", () => {
  const userData = tempDirectory();
  try {
    assert.throws(() => journal.prepareRestoreTransaction(userData, { ...payload(), extra: true }), /unknown|\u672a\u77e5/i);
    assert.throws(() => journal.prepareRestoreTransaction(userData, {
      ...payload(), previous: { ...payload().previous, conversations: "x".repeat(journal.MAX_RAW_BYTES + 1) },
    }), /capacity|\u5bb9\u91cf/i);
    assert.throws(() => journal.prepareRestoreTransaction(userData, {
      ...payload(), target: { ...payload().target, projects: { bad: true } },
    }));
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
