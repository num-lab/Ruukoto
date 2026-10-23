# 共享会话历史恢复验证

基点：`develop` / `3c4b9507`。环境：macOS arm64、Node 24.15.0。第一项模型配置提取已经提交；本记录只覆盖第二项相对基点的改动。

## 被验内容

[实现快照](07-implementation.patch) 收入全部 14 个产品源码、测试、夹具与文档文件，包含未跟踪的新文件；不包含本证据目录与工单，避免循环引用。[快照摘要](07-implementation.sha256) 和[文件摘要](07-files.sha256) 绑定最终内容，方案历史快照保持原样。

共同恢复对象持有窗口任务查询、任务详情与事件分页、UTF-8 正文分页、恢复代次、游标、在途去重及缺失正文事实。TUI 保留先显示历史及 48 KiB assistant 续读；Desktop 保留状态先行、合并重绘及 64 KiB 全角色续读。新快照同步淘汰旧成功、失败降级与收尾副作用。

## 检查与证据

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsx --test --test-concurrency=2 test/history-recovery.test.ts test/14-tui-app.test.ts test/41-desktop-stream.test.ts test/desktop-trace-hydration.test.ts test/desktop-tool-activity.test.ts test/66-control-seam.test.ts test/37-view-browser.test.ts test/36-event-flow-state.test.ts test/37-command-history.test.ts` | [127/127 通过](03-regression.txt)，无跳过；共享恢复、两端接线与各自显示顺序、控制面、投影、输入命令历史和无 Node VM 执行 |
| `npx tsx --test --test-concurrency=2 test/41-desktop-stream.test.ts test/desktop-trace-hydration.test.ts test/desktop-tool-activity.test.ts` | [33/33 通过](04-review-fixes.txt)，无跳过；复核去重归属返工，并新增客户端单条失败继续恢复用例 |
| `npm run check:static` | [退出码 0](05-static.txt)；lint、根/包类型检查、笔记、文档链接/源码引用/预算/段落形态 |
| `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` | [无悬空锚点](06-anchors.txt)；未引用旧笔记为软报告，不是本次新增错误 |
| `git diff --check` 与新文件末尾/行尾核对 | 通过；证据补丁按仓库既有 `.gitattributes` 不做补丁内容空白检查 |

127 项批次发生在 Desktop 去重返工及新增集成用例之前；之后只重跑受影响的 3 个桌面文件，共 33 项。两批有重叠，不相加作为独立用例数量。最终仅调整笔记与文档措辞后，另执行 `npm run verify-notes`、`npm run check:docs`，结果保存在 [最终文档门禁](08-final-docs.txt)。

负向验证：临时只撤掉 `list_tasks` 失败降级中的当前代次守卫，执行 `npx tsx --test --test-name-pattern=旧任务查询迟到失败 test/41-desktop-stream.test.ts`，两例都按预期失败；同实例的新正文被旧正文覆盖，跨实例出现旧会话。源码已恢复，失败日志见[反例](02-stale-failure-negative.txt)。正例验证当前代次查询失败时已读历史仍可见且错误可见。

## 独立审查

独立审查者 `/root/core_architecture` 直接读取计划、代码、调用方、测试与文档。初审要求去掉 Desktop 对 task/entry 的第二份在途去重，并补客户端单条失败后继续恢复的证据；两项已落实。初审亲验共享恢复、浏览器及三个桌面文件共 48/48；定向复审亲验 `npx tsx --test test/41-desktop-stream.test.ts` 14/14，确认无阻断。非阻断文案修正为分页错误经 `entryFailed` 通知，公共 `loadEntry` 不直接拒绝。

## 范围与限制

测试使用 FakeTransport、确定性事件、TUI 测试终端及无 Node VM；没有执行真实 Electron/MyGo 界面或真实模型验收，也未运行全量 `npm run check`、Linux/Node 22 矩阵或桌面制品构建。本次未改协议、schema、存储、依赖、构建入口、图形样式或按键行为，因此以计划确定的最小逻辑回归与静态检查验收。产品显示策略保持既有行为，无新增主观体验取舍；这些结果不代表真实壳体验已验收。

TUI app 从 3504 行到 3425 行，Desktop CodeState 从 453 行到 389 行，新共享模块 143 行；三处产品源码总行数持平，收益是恢复规则集中及失效请求隔离，不宣称总行数减少或性能提升。
