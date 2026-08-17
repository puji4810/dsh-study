# @puji4810/dsh-tikz

为 dsh Web 提供 ` ```tikz ` 代码块渲染。使用 TikZJax，并默认加载 `pgfplots` 与 `\pgfplotsset{compat=1.12}`，兼容 Math Vault 中的 TikZ 绘图要求。Host 路由提供 TikZJax 所期待的 pgfplots surf-shading 文件名映射，同时保留 PGFPlots 在缺少 Ximera driver 时的内置 fallback。渲染失败时会保留源码并显示可展开的诊断块，不再只有 TikZJax 的 `img-not-found` 占位图。
