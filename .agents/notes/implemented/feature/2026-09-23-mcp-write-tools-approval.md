# Agent Note: MCP 写工具：统一审批与单次消费

Status: implemented

相关未实施方案：[桌面设置管理](../../proposed/feature/2026-10-21-desktop-settings-management.md)提供配置入口，保留本篇允许列表、批准消费与未知效果规则。

[Cua 接入提案](../../proposed/architecture/2026-10-22-cua-integration.md)拟新增响应未完整读取的失败分类，并在电脑桥接下按原下游终结证据解释网关错误；权限与批准规则复用，实施前仍沿本篇现行结果定性。

原编号：ADR 0008

## 问题

[MCP 客户端](../architecture/2026-09-23-mcp-client.md)首版只开放拥有者声明的只读工具：写工具与副作用不明工具在任何模式下都不注册、不执行，开放它们需要具体操作范围、审批桥单次消费与未知结果恢复，这三项推迟到 personal-agent issue 18 单独交付验收。[旧 GitHub 专用模块退役](../simplification/2026-09-23-retire-github-module.md)后，GitHub 写能力在这之前暂缺。

开放写工具要同时解决四件事。远端工具的 `readOnly` 等注解由服务端给出，客户端核实不了；从批准到真正发送之间，服务配置、凭据、参数和权限都可能变化；写调用遇到超时、断线、取消或后台重启时，远端可能已经执行，重发会制造重复副作用。如果每个服务各写一套发布流程，GitHub 又会走回专用路径，与其他 MCP 服务的授权规则分叉。

## 决定

普通 MCP 写工具不引入专用发布意图、服务适配层或草稿状态机。GitHub 与其他 MCP 服务走同一执行路径，运行时不按服务名分支。

1. **副作用类别是拥有者的本地声明。** 类别写在工具允许列表条目上，取值 `read` / `write` / `unknown`。字符串条目表示拥有者声明的只读工具（与 personal-agent issue 16 的只读接入兼容），对象条目 `{ name, effect }` 显式给出类别；同一工具声明两种类别时配置被拒绝。CLI 写作 `ruukoto mcp configure … --tools a,b:write,c:unknown`，`mcp check` 为每个工具标注类别，工具描述里也写明类别。远端 `readOnly` 等注解是不可信输入，从不作为权限依据。
2. **按类别与访问模式执行。** 未进入允许列表的工具直接拒绝（不注册，也不执行）。`read` 工具在各模式下直接执行。`write` 与 `unknown`（副作用不明，默认与写工具同等需要审批）工具在 `confirm` 与 `auto-review` 模式下逐次审批；`full_access` 跳过逐次审批，但仍须通过服务启用、允许列表与凭据范围校验。
3. **统一审批桥。** 写与副作用不明工具的审批走与文件、HTTP 同一套 `ConfirmationRequest`、`tool_ops`、权限版本与单次消费路径。审批入口是审批闸门 `ApprovalGate.request`（`packages/agent/src/approval-gate.ts`；工单里的 `Driver.awaitApproval` 指同一入口）。审批范围 `mcp_tool` 绑定服务 ID、服务配置版本、远端工具名、任务钉版的工具定义版本、规范化参数摘要、凭据引用名与操作类别；凭据值不进入审批视图或事件。
4. **批准后、真正发送前原子消费。** `Store.consumeApproval()` 在同一 SQLite 事务内完成消费，事务里先重读服务配置：服务被移除或禁用、配置版本变化、工具移出允许列表或类别变化、凭据被撤销（凭据存储不在 SQLite 事务内，见「审批范围与复核」）、权限版本变化、任务已结束，都使旧批准失效，操作按已知未执行记录，不发送网络请求。
5. **执行参数取自审批保存的不可变快照。** 模型改了参数就必须重新申请；同一工具换一组参数的再次调用需要新的审批，批准不复用。
6. **auto-review 对 MCP 工具一律转拥有者。** [自动审查](2026-09-22-auto-review-mode.md)的确定性策略不覆盖 `mcp_tool` 范围，MCP 不扩大自动批准范围。
7. **写调用的未知结果沿用 effect_unknown 语义。** 超时、取消、断线与后台重启时：批准未消费的操作记录已知未执行；批准已消费，或请求已发出而结果无法确认（传输类失败）的操作标 effect_unknown。重连、重复控制请求与重启都不自动重发。远端已应答的错误（`isError` 结果、HTTP 状态错误、JSON-RPC 错误应答）是已知结果，不标 effect_unknown。
8. **真实写工具尚未启用。** 通用框架只以模拟服务验证，仓库没有启用、也没有验收任何真实写工具。首次启用真实写工具时，凭据必须按服务、项目和操作类别独立绑定，禁止复用 Tavily、旧 GitHub 或无 scope 的通用凭据；由拥有者明确指定服务、目标与范围后单独验收。

