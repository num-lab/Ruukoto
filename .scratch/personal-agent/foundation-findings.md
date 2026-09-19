# 阶段 0 基础验证结论（issue 01）

核实日期：2026-09-19。验证代码与测试见 [verification/foundation](../../verification/foundation/README.md)，
全部离线测试用 mock 模型（本地 OpenAI 兼容服务）驱动，不依赖真实凭据；
真实模型只做一次连通性检查。

## 固定版本

| 组件 | 版本 | 依据 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `0.85.1`（dist-tag latest，2026-09-05 发布） | npm 实际发布包；包内含 npm-shrinkwrap，上游依赖树被锁定 |
| `@earendil-works/pi-agent-core` / `pi-ai` / `pi-tui` | `0.85.1` | 与 coding-agent 同批发布，随依赖引入 |
| `typebox` | `1.0.12` | pi 工具参数 schema 的同款库 |
| 运行时 | Node.js ≥ 22.19（engines）；验证于 24.15.0 | 建议目标服务器装 Node 24 LTS |
| 验证工具链 | typescript 5.9.3 / tsx 4.23.13 / @types/node 24.13.6 | 仅验证工程使用 |

## 交互与通信选型

- **TUI 库**：`@earendil-works/pi-tui` 0.85.1（pi 交互模式自用的差分渲染
  TUI 库，随 pi-coding-agent 同版本发布）。04 号工单的 TUI 基于它构建，
  不另选 Ink/React 等第三方库。
- **本机通信**：宿主与任务同进程时直接用 SDK；跨进程（含未来把任务进程
  放进受限环境）用 `pi --mode rpc` 的 JSONL over stdio（测试 06 已验证，
  注意协议要求仅按 `\n` 分帧、不能用 Node readline）。控制面（审批状态、
  任务管理）只绑 unix socket / 127.0.0.1，不对容器暴露。
- **远程会话**（pi-protocol CBOR / pi-client / pi-server）：当前无此需求，
  不选型。

## 复用层级：coding-agent SDK（已验证）

按工单要求优先验证 coding-agent SDK，全部已知需求命中公开 API，**无需**
降到 AgentHarness / agent-core 重写循环：

| 已确认需求 | 公开 API | 验证 |
| --- | --- | --- |
| 关闭自动压缩 | `SettingsManager.inMemory({ compaction: { enabled: false } })` | 测试 01：阈值触发被禁用，磁盘无 compaction 条目 |
| 阻止非预期摘要 | 扩展 `session_before_compact` 返回 `{ cancel: true }` | 测试 01：压缩尝试被拦截，历史原文不动 |
| 完整历史持久化 | JSONL 会话文件（v3 树结构）+ `SessionManager` 全量 API | 测试 01/02：磁盘始终保留全部原文，append-only |
| 每轮选取模型输入 | 扩展 `context` 事件（非破坏，实测过滤后历史不变） | 测试 02：模型只收到选取后的消息，磁盘/进程内历史完整 |
| 注册自定义工具 | `createAgentSession({ customTools })` / `defineTool` / `pi.registerTool` | 测试 03：执行、toolCall/toolResult 合法配对、结果回传模型 |
| 基础工具直接复用 | 内置 `bash` 等工具原样可用；`createBashTool` 系列工厂 + 自定义 `BashOperations` 可替换执行层 | 测试 03：内置 bash 真实执行 `echo`、输出回传模型；Operations 替换缝隙仅从类型面确认，未做容器路由实测 |
| 后台驱动多会话+事件 | 同进程多 `createAgentSession`；`session.subscribe()` 事件流 | 测试 04：并行执行、事件独立、状态/文件互不串用 |
| 跨进程驱动（已验证可用） | `pi --mode rpc`（JSONL over stdio）+ `RpcClient` | 测试 06：prompt 命令、事件流还原回复 |
| 真实模型连通 | `ModelRuntime.create()` + 用户凭据 | 测试 07：2026-09-19 验证会话中以 deepseek-v4-flash 一次往返成功；测试默认跳过，凭 `RUN_MODEL_CHECK=1 npm run test:model` 复现，仓库不保留运行输出 |

持久化结论：**pi 的 JSONL 会话文件就是权威历史的唯一副本**。宿主的索引、
检索（阶段 2）读取这份文件，不重复存储同一份历史。
`pi-session-backend-sqlite-node` 属 agent-core 的另一套会话层（API 不同），
本方案不采用。`SessionManager.inMemory(cwd, { id }, entries)` 支持从外部
数据源恢复会话，是后续把历史迁入自有后端的预留口。

## 可信插件扩展点清单（测试 05 已验证）

- **上下文**：`context` 事件（逐轮消息选取）；`systemPromptOverride`；
  `before_provider_request`（载荷级改写，仅调试用）。
- **记忆/数据**：`pi.appendEntry`（custom 条目持久化、不进模型上下文）；
  `ctx.sessionManager`（历史查询，host_history 工具示例）；
  `custom_message` 条目（进上下文的插件注入）。
- **工具**：`customTools` / `pi.registerTool`；`tool_call` 可阻断
  （权限实施点，03 号工单复用）；`tool_result` 可改写。
