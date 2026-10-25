# 操作手册

本手册介绍 `ruukoto`（个人 Agent）与 `ruukoto-code`（Coding Agent）的日常运行、环境配置、服务管理与故障排查。底层架构机制见[架构总览](architecture.md)与[模块文档](modules/)，开发贡献见[开发说明](development.md)。

<a id="1-前提与安装"></a>

## 1. 环境准备与安装

### 1.1 系统与依赖要求

两个产品均使用原生沙箱与宿主工具链运行，无需 Docker。

- **运行时环境**：Node.js ≥ 24.15.0，Bash，Git。
- **检索工具**：宿主必须预先安装 `ripgrep`（`rg`）并加入 `PATH`（文件检索核心依赖）。
- **平台依赖**：
  - **macOS**：需安装 Command Line Tools（Clang），利用系统 Seatbelt 沙箱。
  - **Linux**：需支持 `bubblewrap`、cgroup v2 与 systemd user manager（个人服务常驻需开启 linger）。

### 1.2 仓库构建与初始化

```bash
npm run setup       # 安装依赖、校验环境前提并配置 Git Hook
npm run build       # 构建工具 Worker、平台监督器与应用包
npm link            # 可选：将 ruukoto 和 ruukoto-code 注册至全局 PATH
```

<a id="21-启动后台"></a>

## 2. 快速启动与运行

两个产品分别针对个人助理与工程编码场景，拥有独立的数据目录与运行入口：

| 产品 | 核心交互方式 | 默认档案目录 | 典型启动命令 |
|---|---|---|---|
| **`ruukoto`** (个人 Agent) | 终端交互菜单、QQ / Telegram 私聊、PA 桌面 | `~/.ruukoto-durable/` | `ruukoto` 或 `ruukoto serve` |
| **`ruukoto-code`** (Coding) | 终端 TUI、Web 界面、Coding 桌面 | `~/.ruukoto-code/` | `ruukoto-code` 或 `ruukoto-code <路径>` |

### 2.1 个人 Agent 运行

<a id="25-个人-durable-隔离向导"></a> <a id="25-个人-agent-引导与管理"></a>

- **交互管理菜单**：直接执行 `ruukoto` 或 `npm start`，进入交互引导菜单，支持模型配置、实例启停、通道管理与工作查询。
- **前台常驻服务**：
  ```bash
  ruukoto serve                          # 托管默认档案的前台服务
  ruukoto serve --directory /path/to/dir # 显式指定独立档案目录
  ```
<a id="72-命令"></a>

- **配置与维护命令行**：
  - `ruukoto settings`：提供结构化 JSON 接口，供客户端程序在线/离线管理模型、Skills 与 MCP 配置。
  - `ruukoto maintenance`：系统级服务的健康检查与受控启停。
  - `ruukoto remote`：本机远程配对管理向导，配合 Tailscale 提供安全远程连接。

### 2.2 Coding Agent 运行

- **交互终端（TUI）**：
  ```bash
  ruukoto-code                     # 打开最近会话
  ruukoto-code ~/code/my-project   # 在指定工作区打开或新建会话
  ruukoto-code config              # 打开模型与参数离线配置界面
  ```
- **后台服务托管**：
  ```bash
  ruukoto-code server              # 前台启动 Coding 后台服务
  ruukoto-code stop                # 优雅停止正在运行的后台服务
  ```

### 2.3 按需拉起后台机制

在终端执行 `ruukoto-code [路径]` 时，TUI 会自动探测后台服务状态：
- **服务已运行**：直接复用，秒级进入会话。
- **服务未运行**：自动在后台拉起常驻服务（日志输出至 `<controlDir>/spawn.log`），就绪后自动连接。
- **并发互斥**：若两个终端同时触发拉起，实例锁（`<dataDir>/runtime.lock`）会自动收敛为单实例，败方自动转为复用胜方。
- **解耦生命周期**：关闭 TUI 窗口或终端断开不会中断后台正在执行的任务；显式执行 `ruukoto-code stop` 才会停止服务。

<a id="8-开发实例"></a>

### 2.4 开发实例启动

在本地调试源码时，可使用独立的开发沙箱实例，避免影响日常使用的正式数据：

```bash
npm run dev                      # 启动个人 Agent 开发环境（Node watch 监听）
npm run code                     # 启动 Coding Agent 开发环境
```

## 3. 模型与基础配置

### 3.1 个人 Agent 模型配置

在 `ruukoto` 引导菜单中选择「配置能力」→「模型配置」：
1. **选择 Provider**：支持主流大模型提供商（Anthropic、OpenAI、DeepSeek 等）。
2. **凭据管理**：推荐配置环境变量名称（如 `ANTHROPIC_API_KEY`），程序在运行时动态读取环境凭据，避免明文落盘。
3. **连接测试**：配置完成后，系统会向模型发送一次轻量 Ping 请求验证连通性。

### 3.2 Coding Agent 模型配置

