# 产品装配

## 职责与边界

`apps/ruukoto` 持有个人 Agent 的正式 bin、主入口、开发入口与 durable 业务接线；`apps/ruukoto-code` 持有 Coding Agent 的 bin、主入口、开发入口、`product.ts` 和开发资料导入策略。两个产品互不依赖，各自拥有运行状态与客户端协议。个人能力见[个人持久会话](personal-durable.md)，Coding CLI 与界面见 [tui](tui.md)。

## 对外接口

个人 bin 与根 `npm start` 默认进入同一个引导式 CLI，无参打开菜单，`serve` 前台运行后台，`settings` 提供模型、Skills 与 MCP 的受限 JSON 管理；`personal:durable` 是该入口的兼容命令。正式默认目录为 `~/.ruukoto-durable/`，可用 `RUUKOTO_PERSONAL_DIR` 选择独立新目录。个人开发入口固定检出散列档案，忽略继承目录，默认由薄启动器托管 Node watch 前台后台；`--config` 直接打开同一菜单且不监听源码，菜单启动的后台由本进程持有，退出时停止。配置菜单源码变化须退出重开。开发拒绝已启用 QQ/Telegram 的档案，不改写配置或连接平台。

Coding bin 固定产品身份，向共享 CLI 传入 `CliProduct`，并向 `Runtime.start` 显式传入 `product.runtime`。`npm start` 的 `RUUKOTO_PRODUCT=ruukoto-code` 选择及 app 的独立 start 保留；Coding 的工作区、会话、四种界面模式、SubAgent、工作流、按需后台与旧开发资料导入保持。

| 能力 | ruukoto | ruukoto-code |
| --- | --- | --- |
| 会话与运行权威 | Pi durable 1.3.0 | 原共享 Runtime/Driver，Pi 0.85.1 |
| 主要界面 | QQ/Telegram 与引导式 CLI | TUI、配置中心与 Code 桌面 |
| 持久历史 | durable SQLite | 核心元数据与原 JSONL |
| 后台工作 | 长期子 Agent、分析委托与独立定时运行 | 通用 SubAgent、worktree 与工作流 |
| 旧资料 | 原地归档，不导入 | 开发资料离线导入 |
| 编码专用入口 | 不提供开发会话、worktree 汇总、旧工作流或 GitHub 自动评审 | 保留既有 Coding 能力 |

个人另提供 `maintenance` 受限 JSON 生命周期入口；`serve --directory <绝对路径>` 将服务档案固定在启动参数，优先于环境。安装与操作见[操作手册](../usage.md)，开发与构建见[开发说明](../development.md)。个人聊天不兼容旧 TUI、桌面 Personal 或控制面协议；桌面设置使用独立新协议连接。

## 数据与状态

个人档案、锁、本机认证 socket、配置、凭据引用及请求证据独立保存，版本和旧目录在恢复前核实。Coding 的产品身份继续登记在核心库 `meta.product.type`，档案、锁与控制面各自隔离。Coding MCP 按实例保存服务与专用凭据，全部工作区共用；Personal 保留自身档案格式，不共享服务或秘密。两个版本的 Pi 对象不跨产品传递，个人不双写旧 Task Store 或 JSONL。

## 主要流程

**启动。** 个人入口使用已配置模型打开唯一 Harness；运行中菜单仅经本机认证接口管理，离线配置持实例锁。认证令牌逐启动生成，完整写入私有临时文件后替换，坏旧令牌仍拒绝启动。Coding 入口按能力声明选择 native 与导入方向，装配 Runtime、控制面与客户端。日常个人后台独立于菜单，开发进程拥有其后台生命周期。

**构建。** 两个产品的宿主最低为 Node 24.15，包声明与开发环境检查使用同一版本门槛。根构建生成共享 `worker/worker.mjs`、自包含的 `worker/personal-command-worker.mjs`、工作流脚本及平台产物，再生成两个 app 的 npm tarball。个人命令 worker 不依赖 Pi SDK，运行依赖从构建制品解析；Coding worker 保留原 SDK 与依赖。tarball 交付源码、bin 和依赖声明，安装仍需要完整 workspace、根 worker 与宿主工具链，不是独立发行版。

## 不变量与失败处理

- 正式个人与兼容入口只有一套装配，不加载旧 Runtime、Driver、Task Store、控制协议或个人导入器；仅复用实际共享的业务库、传输、校验、浏览器及原生执行原语。
- 新个人档案不覆盖、迁移或自动复制旧资料和凭据；旧目录、不支持版本、锁冲突或配置未齐时明确拒绝，拒绝前不连接 IM、不恢复任务。
- Coding 拒绝跨产品目录、旧 local/container 覆盖及非当前 schema；保留旧 SQLite、JSONL 与凭据，使用独立新数据及凭据目录重新配置，不能原地继续旧会话；个人命令模式由宿主配置，不接受旧 CLI 执行覆盖。
- 同账户完全访问使用后台账户已有权限，外部效果未知或停止未核实仍保留原占用；退出界面不能代替停止证明。
- 跨包引用使用 exports 与已声明依赖；反向运行时协作采用注入，core 不依赖其他 workspace 包。个人 app 直接声明 Pi 1.3.0，Coding 调用方保留 0.85.1。

## 设计依据

- [Code MCP 按实例配置与旧格式退出](../../.agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md)

- [个人认证令牌完整写入后发布](../../.agents/notes/implemented/bug-fix/2026-10-24-personal-token-atomic-publish.md)

- [个人正式入口使用唯一 durable 装配](../../.agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md)
- [两个 Agent 产品](../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)
- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)
