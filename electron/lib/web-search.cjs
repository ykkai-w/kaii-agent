const { isIP } = require("node:net");

const MAX_SEARCH_QUERY = 400;
const MAX_SEARCH_RESPONSE = 2 * 1024 * 1024;
const MAX_RESULTS = 5;

// keepNewlines：抽正文时要留着换行，段落边界全靠它。
// 默认仍然压平——标题、摘要那些地方要的就是一行。
function decodeHtml(value, { keepNewlines = false } = {}) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " };
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot|nbsp);/gi, (_match, entity) => {
      if (entity[0] === "#") {
        const numeric = entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : "";
      }
      return named[entity.toLowerCase()] || "";
    })
    .replace(keepNewlines ? /[^\S\n]+/g : /\s+/g, " ")
    .trim();
}

function isPrivateIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] >= 224;
}

function safePublicUrl(rawUrl) {
  let candidate;
  try {
    const value = String(rawUrl).startsWith("//") ? `https:${rawUrl}` : rawUrl;
    candidate = new URL(value);
  } catch {
    return null;
  }
  if (candidate.hostname === "duckduckgo.com" && candidate.pathname.startsWith("/l/")) {
    const redirected = candidate.searchParams.get("uddg");
    if (!redirected) return null;
    try {
      candidate = new URL(redirected);
    } catch {
      return null;
    }
  }
  if (!["http:", "https:"].includes(candidate.protocol) || candidate.username || candidate.password) return null;
  const host = candidate.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes(".")) return null;
  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateIpv4(host)) return null;
  if (ipVersion === 6 && (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))) return null;
  candidate.hash = "";
  return candidate.href;
}

function parseDuckDuckGoHtml(html, limit = MAX_RESULTS) {
  if (typeof html !== "string") throw new TypeError("搜索页面必须是文字");
  const results = [];
  const titlePattern = /<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let titleMatch;
  while ((titleMatch = titlePattern.exec(html)) && results.length < limit) {
    const url = safePublicUrl(decodeHtml(titleMatch[1]));
    const title = decodeHtml(titleMatch[2]).slice(0, 240);
    if (!url || !title) continue;
    const tail = html.slice(titlePattern.lastIndex, titlePattern.lastIndex + 7000);
    const snippetMatch = tail.match(/<a\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const snippet = decodeHtml(snippetMatch?.[1] || "").slice(0, 700);
    if (results.some((item) => item.url === url)) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function normalizeQuery(query) {
  if (typeof query !== "string") throw new TypeError("搜索词必须是文字");
  const normalized = query.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > MAX_SEARCH_QUERY) throw new RangeError("搜索词长度无效");
  return normalized;
}

function safeHttpsEndpoint(rawUrl) {
  const safe = safePublicUrl(rawUrl);
  if (!safe) return null;
  const parsed = new URL(safe);
  if (parsed.protocol !== "https:") return null;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

async function readCappedText(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_SEARCH_RESPONSE) throw new Error("联网搜索返回内容过大");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SEARCH_RESPONSE) throw new Error("联网搜索返回内容过大");
  return text;
}

function assertContentType(response, expected) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes(expected)) throw new Error("联网搜索返回了未知格式");
}

const SEARCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X) AppleWebKit/537.36 kaii/0.1";

async function duckDuckGoSearch(query, { fetchImpl, signal }) {
  const response = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
      "user-agent": SEARCH_USER_AGENT,
    },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`联网搜索返回 HTTP ${response.status}`);
  assertContentType(response, "text/html");
  return parseDuckDuckGoHtml(await readCappedText(response));
}

function wikipediaLanguage(query) {
  return /[㐀-鿿豈-﫿]/.test(query) ? "zh" : "en";
}

function parseWikipediaPayload(payload, language) {
  if (!payload || !Array.isArray(payload.pages)) throw new Error("联网搜索返回了未知格式");
  const results = [];
  for (const page of payload.pages.slice(0, MAX_RESULTS)) {
    if (!page || typeof page.key !== "string" || typeof page.title !== "string") continue;
    const url = safePublicUrl(`https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`);
    if (!url) continue;
    const snippet = decodeHtml(page.excerpt || page.description || "").slice(0, 700);
    results.push({ title: page.title.slice(0, 240), url, snippet });
  }
  return results;
}

