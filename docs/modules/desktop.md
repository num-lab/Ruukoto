# 桌面客户端

## 职责与边界

`desktop` 模块（对应 `apps/desktop/`）是专为桌面环境（主要支持 macOS）打造的图形化 GUI 客户端。它支持双模式切换：本地工程编码（Coding 目标）与远程个人助理（Personal 目标）。

### 核心职责
- **双产品目标支持**：
  - **Coding 目标**：通过本地 Unix Domain Socket 接入 `ruukoto-code`，提供多工作区管理、会话标签页、代码 Diff 查看、SubAgent 监控与集成终端。
  - **Personal 目标**：通过安全的 Tailscale HTTPS/WSS 接入远程 `ruukoto` 个人 Agent，管理长效主会话、日常问答与后台工作。
- **安全 IPC 桥接**：主进程（Node `DesktopHost`）持有控制面凭据，通过严格的白名单 IPC（Preload）向渲染进程暴露受限操作，渲染层无直接底层访问权限。
- **现代前端视图与动效**：基于 React、Tailwind CSS、Radix UI 与 Lucide 图标库构建现代化深浅色三栏工作区。
- **Spotlight 全局快搜（⌘K）**：提供类似 macOS 原生体验的工作区会话与历史消息全文秒级即时检索。

### 边界与非职责
- 视图的纯内存状态投影与事件合并归 [view](view.md)。
- 后台核心任务调度归 [runtime](runtime.md)。
- 个人端的业务数据持久化归 [personal-durable](personal-durable.md)。

## 对外接口

### 1. 宿主与外壳架构

桌面客户端支持两种外壳运行时，底层复用同一套 Node 业务桥接层：

| 外壳运行时 | 技术栈 | 职责与特点 |
|---|---|---|
| **Electron 外壳** (主流) | Electron + Chromium | 提供完整的本地窗口管理、系统级通知、Dock 角标与操作系统钥匙串（Keychain）安全加密 |
| **MyGo 实验外壳** | Go + WKWebView | 轻量化探索架构，利用原生 WKWebView 渲染界面，通过标准输入输出管道与 Node 宿主通信 |

### 2. 渲染层核心交互与功能

| 功能模块 | 快捷键 / 入口 | 核心功能与交互 |
|---|---|---|
| **Spotlight 全局检索** | `⌘K` 或顶栏搜索图标 | 瞬时搜索当前实例下所有工作区会话标题与消息正文，高亮匹配词并一键定位跳转 |
| **工作区与会话树** | 左侧边栏 | 支持添加工作区目录、新建分支会话、切换安全模式与配置模型参数 |
| **时间线与对话区** | 中间主画布 | 流式呈现用户输入、模型思考过程（Thinking）、代码生成与结构化提问卡片 |
| **辅助检查抽屉** | 右侧边栏 | Tab 切换：查看代码 Diff 补丁、SubAgent 执行进展、Git Graph、只读文件树与后台服务日志 |
| **集成终端** | 底部抽屉 | 内嵌基于 xterm.js 的真实终端模拟器，直接在工作区目录执行日常编译命令 |

## 数据与状态

### 1. 客户端连接状态机

```mermaid
stateDiagram-v2
  [*] --> connecting: 启动探测本地后台或拨测远程服务
  connecting --> online: 认证通过，拉取基准快照成功
  connecting --> failed: 认证失败或服务未拉起 (终态，提示修复)
  online --> reconnecting: 网络波动或后台被意外终止
  reconnecting --> online: 重连成功，依据 seq 补齐事件
  reconnecting --> failed: 重试超限
  failed --> [*]
```

### 2. 本地与远程状态隔离

- **Coding 状态**：严格绑定本地 `<controlDir>`，消费 `@ruukoto/view` 的 `ViewState` 内存投影，草稿与未提交输入在客户端安全暂存。
- **Personal 状态**：严格绑定远程 Tailscale HTTPS Origin，基于 WSS 实时消费原生帧，配对凭据存入 macOS Keychain 加密保护。

## 主要流程

### 客户端接入与会话交互流程

```mermaid
sequenceDiagram
  participant Renderer as 渲染进程 (React UI)
  participant Preload as IPC 边界 (Preload)
  participant Main as 主进程 (DesktopHost)
  participant Backend as Coding 后台 / PA 远程

  Renderer->>Preload: request("open_workspace", { path })
  Preload->>Main: IPC 转发 (校验方法白名单)
  Main->>Backend: Unix Socket / WSS 发送 RPC
  Backend-->>Main: 返回会话快照与事件
  Main-->>Renderer: 事件推送更新 ViewState
  Renderer-->>Renderer: 响应式重新渲染消息流
```

1. **环境自检与按需拉起**：客户端启动时探测后台，若未启动则由主进程安全拉起 `ruukoto-code server`，免去手动开终端操作。
2. **多会话无缝切换**：左侧栏点击会话时秒级切换激活视图，历史消息异步分段拉取，保证流畅不掉帧。
3. **一键审批响应**：工具调用触发审批时，时间线即时弹出审批卡片，拥有者可查看参数 Diff 并一键批准或拒绝。

## 不变量与失败处理

- **渲染进程零特权**：Preload 严格限制暴露的 Node API，渲染进程无法直接执行操作系统任意命令或读写任意物理文件。
- **凭据硬件级加密**：所有配对令牌与 API Key 通过操作系统的安全加密存储（macOS Keychain / safeStorage）落盘，严禁明文写入配置文件。
- **后台与界面解耦**：桌面窗口关闭或前端崩溃绝不导致后台正在执行的代码任务被意外终止，重开桌面后自动恢复进度。

## 设计依据

- [桌面客户端作为又一个控制面客户端](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)
- [双端共用会话历史恢复](../../.agents/notes/implemented/architecture/2026-10-23-shared-history-recovery.md)
- [应用内 Spotlight 与历史定位](../../.agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md)
- [个人 Tailscale HTTPS 与 WebSocket](../../.agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md)
