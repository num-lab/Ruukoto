# 上游与参考项目事实核实

核实日期：2026-09-14。以下依据官方文档及仓库当时的主分支，不等于已验证发布包或运行效果，也不代表本项目已经采纳相应设计。

## pi agent core

官方 `badlogic/pi-mono` 地址当前重定向到 `earendil-works/pi`。主分支 agent 包的名称为 `@earendil-works/pi-agent-core`，版本字段为 `0.85.1`；本轮未验证 npm 最新发布版本。旧资料中的包名为 `@mariozechner/pi-agent-core`，不能混用版本假设。[官方仓库](https://github.com/earendil-works/pi)、[包定义](https://github.com/earendil-works/pi/blob/main/packages/agent/package.json)

当前主分支的公共入口既导出低层 Agent 和 Agent 循环，也导出 `AgentHarness`、上下文压缩、会话、Skills、系统提示与基础工具。因此，不能预先认定持久化、压缩及 Skills 都是需要自行补齐的能力。[公共入口](https://github.com/earendil-works/pi/blob/main/packages/agent/src/index.ts)

coding-agent 另外提供现成 CLI/TUI、SDK/RPC、扩展加载及包管理。选用 core、Harness 或现成应用宿主的哪一层，需结合用户需求和实际可用版本验证。[coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

同仓还有独立插件组合运行时 Chord，提供插件、服务依赖与生命周期等机制。这是后续可评估的复用候选，本轮未验证发布状态、稳定性及与本项目需求的适配程度。[Chord README](https://github.com/earendil-works/pi/blob/main/packages/chord/README.md)

## DeepSeek Harness

已确认是 DeepSeek 官方发布的 `deepseek-ai/deepseek-harness`。其“everything is a plugin”包括模型、工具、会话、存储、Agent 循环、调度与 UI；Cordis 内核负责插件装卸和依赖管理。[官方介绍](https://deepseek.com/harness/en/)、[官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

这与“固定 pi 的职责，仅用插件添加缺失能力”具有不同范围。需要由用户确认希望借鉴的是扩展能力、替换内部机制，还是完整插件组合架构。

插件机制本身不保证安全隔离。官方动态 Host 插件在当前进程激活，VM 明确不构成安全边界；插件可能影响同进程其他会话。不能据此推断任意第三方插件可以安全执行。[动态插件工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/tool-cordis/README.md)

## OpenClaw

官方 Gateway 提供常驻运行、多渠道连接及客户端接入等宿主能力。当前官方运行时文档说明内置 Agent 运行时由 OpenClaw 自身维护；进一步的架构说明指出已移除外部 Agent 框架，采用 `@openclaw/agent-core`。应借鉴其当前产品和架构，不能将其当前版本直接视为 pi agent core 的上层实现。[Gateway 架构](https://docs.openclaw.ai/concepts/architecture)、[运行时说明](https://docs.openclaw.ai/concepts/agent)、[运行时架构](https://docs.openclaw.ai/agent-runtime-architecture)

OpenClaw 已提供广泛插件能力，包括渠道、模型 provider、Agent harness、工具及其他扩展。因此，“采用插件”本身不足以说明自建项目的区别，需要明确现有产品未满足的目标。[插件文档](https://docs.openclaw.ai/tools/plugin)

## Hermes

暂按上下文将用户所说 Hermes 理解为 NousResearch 的 Hermes Agent；这是项目身份推断，尚未获得用户明确确认。官方产品定位包括跨会话积累知识、搜索历史会话及创建和改进 Skills；本轮未独立验证其学习效果。[官方仓库](https://github.com/NousResearch/hermes-agent)

Hermes 已提供工具、hooks、命令、Skills、渠道、记忆与上下文等扩展方式。Python 插件在 Agent 进程内运行，声明能力和同意机制不能代替操作系统隔离。[插件文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)、[安全文档](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md)

## 对后续讨论的影响

以下属于规划推论，尚不是决策：

- 先明确自建的使用价值及架构探索目标，再判断复用现有产品或组件的范围。
- 在做能力缺口清单前，选择并核实具体 pi 包、发布版本与 API 层级。
- 根据插件实际用途决定可替换范围；插件装卸、工具审批及代码隔离是不同问题。
- 会话、记忆、常驻运行、调度、入口和恢复机制逐项依据首批任务决定是否需要，以及复用还是补充。

## 第 3 轮补充：Jev 与历史筛选

找到与用户描述高度匹配的候选：TypeSafe AI 的 Jev。官方将它定义为从输入状态输出结构化概率决策的模型；官方发布文章日期为 2026-09-15。用户是否指这一模型尚待确认。[TypeSafe 官方介绍](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

社区已有 `fast-jev-compaction` 及其 pi 移植：用 Jev 判断旧工具调用和结果是否仍然需要，再保留、截断或移除；保留下来的文字不改写。pi 移植的 README 明确说明筛选作用于发送给模型的消息视图，磁盘上的会话文件保持完整。这些是项目作者的功能说明，本轮未运行验证，也不是 TypeSafe 官方提供的上下文管理组件。[原始实现](https://github.com/tamaratran/fast-jev-compaction)、[pi 移植](https://github.com/QuentinDanblon/pi-fast-jev-compaction)

对本项目的推论：Jev 可以作为后续上下文筛选实验的候选，但保留历史原文不等于当轮推理没有信息遗漏。这些实现也不能证明跨会话长期记忆的清理问题已解决。是否清理派生记忆或删除原始历史，仍是本项目独立待决的问题。

## 第 3 轮补充：pi 上下文扩展点

2026-09-19 核实官方主分支；未验证发布包及实际运行效果：

- 低层 `Agent` 在转换为模型消息前调用 `transformContext`；可为本次调用选取消息，自定义处理器应避免原地修改历史。该类自身不调度自动压缩。[Agent 文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[循环源码](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- coding-agent SDK 可通过 `compaction.enabled: false` 或 `setAutoCompactionEnabled(false)` 关闭自动压缩。这不会禁止手动压缩或分支摘要，也不会自动解决上下文超限。[SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)、[会话源码](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts)
- coding-agent 扩展的 `context` 事件可调整每次调用的消息副本；自定义工具可通过 `ctx.sessionManager` 查询历史。因此可以评估复用现成宿主，在其扩展点上实现消息选择及历史读取，而不预先认定必须重写循环。[扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- 会话格式区分原始条目与活动上下文。消息留存不代表工具未截断的全部原始输出、流式中间状态或崩溃前最后写入都已经可靠持久化；这些需要在实现设计中分别验证。[会话格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
