# Trace 工具详情验收

范围为可变 demo 与配套记录，分支 codex/desktop-demo-ui，基点 6afb20a，包含此前 demo 未提交改动。源码以本目录 source-hashes.json 对应的文件为准；不改正式 Desktop、后台、原始样例或两份冻结稿。

## 工程检查

2026-10-16 在 macOS／Node 24.15.0 执行 npm --prefix .scratch/desktop-shadcn/demo run check，通过类型、SSR、既有输入和右栏检查及 Vite 构建。新增 check-tool-activity 覆盖无思考装配、正常／失败摘要、Read 无子 trigger 和路径入口、失败 Read 直出、Edit／Write 增删、缺失与空差异、Bash 完整命令／结果／错误、HTML 转义、旧活动与默认收起；不把 SSR 记为动态验收。构建保留既有大于 500kB 的 chunk 提示，本轮产物约 656kB。

npm run check:static 的 lint、全部 workspace 类型、84 篇 notes 与 docs 门禁通过。之后工具消费者仅增加无断点换行类并恢复既有增删统计颜色，demo check 再次通过；独立审查增量核对这两处，无需扩大根门禁。git diff --check 通过。

## 浏览器实测

使用 Playwright CLI 的独立 Chromium，访问当前 127.0.0.1:5173，尺寸 1280×827、1280×600 与 833×827，实际点击、键盘操作与计算布局，未向真实后台发送命令或文件请求。工作脚本保存在临时目录，不作为正式测试入口。控制台只有既有 favicon.ico 404，没有应用异常。

主流 Read 路径打开右栏独立源码预览，重复点击只有一个标签，仍有语法高亮；链接不嵌套按钮。Edit 按 Enter 在流内展开已有 diff，含新增／删除，未切换右栏。切换 Tokyo 会话没有泄漏展开状态，返回主会话仍保留。子流使用同一组件，Check 展开原附注，Read 打开右栏文件，返回子 Agent 仍保留详情状态。

通过设置选择工具详情场景：父分组默认展开，Write 显示自己的两行新增内容；成功 Bash 默认收起，展开显示完整 pnpm --version 与 10.18.0；失败 Bash 展开显示完整命令和 ERR_PNPM_OUTDATED_LOCKFILE，错误行与普通行计算颜色不同；失败 Read 无子折叠，直接显示 ENOENT，路径仍可打开缺失文件的「文件不可用」提示。父分组关闭后保留 2 failed，重新打开仍保留调用详情状态。

窄栏首次测量发现 ERR_PNPM_OUTDATED_LOCKFILE 在官方 break-word 下仍因 grid 的最小内容宽度而溢出；消费者使用 data-wrap:wrap-anywhere 后，4 个可见代码块 clientWidth／scrollWidth 分别为 179／179、179／179、179／179、183／183，全部 pre-wrap，页面无横向溢出。明暗截图已目视检查；长错误可在流和块内滚动查看。

调用展开与收起实际触发 demo-expand／demo-collapse；收起时 inert 为 true，展开 0.18s，逐帧高度约 11→75px，测得多个中间高度。快速反向切换最终状态正确。系统 prefers-reduced-motion: reduce 时 animationName 为 none。上翻自由阅读时展开 diff 保持滚动位置，未新增滚动控制器。

静态截图只证明最终布局：tools-dark.png 展示工具详情与错误，default-diff.png 展示默认对话的就地差异，narrow-dark.png／narrow-light.png 展示窄栏明暗。动画与操作结论来自上述实测，不能由截图单独推出。

## 独立审查与限制

trace_tool_details_review 独立审查原始请求、附件、工单及代码，方案与实现均无阻断；亲跑最窄 checkToolActivity SSR 通过，并核对窄栏换行和统计颜色的最终增量。最终材料审查亲核 39 项哈希与磁盘一致，目视检查 4 张截图，并确认正式端、后台及冻结稿无变更；无阻断。

工程验收通过；产品外观与观感待拥有者审阅。这里是静态演示数据，不证明真实工具执行、错误产生、工作区文件读取或 Electron 行为；未同步 Desktop，未提交。