执行 `ruukoto-code config`，在全屏配置界面中管理模型配置：
- **模型分工**：可为主任务、思考推理、SubAgent 分别指定不同的模型与上下文窗口限制。
- **即时生效**：后台运行时保存配置将平滑更新运行时模型栈，无需重启服务。

## 4. 外部通道与客户端接入

### 4.1 QQ / Telegram 接入

个人 Agent 支持将个人 QQ 或 Telegram 私聊作为日常交互入口：

1. **Telegram 接入**：
   - 在 BotFather 创建机器人并获取 Bot Token；
   - 在 `ruukoto` 菜单中选择「平台接入」→「Telegram 配对」，输入 Token；
   - 拥有者向 Bot 发送消息完成单人专属配对。
2. **QQ 接入**：
   - 依赖 OneBot 实现（支持 NapCat 等实现接入）；
   - 在菜单中配置 WebSocket 服务端点并完成握手。
3. **安全模式**：外部 IM 默认启用自动审查（Auto-Review）模式，敏感工具调用需拥有者在对话中明确批准。

<a id="桌面客户端"></a>

### 4.2 桌面客户端连接

PA 桌面客户端支持跨平台窗口交互：
- 服务端执行 `ruukoto remote` 打开配对向导，生成一次性配对码。
- 桌面客户端输入服务端地址与配对码完成认证握手。
- 连接基于安全 Unix Socket / Tailscale Serve，保障传输加密与设备绑定。

## 5. 扩展与高级能力

<a id="57-mcp-服务"></a>

### 5.1 MCP（Model Context Protocol）服务

系统通过标准 MCP 协议接入外部上下文与工具：

- **服务配置**：支持标准 stdio 进程与 HTTPS / SSE 远程服务。
- **工具发现与权限**：服务接入后自动发现暴露的工具集。拥有者可在配置中按需启用工具，未勾选的工具对模型完全不可见。
- **调用审计**：所有 MCP 调用的请求参数与返回结果完整记入操作账本，支持审计与结果复核。

### 5.2 技能库（Skills）

- **加载机制**：支持从 `skills/` 目录加载 Markdown 格式的技能说明，运行时自动根据任务相关度注入模型上下文。
- **托管技能管理**：支持从外部仓库按包导入技能，并支持在配置中单独启停指定技能。

<a id="12-浏览器"></a>

### 5.3 浏览器自动化

在配置中启用浏览器能力后，Agent 可操作无头或可视化 Chromium 浏览器：
- 支持网页导航、交互点击、文本输入、页面截图与全文提取。
- 截图产物以二进制文件妥善存放在产物目录中，并通过控制面按需提供预览。

<a id="511-工作流问题与回报"></a>

<a id="54-通用定时任务"></a>

### 5.4 工作流与交互式提问

- **结构化提问（`ask_user`）**：当模型需要人类决策时，会在界面上渲染单选、多选或自由文本输入弹窗，等待用户确认后继续推进任务。
- **后台长期分析**：支持将耗时任务放入后台分析委托，主会话可随时查询进度并在任务完成后接收汇报。

## 6. 数据迁移与归档

<a id="6-导入旧实例"></a>

### 6.1 导入旧实例数据

对于既有 Coding 实例的迁移，系统提供安全的前置校验与导入工具：

```bash
ruukoto-code legacy-import --preview <源目录>  # 预览待迁移内容（会话、任务、配置）
ruukoto-code legacy-import --apply <源目录>    # 执行迁移并生成备份与迁移回执
ruukoto-code legacy-import --revert <源目录>   # 撤销导入并还原旧库状态
```

> **安全保证**：导入源严格只读，目标库在应用前自动备份。导入过程中若检测到目标环境已产生冲突数据，将主动中止并拒绝覆盖。

<a id="62-个人资料归档"></a>

### 6.2 个人资料归档

个人 Agent 采用 durable 存储体系，历史旧格式数据原地保留为只读归档，新服务统一在新目录中初始化。

## 7. 常见问题排查与运维

### 7.1 日志查看

- **个人服务后台日志**：`<dataDir>/personal.log`
- **Coding 服务后台日志**：`<controlDir>/spawn.log`
- **任务产物与详细错误**：各任务输出可在 TUI 会话详情中查看，超长输出保存在 `<agentDir>/artifacts/`。

### 7.2 实例锁与并发冲突

- **现象**：启动提示 `runtime.lock` 或 `config.lock` 冲突。
- **排查**：
  1. 检查是否有存活的后台进程：`pgrep -fl ruukoto`；
  2. 若为非正常关机导致的死锁，确认无后台进程后可安全清除对应 lock 目录。

### 7.3 沙箱与权限问题

- **macOS**：如遇到工具执行失败，检查是否未授权终端的 Accessibility 或 Command Line Tools。
- **Linux**：若原生受限沙箱报错 `execution_unavailable`，确保系统安装了 `bubblewrap`，且当前用户开启了 cgroup v2 访问权限。
