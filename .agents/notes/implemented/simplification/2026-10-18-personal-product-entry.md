# Agent Note: 个人正式入口使用唯一 durable 装配

Status: implemented

## 问题

新个人能力已经集中在 app 内，但 bin、根 start、dev 与部署仍启动旧共享 CLI。保留两套个人装配会继续维护旧运行状态与无生产调用方的工具，也容易误用旧资料或真实 IM。目标与授权范围由[迁移规格](../../../../.scratch/personal-pi-durable/spec.md)和[入口工单](../../../../.scratch/personal-pi-durable/issues/38-product-entry-cleanup.md)持有。

## 决定

正式入口统一调用已有个人 CLI，正式默认档案使用 `~/.ruukoto-durable/`，显式新目录供隔离验证；开发档案继续按检出 realpath 散列分开。开发后台使用平台源码监听，配置菜单直接复用同一 CLI、不监听源码；退出先停自己持有的后台；开发启动拒绝启用真实 IM 的档案，不通过临时配置使旧发送失效。旧目录和未知版本按现有档案核实拒绝。

删除仅供旧个人运行的能力声明、调度/服务工具装配与个人导入器，不把它们转移成测试夹具。共享测试只保留所需的薄能力声明；服务 helper、Coding 导入器、schema 与历史读取继续保留。共享 main 与定时系统提示同步删除退役工具的调用指导，保留宿主最终回报规则。个人 app 不再直接依赖旧 Pi SDK、共享 CLI 或 Runtime；仍可复用共享包内不持有个人运行状态的工具、传输与业务库。

构建仍交付完整 workspace 与根 `worker/`，app tarball 是其中的源码与依赖声明，不能单独作为可安装发行版。隔离安装须实际使用解包后的 app 与构建 worker，分别核实个人 Pi 1.3.0 和 Coding 0.85.1；生产服务接管不属于入口替换。

## 既有笔记审计

[测试精简提案](../../proposed/testing/2026-10-24-test-suite-reduction.md)据本篇的正式入口退役判断旧运行验收的去留；尚未实施，共享库与旧资料保留边界不变。

[迁移总方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)、[基础档案](../../implemented/architecture/2026-10-17-personal-durable-foundation.md)、[本机管理](../../implemented/architecture/2026-10-17-personal-local-management.md)、[双产品](../../implemented/architecture/2026-10-02-two-agent-products.md)、[同仓分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)和[开发入口](../../implemented/process/2026-10-09-dev-launchers.md)部分重叠，各自同步适用范围。[旧个人导入](../../implemented/architecture/2026-10-05-personal-instance-import.md)与[保留开发会话](../../implemented/feature/2026-10-05-ruukoto-keeps-dev-sessions.md)的个人运行入口退出，历史理由和旧资料保持。按 product、durable、正式入口、导入与开发检索未发现完全吸收的笔记，rejected 目录不存在。

## 备选方案

- 保留旧个人工具只撤入口：改动少，也能沿用旧测试；但源码仍承担无生产调用方的装配维护，不能证明减负，因此连同仅验证退出行为的用例删除。
- 复用旧共享开发启动器：已有监听与进程管理，但同时带入旧控制协议、目录和 CLI；开发仅需同一新后台与配置菜单，使用平台监听并明确管理当前进程生命周期。
- 把 app tarball 改成独立发行版：安装表面直观，但必须同时重组共享包、原生监督器与 worker 资产；本次目标是正式入口和完整 workspace 制品可运行，独立发货不在范围内。

## 验证

正式与开发入口的窄测试、真实 PTY、隔离解包/安装后的入口和 worker、双版本解析及 Coding 升级均有通过证据。全仓检查在既有 macOS 监督器用例失败，补跑共享工作流也出现失败，不能据前述窄证据宣称完整回归通过；具体失败、诊断、适用范围与独立审查回到工单。

## 后果

退出个人旧客户端和命令是已确认的产品变化，升级必须另用新档案并保留原件；不能按旧部署步骤加载旧运行记录。平台监听的 TTY、信号和重载语义须实际核实。36 原失败精确归因仍待验，拥有者仅允许隔离实施先行，不解除最终验收或生产切换阻断。
