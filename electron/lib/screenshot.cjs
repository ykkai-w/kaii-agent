const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// 截图提问：框一块屏幕，直接当图片问。
//
// 用系统自带的 screencapture。自己画选区框要处理多屏、缩放、
// 全屏应用、深色模式一大堆事，系统那个已经做得很好，用户也熟。
//
// 三条要守住的：
// - 截图不落在用户的桌面或图片文件夹里，只进临时目录，用完就删。
// - 用户按 esc 取消是正常操作，不是错误，不该弹任何东西。
// - 不能无限等。screencapture 卡住（比如没给屏幕录制权限）时要能收场。

const CAPTURE_TIMEOUT_MS = 120_000;

// -i 交互框选，-x 不播快门声（半夜截个图不该响一声）。
function captureArguments(target, { mode = "region" } = {}) {
  const flags = ["-x"];
  if (mode === "region") flags.push("-i");
  else if (mode === "window") flags.push("-i", "-W");
  else if (mode === "screen") flags.push("-m");
  else throw new TypeError("截图方式无效");
  return [...flags, target];
}

function temporaryTarget(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, `kaii-截图-${crypto.randomUUID()}.png`);
}

// 返回 { ok, filePath } 或 { ok: false, cancelled: true }。
// 调用方拿到 filePath 后自己负责处理并删除。
function capture({ mode = "region", spawnImpl = spawn, tmpdir = os.tmpdir() } = {}) {
  const target = temporaryTarget(tmpdir);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = spawnImpl("/usr/sbin/screencapture", captureArguments(target, { mode }), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已经没了。
      }
      done({ ok: false, message: "截图一直没有结束，已经取消了。" });
    }, CAPTURE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, message: `截图程序起不来：${error.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // 用户按 esc 取消时 screencapture 退出码是 0 但不写文件。
      // 这是正常操作，不该报错。
      let exists = false;
      try {
        exists = fs.statSync(target).size > 0;
      } catch {
        exists = false;
      }
      if (!exists) {
        if (code === 0) return done({ ok: false, cancelled: true });
        return done({
          ok: false,
          message: stderr.trim()
            || "截图没成功。可能是还没允许录屏：去「系统设置 → 隐私与安全性 → 屏幕录制」里把 kaii 打开。",
        });
      }
      done({ ok: true, filePath: target });
    });
  });
}

function discard(filePath) {
  if (typeof filePath !== "string" || !filePath.includes("kaii-截图-")) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { CAPTURE_TIMEOUT_MS, capture, captureArguments, discard, temporaryTarget };
