import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

test("设置页删除附加功能说明", () => {
  for (const copy of [
    "防路人，不防黑客",
    "网慢的时候把超时调长",
    "改了立刻生效，只影响这台电脑",
    "哪家模型、大概多少字发了出去",
    "老机器也更跟手",
    "改文件和跑命令都会先停下来等你点允许",
    "维基的 REST 接口稳定、免密钥",
  ]) assert.equal(source.includes(copy), false, copy);
});

test("设置页保留功能入口和配置绑定", () => {
  for (const copy of ["显示模型用量", "后台回答完成提示音", "减少动画", "设一个开屏锁码", "保存设置"]) {
    assert.ok(source.includes(copy), copy);
  }
  for (const binding of ["cloudReceipt", "chatTimeoutMinutes", "agentApproval", "searchFallback", "setLock(code.trim())"]) {
    assert.ok(source.includes(binding), binding);
  }
});

test("公共界面移除研究入口并保留旧会话的只读保护", () => {
  assert.doesNotMatch(source, /dmrml/i);
  assert.doesNotMatch(source, /usage\.items|数据都在这里/);
  assert.match(source, /activeConversation\.detachedContext/);
  assert.match(source, /这段历史对话仅供查阅/);
  assert.ok(source.indexOf("activeConversation.detachedContext") < source.indexOf("const webForThisSend"));
});
