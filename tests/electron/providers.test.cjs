const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const providers = require("../../electron/lib/providers.cjs");

function sandbox() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kaii-cred-")));
}

const FAKE_KEY = "sk-testkeytestkeytestkey1234";

test("keys land in a 0600 file outside the repo and never in settings", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "deepseek", FAKE_KEY);

  const file = providers.credentialsPath(userData);
  assert.equal(path.basename(file), "credentials.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "凭据文件必须是 0600");
  assert.equal(providers.getApiKey(userData, "deepseek"), FAKE_KEY);

  // 绝不能落进 settings.json——那份文件是要能随手分享的。
  assert.equal(fs.existsSync(path.join(userData, "settings.json")), false);

  providers.setApiKey(userData, "deepseek", "");
  assert.equal(providers.getApiKey(userData, "deepseek"), "");
});

test("a real rename failure removes only the temp owned by this credential write", () => {
  const failedUserData = sandbox();
  const target = providers.credentialsPath(failedUserData);
  const temp = `${target}.${process.pid}.tmp`;
  // POSIX 不能用普通文件原子替换一个目录，真实触发 rename(2) 失败。
  fs.mkdirSync(target);
  assert.throws(() => providers.writeCredentials(failedUserData, { deepseek: FAKE_KEY }));
  assert.equal(fs.existsSync(temp), false, "rename 失败也不得留下明文临时副本");
  assert.equal(fs.statSync(target).isDirectory(), true, "失败路径不得顺手删掉既有 target");

  const occupiedUserData = sandbox();
  const occupiedTarget = providers.credentialsPath(occupiedUserData);
  const occupiedTemp = `${occupiedTarget}.${process.pid}.tmp`;
  fs.writeFileSync(occupiedTemp, "not owned by this call\n", { mode: 0o600 });
  assert.throws(
    () => providers.writeCredentials(occupiedUserData, { deepseek: FAKE_KEY }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(
    fs.readFileSync(occupiedTemp, "utf8"),
    "not owned by this call\n",
    "O_EXCL 失败说明没有取得所有权，finally 不得删除同名文件",
  );
});

test("write failure removes its partial temp and redacts the key from the error", () => {
  const userData = sandbox();
  const target = providers.credentialsPath(userData);
  const temp = `${target}.${process.pid}.tmp`;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === "number") throw new Error(`write failed with ${FAKE_KEY}`);
    return originalWrite(file, ...args);
  };
  let thrown;
  try {
    providers.writeCredentials(userData, { deepseek: FAKE_KEY });
  } catch (error) {
    thrown = error;
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.ok(thrown);
  assert.equal(thrown.message.includes(FAKE_KEY), false, "写盘错误不得把 key 带回 IPC");
  assert.match(thrown.message, /\[已隐藏的 API key\]/);
  assert.equal(fs.existsSync(temp), false, "部分写入也必须 finally 清掉");
  assert.equal(fs.existsSync(target), false);
});

test("a chmod error still reports success when the renamed credential is already 0600", () => {
  const userData = sandbox();
  const originalChmod = fs.chmodSync;
  fs.chmodSync = () => { throw new Error(`chmod failed with ${FAKE_KEY}`); };
  let result;
  try {
    result = providers.writeCredentials(userData, { zhipu: FAKE_KEY });
  } finally {
    fs.chmodSync = originalChmod;
  }
  const target = providers.credentialsPath(userData);
  assert.deepEqual(result, { ok: true }, "canonical 已安全落盘时不能误报保存失败");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { zhipu: FAKE_KEY });
  assert.equal(fs.existsSync(`${target}.${process.pid}.tmp`), false);
});

