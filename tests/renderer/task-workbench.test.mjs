import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const component = fs.readFileSync(new URL("../../src/components/TaskWorkbench.tsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../../src/task-workbench.css", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

test("隐私审批在工作台内容之前，并保持首屏可见", () => {
  const preview = component.indexOf('{privacyPreview && (');
  const entries = component.indexOf('<nav className="task-workbench-entries"');
  assert.ok(preview >= 0 && entries > preview, "发送审批必须先于任务入口出现");
  const stickyRule = css.match(/\.privacy-preview\s*\{([^}]*)\}/s)?.[1] || "";
  assert.match(stickyRule, /position:\s*sticky;/);
  assert.match(stickyRule, /top:\s*0;/);
  assert.match(stickyRule, /z-index:\s*4;/);
  assert.match(component, /ref=\{privacyCancelRef\}[^>]*>取消<\/button>/);
});

test("模态工作台约束键盘焦点并在关闭后恢复", () => {
  assert.match(component, /restoreFocusRef\.current = document\.activeElement/);
  assert.match(component, /requestAnimationFrame\(\(\) => restoreTarget\.focus\(\)\)/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.match(component, /event\.shiftKey[\s\S]*last\.focus\(\)/);
  assert.match(component, /window\.removeEventListener\("keydown", handleKeyDown\)/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /aria-modal="true"/);
});

test("结果动作只承诺当前真正完成的行为", () => {
  for (const label of ["准备重试", "打开项目…", "放到输入区"]) {
    assert.ok(component.includes(label), `缺少诚实动作名：${label}`);
  }
  for (const overstated of [">重试</button>", ">归项目</button>", ">入资料</button>"]) {
    assert.equal(component.includes(overstated), false, `仍存在夸大的动作名：${overstated}`);
  }
  assert.match(component, /source\.kind === "text" \? "文字"/);
  assert.match(app, /input\.label\.startsWith\("附件记录："\)[\s\S]*?\? "file" as const : "text" as const/);
});

test("附件任务不把文字预览冒充完整载荷预览", () => {
  assert.match(app, /附件正文不在这份逐字预览中/);
  assert.match(app, /附件正文尚未在这里逐字预览，也未经过上方的密钥和个人信息扫描/);
  assert.doesNotMatch(app, /保证预览与发送一致/);
});
