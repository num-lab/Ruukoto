# 02 将 Cua 图片送入双端模型与历史

Status: ready-for-human

## 目标与边界

实现[规格R5](../spec.md#r5-图片进入模型与历史)。复用既有图片存储和 provider 路径，交付图片内容转换，不修复全部 HTTP/SSE 传输，也不运行真实桌面。

## 方案

1. 在 packages/agent/src/mcp/tools.ts 及实际结果调用方增加有界内联图片处理；复用 artifacts.ts，不把 base64 作为文本交模型。由共享无状态校验识别 MIME、数量、单图大小与顺序，限制值见R5。
2. Code 将真实图片产物与原工具操作/JSONL/模型请求关联；Personal 经 personal-mcp.ts、personal-media.ts/registerImages 批量关联原 pi.tool Task，不改成旧 Task Store。
3. 纯图片、文本混图、多图和 isError 图片按原顺序保存。完整动作应答已收到而图片失败时只报图像问题；未拿到完整应答由03传输分类处理。
4. 新历史字段或产物引用须有明确兼容读取；旧文本历史和普通 HTTPS MCP 保持原行为。实际模型输入保存可重建的工具定义和图片引用。
5. 更新 docs/modules/agent-tools.md、personal-durable.md；模型可见说明按 agent-facing-text 取实际快照。没有新命令就不改无关入口。

## 进展与交接

- 当前角色与阶段：工程实施与独立实现审查通过，待03组合与05真实环境验收。
- 下一角色与动作：03复用共享mcpImages与现有双端结果转换，补Cua发送前视觉模型检查和48MiB消息预算，再交05正式入口验收。
- 当前内容：在6477dabe规划提交上实施；Code图片绑定原toolResult及task.tool_result，Personal保存version 1 imageProjection与不可改entry，批量媒体登记仍归原pi.tool。理由和兼容读取见[决定](../../../.agents/notes/implemented/architecture/2026-10-23-mcp-image-results.md)。
- 阻塞与恢复条件：02离线实现无需外部环境；正式交付需03的消息预算及Cua动作前能力闸门，真实视觉效果由05验收。当前不以普通HTTPS工具的未知返回类型拒绝文本模型。

## 验收与证据

工程离线检查通过：mock MCP覆盖纯图、混图、多图、isError附图、畸形base64/MIME、数量和单图上限、落盘失败与历史损坏；实际provider HTTP请求含图，JSONL/请求证据只存引用，历史重读与Personal重开均不再调用远端。坏图/磁盘失败保留原动作返回事实，并在实际模型输入提示勿重试原动作。

- `npm run check:static`通过；`git diff --check`通过。
- `npx tsx --test test/mcp-images.test.ts test/24-mcp.test.ts test/personal-mcp.test.ts test/personal-media.test.ts test/59-system-prompt.test.ts`：68/68通过；最后补JSONL解析恢复、缺引用拒绝、Personal实际请求证据和pretty JSON文字截断断言后，`--test-name-pattern='图片'`的12条图片用例再次全部通过。最后代码与测试的`npm run lint`、`npx tsc --noEmit --pretty false`通过。
- `npx tsx --test test/09-artifacts.test.ts test/25-mcp-write.test.ts test/90-inbound-media.test.ts test/personal-mcp-recovery.test.ts test/personal-mcp-controls.test.ts test/personal-browser.test.ts`：65/65通过；涵盖原审批、未知不重发、SSE恢复与既有图片调用方。
- 工具定义、参数schema和系统提示未改；模型新增结果与失败提示由实际模拟provider请求和引用快照断言覆盖。真实模型/桌面未运行，不记产品体验通过。

产品主观取舍在02不适用；05的真实视觉与正式调用链验收仍待完成，不能用本单离线结果代替。

独立实现审查由不同执行上下文`/root/image_implementation_review`直接读取工单、实际diff、调用方与文档完成，结论通过，无未解决阻断。审查者亲自运行11条图片窄用例与5条旧行为兼容用例；最终文字预算修复后再跑新增1条窄用例通过，并单独核实缺图片引用拒绝与旧文本原样读取。最初发现的Personal多图事务读写错误已修复并复测；批量登记PersonalError回滚降级由只读核对覆盖，未直接注入该阶段错误。审查者未重复全量静态检查、真实模型或桌面；作者静态证据与05缺口如上。

## Comments

2026-10-23：只保留图片到模型与历史的必要工作；网络输入预算由03的官方 stdio 接口承担，旧06不作为本单前置。

2026-10-23：02离线图片链实施和独审通过；多图批量登记与文字/图片独立预算已落地。03显式接手Cua动作前视觉能力闸门与48MiB消息预算，05接手真实正式入口与模型验收，未启动真实桌面或部署。
