# 测试精简独立只读审查：数字 80+、其他未编号及 foundation

审查对象：28c033f7。审查者：audit_remaining。共 test/119 文件与 foundation/7 文件，合计126文件。仅读源码、既有笔记及用例；未修改主工作区，未运行测试或计时。本报告不是实现验收。

## 四输入联合验收

122-workflow-code-acceptance.test.ts 的四输入方案可以保住当前联合验收。SCRIPT 故意失败编号由6改3，输入改[1,2,3,4]；放行前按稳定键确认change_1/2/3均running、change_4为queued，仅计数3不足以证明排队项身份。成功集为[1,2,4]，总尝试7；change_3一次失败，verify_3零尝试且skipped。保留58–73行冻结摘要对应、修改/验证Task与Session不同、独立目录、验证写入只留验证副本、不污染来源与修改副本。保留真实check.mjs、第4项实际写入来源、第3项保留基线、全执行stopVerified、占用清零、唯一部分失败回报、零普通wake。write_result_missing必须先归因，减规模后通过不等于解释原失败。

## 确定裁剪及合并建议

| 原位置/用例 | 结论与保留边界 |
| --- | --- |
| 83-subagent-worktrees:271–275，授予路径与边界守门尾段 | 删除hooks/fsmonitor设置及assert.ok(true)；后面没有执行副本，不能证明声明的安全边界。 |
| 83-subagent-worktrees:138–139，并行worktree尾段 | 删除两个子任务完成后才写untracked.md并立即读回的片段；它没有核实副本。真实脏内容隔离134–137保留。 |
| 84-subagent-integrate:171，幂等与空差异 | already及事件数=1并入54成功路径。原段还有只读工作integrate拒绝及empty不登记事件，必须承接后才能整删。95-work-copy:165只测结果解析，不能证明Runtime零事件。原只读assert.rejects缺await，承接时补齐。 |
| 84-subagent-integrate:359，main通用修改委派 | main正常修改/汇入属旧个人运行；386–397旧coding角色拒绝委派、零work/agent仍保留，搬到既有兼容用例或Runtime夹具。 |
| workspace-snapshot-runtime-boundaries:231，取消定时运行坏快照 | 删除旧Scheduler→Runtime运行；不是只读归档。 |
| workspace-snapshot-runtime-boundaries:277，定时子工作区失效 | record/baseline两条均删除旧调度运行；其他普通会话/真实快照/冷恢复保留。 |
| work-copy-host-runtime:117，定时运行收尾读取Agent回复 | 删除旧Scheduler选择最终回复的运行接线；现行durable另有实现。 |
| 119-workflow-im-controls:26，双平台完整显式启动/查看/暂停/恢复/回答 | 删除两条旧个人IM工作流运行。与首批95/158同属退役入口。 |
| 119-workflow-im-controls:16及114-workflow-owner-input:20，旧IM命令语法 | parseImWorkflowCommand生产唯一调用在channels/im-workflows，属于旧Runtime IM；现行个人无工作流，code im:false。119可整文件退出；114其他控制面/事务用例保留。 |
| 115-workflow-final-delivery:201、250，IM和定时最终汇报 | 删2个平台与3个定时模式，共5条。dev最终汇总、停止事实、冷恢复回执保留。 |
| 116-workflow-notification-recovery全文 | 删3条；虽然名为recovery，均先新建旧个人IM工作流，重启后继续执行/发送，不是读取旧档案。 |
| 118-workflow-entries:302，个人main控制面拥有者发起 | 删退役运行入口；Coding正常入口及其他来源/权限拒绝保留。 |
| 123-workflow-model-acceptance:16的personal分支 | 导入legacy-product，并非新个人，删除。Coding真实模型分支保留。默认离线skip，不能声称离线提速。 |
| 125-agent-wait-model:83的personal分支 | 删除legacy-product分支，保留Coding及57门控代理协议自测。默认离线skip，不算离线收益。 |
| foundation/test/06-rpc.test.ts全文 | 删除未采用的pi --mode rpc探索。packages及正式产品入口没有RpcClient或该CLI调用，正式SDK由session-factory同进程装配。foundation README改历史定位，不改历史结果。 |
| foundation/test/03-tools:49 自定义工具注册 → 05-plugin:17 | 可以将参数/toolCallId配对/后续模型收到结果断言并入05的host_history路径，再删03第二条；builtin bash保留。收益很小。 |

