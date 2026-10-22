"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  ModelSupervisor,
  ModelSupervisorError,
} = require("../../electron/lib/model-supervisor.cjs");

const CONFIG = Object.freeze({
  binary: "/fake/llama-server",
  args: ["-m", "/models/qwen.gguf", "--port", "8091"],
  baseUrl: "http://127.0.0.1:8091",
  expectedIdentity: "/models/qwen.gguf",
});

function response({ ok = true, status = ok ? 200 : 503, json = {}, contentType = "application/json" } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    async json() { return json; },
  };
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  };

  clearTimeout = (id) => {
    this.timers.delete(id);
  };

  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

class FakeChild extends EventEmitter {
  constructor({ exitOnTerm = true, onKill = () => {} } = {}) {
    super();
    this.exitOnTerm = exitOnTerm;
    this.onKill = onKill;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    this.onKill(signal, this);
    if (signal === "SIGTERM" && this.exitOnTerm) this.emit("exit", 0, signal);
    return true;
  }
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function tokenFactory() {
  let value = 0;
  return () => `lease-${++value}`;
}

function readyFetch(isRunning, identity = CONFIG.expectedIdentity) {
  return async (url) => {
    if (url.endsWith("/health")) return response({ ok: isRunning() });
    if (url.endsWith("/v1/models")) {
      return response({ json: { data: [{ id: typeof identity === "function" ? identity() : identity }] } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test("concurrent acquisitions share one startup and receive owner-bound unique leases", async () => {
  let running = false;
  let spawnCount = 0;
  const supervisor = new ModelSupervisor({
    spawn() {
      spawnCount += 1;
      running = true;
      return new FakeChild({ onKill: () => { running = false; } });
    },
    fetch: readyFetch(() => running),
    createToken: tokenFactory(),
    idleMs: 60_000,
  });

  const [one, two, three] = await Promise.all([
    supervisor.acquire({ owner: "chat-1", config: CONFIG }),
    supervisor.acquire({ owner: "chat-2", config: CONFIG }),
    supervisor.acquire({ owner: "scheduled-job", config: CONFIG }),
  ]);
  assert.equal(spawnCount, 1, "single-flight 必须只启动一个进程");
  assert.equal(new Set([one.token, two.token, three.token]).size, 3);
  assert.equal(supervisor.snapshot().leaseCount, 3);
  assert.equal(supervisor.release({ owner: "somebody-else", token: one.token }), false, "owner 不匹配不得释放租约");
  assert.equal(one.release(), true);
  assert.equal(two.release(), true);
  assert.equal(three.release(), true);
});

test("the startup wait queue is bounded before any extra process can be spawned", async () => {
  let releaseFirstProbe;
  let firstProbe = true;
  let running = false;
  const supervisor = new ModelSupervisor({
    maxPending: 2,
    idleMs: 60_000,
    createToken: tokenFactory(),
    spawn() {
      running = true;
      return new FakeChild({ onKill: () => { running = false; } });
    },
    fetch: async (url) => {
      if (url.endsWith("/health") && firstProbe) {
        firstProbe = false;
        await new Promise((resolve) => { releaseFirstProbe = resolve; });
        return response({ ok: false });
      }
      return readyFetch(() => running)(url);
    },
  });

  const first = supervisor.acquire({ owner: "one", config: CONFIG });
  await flush();
  const second = supervisor.acquire({ owner: "two", config: CONFIG });
  await assert.rejects(
    supervisor.acquire({ owner: "three", config: CONFIG }),
    (error) => error instanceof ModelSupervisorError && error.code === "QUEUE_FULL",
  );
  releaseFirstProbe();
  const leases = await Promise.all([first, second]);
  assert.equal(supervisor.snapshot().leaseCount, 2);
  leases.forEach((lease) => lease.release());
});

test("a start in progress can be cancelled and leaves no lease or owned process", async () => {
  let running = false;
  let spawned;
  const supervisor = new ModelSupervisor({
    spawn() {
      running = true;
      spawned = new FakeChild({ onKill: () => { running = false; } });
      return spawned;
    },
    fetch: async (url, options) => {
      if (!running) return response({ ok: false });
      if (url.endsWith("/health")) {
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      throw new Error("identity should not be queried before health succeeds");
    },
    createToken: tokenFactory(),
  });

  const acquiring = supervisor.acquire({ owner: "cancel-me", config: CONFIG });
  while (!spawned) await flush();
  await supervisor.stop({ force: true });
  await assert.rejects(acquiring, (error) => error.code === "START_CANCELLED");
  assert.deepEqual(spawned.signals, ["SIGTERM"]);
  assert.equal(supervisor.snapshot().status, "stopped");
  assert.equal(supervisor.snapshot().leaseCount, 0);
  assert.equal(supervisor.snapshot().owned, false);
});

test("active leases block idle unload; releasing the last lease starts a cancellable idle timer", async () => {
  const clock = new FakeClock();
  let running = false;
  const children = [];
  const supervisor = new ModelSupervisor({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    idleMs: 100,
    createToken: tokenFactory(),
    spawn() {
      running = true;
      const child = new FakeChild({ onKill: () => { running = false; } });
      children.push(child);
      return child;
    },
    fetch: readyFetch(() => running),
  });

  const first = await supervisor.acquire({ owner: "active", config: CONFIG });
  await clock.advance(1_000);
  assert.deepEqual(children[0].signals, [], "active lease 存在时不得空闲卸载");

  first.release();
  await clock.advance(99);
  const second = await supervisor.acquire({ owner: "returned", config: CONFIG });
  await clock.advance(100);
  assert.deepEqual(children[0].signals, [], "新 lease 必须取消旧的空闲计时器");

  second.release();
  await clock.advance(100);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.equal(supervisor.snapshot().status, "stopped");
  assert.match(supervisor.snapshot().detail, /自动释放/);
});

test("a late exit from an old child cannot corrupt the replacement generation", async () => {
  const clock = new FakeClock();
  let running = false;
  const children = [];
  const supervisor = new ModelSupervisor({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    stopTimeoutMs: 10,
    idleMs: 60_000,
    createToken: tokenFactory(),
    spawn() {
      running = true;
      const child = new FakeChild({
        exitOnTerm: false,
        onKill(signal, target) {
          if (signal === "SIGKILL" && children.at(-1) === target) running = false;
        },
      });
      children.push(child);
      return child;
    },
    fetch: readyFetch(() => running),
  });

  const oldLease = await supervisor.acquire({ owner: "old", config: CONFIG });
  oldLease.release();
  const stopping = supervisor.stop({ force: true });
  await clock.advance(10);
  await stopping;
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);

  const replacement = await supervisor.acquire({ owner: "new", config: CONFIG });
  const replacementGeneration = replacement.generation;
  children[0].emit("exit", 0, "SIGKILL");
  await flush();
  assert.equal(supervisor.snapshot().status, "ready");
  assert.equal(supervisor.snapshot().generation, replacementGeneration);
  assert.equal(supervisor.snapshot().leaseCount, 1);
  replacement.release();
});

test("the current child exiting after readiness invalidates its leases instead of leaving a false ready state", async () => {
  let running = false;
  let child;
  const supervisor = new ModelSupervisor({
    idleMs: 60_000,
    createToken: tokenFactory(),
    spawn() {
      running = true;
      child = new FakeChild({ exitOnTerm: false, onKill: () => { running = false; } });
      return child;
    },
    fetch: readyFetch(() => running),
  });
  const lease = await supervisor.acquire({ owner: "active-run", config: CONFIG });
  child.emit("exit", 9, null);
  await flush();
  assert.equal(supervisor.snapshot().status, "stopped");
  assert.equal(supervisor.snapshot().owned, false);
  assert.equal(supervisor.snapshot().leaseCount, 0);
  assert.equal(lease.release(), false, "已终止实例的旧 lease 必须失效");
});

test("readiness requires both a healthy endpoint and the exact configured model identity", async () => {
  let modelCalls = 0;
  const unhealthy = new ModelSupervisor({
    spawn() { throw new Error("spawn should only happen after the preflight"); },
    fetch: async (url) => {
      if (url.endsWith("/health")) return response({ ok: true });
      modelCalls += 1;
      return response({ json: { data: [{ id: "/models/not-qwen.gguf" }] } });
    },
  });
  await assert.rejects(
    unhealthy.acquire({ owner: "identity-check", config: CONFIG }),
    (error) => error.code === "IDENTITY_MISMATCH",
  );
  assert.equal(modelCalls, 1, "health 通过后必须再查 /v1/models");
  assert.equal(unhealthy.snapshot().status, "error");

  let spawned = false;
  const healthy = new ModelSupervisor({
    createToken: tokenFactory(),
    spawn() {
      spawned = true;
      return new FakeChild();
    },
    fetch: readyFetch(() => true),
  });
  const lease = await healthy.acquire({ owner: "verified", config: CONFIG });
  assert.equal(spawned, false, "已运行且身份正确的本机模型应安全附着，不重复启动");
  assert.equal(lease.identity, CONFIG.expectedIdentity);
  assert.equal(healthy.snapshot().owned, false);
  lease.release();
});
