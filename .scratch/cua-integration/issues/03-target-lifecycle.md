# 03 接入官方 MCP、持续连接与人工恢复

Status: ready-for-agent

## 目标与边界

实现[规格R1–R4、R6](../spec.md#共同契约)及R5的 stdio 消息限额。固定 Code Mac direct 与 Personal Linux CLI；不创建跨产品桌面锁、自建 HTTP 服务或独立操作数据库。

## 方案

1. 在共享 MCP 旁增加受控 stdio 连接入口，使用现有 @modelcontextprotocol/client/stdio。复用 Client、schema、McpError 与请求/应答记录能力；发送钩子在 tools/call 写入前完成原记录与批准消费。原 HTTPS API 不伪装成本地命令，取消/关闭不能触发旧 tools/call 重发。
2. 固定两类 Cua 启动配置，程序、参数和最小环境由宿主生成。同步 packages/agent/src/mcp/store.ts、client.ts、tools.ts、core schema/配置事件、Runtime装配与 Personal mcp-config.ts；控制/settings消费者随配置接口修改。明确新版本、旧配置/历史兼容和失败拒绝；无需变化的持久格式不迁移。
3. 产品 Cua 管理器保留一个主会话绑定与持续连接，同实例其他会话拒绝抢占；真实窗口/元素引用留给Cua，目标覆盖在发送前拒绝。Personal 不再对 Cua 每次 finally 关闭，普通 HTTPS 保持原行为。每次调用的原 id/证据钩子重新关联，不能泄漏上次应答。
4. 沿两端原工具权限装配电脑调用。记录模型受限 schema 与实际请求；生命周期控制不暴露给模型。Node22/24 用离线进程夹具核连接关闭、取消和异常退出；SDK maxBufferSize 按R5设置，超限保留原已发送事实，不复制 SSE 修复。
5. 在原操作记录上追加执行身份和 Cua 恢复控制事实，复用已有原生身份/停止工具。Mac只核该direct执行单元；Linux先关受管CLI，随后由拥有者选择停止原沙箱运行代并核实，保留磁盘。旧结果未知保持，按R6顺序恢复，不重放旧Task或点击。
6. Personal 引入独立于 remoteEnded 的 Cua 恢复结算事实：停止证据、owner选择、新观察/接受关联原操作和执行身份。逐个同步 mcpUnresolved、mcpSourceBlocker/工作等待、配置保存阻塞、恢复校验、controls/summary与设置阻塞；追踪调用方到 personal-work 与 reports，不能只改主聊天。personal-tools.ts 的未决MCP/HTTP目标检查及 personal-mcp.ts 的反向HTTP互锁要按传输类型分支：保留HTTP端点互锁，Cua走本档案冻结，不对stdio配置执行 new URL(service.endpoint)。原远端应答字段与普通HTTP语义不动。Code冻结记录在冷启动工具开放前加载。
7. 同步实际受影响的 agent-tools、personal-durable、runtime/core/control 模块文档；只有新增模块才扩模块地图，exports/dependencies按真实调用方更新。

## 进展与交接

- 当前角色与阶段：方案者；独立方案审查通过，尚未实施。02提供图片转换接口，本单可先用离线结果夹具，交付前合验。
- 下一角色与动作：实施者先交最小stdio调用和记录，再在同一工单完成冻结/恢复与消费者；不另立多轮实机原型阶段。
- 02接口交接：共享`mcp/images.ts`提供mcpImages/MCP_IMAGE_LIMITS；Code沿formatMcpResult与原toolResult恢复，Personal沿原pi.tool的imageProjection与媒体registerImages。03在能识别Cua配置后，于真实发送前核实所选模型支持image，并用零发送回归证明；普通HTTPS不因未知结果类型整体禁用文本模型。该闸门与48MiB聚合预算是R5尚待本单完成的部分。
- 当前内容：基点14ee3d00，未提交规划见[review.md](../review.md)。
- 阻塞与恢复条件：官方固定制品如果不支持已选择入口，先给出具体差异再修方案；不能自动退回网关或扩展全局锁。

## 验收与证据

工程待实施。离线反例覆盖：异sandbox及来源拒绝、旧批准失效、持久请求失败时零发送、实际写后丢答仅一次、后台重启冻结、换本档案配置不能绕过、消息上限、恢复前置缺一拒绝、新截图后只开新工作。Personal已恢复的Cua可结束旧等待且remoteEnded仍false；普通HTTP人工说明依旧不能解锁。另用 personal-tools 的窄回归证明Cua未决记录不会使独立HTTP工具因URL解析而失败，HTTP/MCP原目标互锁仍成立。

新增 test/cua-mcp.test.ts（建议名）集中守住新连接与生命周期；按实际影响跑24/25-mcp、personal-mcp/recovery/config/controls及工作/报告消费者的窄用例。同一Cua进程应跨连续调用保持，关闭只回收自身；不新增跨产品/跨URL别名争用矩阵。03离线检查不冒充05正式桌面/模型验收。

## Comments

2026-10-23：移除原执行端协议、全局claim与持久原回执服务；保留现有操作历史及拥有者已接受的人工恢复。共享HTTP缺陷另行维护，不阻塞stdio路线。