上述退役依据：apps/ruukoto-code/src/product.ts:6固定im:false/scheduler:false；test/helpers/legacy-product.ts明确仅为旧格式/恢复测试装配；.agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md明确正式个人不用共享Runtime，且不能加载旧运行记录。

## 高成本集合保留理由

83-subagent-worktrees除上表无效尾段外保留。158 LaunchSpec用例为confirm，55首条为full_access继承，不能直接合并而丢受限接线。754/813/858/904分别覆盖结果已到、ready/call、模式切换、后台停止与迟到结果；false和throws也有不同收尾分支，不按同名删。

workspace-snapshot-runtime-boundaries删3条旧调度后保留。真实Git基线损坏、运行中下一模型请求、冷恢复消息/父总结/组内来源/普通注入/冷补记是不同接线点。workspace-snapshot-terminal-boundaries用存储夹具验证错误分类传播，不能替代真实私有基线和Runtime。

84-subagent-integrate保留真实冲突零写入、直接目标、取消/关闭后成果、复用隔离、busy/身份更换、停止矩阵。already可并，empty零事件与只读拒绝不能消失。

原生执行、停止、权限、记录与事件原子性、JSONL历史、恢复不重放、来源撤销、发送前持久化、控制/UI、SDK接线都是保留边界。不同存储/传输/执行层相似标题不算重复。125-agent-wait-resource的main/dev差异按工单明确保留。

## 完整文件清单与模块结论

文件名以下均相对test/，未列具体裁剪者本轮保留。首批工单候选按原方案进行；本表不重复已定的逐条断言。广泛文件按用例、夹具和关键断言归类，重点文件逐段核实；未把其余低成本旧main/IM负例未经承接就判为可删。

### 工具链与入口：保留（6）

`100-offline-test-gate.test.ts`、`124-test-app-runner.test.ts`、`98-development-tools.test.ts`、`99-verification-entrypoints.test.ts`、`99-workspace-boundaries.test.ts`、`control-readiness.test.ts`

### 原生执行/停止/目录保护：保留（13）

`100-worker-stop.test.ts`、`101-instance-lock.test.ts`、`101-native-execution.test.ts`、`101-native-linux-scope.test.ts`、`101-native-macos-helper.test.ts`、`94-task-ending.test.ts`、`dir-identity.test.ts`、`native-linux-identity.test.ts`、`native-macos-identity.test.ts`、`native-mount-protection.test.ts`、`protected-path-batch.test.ts`、`service-helper-stop.test.ts`、`service-helper-transport.test.ts`

### 历史/分支/压缩：保留（6）

`102-branch-session.test.ts`、`103-manual-compaction-store.test.ts`、`104-manual-compaction.test.ts`、`history-recovery.test.ts`、`history-search.test.ts`、`history-window.test.ts`

### 工作流：按首批及上表裁剪，其他保留（23）

`104-workflow-script.test.ts`、`105-workflow-runtime.test.ts`、`106-workflow-host.test.ts`、`107-workflow-runtime-wiring.test.ts`、`108-workflow-import.test.ts`、`109-workflow-cold-recovery.test.ts`、`110-workflow-workcopy.test.ts`、`111-workflow-capabilities.test.ts`、`112-workflow-real-steps.test.ts`、`113-workflow-source-capabilities.test.ts`、`114-workflow-owner-input.test.ts`、`115-workflow-final-delivery.test.ts`、`116-workflow-notification-recovery.test.ts`、`117-workflow-library.test.ts`、`118-workflow-entries.test.ts`、`119-workflow-im-controls.test.ts`、`120-workflow-cli.test.ts`、`121-workflow-personal-acceptance.test.ts`、`122-workflow-code-acceptance.test.ts`、`123-workflow-model-acceptance.test.ts`、`126-workflow-sidebar.test.ts`、`workflow-interface-version.test.ts`、`workflow-role-integration.test.ts`

