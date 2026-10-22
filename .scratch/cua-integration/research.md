# Cua 接入调查

核对日期：2026-10-22。仓库基点：`419c8384fb8916660b9d84965885fd39b618fe25`。本文件区分源码/官方文档事实和待实测的接入推论；没有安装 Cua、运行网关或访问真实桌面。

## 现有代码

| 入口 | 已核实事实 | 接入影响 |
| --- | --- | --- |
| [共享传输](../../packages/agent/src/mcp/transport.ts) | Streamable HTTP、固定源与 Bearer resolver；HTTP 仅回环模拟；原请求/应答及 SSE 游标钩子；无 stdio | 接 Cua 需要传输适配；不能复制 SDK 协议或取消既有凭据核实 |
| [远端 schema](../../packages/agent/src/mcp/schema.ts) | 根对象、16 KiB 上限、TypeBox 编译；每服务最多 64 工具 | 实际 tools/list 必须过现有预检，不以文档里的工具名代替 |
| [Coding MCP 结果](../../packages/agent/src/mcp/tools.ts) | `formatMcpResult` 只返回文本，非文本类型列为未展示；文本 32 KiB 内联、1 MiB 产物截断 | 图片需要独立字节预算和图片产物，不能简单增大文本限额 |
| [Coding 路由](../../packages/agent/src/tool-router.ts) | 统一审批，调用前复核；写工具传输未知登记 effect_unknown | 仍需 Cua 目标级暂停与占用，不应假定普通 MCP 已处理桌面归属 |
| [Personal MCP](../../apps/ruukoto/src/personal-mcp.ts) | 每次调用连接、发现并在 finally 关闭；原应答保存，模型得到状态/分页文本 | 需要证明 Cua 跨调用 session/引用兼容，图片须投影为视觉块 |
| [Personal 媒体](../../apps/ruukoto/src/personal-media.ts) | 图片与原生工具 Task、pi.tool-result、会话和产物绑定；provider 前核实并还原 | 复用 registerImage；不能把 MCP base64 直接塞入历史绕过归属校验 |
| [Coding 浏览器截图](../../packages/agent/src/browser-tools.ts) | 使用 ArtifactStore.importImage/readImage 与 recordArtifact | 可复用图片持久链路；浏览器管理器的所有权不能直接套在远端 Cua 上 |

## 上游一手来源

- [Cua Driver 接入](https://cua.ai/docs/cua-driver/guides/connect-your-agent)：常规入口为 `cua-driver mcp` stdio；Driver 不调用模型，Agent 自己持有循环。
- [Driver SDK](https://cua.ai/docs/cua-driver/guides/use-the-sdk)：提供 TypeScript/Python 原生调用；macOS 默认连接官方应用 daemon 以保留系统授权归属。SDK 是备选执行适配，不代表当前仓库已安装或可直接打包。
- [远程与虚拟机](https://cua.ai/docs/cua-driver/guides/vms-and-remote)：Driver 在被控电脑运行；远控可用 SSH。Personal 远控 Mac 不属于已确认首版。
- [Cua 沙箱 MCP](https://cua.ai/docs/cua-cli/guides/mcp-server)：`cua mcp` / `cua daemon mcp` 暴露沙箱/电脑工具，`--sandbox` 为默认目标，每次调用仍可带目标；权限可以按工具组收窄。因此默认目标不是隔离证明。
- [Driver session](https://cua.ai/docs/cua-driver/reference/mcp-tools/apps-windows-and-screen)：隐式 lifecycle session 属于认证 transport lease；有公开 session label 和结束工具。文档没有证明这相当于 Ruukoto 跨产品的桌面独占或持久原操作回执。
- [Supergateway](https://github.com/supercorp-ai/supergateway)：支持 stdio 到 Streamable HTTP、stateful、监听地址和 API key 文件；候选可减少自写协议转换。部署需固定正式版本、校验制品并核对对应版本参数，不使用运行时 npx latest。
- [Supergateway 正式发布](https://github.com/supercorp-ai/supergateway/releases)：作为版本选择入口；本轮不把最新版本或发布说明当作与 Ruukoto 的组合测试通过。

以上页面读取结果属于资料核对；对运行时是否重放、连接关闭后引用是否存活、原响应是否可恢复及子进程是否结束的判断，必须由 [01](issues/01-transport-and-lifecycle-probe.md) 的探针提供。

## 待证明的工程事实

1. 固定 Cua Driver/Cua CLI、镜像、网关与 Node 22.19/24.15 的组合；macOS 授权和 Linux 桌面准备方式；无需云账号的本地沙箱路线可运行。
2. 原始工具定义能通过现有 schema/分页/数量限制；最小工具集足以完成看图和操作；Driver 与沙箱参数中的目标/session 不可越过宿主绑定。
3. Code 任务连接、Personal 逐调用连接、HTTP 重连与 Cua transport lease 的对应关系；窗口/元素引用跨调用的真实寿命。
4. 目标身份和执行端独占的实现；单网关多 HTTP session、两个 URL 别名或第二个网关不能并行控制同一目标。没有现成能力时先复审最窄适配契约。
5. 下游动作执行后丢上游应答，实际动作仅一次；原 SSE 重读或原操作查询可取得终结证据；无法证明结束时保持不可用，而非自动重连后继续。
6. 图片大小、原响应体界限与恶意多图的内存上限；纯图片/错误附图也能保存并进入两个产品的实际 provider 请求。
7. 产品 HTTPS 端点的部署与证书信任在本机及 Linux 均成立；不能以测试回环豁免绕过原生产端点决定。

这些是有明确通过标准的前置实验，不是已确认可行的实现事实。01 未通过时不得交付电脑写操作。
