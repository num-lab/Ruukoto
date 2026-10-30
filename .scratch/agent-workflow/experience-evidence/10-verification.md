# 工单 10 实现与验证交接

2026-10-14；实施基点及工程验收时 HEAD 为 `40dcee7`，分支 `Eitrous/agent-workflow`。验收时实现尚未提交，最终内容清单见 [10-inputs.sha256](10-inputs.sha256)；原实现审查见 [10-review-manifest.json](10-review-manifest.json)，续接与来源返工见 [追加审查](10-continuation-review.md)及 [追加清单](10-continuation-manifest.json)。各阶段结论只覆盖对应快照，删除的 proposed 笔记由 Git diff 记录。验收记录时 Agent 尚未提交、推送、部署或执行实际 IM 外发。

提交门禁要求无行尾空白。受影响的日志与补丁保留 `.gz` 无损原件，文本副本仅清理行尾空白及末尾空行；[原件映射与 SHA](10-raw-log-archives.json)区分原始字节和文本副本，原审查日志哈希对应解压后的原件。检查结果与源码不变。

## 人工验收

2026-10-14，拥有者在本会话确认：“人工验收已完成，wait工具能够正常作用，但是遇到子agent无法调用shell的问题，不在本单范围内”。本单人工验收通过，状态为 resolved。子 Agent 无法调用 shell 作为独立后续问题记录，本次不诊断或修复；具体验收入口、平台及逐路径结果未提供，不把这一确认改写为实际 IM 或 CI 矩阵通过。

## 行为与范围

两个产品的主 Agent 共用 `agent_wait`，可等待最多 20 个同来源固定任务或运行；等待安全让出目录，结果到达后可继续处理，恢复目录访问前重取并复核资源。新拥有者输入打断旧等待而不取消后台，目录仍被子任务占用时进入不扫描工作区、不启动 worker/MCP、仅允许宿主查询的内部对话阶段。持久消费、整组报告认领及原键后备保证父轮、既有专属汇总与晚到补报共享唯一报告；JSONL/SQLite 恢复、两方向导入、可信隐藏分类及 control/TUI 等待投影同步实现。阶段问句保留最终报告资格；续接轮只等最后一项也须接受完整 `reportTargets` 才接手报告，旧消费不改。认领清除后仍从持久事件与本轮 JSONL 绑定全部来源，坏输入明确拒绝。

schema 为 40、control 协议为 24，沿既有严格版本拒绝规则；已有 schema 39 档案保留原样，用匹配代码查阅，当前实现须使用独立新档案及配套客户端。导入只接受当前格式，不充当旧库迁移。

## 实际检查

| 环境与命令 | 结果与证据 | 能证明什么 |
| --- | --- | --- |
| macOS arm64 / Node 24.15.0，`npm run check` | [最终全量日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-full-check-continuation-final.log)，exit 0；macOS 独占 38 通过，应用 1393 通过/5 跳过，foundation 9 通过/1 跳过 | 最终生产代码的构建、静态检查和全仓回归；默认门控的真实模型不计通过。随后新增的 12 条坏输入测试单独执行如下，不冒称包含在全量中。 |
| 续接、store、报告、恢复、排队组、来源边界、双向导入及 88/115/116 调用方的明确文件集合 | [78/78](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-continuation-final.log)，无跳过 | 部分结果问句不提前完成报告、Q 整组接手、provider 失败原 canonical 补报、20 项总上限、真实本地冷恢复发送器拒发及相邻契约。最后畸形字段守卫另有回归。 |
| 新增坏输入回归后，`npx tsx --test test/125-agent-wait-recovery.test.ts` | [22/22](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-input-integrity-permanent-final.log)，无跳过，原 10 条及新增 12 条 | 真实 SQLite/SDK JSONL 恢复；claim 清理后缺引用、缺边界/工具条目、缺整组字段、非法 JSON/null/false 或子集输入仍得到类型化拒绝，原消费不被覆盖。 |
| 最后源码、测试及模块文档汇总后，`npm run check:static` | [静态日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-static-continuation-final.log)，exit 0 | lint、全 workspace/foundation 类型、决策记录与文档门禁；后续只有工单、验证记录及内容清单更新。 |
| Ubuntu Linux 6.8 x64 / Node 24.21.0，`ssh tx` 隔离目录内 build 后执行 `npx tsx --test --test-concurrency=1 test/125-agent-wait-resource.test.ts test/125-agent-wait.test.ts` | [最新 14/14](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-linux-continuation-final.log)，无跳过；[关键源码 SHA](10-linux-continuation-source-sha.txt) | 最后生产代码的真实 worker 停止、目录让出/重取、双产品修改/冻结/独立验证/汇入及新输入、审批和晚到补报；不代表 Linux 全仓或 CI 全版本矩阵。 |
| macOS，`RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/path/models.json npx tsx --test test/125-agent-wait-model.test.ts`；DeepSeek `deepseek-flash`、thinking off | [最后受控 3/3](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-model-continuation-final.log)，两产品真实 API 场景及一个离线代理协议用例 | main/dev 等待→查询→attention 后再等→新输入中断→原 canonical 唯一补报；父提示明确工具顺序，证明受控机制。 |
| 独立副本，保留原自然需求、保存定义及 interruption→release 真实 HTTP 门控 | [自然 3/3](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-natural-final.log)，两产品真实 API 场景及一个离线代理；[事实](10-natural-final.json)、[探针](10-natural-final-source.txt)、[168 文件 SHA](10-natural-final-source-sha.json) | 两产品自主等待和检查、attention 后再等、新输入打断 P；Q 只等第二项却获得完整两项 `reportTargets`，同一 final proof、可见合并回复 1，第一消费仍归 P。无 IM 来源，outbox 不适用。 |
| 独立执行上下文直接读要求、源码、测试和证据，亲跑最小检查 | [原实现审查](10-implementation-review.md)、[消费追加审查](10-delta-review.md)、[续接/来源追加审查](10-continuation-review.md)及各清单 | 原审查与后续返工分开绑定，不能用旧通过覆盖新代码；真实体验和环境未验项仍保留。 |

