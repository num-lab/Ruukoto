# 用 Pi MCP 替换接入并收缩宿主职责

Status: ready-for-agent

## 目标与边界

按[规格 S1–S7](../spec.md)替换 MCP 接入并删除／简化前轮筛出的过度设计。拥有者于2026-10-26明确要求制定方案；已确认方向为 Pi 接入和减法，本轮不实施产品、升级依赖或切换真实档案。理由与备选归[决策提案](../../../.agents/notes/proposed/simplification/2026-10-26-mcp-host-responsibilities.md)，上游接口事实归[调研](../research.md)。

Code 使用官方内置 MCP 与 tool_search；Personal 使用同版 pi-mcp 的 durable 薄适配，不更换运行时。当前 HTTP／Bearer／Cua 范围保持；旧记录可读，新的未知收尾不伪造远端结束，Cua 真实资源保护保留。新增 OAuth／任意 stdio／Resources 产品入口、插件平台、部署和发布不在本期。

## 方案

按下列顺序实施；单工作区同时只有一个写入者，独立审查只读。第一步是隔离验证，不允许技术假设失败后靠复制上游运行时继续堆实现。

| 阶段 | 工作与影响面 | 完成证据 |
| --- | --- | --- |
| P0 接线原型 | 在隔离临时目录验证固定Pi 1.3.0官方factory、显式模块加载与局部EventBus注入、动态服务注册、调用ID关联、实际发送前提交、原结果持久投影、前置工具就绪及Cua生命周期。读当前SDK升级差异，不改正式档案 | 官方路径可追踪；并发同名同参不串账；批准／撤销／慢持久取消零业务发送；恶意外部资源未读或枚举；同SDK服务发布可见；长文／纯图／错误附图重开可还原；必需工具缺失前不调用模型。失败回到方案，不以私有深层import、复制runtime或第二发现清单绕过 |
| P1 SDK与共享Pi适配 | 根、packages/{core,agent,runtime,channels,tui}及foundation依赖、两份锁、session-factory/driver、模型与历史调用面；保留压缩／重试／终结设置，接入公开factory与pi-mcp传输 | 构建和静态检查；旧0.85 JSONL重建；普通编码、工具、等待/终结与SubAgent/工作流用例；依赖隔离和正式包入口检查 |
| P2 Code MCP | mcp模块、tool-router/ledger、availability、host工具族、driver、runtime工作流及SubAgent前置核实；实际调用切到官方extension，替换search_tools与工具名；动态资格、原始结果产物、Cua客户端归属同步 | 24/25 MCP、search-tools、Plan/角色/工作流来源、图片与Cua用例；不得存在旁路调用旧连接。工具新增不自动授权，撤回立即不可执行；SDK重建不遗留未核实电脑执行 |
| P3 Personal格式和调用 | personal-mcp/config/harness、settings/configuration发布、controls、旧Task退役；配置v4与recordVersion2、旧默认unknown、规范化token摘要及显式轮换；新调用走pi-mcp | 旧档案混合夹具可打开；历史字节不变；旧任务恢复零网络；未开始批准失效；read免审批，write/unknown授权不变；轮换与换行分别覆盖 |
| P4 未知收尾与客户端 | personal-work/delegation/report/scheduler/tools/service-operations、settings-blockers；MCP人工收尾和原来源禁执行；删除SSE重核与URL互锁；Code停止未知写后的自动调用。CLI/TUI/Desktop/Telegram及控制/remote更新，Cua合并observe | 同来源换方式被拒，不同独立工作同URL可用；未知摘要可送达；人工收尾不释放未停真实资源；旧操作明确拒绝且不重发；配置仍逐服务发布，丢答按原键核实 |
| P5 删除与交付 | 删除旧SDK依赖、客户端、搜索/激活与原流引擎，不保留双路径；同步文档、笔记及最小检查集 | 全部契约矩阵通过、独立实现审查无阻断；双壳/IM主观体验及HTTP/Cua外部验收按实际环境留证，缺前提不记通过 |

### 受影响入口与文档

Code 管理保持实例服务表与现有凭据入口；`mcp_cua_begin_recovery` 从 runtime/control ops/server、Desktop IPC 白名单和 TUI/电脑页移除，observe承接合并动作。控制协议升一版，数据库无布局变化不升。Personal 删除 `/mcp/recheck`、CLI/Telegram新建重核动作及对应harness暴露；保留旧控制收件的只读校验，并修正原以requestRecheck是否存在判断装配的代码。remote现无公开SSE重核写入口，不误删其他工具重核。

Personal v4的本地效果分类、显式凭据轮换、人工收尾和合并电脑恢复同步 `personal-settings*.ts`、`personal-mcp-cli.ts`、`personal-mcp-controls.ts`、`personal-control.ts`、remote权限／转发及桌面personal设置。完整消费者检索以 `mcpUnresolved`、`mcpSourceBlocker`、`requireWorkMcpStopped`、`requestRecheck`、`mcpRecheck`、`beginRecovery`、`search_tools`、`planMcpTaskTools`、旧SDK包名为起点，不只改UI。

文档落点为 `docs/modules/{agent-tools,agent-context,personal-durable,runtime,control,core,tui,desktop,products,workflows}.md` 中实际受影响的契约和 `docs/usage.md`；新增模型可见工具说明按 agent-facing-text，文案按 prose-standard。依赖和验证入口变化同步 README、docs/development 与 pre-push-checks；不修改仍描述旧版本事实的验收材料。

## 验收与证据

