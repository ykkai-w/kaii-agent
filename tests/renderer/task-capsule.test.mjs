import test from "node:test";
import assert from "node:assert/strict";

const lib = await import(new URL("../../src/lib/task-capsule.ts", import.meta.url).href);

function makeCapsule({ local = true, approved = false, sendMode = "redacted", text = "ordinary input" } = {}) {
  const preview = lib.previewPrivacy(text);
  return lib.createTaskCapsule({
    id: "capsule-1", createdAt: 10, updatedAt: 10, target: "Produce a checked result",
    inputs: [lib.capsuleInput("input-1", "Source", text)],
    route: { provider: local ? "local" : "zhipu", model: "test-model", local },
    routingReason: "Use the selected route for this bounded task.",
    privacy: lib.privacyInventory(preview, 10, { reviewedAt: approved ? 11 : null, approvedForSend: approved, sendMode }),
  });
}

function verifyCapsule(capsule) {
  const checkpoint = { id: "checkpoint-1", label: "Output checked", status: "verified", detail: "Deterministic comparison passed.", observedAt: 20 };
  const artifact = { id: "artifact-1", kind: "report", label: "Result", sha256: lib.sha256Text("report body"), uri: null, createdAt: 21 };
  let result = lib.appendCheckpoint(capsule, checkpoint);
  result = lib.appendArtifact(result, artifact);
  return lib.appendEvidenceReceipt(result, {
    id: "receipt-1", checkpointId: checkpoint.id, status: "verified", summary: "The input and output were checked.", observedAt: 22,
    inputHashes: result.inputs.map((input) => input.sha256), artifactIds: [artifact.id],
  });
}

