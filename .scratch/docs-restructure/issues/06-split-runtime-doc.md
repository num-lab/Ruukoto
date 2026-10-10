Status: resolved

# 拆分 runtime.md：总览、模块设计、操作手册，并写 writing-docs-for-human

依赖：03（理由与历史要并入已迁移的 notes）。范围见 [spec](../spec.md)。

## 产出

- `docs/architecture.md`：模块地图（每个模块一句职责、主要依赖方向），以及四条主流程：任务生命周期、入站消息到回复、工具调用与审批、SubAgent 委派。
- `docs/modules/`：runtime、core、agent-context、agent-tools、execution、control、tui、channels、scheduler、deploy，共 10 篇。
- `docs/usage.md`：操作手册，包括运行、配置、各入口的启用、旧实例导入命令与故障排查。
- `.agents/skills/writing-docs-for-human/SKILL.md`（目录已存在）：模板、文风与触发条件。AGENTS.md 加一行指针：改了某模块的可观察行为，同步 `docs/modules/` 里对应的那篇；新增模块时，更新 `architecture.md` 的模块地图。不加覆盖测试。

## 模块文档模板

固定节：职责与边界 → 对外接口（谁调用它、它调用谁、协议与工具名）→ 数据与状态（表、状态机）→ 主要流程 → 不变量与失败处理 → 设计依据（链接 notes）。

- 只写现在怎么运作，标题和正文都不挂 issue 编号，不写演进历史。
- 理由与被否方案只在 notes 里；链接只从 docs 指向 notes。
- 图用 Mermaid，只画状态机与时序。
- 术语一律按 `CONTEXT.md`。

## runtime.md 各节去向（执行时逐节核对，结果表记入 Comments）

| runtime.md 节 | 去向 |
|---|---|
| 架构要点 | architecture.md；各机制细节分到对应模块 |
| 运行命令 | usage.md |
| TUI、配置中心 | 操作进 usage.md，设计进 modules/tui |
| 开发实例 | development.md |
| 数据布局 | modules/core；其中旧实例导入的命令进 usage.md，导入设计进 modules/runtime |
| 上下文、历史检索与长期记忆（含技能、工作清单、计划模式、Jev、选择记录） | modules/agent-context；工作清单与计划模式的工具面进 modules/agent-tools |
| main 应用数据空间、MCP 服务、Web Search、长期操作授权 | modules/agent-tools；配置步骤进 usage.md |
| 调度器与通知 outbox、新闻推送 | modules/scheduler |
| Telegram、QQ 私聊、私聊图片入站、IM 审批、GitHub MCP 与 PR webhook、QQ 群聊（已退役） | modules/channels；配置与旧群资料命令进 usage.md |
| 服务器服务管理、部署 | modules/deploy；与 `deploy/systemd/README.md` 重复的操作步骤只留一处，另一处链接过去 |
| 通用 SubAgent 委派 | modules/runtime；worktree 与容器内 git 的部分进 modules/execution |
| 固定 coding 角色退役 | 历史：核对是否已被 0017 等迁移来的 note 覆盖，缺的补进对应 note；模块文档只写现状 |
| 验证状态（诚实清单）、按会话选择模型 | 验证状态进 release-acceptance.md；模型选择进 modules/agent-context 与 usage.md |

拆分中遇到 notes 尚未覆盖的理由或历史，就地补进对应 note（按 maintain-notes 的原地同步规则），不写进模块文档。

## 同时处理

- README：权限模式、TUI、命令行、数据目录几节并入 usage.md；README 只留介绍、当前状态、快速开始与文档链接。设计要点并入 architecture.md。
- 所有指向 `docs/runtime.md` 的链接（notes、`deploy/systemd/README.md`、`docs/development.md`、`docs/release-acceptance.md` 等）改指新位置。CONTEXT.md 留给 07 处理。
- 删除 `docs/runtime.md`，把最后提交号记入 Comments。

## 验收

