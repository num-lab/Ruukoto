# Demo 输入与源码预览验收

## 范围

[工单06](../../../issues/06-input-preview-refinement.md)仅修改可变 demo 及其说明、决定与检查，正式 Desktop、两份冻结稿和根依赖锁未改。新增 highlight.js 11.12.0 仅在 demo 独立包／锁中声明。范围与哈希见[记录](source-hashes.json)。

## 工程检查

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过：类型、SSR、七种键盘分支、逐样例语言高亮、跨行注释、原始字符／空行／末尾换行、危险 HTML、未知与空文件回归，以及生产构建。独立审查者亲跑同一检查通过，无阻断。原始 CSS 来源断言允许此前提交清理过的行尾空白，仍逐字核对实际样式。构建保留主 chunk 大于 500 kB 的提示，不改变功能。

`npm run check:static` 通过，覆盖 lint、全 workspace 类型、笔记与文档门禁；`git diff --check` 通过。独立最终复核确认 9 项源码哈希、23／41 项冻结哈希与范围一致，明暗截图及记录无未解决阻断；深色图在主题绘制稳定后重新保存并复核。

## 浏览器操作

使用现有 127.0.0.1:5173 标签页、833×827 视口。旧 dev server 已停止，页内旧缓存最初仍执行原快捷键；在当前 checkout 启动服务并刷新后重新进行下列检查，旧缓存尝试不作为通过依据。

实际输入「键盘验收第一行」，Shift+Enter 后草稿为该文字加换行，未发起提交；续写「第二行」再按 Enter，进入核实、输入只读并保留原草稿且不新增换行。核实后草稿清空，消息中该两行文本只出现一次。完成后刷新还原演示样例，最终截图不保留测试输入。

展开筛选后高度 36 px、焦点进入输入；输入 fumo 后 nexus 工作区消失。Escape 清空并关闭，焦点返回筛选按钮；收起瞬间仍有 36 px 高度和完整透明度，随后到 0 px／0，确认收起过渡而非卸载；样式为 160 ms 高度／透明度过渡。关闭区域有 inert／aria-hidden，触发器 Tab 后焦点到添加工作区，跳过隐藏输入。连续四次切换后状态、焦点和高度正常。减弱动画由已有全局 CSS 规则与独立实现复核覆盖，未切换系统偏好模拟实测。

通过文件树打开 PassTimeline.tsx，源码产生 34 个高亮 token，原始文本保留；行号列与源码行高均为 20.4 px。窄栏内容可横滚，ArrowRight 后实测 scrollLeft 大于 0，行号左边缘仍与滚动区左边缘相同。深色关键词为 rgb(255,123,114)，浅色为 rgb(207,34,46)，见[深色](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Finput-preview%2Fdark.png)与[浅色](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Finput-preview%2Flight.png)。README 排版切到源码后也有高亮，其余样例语言与危险内容由定向检查覆盖。刷新后的浏览器未出现新的应用错误，读取到的 Vite WebSocket 错误属于服务停止时的旧记录。

## 限制

输入法组合与 229 键码由键盘回归分支覆盖，未操作系统中文输入法；动画最终观感待拥有者审阅。本轮未同步 Desktop，未提交、推送或发布。
