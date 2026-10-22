// 公式渲染的共用配置。
//
// 模型写数学时几乎一定用 LaTeX：行内 $...$，成段 $$...$$。
// 不渲染的话用户看到的就是一堆 \frac{1}{2} 和 \cdots，比不写还难读。
//
// 用 KaTeX 而不是 MathJax：KaTeX 是同步渲染，字体和 CSS 都能打进包里，
// 不需要联网，也不会在流式输出时一闪一闪地重排。

export const KATEX_OPTIONS = {
  // 写错的公式不要把整条回答炸掉。流式输出到一半时公式本来就是残的，
  // throwOnError 会让整段消息渲染失败，用户看到一片空白。
  throwOnError: false,
  // 渲染不出来的部分原样显示成红色，让人知道这里本来是个公式，
  // 而不是悄悄吞掉。
  errorColor: "var(--danger)",
  // \newcommand 之类的宏定义只在当前这一段生效，不跨消息污染。
  globalGroup: false,
  // 屏蔽会引入外部资源或改变全局状态的命令。
  trust: false,
  strict: false as const,
  // 分数线、根号线都吃这个值。0.06em 在 15px 正文下不到一个物理像素，
  // 会被抗锯齿糊成一条灰影——用户第一眼就说"分数的横线看不清"。
  minRuleThickness: 0.1,
};

// 行内公式的误判修正。
//
// remark-math 把 `$...$` 之间的东西都当公式。日常聊天里这会出事：
// 「花了 $5 买的，另一个 $8」——两个美元号配成一对，中间那句中文
// 被整段当成公式吃掉，用户看到的是一串数学符号。
//
// 判据不能是“只要有中文就不是公式”。`$\text{利润}=收入-成本$`、
// `$x_{价格}$` 都是正常 LaTeX。现在只把“有中文、又完全没有数学语法”
// 的 inlineMath 还原成文字：这仍能修正 `$5 买的，另一个 $8` 的误配，
// 但不会误伤带中文标签的公式。

const CJK = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;
// 汉字不能一刀切：`\text{利润}`、`x_{价格}`都是合法数学。
// 但 `/` / `+` / `*` 单独也不够强，价格和普通中文里太常见；
// 否则“$5/本，另一个 $8”又会整段被当公式。
const MATH_SYNTAX = /\\[A-Za-z]+|[_^]\s*(?:\{|[A-Za-z0-9])|[=≤≥≈≠√∑∏∫∈∉∞±×÷]/;

interface MathNode {
  type: string;
  value?: string;
  children?: MathNode[];
}

export function looksLikeMath(value: string): boolean {
  return !CJK.test(value) || MATH_SYNTAX.test(value);
}

// 一个极小的 remark 插件：把含中文的 inlineMath 还原成普通文字。
// 手写遍历而不是引 unist-util-visit——为了一个十行的判断多背一个依赖不值得。
export function remarkNoCurrencyMath() {
  return (tree: MathNode) => {
    const walk = (node: MathNode) => {
      if (!Array.isArray(node.children)) return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index];
        if (child.type === "inlineMath" && typeof child.value === "string" && !looksLikeMath(child.value)) {
          node.children[index] = { type: "text", value: `$${child.value}$` };
          continue;
        }
        walk(child);
      }
    };
    walk(tree);
  };
}
