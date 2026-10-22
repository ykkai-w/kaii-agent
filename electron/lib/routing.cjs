// 自动挑模型。
//
// 出发点很实际：本机 8B 应付日常聊天、润色、翻译完全够用而且不花钱，
// 但一碰到改代码、啃长文档、多步任务就明显不行。让用户每次自己判断该切哪个
// 是件麻烦事，所以按这一轮的实际情况替他选，并且把理由写出来。
//
// 判断只看确定的信号——有没有开工程模式、附了多长的东西、问题里有没有代码。
// 不去猜"这个问题难不难"，那种猜测不可靠，也解释不清楚。

const LONG_INPUT_CHARACTERS = 2000;

const REASONS = Object.freeze({
  tools: "要动文件和跑命令",
  code: "题目里有代码",
  longInput: "带的材料比较长",
  longChat: "这段对话已经很长",
  simple: "日常问题",
  image: "有图要看",
  imageLocal: "本机只能认字",
  manual: "你自己选的",
  offline: "还没配云端 key",
  localOnly: "仅本机模式",
});

function looksLikeCode(text) {
  const value = String(text || "");
  if (/```/.test(value)) return true;
  // 单独出现的关键字容易误伤（"我function了一下"这种不算），要求成对结构。
  const signals = [
    /\b(function|const|let|var)\s+[A-Za-z_$][\w$]*\s*[=(]/,
    /\b(def|class)\s+[A-Za-z_]\w*\s*[(:]/,
    /\b(import|from)\s+[\w.{}\s,*]+\s+(import|from)\b/,
    /[\w$]+\.[\w$]+\([^)]*\)\s*;?/,
    /^\s*(npm|pnpm|yarn|git|pytest|cargo|go)\s+\w+/m,
    // 标签里通常带属性，只匹配光秃秃的 <div> 会漏掉绝大多数真实 JSX/HTML；
    // 但属性里不该出现中文，否则"他说 a<b 而且 b>c"这种会被当成标签。
    /<\/?[a-zA-Z][\w-]*(\s+[^<>\u4e00-\u9fff]*)?\/?>/,
  ];
  return signals.some((pattern) => pattern.test(value));
}

// 返回这一轮该用哪个模型，以及一句能直接显示给用户的理由。
function pickModel({
  question = "",
  hasImage = false,
  attachedCharacters = 0,
  conversationCharacters = 0,
  useTools = false,
  available = [],
  manual = null,
  localOnly = false,
}) {
  const local = { provider: "local", model: "" };
  // 断网模式是一道硬边界，比手动选型和自动路由都优先。
  // 否则代码任务会先被选成 GLM，到真正发送时才报错。
  if (localOnly) return { ...local, reason: REASONS.localOnly, auto: true };

  // 用户自己选了就听用户的，不替他改。
  if (manual && manual.provider) {
    return { provider: manual.provider, model: manual.model || "", reason: REASONS.manual, auto: false };
  }

  const cloud = available.filter((item) => item.provider !== "local" && item.configured);
  if (!cloud.length) {
    return { ...local, reason: REASONS.offline, auto: true };
  }

  const pick = (preferred, reason) => {
    const hit = cloud.find((item) => item.model === preferred) || cloud[0];
    return { provider: hit.provider, model: hit.model, reason, auto: true };
  };

  // 有图先给会看图的模型。本机那套只能把图里的字认出来，看不懂画面本身。
  if (hasImage) {
    const seeing = cloud.find((item) => item.vision);
    if (seeing) return { provider: seeing.provider, model: seeing.model, reason: REASONS.image, auto: true };
    return { ...local, reason: REASONS.imageLocal, auto: true };
  }

  // 工程模式：要真的改文件、跑命令，本机 8B 实测成功率太低，直接上最强的。
  if (useTools) return pick("glm-5.2", REASONS.tools);
  if (looksLikeCode(question)) return pick("glm-5.2", REASONS.code);
  if (attachedCharacters >= LONG_INPUT_CHARACTERS) return pick("kimi-k3", REASONS.longInput);
  // 长对话在本机 8K 上下文里会不断丢历史，换到大窗口的模型更划算。
  if (conversationCharacters >= 6000) return pick("kimi-k3", REASONS.longChat);

  return { ...local, reason: REASONS.simple, auto: true };
}

module.exports = { LONG_INPUT_CHARACTERS, REASONS, looksLikeCode, pickModel };