## 审批范围与复核

- **`mcp_tool` 字段**（`packages/core/src/types.ts`）：`serviceId`、`serviceName`（展示用）、`endpoint`（审批时核对目标，不含 userinfo）、`configVersion`、`remoteName`、`toolSignature`、`paramsSha256`、`credential`（`CredentialStore` 绑定名，无认证为 `null`）、`operationCategory`（`write` 或 `unknown`）。暴露给模型的工具名在 `ConfirmationRequest.toolName`。
- **工具定义版本** `toolSignature` 是远端工具名、描述、`inputSchema` 与副作用类别的 sha256 摘要（取前 16 个十六进制字符），任务开始时钉版。工具定义只在任务开始发现；定义变化产生新签名并重建会话，在下一任务生效。「工具定义变化使旧批准失效」按任务粒度成立：旧批准随所属任务进入终态而不可消费，不跨任务复用。
- **参数摘要** `paramsSha256` 是规范化 JSON（键序稳定）的 sha256。它供审批展示与审计；执行直接用审批记录保存的参数快照。
- **持久化**：`mcp_tool` 范围由审批记录的既有 JSON 列承载，没有 SQLite 迁移；不为单个 MCP 服务新增表或分支。
- **复核点**：同一组检查跑两次，一次在调用前（审批之前），一次作为获批后复核放进消费事务。检查项：服务被移除或换了项目、被禁用、配置版本与任务钉版不同、工具不在允许列表或类别变化、凭据被撤销、凭据 host 与端点 host 不一致；任一命中即拒绝且不发网络请求。复核或消费失败时，同一事务把批准从 `approved` 标为 `stale`。
- **凭据**：`CredentialStore` 是文件存储，凭据绑定的重读在消费前进行，不与 SQLite 消费同事务。发送时 MCP 客户端的认证提供方逐次请求调用 `getForUse`，再核对一次项目、`mcp` 操作范围与 host，撤销即时生效。
- **模式切换与取消**：等待期间切换访问模式，待决审批失效，操作已知未执行，切换后按新模式执行；任务在审批等待中被取消，同样零调用、已知未执行。
- **IM 渠道答复的批准**在同一消费事务里额外核对 IM 固定身份，MCP 的配置复核照常执行，见 [IM 审批与最终报告](2026-10-02-im-approval-and-final-report.md)。
- **副作用类别的其他用途**：计划模式只开放 `effect=read` 的 MCP 工具（见 [Plan 会话模式](2026-10-08-plan-session-mode.md)），宿主评审 SubAgent 也只按任务开放 `effect=read` 的 MCP 工具（见 [GitHub 事件评审](2026-09-24-github-event-review.md)）。

## 结果定性

- **调用结果**（`packages/agent/src/tool-router.ts` 的 `mcpSend`）：对 `write` 与 `unknown` 工具，错误码 `timeout`、`connect_failed`、`canceled` 表示请求可能已发出而结果无法确认，经工具操作账本标 effect_unknown。`remote_error`（JSON-RPC 错误应答）、`auth_failed`、`rate_limited`、`service_error`、`unexpected_status` 与 `isError` 结果都是已知错误；发送前失败（凭据、校验）也是已知结果。`read` 工具的超时只是普通失败。`full_access` 下不经审批的写调用走同一套定性。
- **结构化结果**：调用向 SDK 传钉版定义（只有名称与 `inputSchema`，不带 `outputSchema`），SDK 因此不做本地输出校验，也不在 header 不符时刷新清单后自动重发。路由器按任务开始钉版的 `outputSchema` 校验 `structuredContent`；远端成功应答但不符声明时记已知错误「远端已执行，但结构化结果与声明的 outputSchema 不符」，不标 effect_unknown，也不重发。
- **停止与重启**：工具操作账本（`packages/agent/src/tool-op-ledger.ts`）按审批判定 MCP 动态工具。有审批且全部未消费，记已知未执行；其余结果缺失的操作标效果未知，不重放，由拥有者核实。

## 备选方案

