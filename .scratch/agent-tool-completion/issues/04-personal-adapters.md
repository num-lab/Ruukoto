# 个人 durable 接入检索、持久提问与后台进程

Status: ready-for-agent

## 目标与边界

在三个Coding切片通过其验收后，按[共享规格](../spec.md)接入个人端，保留独立durable、来源与IM代次。分别依赖[文件检索](01-coding-file-search.md)、[提问](02-coding-owner-questions.md)、[后台进程](03-coding-background-processes.md)；不是为复用而导入旧runtime/Store/ApprovalGate。

## 方案

1. 复用检索纯参数/解析，新增绑定tools资料根的只读执行适配，接personal-tools/IO/artifacts/config/harness及原权限、定时/子工作工具快照。受限递归搜索不在宿主raw spawn，也不借command目录替代资料范围。
2. 新增个人问题document/不可改entries、answer-admission及唯一续接Task；扩展personal-source和实际请求证据，在本机control/CLI及QQ/Telegram原宿主菜单实现查询、逐题回答、取消、回执与换代失效。沿固定原键接回main，不占住主聊天。
3. 主会话完全访问的显式后台工具使用command.json固定目录、独立durable执行与输出记录，复用底层机器/执行身份。新增共享目录claim，后台starting、普通命令prepare/start、文件写批准消费均事务核实并认领，持有至各自停止/观察完成，未知保留；不能只在后台启动时读一次现有命令表。不向子工作/调度开放start，旧两分钟run_command语义保留。
4. 停机配置与扩展升级先核实旧未决工作，恢复双向核对全部document/entry/Task/来源/占用；新增扩展阻止旧程序忽略记录。没有相同原生能力的平台明确不支持，不退回宿主无限制执行。
5. 更新personal-durable/agent-tools/execution/scheduler及usage中受影响说明，README/development/pre-push同步实际新增前提或入口。按能力逐个接入和验证，不把三个适配合成一次不可定位的验收。

## 进展与交接

- 当前角色：方案者；revision2已通过独立审查，两端语义与先Coding顺序已确认，个人适配未实施。
- 下一角色：拥有者审阅；进入个人实施前重核三个Coding工单最终接口，实质变更须更新本单并复审受影响契约。
- 当前内容：基点与范围见[源码调查](../evidence/investigation.md)，被审文档见[审查记录](../evidence/plan-review.md)。
- 阻塞：依赖前三单实际交付与真实平台证据；不把暂定接口当作已存在exports。

## 验收与证据

文件检索新增个人窄测并扩展`test/personal-tools.test.ts`、`test/personal-tools-controls.test.ts`、`test/personal-tool-io.test.ts`及实际受影响的scheduler权限用例；覆盖撤权、目录替换、链接、子来源和定时快照。

问题新增`test/personal-questions.test.ts`（拟新增），覆盖main待答期间普通聊天可继续、答后一次续接、崩溃/丢答恢复、双平台错答、配置换代、原菜单/引用伪造、模式变化及模型请求双边界来源核实；回归`test/personal-telegram.test.ts`、`test/personal-qq.test.ts`与实际受影响的CLI用例。

后台新增`test/personal-background-processes.test.ts`（拟新增），覆盖独立durable归属、固定命令目录、主会话资格、后台starting与已有/后续文件写和普通命令的双向竞争、批准消费与启动交错、父子路径/现有dev/ino冲突、claim恢复断链、原入口撤销、预算/关停/重开停止与未知保占用；回归实际影响的`test/personal-command-work.test.ts`、`test/personal-command-execution.test.ts`和工具恢复用例。Linux真实scope与原机器停止必须单独执行。

实施检查为`npm run check:static`及上述有实际影响的窄测，构建变动再加build:worker/产品入口。真实模型、QQ/Telegram菜单、私聊代次和本机管理各自验收；没有凭据时明确未验。工程及产品验收待验证，方案审查见[审查记录](../evidence/plan-review.md)。

## Comments

2026-10-21：拥有者确认两端规划、先Coding；个人端复用底层能力而不迁回旧共享业务运行时。
