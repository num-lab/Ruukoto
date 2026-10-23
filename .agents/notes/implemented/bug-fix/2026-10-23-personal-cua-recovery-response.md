# Agent Note: Personal 电脑恢复先保存应答再校验截图

Status: implemented

## 问题

Personal 的拥有者恢复观察只在图片校验与保存成功后记录完整应答。工具返回 isError、无图或无效图片时，已收到的原应答只留在内存，档案只保存截图请求；冷启动或再次观察后无法从原调用详情重读。这违反 [Cua 接入](../architecture/2026-10-23-cua-official-mcp.md)保存取得应答的要求，也混淆了“收到应答”与“取得可接受截图”。

## 决定

恢复观察复用 stdio 的 recordCallProgress：收到应答即在同一事务追加 McpCuaRecovery 的 observe-response 事件及原操作的 responses 引用，再处理 isError、图片校验与产物保存。事件保留原操作和旧执行身份、对应 observe-request 的 requestEntry、新执行身份及完整请求/应答；原操作只存 EntryId，避免再次复制图片 base64。本机原调用详情沿引用分页读取应答正文；模型读取沿原 includeHost 限制。

observe-reset 只清当前 pendingObservation 和有效 observation，保留全部已取得应答。失败应答不生成有效观察或截图引用，不能接受；只有原有成功观察及执行身份检查通过，才允许接受。原动作的 effect_unknown 与 remoteEnded 保持。再次只读观察沿既有运行代，不增加沙箱停止或重启。

恢复核实应答引用、应答事件、原请求事件及新执行身份的双向关联和先后顺序，JSON-RPC id 必须对应原截图请求；删空引用不能使已存在的新应答事件绕过核实。旧档案没有 observe-response 事件时，缺省 responses 仍可读取；不升级无关档案或配置格式。

按 Cua、个人 MCP、图片与恢复观察检索既有笔记：本篇与 [Cua 接入](../architecture/2026-10-23-cua-official-mcp.md)、[个人 MCP](../architecture/2026-10-17-personal-durable-mcp.md)和 [MCP 图片结果](../architecture/2026-10-23-mcp-image-results.md)部分重叠，分别保留接入范围、原动作账本和图片投影的决定；其他设置、媒体与旧提案命中不改变。没有完全吸收或取代既有决定。

## 备选方案

- 只在 pendingObservation 补完整应答，改动少且可直接显示；不采用，因为重新观察会删除 pending，失败历史仍然丢失。
- 在原操作保存每次完整请求/应答，可复用详情的直接序列化；不采用，因为原事件已持有正文，复制图片 base64 会放大原操作，引用即可重读。
- 只记录失败分支，成功路径保持现状，事件数更少；不采用，因为图片校验、保存或 SDK 输出校验都可能在收到原应答后失败，传输钩子能覆盖这些出口。

## 后果

原操作档案保留恢复失败证据，拥有者可在冷启动或后续成功恢复后重读；代价是额外应答事件和引用，正文按个人档案保护，不进入诊断输出。现有成功观察仍保留其原证据，截图接受与旧等待结算规则不变。

离线回归覆盖 isError 附图、无效图片与缺图的完整应答、分页重读、冷启动、再次观察成功及接受、删空引用与缺失 id／null 应答按类型拒绝和原未知事实保留，并确认只重观察不再次停止或重启已运行的新代。真实模型、桌面与正式入口验收沿原验收工单另记。
