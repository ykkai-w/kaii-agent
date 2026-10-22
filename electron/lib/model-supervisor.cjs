"use strict";

const crypto = require("node:crypto");

class ModelSupervisorError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ModelSupervisorError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  return new ModelSupervisorError(code, message, cause);
}

function assertOwner(owner) {
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 160
    || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw fail("INVALID_OWNER", "模型租约的 owner 无效");
  }
  return owner;
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw fail("INVALID_CONFIG", "模型启动配置无效");
  }
  if (typeof config.binary !== "string" || !config.binary) {
    throw fail("INVALID_CONFIG", "模型启动程序无效");
  }
  if (!Array.isArray(config.args) || config.args.some((item) => typeof item !== "string")) {
    throw fail("INVALID_CONFIG", "模型启动参数无效");
  }
  if (typeof config.expectedIdentity !== "string" || !config.expectedIdentity
    || /[\u0000-\u001f\u007f]/.test(config.expectedIdentity)) {
    throw fail("INVALID_CONFIG", "未提供可验证的模型身份");
  }
  let endpoint;
  try {
    endpoint = new URL(config.baseUrl);
  } catch {
    throw fail("INVALID_CONFIG", "本机模型地址无效");
  }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || endpoint.username || endpoint.password || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw fail("INVALID_CONFIG", "本机模型只能使用 127.0.0.1 HTTP 地址");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  const normalized = {
    binary: config.binary,
    args: [...config.args],
    baseUrl: endpoint.href.replace(/\/$/, ""),
    expectedIdentity: config.expectedIdentity,
    spawnOptions: config.spawnOptions && typeof config.spawnOptions === "object" && !Array.isArray(config.spawnOptions)
      ? { ...config.spawnOptions }
      : {},
  };
  normalized.key = JSON.stringify({
    binary: normalized.binary,
    args: normalized.args,
    baseUrl: normalized.baseUrl,
    expectedIdentity: normalized.expectedIdentity,
    spawnOptions: normalized.spawnOptions,
  });
  return normalized;
}

