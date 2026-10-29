# 消息引导 SDK 门槛核实

日期：2026-10-29（Asia/Tokyo）。接手基点为 `5c55e96b5de38f068eabb0aa58b7885e9e085781`，初始工作树干净；环境为 macOS、Node 24.15.0、npm 11.12.1，锁定的 `@earendil-works/pi-agent-core`、`pi-coding-agent`、`pi-ai` 均为 1.3.0。

## 结论与影响

[工单](../issues/01-queue-and-guidance.md)步骤 1 的元数据、all 批次及未取出输入清理契约成立；裸清理不能覆盖已取出未落历史的窗口，已经补成边界预留、同步停止守卫与磁盘核实后丢弃 SDK 的修订方案。修订经独立复审无剩余阻断，实施者已恢复步骤 2。本篇只记录 SDK 门槛，后续产品实现与检查由工单持有；没有提交、推送或操作运行实例。

公开队列为空不代表所有引导已落历史或已撤回。若按现方案取消源 Task 或先回退到普通队首，再清 SDK 队列，已取出的输入仍可能写入目标 JSONL，造成取消与历史归属冲突，或同一源输入既在目标历史又独立执行。目标中止也不能消除这个窗口。不能通过正文匹配、私有字段、vendor 修改、删除历史或提前记录“已接入”规避。

## 作者实测

定向入口为根目录 `test/sdk-steering-contract.test.ts`：

```sh
npx tsx --test test/sdk-steering-contract.test.ts
```

用例覆盖 SDK 契约与写失败限制。测试复用真实 `createSdkSession` 和宿主扩展装配、现有 `startAssemblyKit`、本地 `MockModelServer` 与临时磁盘 JSONL，不启动 Runtime、工具 worker、桌面或 TUI，不读用户模型凭据。根类型库是 ES2023，测试用既有 Promise 解析器写法，不为 Node 已支持的 `Promise.withResolvers` 提高全仓配置。

| 检查 | 实测事实 | 证明范围 |
| --- | --- | --- |
| 同文源身份、附件与 all | 两条正文相同但源 Task ID／附件引用不同的 user，在下一次请求一起出现；SDK 内存与 JSONL 各保留两条 | 元数据可按源 ID 关联，不必正文匹配；仅验证附件元数据保存，不验证真实附件读取或权限 |
| 通知与落盘 | user `message_end` 回调时该源 entry 尚未出现在 JSONL；模型发送函数开始时两条均已出现 | 监听通知不能充当落盘证明；JSONL 实际可重建源输入，不涉及 fsync 或崩溃保证 |
| 中止未取出消息 | 模型请求挂起期间排入的 steer，在 `sdk.abort()` 后仍可由公开 peek 查到；显式清理后下一次 prompt 无该源 | abort 不自带清队列，公开清理对仍在队列中的消息有效 |
| 已取出窗口 | SDK 进入异步下一轮准备时，公开 queue／peek 均为空，JSONL 尚无该源；此时 `clearQueue` 或 `abort + clearQueue` 后，源 user 仍写入 JSONL | 两种通过结果是限制的反例，不是产品取消／回退验收通过 |

窗口用例只包裹公开 `sdk.agent.prepareNextTurnWithContext`，用 Promise 固定现有异步窗口，再调用公开查询、清理和中止接口。未访问私有 steeringQueue／pendingMessages，也未修改 SDK。它不模拟产品取消事务，而是证明产品不能仅凭公开清队列保证未落历史输入已撤回。

## 修订方法与复现实证

引导先保留在宿主持久路由，轮末决定继续时同步预留首批源 ID 为内存批次。取消先完成时源被排除且不增加请求；批次先预留时取消等待实际历史。原 SDK 下一轮准备结束后，再将准备期间收到、尚未取消的源一起选入并 `agent.steer`，`prepareRequest` 按实际历史核实该批结果。两条用例分别证明取消先赢只发原请求，以及预留先赢时取消等待、迟到源同批进入、迟到取消源不进入。

