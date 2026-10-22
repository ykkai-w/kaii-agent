export type CodeBlockViewState = Readonly<{
  wrapped: boolean;
  numbered: boolean;
}>;

export type CodeBlockViewAction = "wrap" | "numbers";

export const INITIAL_CODE_BLOCK_VIEW: CodeBlockViewState = Object.freeze({
  wrapped: false,
  numbered: false,
});

/**
 * 折行会让一条源代码占多个视觉行，而行号槽只知道源代码行。
 * 因此开启其中一个时关掉另一个；单纯关闭时不动另一个状态。
 */
export function toggleCodeBlockView(
  current: CodeBlockViewState,
  action: CodeBlockViewAction,
): CodeBlockViewState {
  // 现在组件不会产生这个状态，但以后如果状态被持久化或从旧版水合，
  // reducer 也不能把“两个都开”带进下一次渲染。
  const safeCurrent = current.wrapped && current.numbered
    ? INITIAL_CODE_BLOCK_VIEW
    : current;

  if (action === "wrap") {
    return safeCurrent.wrapped
      ? { ...safeCurrent, wrapped: false }
      : { wrapped: true, numbered: false };
  }

  return safeCurrent.numbered
    ? { ...safeCurrent, numbered: false }
    : { wrapped: false, numbered: true };
}