### agent_wait：删首批及上表旧产品分支，其他保留（11）

`125-agent-wait-attention-report.test.ts`、`125-agent-wait-core.test.ts`、`125-agent-wait-group-boundaries.test.ts`、`125-agent-wait-import.test.ts`、`125-agent-wait-model.test.ts`、`125-agent-wait-queued-group.test.ts`、`125-agent-wait-recovery.test.ts`、`125-agent-wait-report.test.ts`、`125-agent-wait-resource.test.ts`、`125-agent-wait-view.test.ts`、`125-agent-wait.test.ts`

### SubAgent/送达：删首批重复产品分支，其他保留（15）

`80-subagent-delegation.test.ts`、`81-subagent-reuse-close.test.ts`、`82-subagent-cancel-work.test.ts`、`86-subagent-messaging.test.ts`、`86-subagent-recovery.test.ts`、`88-parent-delivery.test.ts`、`92-subagent-lifecycle.test.ts`、`subagent-capabilities.test.ts`、`subagent-definition-core.test.ts`、`subagent-execution-core.test.ts`、`subagent-result-source-boundaries.test.ts`、`subagent-role-driver.test.ts`、`subagent-role-library.test.ts`、`subagent-role-runtime.test.ts`、`subagent-source-capabilities.test.ts`

### 工作副本/快照：按上表删并，其他保留（9）

`83-subagent-worktrees.test.ts`、`84-subagent-integrate.test.ts`、`95-work-copy.test.ts`、`subagent-workspace-snapshot.test.ts`、`work-copy-host-core.test.ts`、`work-copy-host-runtime.test.ts`、`workspace-snapshot-runtime-boundaries.test.ts`、`workspace-snapshot-terminal-boundaries.test.ts`、`workspace-snapshots.test.ts`

### 旧IM接线：84按首批裁剪，窄层资格/恢复保留（3）

`84-im-final-delivery.test.ts`、`89-im-entries.test.ts`、`93-im-approval-lifecycle.test.ts`

### 迁移/兼容/发布：保留（4）

`85-legacy-instance-import.test.ts`、`85-retire-core-group-chat.test.ts`、`87-retire-coding-role.test.ts`、`91-release-acceptance.test.ts`

### 工具/传输：保留（5）

`90-host-tool-families.test.ts`、`file-search.test.ts`、`mcp-images.test.ts`、`mcp-transport.test.ts`、`web-search-transport.test.ts`

### 入站媒体/视觉：保留（5）

`90-inbound-media.test.ts`、`95-media-adapters.test.ts`、`96-vision-driver.test.ts`、`97-media-recovery.test.ts`、`98-media-model-pinning.test.ts`

### 后台进程：保留（6）

`background-browser-acceptance.test.ts`、`background-model-acceptance.test.ts`、`background-process-clients.test.ts`、`background-processes-core.test.ts`、`background-processes-recovery.test.ts`、`background-processes.test.ts`

### 浏览器：保留（3）

`browser-lifecycle.test.ts`、`browser-model-acceptance.test.ts`、`browser-tools.test.ts`

### Cua：保留（3）

`cua-code.test.ts`、`cua-configuration.test.ts`、`cua-mcp.test.ts`

### 托管技能：保留（2）

`managed-skills-reference.test.ts`、`managed-skills.test.ts`

### 持久提问：保留（5）

`owner-question-clients.test.ts`、`owner-question-import.test.ts`、`owner-question-model-acceptance.test.ts`、`owner-question-tools.test.ts`、`owner-questions.test.ts`

### Foundation（7）

`verification/foundation/test/01-compaction.test.ts`、`verification/foundation/test/02-context.test.ts`、`verification/foundation/test/03-tools.test.ts`、`verification/foundation/test/04-sessions.test.ts`、`verification/foundation/test/05-plugin.test.ts`、`verification/foundation/test/06-rpc.test.ts`、`verification/foundation/test/07-connectivity.test.ts`。按上表删并，其余保留。

未运行测试、真实模型、平台验收或计时；性能和负例有效性待实施者及独立实现审查补证。
