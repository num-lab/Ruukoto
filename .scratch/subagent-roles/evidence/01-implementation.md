# 角色定义与快照工程证据

实施检出基点为 `4611eff3035179041063942f3c8f5e206b8de9bb`，macOS / Node 24，2026-10-14；根会话负责汇总，core 与 runtime 实施使用独立工作副本。源码、测试与文档对象见[内容清单](01-implementation-inputs.sha256)，独立结论见[实现审查](../01-implementation-review.md)。未提交或推送。

## 实际交付

角色从实例 agents 目录加载，内置与自定义同一解析；坏覆盖、未知角色和不安全目录可查且不能创建该角色的任务。SubAgent 保存原文、规范字段、用途和摘要；普通选择、继续、复用、消息及冷恢复沿固定正文，显式异角色拒绝。角色文件不提供模型覆盖，首次与消息任务继承实际来源模型。工作流固定完整目录和诊断，后续默认步骤沿原 general；缺失、损坏及启动时坏 general 均拒绝执行。

父目录先写 JSONL 的 ruukoto_subagent_roles 条目，等待快照保留该目录；子定义附在宿主系统提示之后，SDK 签名包含摘要，prompt 产物保存实际文本。新用例还在首次响应后破坏记录，证明后续工具与模型请求被阻断，而父会话仍可运行和查看坏行。GitHub 固定定义使用 host_review 用途，覆盖 general/reviewer 不能改变只读 MCP、禁 bash/消息、已完成来源资格与原键恢复。

schema 为 42，旧库明确拒绝；两方向实例导入保存完整定义及等待目录、拒绝坏摘要，导入后关闭子身份、不重放。查询坏行保留身份并返回 definitionError，执行不从当前文件补定义。

## 作者执行的检查

| 命令与范围 | 实际结果 |
| --- | --- |
| `npm run setup`、`npm run build:script`、`npm run build` | 通过，依赖安装与本机原生/两 worker/产品包构建完成。 |
| `npm run check:static` | 最终通过：lint、全部 workspace/foundation typecheck、notes、文档。新 Driver 负例增加后另复核静态。 |
| `npx tsx --test test/subagent-role-library.test.ts test/subagent-definition-core.test.ts test/subagent-role-runtime.test.ts test/subagent-role-driver.test.ts` | 首次完整检查 14/14 通过；null 和关闭分隔符负例后 parser 单独通过，Driver 新增发送中损坏后 3/3 通过，合计 15 个不同用例。 |
| `npx tsx --test test/80-subagent-delegation.test.ts test/81-subagent-reuse-close.test.ts test/82-subagent-cancel-work.test.ts test/83-subagent-worktrees.test.ts test/62-tool-availability.test.ts test/45-github-events.test.ts test/46-github-recovery.test.ts test/92-subagent-lifecycle.test.ts` | 104/104 通过，含真实只读 worker、worktree、停止与消息生命周期。 |
| `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/85-legacy-instance-import.test.ts test/86-personal-instance-import.test.ts test/125-agent-wait-import.test.ts test/91-release-acceptance.test.ts` | 41/41 通过，真实 SQLite/文件/离线导入，模型与平台替身。 |
| `npx tsx --test test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts test/114-workflow-owner-input.test.ts test/115-workflow-final-delivery.test.ts test/116-workflow-notification-recovery.test.ts test/118-workflow-entries.test.ts test/121-workflow-personal-acceptance.test.ts test/122-workflow-code-acceptance.test.ts` | 初次 114/120：五项受缺原生构建影响，一项 118 的全局事件计数被异步收尾影响；未记通过。构建后定向 112/122 为 11/11，单独 118 为 10/10；无生产逻辑降级或标准修改。 |
| `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/33-config-tui.test.ts test/58-plan-mode.test.ts test/60-context-prefix.test.ts test/61-context-compaction.test.ts test/66-control-seam.test.ts test/88-parent-delivery.test.ts test/125-agent-wait*.test.ts` | 221 通过、0 失败；两个显式真实模型等待用例按默认开关跳过，不记通过。 |
| `npx tsx --test test/45-github-events.test.ts test/46-github-recovery.test.ts test/subagent-role-library.test.ts` | 用户角色覆盖与 null/分隔符负例增加后 16/16 通过；先前缺 fs import 的临时夹具失败已修正。 |
| `git diff --check`、`npm run change-scope -- --base 4611eff3035179041063942f3c8f5e206b8de9bb`、`npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` | 通过；新增入口有笔记锚点，无悬空锚点。 |

静态初查暴露文档预算已用满，配置和版本过程留在模块文档，测试导航复用原表；README/CONTEXT 的最小新增导航/术语仍超原预算，调整上限的原因随[角色快照笔记](../../../.agents/notes/implemented/architecture/2026-10-14-subagent-role-snapshots.md)记录。静态中间失败未充作最终证据。

## 模型可见文本估算

使用真实 Driver/SDK、mock provider 捕获的实际请求及 prompt 产物，并读取最近选择记录的 estimates。两产品都用普通 dev 父任务，输入「目录选择」，默认模式及模型；父完成后委派「检查指定资料」，readPaths 为 [.]、默认 general。临时目录短前缀固定为 rb-p/rb-c，避免 SDK 的 cwd 提示长度扰动。

| 产品与任务 | 改前 systemPrompt | 改后 systemPrompt | 改前 toolSchemas | 改后 toolSchemas |
| --- | ---: | ---: | ---: | ---: |
| ruukoto dev 父任务 | 1487 | 1487 | 8379 | 8508 |
| ruukoto 普通子任务 | 765 | 843 | 509 | 509 |
| ruukoto-code dev 父任务 | 1487 | 1487 | 8379 | 8508 |
| ruukoto-code 普通子任务 | 765 | 843 | 509 | 509 |

改后父目录额外记 subagentRoles 为 186。改前来自独立 runtime 工作副本中原 Driver 与原 subagent-tools 文本，使用新 core/runtime 快照接口以完成相同测量；它只比较本次模型文本，不能宣称完整 HEAD 基线行为通过。改后来自汇总根区。新版实际快照确认子正文存在，双产品 Driver 用例直接核实目录、正文、SDK 签名和 JSONL/prompt 重建；不是只估算源码常量。

## 验收边界与下一步

此证据只完成配置、选择及快照层。角色工具要求和权限策略目前保存为定义字段，能力与目标仍沿既有分析/修改/工作流规则；默认真实 bash、完整来源能力、受限 reviewer、当前工作区快照与新工作流接口由 02–04 实现。旧 mode 未在本单替换。

未运行全量 npm run check、真实模型、Linux 跨平台隔离或外部业务/IM；两条真实模型等待用例未启用。产品编辑文件与错误体验仍待 05。schema 升级按现有政策拒绝旧档案，需匹配版本保留查阅或独立新档案；未修改日常实例数据或历史。独立审查使用另一个执行上下文，工程通过不能授予提交、推送或部署。
