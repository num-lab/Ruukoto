# Agent Note: 设置拆出电脑与 Web 搜索类别

Status: implemented

## 问题

电脑操作（Cua）的配置与人工恢复埋在双端 MCP 设置页里，拥有者要在服务列表里辨认特殊服务类型；Web Search 在桌面端没有任何入口，Tavily 凭据与项目开关只能用 CLI 或配置中心管理。拥有者要求把两者各自列为独立设置项。

## 决定

- 新增托管类别「电脑」（Code/PA 左栏分组，沿[设置容器](2026-10-21-desktop-settings-shell.md)机制；分组取代页签见 [demo 设计](2026-10-28-desktop-settings-demo-design.md)）：Code 页管理本机 Cua Driver，PA 页管理 Linux 桌面沙箱，运行恢复控制一并迁入。数据不变，仍是 [Cua 官方 MCP 方案](../architecture/2026-10-23-cua-official-mcp.md)下的 MCP 服务存储；MCP 页只呈现 HTTP 服务，双页各自过滤，同名冲突按本类服务认领。
- Code 侧 `CodeMcpState` 增加 `mode`（mcp/computer）参数共用全部状态机：computer 模式下 `select(null)` 直接产出 cua-mac 草稿，冲突查找按 mode 过滤。PA 侧 `PersonalSettingsPageState` 的 computer 类别映射到 `revisions.mcp` 与同一保存入口。
- 新增普通类别「Web 搜索」，仅 Code、无页签、即时操作无草稿。Tavily 凭据经新专用 op `web_search_save_credential/remove_credential` 保存到固定名 `web-search` 绑定（host/purpose 固定，不接受名称、主机或用途参数），仿 `mcp_save_credential` 的用途收窄模式；`list_credentials` 复用已有放行。页面按名称排序呈现生效绑定（与服务端 `resolveCredential` 同序），CLI 创建的绑定只读并提示用原命令管理。
- 项目开关复用既有 `set_project_web_search`（补入 TuiOps 表与桌面白名单）；项目列表与当前值来自本地 view 快照（已含 `webSearch`/`settingsVersion`），写入带期望版本，冲突提示重选，事件驱动自动刷新。注：当日稍后 Web Search 已[收窄为实例级全局开关](../simplification/2026-10-25-web-search-global-toggle.md)，本页项目列表改为单一全局开关行，op 为 `set_web_search`。
- 边界保持：`add_credential`/`remove_credential` 等通用凭据写仍不向桌面开放；PA 的 web search（远端 personal tools 的 apiKeyEnv）不动远端管理协议，桌面不覆盖。

## 备选方案

- 复用通用 `add_credential`/`remove_credential` 开放桌面凭据写：被否，违背已记录的凭据边界，且桌面端拿不到用途收窄；专用 op 只多两个薄封装。
- Web 搜索页做只读状态：被否，桌面仍依赖 CLI，设置项无管理能力。
- 为电脑页建独立存储或 op：被否，Cua 复用 MCP 存储是[既有决定](../architecture/2026-10-23-cua-official-mcp.md)，只改 UI 归属即可，避免数据迁移。
- PA 侧同步开放远端 web search 配置：被否，需扩展远端 PA 管理协议与 worker，改动面与收益不成比例；拥有者确认仅 Code。

## 后果

桌面可独立完成 Web Search 全部配置；MCP 页不再出现电脑服务，两种恢复控制分别只在自己页面出现。专用凭据 op 的固定绑定名 `web-search` 与 agent 包导出常量保持一致（桌面 renderer 以注释对齐字面量）；同名单凭据冲突按 `credential_scope_mismatch` 拒绝，不改写不删除。测试：`test/desktop-settings-computer.test.ts`、`test/desktop-settings-web-search.test.ts` 及 mcp/backend/personal 系列更新；真实桌面交互与真实 Tavily 连接属外部验收。