test("startup cleanup removes only exact regular credential temps", () => {
  const crashedUserData = sandbox();
  const crashedTarget = providers.credentialsPath(crashedUserData);
  const stale = `${crashedTarget}.314159.tmp`;
  const unrelated = path.join(crashedUserData, "other-feature.tmp");
  const similar = [
    `${crashedTarget}.0.tmp`,
    `${crashedTarget}.-1.tmp`,
    `${crashedTarget}.pid.tmp`,
    `${crashedTarget}.2718.tmp.bak`,
    `${crashedTarget}.2718.tmpx`,
  ];
  const exactDirectory = `${crashedTarget}.1618.tmp`;
  const exactSymlink = `${crashedTarget}.1414.tmp`;
  const outside = path.join(sandbox(), "outside-secret.txt");

  fs.writeFileSync(stale, `${FAKE_KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(unrelated, "keep me\n");
  for (const file of similar) fs.writeFileSync(file, "keep me\n");
  fs.mkdirSync(exactDirectory);
  fs.writeFileSync(outside, "outside stays\n", { mode: 0o600 });
  fs.symlinkSync(outside, exactSymlink);

  assert.deepEqual(providers.readCredentials(crashedUserData), {});
  assert.equal(fs.existsSync(stale), false, "新进程首次读凭据前应清理上次崩溃副本");
  assert.equal(fs.existsSync(unrelated), true, "不得用宽泛 tmp 清理误删其他文件");
  for (const file of similar) assert.equal(fs.existsSync(file), true, `相似名字不得删除：${path.basename(file)}`);
  assert.equal(fs.statSync(exactDirectory).isDirectory(), true, "exact 名字的目录也不是凭据副本");
  assert.equal(fs.lstatSync(exactSymlink).isSymbolicLink(), true, "清扫不得删除或跟随符号链接");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside stays\n");
});

test("the renderer only ever sees the last four characters", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "zhipu", FAKE_KEY);
  const list = providers.listProviders(userData);
  const zhipu = list.find((item) => item.id === "zhipu");

  assert.equal(zhipu.configured, true);
  assert.equal(zhipu.maskedKey, `已保存 …${FAKE_KEY.slice(-4)}`);
  // 整个返回结构里不能出现完整 key。
  assert.equal(JSON.stringify(list).includes(FAKE_KEY), false, "完整 key 泄漏到界面数据里了");
  assert.equal(providers.maskKey(""), "");
  assert.equal(providers.maskKey(null), "");
  assert.match(providers.maskKey(FAKE_KEY), /…\w{4}$/, "只显示后 4 位");
  assert.equal(providers.maskKey("short"), "已保存", "过短值不得原样送到界面");
});

test("anything shown to the user gets the key scrubbed out of it", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "moonshot", FAKE_KEY);
  const leaky = `请求失败：Bearer ${FAKE_KEY} 被拒绝`;
  const clean = providers.redact(leaky, userData);
  assert.equal(clean.includes(FAKE_KEY), false);
  assert.match(clean, /\[已隐藏的 API key\]/);
  assert.equal(providers.redact("普通报错", userData), "普通报错");
});

test("structured tool receipts can be redacted before audit, IPC and model reuse", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "deepseek", FAKE_KEY);
  const original = {
    summary: `读到 ${FAKE_KEY}`,
    detail: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
    modelText: [`内容 ${FAKE_KEY}`],
    meta: { safe: true },
  };
  const clean = providers.redactValue(original, userData);

  assert.equal(JSON.stringify(clean).includes(FAKE_KEY), false);
  assert.match(clean.summary, /\[已隐藏的 API key\]/);
  assert.equal(original.summary.includes(FAKE_KEY), true, "脱敏不应偷改原工具结果");
});

test("local stays local: no key, no auth header, loopback only", () => {
  const userData = sandbox();
  const endpoint = providers.resolveEndpoint({ providerId: "local", userDataPath: userData, localPort: 8091 });
  assert.equal(endpoint.cloud, false);
  assert.equal(endpoint.baseUrl, "http://127.0.0.1:8091");
  assert.equal(endpoint.headers.authorization, undefined, "本机请求不该带鉴权头");
  assert.throws(() => providers.setApiKey(userData, "local", FAKE_KEY), /不需要 API key/);
});

test("cloud endpoints refuse to build without a key", () => {
  const userData = sandbox();
  assert.throws(
    () => providers.resolveEndpoint({ providerId: "deepseek", userDataPath: userData, localPort: 8091 }),
    /还没有填 DeepSeek 的 API key/,
  );

  providers.setApiKey(userData, "deepseek", FAKE_KEY);
  const endpoint = providers.resolveEndpoint({
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    userDataPath: userData,
    localPort: 8091,
  });
  assert.equal(endpoint.cloud, true);
  assert.equal(endpoint.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(endpoint.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(endpoint.model, "deepseek-v4-pro");
});

test("provider and model ids are validated, junk is rejected", () => {
  assert.throws(() => providers.validateProviderId("openai"), /模型来源无效/);
  assert.throws(() => providers.validateProviderId("__proto__"), /模型来源无效/);
  assert.equal(providers.validateModelId("deepseek", ""), "", "空表示用默认模型");
  assert.equal(providers.validateModelId("deepseek", "glm-4.7"), "glm-4.7", "模型名由各家决定，只做形状校验");
  assert.throws(() => providers.validateModelId("deepseek", "带 空格"), /模型无效/);
  assert.throws(() => providers.validateModelId("deepseek", "x".repeat(200)), /模型无效/);
  assert.equal(providers.validateModelId("local", "随便"), "");

  assert.throws(() => providers.validateApiKey("有 空格的key"), /API key 格式无效/);
  assert.throws(() => providers.validateApiKey("x".repeat(500)), /API key 格式无效/);
  assert.throws(() => providers.validateApiKey("  sk-abc  "), /API key 格式无效/);
});

test("legacy short keys are ignored instead of displayed or used without redaction", () => {
  const userData = sandbox();
  fs.writeFileSync(providers.credentialsPath(userData), '{"deepseek":"sk-abc"}\n', { mode: 0o600 });
  assert.deepEqual(providers.readCredentials(userData), {});
  const deepseek = providers.listProviders(userData).find((item) => item.id === "deepseek");
  assert.equal(deepseek.configured, false);
  assert.equal(deepseek.maskedKey, "");
  assert.throws(
    () => providers.resolveEndpoint({ providerId: "deepseek", userDataPath: userData, localPort: 8091 }),
    /还没有填/,
  );
});

test("a corrupt credentials file degrades to no keys instead of crashing", () => {
  const userData = sandbox();
  fs.writeFileSync(providers.credentialsPath(userData), "不是 JSON");
  assert.deepEqual(providers.readCredentials(userData), {});

  fs.writeFileSync(providers.credentialsPath(userData), JSON.stringify({ openai: "x", deepseek: 123, zhipu: FAKE_KEY }));
  // 未知来源和非字符串一律丢掉。
  assert.deepEqual(providers.readCredentials(userData), { zhipu: FAKE_KEY });
});

test("model discovery falls back to the bundled list when the network says no", async () => {
  const userData = sandbox();
  providers.setApiKey(userData, "zhipu", FAKE_KEY);

  const failing = await providers.fetchModels(userData, "zhipu", {
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.live, false);
  assert.ok(failing.models.length >= 1, "拉不到也要给个兜底清单，不能让界面空着");
  assert.match(failing.message, /HTTP 401/);

  const live = await providers.fetchModels(userData, "zhipu", {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "glm-5.2" }, { id: "glm-4.6" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(live.live, true);
  assert.deepEqual(live.models.map((model) => model.id), ["glm-4.6", "glm-5.2"]);

  // 没填 key 时不该发请求。
  const noKey = await providers.fetchModels(sandbox(), "deepseek", {
    fetchImpl: async () => { throw new Error("不该被调用"); },
  });
  assert.equal(noKey.ok, false);
  assert.match(noKey.message, /还没有填/);
});

test("no source file hides raw control characters inside a regex class", () => {
  // 这条是被真实故障逼出来的：providers.cjs 里的 API key 校验写成了字面控制字符，
  // 看起来像 /[ -]/，实际是 /[<0x00>-<0x1f>]/，于是带空格的 key 被放行。
  // 这类问题肉眼审不出来，只能靠扫描。
  const projectRoot = path.resolve(__dirname, "../..");
  const roots = [path.join(projectRoot, "electron"), path.join(projectRoot, "src")];
  const offenders = [];
  const controlInClass = new RegExp("/\\[[^\\]]*[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f][^\\]]*\\]");

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!/\.(cjs|ts|tsx)$/.test(entry.name)) continue;
      fs.readFileSync(target, "utf8").split("\n").forEach((line, index) => {
        if (controlInClass.test(line)) offenders.push(`${path.relative(projectRoot, target)}:${index + 1}`);
      });
    }
  };
  for (const root of roots) walk(root);

  assert.deepEqual(offenders, [], `这些地方要改成 \\u00xx 显式转义：${offenders.join("、")}`);
});

test("each provider carries its own context window and parameter quirks", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "moonshot", FAKE_KEY);
  providers.setApiKey(userData, "zhipu", FAKE_KEY);

  const local = providers.resolveEndpoint({ providerId: "local", userDataPath: userData, localPort: 8091 });
  assert.equal(local.contextWindow, 0, "本机用设置里的那份，由硬件决定");
  assert.deepEqual(local.forceParams, {});

  const kimi = providers.resolveEndpoint({ providerId: "moonshot", userDataPath: userData, localPort: 8091 });
  assert.ok(kimi.contextWindow >= 100_000, "云端不该被本机的 8K 卡住");
  // 实测 k2/k3 只接受 temperature=1，传别的值直接 400。
  assert.equal(kimi.forceParams.temperature, 1);

  const glm = providers.resolveEndpoint({ providerId: "zhipu", userDataPath: userData, localPort: 8091 });
  assert.ok(glm.contextWindow >= 100_000);
  assert.deepEqual(glm.forceParams, {}, "智谱没有这个限制，不该乱加参数");
});

test("the model catalog is grouped by what to pick, not by company", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "zhipu", FAKE_KEY);

  const catalog = providers.buildModelCatalog(userData, {});
  const groups = catalog.map((section) => section.group);
  assert.deepEqual(groups, ["主力", "轻快"]);

  const flagship = catalog[0].items;
  // 本机不需要 key，永远可选。
  const local = flagship.find((item) => item.provider === "local");
  assert.equal(local.configured, true);
  assert.equal(local.model, "");
  assert.equal(local.label, "Qwen3-8B");
  assert.equal(local.note, "本地化");
  // 没填 key 的来源要标出来，但仍然列出来，让用户知道有这个选项。
  assert.equal(flagship.find((item) => item.provider === "deepseek").configured, false);
  assert.equal(flagship.find((item) => item.provider === "zhipu").configured, true);
  // 每个条目都要有一句短评。
  for (const section of catalog) {
    for (const item of section.items) {
      assert.ok(item.note && item.note.length <= 14, `${item.label} 的短评太长或缺失：${item.note}`);
      assert.ok(item.label);
    }
  }
});

test("models that no longer exist upstream are hidden instead of 404-ing", () => {
  const userData = sandbox();
  providers.setApiKey(userData, "zhipu", FAKE_KEY);
  providers.setApiKey(userData, "deepseek", FAKE_KEY);

  // 真实清单里没有 glm-5.2 时，这一条就不该出现在菜单里。
  const catalog = providers.buildModelCatalog(userData, {
    zhipu: ["glm-4.6"],
    deepseek: ["deepseek-chat"],
  });
  const flagship = catalog[0].items.map((item) => `${item.provider}:${item.model}`);
  assert.equal(flagship.includes("zhipu:glm-5.2"), false, "下线的模型要隐藏");
  // deepseek-chat 已退役，真实清单只剩它时不得再当作 V4 Pro 的备选。
  assert.equal(flagship.some((item) => item.startsWith("deepseek:")), false);
  assert.equal(catalog.flatMap((section) => section.items).some((item) => item.model === "deepseek-chat"), false);
});

test("比一比那条路上的错误也要脱敏，不能把 key 漏到界面上", () => {
  const fs = require("node:fs");
  const main = fs.readFileSync(require("node:path").join(__dirname, "../../electron/main.cjs"), "utf8");
  const block = main.slice(main.indexOf("async function runCompare"), main.indexOf("function cancelCompare"));
  assert.match(block, /providers\.redact\(/);
  // redact 需要 userDataPath 才知道该遮哪些 key，少传一个参数等于没脱敏。
  assert.match(block, /providers\.redact\([^)]*, userDataPath\)/);
});

test("每一处 redact 调用都带上了 userDataPath", () => {
  const fs = require("node:fs");
  const main = fs.readFileSync(require("node:path").join(__dirname, "../../electron/main.cjs"), "utf8");
  const marker = "providers.redact(";
  let cursor = 0;
  let count = 0;
  while ((cursor = main.indexOf(marker, cursor)) >= 0) {
    const start = cursor + marker.length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    let end = start;
    for (; end < main.length && depth > 0; end += 1) {
      const character = main[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    const argumentsSource = main.slice(start, end - 1);
    let argumentDepth = 0;
    let hasTopLevelComma = false;
    quote = "";
    escaped = false;
    for (const character of argumentsSource) {
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if ("([{ ".includes(character) && character !== " ") argumentDepth += 1;
      else if (")] }".includes(character) && character !== " ") argumentDepth -= 1;
      else if (character === "," && argumentDepth === 0) hasTopLevelComma = true;
    }
    assert.equal(hasTopLevelComma, true, `这处 redact 少了第二个参数：${argumentsSource.slice(0, 100)}`);
    count += 1;
    cursor = end;
  }
  assert.ok(count > 0, "源码里没找到 redact 调用，这条安全检查本身已经失效");
});

test("云端回退判定：网络/服务抖动才回退，用户配置错误不回退", () => {
  for (const transient of ["HTTP 502", "fetch failed", "ECONNRESET", "ENOTFOUND api", "ETIMEDOUT", "请求超时", "没有返回事件流"]) {
    assert.strictEqual(providers.isTransientNetworkError(transient), true, transient);
  }
  for (const permanent of ["HTTP 401 Unauthorized", "HTTP 429 Too Many Requests", "API key 无效", "模型名不存在"]) {
    assert.strictEqual(providers.isTransientNetworkError(permanent), false, permanent);
  }
});

test("模型启动失败翻译：三种常见故障都给出能照做的修法", () => {
  assert.match(providers.describeModelStartFailure("spawn ENOENT", "/opt/llama/llama-server"), /找不到 llama-server（\/opt\/llama\/llama-server）/);
  assert.match(providers.describeModelStartFailure("EACCES denied", "x"), /chmod \+x/);
  assert.match(providers.describeModelStartFailure("listen EADDRINUSE :8080", "x"), /端口被别的程序占了/);
  assert.match(providers.describeModelStartFailure("莫名其妙", "x"), /Qwen 启动失败：莫名其妙/);
});

test("模型加载超时会读字符串日志，分清端口占用和内存不足", () => {
  assert.match(
    providers.describeModelStartTimeout(["[server] bind: address already in use"], 8091),
    /端口 8091 被别的程序占了/,
  );
  assert.match(
    providers.describeModelStartTimeout(["[server] failed to allocate memory"], 8091),
    /内存不够/,
  );
  assert.match(providers.describeModelStartTimeout(["[server] still loading"], 8091), /运行日志/);
});

test("读进程内存：拿自己的 pid 能读出正数，坏 pid 返回 0", () => {
  const mine = providers.readProcessRssMb(process.pid);
  assert.ok(mine > 0, `自己的进程内存应当大于 0，读到 ${mine}`);
  assert.strictEqual(providers.readProcessRssMb(-1), 0);
  assert.strictEqual(providers.readProcessRssMb(999999999), 0);
  assert.strictEqual(providers.readProcessRssMb("abc"), 0);
});
