# agent-browser 接入事实调查

调查日期：2026-10-14。仓库基线：`f89a1a74409e45f1c5f26827b75faa632dde996e`。本文件是只读源码与官方资料调查，未安装或启动真实浏览器，不构成运行验收。

## 上游基线

官方 [v0.39.0 发布](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.0)提供 CLI 原生二进制与校验值。[npm 包](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/package.json)声明 Node >=24，与本仓库 Node 22/24 矩阵不完全相同；可优先验证固定版本原生二进制，不以 npm wrapper 看似兼容替代支持证据。[安装文档](https://agent-browser.dev/installation)要求另备 Chromium，Linux 还需要系统库。

[官方 MCP](https://agent-browser.dev/commands#mcp-server)使用 stdio，并在内部调用 CLI；当前没有核实到受支持的 JavaScript 库接口。CLI 的 snapshot 提供可访问性树与元素引用；截图写文件，MCP 可同时返回图片块。CLI 与 MCP 不能消除浏览器生命周期管理的需要。

[会话文档](https://agent-browser.dev/sessions)区分独立 session、持久 profile 与附接已有浏览器；共享 CDP 不提供独立 Cookie 隔离。[安全文档](https://agent-browser.dev/security)中的安全开关默认关闭，域名白名单与 CDP、profile、restore 等组合不兼容。首版仅完全访问，不借这些开关声称已实现现有受限模式。

[main.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/cli/src/main.rs)有 `AGENT_BROWSER_DAEMON=1` 前台入口，但 [connection.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/cli/src/connection.rs)中的普通 CLI 会检查配置指纹，缺失/变化时关闭并以 `setsid` 重启 daemon，连接失败还会自动再启动。直接调用内部前台入口不足以证明宿主能收回全部进程；不复制上游私有指纹算法作为集成契约。

独立审查发现确定的调用语义冲突：`connection.rs` 的 `send_command` 对读超时、EOF、reset、broken pipe 等重新调用 `send_command_once`，最多五次发送完整命令；[daemon.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/cli/src/native/daemon.rs)与 actions 分派未见按请求 ID 去重，官方 MCP 也调用同一 CLI。未找到关闭该重试的公开选项。因此未经修复的 v0.39.0 不能承担「已发出且效果未知时不重发」契约；宿主不重试、增加记录或只换 MCP 都不能解决。曾考虑修复版本、受支持的替代路径和最小补丁，当前选择以下官方正式发布路线，仍须通过响应丢失后的提交计数探针。

后续核实：官方 [PR #2085](https://github.com/vercel-labs/agent-browser/pull/2085) 于 2026-10-11 合入 [d9570915f4dd6504dee4070379d2c4f79d81dbb2](https://github.com/vercel-labs/agent-browser/commit/d9570915f4dd6504dee4070379d2c4f79d81dbb2)，非只读命令写入任意字节后失败返回 `outcome_unknown`，不再重发；只读命令仍允许重试。2026-10-14 查询官方 latest release 仍指向 v0.39.0，修复未发版。拥有者选择等正式 release；以上补丁/自构建只是曾考虑的路径，不是实施授权。

## 仓库现有能力

| 机制 | 已有实现与接入约束 |
| --- | --- |
| 会话工具集 | [tool-availability.ts](../../packages/agent/src/tool-availability.ts)：普通开发会话有 bash/skill/MCP；main 无 bash/MCP；SubAgent 依固定白名单装配，不能因安装技能自动取得浏览器工具 |
| 宿主工具族 | [host-tool-families.ts](../../packages/agent/src/host-tool-families.ts)：提供调用身份、审批、产物与效果未知记录，可承载共享浏览器工具；无需为 main 开放整套编码工具 |
| 受限执行 | [execution](../../docs/modules/execution.md)：原生受限环境禁止所需网络和 Unix socket；完全访问沿启动账户权限，仍不自动扩大工具集 |
| bash 生命周期 | [worker.ts](../../packages/agent/src/tool-worker/worker.ts)：每次 shell 退出后清理原进程组；不能假设 CLI daemon 可自然跨工具调用存活且会随任务停止 |
| 跨轮持有 | [driver.ts](../../packages/agent/src/driver.ts)虽持有会话 registry，每轮任务仍会清理，不能直接登记跨轮浏览器后宣称生命周期成立 |
| 图片历史 | 内置 read 支持视觉块并进入 JSONL 与 prompt 快照；main 没有该编码工具，浏览器截图需直接提供图像结果；read_artifact 的 base64 文本不等于模型视觉输入 |
| 图片产物 | [artifacts.ts](../../packages/agent/src/artifacts.ts)已有 importImage/readImage；拥有者的 read-artifact CLI 可导出二进制，但默认 256 KiB、单页硬上限 720 KiB，目前不自动分页，完整截图文件需覆盖这个缺口 |
| MCP | 当前只启用远程 Streamable HTTP，图片只保留类型说明；接官方 stdio 并非现成配置，需同时补进程生命周期、入口与图片返回 |

## 关联决定

以下均为部分重叠、继续沿用的独立决定，无需废弃或改写原决定：

- [两个产品](../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)：产品与档案隔离、共用底座。
- [MCP 客户端](../../.agents/notes/implemented/architecture/2026-09-23-mcp-client.md)：当前远程传输及 stdio 的启用前提；浏览器专属工具不等于放开通用本地 MCP。
- [当前账户完全访问](../../.agents/notes/implemented/feature/2026-10-12-full-access-current-account.md)：免操作审批、真实任务授权、未知效果不重放。
- [个人原生执行](../../.agents/notes/implemented/architecture/2026-10-12-personal-native-sandbox.md)：现有受限后端与停止语义。
- [读取图片](../../.agents/notes/implemented/bug-fix/2026-10-12-read-images.md)：实际图像输入进入历史、纯文本模型拒绝、大小上限明确失败。

调查开始前不存在 proposed/rejected 目录；未发现既有 agent-browser 接入提案。Web Search 工单曾明确不包含浏览器，不阻止另立本工单。

## 尚需真实验证

上游 [browser.rs](https://github.com/vercel-labs/agent-browser/blob/v0.39.0/cli/src/native/browser.rs) 的关闭路径仅对自己启动的浏览器发送 `Browser.close`，外部 CDP 只关 transport；实际断开仍需探针。Chrome 144 提供[人工允许调试连接](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)；Chrome 136 起[传统调试端口不能直接用于默认资料目录](https://developer.chrome.com/blog/remote-debugging-port)，不能照抄只加端口的旧命令。无桌面 Linux 可尝试[官方 dashboard](https://agent-browser.dev/dashboard)提供的画面与键鼠入口，经 SSH loopback 转发给拥有者；尚未实测登录与实例隔离。

1. 固定版本原生程序与 Chromium 在 macOS/Linux、宿主 Node 22/24 环境的准备与启动。
2. CLI 多次调用是否保留同一页面；取消、显式关闭、后台退出、崩溃后的 daemon 与浏览器归属及回收。
3. CDP 附接后的断开、错误与超时是否保留拥有者浏览器及既有标签；登录准备与人工接管是否可执行。
4. 截图的真实图像输入、会话历史重建、完整文件导出及大图边界；模拟模型与真实视觉模型分别记证据。
5. 在命令已执行后丢弃 daemon 响应，分别注入 EOF、读超时与 reset，核对实际请求/提交次数。原版应暴露重发反例，修复后的路线只能发送一次并报告结果未知；另用无敏感信息的测试 Cookie 核实 profile 在 close/重启后保留。
