# Agent Note: MCP 传输由宿主提供凭据而不持有旧项目

Status: implemented

[Cua 接入提案](../../proposed/architecture/2026-10-23-cua-official-mcp.md)复用本篇传输，目标绑定与连接寿命由消费者承担；提案不改变当前接口。

## 问题

[个人 durable 迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)只复用无任务状态的底层能力。[MCP 客户端](2026-09-23-mcp-client.md)的公开连接接口要求 McpServiceConfig 与 CredentialStore，个人端要复用 HTTP 就得伪造旧项目和配置；它们原本是 type import，问题是公开接口耦合，并非运行时加载旧 core。

## 决定

`mcp/transport.ts` 持有 SDK、端点校验、钉源 fetch、发现、调用和错误分类。`connectMcpEndpoint` 接受服务标识、固定端点、超时、可选的逐请求 token resolver 及宿主原请求/应答记录钩子，不接受任意 fetch、headers、OAuth 刷新或请求配置。调用方持有连接并负责关闭，传输不持有任务、审批、项目或凭据存储。

resolver 由可信宿主核实原凭据的目标、用途和来源范围；接口本身不提供这些授权。没有 resolver 才匿名；已配置 resolver 返回空 token 或抛普通异常时，在发出该请求前报静态 auth_failed，不降级匿名、不复述异常里的秘密。宿主主动抛出的 McpError 继续保留分类与可读说明，调用方须保证说明没有秘密值。

`mcp/client.ts` 继续适配旧 McpServiceConfig/CredentialStore，每请求调用 getForUse 核对 projectId/mcp 范围与 host；它重导出原符号，新旧入口共用同一个 McpError 构造器。Runtime、工具计划、路由器和 Driver 的入口、调用参数与关闭归属不变，不改旧数据、依赖或包 exports。旧配置入口仍负责 purpose/header 校验，本片不把旧 wrapper 宣称为完整的逐请求用途校验。

分页由锁定 SDK 的 listMaxPages 限制为最多请求 16 页，达到上限且仍需继续分页时抛 too_many_pages，不将超限结果当成功清单返回；成功汇总后最多 64 个工具，每页沿原超时预算。SDK 的无 cursor listTools 本来就会自动汇总，外层循环不能限制其请求次数，因此不再重复手写分页；重复游标仍沿 SDK 的结束规则，不新增协议判定。

HTTP 关闭、取消与超时只结束本地等待。MCP 服务可继续执行，客户端不能据此提供远端停止证明；Linux scope 的本机停止证明也不适用于远端。[MCP 写工具](../feature/2026-09-23-mcp-write-tools-approval.md)的不重发和未知效果规则继续成立。个人消费者通过[原生工具与外部证据](2026-10-17-personal-durable-mcp.md)钉定原请求并保存完整应答；共享传输提供原 SSE 流恢复 GET，只读取匹配原请求的迟到终结应答，不重发 tools/call。游标与同事件应答一起交宿主持久化，缺证据保留未知。

## 既有记录审计

按 MCP、凭据、取消、停止证明和 durable 检索 active notes。[迁移总提案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)、原 MCP 客户端、MCP 写工具及[完全访问命令](2026-10-17-personal-full-access-commands.md)部分重叠，保留并互链；本篇仅持有传输和旧装配的接口分工，不取代权限、HTTP 取消或命令停止决定。其他执行、业务、渠道与调度记录无关，没有完全吸收或过时提案。

## 备选方案

- 直接沿旧 connectMcpService 构造项目及凭据对象，几乎不动共享代码；不选，因为个人端没有旧项目，伪造对象会把旧配置领域带回新产品，也不能准确表达个人来源范围。
- 复制一份个人 MCP 客户端，可分别修改两个产品；不选，因为协议、钉源、限额和错误分类没有产品差异，复制会造成两份安全实现的维护。
- 保留原分页循环，可以少改已有实现；不选，因为 SDK 在循环第一步就汇总全部页，保留它会继续违反已声明的 16 页限额。直接使用 SDK 限额与结构化错误即可恢复约束。
- 用持久 Linux worker 或 HTTP DELETE 作为远端停止证明，可统一命令式接口；不选，因为它们只能证明本机进程或传输会话结束，不能证明远端工具停止，且没有新增 stdio 要求。

## 后果

两个产品可共用纯 HTTP 传输，旧调用者继续使用原接口。代价是宿主仍须提供逐请求授权核实；HTTP 操作丢失结果后没有通用的远端停止证明，后续 durable 消费者必须保存未知并等待可信核实，不能重发或提前释放工作。回归与独立审查见[实施工单](../../../../.scratch/personal-pi-durable/issues/27-mcp-transport.md)；本篇只持有共享传输；个人入口与持久恢复见上述记录，不证明真实 MCP、模型或 IM 可用。
