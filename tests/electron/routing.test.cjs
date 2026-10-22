const assert = require("node:assert/strict");
const test = require("node:test");

const routing = require("../../electron/lib/routing.cjs");

const AVAILABLE = [
  { provider: "local", model: "", configured: true },
  { provider: "zhipu", model: "glm-5.2", configured: true },
  { provider: "moonshot", model: "kimi-k3", configured: true },
];

test("everyday questions stay on the local model so they cost nothing", () => {
  const pick = routing.pickModel({ question: "帮我把这句话说得顺一点", available: AVAILABLE });
  assert.equal(pick.provider, "local");
  assert.equal(pick.auto, true);
  assert.equal(pick.reason, routing.REASONS.simple);
});

test("anything that touches files goes to the strongest model", () => {
  // 本机 8B 在工程任务上实测 3/8，这类活不该让它碰。
  const pick = routing.pickModel({ question: "把测试跑一下", useTools: true, available: AVAILABLE });
  assert.equal(pick.provider, "zhipu");
  assert.equal(pick.model, "glm-5.2");
  assert.equal(pick.reason, routing.REASONS.tools);
});

test("code in the question routes to the coding model", () => {
  for (const question of [
    "```js\nconst a = 1;\n```\n这段有问题吗",
    "function subtotal(items) { return 0; } 帮我看看",
    "def main(): pass 这样写对吗",
    "npm run build 报错了",
    "<div className=\"x\" /> 为什么不显示",
  ]) {
    const pick = routing.pickModel({ question, available: AVAILABLE });
    assert.equal(pick.provider, "zhipu", `这条应当认成代码：${question}`);
    assert.equal(pick.reason, routing.REASONS.code);
  }

  // 日常话里带个别英文词不该被误判成代码。
  for (const question of [
    "我今天function了一下这个想法",
    "这个 class 的同学都很好",
    "import 这个词怎么翻译",
  ]) {
    assert.equal(routing.looksLikeCode(question), false, `这条不该算代码：${question}`);
  }
});

test("long material and long chats move to the big-context model", () => {
  const long = routing.pickModel({
    question: "总结一下",
    attachedCharacters: routing.LONG_INPUT_CHARACTERS + 1,
    available: AVAILABLE,
  });
  assert.equal(long.model, "kimi-k3");
  assert.equal(long.reason, routing.REASONS.longInput);

  const chatty = routing.pickModel({ question: "继续", conversationCharacters: 9000, available: AVAILABLE });
  assert.equal(chatty.model, "kimi-k3");
  assert.equal(chatty.reason, routing.REASONS.longChat);
});

test("a manual choice is never overridden", () => {
  const pick = routing.pickModel({
    question: "把测试跑一下",
    useTools: true,
    available: AVAILABLE,
    manual: { provider: "deepseek", model: "deepseek-v4-pro" },
  });
  assert.equal(pick.provider, "deepseek");
  assert.equal(pick.auto, false);
  assert.equal(pick.reason, routing.REASONS.manual);
});

test("with no cloud key configured everything stays local and says why", () => {
  const offline = [{ provider: "local", model: "", configured: true }, { provider: "zhipu", model: "glm-5.2", configured: false }];
  const pick = routing.pickModel({ question: "改个 bug", useTools: true, available: offline });
  assert.equal(pick.provider, "local");
  assert.equal(pick.reason, routing.REASONS.offline);
});

test("local-only mode overrides cloud keys, manual cloud choice and coding heuristics", () => {
  const pick = routing.pickModel({
    question: "```js\nconst broken = true\n```",
    useTools: true,
    available: AVAILABLE,
    manual: { provider: "zhipu", model: "glm-5.2" },
    localOnly: true,
  });
  assert.deepEqual(pick, {
    provider: "local",
    model: "",
    reason: routing.REASONS.localOnly,
    auto: true,
  });
});

test("every reason is short enough to sit in the composer", () => {
  for (const reason of Object.values(routing.REASONS)) {
    assert.ok(reason.length <= 12, `理由太长：${reason}`);
  }
});

test("comparison operators in plain Chinese are not mistaken for tags", () => {
  // 这条是实测出来的：一开始 "他说 a<b 而且 b>c" 被当成了 HTML 标签。
  for (const question of ["他说 a<b 而且 b>c", "温度 <30 度就行", "如果 x<y 就取 x", "1<2 而且 2>1"]) {
    assert.equal(routing.looksLikeCode(question), false, `这条不该算代码：${question}`);
  }
  for (const question of ['<div className="x" /> 为什么不显示', "<Button onClick={fn}>点我</Button>", "</section> 少了什么"]) {
    assert.equal(routing.looksLikeCode(question), true, `这条应当算代码：${question}`);
  }
});

test("an image goes to a model that can actually look at it", () => {
  const seeing = [
    { provider: "local", model: "", configured: true },
    { provider: "moonshot", model: "kimi-k3", configured: true, vision: true },
    { provider: "zhipu", model: "glm-5.2", configured: true, vision: false },
  ];
  const pick = routing.pickModel({ question: "这张图什么意思", hasImage: true, available: seeing });
  assert.equal(pick.model, "kimi-k3");
  assert.equal(pick.reason, routing.REASONS.image);

  // 一家会看图的都没有时，退回本机并说清它只能认字。
  const blind = [
    { provider: "local", model: "", configured: true },
    { provider: "zhipu", model: "glm-5.2", configured: true, vision: false },
  ];
  const fallback = routing.pickModel({ question: "这张图什么意思", hasImage: true, available: blind });
  assert.equal(fallback.provider, "local");
  assert.equal(fallback.reason, routing.REASONS.imageLocal);

  // 有图优先于其它规则：哪怕开着工程模式，也先找会看图的。
  const withTools = routing.pickModel({ question: "照着这张图改", hasImage: true, useTools: true, available: seeing });
  assert.equal(withTools.model, "kimi-k3");
});
