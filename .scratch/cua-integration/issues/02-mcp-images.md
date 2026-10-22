# 02 将 MCP 图片结果接入两端模型与历史

Status: ready-for-agent

## 目标与边界

实现[规格 R5](../spec.md#r5-图片进入模型与记录)，让两端的 MCP 内联图片可验证、可重建并真正进入模型；保持普通文本和原执行事实。可先用模拟 MCP 实施，不依赖 01 的真实桌面准备；本单不增加电脑操作授权或远端资源下载。

## 方案

1. 沿 `packages/agent/src/mcp/transport.ts`、`tools.ts`、`tool-router.ts` 与 `apps/ruukoto/src/personal-mcp.ts` 追踪完整结果/错误/历史及所有调用方。钉定响应体、单图、图数和累计解码预算，在解码/聚合前拒绝超限；复用现有 MIME 与图片字节校验，不扩大文本截断预算。新增响应未完整读取的类型化失败须保留发送和终结证据，两个消费者都处理，此新分类适用于所有 MCP 的 write/unknown；普通 MCP 既有 HTTP/JSON-RPC 错误保持原定性，Cua 下游应答核实由 03 承担。
2. Code 使用 ArtifactStore.importImage/readImage，并经原操作登记产物。调整结果类型及路由，保留原内容次序、isError 和结构化结果；同时处理 `formatMcpResult` 与 `buildMcpToolDef` 当前抛错时丢弃图片的路径，不能只改正常返回。不能在图片失败时抛成让调用方误判尚未执行的传输错误。沿 driver/provider、JSONL 和 prompt 核实实际图片输入。
3. Personal 在原生工具结果上复用 `PersonalImageRegistrar` 和私有产物，在 `personal-harness.ts` 装配处核对媒体创建与 MCP 注入顺序；mcp_call 的操作状态仍可查，read_mcp_result 的旧分页入口兼容。原响应保存为完整证据或可重建产物，视觉内容经原 Task/entry 绑定，恢复只处理已存结果。旧响应/旧记录继续可读，新增引用版本未知则拒绝。
4. 写窄用例覆盖纯图/混图/重复图/isError 附图、伪 base64/MIME、超图数/超总量、文本模型、图片落盘失败、已成功动作后的图片失败、重启读取、改写或跨会话冒用产物。专门注入“已执行写动作，响应读取因预算中断或 JSON 截断失败”，未取得完整终结证据时保持未知，不记未执行也不重发；与已取得终结应答后本地图片落盘失败分开。使用模拟 provider 检查真实装配后的 payload、位置及次数，不只断言内部 content 数组。
5. 同步 `docs/modules/agent-tools.md`、`personal-durable.md` 与涉及的图片/产物说明；决策入口加提案落地后的锚点。沿用现有完整导出，只有发现能力缺口才修改 CLI/控制协议并补调用方回归。

## 进展与交接

- 当前角色与阶段：方案者完成；独立方案复核通过，已确认两端当前 MCP 都只给模型文本，既有图片链路可复用。
- 下一角色与动作：实施者按步骤 1 钉定预算与证据持久形式并完成离线实现。本单可先于 01 完成，但不能据此启用 Cua 写操作；持久契约有实质变化时按下述条件复审。
- 当前内容：`develop`，基点 `419c8384fb8916660b9d84965885fd39b618fe25`；未提交规划文件范围和快照见[review.md](../review.md)。
- 阻塞与恢复条件：无外部平台前置；真实 Cua/模型组合由 05 完成。若需要改变公共持久格式，先补齐迁入与旧历史行为，复审受影响契约。

## 验收与证据

工程验收待验证。最小回归从 `test/24-mcp.test.ts`、`test/25-mcp-write.test.ts`、`test/mcp-transport.test.ts`、`test/07-read-images.test.ts`、`test/09-artifacts.test.ts`、`test/personal-mcp.test.ts`、`test/personal-mcp-recovery.test.ts`、`test/personal-media.test.ts`、`test/personal-artifacts.test.ts` 选实际影响项；新增最窄 MCP 图片用例而非重跑全部个人测试。按仓库要求执行 `npm run check:static`，实际改依赖/exports/构建时加对应检查。

在 `evidence/02-images.md` 记录每项 R5 的输入、结果、实际 provider 快照与字节哈希，作者和独立审查分开；无真实模型时仅称离线装配通过。模型可见文本改动按 agent-facing-text 记录前后 schema/prompt 估算及快照。产品验收在 05 核实看图和取回，不在本单用模拟结果代替。方案审查见[review.md](../review.md)，实现审查待执行。

## Comments

2026-10-22：图片能力按通用 MCP 内联结果实现；Cua 的目标、工具和权限限制由 03 持有。

2026-10-22：独立方案复核通过；响应预算中断后的未知效果、错误附图及装配入口已补齐，见[审查记录](../review.md)。
