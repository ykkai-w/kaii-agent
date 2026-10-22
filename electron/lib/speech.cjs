const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// 听写会话的管理。真正干活的是 resources/bin/kaii-speech（Swift 写的），
// 这里只负责：同一时间只允许一个会话、把它按行吐出来的 JSON 转成事件、
// 以及保证不管从哪条路径结束，麦克风一定被放开。
//
// 麦克风被占着不放是最难受的一种 bug——用户看不见，只会发现别的软件
// 突然录不了音。所以这里所有的收尾都要走同一个 finish()。

const MAX_LINE_BYTES = 64 * 1024;
const STOP_GRACE_MS = 3000;

function helperPath({ resourcesPath = "", packaged = false } = {}) {
  return packaged
    ? path.join(resourcesPath, "bin", "kaii-speech")
    : path.join(__dirname, "..", "..", "resources", "bin", "kaii-speech");
}

function helperAvailable(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return false;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// 一行一条 JSON。半行要留着等下一块数据，否则长句子会被从中间切开。
function createLineReader(onObject) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      // 正常情况下一行几十字节。涨到这个量级说明对面吐的不是我们的协议，
      // 与其无限攒内存，不如丢掉重新开始对齐。
      buffer = buffer.slice(-MAX_LINE_BYTES);
    }
    let newlineAt = buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (line) {
        try {
          onObject(JSON.parse(line));
        } catch {
          // 不是 JSON 的行直接跳过：Speech 框架偶尔会往 stdout 打系统日志。
        }
      }
      newlineAt = buffer.indexOf("\n");
    }
  };
}

class SpeechSession {
  constructor({ onEvent, spawnImpl = spawn } = {}) {
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.text = "";
    this.done = false;
    this.stopTimer = null;
  }

  get active() {
    return Boolean(this.child) && !this.done;
  }

  start(target, { locale = "zh-CN", maxSeconds = 120, allowCloud = false } = {}) {
    if (this.active) throw new Error("已经在听了");
    if (!helperAvailable(target)) throw new Error("这个版本里没有装听写程序");

    const args = ["--locale", String(locale), "--max-seconds", String(maxSeconds)];
    if (allowCloud) args.push("--allow-cloud");

    this.done = false;
    this.text = "";
    this.child = this.spawnImpl(target, args, { stdio: ["pipe", "pipe", "pipe"] });

    const read = createLineReader((event) => {
      if (event.type === "partial" || event.type === "final") {
        this.text = typeof event.text === "string" ? event.text : this.text;
      }
      if (event.type === "final" || event.type === "error") {
        this.finish(event);
        return;
      }
      this.onEvent(event);
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", read);
    // stderr 只用来排查，不往界面上抛：Speech 框架会往这里写一堆系统噪音。
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});

    this.child.on("error", (error) => {
      this.finish({ type: "error", code: "spawn_failed", message: `启动听写失败：${error.message}` });
    });
    this.child.on("close", () => {
      // 进程没吐 final 就没了（被杀、崩了）。有听到内容就当结果用，
      // 一个字都没有才算失败——总比让用户白说一遍强。
      this.finish(this.text
        ? { type: "final", text: this.text, reason: "process_exit" }
        : { type: "error", code: "ended_early", message: "听写中途停了。再试一次。" });
    });

    return this;
  }

  // 让它自己收尾（关 stdin），而不是直接杀。直接杀会丢掉最后半句话。
  stop() {
    if (!this.active) return;
    try {
      this.child.stdin.end();
    } catch {
      // stdin 已经关了，下面的兜底计时器会处理。
    }
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      if (this.active) this.kill();
    }, STOP_GRACE_MS);
    if (typeof this.stopTimer.unref === "function") this.stopTimer.unref();
  }

  kill() {
    if (!this.child) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // 已经没了。
    }
  }

  finish(event) {
    if (this.done) return;
    this.done = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 正常退出的话这里本来就没进程了。
      }
    }
    this.onEvent(event);
  }
}

module.exports = { SpeechSession, createLineReader, helperAvailable, helperPath };