- **生命周期**：每轮 `before_agent_start` / `agent_start` / `agent_end` /
  `agent_settled` 可靠派发（测试 05 断言）；`session_start` /
  `session_shutdown` 在 SDK 路径下未观察到派发（调试探针实测，未纳入自动
  断言；两者是 CLI 交互模式事件）——会话级生命周期由宿主自行维护，不依赖
  上游事件。
- **宿主维护的不变量**（不可交给插件）：会话进程唯一写者（同一会话单写，
  sqlite backend 文档同款约束）；压缩策略（enabled:false + cancel hook）；
  权限实施点（tool_call 拦截只是进程内一层，OS 边界见下）；数据访问范围
  在读取层过滤。

## 权限边界与 Linux 受限执行

上游明确**无内置沙箱**（security.md：真实隔离必须来自 OS/容器/VM 边界），
与 ADR 0003 的技术约束要求一致。SDK 导出 `createBashTool` 等工具工厂并
接受自定义 `BashOperations` 等执行层——这是把工具执行路由进受限环境的
官方缝隙（上游 Gondolin 示例即此模式）。

**选定方案（满足已知要求，不做多后端抽象）**：请求确认模式的任务命令在
Linux 容器内执行（per-session 容器：只挂工作区、无宿主凭据、
`--network none` 或按需最小网络、非 root、cap-drop ALL、no-new-privileges）；
完全访问模式 = 不进容器，直接使用运行账户权限（不额外授权）。

**控制面身份模型**（ADR 0003"两种模式的项目命令均不得冒充拥有者、修改
宿主授权状态"的落地方案）：后台控制面由独立系统用户（如 `ruukoto-backend`）
运行并持有 0600 的授权状态与会话数据；请求确认任务在容器内运行（无宿主
身份）；完全访问任务以拥有者账户运行——它与控制面系统用户是不同 uid，
内核文件权限拒绝其改写授权状态（identity 探针验证的正是这一边界）。
推论：**控制面与拥有者共用同一账户的部署不满足此不变量**，部署时必须
创建独立系统用户运行控制面，否则按 ADR 0003 该部署只能降级声明。

容器探针结果（31/31 一致，详见
[linux-isolation-report.md](../../verification/foundation/results/linux-isolation-report.md)）：

- 文件：工作区可写；`/Users`、`/root/.pi`、宿主控制面路径不可见；
  非 root 时工作区外写入被拒
- 子进程：可正常 spawn；mount 被拒；cap-drop 后 CapEff=0
- 网络：`--network none` 下外网不可达
- 凭据：环境变量无凭据、无 `~/.pi`
- 控制面：宿主回环监听端口从容器经回环与网关两条路径均不可达
- 系统身份：root 持有的 0600 控制面状态文件，任务 uid 读写均被内核拒绝
  ——支持"控制面与任务执行账户分开"的 ADR 0003 不变量

## 未验证项（诚实清单）

1. **目标 Linux 服务器的宿主前提**：本验证在 macOS 的 Docker Desktop
   （Linux VM，linuxkit 6.12.76 / Debian 13）完成，验证的是容器边界本身。
   目标服务器的发行版、内核版本、rootless 运行时（podman/docker-rootless）、
   user namespace 与 sysctl 配置未验证。部署时需按上述清单在目标机重跑
   `npm run linux:probes`。
2. **上下文超限行为**：压缩禁用后若上下文溢出，pi 会走 overflow 恢复
   （`summarization_retry_scheduled` 等），cancel hook 可拦截（已验证拦截
   通路），但"预算耗尽明确暂停"的完整宿主行为未在真实超限场景实测——
   归入 02 号工单。
3. **替代隔离机制**：Landlock、bubblewrap、systemd 沙箱、Gondolin
   micro-VM、OpenShell、Docker Sandboxes（sbx 凭据代理）未验证——容器方案
   已满足已知要求；若目标服务器不支持容器，再回来评估。
4. **真实模型**仅连通性检查（一次短往返），未跑编码任务质量，符合工单
   "不以生成代码的成功率设置产品门槛"。
5. **RPC 长连接语义**（断开重连、事件补偿）未深测，归入 04 号工单。
6. **多机/远程会话**（pi-protocol CBOR、pi-server）未验证，当前无此需求。

## 备忘

- `createAgentSession()` 无 `extensionFactories` 选项，传入会被静默忽略；
  inline 扩展必须走 `DefaultResourceLoader`。这类静默忽略要求宿主集成时
  用类型检查 + 启动诊断兜底。
- `ModelRuntime.create()` 默认读用户 `~/.pi/agent`（auth/models/models-store）；
  宿主必须显式传 `authPath` / `modelsPath` / `modelsStore` 实现封闭与
  凭据面收窄。
- 会话文件惰性创建：首次写入前 `session.sessionFile === undefined`。

复用层级与持久化结论供 02 号工单直接使用；权限实施细节（tool_call 拦截 +
容器参数）供 03 号工单展开。正式 ADR（如"容器为受限执行边界"）在 02/03
确认运行时形态后按 domain-modeling 流程补记。
