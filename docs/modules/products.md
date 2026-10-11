# 产品装配

## 职责与边界

`apps/ruukoto` 是个人 Agent，`apps/ruukoto-code` 是 Coding Agent。各 app 持有自己的 bin、主入口与开发入口、`product.ts` 能力声明及专属工具或导入策略；两个 app 互不依赖。共享 CLI 在 tui 包（见 [tui](tui.md)）。存储、模型、任务、控制面与界面由 `packages/` 下的共享包提供。

## 对外接口

各 bin 固定 `RUUKOTO_PRODUCT` 后注册 tsx，再进入本 app 的 `main.ts`。共享 CLI 接收 `CliProduct`，共享 `Runtime.start` 要求 `RuntimeConfig.product`，不按产品名选择装配。调用程序化入口时，显式传入所属 app 的 `product.runtime`。

| 声明 | ruukoto | ruukoto-code |
| --- | --- | --- |
| 默认执行后端 | local；服务器部署显式配置 container | container |
| 拥有者 IM 与个人调度 | 启用；开发入口可停用真实 IM | 停用 |
| 服务管理 | Linux 与显式部署配置齐备才装配 | 不装配 |
| 旧项目写入口 | 保留 | 引导改用工作区 |
| 旧实例导入 | 个人资料；channels 持有方向实现 | 开发资料；app 持有方向实现 |

任务界面、配置中心、工作区组织迁移与旧群结果查询由两个产品共用。界面按产品展示工作区或旧项目。运行与安装命令见[操作手册](../usage.md)，开发和构建见[开发说明](../development.md)。

## 数据与状态

产品身份在核心库 `meta` 的 `product.type` 登记；档案、锁、控制面、模型配置与凭据按产品隔离。能力声明是宿主代码，不由模型或工具参数修改。分包不改变 schema、控制面协议、会话 JSONL 与既有归属。

## 主要流程

**启动。**

- bin 固定产品身份，app 把能力声明交给共享 CLI。
- CLI 按声明选择默认执行后端和导入方向，将 RuntimeProduct 注入运行时。
- 运行时按 IM、调度与工具族能力创建部件，再接上控制面。
- 开发入口复用共享启动器，子进程仍使用对应 app 的 bin。

**构建。**

- 根构建单次生成 `worker/worker.mjs`，再为两个 app 分别生成含 bin、源码和依赖声明的 npm 包。
- app 包使用同仓共享依赖；部署需要完整 workspace 安装，两个产品共用同一 worker 镜像。

## 不变量与失败处理

**产品隔离。**

- 跨产品打开同一数据目录以 `product_mismatch` 拒绝。
- Coding Agent 停用 IM 与调度时，旧记录仍可读，旧工具操作仍按共同账本核实。
- 两个 app 的能力使用同一份存储、审批与执行约束。

**进程与执行环境。**

- 应用实例不会因退出 TUI 而停止；开发启动器则拥有其子进程生命周期。
- 缺少执行环境明确失败，默认后端不静默降级。

**依赖方向。**

- 跨包相对引用、未声明依赖与越层运行时值引用不能通过 lint。
- core 连反向类型引用也不接受；其他共享包的反向引用只限声明过的类型，运行时协作使用注入回调。

## 设计依据

- [两个 Agent 产品独立运行](../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)
- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)
