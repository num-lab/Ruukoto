Status: resolved

# 精简重复测试与复制的测试设施

## 目标与验收

审查 `test/` 与 `verification/foundation/`，减少重复行为检查和复制的测试设施。
删除用例须有明确的保留覆盖；权限、资料隔离、迁移、取消、幂等与效果未知边界继续保留。
完成项目及基础验证的类型检查和离线测试。

## 实现与覆盖对应

- `26-qq` 的错误 token、错误登录账号和重连用例使用已永久忽略的群消息，移除后由 `40-qq-private` 的有效拥有者私聊验证接收边界；接收缺口断言移入该用例，并限制为本次断线后的事件。
- `26-qq` 与 `59-system-prompt` 的群消息零新增检查合并到 `85-retire-core-group-chat` 验收1；第二群、发送账本、状态视图和未登记撤回检查保留。
- `27-orchestration` 的旧五键摘要兼容由 `10-access-modes` 的新旧摘要综合检查覆盖；输入异参冲突断言移入该用例。
- `57-todo-list` 的角色工具装配检查移入 `56-skills` 已有的 main / 普通开发会话真实任务循环。
- `61-context-compaction` 的重复压缩视图确定性检查移入已有 100 次调用压力用例；已有非空摘要用例也检查相同输入稳定及新增消息保持前缀。
- `69-session-summaries` 的组织归属检查由 `76-legacy-workspace-data` 的完整控制面查询覆盖；原资料身份、工作区归属、摘要名称与活跃时间断言保留。
- `75-workspace-settings` 的跨项目设置隔离检查由同文件的工作区并存用例覆盖，继续核对指令、Web Search、版本和设置事件。
- `33-config-tui` 复用现有 `FakeTerminal`；括号粘贴仍以整段输入送达。
- 11 个测试文件复用 `testkit` 中的模型请求读取函数，解析逻辑保持一致。
- 基础验证复用 `test/helpers/mock-provider.ts`，删除复制的模型服务；README 明确要求从完整仓库运行。

共删除 10 个重复顶层用例，测试代码净减少 628 行。默认调度器启动、工具发送前阻断和效果分类等独立行为用例经复核保留。

## 验证

2026-10-08，本机 macOS / Node v24.15.0：

- 修改前 `npm test`：1007 通过、0 失败、1 跳过；修改后：997 通过、0 失败、1 跳过。
- 根目录 `npm run typecheck`：通过。
- `verification/foundation` 的 `npm run typecheck` 与 `npm test`：通过；9 项通过、0 失败、1 项真实模型连通性跳过。
- 摘要视图断言补充后的 `test/61-context-compaction.test.ts`：22 项通过。
- `git diff --check`：通过。

未重新运行真实模型、Docker 或 Linux 服务器探针；本轮改动仅涉及测试及对应文档。
