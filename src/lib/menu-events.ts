// 菜单在点到外面时要关，但点开关本身不能又被
// window 的关闭器在同一次点击里立刻关掉。
export function keepMenuClickInside(event: Pick<Event, "stopPropagation">): void {
  event.stopPropagation();
}