class ModelSupervisor {
  constructor({
    spawn,
    fetch: fetchImpl,
    now = Date.now,
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
    createToken = () => crypto.randomUUID(),
    onState = () => {},
    maxPending = 8,
    idleMs = 10 * 60_000,
    startTimeoutMs = 120_000,
    pollIntervalMs = 650,
    requestTimeoutMs = 1_200,
    stopTimeoutMs = 5_000,
  } = {}) {
    if (typeof spawn !== "function" || typeof fetchImpl !== "function") {
      throw new TypeError("ModelSupervisor 需要 spawn 和 fetch");
    }
    for (const [name, value, minimum] of [
      ["maxPending", maxPending, 1],
      ["idleMs", idleMs, 0],
      ["startTimeoutMs", startTimeoutMs, 1],
      ["pollIntervalMs", pollIntervalMs, 1],
      ["requestTimeoutMs", requestTimeoutMs, 1],
      ["stopTimeoutMs", stopTimeoutMs, 0],
    ]) {
      if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${name} 无效`);
    }
    this._spawn = spawn;
    this._fetch = fetchImpl;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._createToken = createToken;
    this._onState = onState;
    this._maxPending = maxPending;
    this._idleMs = idleMs;
    this._startTimeoutMs = startTimeoutMs;
    this._pollIntervalMs = pollIntervalMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this._stopTimeoutMs = stopTimeoutMs;

    this._status = { status: "stopped", detail: "模型尚未启动", identity: "", owned: false };
    this._generation = 0;
    this._child = null;
    this._configKey = null;
    this._startPromise = null;
    this._startController = null;
    this._stopPromise = null;
    this._pending = 0;
    this._leases = new Map();
    this._idleTimer = null;
    this._idleAt = 0;
  }

  snapshot() {
    return Object.freeze({
      ...this._status,
      generation: this._generation,
      leaseCount: this._activeLeaseCount(),
      pendingCount: this._pending,
      queueLimit: this._maxPending,
      idleAt: this._idleAt || null,
    });
  }

  async acquire({ owner, config, signal } = {}) {
    const validOwner = assertOwner(owner);
    const normalized = normalizeConfig(config);
    if (signal?.aborted) throw fail("ACQUIRE_CANCELLED", "模型租约申请已取消");
    if (this._pending >= this._maxPending) {
      throw fail("QUEUE_FULL", `模型等待队列已满（${this._maxPending}）`);
    }

    this._pending += 1;
    this._cancelIdleTimer();
    this._publish();
    try {
      await this._waitForCaller(this._ensureReady(normalized), signal);
      if (signal?.aborted) throw fail("ACQUIRE_CANCELLED", "模型租约申请已取消");
      if (this._status.status !== "ready") throw fail("MODEL_NOT_READY", "本机模型没有就绪");

      const token = String(this._createToken());
      if (!token || this._leases.has(token)) throw fail("TOKEN_COLLISION", "无法创建唯一模型租约");
      const generation = this._generation;
      this._leases.set(token, { owner: validOwner, generation });
      this._publish();
      return Object.freeze({
        owner: validOwner,
        token,
        identity: this._status.identity,
        generation,
        release: () => this.release({ owner: validOwner, token }),
      });
    } finally {
      this._pending -= 1;
      this._scheduleIdleIfUnused();
      this._publish();
    }
  }

  release({ owner, token } = {}) {
    const lease = typeof token === "string" ? this._leases.get(token) : null;
    if (!lease || lease.owner !== owner) return false;
    this._leases.delete(token);
    this._scheduleIdleIfUnused();
    this._publish();
    return true;
  }

  async stop({ force = false, reason = "manual" } = {}) {
    if (this._stopPromise) return this._stopPromise;
    if (!force && this._activeLeaseCount() > 0) {
      throw fail("MODEL_IN_USE", "本机模型仍有任务在使用");
    }

    this._cancelIdleTimer();
    const stoppedGeneration = this._generation;
    const child = this._child;
    const controller = this._startController;
    this._generation += 1;
    this._child = null;
    this._configKey = null;
    this._dropLeases(stoppedGeneration);
    controller?.abort(fail("START_CANCELLED", "模型启动已取消"));
    this._setStatus("stopping", reason === "idle" ? "模型空闲，正在释放内存……" : "正在释放模型内存……", "", Boolean(child));

    const operation = (async () => {
      if (child) await this._terminateChild(child);
      this._setStatus("stopped", reason === "idle" ? "模型已在空闲后自动释放" : "模型已停止", "", false);
      return this.snapshot();
    })();
    this._stopPromise = operation;
    try {
      return await operation;
    } finally {
      if (this._stopPromise === operation) this._stopPromise = null;
    }
  }

  async _ensureReady(config) {
    this._cancelIdleTimer();
    if (this._stopPromise) await this._stopPromise;
    if (this._status.status === "ready" && this._configKey === config.key) return this.snapshot();
    if (this._status.status === "ready" && this._configKey !== config.key) {
      if (this._activeLeaseCount() > 0) throw fail("CONFIG_IN_USE", "另一个模型配置正在使用");
      await this.stop({ force: true, reason: "reconfigure" });
    }
    if (this._startPromise) {
      if (this._configKey !== config.key) throw fail("CONFIG_IN_USE", "另一个模型正在启动");
      return this._startPromise;
    }

    const generation = this._generation + 1;
    this._generation = generation;
    this._configKey = config.key;
    const controller = new AbortController();
    this._startController = controller;
    const operation = this._start(config, generation, controller);
    this._startPromise = operation;
    try {
      return await operation;
    } finally {
      if (this._startPromise === operation) this._startPromise = null;
      if (this._startController === controller) this._startController = null;
    }
  }

  async _start(config, generation, controller) {
    this._setStatus("starting", "正在验证本机模型……", "", false);
    let processFailure = null;
    let startCompleted = false;
    try {
      const attached = await this._probe(config, controller.signal);
      this._assertCurrent(generation, controller.signal);
      if (attached.ready) {
        this._setStatus("ready", "已连接经身份验证的本机模型", attached.identity, false);
        return this.snapshot();
      }
      if (attached.identityMismatch) {
        throw fail("IDENTITY_MISMATCH", `本机端口上的模型身份不符：${attached.identity || "未知"}`);
      }

      this._assertCurrent(generation, controller.signal);
      const child = this._spawn(config.binary, config.args, {
        ...config.spawnOptions,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      if (!child || typeof child.once !== "function" || typeof child.kill !== "function") {
        throw fail("SPAWN_FAILED", "spawn 没有返回可管理的模型进程");
      }
      this._child = child;
      this._setStatus("starting", "正在加载本机模型……", "", true);
      const markProcessFailure = (error) => {
        if (this._child !== child || this._generation !== generation) return;
        processFailure = error instanceof Error ? error : new Error(String(error));
        this._child = null;
        if (startCompleted) {
          this._dropLeases(generation);
          this._setStatus("stopped", "本机模型进程意外退出", "", false);
          return;
        }
        controller.abort(processFailure);
      };
      child.once("error", markProcessFailure);
      child.once("exit", (code, signal) => {
        markProcessFailure(fail("PROCESS_EXITED", `模型进程提前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`));
      });

      const deadline = this._now() + this._startTimeoutMs;
      while (this._now() <= deadline) {
        this._assertCurrent(generation, controller.signal, processFailure);
        const readiness = await this._probe(config, controller.signal);
        this._assertCurrent(generation, controller.signal, processFailure);
        if (readiness.identityMismatch) {
          throw fail("IDENTITY_MISMATCH", `本机端口上的模型身份不符：${readiness.identity || "未知"}`);
        }
        if (readiness.ready) {
          startCompleted = true;
          this._setStatus("ready", "本机模型就绪", readiness.identity, true);
          return this.snapshot();
        }
        if (this._now() >= deadline) break;
        await this._sleep(Math.min(this._pollIntervalMs, deadline - this._now()), controller.signal);
      }
      throw fail("START_TIMEOUT", "本机模型加载超时");
    } catch (error) {
      const current = this._generation === generation;
      const child = current ? this._child : null;
      if (current) this._child = null;
      if (child) await this._terminateChild(child);
      if (!current) {
        throw fail("START_CANCELLED", "模型启动已取消", error);
      }
      const source = processFailure || error;
      if (controller.signal.aborted && !processFailure && source?.code !== "IDENTITY_MISMATCH") {
        throw fail("START_CANCELLED", "模型启动已取消", source);
      }
      const normalized = source instanceof ModelSupervisorError
        ? source
        : fail(processFailure ? "PROCESS_FAILED" : "START_FAILED", source?.message || "本机模型启动失败", source);
      this._setStatus("error", normalized.message, "", false);
      throw normalized;
    }
  }

  async _probe(config, parentSignal) {
    let health;
    try {
      health = await this._request(`${config.baseUrl}/health`, parentSignal);
    } catch (error) {
      if (parentSignal.aborted) throw error;
      return { ready: false, identity: "", identityMismatch: false };
    }
    if (!health?.ok) return { ready: false, identity: "", identityMismatch: false };

    let response;
    try {
      response = await this._request(`${config.baseUrl}/v1/models`, parentSignal);
      if (!response?.ok) return { ready: false, identity: "", identityMismatch: false };
      const contentType = response.headers?.get?.("content-type") || "";
      if (!String(contentType).toLowerCase().includes("application/json")) {
        return { ready: false, identity: "", identityMismatch: false };
      }
      const payload = await response.json();
      const identity = payload?.data?.[0]?.id;
      if (typeof identity !== "string" || !identity) {
        return { ready: false, identity: "", identityMismatch: false };
      }
      return {
        ready: identity === config.expectedIdentity,
        identity,
        identityMismatch: identity !== config.expectedIdentity,
      };
    } catch (error) {
      if (parentSignal.aborted) throw error;
      return { ready: false, identity: "", identityMismatch: false };
    }
  }

  async _request(url, parentSignal) {
    if (parentSignal.aborted) throw parentSignal.reason || fail("START_CANCELLED", "模型启动已取消");
    const controller = new AbortController();
    const relayAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener("abort", relayAbort, { once: true });
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = this._setTimer(() => {
        const error = fail("REQUEST_TIMEOUT", "本机模型探测超时");
        controller.abort(error);
        reject(error);
      }, this._requestTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve(this._fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        })),
        timeout,
      ]);
    } finally {
      if (timer !== null) this._clearTimer(timer);
      parentSignal.removeEventListener("abort", relayAbort);
    }
  }

  _assertCurrent(generation, signal, processFailure = null) {
    if (processFailure) throw processFailure;
    if (this._generation !== generation || signal.aborted) {
      throw fail("START_CANCELLED", "模型启动已取消", signal.reason);
    }
  }

  _waitForCaller(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const abort = () => reject(fail("ACQUIRE_CANCELLED", "模型租约申请已取消"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason || fail("START_CANCELLED", "模型启动已取消"));
        return;
      }
      let timer = null;
      const abort = () => {
        if (timer !== null) this._clearTimer(timer);
        reject(signal.reason || fail("START_CANCELLED", "模型启动已取消"));
      };
      timer = this._setTimer(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async _terminateChild(child) {
    let exited = false;
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    child.once("exit", () => {
      exited = true;
      resolveExit();
    });
    try { child.kill("SIGTERM"); } catch { exited = true; }
    if (!exited) {
      await Promise.race([exit, this._sleep(this._stopTimeoutMs)]);
    }
    if (!exited) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }

  _activeLeaseCount(generation = this._generation) {
    let count = 0;
    for (const lease of this._leases.values()) if (lease.generation === generation) count += 1;
    return count;
  }

  _dropLeases(generation) {
    for (const [token, lease] of this._leases) {
      if (lease.generation === generation) this._leases.delete(token);
    }
  }

  _scheduleIdleIfUnused() {
    if (this._status.status !== "ready" || this._pending > 0 || this._activeLeaseCount() > 0 || this._idleTimer) return;
    this._idleAt = this._now() + this._idleMs;
    this._idleTimer = this._setTimer(() => {
      this._idleTimer = null;
      this._idleAt = 0;
      if (this._pending === 0 && this._activeLeaseCount() === 0 && this._status.status === "ready") {
        void this.stop({ force: true, reason: "idle" });
      }
    }, this._idleMs);
    // 这是资源回收优化，不是应用活着的理由。
    // Node 真计时器可以 unref；测试里的假计时器只返回数字。
    this._idleTimer?.unref?.();
  }

  _cancelIdleTimer() {
    if (this._idleTimer !== null) this._clearTimer(this._idleTimer);
    this._idleTimer = null;
    this._idleAt = 0;
  }

  _setStatus(status, detail, identity, owned) {
    this._status = { status, detail, identity, owned };
    this._publish();
  }

  _publish() {
    try { this._onState(this.snapshot()); } catch {}
  }
}

module.exports = {
  ModelSupervisor,
  ModelSupervisorError,
  normalizeConfig,
};
