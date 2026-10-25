# Pi 内置 MCP 与 Ruukoto 当前能力比较

调研日期：2026-10-26。对象是官方内置 MCP，不含第三方 adapter；上游固定 `v1.3.0`，commit `71023aec1546d6d677a65669c5665c0927ce0dd0`。本记录是调研证据，不是迁移决定。

## 结论

Pi 已覆盖普通 MCP 客户端功能，并增加通用 stdio、OAuth 和 Resources；可以复用，但不能直接替代 Ruukoto 整套 MCP 行为。审批、凭据与配置修订、持久请求证据、未知效果及 Cua 管理仍需宿主适配。

| 能力 | Pi 1.3.0 内置支持 | 对本项目的覆盖 |
| --- | --- | --- |
| 服务连接 | Streamable HTTP、通用 stdio、Bearer、OAuth；不支持旧版 HTTP+SSE | 通用连接范围更广 |
| 工具 | 发现、调用、过滤；direct/deferred/codemode/hidden | 覆盖按需发现与允许范围 |
| 结果 | 文本、图片、结构化结果；长文本写临时文件 | 类型覆盖，临时文件不等于本项目持久产物 |
| Resources | 列表、模板、读取 | 比当前更多；不渲染 MCP Apps |
| 审批 | 所有 MCP 调用经过 tool_call/tool_result，包括 codemode | 有拦截点，本地审批与单次消费仍须实现 |

依据：[MCP 文档][mcp-doc]、[结果处理][tools]。本次未将 Prompts、Sampling、Elicitation 或异步 Tasks 计为内置扩展已提供的能力。

## 装配与适配

Code 仍固定 [pi-coding-agent 0.85.1](../../packages/agent/package.json)，没有这套内置 MCP；[封闭 ResourceLoader](../../packages/agent/src/session-factory.ts)仅加载宿主扩展。Personal 使用独立 [pi-durable 1.3.0](../../apps/ruukoto/package.json)，同版本号不表示能直接加载 Coding Agent 扩展。上游 SDK 也要求显式加入 `createMcpExtension()` 并绑定生命周期。[SDK 说明][sdk]

内置扩展公开 `loadConfig`、`createTransport`、`credentials`、`updateConfig`，可接现有宿主配置。[扩展接口][extension] 另有独立 `@earendil-works/pi-mcp` 1.3.0，不依赖其他 Pi 包或官方 MCP SDK，公开客户端、OAuth 和测试入口；HTTP 可注入 fetch，transport 可包装 `send`／`onMessage`。[包声明][package]、[客户端说明][client]、[传输接口][transport] 因此 Personal 可评估复用底层包，无需换成 Coding Agent 运行时。

这些接口不自动提供本项目的产品行为：Code 本地副作用分类与 Personal 逐次审批；每请求核实凭据用途、目标和指纹；发送前同事务保存原 JSON-RPC 请求及批准消费；独立记录远端结束与业务效果；跨重启保存原 SSE 身份并只查原流；图片哈希、归属与历史引用；Cua 的固定制品、主会话占用、观察前置、停止证明和人工恢复。依据：[共享传输](../../packages/agent/src/mcp/transport.ts)、[个人 MCP](../../apps/ruukoto/src/personal-mcp.ts)、[Code Cua](../../packages/agent/src/mcp/code.ts)。

## 重试差异与验证缺口

Pi 对普通工具调用的 transient HTTP 错误不重试；连接初始化与资源读取可重试。原 POST 直接返回会话过期 404 时，首次 `McpSessionExpiredError` 会建立新会话并重发请求，也覆盖 `tools/call`；源码认为该请求被过期会话拒绝、尚未执行。已接纳响应流的恢复 GET 返回 404 则被传输转换为本地失败，不进入上述重发分支。因此不能把正常会话恢复描述成未知写入的自动重放。宿主仍须区分真实远端应答和客户端合成错误，后者不证明原业务未执行或远端已结束。[运行时源码][runtime]、[响应流恢复][stream]

本次仅核对本地与固定上游源码，未安装、升级、实现适配或运行真实 MCP／Cua。OAuth 全部重试分支、持久恢复接入和现有回归是否保持尚未验证；接口存在不等于替换验收通过。

[mcp-doc]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/mcp.md
[tools]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/tools.ts
[sdk]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/sdk.md#codemode-mcp
[extension]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/index.ts#L69
[package]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/package.json
[client]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/README.md
[transport]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/transports/transport.ts
[runtime]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/extensions/mcp/runtime.ts#L246
[stream]: https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/mcp/src/transports/streamable-http.ts#L355
