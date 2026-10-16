# 独立 Harness 的档案、恢复与输入证据

Status: resolved

## 目标与边界

落实[总工单](01-migration-plan.md)阶段 1 中可独立验证的存储与恢复基础，对应[规格](../spec.md) A1/A8/A9 的部分约束。拥有者的完整方案确认及接手指令沿总工单生效，不改变验收标准。决策在[基础笔记](../../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md)。

本任务不切换正式入口，不连接真实 IM 或承接业务工作；引导式 CLI、本机认证接口、实际模型和完整阶段退出仍由总工单推进。新文件只在隔离目录调用；旧 Runtime、Task 表和 JSONL 不进入新 API。

## 方案

- `apps/ruukoto` 固定 Pi 1.3.0，保留 Coding 原依赖；直接 ESM 解析验证两代各自版本。
- 建立档案格式、文件权限、SQLite 实例锁与单一 Harness；调度前拒绝未知档案、业务/会话扩展版本和任务定义。
- provider 入口与 HTTP 请求体发送前记录输入，记录失败阻止发出；由 durable 承担输入去重、历史与崩溃恢复。
- 新增根窄测试，不修改旧测试夹具；同步产品、架构、开发测试映射及独立基础模块文档。

## 进展与交接

- 当前角色：实施者；基础实现、27 项窄检查、规定静态/构建检查与独立实现审查完成。父工单保持 in-progress，阶段 1 尚未退出。
- 当前内容：分支 `Eitrous/migrate-to-pi-durable`，基础改动已提交为 `6105c5a`，基点为 `498fc62`。下列快照与本任务验收对应该提交；后续本机引导管理对锁生命周期和配置解析的变更见[后续工单](03-local-cli.md)，原结论不单独证明新增契约。
- 下一角色：实施者继续总工单阶段 1 的 CLI/本机接口与入口接线；本窄任务工程验收通过。
- 阻塞与恢复条件：基础离线验收无环境阻塞；真实模型、IM、Linux 外部执行及正式切换不在本窄任务证据范围。

## 验收与证据

| 要求 | 作者证据 |
| --- | --- |
| 依赖分离与档案拒绝 | ESM 子进程核实个人 pi-ai 1.3.0 / Coding 0.85.1；旧目录指纹保持，链接、未知格式与锁冲突拒绝。 |
| 历史与幂等 | 真实 SQLite、HTTP/SSE 替身；输入/回答、同键去重、关闭重开后的上下文保留，并对实际请求体与 entry 逐项比较。 |
| 崩溃恢复 | 真实 Node 子进程确认 partial 正文已持久化后 SIGKILL；跨进程锁冲突、OS 释放锁、旧 partial 保留、同键恢复为一个输入和一个最终回答。模型为本地替身。 |
| 请求证据失败 | 三种实际 API adapter 各覆盖规范化输入和 payload 记录失败，6 个反例均零 HTTP；真实 Storage.commit 失败另测两处，Harness 关闭、零 HTTP、锁释放。 |
| 恢复拒绝与清理 | 缺扩展、业务版本、缺任务定义、未完成输入换模型拒绝；空闲模型切换和存储关闭失败后保留原错误并释放锁。 |
| 窄检查 | 作者在 macOS / Node 24.15.0 执行 `npx tsx --test test/personal-durable.test.ts`：27/27；重装依赖后复跑同样通过。 |
| 安装、构建与静态 | `npm run setup` 按两份锁文件重装成功；随后 `npm run build` 与 `npm run check:static` 通过，包含全部 workspace 类型、lint、笔记与文档门禁。README/架构预算内搬运已有重复说明，没有提高上限。 |
| 既有回归 | `npx tsx --test test/71-product-entry.test.ts test/81-subagent-reuse-close.test.ts test/122-workflow-code-acceptance.test.ts`：26/26。71/81 包含旧个人与共享装配，122 显式 Coding；不将这些结果声称为 durable 个人功能。 |
| 依赖风险核对 | 独立只读上下文比较 HEAD/current lock 与 `npm audit --json`：32 个新增 package 路径与 vulnerable nodes 无交集；根现有 12 项涉及的 lock 条目均未改变，foundation 锁未改。未修既有依赖或评估可利用性。 |
| 模型可见文本 | 新增隔离 API：systemPrompt 估算 0 → 47，toolSchemas 0 → 0（按仓库 chars/4 与 CJK 补足口径）；本地实际输入快照与请求证据覆盖个人提示，空工具集。该比较不代表旧个人完整 prompt 的迁移差额。 |

独立实现审查：2026-10-17，`durable_review` 只读上下文直接审查四个实现文件、测试与对应文档。亲跑基础测试在 macOS / Node 24.15.0 与精确 Node 22.19.0 各 25/25；最后新增的已知任务版本反例另跑受影响测试 3/3。隔离副本分别撤去缺扩展检查、模型更新与初始化锁释放，对应用例均失败，证明能够捕获回归。结论无未解决阻断；不覆盖真实模型、IM、Linux 执行与完整压缩链路。

方案审查沿总工单已经确认的要求；本任务无新增产品取舍。工程验收通过；产品验收不适用，本任务只增加未接入产品入口的基础 API，真实产品体验与必要平台证据留在总工单，阶段 1 不据此退出。

基础实现提交 `6105c5a` 的 SHA-256 快照（本任务正文只承载记录，不参与自指哈希）：

```text
f4266968ec480f657bee1a6043e69d07910134f09924ec43683aa0569b212ab4  apps/ruukoto/src/personal-error.ts
204b2dfaa7b0221c48b15511a7332403d025a8152bf53309529e06ad6b46078a  apps/ruukoto/src/personal-harness.ts
14ff042e9e71fa074fa4f16721ff4f7213d647c32791f759f6c2fa56f5a09078  apps/ruukoto/src/personal-model.ts
bea3cf497590be50ca282b66a6d55080a138253749bb5100e5a6387bc4545ba5  apps/ruukoto/src/personal-profile.ts
35295ae007d7c2bcb426b371a92566d4ce478efe0ff9482efbba3554cc0e2481  test/personal-durable.test.ts
9deeb4d52c1040c92ebb43cd34495dd51cc8772ced4535ac21cfc099a3731138  apps/ruukoto/package.json
b64f22573ce200c99c2022a1c0cd7802b9a18490915eaef4e46831d4012ab209  package-lock.json
c202705b02a1c44c93ee6fadaf0c07a5d70bc6395cb20947bb1515ceeb8331f9  docs/modules/personal-durable.md
80fe8086823139ae55a83bbf4695ff3bd4ed10bdebc0541e62535dd083e5f95c  .agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md
```

## Comments

2026-10-17：接续工作区未验收实现，修复任务字段误用、泛型类型错误、缺扩展被静默忽略、已有主会话模型未更新和初始化关闭失败可能漏锁的问题。增加请求关联键并保留原 onPayload 改写；不将基础通过记作 A1/A8/A9 整项通过。
