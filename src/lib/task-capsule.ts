// 任务胶囊：把「这次要做什么、用了哪份输入、发给谁、
// 隐私边界是什么、做到哪里、凭什么说完成」收成一份可验证记录。
//
// 这一层刻意没有 I/O、没有模型调用、没有 Date.now/randomUUID：
// 上层可以放 localStorage、文件或数据库，测试则能复现每一个字节。

export const TASK_CAPSULE_SCHEMA_VERSION = 2;
export const TASK_CAPSULE_LEGACY_SCHEMA_VERSION = 1;

export type CapsuleStatus =
  | "verified"
  | "unverified"
  | "needs_user"
  | "retryable"
  | "stale"
  | "terminal_failure";

export type PrivacyCategory = "secret" | "pii";
export type PrivacyKind =
  | "private_key"
  | "anthropic_api_key"
  | "openai_api_key"
  | "github_token"
  | "aws_access_key"
  | "bearer_token"
  | "credential_value"
  | "email"
  | "cn_phone"
  | "cn_id"
  | "bank_card";

export interface CapsuleInput {
  id: string;
  label: string;
  sha256: string;
  bytes: number;
}

export interface ProviderRoute {
  provider: string;
  model: string;
  local: boolean;
}

export interface PrivacyFinding {
  id: string;
  category: PrivacyCategory;
  kind: PrivacyKind;
  start: number;
  end: number;
  placeholder: string;
}

export interface PrivacyPreview {
  originalHash: string;
  redactedHash: string;
  originalBytes: number;
  redactedBytes: number;
  redactedText: string;
  findings: PrivacyFinding[];
}

export interface PrivacyMessagePreview extends PrivacyPreview {
  redactedMessages: string[];
}

export interface PrivacyInventory {
  scannedAt: number;
  originalHash: string;
  redactedHash: string;
  originalBytes: number;
  redactedBytes: number;
  findings: PrivacyFinding[];
  reviewedAt: number | null;
  approvedForSend: boolean;
  sendMode: "original" | "redacted";
}

export interface TaskCheckpoint {
  id: string;
  label: string;
  status: CapsuleStatus;
  detail: string;
  observedAt: number;
}

export interface TaskArtifact {
  id: string;
  kind: "file" | "text" | "report" | "dataset" | "other";
  label: string;
  sha256: string;
  uri: string | null;
  createdAt: number;
}

export interface EvidenceReceipt {
  id: string;
  checkpointId: string | null;
  status: CapsuleStatus;
  summary: string;
  observedAt: number;
  inputHashes: string[];
  artifactIds: string[];
}

export type MemoryProposalState = "valid" | "superseded" | "disputed";
export type MemoryScope =
  | { kind: "global"; id: null }
  | { kind: "project" | "conversation"; id: string };

export interface MemoryProposal {
  id: string;
  sequence: number;
  state: MemoryProposalState;
  kind: "note" | "preference" | "project" | "fact";
  content: string;
  scope: MemoryScope;
  source: {
    capsuleId: string;
    receiptId: string;
    inputHashes: string[];
  };
  targetProposalId: string | null;
  reason: string | null;
  createdAt: number;
  validFrom: number;
  validUntil: number | null;
}

export interface TaskCapsule {
  schemaVersion: typeof TASK_CAPSULE_SCHEMA_VERSION;
  id: string;
  createdAt: number;
  updatedAt: number;
  target: string;
  inputs: CapsuleInput[];
  route: ProviderRoute;
  routingReason: string;
  privacy: PrivacyInventory;
  status: CapsuleStatus;
  checkpoints: TaskCheckpoint[];
  artifacts: TaskArtifact[];
  receipts: EvidenceReceipt[];
  memoryProposals: MemoryProposal[];
}

export interface TaskCapsuleParseResult {
  status: "valid" | "migrated" | "unsupported" | "corrupt";
  capsule?: TaskCapsule;
  schemaVersion?: unknown;
  migratedFrom?: number;
  error?: string;
}

export interface PrivacyGateResult {
  allowed: boolean;
  status: "verified" | "needs_user" | "terminal_failure";
  payloadHash: string;
  reasons: string[];
}