| 编号 | 要证明的行为 | 最窄证据起点 |
| --- | --- | --- |
| A1 | Code实际使用官方factory、Personal实际使用pi-mcp，旧实现无回退 | P0调用链证据；依赖/源码检索；24 MCP与personal-mcp |
| A2 | 未授权、拒绝、重复批准、撤销、改参数、慢持久跨取消均不产生业务发送；并发不串操作 | 25 MCP、63审批、64账本及P0双调用反例 |
| A3 | 模型声明、搜索、动态重注册、嵌套调用和发送门具有同一当前资格；同SDK跨任务新增／改端点／启停／允许列表／A→B→A均正确，保存不中断已发调用 | search-tools、44/58/62、subagent-source-capabilities、113-workflow-source-capabilities；禁止的resources/codemode负例与动态服务发布夹具 |
| A4 | 远端已写、本地丢答或落盘前崩溃，重开和新SDK循环都不自动再写 | Code/Personal MCP故障测试，区分POST明确拒绝、已接纳流断开和客户端合成错误 |
| A5 | 原来源仍拒绝重试；独立工作同URL不被阻挡；人工前可查未知，人工收尾及本地停止／成员终态之后才送最终未知报告，真实资源不提前释放 | personal-work/delegations/reports/scheduler/tools，Code任务终结；断言实际发送顺序，不再要求永久running |
| A6 | 旧配置/操作/重核Task/IM回执/图片混合档案可恢复，退役任务零GET/POST，原历史未改；v4保存／生效间崩溃仍可管理旧有效配置，旧Cua未决不被纯格式变化自锁 | personal-mcp-recovery/config/controls、settings-updates/publication、旧JSONL夹具及迁入各失败窗口 |
| A7 | 旧工具默认unknown；read批准规则、规范化token换行、显式轮换、同路径换token拒绝各自正确；缺凭据旧禁用服务保留原引用且不阻塞其他服务迁入 | personal-mcp-config、personal-settings、24/25 MCP；凭据零泄露、引用保护与旧/新摘要混合配置 |
| A8 | 纯图、混图、isError附图和长结果在首次及重开模型输入保持归属，坏图不重做动作 | mcp-images、24 MCP、personal-mcp、media-model-pinning及实际provider快照 |
| A9 | Cua跨普通轮持续、重建时先核实停止、旧恢复阶段可进入新流程，接受绑定新图，原点击不重发；旧SDK销毁后管理入口仍可只读恢复 | cua-mcp、cua-code、personal-cua；macOS原生与Linux scope最窄测试及双端实机 |
| A10 | 所有管理入口移除退役动作，保留版本/身份/引用保护、丢答核实和独立配置发布 | 29/33、desktop-settings-mcp/computer、desktop-personal-settings-pages、personal-settings/remote/controls |

每个阶段跑 `npm run check:static` 与对应最窄用例；依赖变更按检查规范构建并更新两套锁。P1至少覆盖18-model-selection、60-context-prefix、61-context-compaction、71-product-entry、98-media-model-pinning、122-workflow-code-acceptance及相关SDK工具/终结用例。其余文件名在实施时按上述功能词确认，避免把整表机械当一次全量命令；最终实际影响横跨全仓时才扩大到完整check。Linux必须用隔离目录和 `ssh tx` 核原生执行，不以macOS模拟替代。

产品验收包括双壳MCP设置与凭据轮换、未知调用人工收尾、Cua合并恢复的真实操作；普通HTTPS写工具只在拥有者明确提供的隔离目标验证。真实模型、IM与外部服务前提缺失时保留待验与恢复条件，不用桩宣称通过。

当前工程验证：仅方案文件与上游/本地源码核对，P0–P5均未实施。产品验收：待实施后验证，现有旧Cua证据只作为保护目标，不代表新Pi实现已通过。

独立方案审查：2026-10-26，两位不同上下文审查者分别直接核对Code／上游接线和Personal迁移契约；初审发现的加载器、服务动态发布、无SDK的Cua管理恢复、v4迁入顺序、缺失凭据和报告时机已修订，复审均无剩余阻断。对象、范围、证据与未验证项见[审查记录](../evidence/2026-10-26-plan-review.md)，被审文件原文与摘要见[方案快照](../evidence/2026-10-26-plan-snapshot.json)。独立实现审查尚未开始。

## 进展与交接

- 当前角色与阶段：方案者，方案及两路独立复审完成，未实施。
- 基点：`7d6ebbf0650358f98fbc0868f9160132eb42e03d`。本任务未提交范围为 `.scratch/pi-mcp-comparison/` 与对应 proposed 笔记；仓库其他后续变化不包含在本方案验证结论中。
- 已确认内容：采用Pi接入并删除／简化前轮过度设计；具体步骤按上述规格落实。没有新增产品范围的待决问题；P0中的接口与生命周期是技术验证前提，不能用假定当已证明。
- 下一角色与动作：实施者从P0隔离原型开始，保存结果并核对其是否支持P1–P5；不能跳到正式替换。本轮拥有者请求止于制定方案，未执行实现、提交或部署。
- 阻塞与恢复条件：无未解决方案阻断；P0尚未执行属于计划内步骤，不是外部阻塞。若公开接口无法保持封闭加载、调用关联或Cua寿命，先修订方案，不复制上游运行时填补。

## Comments

2026-10-26：拥有者明确要求制定迁移与简化方案；沿前轮筛选形成此工单和规格。当前仅文档，不升级依赖、不操作真实档案、不提交或发布。

2026-10-26：独立初审要求补齐六项接线／迁入契约，方案已逐项修订；两位原审查者复审无剩余阻断，状态转ready-for-agent，下一步为P0。