- [x] Comments 里的去向表覆盖 runtime.md 的每个 `##` 和 `###` 节。
- [x] `docs/runtime.md` 已删除；`git grep -n "runtime\.md"` 只命中 `.scratch/`、`.agents/notes/`（历史叙述）和 `docs/visual/`。
- [x] `grep -nE "^#.*(issue|ADR|工单)" docs/modules/*.md docs/architecture.md docs/usage.md` 无命中。
- [x] 每篇模块文档都有六个固定节；设计依据只链接 `.agents/notes/` 里存在的 note。
- [x] `npm run check:static` 通过。

## Comments

2026-10-10：skill 部分完成（拆分 runtime.md 的其余产出未开始，工单保持 ready-for-agent）。

- `.agents/skills/writing-docs-for-human/SKILL.md`：触发条件表（模块可观察行为 → `docs/modules/<模块>.md`；新增/拆分/合并/删除模块 → `docs/architecture.md` 模块地图；运行/配置/启用入口/导入命令/故障排查 → `docs/usage.md`；决定翻转 → notes）、源目录到模块文档的 10 条对应表、模块文档固定六节、architecture 与 usage 的形态、落笔红线、写完自检。
- `.agents/skills/writing-docs-for-human/templates/module.md`：六节骨架，含 Mermaid 状态机与时序占位、对外接口表、「设计依据」链接写法。
- `.agents/skills/writing-docs-for-human/references/prose.md`：docs 行文与去泄露清单（现在时、删会话与提交痕迹、一个事实只讲一次、术语按 CONTEXT.md、图的用法、返工清单）。
- 不加覆盖测试，与决策 note 一致（test/67 式门禁正是可视化文档维护变重的原因）。
- AGENTS.md「Agent skills」下新增「人类文档」一节，一行指针指向上面的 SKILL.md。
- 验证：用 `loadSkillLibrary` 加载 `.agents/skills/`，两个技能均无诊断、`writing-docs-for-human` 的 description 与正文正常；SKILL.md 内的 `templates/module.md`、`references/prose.md` 链接均存在。`npm run check:static` 通过；`npx tsx --test test/56-skills.test.ts` 6/6 通过。

2026-10-10：拆分完成，`docs/runtime.md` 已删除。删除前的最后提交号：`e2d5131a4bac5f32dc677cf4391520cb8229d6f0`（`e2d5131`，docs: 将 ADR 迁移为分类决策笔记；删除时工作区无未提交改动涉及该文件）。

### 产出

- `docs/architecture.md`（169 行）：模块地图（10 行，每行一句职责 + 主要依赖方向）与四条主流程（任务生命周期、入站消息到回复、工具调用与审批、SubAgent 委派），每条流程配 Mermaid 时序图与要点列表，末尾「一条消息穿过全部模块」串起全链路。
- `docs/modules/`：10 篇，每篇六节固定顺序，`docs/modules/runtime.md` 308 行、`execution.md` 206、`agent-tools.md` 235、`agent-context.md` 168、`channels.md` 556、`core.md` 331、`control.md` 218、`tui.md` 230、`scheduler.md` 189、`deploy.md` 222。
- `docs/usage.md`（549 行）：前提与安装、运行（含按需拉起后台与两产品差别）、控制面命令、配置、启用各入口、导入旧实例、交互终端、开发实例指针、数据目录、故障排查（后台/执行/MCP/消息入口/上下文五类表）、已知限制。
- README 收敛为介绍、当前状态、快速开始与文档链接；权限模式、TUI、命令行、数据目录、已知限制几节并入 usage.md，设计要点并入 architecture.md。

### 逐节去向表（runtime.md 的每个 `##` 与 `###`）

