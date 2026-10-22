import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { ONBOARDING_KEY, hasCloudProvider, isBrowsingWithoutModel, onboardingKeyError, readOnboardingChoice, rememberOnboardingChoice } from "../../src/lib/onboarding.ts";

test("首次打开及未知版本保留引导", () => {
  assert.equal(readOnboardingChoice({ getItem: () => null }), null);
  assert.equal(readOnboardingChoice({ getItem: () => "future" }), null);
  assert.equal(readOnboardingChoice({ getItem: () => { throw new Error("blocked"); } }), null);
});

test("浏览选择持久化只写状态", () => {
  const items = new Map();
  const storage = { getItem: (k) => items.get(k), setItem: (k, v) => items.set(k, v) };
  rememberOnboardingChoice(storage, "browse");
  assert.deepEqual([...items], [[ONBOARDING_KEY, "browse"]]);
  assert.equal(readOnboardingChoice(storage), "browse");
  rememberOnboardingChoice(storage, "configured");
  assert.equal(readOnboardingChoice(storage), "configured");
  assert.doesNotThrow(() => rememberOnboardingChoice({ setItem: () => { throw new Error(); } }, "browse"));
});

test("本机默认 provider 标记不能被当成已配置的云端", () => {
  const local = { cloud: false, configured: true };
  const cloud = { cloud: true, configured: false };
  assert.equal(hasCloudProvider([local, cloud]), false);
  assert.equal(isBrowsingWithoutModel("browse", [local, cloud], false), true);
  assert.equal(isBrowsingWithoutModel("browse", [{ ...cloud, configured: true }], false), false);
  assert.equal(isBrowsingWithoutModel("browse", [local], true), false);
  assert.equal(isBrowsingWithoutModel("configured", [local], false), false);
});

test("key 输入只校验形状，不声称连接成功", () => {
  assert.ok(onboardingKeyError(""));
  assert.ok(onboardingKeyError("short"));
  assert.ok(onboardingKeyError("abc defghijk"));
  assert.ok(onboardingKeyError("a".repeat(401)));
  assert.equal(onboardingKeyError(" example-key-for-test "), null);
});

test("无模型的浏览状态在路由或启动模型之前返回", () => {
  const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
  const send = app.slice(app.indexOf("const send = useCallback"));
  assert.ok(send.indexOf("if (browsingWithoutModel)") < send.indexOf("window.kaiLocal.routeModel"));
  assert.ok(send.indexOf("if (browsingWithoutModel)") < send.indexOf("await startModel()"));
  const panel = fs.readFileSync(new URL("../../src/components/WelcomePanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /type="password"/);
  assert.doesNotMatch(panel, /console\.|localStorage|fetch\(|startModel\(/);
});