- **为 GitHub 保留专用发布意图、仓库适配层与草稿状态机** — personal-agent issue 06 的专用设计给发布更强的保证：拥有者经可信入口创建发布意图，正文先形成可查看的草稿，批准绑定仓库、目标、草稿版本与完整正文和分析修订，发送前再核对修订与绑定。不选，是因为拥有者明确要求 GitHub 作为普通 MCP 工具；专用路径会让 GitHub 与其他服务走不同授权规则，运行时也要按服务名分支。代价是接受普通 MCP 调用不自动提供旧工作流的全部保证。（见 [personal-agent issue 06](../../../../.scratch/personal-agent/issues/06-github.md)「实施范围」、[personal-agent issue 17](../../../../.scratch/personal-agent/issues/17-replace-github-module-with-mcp.md)「已确认的方向」、[personal-agent issue 18](../../../../.scratch/personal-agent/issues/18-mcp-write-tools.md)「已确认范围」）
- **按远端 `readOnly` 注解决定是否审批** — 服务端已为工具标注是否只读，客户端可据此自动分类，拥有者不必逐个声明。不选，是因为注解由服务端提供、客户端核实不了，伪造的只读注解就能让写操作绕过审批；改由拥有者在允许列表上声明类别，副作用不明时默认需要审批。（见 personal-agent issue 18 实施计划第 1 步）
- **把 JSON-RPC 错误应答一律按传输失败标 effect_unknown** — SDK 2.0.0 的 `callTool` 在远端成功应答后还会按缓存的 `outputSchema` 本地校验结构化结果，不符同样抛 `ProtocolError`，错误码与远端错误应答分不开；一律标未知，至少不会把可能已执行的操作说成未执行。不选，是因为这违反「远端已应答的错误是已知结果」，让本有确定结果的操作也要拥有者核实；改为调用时传钉版定义关掉 SDK 本地输出校验，由路由器按钉版 `outputSchema` 自行校验，`ProtocolError` 就只代表远端错误应答，定为 `remote_error`。（见 [architecture issue 05](../../../../.scratch/architecture/issues/05-tool-op-ledger.md)「背景」与「MCP 定性」，[architecture issue 04](../../../../.scratch/architecture/issues/04-approval-gate.md)「移交候选 05」）

## 后果

- **收益**：GitHub 与任何 MCP 服务共用一条审批、消费、结果记录与恢复路径，新增服务不需要专用代码。一次批准最多发送一次，拒绝发送零次；批准钉住服务、配置版本、工具定义、参数与凭据引用，等待期间任何一项变化都使批准失效且不发送。重连、重复应答与重启不会造成重复副作用；凭据值不出现在审批视图与事件里。
- **代价**：类别的正确性完全取决于拥有者的声明。写工具被登记成字符串条目（即只读）时，它在各模式下直接执行，不经审批。`full_access` 下写调用不逐次确认，挡住它的只有服务启用、允许列表与凭据范围。auto-review 对 MCP 不提供任何自动化，每次写或副作用不明的调用都要等拥有者。effect_unknown 的操作只能由拥有者核实，系统不自动重试。
- **已知上限**：凭据绑定的重读不与消费同事务，消费到发送之间的撤销靠发送时的 `getForUse` 兜住。工具定义变化只按任务粒度生效。账本的规则表里没有 MCP 工具的副作用类别（`tool_ops` 不存它，重启时也拿不到任务钉版的计划），所以停止或重启时中断的 MCP 只读调用同样标效果未知。没有任何真实写工具经过验收；启用前必须先满足第 8 条的凭据与验收要求。

## 验证

`test/25-mcp-write.test.ts` 经两个模拟 MCP 服务走真实宿主路径，覆盖：允许列表类别与 `mcp check` 标注；confirm 模式批准前零调用、批准后按批准参数执行一次（含范围字段与脱敏）；拒绝零次；重复响应只有一次成功；批准等待期间配置变化使旧批准失效；参数变化需新审批；`full_access` 跳过审批但不越过允许列表；auto-review 转拥有者；副作用不明默认审批与两服务同名工具各自独立；审批等待中与在途取消；断线与超时标 effect_unknown（只读超时只是普通失败）；模式切换使待决审批失效；工具定义变化在下一任务钉版新签名；崩溃重启时已消费的在途调用标 effect_unknown 不重放、未消费的记已知未执行；JSON-RPC 错误应答与 `outputSchema` 不符都记已知错误。批准消费的通用行为由 `test/63-approval-gate.test.ts` 覆盖，停止与重启的分类由 `test/64-tool-op-ledger.test.ts` 覆盖。用模拟服务而不用真实写工具，是因为真实写入须由拥有者指定目标与凭据范围后单独验收。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
