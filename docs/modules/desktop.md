# 桌面客户端

## 职责与边界

`apps/desktop` 是 macOS 上的控制面客户端，与 TUI 共用后台。当前提供 Code 目标的连接状态与工作区列表；工作区与会话操作、对话、审批和 Personal 目标尚未开放。后台事实只经控制面取得，不读取数据库、JSONL、工作区文件或 git。

## 对外接口

主进程持有令牌、`ControlConnection` 和后台拉起。preload 只向渲染进程暴露 `subscribe(target, listener)`、`request(target, op, params)`、`pickFolder()` 与 `reveal(path)`。主进程校验 IPC 来源和操作名单；当前仅开放本地 `reconnect`，不转发后台操作。错误作为 `{ code, outcome, message, versions? }` 响应数据跨 IPC 传递，保留应答丢失分类。

渲染进程使用 React 与 Tailwind，消费 `@ruukoto/view` 的快照和事件投影。开发与构建命令见[开发说明](../development.md#桌面客户端)，启动与故障恢复见[操作手册](../usage.md#桌面客户端)。

## 数据与状态

连接目标由产品身份、socket 和令牌来源组成，Code 固定为 `ruukoto-code`。连接状态沿用 control 的 connecting、online、reconnecting、failed 与 closed；版本被明确拒绝后停在 failed，仅由拥有者重新连接。令牌只在主进程内存；本模块不保存业务资料或令牌。日常后台仍使用自己的档案与日志。

## 主要流程

日常应用启动时执行一次登录 shell，取得 node 与环境，在采用这份环境后显式解析 Code 的数据、agent、控制目录。`ensureBackend` 先探测已有后台；需要启动时用登录环境中的 node 执行构建时记录的仓库 bin。后台脱离运行，关闭应用只关闭连接。

受管开发前端使用启动器清洗后的环境，从开发控制目录读取 owner.token，不执行登录 shell，也不调用 ensureBackend；后台重载后由 ControlConnection 自动重连。桌面源码由 electron-vite 监听，渲染进程热更新，主进程重建后重启 Electron，preload 重建后重载渲染进程。启动器负责整组进程退出。

## 不变量与失败处理

窗口启用 sandbox、contextIsolation，关闭 nodeIntegration。sandbox preload 构建为单个 CommonJS 文件；主进程与 preload 除 Electron、Node 内置模块外的依赖全部打包。生产 HTML 的 head 首个元素是严格 CSP meta；开发页面只使用带本次 nonce 的响应头策略，放行 dev server 的 HTTP 与 WebSocket 源，不开放 unsafe-inline。开发页面仅允许对配置的完整文档 URL 自身重载；其他导航被拦截，只有 HTTP(S) 链接交给系统浏览器。

版本不一致显示双方版本与更新方向：客户端较旧时重建应用；受管后台较旧时重启开发启动器；日常后台较旧时按当前 control.sock 的 lsof 指引核对唯一 PID、用户和完整后台命令，由拥有者手动结束后重新连接。未查到监听进程时先核对命令是否成功，多匹配或无法核实时停止操作。桌面客户端不发送进程信号。仓库移动或 node 不可用会提示修复环境或重建。

## 设计依据

- [桌面客户端提案](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)
- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)
- [开发启动器](../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)
