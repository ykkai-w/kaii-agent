const fs = require("node:fs");
const path = require("node:path");

// 模型来源。本机那条是原来的 llama-server；其余几家都提供 OpenAI 兼容的
// /v1/chat/completions，所以整条流式链路可以复用，差别只在 baseUrl、鉴权头和模型名。
//
// API key 的处理原则（用户明确要求以后开源时别人看不到）：
//   - 只存在应用数据目录的 credentials.json，权限 0600
//   - 绝不写进源码、不进 localStorage、不进 settings.json、不进日志
//   - 任何回给界面的地方都只给后四位

const PROVIDERS = Object.freeze({
  local: Object.freeze({
    id: "local",
    label: "本机 Qwen",
    detail: "本机",
    cloud: false,
    needsKey: false,
    models: Object.freeze([]),
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    detail: "深度求索",
    cloud: true,
    needsKey: true,
    envKey: "DEEPSEEK_API_KEY",
    contextWindow: 1_000_000,
    // 实测：DeepSeek 走文本协议 3/3，走原生 tools 反而不调用。按证据选，不按想当然。
    preferNativeTools: false,
    baseUrl: "https://api.deepseek.com/v1",
    // 只是兜底：真实清单在运行时从各家 /models 拉，模型名会变（实测 deepseek-chat 已被 v4 系列取代）。
    models: Object.freeze([{ id: "deepseek-v4-flash", label: "deepseek-v4-flash" }]),
  }),
  moonshot: Object.freeze({
    id: "moonshot",
    label: "Kimi",
    detail: "月之暗面",
    cloud: true,
    needsKey: true,
    envKey: "MOONSHOT_API_KEY",
    contextWindow: 1_000_000,
    // 实测：Kimi 文本协议 1/3（老"宣布不执行"），原生 tools 后正常做完。
    preferNativeTools: true,
    // 实测 kimi-k3 能直接看原图（认出了画面内容和角落的水印）。
    visionModels: Object.freeze(["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"]),
    baseUrl: "https://api.moonshot.cn/v1",
    // 实测 k2/k3 系列只接受 temperature=1，传别的值会直接 400。
    forceParams: Object.freeze({ temperature: 1 }),
    models: Object.freeze([{ id: "kimi-k2.6", label: "kimi-k2.6" }]),
  }),
  zhipu: Object.freeze({
    id: "zhipu",
    label: "智谱 GLM",
    detail: "智谱",
    cloud: true,
    needsKey: true,
    envKey: "ZHIPU_API_KEY",
    contextWindow: 131_072,
    preferNativeTools: true,
    // 普通对话可以把官方 web_search 直接交给 GLM。
    // Agent 仍走 kaii 的预搜索，避免两套 tools 在同一请求里打架。
    nativeWebSearch: true,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: Object.freeze([{ id: "glm-4.5-air", label: "glm-4.5-air" }]),
  }),
});

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 400;
const cleanedCredentialDirectories = new Set();

function credentialsPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("凭据目录无效");
  return path.join(userDataPath, "credentials.json");
}

function cleanupCredentialTemps(userDataPath) {
  const directory = path.dirname(credentialsPath(userDataPath));
  if (cleanedCredentialDirectories.has(directory)) return;
  let completed = true;
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // 只清理本模块的原子写入副本。不用宽泛 *.tmp，避免误删
      // userData 里其他功能的文件。只删普通文件；符号链接、目录和
      // 任何相似名字都留在原处，更不会沿着链接碰到目录外的文件。
      if (!/^credentials\.json\.[1-9]\d*\.tmp$/.test(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      try {
        if (!fs.lstatSync(candidate).isFile()) continue;
        fs.unlinkSync(candidate);
      } catch {
        // 清不掉时下次读取再试，不能把一次短暂的占用记成“已经扫完”。
        completed = false;
      }
    }
  } catch (error) {
    // 第一次启动时目录可能还不存在。
    if (error?.code !== "ENOENT") completed = false;
    else return;
  }
  if (completed) cleanedCredentialDirectories.add(directory);
}

function validateProviderId(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROVIDERS, value)) throw new TypeError("模型来源无效");
  return value;
}

function validateApiKey(value) {
  if (typeof value !== "string") throw new TypeError("API key 必须是文字");
  const key = value.trim();
  if (!key) return "";
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /[\s\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError("API key 格式无效");
  }
  return key;
}

