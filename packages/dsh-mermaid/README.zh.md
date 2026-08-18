# @puji4810/dsh-mermaid

为 ` ```mermaid ` 代码块提供 Web 客户端渲染，与 `@puji4810/dsh-tikz` 并列。Host 半边从
`/dsh-mermaid/mermaid.min.js` 提供官方 Mermaid 浏览器 bundle；Client 半边加载后，
把每个已渲染的 Mermaid 代码块（按 `language-mermaid` class 或可见的 info-string
横幅匹配）原地替换成 SVG，并跟随页面的 `prefers-color-scheme` 选择明暗主题。
渲染串行执行、单图超时保护；失败时保留源码在一个可展开的诊断块里，而不是静默丢图。

单独安装：

```bash
dsh plugin --profile web add @puji4810/dsh-mermaid
```

或与 StudyOS 一起安装 —— `dsh plugin --profile web add @puji4810/dsh-study`
会同时激活 StudyOS 面板与 TikZ、Mermaid 两个渲染器。