# Demo 输入、源码高亮与工作区筛选过渡

Status: ready-for-human

## 目标与授权

拥有者要求回到 UI demo 开始下一轮：Enter 发送文本，Shift+Enter 换行；文本文件预览语法高亮；工作区筛选输入框展开与收起过渡。仅修改可变 demo 及配套记录，不迁移正式 Desktop，不更新两份冻结稿，不增加其他界面。

## 方案与验收

沿用现有 Textarea、Input 和提交状态。Enter 阻止默认换行后仅在有输入且可提交时发送；保留 Shift+Enter 原生换行，不把中文组合输入、229 键码或按键重复识别为发送，不让空输入 Enter 触发停止。单元检查覆盖键盘分支，浏览器亲验实际提交、换行与待核实行为。

demo 独立声明 highlight.js core，按路径扩展名注册现有样例语言与 JSX 所需 XML。整篇高亮后与独立 sticky 行号列共享滚动容器，不切开跨行 token；未知语言保持纯文本，保留空内容、空行和原始字符。覆盖每种样例语言、跨行注释、危险 HTML 转义、明暗和窄栏横滚。

筛选区域保持挂载，使用 CSS grid 高度与透明度过渡，关闭时 inert／aria-hidden，打开聚焦输入，Escape 清空后将焦点交回触发按钮，沿用 prefers-reduced-motion。浏览器核对双向过渡、快速切换、焦点与闭合不可聚焦。

## 当前阶段

独立方案、实现与最终证据审查无阻断，根代理唯一写入；demo check、check:static 与 diff 空白检查通过，审查者另行亲跑 demo check 通过。浏览器完成 Enter 单次提交、Shift+Enter 换行、核实前保留与完成后清空、筛选开关／焦点／快速切换、明暗高亮与窄栏固定行号验收。[验收记录](../evidence/2026-10-16/input-preview/verification.md)持有证据与限制，最终动画观感交拥有者审阅；正式 Desktop 与冻结稿未改。
