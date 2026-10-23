# 02 将 Cua 图片送入双端模型与历史

Status: ready-for-agent

## 目标与边界

实现[规格R5](../spec.md#r5-图片进入模型与历史)。复用既有图片存储和 provider 路径，交付图片内容转换，不修复全部 HTTP/SSE 传输，也不运行真实桌面。

## 方案

1. 在 packages/agent/src/mcp/tools.ts 及实际结果调用方增加有界内联图片处理；复用 artifacts.ts，不把 base64 作为文本交模型。由共享无状态校验识别 MIME、数量、单图大小与顺序，限制值见R5。
2. Code 将真实图片产物与原工具操作/JSONL/模型请求关联；Personal 经 personal-mcp.ts、personal-media.ts/registerImage 关联原 pi.tool Task，不改成旧 Task Store。
3. 纯图片、文本混图、多图和 isError 图片按原顺序保存。完整动作应答已收到而图片失败时只报图像问题；未拿到完整应答由03传输分类处理。
4. 新历史字段或产物引用须有明确兼容读取；旧文本历史和普通 HTTPS MCP 保持原行为。实际模型输入保存可重建的工具定义和图片引用。
5. 更新 docs/modules/agent-tools.md、personal-durable.md；模型可见说明按 agent-facing-text 取实际快照。没有新命令就不改无关入口。

## 进展与交接

- 当前角色与阶段：方案者；独立方案审查通过，尚未实施。
- 下一角色与动作：实施者先做离线图像及 provider 接线，03复用同一结果转换。正式交付需03的消息预算。
- 当前内容：基点14ee3d00，未提交规划快照见[review.md](../review.md)。
- 阻塞与恢复条件：无需外部环境；真实视觉效果由05验收。

## 验收与证据

工程待实施：以 mock MCP 结果覆盖纯图、混图、多图、畸形base64/MIME、上限、落盘失败和历史损坏；断言实际 provider 请求含图且历史重读不产生第二次工具调用。复用 test/09-artifacts.test.ts、24-mcp.test.ts、personal-media.test.ts、personal-mcp.test.ts 中受影响用例，必要时加一份窄图片测试。产品体验待05；真实模型缺前提时不记通过。

## Comments

2026-10-23：只保留图片到模型与历史的必要工作；网络输入预算由03的官方 stdio 接口承担，旧06不作为本单前置。