最后全量、Linux 原生和受控模型均已重跑。自然 API 的源码清单对应最终 Runtime 畸形 `reportTargets` 存在性守卫之前；差异仅拒绝 false/null 等非法字段，正常转交路径不变，该差异由永久坏输入用例和最终检查覆盖，没有再次调用自然 API。源码冻结后的工单与证据整理不改变生产行为。

## 负例与失败记录

同任务复用调用 ID 的新增冷恢复用例在修复前实际得到 pending 而非 reported，见 [修前失败](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-repeated-call-before-fix.log)；修后必须把 consumption.entryId 关联到包含该结果的真实工具条目，且不再调用模型。既有跨任务复用、没有完成标记的后备、发送前和下一模型请求前撤销资料也保留回归。

真实模型首次机制运行暴露第一结果的原专属汇总已排队、父轮中断后抢先总结，第二结果又重复补报，见 [分组修复前日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-model-before-group-fix.log)。现所有可信后备启动前复核本父轮固定组，未齐时停车并继续处理拥有者输入，齐后使用原 canonical 汇总；[排队组回归](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-queued-group.log)与 [独立组边界回归](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-group-boundaries.log)验证原输入、键、delivery.taskId 和真实证明保留。

自然需求初次 Personal 误把保存定义名当作任务 ID，未实际启动；Code 初次门控等待 owner completed 才放子响应，双方重新等待形成 fixture 互等，该次不算产品失败或通过，见 [初次日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-natural-initial.log)。纯工具说明修正后再次自然运行：Personal 完成介入问句却把第一项提前记为最终报告，Code 续接回复与 canonical 再给两份合并总结，见 [返工前日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-natural-before-ownership-fix.log)及 [事实](10-natural-before-ownership-fix.json)。最终自然复验两产品均由新输入中断 P，Q 整组接手唯一总结；本次没有自然走到 P 主动完成问句的分支。Code 合并段落后另附查询修正过程，该次自然 API 不证明严格单段体验。

真实 Driver/TelegramAdapter 冷恢复回归在 first 来源撤销、claim 清除后曾实际发送 Q 的普通 owner_reply，见 [修前 API=1](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-cold-sender-before-fix.log)；修后 outbox canceled/source_revoked，实际请求 0，[5/5](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-cold-sender-final.log)。初审坏输入仅 2/9 正确拒绝，[原失败](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-input-integrity-before-fix.log)与 [修后 9/9](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-input-integrity-final.log)保留；本轮自身消费缺条目/子集与 false 字段也有 [自身消费修前](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-own-input-before-fix.log)、[false 修前](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-falsy-input-before-fix.log)及对应永久回归。坏输入由隔离夹具人为损坏保护历史，证明拒绝语义，不声称正常记录会自行丢失字段；本地适配器请求不是真实 IM 外发。

前两次全量曾出现原生停止未核实、既有 122 超时及 TUI 用例卡住，另发现新增事件 demo 与上下文类别 fixture 未同步，原日志 [第一次](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-full-check.log)、[第二次](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-full-check-final.log)保留。fixture 已同步；112/122/14 独立顺序复验 [43/43](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-failed-files-isolated.log)，最后全量通过，未修改测试运行并发、延长超时、跳过用例或放宽成功断言。负载下原生失败的系统性原因尚未确定，不把一次重跑当作稳定性证明。

Linux 初次 setup 因远端 ENOSPC 失败；复用同锁文件依赖后，125 条绝对包符号链接指向隔离目录外，真实 worker 初始化报 pi-coding-agent 不可见，见 [初始化失败](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-linux-init-failure.log)。在独立副本内将依赖实体化后 [初始化通过](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Fexperience-evidence%2F10-linux-init-fixed.log)，再得到 14/14；没有修改原缓存或放宽执行边界。

## 保留的验证边界与下一角色

[08 实现者](../issues/08-workflow-sidebar.md)可接已验证的 `TaskView.wait/resourcePhase/reportParked` 和对应持久事件，接口见 [control](../../../docs/modules/control.md)；本次没有实现或验收侧栏。本单人工验收已完成；[11 联合验收](../issues/11-experience-acceptance.md)继续负责侧栏焦点/返回/窄屏组合及真实 IM 等跨工单验证。此前自然 API 没有走 P 主动完成介入问句后的续接分支，Coding 的严格单段表现也未记通过，人工确认未提供这些路径的单独证据，保留原工程验证边界。真实 IM 须拥有者授权并提供原绑定入口，核实目标、稳定键和唯一实际送达，本地 FakeBotAPI/TelegramAdapter 只算宿主和适配器回归。Linux 全仓与 Node 22.19/24.15 CI 矩阵也未在本次运行，不能记通过。