const HASH = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES = new Set<CapsuleStatus>([
  "verified", "unverified", "needs_user", "retryable", "stale", "terminal_failure",
]);
const MAX_INPUTS = 100;
const MAX_CHECKPOINTS = 200;
const MAX_ARTIFACTS = 200;
const MAX_RECEIPTS = 500;
const MAX_MEMORY_PROPOSALS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTime(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) >= 0;
}

function isStatus(value: unknown): value is CapsuleStatus {
  return typeof value === "string" && STATUSES.has(value as CapsuleStatus);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// 纯 JS SHA-256，避免 WebCrypto 的 Promise 把整个数据层变成异步，
// 也避免渲染端为一个哈希引入 Node 或第三方依赖。
export function sha256Text(text: string): string {
  const bytes = new TextEncoder().encode(String(text));
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const words = new Uint32Array(64);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + k[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}

interface Detector {
  category: PrivacyCategory;
  kind: PrivacyKind;
  pattern: RegExp;
  capture?: number;
  accept?: (matched: string) => boolean;
}

function passesLuhn(raw: string): boolean {
  const digits = raw.replace(/[- ]/g, "");
  if (!/^\d{16,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { category: "secret", kind: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { category: "secret", kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { category: "secret", kind: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { category: "secret", kind: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\b/g },
  { category: "secret", kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { category: "secret", kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  {
    category: "secret",
    kind: "credential_value",
    pattern: /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*["']?([^\s"';&]{6,})/gi,
    capture: 1,
  },
  { category: "pii", kind: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { category: "pii", kind: "cn_phone", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { category: "pii", kind: "cn_id", pattern: /(?<!\d)\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g },
  { category: "pii", kind: "bank_card", pattern: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, accept: passesLuhn },
];

interface RawFinding {
  category: PrivacyCategory;
  kind: PrivacyKind;
  start: number;
  end: number;
  priority: number;
}

export function previewPrivacy(text: string): PrivacyPreview {
  const original = String(text);
  const candidates: RawFinding[] = [];
  DETECTORS.forEach((detector, priority) => {
    detector.pattern.lastIndex = 0;
    for (const match of original.matchAll(detector.pattern)) {
      const captured = detector.capture ? match[detector.capture] : match[0];
      if (!captured || (detector.accept && !detector.accept(captured))) continue;
      const offset = detector.capture ? match[0].lastIndexOf(captured) : 0;
      const start = (match.index ?? 0) + Math.max(0, offset);
      candidates.push({ category: detector.category, kind: detector.kind, start, end: start + captured.length, priority });
    }
  });
  candidates.sort((left, right) => (
    left.start - right.start || right.end - left.end || left.priority - right.priority || left.kind.localeCompare(right.kind)
  ));
  const selected: RawFinding[] = [];
  for (const candidate of candidates) {
    const previous = selected[selected.length - 1];
    if (previous && candidate.start < previous.end) continue;
    selected.push(candidate);
  }
  const counts = new Map<string, number>();
  const findings = selected.map((finding): PrivacyFinding => {
    const count = (counts.get(finding.kind) || 0) + 1;
    counts.set(finding.kind, count);
    const token = finding.kind.toUpperCase();
    return {
      id: `${finding.category}-${finding.kind}-${count}`,
      category: finding.category,
      kind: finding.kind,
      start: finding.start,
      end: finding.end,
      placeholder: `[REDACTED:${token}:${count}]`,
    };
  });
  let cursor = 0;
  let redactedText = "";
  for (const finding of findings) {
    redactedText += original.slice(cursor, finding.start) + finding.placeholder;
    cursor = finding.end;
  }
  redactedText += original.slice(cursor);
  return {
    originalHash: sha256Text(original),
    redactedHash: sha256Text(redactedText),
    originalBytes: utf8Bytes(original),
    redactedBytes: utf8Bytes(redactedText),
    redactedText,
    findings,
  };
}

// 云端聊天实际发送的是一组消息，不只是输入框里最后一句。
// 这里逐条脱敏、统一编号，再生成一份与实际消息顺序一致的可读预览。
// 上层因此既能把准确内容给用户看，也能把同一份 redactedMessages 真正发出去。
export function previewPrivacyMessages(messages: Array<{ role: string; content: string }>): PrivacyMessagePreview {
  const counts = new Map<PrivacyKind, number>();
  const redactedMessages: string[] = [];
  const findings: PrivacyFinding[] = [];
  let originalText = "";
  let redactedText = "";

  messages.forEach((message, messageIndex) => {
    const label = `【${messageIndex + 1} · ${message.role}】\n`;
    const separator = messageIndex ? "\n\n" : "";
    const local = previewPrivacy(message.content);
    const offset = originalText.length + separator.length + label.length;
    let cursor = 0;
    let redactedMessage = "";
    for (const finding of local.findings) {
      const sequence = (counts.get(finding.kind) || 0) + 1;
      counts.set(finding.kind, sequence);
      const placeholder = `[REDACTED:${finding.kind.toUpperCase()}:${sequence}]`;
      const globalFinding: PrivacyFinding = {
        ...finding,
        id: `${finding.category}-${finding.kind}-${sequence}`,
        start: offset + finding.start,
        end: offset + finding.end,
        placeholder,
      };
      findings.push(globalFinding);
      redactedMessage += message.content.slice(cursor, finding.start) + placeholder;
      cursor = finding.end;
    }
    redactedMessage += message.content.slice(cursor);
    redactedMessages.push(redactedMessage);
    originalText += `${separator}${label}${message.content}`;
    redactedText += `${separator}${label}${redactedMessage}`;
  });

  return {
    originalHash: sha256Text(originalText),
    redactedHash: sha256Text(redactedText),
    originalBytes: utf8Bytes(originalText),
    redactedBytes: utf8Bytes(redactedText),
    redactedText,
    findings,
    redactedMessages,
  };
}

export function capsuleInput(id: string, label: string, text: string): CapsuleInput {
  return { id, label, sha256: sha256Text(text), bytes: utf8Bytes(text) };
}

export function privacyInventory(
  preview: PrivacyPreview,
  scannedAt: number,
  options: { reviewedAt?: number | null; approvedForSend?: boolean; sendMode?: "original" | "redacted" } = {},
): PrivacyInventory {
  return {
    scannedAt,
    originalHash: preview.originalHash,
    redactedHash: preview.redactedHash,
    originalBytes: preview.originalBytes,
    redactedBytes: preview.redactedBytes,
    findings: preview.findings.map((finding) => ({ ...finding })),
    reviewedAt: options.reviewedAt ?? null,
    approvedForSend: options.approvedForSend === true,
    sendMode: options.sendMode || "redacted",
  };
}

export function evaluatePrivacyGate(capsule: Pick<TaskCapsule, "route" | "privacy">): PrivacyGateResult {
  const inventory = capsule.privacy;
  const payloadHash = inventory.sendMode === "redacted" ? inventory.redactedHash : inventory.originalHash;
  if (capsule.route.local) return { allowed: true, status: "verified", payloadHash, reasons: [] };
  const reasons: string[] = [];
  if (inventory.reviewedAt === null || !inventory.approvedForSend) reasons.push("云端发送尚未经用户确认。");
  if (inventory.findings.some((finding) => finding.category === "secret") && inventory.sendMode !== "redacted") {
    reasons.push("凭据只能以脱敏版发往云端。");
  }
  return {
    allowed: reasons.length === 0,
    status: reasons.length ? "needs_user" : "verified",
    payloadHash,
    reasons,
  };
}

const ALLOWED_TRANSITIONS: Record<CapsuleStatus, ReadonlySet<CapsuleStatus>> = {
  unverified: new Set(["verified", "needs_user", "retryable", "stale", "terminal_failure"]),
  needs_user: new Set(["unverified", "verified", "retryable", "terminal_failure"]),
  retryable: new Set(["unverified", "verified", "needs_user", "terminal_failure"]),
  verified: new Set(["stale"]),
  stale: new Set(["unverified", "needs_user", "terminal_failure"]),
  terminal_failure: new Set(),
};

export function canTransitionCapsuleStatus(from: CapsuleStatus, to: CapsuleStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].has(to);
}

function receiptSupportsStatus(capsule: TaskCapsule, status: CapsuleStatus): boolean {
  return capsule.receipts.some((receipt) => receipt.status === status)
    || capsule.checkpoints.some((checkpoint) => checkpoint.status === status);
}

export function evaluateEvidenceGate(capsule: TaskCapsule): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const privacy = evaluatePrivacyGate(capsule);
  if (!privacy.allowed) reasons.push(...privacy.reasons);
  if (!capsule.receipts.some((receipt) => receipt.status === "verified")) reasons.push("没有 verified 证据回执。");
  if (capsule.checkpoints.some((checkpoint) => checkpoint.status !== "verified")) reasons.push("仍有未验证的检查点。");
  for (const artifact of capsule.artifacts) {
    if (!capsule.receipts.some((receipt) => receipt.status === "verified" && receipt.artifactIds.includes(artifact.id))) {
      reasons.push(`产物 ${artifact.id} 没有 verified 回执。`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

export function transitionTaskCapsuleStatus(capsule: TaskCapsule, next: CapsuleStatus, updatedAt: number): TaskCapsule {
  if (!canTransitionCapsuleStatus(capsule.status, next)) {
    throw new Error(`状态不能从 ${capsule.status} 转到 ${next}。`);
  }
  const candidate = { ...capsule, status: next, updatedAt };
  const error = validateTaskCapsule(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function appendCheckpoint(capsule: TaskCapsule, checkpoint: TaskCheckpoint): TaskCapsule {
  if (capsule.checkpoints.some((item) => item.id === checkpoint.id)) throw new Error("检查点 id 已存在。");
  const candidate = { ...capsule, updatedAt: Math.max(capsule.updatedAt, checkpoint.observedAt), checkpoints: [...capsule.checkpoints, checkpoint] };
  const error = validateTaskCapsule(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function appendArtifact(capsule: TaskCapsule, artifact: TaskArtifact): TaskCapsule {
  if (capsule.artifacts.some((item) => item.id === artifact.id)) throw new Error("产物 id 已存在。");
  const candidate = { ...capsule, updatedAt: Math.max(capsule.updatedAt, artifact.createdAt), artifacts: [...capsule.artifacts, artifact] };
  const error = validateTaskCapsule(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function appendEvidenceReceipt(capsule: TaskCapsule, receipt: EvidenceReceipt): TaskCapsule {
  if (capsule.receipts.some((item) => item.id === receipt.id)) throw new Error("回执 id 已存在。");
  if (!canTransitionCapsuleStatus(capsule.status, receipt.status)) {
    throw new Error(`状态不能从 ${capsule.status} 转到 ${receipt.status}。`);
  }
  const candidate = {
    ...capsule,
    status: receipt.status,
    updatedAt: Math.max(capsule.updatedAt, receipt.observedAt),
    receipts: [...capsule.receipts, receipt],
  };
  const error = validateTaskCapsule(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function appendMemoryProposal(capsule: TaskCapsule, proposal: Omit<MemoryProposal, "sequence">): TaskCapsule {
  if (capsule.memoryProposals.some((item) => item.id === proposal.id)) throw new Error("记忆提案 id 已存在。");
  const candidateProposal: MemoryProposal = { ...proposal, sequence: capsule.memoryProposals.length + 1 };
  const candidate = {
    ...capsule,
    updatedAt: Math.max(capsule.updatedAt, proposal.createdAt),
    memoryProposals: [...capsule.memoryProposals, candidateProposal],
  };
  const error = validateTaskCapsule(candidate);
  if (error) throw new Error(error);
  return candidate;
}

export function resolveMemoryProposals(proposals: MemoryProposal[]): {
  valid: MemoryProposal[];
  superseded: string[];
  disputed: string[];
} {
  const superseded = new Set<string>();
  const disputed = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.state === "superseded" && proposal.targetProposalId) superseded.add(proposal.targetProposalId);
    if (proposal.state === "disputed" && proposal.targetProposalId) disputed.add(proposal.targetProposalId);
  }
  return {
    valid: proposals.filter((proposal) => proposal.state === "valid" && !superseded.has(proposal.id) && !disputed.has(proposal.id)),
    superseded: [...superseded],
    disputed: [...disputed],
  };
}

export function createTaskCapsule(input: Omit<TaskCapsule, "schemaVersion" | "status" | "checkpoints" | "artifacts" | "receipts" | "memoryProposals">): TaskCapsule {
  const capsule: TaskCapsule = {
    schemaVersion: TASK_CAPSULE_SCHEMA_VERSION,
    ...input,
    status: "unverified",
    checkpoints: [],
    artifacts: [],
    receipts: [],
    memoryProposals: [],
  };
  const error = validateTaskCapsule(capsule);
  if (error) throw new Error(error);
  return capsule;
}

function uniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function validatePrivacyFinding(value: unknown): value is PrivacyFinding {
  if (!isRecord(value) || !isSafeId(value.id)) return false;
  if (value.category !== "secret" && value.category !== "pii") return false;
  if (!DETECTORS.some((detector) => detector.kind === value.kind && detector.category === value.category)) return false;
  if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || Number(value.start) < 0 || Number(value.end) <= Number(value.start)) return false;
  return typeof value.placeholder === "string" && /^\[REDACTED:[A-Z0-9_]+:\d+\]$/.test(value.placeholder);
}

function validatePrivacy(value: unknown): value is PrivacyInventory {
  if (!isRecord(value) || !isFiniteTime(value.scannedAt) || !isHash(value.originalHash) || !isHash(value.redactedHash)) return false;
  if (!Number.isInteger(value.originalBytes) || Number(value.originalBytes) < 0 || !Number.isInteger(value.redactedBytes) || Number(value.redactedBytes) < 0) return false;
  if (!Array.isArray(value.findings) || value.findings.length > 500 || !value.findings.every(validatePrivacyFinding)) return false;
  if (!uniqueIds(value.findings as PrivacyFinding[])) return false;
  if (value.reviewedAt !== null && !isFiniteTime(value.reviewedAt)) return false;
  return typeof value.approvedForSend === "boolean" && (value.sendMode === "original" || value.sendMode === "redacted");
}

function validateScope(value: unknown): value is MemoryScope {
  if (!isRecord(value)) return false;
  if (value.kind === "global") return value.id === null;
  return (value.kind === "project" || value.kind === "conversation") && isSafeId(value.id);
}

function validateTaskCapsule(value: unknown): string | null {
  if (!isRecord(value) || value.schemaVersion !== TASK_CAPSULE_SCHEMA_VERSION) return "胶囊版本无效。";
  if (!isSafeId(value.id) || typeof value.target !== "string" || !value.target.trim() || value.target.length > 8000) return "胶囊目标无效。";
  if (!isFiniteTime(value.createdAt) || !isFiniteTime(value.updatedAt) || value.updatedAt < value.createdAt) return "胶囊时间无效。";
  if (!Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > MAX_INPUTS) return "胶囊输入无效。";
  const inputs = value.inputs as unknown[];
  if (!inputs.every((item) => isRecord(item)
    && isSafeId(item.id)
    && typeof item.label === "string" && Boolean(item.label.trim()) && item.label.length <= 500
    && isHash(item.sha256)
    && Number.isInteger(item.bytes) && Number(item.bytes) >= 0)) return "胶囊输入无效。";
  if (!uniqueIds(inputs as CapsuleInput[])) return "胶囊输入 id 重复。";
  if (!isRecord(value.route)
    || typeof value.route.provider !== "string" || !value.route.provider.trim() || value.route.provider.length > 80
    || typeof value.route.model !== "string" || !value.route.model.trim() || value.route.model.length > 200
    || typeof value.route.local !== "boolean") return "胶囊路由无效。";
  if (typeof value.routingReason !== "string" || !value.routingReason.trim() || value.routingReason.length > 4000) return "路由理由无效。";
  if (!validatePrivacy(value.privacy) || !isStatus(value.status)) return "隐私或状态无效。";

  if (!Array.isArray(value.checkpoints) || value.checkpoints.length > MAX_CHECKPOINTS) return "检查点无效。";
  const checkpoints = value.checkpoints as unknown[];
  if (!checkpoints.every((item) => isRecord(item) && isSafeId(item.id)
    && typeof item.label === "string" && Boolean(item.label.trim()) && item.label.length <= 500
    && isStatus(item.status) && typeof item.detail === "string" && item.detail.length <= 4000
    && isFiniteTime(item.observedAt))) return "检查点无效。";
  if (!uniqueIds(checkpoints as TaskCheckpoint[])) return "检查点 id 重复。";

  if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS) return "产物无效。";
  const artifacts = value.artifacts as unknown[];
  if (!artifacts.every((item) => isRecord(item) && isSafeId(item.id)
    && ["file", "text", "report", "dataset", "other"].includes(String(item.kind))
    && typeof item.label === "string" && Boolean(item.label.trim()) && item.label.length <= 500
    && isHash(item.sha256) && (item.uri === null || (typeof item.uri === "string" && item.uri.length <= 4096))
    && isFiniteTime(item.createdAt))) return "产物无效。";
  if (!uniqueIds(artifacts as TaskArtifact[])) return "产物 id 重复。";

  const inputHashes = new Set((inputs as CapsuleInput[]).map((item) => item.sha256));
  const checkpointIds = new Set((checkpoints as TaskCheckpoint[]).map((item) => item.id));
  const artifactIds = new Set((artifacts as TaskArtifact[]).map((item) => item.id));
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) return "证据回执无效。";
  const receipts = value.receipts as unknown[];
  if (!receipts.every((item) => isRecord(item) && isSafeId(item.id)
    && (item.checkpointId === null || (isSafeId(item.checkpointId) && checkpointIds.has(item.checkpointId)))
    && isStatus(item.status) && typeof item.summary === "string" && Boolean(item.summary.trim()) && item.summary.length <= 4000
    && isFiniteTime(item.observedAt)
    && Array.isArray(item.inputHashes) && item.inputHashes.length <= MAX_INPUTS && item.inputHashes.every((hash) => isHash(hash) && inputHashes.has(hash))
    && Array.isArray(item.artifactIds) && item.artifactIds.length <= MAX_ARTIFACTS && item.artifactIds.every((id) => isSafeId(id) && artifactIds.has(id)))) {
    return "证据回执无效。";
  }
  if (!uniqueIds(receipts as EvidenceReceipt[])) return "回执 id 重复。";

  const capsule = value as unknown as TaskCapsule;
  if (capsule.status === "verified" && !evaluateEvidenceGate(capsule).allowed) return "verified 缺少足够证据。";
  if (["needs_user", "retryable", "stale", "terminal_failure"].includes(capsule.status)
    && !receiptSupportsStatus(capsule, capsule.status)
    && !(capsule.status === "needs_user" && !evaluatePrivacyGate(capsule).allowed)) {
    return `${capsule.status} 缺少对应回执或检查点。`;
  }

  if (!Array.isArray(value.memoryProposals) || value.memoryProposals.length > MAX_MEMORY_PROPOSALS) return "记忆提案无效。";
  const proposalIds = new Set<string>();
  const receiptById = new Map((receipts as EvidenceReceipt[]).map((item) => [item.id, item]));
  for (let index = 0; index < value.memoryProposals.length; index += 1) {
    const item = value.memoryProposals[index];
    if (!isRecord(item) || !isSafeId(item.id) || proposalIds.has(item.id) || item.sequence !== index + 1) return "记忆提案顺序无效。";
    if (!["valid", "superseded", "disputed"].includes(String(item.state))
      || !["note", "preference", "project", "fact"].includes(String(item.kind))
      || typeof item.content !== "string" || !item.content.trim() || item.content.length > 8000
      || !validateScope(item.scope) || !isRecord(item.source)
      || item.source.capsuleId !== capsule.id || !isSafeId(item.source.receiptId)
      || !Array.isArray(item.source.inputHashes) || item.source.inputHashes.length > MAX_INPUTS
      || !item.source.inputHashes.every((hash) => isHash(hash) && inputHashes.has(hash))
      || !isFiniteTime(item.createdAt) || !isFiniteTime(item.validFrom)
      || (item.validUntil !== null && (!isFiniteTime(item.validUntil) || item.validUntil <= item.validFrom))) return "记忆提案内容无效。";
    const sourceReceipt = receiptById.get(item.source.receiptId);
    if (!sourceReceipt || sourceReceipt.status !== "verified") return "记忆提案必须来自 verified 回执。";
    if (item.state === "valid") {
      if (item.targetProposalId !== null || item.reason !== null) return "valid 记忆不应指向其他提案。";
    } else {
      if (!isSafeId(item.targetProposalId) || !proposalIds.has(item.targetProposalId)
        || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 2000) return "记忆更正必须指向先前提案。";
    }
    proposalIds.add(item.id);
  }
  return null;
}

interface LegacyTaskCapsuleV1 {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  target: string;
  inputHashes: string[];
  provider: string;
  model: string;
  local: boolean;
  routingReason: string;
  privacy: PrivacyInventory;
  status: CapsuleStatus;
  checkpoints: TaskCheckpoint[];
  artifacts: TaskArtifact[];
  receipts: EvidenceReceipt[];
}

function migrateV1(value: Record<string, unknown>): TaskCapsule | null {
  if (!isSafeId(value.id) || !isFiniteTime(value.createdAt) || !isFiniteTime(value.updatedAt)
    || typeof value.target !== "string" || !value.target.trim()
    || !Array.isArray(value.inputHashes) || !value.inputHashes.length || value.inputHashes.length > MAX_INPUTS
    || !value.inputHashes.every(isHash)
    || typeof value.provider !== "string" || !value.provider.trim()
    || typeof value.model !== "string" || !value.model.trim()
    || typeof value.local !== "boolean" || typeof value.routingReason !== "string" || !value.routingReason.trim()
    || !validatePrivacy(value.privacy) || !isStatus(value.status)
    || !Array.isArray(value.checkpoints) || !Array.isArray(value.artifacts) || !Array.isArray(value.receipts)) return null;
  const legacy = value as unknown as LegacyTaskCapsuleV1;
  const migrated: TaskCapsule = {
    schemaVersion: TASK_CAPSULE_SCHEMA_VERSION,
    id: legacy.id,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    target: legacy.target,
    inputs: legacy.inputHashes.map((sha256, index) => ({ id: `legacy-input-${index + 1}`, label: `Legacy input ${index + 1}`, sha256, bytes: 0 })),
    route: { provider: legacy.provider, model: legacy.model, local: legacy.local },
    routingReason: legacy.routingReason,
    privacy: legacy.privacy,
    status: legacy.status,
    checkpoints: legacy.checkpoints,
    artifacts: legacy.artifacts,
    receipts: legacy.receipts,
    memoryProposals: [],
  };
  return validateTaskCapsule(migrated) ? null : migrated;
}

export function migrateTaskCapsule(value: unknown): TaskCapsuleParseResult {
  if (!isRecord(value)) return { status: "corrupt", error: "胶囊根结构无效。" };
  if (value.schemaVersion === TASK_CAPSULE_SCHEMA_VERSION) {
    const error = validateTaskCapsule(value);
    return error
      ? { status: "corrupt", schemaVersion: value.schemaVersion, error }
      : { status: "valid", schemaVersion: value.schemaVersion, capsule: value as unknown as TaskCapsule };
  }
  if (value.schemaVersion === TASK_CAPSULE_LEGACY_SCHEMA_VERSION) {
    const capsule = migrateV1(value);
    return capsule
      ? { status: "migrated", schemaVersion: TASK_CAPSULE_SCHEMA_VERSION, migratedFrom: 1, capsule }
      : { status: "corrupt", schemaVersion: 1, error: "v1 胶囊无法安全迁移。" };
  }
  return { status: "unsupported", schemaVersion: value.schemaVersion, error: "这个胶囊版本当前不认识。" };
}

export function parseTaskCapsule(raw: string): TaskCapsuleParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", error: "胶囊不是合法 JSON。" };
  }
  return migrateTaskCapsule(parsed);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function serializeTaskCapsule(capsule: TaskCapsule): string {
  const result = migrateTaskCapsule(capsule);
  if (result.status !== "valid" || !result.capsule) throw new Error(result.error || "胶囊无法安全序列化。");
  return stableJson(result.capsule);
}
