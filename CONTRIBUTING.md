# 参与开发

欢迎提交具体的使用问题、界面改进和代码。报告问题时，写清 macOS 版本、kaii-agent 版本、操作步骤和实际结果；截图与样例请先去除个人内容。

## 本地运行

准备 macOS、Node.js 22.12 或更新版本，以及 Xcode Command Line Tools。

```bash
npm ci
npm run build:native
npm run dev
```

云端功能使用自己的 API key。本机推理另需 llama.cpp 与模型权重。

## 界面预览

日常修改界面，可以先运行带演示数据的预览环境。

```bash
npm run harness
npm run harness:workbench
```

完整界面的地址为 `http://127.0.0.1:4178/harness/index.html`，任务工作台的地址为 `http://127.0.0.1:4179/harness/task-workbench.html`。两个入口均在浏览器里加载真实组件，模型事件由测试代码模拟，Electron 和模型进程保持关闭。

完整界面支持 `?view=welcome`、`?view=browse`、`?view=showcase`、`?view=empty`、`?view=lock` 等场景。`showcase` 提供 README 中的演示对话、检索片段和任务。改动后检查浅色与深色、窄窗口、键盘操作和长内容，再保存截图。引导里的 key 输入在预览环境中只改变模拟状态。

README 的展示图放在 `docs/images/`，每张配一段具体用法和功能入口。截图使用普通示例资料，模型回答、任务状态和文件路径都要交代来源。使用 macOS 所选窗口截图，保留完整窗口、侧栏、标题栏与系统阴影，各张保持相同窗口尺寸。

## 检查改动

```bash
npm run test:main
npm run test:renderer
npm run build
npm run test:native
npm run test:package
```

主进程测试位于 `tests/electron/`，界面纯函数和源码契约测试位于 `tests/renderer/`。测试按单进程顺序运行，减少高负载机器上的超时干扰。纯函数放在 `.ts` 文件里，便于直接导入测试。

保存构建命令的实际退出码。修改文件格式、备份、任务恢复或权限逻辑时，同时补上失败、取消和中断场景。测试断言要覆盖实际结果，例如文件内容、事件顺序和恢复状态。

## 凭据与执行权限

API key 由主进程写入应用数据目录的 `credentials.json`，权限为 `0600`。界面读取配置状态和掩码，原始 key 只在输入与保存期间经过界面。错误提示通过 `providers.redact(text, userDataPath)` 处理。

工作目录默认只读，写入需单独授权。命令会以当前用户的权限执行项目代码，审批界面应清楚展示工作目录与命令。相关检查见[安全说明](SECURITY.md)。

提交时写明改了什么、怎样验证、结果如何。新增或失败的实验也要保留执行条件与结果，方便后续复现。
