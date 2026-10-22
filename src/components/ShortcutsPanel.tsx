import { X } from "lucide-react";
import { useEffect } from "react";

// 快捷键速查。按 ? 弹出来。
//
// 快捷键的问题从来不是记不住，是不知道有哪些。做了十几个快捷键
// 却只在 tooltip 里零散提一句，等于没做。
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "日常",
    items: [
      ["⌘K", "搜索命令和功能"],
      ["⌘N", "新建对话"],
      ["⌘F", "在当前对话里找"],
      ["⇧⌘F", "搜全部历史对话"],
      ["⌘1-9", "直达侧栏第 N 段对话"],
      ["⌃Tab", "在最近两段对话之间来回跳"],
      ["j / k", "上一条 / 下一条消息（不在输入框时）"],
      ["Home / End", "跳到这段对话的开头 / 末尾"],
      ["[ / ]", "上一个 / 下一个「我的提问」"],
      ["⌘⇧C", "复制最后一条回答"],
      ["⌘,", "设置"],
      ["esc", "停下正在生成的回答"],
      ["?", "打开这个面板"],
    ],
  },
  {
    // 命令面板里藏着一堆没有快捷键的功能。做了却没人知道，等于没做——
    // 这一组就是告诉用户「⌘K 之后能找到什么」。
    title: "⌘K 里能找到",
    items: [
      ["从 ChatGPT 导入对话", "官方导出的 conversations.json，只搬你看到的那条线"],
      ["归档三个月没动的对话", "先报数再确认，不删只收"],
      ["开一段不留记录的对话", "阅后即焚：不写盘、不进备份、不进搜索"],
      ["昨天聊到哪了", "跳回今天之前最后聊的那段"],
      ["打开数据目录", "对话、附件、备份都在那儿"],
    ],
  },
  {
    title: "拖拽",
    items: [
      ["对话行 → 项目名", "把对话归进项目（拖到「未分组」移出）"],
      ["项目名 ↕", "手动排项目顺序（拖过一次就不再按活跃排）"],
      ["侧栏右缘", "拖着改宽度，双击回默认"],
      ["回答旁的抓手", "把整条回答拖进别的应用"],
      ["文件 → 窗口", "文档图片直接进对话；文件夹可当知识库"],
    ],
  },
  {
    title: "全局",
    items: [
      ["⌥⌘K", "剪贴板浮窗：选中一段文字直接处理"],
      ["⌃⌘K", "截一块屏幕拿过来问"],
    ],
  },
  {
    title: "输入框里",
    items: [
      ["↵ / ⌘↵", "发送"],
      ["⇧↵", "换行"],
      ["长按发送键", "这一条临时反转联网开关"],
      ["⌘⇧V", "剪贴板文字直接发出去"],
      ["⌘B / ⌘E", "把选中的字变粗体 / 行内代码"],
      ["/", "开头敲斜杠唤出常用语，Tab 展开"],
      ["↑ / ↓", "空输入框里翻之前问过的话"],
      ["esc esc", "连按两下清空输入框"],
      ["@", "点名工作区里的文件（工程模式）"],
      ["粘贴长文", "超过 2000 字会自动收成附件"],
    ],
  },
];

export default function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="shortcuts-panel" role="dialog" aria-modal="true" aria-label="快捷键">
        <header>
          <div>
            <h2>快捷键</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <div className="shortcuts-group" key={group.title}>
              <div className="section-label">{group.title}</div>
              {group.items.map(([keys, what]) => (
                <div className="shortcuts-row" key={keys}>
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
