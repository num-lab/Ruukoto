# Agent Note: Cua 直接复用官方 MCP 并收窄独占与恢复范围

Status: proposed

## 问题

已有方案把双产品电脑操作扩成跨产品目标认领、HTTP桥接与持久原回执执行服务，导致01不断追加原型和实机验收。拥有者在2026-10-23明确撤销跨产品同桌面独占保证，要求外部保存实验并回滚到e8479aa1之前。首版环境仍是Code本机Mac、Personal独立Linux沙箱，权限不变，已接受的人工核实恢复继续有效。

## 方案

直接使用官方MCP：Mac固定cua-driver mcp --direct，Linux固定cua mcp与既有sandbox，复用现有MCP SDK的stdio传输。程序与参数由可信宿主生成，保持原工具审批和模型循环；不开放任意命令的通用stdio配置。当前HTTP传输决定由本提案新增受控入口，原HTTP能力不变。上游依据与基线源码见[调查](../../../../.scratch/cua-integration/research.md)。

每产品实例仅保持一个主会话的电脑连接与串行调用。删除跨产品、跨实例、跨别名的目标认领，不建root注册表、全局锁或自建HTTP执行端。外部控制器和人类仍能改变桌面，因此观察必须更新，用户避免并行控制；独立Mac/Linux环境本来不共享桌面。

沿两端已有操作账本保存请求和结果，不要求Cua跨进程找回丢失原回执。未知冻结本档案的电脑入口；核实原执行停止后，拥有者检查并开始只读恢复，接受新图后开放新工作。原unknown和remoteEnded不伪造；Personal另记Cua专属恢复结算并同步全部阻塞消费者。Linux CLI关闭不等于guest停止，必要整沙箱停止须本人选择并保留磁盘。

图片复用既有ArtifactStore与Personal媒体链。以官方SDK消息限额控制stdio输入，解码前校验图像预算。接口和验收标准以[现行规格](../../../../.scratch/cua-integration/spec.md)为准，不把未实现能力写进当前模块说明。

### 既有决定审计

| 记录 | 处理 |
| --- | --- |
| [旧Cua提案](../../rejected/architecture/2026-10-22-cua-integration.md) | 过时提案转rejected，保留为何曾选桥接的历史；新规格取代全局独占与自建执行路线 |
| [MCP客户端](../../implemented/architecture/2026-09-23-mcp-client.md)、[共享传输](../../implemented/architecture/2026-10-17-mcp-transport-reuse.md) | 部分重叠，互链；新增Cua专用stdio，不改变HTTP认证与取消限度 |
| [个人MCP](../../implemented/architecture/2026-10-17-personal-durable-mcp.md) | 部分重叠，互链；只对Cua增加人工恢复结算，原remoteEnded含义不改 |
| [个人图片](../../implemented/architecture/2026-10-18-personal-browser-media.md)、[MCP写工具](../../implemented/feature/2026-09-23-mcp-write-tools-approval.md) | 部分重叠，互链；复用图片及原批准，不以结果处理失败触发重试 |

桌面设置等其他命中无关。e8479aa1之后的专用执行恢复与HTTP修复笔记已随用户指定回滚移出当前树，完整内容在[外部归档](../../../../.scratch/cua-integration/archive.md)，不复制成当前implemented决定。

## 备选方案

- 现成HTTP网关能沿用现有传输，但仍增加服务、TLS、认证与进程寿命转换；本机两种官方stdio入口已有固定执行程序，故不选网关。
- 自建执行服务可统一全局锁和原回执查询，但主要服务于已撤销的保证，且Cua原回执丢失仍无法重建，因此撤回。
- Cua原生SDK有直接调用与结构化错误，适合自带电脑控制的应用；当前两端已有MCP审批和结果链，另接SDK会维护两套工具适配，首版选择官方MCP。
- 任意stdio服务配置更通用，但扩大了宿主命令执行范围；只增加Cua两种受控启动配置。
- 完全不保留未知状态最省代码，但会在提交后丢答时重复动作；沿现有账本和人工恢复即可，不删这条已确认保证。

## 验收标准

01完成资料与备份即结束；02–04实现实际产品链和窄回归，05双端各一次可用流程与一次丢答恢复。相同制品/执行机制的历史证据复用，只补接线差异。跨产品争用和全局别名绕过从验收中删除。新验收项必须对应现行规格，不凭“完整性”不断扩充。

## 风险

去掉全局独占后，另一个产品或独立实例可能干扰同一桌面；本实例绑定不能阻止它。Mac direct权限归属取决于实际启动宿主；Linux核实停止可能需要中断整个沙箱并丢失未保存状态。已收回的HTTP修复不再位于产品树，既有HTTP问题需独立维护；新stdio能力尚待实现与正式验收。