async function wikipediaSearch(query, { fetchImpl, signal }) {
  const language = wikipediaLanguage(query);
  const endpoint = `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": SEARCH_USER_AGENT },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`联网搜索返回 HTTP ${response.status}`);
  assertContentType(response, "application/json");
  return parseWikipediaPayload(JSON.parse(await readCappedText(response)), language);
}

function parseSearxngPayload(payload) {
  if (!payload || !Array.isArray(payload.results)) throw new Error("联网搜索返回了未知格式");
  const results = [];
  for (const item of payload.results) {
    if (results.length >= MAX_RESULTS) break;
    if (!item || typeof item.url !== "string" || typeof item.title !== "string") continue;
    const url = safePublicUrl(item.url);
    if (!url || results.some((existing) => existing.url === url)) continue;
    results.push({
      title: decodeHtml(item.title).slice(0, 240),
      url,
      snippet: decodeHtml(item.content || "").slice(0, 700),
    });
  }
  return results;
}

async function searxngSearch(query, { fetchImpl, signal, endpoint }) {
  const base = safeHttpsEndpoint(endpoint);
  if (!base) throw new Error("SearXNG 地址无效，请在设置里填写 https 公网地址");
  const response = await fetchImpl(`${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": SEARCH_USER_AGENT },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`联网搜索返回 HTTP ${response.status}`);
  assertContentType(response, "application/json");
  return parseSearxngPayload(JSON.parse(await readCappedText(response)));
}

const SEARCH_PROVIDERS = Object.freeze({
  duckduckgo: Object.freeze({
    id: "duckduckgo",
    label: "DuckDuckGo",
    detail: "抓取公开 HTML 结果页，没有官方 API 承诺。",
    needsEndpoint: false,
    search: duckDuckGoSearch,
  }),
  wikipedia: Object.freeze({
    id: "wikipedia",
    label: "维基百科",
    detail: "官方 REST API，免密钥、结构稳定，只覆盖百科条目。",
    needsEndpoint: false,
    search: wikipediaSearch,
  }),
  searxng: Object.freeze({
    id: "searxng",
    label: "SearXNG",
    detail: "自建或公开 SearXNG 实例的 JSON 接口，需要自己填地址。",
    needsEndpoint: true,
    search: searxngSearch,
  }),
});

const DEFAULT_SEARCH_PROVIDER = "duckduckgo";

function listSearchProviders() {
  return Object.values(SEARCH_PROVIDERS).map(({ id, label, detail, needsEndpoint }) => ({ id, label, detail, needsEndpoint }));
}

function resolveProvider(providerId) {
  const provider = SEARCH_PROVIDERS[providerId || DEFAULT_SEARCH_PROVIDER];
  if (!provider) throw new TypeError("联网搜索来源无效");
  return provider;
}

async function searchWeb(query, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 12_000,
  provider = DEFAULT_SEARCH_PROVIDER,
  endpoint = "",
  fallbackProvider = "",
} = {}) {
  const normalized = normalizeQuery(query);
  const primary = resolveProvider(provider);
  const fallback = fallbackProvider && fallbackProvider !== primary.id ? resolveProvider(fallbackProvider) : null;

  const attempt = async (target) => {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const results = await target.search(normalized, { fetchImpl, signal: controller.signal, endpoint });
      if (!Array.isArray(results) || !results.length) throw new Error("没有找到可用的联网结果");
      const searchedAt = new Date().toISOString();
      return results.slice(0, MAX_RESULTS).map((result) => ({ ...result, searchedAt, provider: target.id }));
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new Error(`${target.label} 联网搜索超时`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromParent);
    }
  };

  try {
    return await attempt(primary);
  } catch (error) {
    if (!fallback || signal?.aborted) throw error;
    try {
      return await attempt(fallback);
    } catch {
      throw error;
    }
  }
}

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_PAGE_CHARACTERS = 12_000;