test("sha256 and privacy preview are deterministic and do not retain matched values", () => {
  assert.equal(lib.sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const secret = `sk-proj-${"A".repeat(24)}`;
  const text = `mail kai@example.com phone 13800138000 id 11010519491231002X card 4111 1111 1111 1111 key ${secret} password=hunter2`;
  const first = lib.previewPrivacy(text);
  assert.deepEqual(first, lib.previewPrivacy(text));
  for (const raw of ["kai@example.com", "13800138000", "11010519491231002X", "4111 1111 1111 1111", secret, "hunter2"]) {
    assert.equal(first.redactedText.includes(raw), false);
    assert.equal(JSON.stringify(first.findings).includes(raw), false);
  }
  assert.ok(first.findings.some((finding) => finding.kind === "openai_api_key"));
  assert.ok(first.findings.some((finding) => finding.kind === "cn_id"));
  assert.match(first.redactedText, /\[REDACTED:OPENAI_API_KEY:1\]/);
});

test("multi-message privacy preview matches the exact redacted messages sent to cloud", () => {
  const key = `sk-proj-${"C".repeat(24)}`;
  const preview = lib.previewPrivacyMessages([
    { role: "user", content: `旧消息 ${key}` },
    { role: "assistant", content: "请联系 kai@example.com" },
    { role: "user", content: "继续" },
  ]);
  assert.equal(preview.redactedMessages.length, 3);
  assert.equal(preview.redactedMessages.some((message) => message.includes(key)), false);
  assert.equal(preview.redactedMessages.some((message) => message.includes("kai@example.com")), false);
  assert.match(preview.redactedMessages[0], /REDACTED:OPENAI_API_KEY:1/);
  assert.match(preview.redactedMessages[1], /REDACTED:EMAIL:1/);
  assert.equal(preview.redactedText, [
    `【1 · user】\n${preview.redactedMessages[0]}`,
    `【2 · assistant】\n${preview.redactedMessages[1]}`,
    `【3 · user】\n${preview.redactedMessages[2]}`,
  ].join("\n\n"));
  assert.equal(preview.redactedHash, lib.sha256Text(preview.redactedText));
});

test("privacy gate permits local use but requires review and redaction before cloud secret upload", () => {
  const text = `token sk-proj-${"B".repeat(24)}`;
  assert.equal(lib.evaluatePrivacyGate(makeCapsule({ text })).allowed, true);
  assert.equal(lib.evaluatePrivacyGate(makeCapsule({ local: false, text })).status, "needs_user");
  const original = makeCapsule({ local: false, approved: true, sendMode: "original", text });
  assert.equal(lib.evaluatePrivacyGate(original).allowed, false);
  assert.match(lib.evaluatePrivacyGate(original).reasons.join(" "), /\u51ed\u636e/);
  const redacted = makeCapsule({ local: false, approved: true, sendMode: "redacted", text });
  assert.equal(lib.evaluatePrivacyGate(redacted).allowed, true);
  assert.equal(lib.evaluatePrivacyGate(redacted).payloadHash, redacted.privacy.redactedHash);
});

test("verified requires complete evidence and terminal failure cannot reopen", () => {
  const base = makeCapsule();
  assert.throws(() => lib.serializeTaskCapsule({ ...base, status: "verified" }), /verified/);
  const verified = verifyCapsule(base);
  assert.equal(verified.status, "verified");
  assert.deepEqual(lib.evaluateEvidenceGate(verified), { allowed: true, reasons: [] });
  assert.equal(lib.canTransitionCapsuleStatus("verified", "retryable"), false);
  const failed = lib.appendEvidenceReceipt(makeCapsule(), {
    id: "failure-1", checkpointId: null, status: "terminal_failure", summary: "Input format is permanently unsupported.", observedAt: 30,
    inputHashes: [base.inputs[0].sha256], artifactIds: [],
  });
  assert.equal(failed.status, "terminal_failure");
  assert.throws(() => lib.transitionTaskCapsuleStatus(failed, "unverified", 31), /\u72b6\u6001\u4e0d\u80fd/);
});

test("memory proposals are append-only, evidence-sourced, scoped and corrigible", () => {
  const verified = verifyCapsule(makeCapsule());
  const proposal = {
    id: "memory-1", state: "valid", kind: "fact", content: "The checked artifact uses the current input.", scope: { kind: "project", id: "kai-local" },
    source: { capsuleId: verified.id, receiptId: "receipt-1", inputHashes: verified.inputs.map((item) => item.sha256) },
    targetProposalId: null, reason: null, createdAt: 23, validFrom: 23, validUntil: null,
  };
  const withMemory = lib.appendMemoryProposal(verified, proposal);
  assert.equal(verified.memoryProposals.length, 0);
  assert.equal(withMemory.memoryProposals[0].sequence, 1);
  const corrected = lib.appendMemoryProposal(withMemory, {
    ...proposal, id: "memory-2", state: "superseded", content: "Correction marker", targetProposalId: "memory-1",
    reason: "A newer verified interpretation replaces it.", createdAt: 24, validFrom: 24,
  });
  assert.deepEqual(lib.resolveMemoryProposals(corrected.memoryProposals).valid, []);
  assert.deepEqual(lib.resolveMemoryProposals(corrected.memoryProposals).superseded, ["memory-1"]);
  assert.throws(() => lib.appendMemoryProposal(verified, { ...proposal, source: { ...proposal.source, receiptId: "missing" } }), /verified/);
});

test("serialization roundtrips deterministically and nested corruption fails closed", () => {
  const capsule = verifyCapsule(makeCapsule());
  const serialized = lib.serializeTaskCapsule(capsule);
  assert.equal(serialized, lib.serializeTaskCapsule(capsule));
  const parsed = lib.parseTaskCapsule(serialized);
  assert.equal(parsed.status, "valid");
  assert.deepEqual(parsed.capsule, capsule);
  const broken = JSON.parse(serialized);
  broken.receipts[0].artifactIds = ["missing-artifact"];
  assert.equal(lib.parseTaskCapsule(JSON.stringify(broken)).status, "corrupt");
  assert.equal(lib.parseTaskCapsule("not-json").status, "corrupt");
  assert.equal(lib.parseTaskCapsule(JSON.stringify({ schemaVersion: 99 })).status, "unsupported");
});

test("v1 data migrates explicitly while malformed legacy data fails closed", () => {
  const base = makeCapsule();
  const legacy = {
    schemaVersion: 1, id: base.id, createdAt: base.createdAt, updatedAt: base.updatedAt, target: base.target,
    inputHashes: base.inputs.map((input) => input.sha256), provider: base.route.provider, model: base.route.model, local: base.route.local,
    routingReason: base.routingReason, privacy: base.privacy, status: base.status, checkpoints: [], artifacts: [], receipts: [],
  };
  const migrated = lib.parseTaskCapsule(JSON.stringify(legacy));
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.migratedFrom, 1);
  assert.equal(migrated.capsule.schemaVersion, 2);
  assert.equal(lib.parseTaskCapsule(lib.serializeTaskCapsule(migrated.capsule)).status, "valid");
  legacy.inputHashes = ["not-a-hash"];
  assert.equal(lib.parseTaskCapsule(JSON.stringify(legacy)).status, "corrupt");
});