停止守卫放在公开 `sdk.subscribe` 的同步源 user start／end 监听；已停止时抛错，SDK 将 run 收束为中止，并在 append 前阻止该源。三个磁盘用例固定下一轮 start、第一源 start 后和第一源 end 后的停止窗口：只有最后一种保留已落盘的第一源，均没有第二次模型请求。这里全部 append 成功，公开 `refreshContext()` 可清除 Agent 中的幽灵 user；此结论仅限 SessionManager 与磁盘一致的正常停止。

新增写失败反例在临时目录用目录占用原 JSONL 路径，真实 append 抛错；恢复原文件后磁盘字节未变，但 `refreshContext()` 仍保留 manager 中的未落源。公开 `SessionManager.open` 重读原文件后没有该源且不修改字节。因此正式接线在 run 收束、磁盘核实后直接丢弃旧 SDK／manager，必要收尾和下一任务从原文件重新打开；核实失败暂停，不向污染 manager 追加标记。

正式接线仍须使用带 code 的停止错误、尊重原轮末 end／错误／停止结果，在成功与失败收束时解除批次等待，逐条保留实际 entry。用例中的 pending／joining 只验证 SDK 接线时序，不能替代尚未实现的 SQL 路由、审批屏障和崩溃恢复。

## 源码依据

以下行号对应当前锁定版本，升级 SDK 后须重查：

- `pi-agent-core/dist/agent-loop.js:186` 在轮末取出消息为局部 `pendingMessages`；`:93` 随后等待下一轮准备，`:116`–`:120` 仍发出并追加该批 user，没有在这之前复查清理或中止。
- `pi-coding-agent/dist/core/agent-session.js:540` 为真实 AgentSession 默认安装异步下一轮准备；生产装配也经过此接口，并非只在测试自造异步。
- `pi-coding-agent/dist/core/agent-session.js:753` 先向公开监听者通知，`:768` 才调用 `SessionManager.appendMessage`。
- `pi-coding-agent/dist/core/extensions/runner.js:868`–`:898` 的 `message_end` 扩展只允许同 role 替换，异常仅报告；没有可用于撤销该 user 的公开返回结果。上下文过滤发生在消息追加之后，不能替代接入前取消。

## 独立核实与检查

只读代理 `/root/sdk_contract_audit` 独立读取规格、工单、SDK 与 Driver，并亲跑原生 Agent 断言和真实 AgentSession／内存 SessionManager 反例，核实同文 ID、all、附件 JSON 序列化、通知时序及 clear／abort 窗口，结论与磁盘用例一致。它的内存实验不计作 JSONL 或真实模型证据。

`/root/runtime_scope` 只读检索全部现有队列入口、严格 schema 版本门、submit 来源、审批、等待、收尾和恢复，未发现 SDK 之外的新前提阻断。它没有执行产品测试；发现的旧 wait 回归和权威 sessionFile 补找时序留给后续实施，不扩成本轮产品改动。

`/root/runtime_scope` 对初版 4 条门槛用例和退回 planning 的交接做了独立文件审查，亲跑两次窄测试与 `git diff --check`，无阻断。`/root/guidance_window_design` 随后独立核对修订候选并亲跑真实 AgentSession／内存 SessionManager 的取消与三个停止窗口，确认同步守卫可阻断 append、部分接入与刷新成立；这些内存实验不冒充磁盘产品验收。

`/root/runtime_scope` 对 9 条用例及修订方案亲跑并审查，指出 `refreshContext` 不重读 JSONL 的阻断；按磁盘核实、丢弃污染 manager 的方法修订并加第 10 条反例后，限定复审通过。审查者亲跑当前 10 条全部通过、无跳过，`git diff --check` 通过；正式实现的静态检查另按实际改动面执行。

## 恢复条件与未覆盖项

下一责任角色为实施者：已恢复步骤 2，正式接线仍须证明回退源不会同时留在目标历史，不能只新增“SDK clear 被调用”的断言。

本轮没有产品工程验收、真实模型、真实工具批次、审批、macOS／Linux 原生停止、双客户端或主观体验验收；当前反例已经足以否定清理前提，不能把这些缺口记作通过。新 proposed 仍是提案，不转 implemented。
