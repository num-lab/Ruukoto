# 个人 Agent 的 pi durable 迁移方案与交接

Status: ready-for-agent

## 目标与边界

有效要求在[规格](../spec.md)，取舍依据在[决策提案](../../../.agents/notes/proposed/architecture/2026-10-17-personal-pi-durable.md)。拥有者已确认 Q1–Q18 产品取舍，并在 Q19 确认完整方案；本工单交付方案与实施入口，本轮不开始实现或部署。

## 方案

| 阶段 | 工作与影响面 | 阶段退出证据 |
| --- | --- | --- |
| 1. 个人执行入口 | 在 `apps/ruukoto` 引入独立 Pi 1.3.0 依赖与 Harness、SQLite、实例锁、引导式 CLI/最小本机管理接口；调整 app bin/main/dev 和实际构建/打包依赖，脱离共享 Runtime/CLI 装配 | 最小真实模型往返与进程重启；新旧 Pi 独立解析；个人不会打开旧数据；Coding 入口回归。 |
| 2. 权限与外部执行 | 将现有可复用的隔离 launcher、MCP client、凭据校验、OneBot transport、service helper 接到 durable 工具；重建个人审批、长期授权、操作证据和未知效果暂停 | A5/A6/A9 的窄用例及 Linux 真执行，含停止未核实；提取共享实现后同步 Coding 调用方回归。 |
| 3. 主会话与后台工作 | 实现 QQ/TG 入口、持久收件与回报、长期子 Agent 索引、单工作占用、durable 委派与取消连接 | A2/A3/A10，特别是模型不能绕过未知操作暂停及取消/复用竞态；真实 IM 与模型链路。 |
| 4. 个人业务与配置 | 接入定时任务、持久记忆、独立应用数据、技能/MCP与通用工具，补齐全部配置和管理入口 | A4/A7/A8/A11；保留能力清单与旧个人工具逐项核对，退出能力从新入口移除。 |
| 5. 拆分收尾与交接 | 清理仅供旧个人装配的代码/测试/依赖，保留 Coding 与历史仍需的部分；同步文档；隔离演练停机、归档、接管与回退 | A1/A12 及完整验收矩阵；独立实现审查无阻断，再安排拥有者产品验收与正式切换。 |

阶段只是提交与验收的组织方式，不允许只交付前几阶段就正式替换个人产品。每阶段根据实际接口形成窄实施任务；不提前创建空工单或通用框架。若框架原语无法满足已确认安全与生命周期要求，先修订技术方案并复审，不降低验收要求。

### 可复用与需重装的实现

- `packages/channels/src/qq/onebot.ts` 是独立 transport，可复用；QQ/Telegram adapter 绑定旧 Store/SchedulerStore，不直接搬入。Telegram HTTP 传输按实际需要局部提取。
- `packages/agent/src/execution/` 的 launcher 与真实停止核实可拆用，但当前 worker 入口和运行依赖有固定假设；为 durable 配置新的执行适配，不带回旧 ToolRouter/Driver。
- `packages/agent/src/mcp/client.ts` 与凭据校验可复用，旧 MCP 工具计划/产物/审批装配需替换。
- `packages/agent/src/app-data/store.ts` 与查询模块持有独立 SQLite 和操作回执，可复用；旧工具入口和核心 MemoryStore 不能直接复用。
- `deploy/systemd/ruukoto-service.mjs` 保留协议；`apps/ruukoto/src/service-tools.ts` 改为新执行引用与授权装配。
- 所有复用经包名和 exports；提取位置按真实依赖决定，不创建与七个旧共享包一一对应的新包。新的执行身份使用具名类型，不拿旧 Task 类型伪装 durable Task。

### 调用方、文档与验证落点

实现须核对 app 入口/开发启动器、根 scripts 和锁文件、打包与 worker 解析、共享底层 exports、两产品测试夹具、部署单元与 helper。旧 channels 的归档分类和 Coding 恢复仍有调用方，不整包删除；旧工作流与 TUI/desktop 的 Code 路径保留。

