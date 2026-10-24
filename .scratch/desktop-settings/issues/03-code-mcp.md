# 03 Code 按实例管理 MCP 并删除项目兼容

Status: ready-for-human

## 目标与边界

2026-10-24 拥有者要求「去掉按工作区配置 mcp，同时删除向后兼容」，随后确认「先更新方案文档」。本单重开，取代原按工作区配置的后续实施与验收要求；本次接手按已审查方案实施，旧实现证据不覆盖新范围。共同要求见[规格](../spec.md#code-mcp-配置与旧格式退出)，理由、备选与旧档案切换见[实例 MCP 决定](../../../.agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md)。

目标是同一 Code 实例只配置一次，全部工作区共用启用服务及允许列表，无工作区和会话也可管理。不保留工作区启用、覆盖、旧项目来源或运行兼容。保留角色/模式/工作流与 Cua 资格、批准消费及失败恢复；Personal 档案与格式不改，通用凭据的其他用途仍可按项目受限。前置：[01](01-settings-shell.md)已交付，本单同时删除其 MCP 专属范围状态。

## 方案

1. 存储与退出：修改 `packages/core/src/db.ts` 和 `packages/agent/src/mcp/store.ts`，删除 MCP 的 `project_id/projectId`、外键、项目查询与计数，服务名在实例内唯一；更新 `core/types.ts` 新 MCP 事件的配置归属字段。递增 schema，只支持新版本，删除 49→50 迁移。旧数据库明确拒绝、保持原数据，不自动清空或转换；新数据目录从空配置开始，不能原地继续旧会话。原档案由旧版保留核实，新旧实例不共用凭据目录。
2. 装配与凭据：修改 `agent/mcp/client.ts`、`tools.ts`、`driver.ts`、`tool-router.ts` 及 `runtime.ts`，移除 MCP 的项目筛选，覆盖主任务、SubAgent 预检和 `workflowConfiguration(projectId)` 中的 MCP 能力摘要。后者的 Web Search 项目范围保留；ToolRouter 发送前删除项目归属比较，继续核实 serviceId、版本、启用状态与允许列表。专用凭据仅限本实例、mcp 用途/操作、端点 host 与 authorization；创建、配置、发现和发送复用同一校验，拒绝项目/仓库受限旧绑定，不剥 scope，也不复用无操作限制的通用凭据。沿用引用保护与脱敏，勿全局删除 `execution/credentials.ts` 的项目能力。
3. 控制面与导入：删除 `core/store.ts:listWorkspaceConfigSources`、Runtime `mcpSources`、`control/ops.ts` 与 `server.ts` 的来源操作、项目参数和引用视图字段；同步协议版本、Desktop IPC 类型/白名单及所有消费者，更新 `packages/tui/src/tui/demo-session.ts` 的 MCP 事件夹具。旧 `mcp_sources` 拒绝，旧 `project_id/workspace_id/selected_project_id` 参数明确拒绝，不能静默变成实例写入。`apps/ruukoto-code/src/legacy-import.ts` 将 MCP 服务排除出导入，删除按项目提取、映射、缺凭据停用及对应账本/回退分支；历史工具操作不重写，不复制旧 MCP 秘密或为新 MCP 增加导入器。
4. 客户端：修改 `renderer/settings-state.ts`、`settings-dialog.tsx`、`code-mcp-state.ts`、`code-mcp-settings.tsx` 及接线，删除 MCP 工作区与配置来源选择、默认推断、候选分页和无工作区阻断。表单只保留产品/实例与服务身份、版本的关联，断线与丢答继续核实原实例；切聊天工作区不重建表单。CLI 删除 MCP `--project` 并显式拒绝旧旗标；配置 TUI 删除项目入口、选择、分组和 expectedProjectId 校验，统一从 MCP 管理入口进入。
5. Cua 与行为保全：普通 HTTP 和 Cua 共用实例服务配置；保留 `mcp/code.ts` 的主会话绑定、版本及未决变更拒绝、暂停和人工恢复。切换前在旧版停止原实例受管执行并核实未知结果；不复用 serviceId、批准或旧观察。CRUD、禁用草稿发现、工具允许列表、逐次审批、钉版及撤销继续使用现有路径；不新增传输、全局连接池或业务工具试调用。
6. 测试与文档：用实例共享/实例隔离用例替换旧工作区隔离、同名分项目及来源分页用例；保留版本、秘密、网络和恢复回归。实施时更新 `CONTEXT.md`、`docs/modules/{core,agent-tools,runtime,workflows,control,tui,desktop,products}.md` 中受影响内容及 `docs/usage.md`；CLI 命令同步 README、开发说明与 pre-push-checks。新笔记按落地转 implemented 并留入口锚点，旧决定只标注被取代范围。实施按实际结果同步现行模块文档。

第 2/4 步同时覆盖终端既有通用入口：`credentials add --purpose mcp` 与配置 TUI 都调用 `add_credential`，在 `Runtime.addCredentialBinding` 的 MCP 分支首次保存即校验 authorization、写入 `operations=['mcp']`，与专用入口复用约束；host 在绑定服务时再与实际端点核对。同名现有绑定若含项目/仓库限制、无操作限制或用途不符则拒绝，不能自动转换；有效绑定的轮换保留限制。`Runtime.removeCredentialBinding` 与专用移除共用 MCP 服务引用检查，防止 `remove_credential` 绕过保护。不要只改 Desktop 专用接口，其他用途的通用凭据行为仍按原规则。

## 进展与交接

- 当前角色：实施者；工程实现、文档同步与独立实现审查通过，无未解决工程阻断。交付实例 MCP、严格凭据、schema 51/控制协议 40 与旧格式拒绝，桌面和终端去工作区，旧导入不复制 MCP。拥有者已授权本批提交；不推送或切换真实档案。
- 当前证据与后续：见[实例 MCP 工程验收](../evidence/2026-10-24-mcp-implementation.md)。下一责任人为拥有者／09 验收者，在独立新档案完成真实 Electron/MyGo、指定 HTTPS MCP 与 Cua 产品验收；原档案仍由旧版核实和停止，不以新档案解除旧电脑占用。
- 2026-10-24 后续实施接手：拥有者本次要求接手工单，进入实施者角色；基点 `develop` / `5cd1ec5a`，工作区干净，01 前置已 resolved，新方案独立审查无阻断。旧 plan-only 授权仅描述上一轮，不限制本次实施；本次不提交、推送或切换真实档案。

- 上轮规划交接：文档修订完成，独立方案审查通过，无未解决阻断。核对基点为 `develop` / `bf3cb0d6bc690ed89e8279091fdedddf604e9ebc`。工作区原有桌面 UI、测试与笔记改动不属于本单，本轮未修改产品代码或用户配置。
- 原实现与审查记录见[2026-10-21 工程证据](../evidence/03-verification.md)，它们只证明按项目方案，不覆盖实例化或兼容删除；原截图、快照和历史 Comments 保留。
- 上轮方案范围为共享规格、03 工单、01/09 后续交接、总提案、新决定及旧笔记互链；精确文件快照、独立审查与检查见[2026-10-24 修订记录](../evidence/2026-10-24-mcp-plan-review.md)。
- 上轮后续要求：实施者接手前重核检出与前置。独立审查发现的终端凭据首写及通用删除绕过问题已在方案补齐并复核；原 ready-for-agent 表示规划可交接；当时授权仅限方案，后续实施授权见上方当前接手记录。

## 验收与证据

| 验收项 | 最窄证明 |
| --- | --- |
| 实例配置 | `24-mcp` 与 desktop MCP 用例：无工作区可配置；两个工作区使用同一 serviceId/版本，实例内同名冲突；其他实例和 Personal 不共享 |
| 凭据与发送 | `24/25-mcp`、desktop MCP backend、`29-cli-entry`、`33-config-tui`：终端从空档案创建 MCP 凭据→绑定→检查可用，首写后 HTTP 不可借用；跨工作区 MCP 可用，错误 host、用途、header、操作或 project/repo scope 拒绝且零发送；同名旧绑定不转换，通用/专用删除均拒绝仍有引用的凭据 |
| 装配一致 | `113-workflow-source-capabilities`、`subagent-source-capabilities`：主任务与能力摘要一致，角色、Plan、评审限制保持；服务变化使旧版本调用失效 |
| 旧格式退出 | schema 49/50 与实施前版本、旧 wire/操作/参数、CLI `--project` 明确拒绝；原数据库逻辑内容、JSONL 与凭据保持，无迁移/业务网络；导入不复制 MCP |
| 状态与恢复 | `25-mcp-write`、`cua-code`、`cua-configuration`：批准后停用、未知效果不重发、Cua 绑定与恢复不被换实例/改配置绕开；同名重建和丢答继续可核实 |
| 客户端 | desktop settings/MCP、配置 TUI、CLI：没有工作区选择、来源分页或前置；换实例/断线/迟到结果不串写，切聊天工作区不丢草稿 |
| 产品验收 | Electron/MyGo 无工作区创建并管理服务，两个工作区共用与停用、退出重开；指定 HTTPS MCP 与 Cua 分别真实验证，缺前提保留缺口 |

实施时按实际改动选最窄检查集：`test/24-mcp.test.ts`、`test/25-mcp-write.test.ts`、`test/desktop-settings.test.ts`、`test/desktop-settings-mcp.test.ts`、`test/desktop-settings-mcp-backend.test.ts`、`test/29-cli-entry.test.ts`、`test/33-config-tui.test.ts`、`test/66-control-seam.test.ts`、`test/75-workspace-settings.test.ts`、`test/76-legacy-workspace-data.test.ts`、`test/85-legacy-instance-import.test.ts`、`test/113-workflow-source-capabilities.test.ts`、`test/subagent-source-capabilities.test.ts`、`test/cua-code.test.ts`、`test/cua-configuration.test.ts`；schema 再按 core 检查行加回归，运行 `npm run check:static`。删除已退出行为的用例，保留明确拒绝的窄测，不为已删兼容机制留模拟实现。

本次工程验收通过，产品验收保留真实 Electron/MyGo、指定 HTTPS MCP 与真实 Cua 缺口，状态 ready-for-human。上一轮方案审查与旧项目方案证据均不代替本次工程和产品证据。

## Comments

2026-10-21：凭据是 MCP 表单的必要配套，不扩大成通用凭据管理中心。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。

2026-10-21 实施交付：01、02 前置核实通过；新增 Code MCP 管理、配置来源分页与受限凭据入口，独立审查修复并发发现、同名创建冲突、凭据 repoId 约束、服务身份 ABA 与冲突放弃草稿。工程结果和产品缺口由实现验收记录持有，状态为 ready-for-human；未提交、未推送、未修改日常真实档案。

2026-10-21 提交授权：拥有者明确要求「提交」，按现有工程检查与独立审查结果提交当前分支，不推送；真实双外壳与 HTTPS MCP 仍待验收，状态保持 ready-for-human。

2026-10-24：拥有者要求取消工作区 MCP 配置并删除向后兼容，确认只更新方案文档。本单重开；旧工程与产品状态不适用于新目标，旧实现保留到后续实施。新方案按实例统一配置，采用旧档案保留、新格式重新配置的切换；本轮不执行切换。

2026-10-24 实施交付：按本次接手指令完成实例 MCP 和项目兼容退出；定向回归、静态门禁、双壳构建/签名及交叉独立审查通过。两项审查发现的旧参数绕过均已复核修复；真实双壳操作、HTTPS 与 Cua 保留外部验收，未提交、推送或切换档案。

2026-10-24 提交授权：拥有者明确要求「提交」，依据既有工程验收、独立审查与最终文件快照提交本批实现及文档，不推送。产品缺口不因提交解除，状态保持 ready-for-human。