| runtime.md 节（原行号） | 去向 |
|---|---|
| 架构要点（10） | 机制总纲进 architecture.md 的四条流程；各机制细节分到对应模块：工具工作进程与执行边界 → execution；自动审查、结构化审批、静态宿主工具族、工具可用性、审批闸门、工具操作账本、正文产物 → agent-tools；模式绑定任务、会话身份与执行画像、父级送达、SubAgent 生命周期、任务收尾 → runtime；拥有者 IM 入口 → channels；拥有者认证 → control；QQ 群聊退役 → channels |
| 运行命令（172） | usage.md §1–§3；开发检查命令留 development.md |
| TUI（301） | 操作（按键、命令表、断开重连、终端恢复）→ usage.md §7；设计与展示机制 → modules/tui |
| 配置中心（540） | 操作（在线/离线、各页签）→ usage.md §4；并发与修订、模型应用时机、摘要模型、项目分区 → modules/tui |
| 开发实例（605） | development.md「开发实例」（按工单表：开发实例 → development.md） |
| 数据布局（649） | 布局、schema、任务状态机、职责边界 → modules/core；旧实例导入命令 → usage.md §6，导入设计 → modules/runtime |
| 旧实例开发资料迁入（735） | 设计（源只读、离线、快照、allow-list、回执、回退）→ modules/runtime；命令与整库恢复步骤 → usage.md §6.1 |
| 旧实例个人资料迁入（790） | 同上；交接与旧实例停用要求 → usage.md §6.2 |
| 上下文、历史检索与长期记忆（876） | 整节 → modules/agent-context |
| 统一资料访问范围（878） | modules/agent-context |
| 历史检索（889） | modules/agent-context |
| 上下文选择（905） | modules/agent-context |
| 上下文压缩（983） | modules/agent-context |
| 技能（1042） | 库、钉版、上下文、`skill` 工具 → modules/agent-context；服务器维护命令 → usage.md §5 |
| 工作清单（1072） | 工具面（参数、校验、上限、适用会话）→ modules/agent-tools；上下文保底 → modules/agent-context |
| 计划模式（1094） | 选择、固定表示、继续与切换、权限边界 → modules/runtime 与 agent-tools；上下文与计划说明 → modules/agent-context；TUI 展示 → modules/tui |
| Jev 上下文筛选实验（1131） | 实验机制 → modules/agent-context；凭据登记与启用步骤 → usage.md §5.9 |
| 长期记忆（1168） | 机制 → modules/agent-context；CLI/TUI 入口 → usage.md §3.7 |
| 选择记录（1190） | modules/agent-context |
| main 应用数据空间（1210） | modules/agent-tools |
| 调度器与通知 outbox（1252） | modules/scheduler |
| 新闻推送（1310） | 机制 → modules/scheduler；创建计划的操作与示例 → usage.md §5.4 |
| Telegram owner 入口（1351） | 机制 → modules/channels；配置与启停 → usage.md §5.1 |
| 配置与启停（1356） | usage.md §5.1；配置代次与失效语义 → modules/channels |
| 运行行为（1380） | modules/channels |
| QQ owner 私聊（1426） | 机制 → modules/channels；配置命令 → usage.md §5.2 |
| 私聊图片入站（1483） | modules/channels（配置无需额外启用，usage.md §5.3 一句说明） |
| IM 审批（1524） | 命令与事务语义 → modules/channels；审批闸门与消费 → modules/agent-tools |
| 服务器服务管理（1585） | 设计与 helper/策略/执行 → modules/deploy；审批与长期授权使用语义 → modules/agent-tools；安装步骤 → deploy/systemd/README.md |
| 长期操作授权（1631） | 范围、版本、使用与失效 → modules/agent-tools；IM 命令与查看/撤销 → modules/channels 与 usage.md §5.10 |
| 固定 coding 角色退役（1666） | 历史理由与角色退役决定已由 note 覆盖（见下「理由与历史」）；模块文档只写现状：coding 角色不再引导、`coding_result` 只读兼容、约束不收缩 → modules/runtime 与 modules/core |
| 通用 SubAgent 委派（1694） | modules/runtime；worktree 与容器内 git 部分 → modules/execution |
| 登记与执行范围（1710） | modules/runtime（资料与读范围）；容器路径与身份 → modules/execution |
| 继续、复用与关闭（1747） | modules/runtime |
| 工作内消息与协作加入（1777） | modules/runtime；投递渠道中的唤醒与注入 → modules/runtime「父级送达」 |
| 整项取消（1826） | modules/runtime |
| 修改委派（1876） | 委派语义 → modules/runtime；Git 目标与容器内 git → modules/execution |
| 改动汇总（1953） | 三套结论与幂等 → modules/runtime；容器命令与边界 → modules/execution |
| 结果、通知与空闲（1989） | modules/runtime；工作最终汇报的 target 核对 → modules/channels |
| 宿主固定评审（2029） | modules/runtime（名额、输入、恢复）；只读 MCP 白名单 → modules/agent-tools；PR 事件入口 → modules/channels |
| 后台重启恢复（2073） | modules/runtime |
| GitHub：MCP 操作与 PR webhook（2102） | 入口与评审链路 → modules/channels；MCP 服务侧 → modules/agent-tools；配置步骤 → usage.md §5.7–§5.8 |
| PR webhook 配置（2111） | usage.md §5.8；凭据 scope 与仓库范围 → modules/channels |
| 评审、修订与通知边界（2159） | modules/channels |
| 历史资料与迁移（2214） | 退役迁移的现状行为 → modules/channels；旧表只读归档 → modules/core |
| Web Search（2238） | 机制 → modules/agent-tools；凭据与开关 → usage.md §5.6 |
| 配置与开关（2244） | usage.md §5.6 |
| 参数、限额与故障处理（2256） | modules/agent-tools |
| MCP 服务（2280） | modules/agent-tools |
| 服务配置与管理（2289） | 机制 → modules/agent-tools；命令 → usage.md §5.7 |
| 任务内行为（2313） | modules/agent-tools |
| 写工具与统一审批（2333） | modules/agent-tools |
| GitHub MCP 首次配置（2359） | usage.md §5.7 |
| 故障排查（2371） | usage.md §10.3 |
| QQ 群聊——核心群聊已退役（2382） | modules/channels（退役后的入站行为与只读归档） |
| 退役后的入站行为（2391） | modules/channels |
| 配置与命令（写入口已删除）（2406） | modules/channels；`qq status` 等命令 → usage.md §5.2 |
| 旧群资料（只读归档）（2416） | modules/channels 与 modules/core |
| 群聊结果（chat_result_*）（2432） | modules/channels |
| 验证（2443） | 测试文件名保留在 modules/channels；结论并入 release-acceptance.md |
| 崩溃恢复（无标题的编号清单，2462–2524） | modules/runtime「后台崩溃恢复」（1–9 步原样保留原因码与状态名） |
| 部署（2526） | modules/deploy；操作步骤 → deploy/systemd/README.md |
| 验证状态（诚实清单）（2543） | release-acceptance.md「历史验证清单」（表体逐行保留） |
| 按会话选择模型（2596） | 机制 → modules/agent-context；命令与重启补选 → usage.md §3.4 |

