const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const speech = require("../../electron/lib/speech.cjs");

// 假的子进程：拿来驱动 SpeechSession，不用真去开麦克风。
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { end() { child.stdinEnded = true; } };
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); };
  child.emitLine = (object) => child.stdout.emit("data", `${JSON.stringify(object)}\n`);
  return child;
}

function sessionWith(child) {
  const events = [];
  const session = new speech.SpeechSession({
    onEvent: (event) => events.push(event),
    spawnImpl: () => child,
  });
  // helperAvailable 会真的去 stat 文件，所以指向一个确实存在且可执行的东西。
  session.start("/bin/echo", { locale: "zh-CN" });
  return { session, events };
}

test("一行一条 JSON，半行会留到下一块数据再拼", () => {
  const seen = [];
  const read = speech.createLineReader((object) => seen.push(object));
  read('{"type":"partial","text":"今天');
  assert.deepEqual(seen, [], "半行不该被当成完整的一条");
  read('天气"}\n{"type":"partial","text":"今天天气怎么样"}\n');
  assert.deepEqual(seen.map((item) => item.text), ["今天天气", "今天天气怎么样"]);
});

test("不是 JSON 的行被跳过，不影响后面的", () => {
  const seen = [];
  const read = speech.createLineReader((object) => seen.push(object));
  // Speech 框架偶尔会往 stdout 打系统日志，不能因此把整个会话搞崩。
  read('2026-08-10 kaii-speech[123] some system noise\n{"type":"ready"}\n');
  assert.deepEqual(seen, [{ type: "ready" }]);
});

test("超长的垃圾输入不会把内存撑爆", () => {
  const seen = [];
  const read = speech.createLineReader((object) => seen.push(object));
  read("x".repeat(200_000));
  read('\n{"type":"ready"}\n');
  assert.deepEqual(seen, [{ type: "ready" }]);
});

test("partial 一路转发，final 之后会话就结束了", () => {
  const child = fakeChild();
  const { session, events } = sessionWith(child);
  child.emitLine({ type: "ready", on_device: true });
  child.emitLine({ type: "partial", text: "今天" });
  child.emitLine({ type: "partial", text: "今天天气" });
  assert.equal(session.active, true);
  child.emitLine({ type: "final", text: "今天天气怎么样" });
  assert.equal(session.active, false);
  assert.deepEqual(events.map((item) => item.type), ["ready", "partial", "partial", "final"]);
  assert.equal(events.at(-1).text, "今天天气怎么样");
});

test("final 之后再来的行不会被重复上报", () => {
  const child = fakeChild();
  const { events } = sessionWith(child);
  child.emitLine({ type: "final", text: "说完了" });
  child.emitLine({ type: "partial", text: "又来了" });
  child.emit("close", 0);
  assert.equal(events.filter((item) => item.type === "final").length, 1);
});

test("进程中途没了但已经听到内容，就把听到的当结果，别让人白说一遍", () => {
  const child = fakeChild();
  const { events } = sessionWith(child);
  child.emitLine({ type: "partial", text: "刚说了半句" });
  child.emit("close", 137);
  const last = events.at(-1);
  assert.equal(last.type, "final");
  assert.equal(last.text, "刚说了半句");
  assert.equal(last.reason, "process_exit");
});

test("一个字都没听到就退出，才算失败", () => {
  const child = fakeChild();
  const { events } = sessionWith(child);
  child.emit("close", 1);
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).code, "ended_early");
});

test("停止是先关 stdin 让它自己收尾，不是直接杀", () => {
  const child = fakeChild();
  const { session } = sessionWith(child);
  session.stop();
  assert.equal(child.stdinEnded, true, "应该先关 stdin");
  assert.deepEqual(child.killed, [], "不该立刻杀掉——会丢掉最后半句话");
});

test("不管从哪条路径结束，进程一定被收掉，麦克风不会被一直占着", () => {
  for (const ending of [
    (child) => child.emitLine({ type: "final", text: "说完了" }),
    (child) => child.emitLine({ type: "error", code: "no_speech", message: "没听到" }),
  ]) {
    const child = fakeChild();
    sessionWith(child);
    ending(child);
    assert.ok(child.killed.includes("SIGKILL"), "结束后没有收掉子进程");
  }
});

test("同一时间只允许一个会话", () => {
  const child = fakeChild();
  const { session } = sessionWith(child);
  assert.throws(() => session.start("/bin/echo", {}), /已经在听了/);
});

test("找不到听写程序时直接说清楚，而不是抛一个看不懂的错", () => {
  const session = new speech.SpeechSession({ spawnImpl: () => fakeChild() });
  assert.throws(() => session.start("/不存在/kaii-speech", {}), /没有装听写程序/);
  assert.equal(speech.helperAvailable("/不存在/kaii-speech"), false);
});

test("打包与开发两种情形下的程序路径", () => {
  assert.equal(
    speech.helperPath({ packaged: true, resourcesPath: "/App/Contents/Resources" }),
    "/App/Contents/Resources/bin/kaii-speech",
  );
  assert.ok(speech.helperPath({ packaged: false }).endsWith("/resources/bin/kaii-speech"));
});

test("默认不允许把声音发到苹果服务器", () => {
  // 这是用户隐私上的硬要求：本机没有模型时要报错并指路，
  // 而不是悄悄退回服务器识别。改动这段的人必须知道自己在改什么。
  const source = fs.readFileSync(path.join(__dirname, "../../native/kaii-speech.swift"), "utf8");
  assert.match(source, /requiresOnDeviceRecognition/);
  assert.match(source, /no_on_device_model/);
  assert.match(source, /allowCloud = false/);
  // 上层也不该主动传 --allow-cloud。
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  assert.equal(main.includes("allowCloud: true"), false, "主进程不该默认打开云端识别");
});

test("退出应用时会放开麦克风", () => {
  const main = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  const block = main.slice(main.indexOf('ipcMain.handle("speech:start"'), main.indexOf('ipcMain.handle("knowledge:list"'));
  assert.match(block, /before-quit/);
  assert.match(block, /speechSession\?\.kill\(\)/);
});