// 只有搜索摘要的时候，回答常常停留在"据说""大致是"。把命中的前几篇正文抓下来，
// 才谈得上真的看过。抓取仍然只走公开 http(s)，内网地址在 safePublicUrl 那关就被挡掉了。
function extractReadableText(html) {
  let text = String(html);
  // 先整段删掉不含正文的区域，否则脚本和样式会混进正文里。
  for (const tag of ["script", "style", "noscript", "svg", "template", "iframe"]) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // 导航、页眉页脚、侧栏不是正文。维基百科那种页面不删的话，
  // 开头会是"开关目录 44种语言 العربية Български…"一长串，
  // 白占上下文还会把模型带偏。
  for (const tag of ["nav", "header", "footer", "aside", "form", "select"]) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  // 优先取 article/main，取不到再退回整页。
  const main = text.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main) text = main[2];
  text = text
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return stripLeadingNavigation(decodeHtml(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

// 标签删干净之后，开头往往还剩一段没有句子的导航文字
// （「跳转到内容 44种语言 العربية …」）。
//
// 试过按行切开再判断，但真实页面上不行：公式和表格会被拆成几千个碎行，
// 判断会一路跳进公式中间。所以只做一件很克制的事——
// 掐掉第一个句号之前的那一段，而且只在它足够短的时候掐。
function stripLeadingNavigation(text) {
  const firstStop = text.search(/[。！？]/);
  // 找不到句读（纯列表页），或者句读出现得很晚（说明开头本来就是正文），
  // 都原样返回。300 字以内才认为那是导航。
  if (firstStop < 0 || firstStop > 300) return text;
  const head = text.slice(0, firstStop);
  // 开头这段里如果有逗号，多半已经是正文的半句话，别掐。
  if (/[，、,]/.test(head)) return text;
  // 从这段的最后一个空格切，保住句子开头那几个字。
  const cut = head.lastIndexOf(" ", firstStop);
  return cut > 0 ? text.slice(0, 0) + text.slice(head.lastIndexOf(" ", cut - 40) + 1).trim() : text;
}

async function fetchPage(rawUrl, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = 15_000,
  redirect = "follow",
} = {}) {
  const url = safePublicUrl(rawUrl);
  if (!url) throw new Error("这个网址不能抓");
  if (redirect !== "follow" && redirect !== "error") throw new TypeError("网页跳转策略无效");

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
        "user-agent": "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X) AppleWebKit/537.36 kaii/0.1",
      },
      redirect,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`返回 HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      throw new Error("这个地址不是网页");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) throw new Error("网页太大");
    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > MAX_PAGE_BYTES) throw new Error("网页太大");

    const text = extractReadableText(html);
    if (text.length < 80) throw new Error("这个页面没抓到正文");
    const title = decodeHtml((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")).slice(0, 200);
    const finalUrl = safePublicUrl(response.url || url);
    if (!finalUrl) throw new Error("网页跳转到了不安全的地址");
    if (redirect === "error" && (response.redirected === true || finalUrl !== url)) {
      throw new Error("这个地址发生了跳转");
    }
    return {
      url: finalUrl,
      title,
      text: text.slice(0, MAX_PAGE_CHARACTERS),
      truncated: text.length > MAX_PAGE_CHARACTERS,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

// 搜完之后再抓前几篇正文。抓不到的就退回它的摘要，不让一篇打不开拖垮整轮。
async function readTopResults(results, { fetchImpl, signal, limit = 3 } = {}) {
  const targets = results.slice(0, limit);
  const pages = await Promise.all(targets.map(async (result) => {
    try {
      const page = await fetchPage(result.url, { fetchImpl, signal });
      return { ...result, body: page.text, truncated: page.truncated, read: true };
    } catch (error) {
      return { ...result, body: "", read: false, readError: error?.message || "打不开" };
    }
  }));
  return [...pages, ...results.slice(limit).map((result) => ({ ...result, body: "", read: false }))];
}

module.exports = {
  MAX_PAGE_CHARACTERS,
  extractReadableText,
  fetchPage,
  readTopResults,
  DEFAULT_SEARCH_PROVIDER,
  MAX_RESULTS,
  SEARCH_PROVIDERS,
  decodeHtml,
  listSearchProviders,
  parseDuckDuckGoHtml,
  parseSearxngPayload,
  parseWikipediaPayload,
  safeHttpsEndpoint,
  safePublicUrl,
  searchWeb,
};
