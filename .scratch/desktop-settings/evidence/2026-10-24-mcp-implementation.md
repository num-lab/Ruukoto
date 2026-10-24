# Code 实例 MCP 工程验收

## 对象与授权

实施入口为[03](../issues/03-code-mcp.md)，有效要求来自[共享规格](../spec.md#code-mcp-配置与旧格式退出)及[实例 MCP 决定](../../../.agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md)。拥有者在方案独立审查通过后要求接手工单，本次进入实施；上一轮仅限方案的授权是历史边界。本次未提交、推送、部署或切换日常档案。

基点 `develop` / `5cd1ec5a`，接手时工作区干净；01 前置已 resolved。环境为 macOS 27.0.1 arm64、Node 24.15.0。根工作区由实施者单独写入；Desktop、CLI/TUI、导入及文档分别在独立临时工作副本实施，补丁汇总后按最终调用方验证。受检文件及内容指纹见[快照](2026-10-24-mcp-implementation-snapshot.json)，快照自身不纳入自引用哈希。

## 交付与工程结论

工程验收通过，独立实现审查无未解决阻断。服务存储、事件、主任务、SubAgent 与工作流 MCP 摘要统一为实例配置；服务名称实例内唯一。Desktop 的 MCP 工作区、来源与分页以及终端项目入口已删除，切聊天工作区保留原表单，断线和丢答仍核实原实例、服务身份与版本。

凭据创建、绑定、发现、批准消费前及每次发送复用严格 MCP 校验：authorization、mcp 用途及唯一操作范围、实际 host，无项目或仓库限制。通用首写不能留下可被 HTTP 借用的绑定，同名旧绑定拒绝转换，通用和专用移除均保护全部服务引用。其他用途的项目范围继续保留。

schema 51 只接受当前版本，旧库在修改 journal 模式或建表前拒绝；49→50 迁移删除，控制协议升至 40。旧 MCP 操作、归属参数及 CLI 旗标明确拒绝，不静默转成实例写入。旧实例导入不提取、复制、映射或回退 MCP 服务，不复制其秘密，不重写历史工具参数。Cua 的主会话、配置版本、批准、冻结、暂停与人工恢复路径继续沿用。

## 定向验证

下列都是隔离临时档案、模拟模型与回环 MCP／固定 Cua 夹具的工程检查。它们不代表真实模型、真实 HTTPS 或官方 Cua 业务验收。完整全仓 `npm run check` 未执行。

| 命令或检查对象 | 最终结果与证明 |
| --- | --- |
| `npx tsx --test test/24-mcp.test.ts test/25-mcp-write.test.ts test/cua-code.test.ts test/75-workspace-settings.test.ts` | 61/61；认证调用、工具快照、版本与撤销、批准及未知效果、Cua 冻结恢复、旧项目认领与其他用途凭据范围 |
| `npx tsx --test --test-name-pattern='跨工作区共享认证' test/24-mcp.test.ts` | 最终扩充后 1/1；两工作区调用同一认证服务，停用后各自的新任务不再获得工具、无成功调用且远端计数不增 |
| `npx tsx --test --test-name-pattern='等待批准时凭据范围改变' test/25-mcp-write.test.ts` | 新增 1/1；审批等待中分别改变 host、用途、认证头及五种 scope，批准不消费、审批 stale、已知未执行且无额外网络 |
| `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/113-workflow-source-capabilities.test.ts test/subagent-source-capabilities.test.ts test/13-tui-state.test.ts test/45-github-events.test.ts test/125-agent-wait-resource.test.ts` | 174 项中首轮 169 过、5 个旧夹具失败；修复 08 的泛用途凭据夹具和 113 的旧 MCP 参数后，重跑 `test/08-approvals.test.ts test/113-workflow-source-capabilities.test.ts` 29/29，其他 145 项保留通过证据 |
| `npx tsx --test test/44-task-tool-policy.test.ts test/58-plan-mode.test.ts test/114-workflow-owner-input.test.ts test/cua-configuration.test.ts` | 14/14；宿主白名单、Plan、工作流业务回答与 MCP 审批、Cua 配置保全 |
| `npx tsx --test test/desktop-settings.test.ts test/desktop-models-layout.test.ts test/desktop-settings-mcp.test.ts` | 39/39；设置容器、无工作区管理、草稿、迟到应答、换实例、服务身份 ABA、冲突、发现及 Cua 状态 |
| `npx tsx --test test/desktop-settings-mcp-backend.test.ts` | 10/10；无工作区、实例共享/隔离与同名冲突、旧操作及参数零写入零网络、严格凭据、双入口引用保护与状态事件事务 |
| `npx tsx --test test/29-cli-entry.test.ts test/33-config-tui.test.ts` | 42/42；终端空档案凭据→绑定→检查闭环、统一实例入口、Cua 无工作区入口及既有终端行为；最后旗标修复后重跑两条 MCP CLI 用例 2/2 |
| `npx tsx --test test/76-legacy-workspace-data.test.ts test/85-legacy-instance-import.test.ts` | 根目录 29/29；无 MCP 导入、计数或账本，凭据秘密不复制，历史 MCP 工具参数保持原样；独立副本曾因缺应用层嵌套依赖报 copyJson，根目录复跑已排除该环境缺口 |
| `npx tsx --test test/desktop-settings-models.test.ts test/desktop-settings-skills.test.ts test/desktop-personal-settings-pages.test.ts test/38-desktop-main.test.ts test/38-desktop-build.test.ts test/desktop-mygo.test.ts test/14-tui-app.test.ts test/15-tui-pty.test.ts test/personal-mcp-config.test.ts test/personal-mcp.test.ts` | 216/216；共用设置与 IPC 消费者、终端交互、双壳桥接，以及 Personal 独立配置和 MCP 运行保持 |
| `npm run check:static` | lint、根／全部 workspace／foundation typecheck、197 篇笔记与封印、文档链接／引用／预算／段落通过；最后仅新增测试，再定向 lint 与根 typecheck 通过 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 两壳构建通过，未改 Go 桥接代码，未重复 Go race；构建制品分别在 `dist/mac-arm64` 与 `dist/mygo/darwin-arm64` |
| `codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app`、`codesign --verify --deep --strict 'dist/mygo/darwin-arm64/Ruukoto MyGo.app'` | 两个制品签名核实通过；本地签名检查不等于公证或真实打开体验 |
| `git diff --check` | 通过；新旧笔记链接与工单交接同步 |

旧 schema 的窄测同时保存并比较 SQLite 文件字节、schema 与服务行、schema_version、JSONL 和凭据文件；49/50 都拒绝且保持原样。旧 wire 版本按已有认证前检查拒绝；新 wire 携 `project_id/workspace_id/selected_project_id` 的 MCP、通用凭据操作全部在写入前拒绝，服务、凭据、事件和回环网络计数不变。

首轮静态检查发现笔记移动后的总提案相对链接漏改，修正后完整静态门禁通过。跨工作区停用的新增断言最初误要求为未注册工具生成宿主操作，已改成模型未获工具、无成功操作及零远端发送，独立审查者复跑确认其能捕获停用失效。

## 独立审查与修复

独立上下文 `/root/terminal` 读取需求、方案、实际 diff 与相关代码，审查其他作者的 core、agent、runtime、control、Desktop 和导入；该上下文自己实施的 CLI/TUI 不纳入其独立结论。它亲跑 Desktop 39 项及 backend/Cua/导入的 23 项，后端实例范围、凭据发送、审批消费、Cua 原资格与恢复、导入退出无未解决阻断；最终新增的共享停用和凭据审批回归另亲跑 2/2 并确认断言有效。

独立上下文 `/root/import` 审查其他作者的后端和 CLI/TUI，发现两项可复现绕过：通用 `add_credential(purpose=mcp)` 曾忽略旧归属参数；CLI 的 `--disabled` 会把后续 `--project` 当作其值，造成实例写入。修复分别为通用凭据操作纳入旧归属拒绝、MCP 分支从原始参数捕获 `--project`／`--project=`。该审查者直接复跑原负例与最窄回归 4/4，通过零服务／凭据／事件写入及零网络断言；另亲跑导入 29/29、终端 MCP/Cua 8/8，并核实新旧笔记 50 条相对链接，最终无阻断。

## 产品验收与恢复条件

状态为 ready-for-human，下一责任人为拥有者／[09 验收者](../issues/09-acceptance.md)。真实 Electron/MyGo 的无工作区创建管理、两工作区共用与停用、退出重开、明暗窄窗键盘焦点仍未实际操作；SSR、状态与真实控制面桩检查不抵扣这些体验。

指定 HTTPS MCP 端点及其凭据引用未提供，未连接任意现有真实服务。官方 Cua 的真实模型视觉、捕获、操作与人工恢复未验，本轮仅验证固定本地夹具与现有原生 supervisor 的工程链路。Linux 与 Node 22.19 平台矩阵未跑，不把本机结果写成跨平台通过。

恢复验收时使用新的隔离数据目录和凭据目录，重新配置 MCP；旧 schema 49/50 的会话与持久状态不能在新版原地继续。先用原版本停止原实例受管执行、核实未知效果和 Cua 占用，保留原 SQLite、JSONL、产物与凭据；新服务身份、批准或恢复观察不跨实例继承。真实档案没有被本次实现修改或切换。
