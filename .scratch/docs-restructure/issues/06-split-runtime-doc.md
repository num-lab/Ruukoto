Status: ready-for-agent

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

- [ ] Comments 里的去向表覆盖 runtime.md 的每个 `##` 和 `###` 节。
- [ ] `docs/runtime.md` 已删除；`git grep -n "runtime\.md"` 只命中 `.scratch/`、`.agents/notes/`（历史叙述）和 `docs/visual/`。
- [ ] `grep -nE "^#.*(issue|ADR|工单)" docs/modules/*.md docs/architecture.md docs/usage.md` 无命中。
- [ ] 每篇模块文档都有六个固定节；设计依据只链接 `.agents/notes/` 里存在的 note。
- [ ] `npm run check:static` 通过。

## Comments
