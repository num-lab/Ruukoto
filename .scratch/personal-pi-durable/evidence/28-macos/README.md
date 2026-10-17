# 个人 durable MCP 工程证据

环境：macOS、Node 24.15.0，接手基点 `d517550`。全部模型请求使用本机替身，MCP/Telegram 使用回环 HTTP/SSE；SIGKILL 是实际子进程强杀。没有专用真实 MCP 服务，真实模型、IM 与操作者产品体验未验。代码指纹见 [source.sha256](source.sha256)，日志指纹见 [logs.sha256](logs.sha256)。

## 检查

| 材料 | 命令与结果 |
| --- | --- |
| [首轮 MCP 与旧调用方](mcp-tests.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-mcp.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-config.test.ts test/mcp-transport.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/71-product-entry.test.ts`，119/119，约 98 秒；后续增加取消、别名和损坏负例，原个人 MCP 子集由下面的最终日志取代。 |
| [最终个人 MCP](mcp-final.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-mcp.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-config.test.ts`，36/36，约 8 秒；含端点查询别名、观察反链缺失、参数损坏与伪批准拒绝。 |
| [控制入口最后增量](controls-final.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-mcp-controls.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`，72/72；新增未配置 MCP 收到 `/MCP` 后不给无效菜单、重开仍成功的回归。 |
| [原 SSE 迟到与取消](mcp-recovery.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-mcp-recovery.test.ts`，4/4；跨重开只 GET 原结果流，成功、isError、error.data 和实际取消均保持原 tools/call 计数 1，原报告恢复或取消收尾后才复用身份。 |
| [已有 durable 工作与报告](base-tests.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-mcp-config.test.ts test/personal-durable.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-reports.test.ts`，107/107。 |
| [其余个人调用方](personal-regressions.log) | `RUN_MODEL_CHECK=0 npx tsx --test test/personal-command-work.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-delegations.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`，326 项中 325 通过、1 跳过；跳过为 Linux sudo HTTP 接线，由 [Linux 材料](../28-linux/README.md)的 1/1 补验。 |
| [构建](build-final.log) | `npm run build` 通过；个人与 Coding 制品均构建，`build.log` 保留首轮。未装配菜单守卫收口后追加 `npm run build --workspace=ruukoto`，见[最后个人制品](personal-package-final.log)。 |
| [最终静态](static-final.log) | `npm run check:static` 通过，含 lint、全部类型、笔记、链接、引用、预算和段落。 |
| [说明收口](docs-final.log) | `npm run check:docs` 对后续产品/工具模块事实同步通过。 |

各组包含重复用例，不相加声称唯一用例数。`static.log` 保留最初 JSON/SDK 类型不符，`static-final.log` 取代它；中间文档预算超限修正后通过，没有提高预算。`mcp-incremental.log` 是追加取消及端点反例阶段，最终由 `mcp-final.log` 取代。

## 独立审查

独立上下文 `mcp_independent_review` 直接读取工单、规格、规范、当前实现和证据，亲跑 transport 29/29、端点别名及三类损坏 4/4，并独立启动实际回环 SSE 服务验证 timeout→GET 原终结应答，原调用计数 1。其复现的两个阻断已修正并复验：端点字符串别名绕过占用，未知记录删除观察指针仍能恢复。观察、批准与效果核实现在双向审计；当前范围无未解决阻断。完整审查摘要见 [review.md](review.md)。

独立 transport 实施上下文另亲跑 transport/旧 `24-mcp`/`25-mcp-write`/产品入口组合 88/88，静态和构建通过；其最新传输测试补了空恢复凭据零 GET 断言，原始材料见 [transport-author.log](transport-author.log)。此记录是作者检查，不代替上述独立实现审查。

## 请求证据与限制

实际替身 provider 捕获的主/子工具定义、原结果与持久记录一致。按字符串长度除以 4 向上取整的估算：主会话 systemPrompt 51→51、toolSchemas 521→864；子会话 systemPrompt 38→38、toolSchemas 1→344。这是本 fixture 的估算，不声称真实模型 token 使用量。

强杀发生在远端结果已到达、本地 observation 提交前；恢复保持原工具、admission 和外调计数，工作及报告暂停，独立工作可继续。人工业务效果说明不能设置远端结束，URL 查询别名也不能取得另一份端点执行权。没有原 session/protocol/SSE 游标或服务不支持恢复时，保守保留未知与占用。

未跑全仓 `npm run check`、完整 Coding 122 矩阵、真实服务或生产切换。Linux 另以隔离副本完成原四 MCP 文件 40/40 与专属服务 HTTP 1/1；完整 Linux setup 因 ENOSPC 未成功，仅使用本次实际解出的依赖运行定向验证。真实模型/IM、拥有者实际操作分别留证，不能由本机回环或源码审查代替。
