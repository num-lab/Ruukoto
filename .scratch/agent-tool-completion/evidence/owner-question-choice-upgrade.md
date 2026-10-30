# 提问卡片题型与跳题验收

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../git-history-cleanup/archive.md)。

2026-10-21，拥有者在参考布局上追加缩小自由输入图标、Skip 空答案、删除顶部题号与折叠/关闭、选项可选说明与推荐标记、多选；随后明确多选用复选框替代编号，不显示多选标签。有效决定见[题型扩展](../../../.agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md)，当前代码覆盖全部要求。原[界面补修](owner-question-ui-simplification.md)中的折叠、关闭、仅单选和必填限制按新要求取代，其余原位替换与可信续接继续适用。

## 结果

| 要求 | 实际行为与证据 |
| --- | --- |
| 图标缩小，精简顶部 | 自由输入图标实测12×12；题头无进度、折叠、关闭或多选标签，底部仅一份题号 |
| 单选与多选 | 单选保留编号；多选整行复选框，点击或 Space 切换，选中态和可访问状态一致，推荐不预选 |
| 选项说明与推荐 | 支持旧字符串或 `{label, description?, recommended?}`，说明紧随名字，Recommended 按布尔值显示；名字上限200、说明500字符 |
| Skip | 清除当前单选、多选或自由文本并前进，末题进入核对；允许全部跳过，核对显示已跳过，实际答案仍为空字符串 |
| 选择与自由输入 | 输入文字清除选择，选择不回填输入行；多选按题目顺序保存索引和以换行连接的选项名，不混入说明 |
| 持久化与恢复 | 原键保存完整答案，丢答与后台重启仍只有一次消费和续接；当前格式schema48、协议35，查询页256KiB，快照预览128KiB |
| 回答位置 | 已答卡片继续替换对应用户消息，只有一份，位于续接回复之前 |

最终截图：[650像素卡片](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-choice-checkboxes.jpg)、[760×600视口](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-choice-checkboxes-narrow.jpg)；[实际测量与刷新恢复](owner-question-choice-electron-result.json)和[实际GUI提交后的后台状态](owner-question-choice-submission.json)分别保存，未把另一个档案的IPC预置当成GUI作答证据。`owner-question-choice-multiple.jpg` 是拥有者纠正复选框之前的截图，不作为最终布局证据。

## 工程检查

`npx tsx --test test/owner-question-tools.test.ts test/owner-questions.test.ts test/owner-question-clients.test.ts test/desktop-composer.test.ts` 首次51条中50条通过，一条TUI显示断言漏掉终端补齐空格；修正为允许行尾空格后客户端16条通过，真实落盘答案的精确断言保留。最终复选框改动后，composer与客户端31条通过，独立审查另跑Desktop1条与TUI2条通过。

`npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/12-reconnect-pending.test.ts test/13-tui-state.test.ts test/14-tui-app.test.ts test/66-control-seam.test.ts test/114-workflow-owner-input.test.ts test/owner-question-import.test.ts test/desktop-interaction-regressions.test.ts` 共131条通过，覆盖存储、原键恢复、TUI、协议、原工作流回答、导入拒绝及消息缓存。未跑全仓检查。

最终源代码 `npm run check:static` 通过，文档与证据追加后另跑文档检查；Electron三目标构建、MyGo打包与 `codesign --verify --deep --strict` 通过。没有新依赖。当前工作区由根会话单写，另两上下文仅在临时副本产补丁；独立上下文 `question_upgrade_review` 直接读需求、代码与证据，后端4条、客户端6条和最终复选框3条窄测通过，无未解决阻断。

## 实际客户端

[真实Python PTY夹具](owner-question-choice-tui-pty.mts)运行隔离Runtime、ControlServer和TUI，两轮验证推荐与说明、多选保光标和按题序回答、中文含q的自由输入、返回修改与Skip空答案，以及退出alt screen；[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-choice-tui-pty.log)通过，模型mock。末次运行包含多选以复选框替代编号的最终呈现。

[隐藏Electron夹具](owner-question-choice-electron-harness.mts)使用生产main/preload/renderer、隔离档案与mock模型。实际验证初始无预选、点击及Space勾选/撤销、自由输入清多选、重新选择、翻页、Skip清空手写和单选答案、末题核对及提交。后台最终只保存一个多选答案和两个空答案，只有原任务及一个已完成续接；renderer诊断无新增异常。760×600视口无横向溢出，500字符长说明另以临时DOM布局探针测量，恢复原文后截图，不声称真实提交了该长说明。

首次刷新后直接断言卡片数量失败；调查源码和现行文档确认标签及活动会话仅在renderer内存，刷新回到未选会话画面。随后在另一独立档案经preload IPC预置相同答案，只验证刷新后重新选择会话：恢复一张已答卡片、两个已跳过、无规范化回答气泡，位置仍在续接回复之前。证据保留刷新前后的不同语境，不改变标签恢复策略。复选框前的快速连续方向键读数不可靠；最终Checkbox按Space操作及实际aria-checked核实通过。

## 真实模型与模型可见文本

[一次性脚本](owner-question-choice-model-check.mts)沿实际模型测试的三题用例，显式配置 `magpie/workbuddy-ai/deepseek-v4.1-flash`、普通Coding完全访问会话。真实模型自然结束提问轮，待答期间普通聊天不消费，专用入口提交多选、空备注和随机自由口令后原键唯一续接。[运行日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fowner-question-choice-model-check.log)为1通过、0跳过；[请求与历史](owner-question-choice-model/summary.json)保存4份实际SDK发送前快照、JSONL、选择记录、宿主操作、题答/回执及摘要。

独立审查按实际快照核对J1–J8：工具声明包含选项对象、多选及跳题，参数约束和登记后的下一步一致；创建后请求只剩3个宿主查询工具；结果不泄露内部标识，回答快照包含完整元数据和实际答案。[量化](owner-question-choice-model/tool-schema-estimates.json)中单个ask_user估算417→699 tokens，实际完整请求toolSchemas=11747、systemPrompt=1506；历史不同提供方的11463/1506只作参考，不作同口径前后比较。[manifest](owner-question-choice-model/manifest.json)的9份文件字节及SHA-256全部核对，4份请求的原产物摘要也一致；凭据精确值扫描通过，未保存配置或凭据，Runtime停止后清理临时档案。

## 交付范围

工程验收和本轮实际交互验收通过。真实模型只覆盖上述普通Coding完全访问会话，快照捕获点是SDK委托提供方之前，不等同HTTP请求体；Plan、其他提供方、日常MyGo进程、前台IME及CI全平台未重验。新独立档案通过不代表旧档案迁移通过；schema48/协议35沿精确版本拒绝，原资料需由匹配代码查阅。本工作区MyGo已重新打包，未启动或重启日常应用、未修改或迁移日常档案、未提交、合并或部署。
