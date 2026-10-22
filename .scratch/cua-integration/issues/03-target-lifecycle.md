# 03 接入电脑目标、权限与恢复

Status: planning

## 目标与边界

实现[规格 R1–R4、R6](../spec.md#共同契约)，使 Code 本机 Mac 与 Personal Linux 桌面均有固定目标、原来源权限、持续绑定和可核实的停止/恢复。依赖 [01](01-transport-and-lifecycle-probe.md) 的通过版本与协议和 [02](02-mcp-images.md) 的图片链路；不将未经证明的网关能力带入产品。

主对话切片只适用于已登记的电脑目标，普通 MCP 来源与工具不变。保留两端运行状态的归属，不建立第三套任务系统，不新增通用 stdio 启动入口。

## 方案

1. 消费 01 的目标认领、绑定及原请求查询协议，先把确切的身份、状态/事件、接口参数和失败码补到本单并独立复审。没有完整协议与故障证据则不开始运行实现；路线变更回写规格/提案。
2. 在现有 MCP 服务配置增加可选电脑目标约束，使用具名类型、固定身份和修订，普通服务缺省语义不变。同步 core schema/Store、控制 ops、配置消费者，以及 Personal mcp 配置版本/保存/恢复和机器 settings 验证。新旧版本处理、未知字段拒绝及存量历史兼容要明确；内部进程接口不复制 wire 校验。
3. Code 在 Runtime/Driver 与工具路由接入绑定、来源筛选、目标注入、执行前认领核实和未决动作冻结；Personal 在独立 durable extension/原生 MCP 工具接入相同约束，复用个人配置代次、原批准消费和 evidence。不在 shared transport 里加载 core 或 durable。
4. 让 session、沙箱目标及执行身份由宿主注入并进入实际请求证据；远端原 schema 和宿主暴露的可调用 schema 都有来源，模型可见输入能从记录重建。所有调用及原定义查询共用宿主允许列表，原工具接口不能旁路调用未绑定目标。
5. 按 R4/R6 完成跨轮持有、认领冲突、暂停交还、继续时重新观察、取消、配置/权限变化、后台停止和冷恢复。效果分类使用原发送/下游终结证据，不能只沿现有 timeout/connect_failed/canceled 错误码白名单；覆盖网关 HTTP/自造 JSON-RPC 错误和响应预算中断。目标级未知覆盖下一任务、其他会话和端点别名；可查询原状态但不重发动作，不通过关闭网关假装 daemon 停止。
6. 增加最窄跨层测试，覆盖普通 MCP 不受影响、Code/Personal 资格差异、target 参数覆盖、旧批准失效、跨产品争用、连接重建后旧引用、执行后落盘失败和原响应恢复。所有分支按 error-handling 明确状态持有者及安全下一步。
7. 按实际改动同步 agent-tools、runtime、core、personal-durable、control 模块；包 exports 和依赖声明与消费者一并完成。模型工具定义和失败提示按 agent-facing-text 取实际快照。

## 进展与交接

- 当前角色与阶段：方案者；共同契约已写，执行端 wire 与固定版本待 01 证明。
- 下一角色与动作：分阶段方案已独立复核通过；01 完成后由方案者细化本单执行接口，再复审受影响部分后交实施。
- 当前内容：`develop`，基点 `419c8384fb8916660b9d84965885fd39b618fe25`；未提交文件见[review.md](../review.md)。
- 阻塞与恢复条件：01 无通过协议/版本及 02 无可用图片链路时不得开工；不能把待探针事实写成默认正确。拥有者已确认首版环境与权限，不重复请求这两项决定。

## 验收与证据

工程验收待验证。候选回归为 `test/24-mcp.test.ts`、`test/25-mcp-write.test.ts`、`test/62-tool-availability.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、`test/personal-mcp-config.test.ts`、`test/personal-mcp.test.ts`、`test/personal-mcp-recovery.test.ts`、`test/personal-mcp-controls.test.ts`；schema/控制面/设置有改动时追加对应 01/03/04/66 及 personal-settings 用例。01 的真实探针须通过实际管理器再核实，不能只测直连 Cua。修改时跑 `npm run check:static`，按真实改动面补构建。

证据放 `evidence/03-lifecycle.md`，逐项映射 R1–R4/R6，列实际终结证据和保留未知的反例。产品验收待 04/05 的正常入口。方案审查见[review.md](../review.md)，实现审查待执行。

## Comments

2026-10-22：不假定普通 MCP 的 HTTP session 是桌面锁，也不把 effect_unknown 标记等同于已经阻止后续电脑动作。

2026-10-22：共同契约独立复核通过；本单保持 planning，等 01/02 和实际 wire 补充复审，当前不能开始运行实现。
