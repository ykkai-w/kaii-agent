// 导出时用的文件名清洗。单独放在这里而不是塞进那个含 JSX 的文件里，
// 纯字符串函数就该能被直接调用测试，不用去正则匹配源码。

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function safeFileName(title: string, extension: string): string {
  const cleaned = String(title ?? "")
    .replace(ILLEGAL, "_")
    // 开头的点会变成隐藏文件，末尾的点和空格在某些系统上直接非法。
    .replace(/^\.+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 40);
  return `${cleaned || "对话"}.${extension}`;
}
