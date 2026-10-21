# 03 Code 按工作区管理 MCP 与所需凭据

Status: ready-for-agent

## 目标与边界

完成[范围矩阵](../spec.md#功能与范围矩阵)的 Code MCP 能力及 R1–R4、R6。前置：[01](01-settings-shell.md)。仅复用当前远程 MCP 传输与授权，不加入 stdio、OAuth 或业务工具试调用。

## 方案

1. 在 `control/src/ops.ts` 补已有 `mcp_list/configure/set_enabled/remove/check`、`list_credentials/remove_credential` 的准确类型；新增最窄 MCP 凭据保存入口或给既有入口增加受校验来源参数，首次落盘即限定 `scope={projectId:选定原来源,operations:['mcp']}`，并核对实际 host/authorization；不能先以通用绑定创建再等服务配置收窄。Desktop 只开放本页需要的 Code 操作，不开放不带范围的通用凭据写入。
2. 补后台有界配置来源候选查询，列出工作区自身与组织映射旧会话的原项目名称及服务归属。`renderer` 显式选工作区和适用配置来源，默认规则见共享规格；同一工作区不能只选一个猜测的 `project_id`。展示服务名称、端点、启用、凭据状态、工具允许列表和本地副作用声明。服务 ID 和 expectedVersion 来自读取结果。
3. 新增、编辑、启停和删除都先展示范围；凭据未提供表示保留，null 才清除。匿名须显式选择；清理凭据前展示受影响引用，不删除其他服务所需凭据。
4. 允许列表用逐项选择与类别选择，不要求用户输入 JSON；`mcp_check` 可校验已配置服务并发现工具。首次配置没有既有服务可检查时，先保存禁用草稿服务再检查，之后选择工具并显式启用；发现不执行业务工具，不自动信任远端只读注解。
5. 对版本冲突、凭据 host/purpose 不符、认证/发现失败和丢答给可行动结果；启停读回版本，不自动重发。运行任务旧配置被撤销后的行为仍由后台检查，不宣称禁用已取消远端调用。
6. 同步 `docs/modules/desktop.md`、`control.md`、`agent-tools.md` 和 `docs/usage.md` 的实际入口。

## 进展与交接

- 2026-10-21 拥有者明确表示「方案已通过」，本单范围与产品取舍已确认；ready-for-agent 表示方案可交实施，实际开工仍须满足本单前置。

- 方案未实施；基点见总规格。下一角色：实施者，先等待 01 交付并核对当前接口。
- 01 为前置；与 02 共用文件需协调写入。发现既有检查接口无法支持禁用服务的安全发现时，补最窄发现接口及测试，不能临时启用业务工具绕过。
- 工程及产品待验收；独立方案审查通过，见[记录](../review.md)，实现未审。

## 验收与证据

- 新增 `test/desktop-settings-mcp.test.ts`：两个工作区互不串写、两个原项目映射同一工作区且同名服务不串写、无会话的来源默认与候选分页、CRUD/启停/版本冲突、匿名与凭据拒绝、凭据创建后配置冲突/取消仍拒绝通用 HTTP 和跨来源使用、发现无业务调用、丢答核实和脱敏。
- 回归：`npx tsx --test test/24-mcp.test.ts test/25-mcp-write.test.ts test/38-desktop-main.test.ts test/desktop-settings-mcp.test.ts`；`npm run check:static`。
- 产品验收：双壳对隔离回环服务完成配置→发现→允许→启用→停用→移除；真实 HTTPS MCP 单独记录凭据和测试范围，缺前提保留待验收。
- 独立方案审查无未解决阻断；实现审查尚未进行。

## Comments

2026-10-21：凭据是 MCP 表单的必要配套，不扩大成通用凭据管理中心。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。
