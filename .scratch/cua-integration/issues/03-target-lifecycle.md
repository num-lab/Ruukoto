# 03 接入官方 MCP、持续连接与人工恢复

Status: resolved

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

- 当前角色与阶段：双端离线实现、主工作区验证与独审完成；05已补双端正式丢答、冷冻结、停止核实、本人恢复选择与新工作，增量独审通过，本单验收完成。05发现的完整恢复应答未持久缺口已最窄修复、独审并集成检查通过；失败观察独立留证，原unknown／remoteEnded与接受条件不变。首次上游启动错误实际使用新端口，未改端口或启动方式。
- 下一角色与动作：本单无剩余实现或独立主观体验项；04／05已完成Personal本人管理体验及专用环境收尾，首版验收结束。
- 02接口交接：已复用mcpImages、formatMcpResult、imageProjection和registerImages；Cua动作前视觉闸门与48MiB聚合预算均已完成，文本模型零发送有回归，普通HTTPS不因此禁用文本模型。
- 当前内容：以057e3366为基线实施。Code schema50从49定向增加空列并保留HTTP/历史，控制协议38；Personal MCP version3承载具名Cua，旧version1/2与原remoteEnded语义保持。决定见[官方MCP与恢复](../../../.agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md)。
- 实作核对：固定CLI0.7.0的裸入口会优先连接已有daemon，Linux启动显式加全局--embedded，已独立核对固定源码并验证参数生成；不引入网关。启动失败仍保存原执行身份，停止未核实只冻结电脑，普通聊天继续。
- 管理接口交接：Code提供mcp_cua_status/stop/begin_recovery/observe/accept及get_tool_op_mcp；accept由程序回传status.observation.id。Personal提供/mcp/cua-recover的stop/begin/observe/accept，接受绑定detail.summary.cuaObservation，detail.recoveryImages返回图片引用。内部身份由界面管理，不要求用户填写。

## 验收与证据

工程离线验收通过，独立上下文/root/shared_review对共享传输、双端实现、相关调用方与证据复核后无未解决阻断。异目标、来源、旧批准、落盘失败零发送、慢记录跨取消/超时、写后丢答不重发、未知冷恢复、配置防绕过、消息预算、恢复缺步骤、旧观察接受与重观察失败均有窄反例。Code恢复观察准备后撤销仍零发送，新观察记录当前修订，原未知动作保留原修订。Personal恢复后remoteEnded仍false、原unknown保持，而来源/工作/报告/设置与配置等待可结算；普通HTTP人工说明仍不解锁，双向目标互锁保留。

主工作区check:static、两个桌面壳构建及签名校验通过；共享39项、Node22.19下stdio10项、Personal120项、核心/MCP/Code设置128项、唯一串行Code/native73项、工作/报告/定时76项及文件检索窄用例通过。最后的恢复发送复核增量另通过Code3项、ESLint和类型检查。精确命令、环境、独审范围与原失败见[工程证据](../evidence/03-offline.md)，Linux真实scope、独立无网容器停代/重启保盘见[原语证据](../evidence/03-personal-linux/README.md)。

05中的恢复应答存证修复新增5条先红后绿的窄回归，四个相关文件55/55通过；独审亲跑7条通过，主工作区另跑check:static与personal-cua的20条全部通过。旧档案兼容、失败不可接受、再次观察保留旧应答及原unknown不变均有反例，未重跑旧矩阵。修复补丁、实际版本和原件哈希见[05证据](../evidence/05-acceptance.md)。

本单无独立主观产品取舍。04已提供实际截图呈现，05已完成双端正式桌面／模型及本人业务检查、新图接受和一次新工作，真实原件与增量独审见[05证据](../evidence/05-acceptance.md)。旧unknown、缺失原response及Code收尾停止未核实均保留，不能概括为全部停止通过；Personal正常管理入口的本人确认和收尾亦已通过。未部署或推送。

## Comments

2026-10-23：移除原执行端协议、全局claim与持久原回执服务；保留现有操作历史及拥有者已接受的人工恢复。共享HTTP缺陷另行维护，不阻塞stdio路线。

2026-10-23：03工程实现、主树验证与独审完成。保持无全局锁与不重放原动作；04承接选择式管理和实际截图呈现，05承接正式双端验收。

2026-10-23：05双端正式恢复及Linux唯一新工作2→3增量独审通过，关闭本单；恢复应答存证补丁仍未提交，原失败记录不改判。
