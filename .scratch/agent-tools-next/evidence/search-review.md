# search_tools 独立实现审查证据

日期：2026-10-25。审查者：fetch_path（独立于 search 实现上下文）。对象：主工作区 search-tools.ts、driver.ts 的 eligible/discoveredTools 与生命周期、host-tool-families.ts、plan-mode.ts、Runtime 装配、mock-mcp.ts 发现夹具及相关测试；基点 83f212ad 的未提交 search 改动。主工作区只读，未修改实现。

## 结论

没有未解决的实现阻断。搜索结果仅给名称与描述，下一实际模型请求含完整 schema；候选资格与激活集合分离，未发现伪调用不登记意图；Plan、固定能力与当前 MCP 配置仍约束调用。发现集合在新任务清空、同任务恢复保留，模型实际输入由现有 prompt 产物保存。

## 仓库测试

- `npx tsx --test test/search-tools.test.ts test/subagent-source-capabilities.test.ts`：17 项通过。
- `npx tsx --test test/24-mcp.test.ts test/25-mcp-write.test.ts`：49 项通过，覆盖审批、配置变更、参数与结果 schema、产物、图片、取消、崩溃与不重放。
- `npx tsx --test --test-name-pattern=冷启对话恢复 test/125-agent-wait-resource.test.ts`：首次发现选择记录仍期望 3、实际 4；作者修正断言后复验通过。
- search 测试当时实际 prompt 的 toolSchemas：10341 → 10458；systemPrompt：1505 → 1505。此为搜索专项夹具，不代表最终所有工具合并后的总量。

## 补充生命周期实验

通过 `node --import tsx --input-type=module` 使用当前主工作区的 testkit、MockModelServer、MockMcp 与 Code 产品装配执行三个临时实验，未改仓库测试文件。

1. 在正常主任务调用 search_tools 激活 mcp_review_get，另一个 mcp_review_hidden 保持未发现。注入等待适配器，调用真实 Driver.yieldWorkspace、释放当前目录占用，再由工具原接线调用真实 restoreWorkspace 重取目录并重建 MCP 连接。下次实际 provider 请求仍包含 get、不包含 hidden，真实 MCP tools/call 仅收到 get 一次：通过。
2. 在同样让出期间修改 mock 远端 get 的描述，使重新发现的 MCP 签名变化、触发真实 SDK 重建。继续同一任务后实际 provider 请求含新的工具描述，已发现 get 仍可调用、hidden 仍不暴露，真实 MCP 调用一次：通过。
3. 创建 tools=[mcp_review_get] 的固定子代理角色，父来源按现有 sourceTask 夹具登记 running，走真实 subagents.delegate 与 preflight。子任务实际 provider 请求没有 search_tools，但有明确要求的 MCP 定义，完成一次真实 mock MCP 调用并进入 completed：通过。

前三个实验的等待目标使用注入适配器，仅证明 Driver 让出/恢复、SDK 重建和发现集合的组合；不替代真正 SubAgent 或 workflow 的等待状态机验收。固定角色实验使用真实委派运行，远端服务为本机 mock。

## 未覆盖

未用真实模型或外部 MCP 服务；未重跑全仓检查。主工作区由作者继续汇总，其他工具和最终文档由各自审查覆盖。
