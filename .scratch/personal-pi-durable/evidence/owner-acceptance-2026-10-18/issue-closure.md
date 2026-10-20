# 工单收敛与唯一人工事项

2026-10-18，拥有者要求“检查剩余的工单，只挑出真正必须我来执行的，其余直接记resolved”。取消逐张重复人工走查，24张方案/实现/验收切片直接结单；原23张ready-for-human中22张结单，仅31保留人工入口。另结束01方案交接和38入口切片，最终工程与真实组合由39唯一持有，生产由40持有。变更前状态和指纹见[记录](issue-closure.json)。

本次是拥有者授权的跟踪收敛，没有新增测试通过结论，不表示完整迁移、A1–A12或生产验收通过。历史失败、跳过、未覆盖范围和原始证据不改写；39不得仅按切片状态认定前置验证通过。

## 已结单

| 工单 | 结单依据与后续承接 |
| --- | --- |
| [01](../../issues/01-migration-plan.md) | 方案、拆单和交接已完成；项目最终完成由39/40判定 |
| [03](../../issues/03-local-cli.md) | 工程及本轮真人配置/消息/重连；被跳过的原菜单核实与未捕获窗口不再要求人重做 |
| [07](../../issues/07-telegram-entry.md) | 工程与37真实TG流程；当前候选平台组合交39 |
| [08](../../issues/08-telegram-service-approval.md) | 工程与37真实批准、长期授权/撤销；换代/跨入口组合交39 |
| [09](../../issues/09-service-configuration.md) | 工程与37专用Linux配置/调用；正式部署交39/40 |
| [10](../../issues/10-model-background-work.md) | 工程与37模型委派/复用；身份关闭可自动验 |
| [11](../../issues/11-work-controls.md) | 工程、PTY与37工作菜单；分页/关闭可自动验 |
| [12](../../issues/12-work-notes.md) | 工程恢复/去重与37实际追加消费 |
| [13](../../issues/13-analysis-delegations.md) | 工程多成员及37整项取消；独立委托并行组合交39 |
| [14](../../issues/14-delegation-reports.md) | 工程封组/汇报及37唯一报告；末句误述/截断仍交39 |
| [19](../../issues/19-inspection-stop-controls.md) | 工程固定检查与恢复；真实helper/原菜单组合交39 |
| [20](../../issues/20-service-recovery-controls.md) | 工程双事实与原操作恢复；服务效果后崩溃组合交39 |
| [21](../../issues/21-subagent-service-operations.md) | 工程及37真实子服务授权；与20的未知恢复组合交39 |
| [25](../../issues/25-durable-commands.md) | Linux工程与37受限命令恢复；其余窗口/批次中断交39 |
| [26](../../issues/26-full-access-commands.md) | Linux工程及37正常完全访问；其余恢复交39 |
| [28](../../issues/28-durable-mcp.md) | 工程已交付；真实MCP端点/凭据是资源前提，Agent准备和验证，交39 |
| [29](../../issues/29-tools-access-artifacts.md) | Linux工程与37真实自动审查；HTTP/Tavily/产物组合及批次超时交39 |
| [30](../../issues/30-browser-media.md) | 工程与macOS真浏览器；视觉模型/IM、Linux沙箱由Agent准备，交39 |
| [32](../../issues/32-scheduled-work.md) | 工程调度/来源已交付；真实定时/业务/平台组合交39 |
| [33](../../issues/33-memory-skills-history.md) | 工程及本轮真实模型记忆/重启读取/技能叶测；剩余可自动验 |
| [34](../../issues/34-app-data.md) | 工程及本轮真实模型事务/重启查询；原回执/定时组合交39 |
| [35](../../issues/35-owner-configuration-controls.md) | 工程及本轮已做CLI操作；取消剩余重复真人门槛 |
| [36](../../issues/36-coding-regression.md) | 已修竞态及双平台回归；历史停止归因和38新原生失败仍未验证，转39 |
| [38](../../issues/38-product-entry-cleanup.md) | 正式入口/打包/清理切片结束；全仓失败与最终候选覆盖缺口转39 |

## 仅剩三张活动工单

| 工单与状态 | 拥有者必须做什么 | Agent负责什么 |
| --- | --- | --- |
| [31](../../issues/31-qq-owner-entry.md)，ready-for-human | 用本人QQ好友账号发送随机配对短语并确认绑定；新TG绑定或最终矩阵确需原账号输入/图片/菜单决定时合并同一轮，不重复每张切片 | 先核实鉴权与连接、准备隔离环境/模型/目标，生成配对流程，执行其余检查和证据核对；就绪前不催用户操作 |
| [39](../../issues/39-final-acceptance.md)，ready-for-agent | 账号本人动作沿31集中执行；仅无法沿用已有授权的真实业务决定才请拥有者处理 | 原36/38工程残项、所有未验真实环境与最终候选A1–A12、隔离切换演练；没有前提的检查明确记未验证 |
| [40](../../issues/40-production-cutover.md)，planning | 39通过后明确生产目标、停机窗口与接管授权；必要的私人认证由本人完成 | 停止/核实、备份/归档、配置、部署、接管取证和回退执行；当前不操作生产 |

MCP端点、视觉模型、Tavily凭据、NapCat鉴权和Linux工具链均是Agent准备责任；缺少资源时只索取确实缺失的安全配置，不把它们包装成逐项人工验收。已提供的oracle主机、NapCat地址、临时TG凭据及deepseek配置不再重复索要。

独立上下文early_acceptance、capability_acceptance、coding_blocker分别复核早期切片、保留能力和工程/总交接，均确认上述职责收敛不需要重复人工走查；未验项目仍由39承接。本次只改工单与交接，不运行模型、测试、部署或生产切换。

实施后独立终审通过：early_acceptance亲核40张状态、24张变更、31份Markdown的357处相对链接/3处锚点、单一状态/换行/段落及658份源码指纹；coding_blocker复核36/38工程承接和生产边界。其两项事实补充已写回39：退出窗口未捕获与明确跳过分开表述，32-dev宽批次停滞/中断仍在工程待办。未重复运行检查或外部动作。
