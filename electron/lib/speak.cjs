const { spawn } = require("node:child_process");

// 把回答念出来。听写的反面：手上在忙的时候，让它读给你听。
//
// 用系统自带的 `say`。macOS 的中文语音（婷婷、Sinji）质量够日常用，
// 而且完全在本机，不联网、不花钱、不需要额外下载模型。
//
// 念之前要把文字清理一遍：Markdown 符号、代码块、公式念出来是灾难
// （"星号星号重点星号星号"），必须先剥掉。

const MAX_CHARACTERS = 8000;

// 念给人听和给人看是两回事。这里做的删减都是为了"读出来通顺"：
// 代码和公式念不了，符号是排版不是内容，链接念出来全是噪音。
function speakableText(raw) {
  let text = String(raw ?? "");

  // 代码块直接跳过，只留一句提示——念代码没有任何意义。
  text = text.replace(/```[\s\S]*?```/g, "（这里有一段代码）");
  text = text.replace(/`([^`]+)`/g, "$1");

  // 图表块也跳过。
  text = text.replace(/（这里有一段代码）/g, (match, offset, whole) => (
    whole.slice(Math.max(0, offset - 40), offset).includes("chart") ? "（这里有一张图）" : match
  ));

  // 公式念不出来。
  text = text.replace(/\$\$[\s\S]*?\$\$/g, "（这里有一个公式）");
  text = text.replace(/\$[^$\n]{1,120}\$/g, "（公式）");

  // 链接只留文字，URL 念出来全是噪音。
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/https?:\/\/[^\s，。；：、！？）】」』]+/g, "（一个链接）");

  // 标题、强调、列表符号是排版不是内容。
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  // 表格行拆成"列，列，列"，比连着一串竖线好念。
  text = text.replace(/^\|(.+)\|\s*$/gm, (_match, row) => (
    /^[\s|:-]+$/.test(row) ? "" : row.split("|").map((cell) => cell.trim()).filter(Boolean).join("，")
  ));

  return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_CHARACTERS);
}

class Speaker {
  constructor({ spawnImpl = spawn } = {}) {
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.onEnd = () => {};
  }

  get speaking() {
    return Boolean(this.child);
  }

  speak(raw, { voice = "", rate = 0, onEnd = () => {} } = {}) {
    const text = speakableText(raw);
    if (!text) return { ok: false, message: "这段里没有能念的内容。" };

    // 上一段还在念就先停掉。两个声音一起说话谁也听不清。
    this.stop();
    this.onEnd = onEnd;

    const args = [];
    if (voice) args.push("-v", voice);
    if (rate) args.push("-r", String(rate));
    // 文字走 stdin，不进命令行参数：几千字的回答会顶爆参数长度限制，
    // 而且内容里的引号和换行会把命令搅坏。
    args.push("-f", "-");

    const child = this.spawnImpl("/usr/bin/say", args, { stdio: ["pipe", "ignore", "ignore"] });
    this.child = child;
    // 关掉旧 child 后它的 close/error 仍可能晚到。回调必须带上身份，
    // 否则旧 child 会把刚启动的新 child 误当成自己清掉。
    child.on("error", () => this.finish(child));
    child.on("close", () => this.finish(child));
    try {
      child.stdin.end(text);
    } catch {
      this.finish(child);
      return { ok: false, message: "念不了这段。" };
    }
    return { ok: true, characters: text.length };
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // 已经结束了。
    }
  }

  finish(child = this.child) {
    if (!child || this.child !== child) return;
    this.child = null;
    const callback = this.onEnd;
    this.onEnd = () => {};
    callback();
  }
}

// 按内容挑声音。中文用中文嗓，不然英文嗓念中文是一串音节碎片。
// 系统里装了哪些声音因人而异，所以要在运行时问一遍，不能写死名字。
function pickVoice(text, voices) {
  const sample = String(text ?? "").slice(0, 400);
  const cjk = (sample.match(/[一-鿿]/g) || []).length;
  const wantChinese = cjk > sample.replace(/\s/g, "").length * 0.2;
  if (!wantChinese) return "";
  const chinese = voices.filter((item) => item.locale.startsWith("zh"));
  if (!chinese.length) return "";
  // 优先大陆普通话，没有再退而求其次。
  return (chinese.find((item) => item.locale === "zh_CN") || chinese[0]).name;
}

function parseVoices(output) {
  return String(output ?? "").split("\n").flatMap((line) => {
    // 形如：Tingting (中文（中国大陆）)  zh_CN   # 你好！我叫Tingting。
    const match = line.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\s/);
    if (!match) return [];
    return [{ name: match[1].replace(/\s*\(.*\)\s*$/, "").trim(), locale: match[2].replace("-", "_") }];
  });
}

module.exports = { MAX_CHARACTERS, Speaker, parseVoices, pickVoice, speakableText };
