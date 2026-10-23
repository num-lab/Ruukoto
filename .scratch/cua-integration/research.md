# Cua 官方资料与代码核对

核对日期：2026-10-23。代码基点：`14ee3d007bac3bb99cf104ad55c8aeccb7aa50a4`。当前官方网页、固定制品的历史实验和新产品实现是三种不同证据；本轮只读取资料，没有启动 Cua。

## 官方已经给出的方案

| 来源 | 已公开的能力 | 本方案如何复用 |
| --- | --- | --- |
| [Driver MCP](https://cua.ai/docs/cua-driver/guides/connect-your-agent) | 本机 Agent 可直接使用官方 MCP | 不另造电脑操作服务 |
| [Driver CLI 生命周期](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure#cua-driver-mcp) | macOS 默认代理官方 app；--direct 让 MCP 进程拥有 runtime 与权限归属 | Code 固定 direct；停止核实指向真实 runtime |
| [沙箱 MCP](https://cua.ai/docs/cua-cli/guides/mcp-server) | stdio、默认 sandbox 与按工具组授权；每次调用仍可覆盖 sandbox | Personal 保留一个 CLI，宿主固定目标并用最小权限 |
| [Driver 工作原理](https://cua.ai/docs/cua-driver/concepts/how-cua-driver-works) | session 不锁定目标；送达输入不等于应用改变 | 删除全局独占保证，动作后重新观察 |
| [SDK 指导](https://cua.ai/docs/cua-driver/guides/use-the-sdk) | 超时可能已执行；Unknown 不盲目重发；宿主重启需丢弃旧 client | 沿既有操作账本保留未知、人工恢复；不发明原回执查询能力 |
| [官方会话工具](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen) | session 资源归属与清理 | 仅用于本连接管理，不作为整机锁或跨崩溃回执 |

官方资料已覆盖基础接入和很多失败语义；不能把所有生命周期都说成未知。当前文档中的 SDK API 不自动等于固定 MCP/CLI 制品会透传同一个错误类型。以固定实际 tools/list、schema、退出行为和记录为准；不自动升级到 latest。

## 可复用的制品与实验

历史记录使用 Mac Cua Driver 0.38.0、Linux Cua CLI 0.7.0、guest Spacesd 0.6.0（embedded Driver 0.38.0）。Linux 镜像固定为 `ghcr.io/trycua/linux@sha256:d0f845852b717aca5f3692fbe244e724500847f22400f2f672c505623ed542bf`。完整二进制哈希、签名、OS 与工具清单在[外部证据索引](archive.md)；这些是已有实验版本，不代表当前最新版本。

旧源码核对使用 Driver 提交 `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`，Spacesd 对照提交 `1f9cffdeb8c70143a590bfebd7abe6c8d87bada9`。实验未证明镜像中的二进制与所有源码 tag 的签名构建对应，因此新接线继续记录实际版本/哈希；不以源码候选 API 代替已发布能力。

Mac direct 的权限、执行与停止，Linux 真实操作、截图缩放、guest 自动重启及人工恢复都有历史材料。不同外层 HTTPS/stdio 接法的结果不能无条件互换；只复用不随接法变化的前提。既有记录已经表明逐调用重连会丢 Linux 截图缩放，故正式 Cua 连接跨调用持有。

归档的 Mac direct 工具清单为62项、Linux最小CLI清单为24项，均未超过当前每服务64项限制；继续用固定最小权限与允许列表，不为本路线抬高全局工具数量上限。

## 回滚基线的接入缺口

| 现有位置 | 事实 | 最小工作 |
| --- | --- | --- |
| packages/agent/src/mcp/transport.ts | 只有 Streamable HTTP；有原请求/应答记录钩子 | 增加受控 Cua stdio 入口，复用 Client、schema 与钩子；不复制协议 |
| 已安装 @modelcontextprotocol/client@2.0.0 的 ./stdio | StdioClientTransport 已有 command/args/env、pid、close 和 maxBufferSize | 用现有依赖；关闭仅证明客户端责任，不夸大为 guest 停止 |
| packages/agent/src/mcp/tools.ts、artifacts.ts | MCP 结果只给文本；已有图片产物能力 | 接内联图片，不增大文本截断上限冒充图片 |
| apps/ruukoto/src/personal-mcp.ts | 每调用重连；started/remoteEnded/原证据已持久化 | Cua 分支持续连接；复用原 Task，不新增任务系统 |
| personal-mcp-config.ts、personal-mcp-controls.ts | 配置和恢复依赖原远端结束；人工说明不能改变 remoteEnded | 增加 Cua 专属恢复结算并同步所有阻塞消费者 |
| personal-tools.ts、personal-mcp.ts 的HTTP互锁 | 当前假设每个MCP服务都有URL endpoint | 按传输分支，保留HTTP互锁，Cua使用自身冻结记录 |
| personal-media.ts | provider 前核实图片来源与哈希 | 复用 registerImage，保留原 pi.tool 归属 |

新 stdio 接入尚未实现，不能用历史探针宣称正式产品通过。共享 HTTP 的 Node22 连接回收及响应读取缺陷和候选修复已归档；它们作为独立维护事项保留，不再阻断 Cua 的 stdio 方案。

## 不再进行的调查

不再验证跨产品桌面认领、跨 URL/凭据的全局锁、自建原回执查询服务或通用 HTTP 网关。没有跨进程原回执时采用拥有者已接受的人工核实恢复。新代码只需对真实差异补窄测试；双产品最终体验由05验收。