### 同时处理

- README：`权限模式`、`TUI`、`命令行`、`数据目录`、`已知限制` 五节并入 usage.md（§4.2、§7、§3、§9、§11）；`设计要点` 并入 architecture.md；README 只留介绍、当前状态、快速开始、开发本项目与文档链接。
- 链接改指：`.agents/notes/` 18 篇（运行时设计 → agent-context、运维与配置 → usage、崩溃恢复 → modules/runtime、模块归属 → 对应模块）、`deploy/systemd/README.md`、`docs/development.md`、`docs/release-acceptance.md`、`verification/foundation/README.md`、`test/85-retire-core-group-chat.test.ts` 注释、`src/` 五处注释（tui/index.ts、runtime/legacy-import.ts、runtime/personal-import.ts、runtime/orchestrator.ts、cli.ts）、`CONTEXT.md`（07 仍会收词条，本单只改失效链接）。`docs/visual/` 的失效链接按 05 的决定不修。
- 待处理：无。

### 验收结果

- [x] Comments 的去向表覆盖 runtime.md 的每个 `##` 与 `###`（上表 55 行，含无标题的崩溃恢复清单）。
- [x] `docs/runtime.md` 已删除；`git grep -n "docs/runtime\.md"` 只命中 `.scratch/`、`.agents/notes/`（历史叙述与决策 note）和 `docs/visual/`（冻结快照）。
- [x] `grep -nE "^#.*(issue|ADR|工单)" docs/modules/*.md docs/architecture.md docs/usage.md` 无命中。
- [x] 10 篇模块文档六节齐全、顺序一致；每篇「设计依据」只链接 `.agents/notes/` 下真实存在的文件（脚本核对 0 死链）。
- [x] `npm run check:static` 通过（lint、两处 typecheck、verify-notes 35 篇）。