同批同步 `CONTEXT.md`、`docs/architecture.md`、`docs/modules/products.md` 及实际改变的 runtime/core/agent-context/agent-tools/execution/channels/scheduler/deploy/tui/desktop 文档。旧底座文档明确适用 Coding/归档，新个人实现给独立模块落点。命令与安装变化同步 `README.md`、`docs/development.md`、`docs/usage.md` 和 pre-push-checks；本方案阶段不提前把当前文档改成尚未实现的状态。

执行回归按实际改动选择，起点包括 `test/71-product-entry.test.ts`、`test/122-workflow-code-acceptance.test.ts`、`test/81-subagent-reuse-close.test.ts` 与共享原生执行/审批/MCP/应用数据用例。新个人场景需要独立窄测试，不能改旧测试使其失去 Coding 覆盖。Linux 验证使用 `ssh tx`，真实模型与 IM 使用隔离数据及专用测试目标。

## 进展与交接

- 当前角色：方案者。产品决策已确认，官方 v1.3.0 接口、宿主边界与旧数据交接风险已核查；当前只写方案材料。
- 分支：`Eitrous/migrate-to-pi-durable`；基点与当前 HEAD：`ddb7afaed0733057dc0b3bcd1c42901b9619ca13`。方案是未提交工作区文件，不能用 HEAD 代表被审内容。
- 定稿快照：规格 SHA-256 `06ff31f86b60643b9038aa632f82b7d3d863a9601b22e136be37b06858aa468f`；决策提案 SHA-256 `d52d5d3c30b3e132d85d61ed3e928a414dc0ad06638488c0a71bd741714ce5bd`。审查后仅澄清测试档案措辞并更新确认状态；未提交互链改动为七篇旧笔记各增加一段提案引用。
- 下一角色：实施者。独立方案审查已直接对照 Q1–Q18、源码与上游 v1.3.0，无未解决阻断；Q19 已确认完整共同理解，取得后续实施指令后按阶段细化并推进。
- 实施启动条件：完整方案已确认，独立方案审查无阻断，并取得继续实施的指令。实际部署另需拥有者安排，不由方案确认自动授予。

## 验收与证据

| 对象 | 当前证据与结论 |
| --- | --- |
| 需求 | Q1–Q18 逐轮回答已归入规格确认表；Q19 已确认完整方案并结束访谈。 |
| 上游能力 | 官方 v1.3.0 与 main 对照；主要恢复、inbox、子 Agent 示例、SQLite 和 Code Mode 已在 1.3.0。只有源码证据，未安装或运行上游测试。 |
| 现有工程边界 | 两次只读调查核实产品装配、恢复、导入限制、可复用传输/隔离/MCP/应用数据及旧归档读取风险。 |
| 方案文档检查 | 作者执行 `npm run check:static` 通过。审查修正后，审查者亲自执行 `npm run verify-notes`、`npm run check:docs`、`git diff --check` 全部通过；没有运行时实现，不执行模型或平台操作。 |
| 独立方案审查 | 2026-10-17，独立只读审查上下文 `plan_review`，审查工作区内规格、提案、工单及互链变动，并直接查源码与上游。回退旧库积压问题已修正并复核；输入证据失败拦截已补充。结论无未解决阻断。当前后续修改仅澄清 Coding 测试档案措辞与记录状态，不改变审查范围。 |
| 工程验收 | A1–A12 全部待实施验证。 |
| 产品验收 | 待实现后按 Q18 场景和 IM/CLI 实际操作验收，不能由文档审查替代。 |

## Comments

2026-10-17：grilling 访谈完成 Q1–Q18。拥有者否决单一权限模式、一次性子 Agent 和先决定是否采用的选型门槛；本方案分别保留三模式、长期复用及既定选型。选择新实例空白、旧资料归档与短暂停机，避免引入历史格式和在途工作迁移。

2026-10-17：独立方案审查发现仅重设平台水位不能阻止旧库 registered 入站、pending 通知及计划恢复。修正为代码回退也使用空白档案；A12 增加库内积压反例。另明确 `beforeRequest` 普通 throw 不保证阻止 provider 请求，A8 以输入记录失败时请求计数为零验收。审查者复核修正并通过最小文档检查。

2026-10-17：拥有者在 Q19 回答“确认方案，结束访谈”。方案定稿，进入可交接实施状态；本轮未安装新版依赖、改运行时代码或执行部署。
