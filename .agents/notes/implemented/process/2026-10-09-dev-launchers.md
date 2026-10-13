# Agent Note: 两个产品分别使用独立开发启动入口

Status: implemented

原出处：ADR 0017「补充：两个产品的开发启动入口」

## 问题

两个产品需要独立的源码监听、重载与界面开发入口。既有 `npm run dev` 数据库已登记为 ruukoto，直接切到 Coding Agent 被产品归属拒绝；开发运行也必须与日常实例的路径、凭据、锁、控制面和真实消息消费分开。

## 决定

`npm run dev` 启动 ruukoto 开发后台，`npm run dev -- --config` 打开其配置入口；`npm run code` 启动 ruukoto-code 开发后台并默认打开 TUI，`npm run code -- --config` 打开其配置中心。开发启动器不再接受 `--tui`。

两入口通过各 app 的 `src/dev.ts` 复用 `packages/tui/src/dev.ts` 的源码监听、重载和进程管理；监听范围为 `packages/*/src` 与 `apps/*/src`，子进程使用所属 app 的 bin，档案分别保存为 `~/.ruukoto-dev/<仓库>-<哈希>/` 与 `~/.ruukoto-code-dev/<仓库>-<哈希>/`，与日常[产品档案](../architecture/2026-10-02-two-agent-products.md)分开。保留已有 ruukoto 开发历史，不自动迁移；模型配置仅经已有 `--import-models` 显式复制。各档案拥有自己的数据、配置、凭据、锁与控制面，可以同时运行。ruukoto 开发实例保留普通开发会话的理由见[保留开发会话](../feature/2026-10-05-ruukoto-keeps-dev-sessions.md)。

开发入口固定产品身份，清除继承的日常路径、拥有者令牌及受保护执行账户配置，并停用真实 QQ/Telegram。执行后端沿用 CLI 产品默认值：ruukoto 使用 local，ruukoto-code 使用 container；container 不可用时任务明确失败，不回退 local。完全访问所需的执行账户配置不在此次扩展范围，local 本身没有操作系统级隔离。

开发启动器管理后台：退出 TUI/配置中心、Ctrl+C 或关闭终端会停止本次开发进程。开发前端不自行拉起后台，防止源码重载失败派生未由启动器管理的进程；日常 ruukoto-code 的 TUI 退出后后台继续运行规则仍成立，见[后台与终端分离](../architecture/2026-09-19-detach-terminal-from-task-runtime.md)。

## 验证

原实现提交 `c819db3adad75b8c0cf604b3fef3816334fa993f` 同步开发启动器、两个产品的开发入口和 package 入口和 test/32、test/71。test/32 覆盖入口参数、双档案、重载与受管退出；test/71 覆盖双产品环境清洗与日常目录/令牌/执行配置不继承。原 ADR 补充段和 `.scratch/` 没有独立登记该提交的运行命令结果，因此此处只记录可复查覆盖，不把它表述成历史测试已通过。开发启动方式与模型导入操作见[开发说明](../../../../docs/development.md#开发实例)。

## 备选方案

把已有开发档案直接切到 ruukoto-code 可以复用现有历史与配置，但原 ADR 记明数据库已有 ruukoto 产品归属，直接切换会被拒绝；因此新增独立 Coding Agent 开发档案，历史保留在原档案，模型配置显式复制。该取舍与[开发会话保留工单](../../../../.scratch/agent-direction/issues/23-contract-legacy-roles.md)记录的产品切换约束一致。

开发前端自行拉起后台可复用日常 TUI 的按需启动机制，但原 ADR 明确记录源码重载失败后可能派生不受开发启动器管理的进程；因此开发前端只连接启动器管理的后台。

## 后果

两产品可同时开发，重载和退出有同一个管理者，既有开发历史不会被隐式改变产品身份。代价是两份开发资料分别维护，迁移历史不属于启动器功能；Coding Agent 开发任务要求 container 可用，完全访问仍需另外满足受保护执行配置。开发退出会停后台，使用者不能把日常产品的后台持续运行规则套用到开发入口。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
