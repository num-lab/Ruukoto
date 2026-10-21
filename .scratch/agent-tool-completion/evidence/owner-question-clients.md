# Coding 拥有者问题客户端验证

2026-10-21，实施副本 `/tmp/ruukoto-owner-question-clients`，macOS、Node 24.15；依赖复用当前检出的锁定安装，core/agent/control/runtime/view 按协作中的当前代码复制到副本，仅用于契约和客户端验证。

`test/owner-question-clients.test.ts` 五条通过：TUI 逐题自由文本及 q、取消丢答原键恢复，Desktop 无默认补齐、普通草稿隔离、回答丢答与双窗口唯一续接，以及取消丢答和重复点击。

`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/41-desktop-stream.test.ts`、`test/desktop-composer.test.ts`、`test/38-desktop-main.test.ts`、`test/desktop-terminal.test.ts` 的组合执行150条，首次146条通过、4条工作流失败。隔离副本缺少生成的 `worker/workflow-script.wasm`；运行 `npm run build:script` 后，按四个失败用例名称定向复跑全部通过，没有改动被测代码。该集合已逐条通过，不把首次执行记为全绿。

TUI 与 Desktop 的各自 `tsc --noEmit`、客户端定向 ESLint、`git diff --check` 及 `npm run check:docs` 通过。

[Python PTY 探针](owner-question-tui-pty.mts)使用真实终端、临时 Runtime 和 ControlServer、mock 模型，验证90×28窗口中的 `/questions`、逐题导航、含 q 的中文自由文本、单选加自由文本、完整回答唯一续接、显式取消无续接和退出后 alt screen 恢复。它复用 `test/15-tui-pty.test.ts` 的 Python 驱动，不访问日常档案。

Electron 真窗口、真实模型与双客户端实际断线体验由最终组合验收补齐；这里的替身双窗口/丢答检查不当作这些产品验收通过。

最终组合已补充真实模型、90×28终端长选项翻页、两个隐藏Electron客户端的实际输入/取消及扣答后真实socket断线恢复；原替身范围保持不变，具体环境、截图、夹具和限制见[实施验收](owner-question-acceptance.md)。

补充审查修复：客户端在当前会话快照、选择或问题窗口打开时查询最近一页，恢复快照预算省略的题目；旧页不跨会话安装，较新终态不会被旧待答页覆盖。新增最大完整题目/答案占满全局快照预算后另一会话待答恢复用例，及 Desktop main 在取消发送中或丢答断线时拦截另一窗口换键回答。丢答替身沿原键原参数返回已提交对象，允许核摘要的第二次 wire 请求，业务消费和续接仍各一次。
