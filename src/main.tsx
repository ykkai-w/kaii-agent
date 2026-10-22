import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import QuickPanel from "./QuickPanel";
import "katex/dist/katex.min.css";
import "./styles.css";

// 快捷浮窗复用同一份产物，只靠 hash 区分。这样 preload、CSP 和导航白名单全部沿用主窗口那一套。
const isQuick = window.location.hash === "#quick";
if (isQuick) document.documentElement.dataset.surface = "quick";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isQuick ? <QuickPanel /> : <App />}
  </StrictMode>,
);