function readCredentials(userDataPath) {
  // 上次进程若在 write 与 rename 之间被强制结束，会留下一份
  // 0600 临时文件。新进程第一次读凭据前先精确清掉，不让它长期成为第二份 key。
  cleanupCredentialTemps(userDataPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath(userDataPath), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [id, key] of Object.entries(parsed)) {
      if (!Object.hasOwn(PROVIDERS, id) || typeof key !== "string") continue;
      try {
        const validated = validateApiKey(key);
        if (validated) clean[id] = validated;
      } catch {
        // 旧版可能留下过短或已损坏的值。它们不能继续被当成可用凭据。
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function writeCredentials(userDataPath, credentials) {
  const target = credentialsPath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  let descriptor = null;
  let ownsTemp = false;
  try {
    // 先用 O_EXCL 取得这一个临时路径的所有权。若它早已存在，说明并非
    // 本次调用创建；finally 绝不能顺手把那份文件删掉。
    descriptor = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    ownsTemp = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, target);
    ownsTemp = false;
    try {
      fs.chmodSync(target, 0o600);
    } catch (error) {
      // 原子副本本来就是按 0600 创建的，rename 会保留权限。某些文件系统
      // 不支持随后 chmod；若磁盘上的 canonical 文件已经是 0600，就应当
      // 如实告诉界面“保存成功”，而不是让用户误以为 key 没有写进去。
      let mode = null;
      try { mode = fs.lstatSync(target).mode & 0o777; } catch {}
      if (mode !== 0o600) throw error;
    }
    return { ok: true };
  } catch (error) {
    const secrets = credentials && typeof credentials === "object"
      ? Object.values(credentials).filter((value) => typeof value === "string" && value)
      : [];
    const rawMessage = error instanceof Error ? error.message : String(error || "凭据没有保存");
    const safe = new Error(redactWithSecrets(rawMessage, secrets));
    if (typeof error?.name === "string") safe.name = error.name;
    if (typeof error?.code === "string") safe.code = error.code;
    throw safe;
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    // 只清理由本次 O_EXCL 成功创建、且还没有 rename 成 canonical 文件的
    // temp。写入或 rename 失败不会留明文，也不会误删既有同名文件。
    if (ownsTemp) {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function setApiKey(userDataPath, providerId, rawKey) {
  const id = validateProviderId(providerId);
  if (!PROVIDERS[id].needsKey) throw new Error(`${PROVIDERS[id].label} 不需要 API key`);
  const key = validateApiKey(rawKey);
  const credentials = readCredentials(userDataPath);
  if (key) credentials[id] = key;
  else delete credentials[id];
  writeCredentials(userDataPath, credentials);
  return { ok: true, providerId: id, configured: Boolean(key) };
}

function getApiKey(userDataPath, providerId) {
  const id = validateProviderId(providerId);
  return readCredentials(userDataPath)[id] || "";
}

// 界面上只给后四位。任何时候都不要把完整 key 送出主进程。
function maskKey(key) {
  if (typeof key !== "string" || !key) return "";
  // 不管调用方传来什么，过短的值都只显示状态，不能原样返回。
  return key.length >= MIN_KEY_LENGTH ? `已保存 …${key.slice(-4)}` : "已保存";
}

// 只说每个模型的长处，不在选择器里替用户下判断。
const MODEL_CATALOG = Object.freeze([
  Object.freeze({
    group: "主力",
    items: Object.freeze([
      { provider: "zhipu", model: "glm-5.2", label: "GLM-5.2", note: "代码和工具" },
      { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "推理和分析" },
      { provider: "moonshot", model: "kimi-k3", label: "Kimi K3", note: "长文档和图片" },
      { provider: "local", model: "", label: "Qwen3-8B", note: "本地化" },
    ]),
  }),
  Object.freeze({
    group: "轻快",
    items: Object.freeze([
      { provider: "zhipu", model: "glm-5-turbo", label: "GLM-5 Turbo", note: "快速问答" },
      { provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "快速推理" },
      { provider: "moonshot", model: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code", note: "快速改代码" },
      { provider: "zhipu", model: "glm-4.5-air", label: "GLM-4.5 Air", note: "轻量问答" },
    ]),
  }),
]);

// 把目录和"这家配没配 key、这个模型还在不在"对上。
function buildModelCatalog(userDataPath, liveModels = {}) {
  const credentials = readCredentials(userDataPath);
  return MODEL_CATALOG.map((section) => ({
    group: section.group,
    items: section.items.flatMap((item) => {
      const provider = PROVIDERS[item.provider];
      if (!provider) return [];
      const configured = provider.needsKey ? Boolean(credentials[item.provider]) : true;
      const live = liveModels[item.provider];
      // 拉到了真实清单就以它为准；模型改名或下线时自动隐藏，不让用户点到 404。
      let model = item.model;
      if (configured && Array.isArray(live) && live.length) {
        if (!live.includes(model)) {
          const fallback = item.model2 && live.includes(item.model2) ? item.model2 : null;
          if (!fallback) return [];
          model = fallback;
        }
      }
      return [{
        provider: item.provider,
        model,
        label: model === item.model ? item.label : (item.model2Label || model),
        note: item.note,
        configured,
        needsKey: provider.needsKey,
        vision: Array.isArray(provider.visionModels) && provider.visionModels.includes(model),
      }];
    }),
  })).filter((section) => section.items.length);
}

function listProviders(userDataPath) {
  const credentials = readCredentials(userDataPath);
  return Object.values(PROVIDERS).map((provider) => ({
    id: provider.id,
    label: provider.label,
    detail: provider.detail,
    cloud: provider.cloud,
    needsKey: provider.needsKey,
    configured: provider.needsKey ? Boolean(credentials[provider.id]) : true,
    maskedKey: provider.needsKey ? maskKey(credentials[provider.id]) : "",
    models: provider.models.map((model) => ({ ...model })),
  }));
}

function defaultModelFor(providerId) {
  const provider = PROVIDERS[validateProviderId(providerId)];
  return provider.models[0]?.id || "";
}

function validateModelId(providerId, modelId) {
  const provider = PROVIDERS[validateProviderId(providerId)];
  if (!provider.cloud) return "";
  // 没指定就用这家的默认模型，不算错。
  if (modelId === undefined || modelId === null || modelId === "") return "";
  // 模型名由各家 /models 决定，会随时间变。这里只做形状校验，
  // 真正不存在的名字会被对方以 404 挡回来，并如实显示给用户。
  if (typeof modelId !== "string" || modelId.length > 120 || !/^[\w.:@-]+$/.test(modelId)) {
    throw new TypeError("模型无效");
  }
  return modelId;
}

// 拼出这次请求要用的地址和头。本机那条仍然走回环，不带任何鉴权。
function resolveEndpoint({ providerId, modelId, userDataPath, localPort }) {
  const id = validateProviderId(providerId);
  const provider = PROVIDERS[id];
  if (!provider.cloud) {
    return {
      provider,
      baseUrl: `http://127.0.0.1:${localPort}`,
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      model: "",
      cloud: false,
      forceParams: {},
      contextWindow: 0,
      preferNativeTools: false,
      nativeWebSearch: false,
      vision: false,
    };
  }
  const key = getApiKey(userDataPath, id);
  if (!key) throw new Error(`还没有填 ${provider.label} 的 API key，去设置里加一个`);
  return {
    provider,
    baseUrl: provider.baseUrl,
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    model: validateModelId(id, modelId) || defaultModelFor(id),
    cloud: true,
    forceParams: { ...(provider.forceParams || {}) },
    // 云端的上下文窗口比本机大一两个数量级。沿用本机那份 8K 会白白把
    // 文档、项目资料和历史裁掉，等于买了强模型却只用它一小块。
    contextWindow: provider.contextWindow || 32_768,
    preferNativeTools: provider.preferNativeTools === true,
    nativeWebSearch: provider.nativeWebSearch === true,
    // 会不会看图是按模型算的，不是按公司算的。
    vision: Array.isArray(provider.visionModels)
      && provider.visionModels.includes(validateModelId(id, modelId) || defaultModelFor(id)),
  };
}

// 只有“GLM 原生搜索参数/工具本身”报错时才可以退回 kaii 搜索。
// 模型过载、余额不足、网络断开等普通错误不得重试，否则可能重复计费。
function isNativeWebSearchError(providerId, error) {
  if (providerId !== "zhipu") return false;
  const message = String(error?.message || error || "");
  return /(web[_ -]?search|search_(?:engine|result|prompt)|联网搜索|网络搜索|搜索工具|搜索引擎|(?:tools?|工具).{0,40}(?:not supported|unsupported|unavailable|invalid|不支持|不可用|无效))/i.test(message);
}

function redactWithSecrets(text, secrets) {
  let output = String(text ?? "");
  for (const key of secrets) {
    if (key) output = output.split(key).join("[已隐藏的 API key]");
  }
  return output;
}

// 日志和报错里可能夹带 key（例如把整个 headers 打出来）。落盘或上屏前统一过一遍。
function redact(text, userDataPath) {
  return redactWithSecrets(text, Object.values(readCredentials(userDataPath)));
}

// 工具回执不只有一条 message：summary/detail/modelText/meta 都可能带出文件内容。
// 返回新结构而不改原对象，调用方可以在写审计库、发 IPC 和回填模型之前只收口一次。
function redactValue(value, userDataPath) {
  const secrets = Object.values(readCredentials(userDataPath));
  const seen = new WeakMap();

  function visit(current) {
    if (typeof current === "string") return redactWithSecrets(current, secrets);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return seen.get(current);
    if (Array.isArray(current)) {
      const result = [];
      seen.set(current, result);
      for (const item of current) result.push(visit(item));
      return result;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return current;
    const result = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) {
      result[redactWithSecrets(key, secrets)] = visit(item);
    }
    return result;
  }

  return visit(value);
}

// 从各家拉真实模型清单。拉不到就用兜底清单，不让界面空着。
async function fetchModels(userDataPath, providerId, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const id = validateProviderId(providerId);
  const provider = PROVIDERS[id];
  if (!provider.cloud) return { ok: true, models: [], live: false };
  const key = getApiKey(userDataPath, id);
  if (!key) return { ok: false, models: [], live: false, message: `还没有填 ${provider.label} 的 API key` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${provider.baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`返回 HTTP ${response.status}`);
    const payload = await response.json();
    const models = (Array.isArray(payload?.data) ? payload.data : [])
      .map((item) => item?.id)
      .filter((value) => typeof value === "string" && value && value.length <= 120)
      .sort()
      .map((value) => ({ id: value, label: value }));
    if (!models.length) throw new Error("这个账号下没有可用模型");
    return { ok: true, models, live: true };
  } catch (error) {
    return {
      ok: false,
      models: provider.models.map((model) => ({ ...model })),
      live: false,
      message: redact(error?.message || "拉取模型清单失败", userDataPath),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 云端这次失败值不值得换本机模型顶上：只认"像是网络/服务临时抖了"的错。
// 4xx（key 错、参数错）不算——那是要用户修的，换模型只会把问题藏起来。
function isTransientNetworkError(message) {
  return /HTTP 5\d\d|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|超时|没有返回事件流/i.test(String(message ?? ""));
}

// 本机模型启动失败翻译成能照做的话。别只甩一句"启动失败"。
function describeModelStartFailure(message, serverBinary) {
  const text = String(message ?? "");
  if (/ENOENT/.test(text)) {
    return `找不到 llama-server（${serverBinary}）。路径改过或者重装过 llama.cpp 的话，去设置里改一下。`;
  }
  if (/EACCES/.test(text)) return "llama-server 没有执行权限。终端里 chmod +x 一下它。";
  if (/EADDRINUSE|address already in use/i.test(text)) return "端口被别的程序占了。关掉占端口的程序，或者去设置里换一个端口。";
  return `Qwen 启动失败：${text}`;
}

// llama-server 进程没有立即报错、但在限时内一直没就绪时，
// 从已收集的字符串日志里翻译最常见的两种原因。
function describeModelStartTimeout(logLines, port) {
  const text = Array.isArray(logLines)
    ? logLines.map((line) => String(line)).join("\n")
    : String(logLines ?? "");
  if (/address already in use|\bbind\b/i.test(text)) {
    return `端口 ${port} 被别的程序占了。可能有一个旧的 llama-server 没退干净：活动监视器里搜 llama-server 退掉它，或者去设置里换个端口。`;
  }
  if (/out of memory|failed to allocate/i.test(text)) {
    return "内存不够，模型没加载进来。关掉一些别的应用再试，或者在设置里把 GPU 层数调小。";
  }
  return "模型加载超时。点「运行日志」看看卡在哪一步。";
}

// 读一个进程当前占了多少内存（MB）。读不到（进程没了/超时）返回 0。
function readProcessRssMb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  try {
    const out = require("node:child_process")
      .execFileSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
    const kb = Number(out.trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : 0;
  } catch {
    return 0;
  }
}

module.exports = {
  describeModelStartFailure,
  describeModelStartTimeout,
  isTransientNetworkError,
  readProcessRssMb,
  MIN_KEY_LENGTH,
  MAX_KEY_LENGTH,
  PROVIDERS,
  credentialsPath,
  defaultModelFor,
  fetchModels,
  getApiKey,
  MODEL_CATALOG,
  buildModelCatalog,
  listProviders,
  maskKey,
  readCredentials,
  redact,
  redactValue,
  resolveEndpoint,
  isNativeWebSearchError,
  setApiKey,
  validateApiKey,
  validateModelId,
  validateProviderId,
  writeCredentials,
};
