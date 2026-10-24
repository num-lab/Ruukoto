# TUI 退出后迟到应答修复：独立实现审查

审查对象：主工作区相对 `28c033f7` 的 `packages/tui/src/tui/app.ts`、`test/32-dev.test.ts` 小修复，以及 `.scratch/ci/issues/03-tui-exit-late-response.md`、对应 bug-fix 笔记与 `docs/modules/tui.md`。主工作区只读；本轮负例仅改 `/tmp/ruukoto-neg-y53r145s` 的独立源文件。采用 development-workflow、error-handling 与 prose-standard 核实退出归属、恢复保证和证据范围。

## 结论

实现无阻断。quit 已同步设置 exiting 并调用 stopTimingTick；submitText 收到迟到结果后会 notify/refreshAll，且 finally 必定 refreshAll，原 tickTiming 可以重新创建引用计时器。连接已关闭，前端可能永久保存 running 状态，因此计时器不会因后台实际完成而自行停止。新增 guard 位于计时器创建的唯一入口，覆盖所有迟到刷新；不取消后台任务，也不丢弃原提交应答或改变请求事实处理。

32 原用例中的任务中断、重载文件 kind/instance/session/draft/continueForTaskId、重开会话与草稿恢复、继续模式提示和新任务 resumesTaskId 断言全部保留。模型门保证 continue 在退出时仍真实运行；应答门位于原 SubmissionGuard.submit 完成之后，退出后才交回 app，未伪造 accepted 结果。等待 submitting=false 后，finally 内 refreshAll 已同步执行完成，timer=null 断言不会抢在故障窗口之前。随后直接查真实 Store 仍为 running，再放行模型并等 completed，证明客户端退出没有变成后台取消。失败 cleanup 回收重新出现的 timer，确保反例以断言失败退出；这段 cleanup 位于断言之后，不会掩盖回归。

该 guard 只约束动画资源。迟到请求仍可按原逻辑完成状态与重载资料收尾，未把本次局部修复扩大成“丢弃所有退出后异步工作”或“所有客户端资源均已验证”的承诺。对应笔记的决定、备选与后果，以及 tui 模块的退出契约与实际代码一致。

## 独立红绿

环境为 macOS Darwin arm64 / Node v24.15.0，RUN_MODEL_CHECK=0、RUN_BACKGROUND_BROWSER_CHECK=0。先复制当前 app.ts 和32测试到已有独立副本。因副本 node_modules 只读链接主安装，唯一测试导入改为 `../packages/tui/src/tui/app.ts`，确保实际被测 TuiApp 是副本源码；不改断言或其他运行依赖。每轮只执行本条 test-name-pattern。

| 阶段 | 改动与结果 | 完整进程墙钟 |
| --- | --- | --- |
| 反例 | 只撤去 tickTiming 的 `if (this.exiting) return;`，退出1；32:683 的 null 断言得到 refed=true、repeat=80 的 Timeout。1失败，零取消/跳过，未触发55秒监护。 | 6.928秒 |
| 恢复 | 恢复原 guard，其余输入和用例相同；退出0，1/1，零失败/取消/跳过，未触发监护。后台 running→completed 断言通过。 | 6.215秒 |

源码 SHA-256：`f5440a675b05dc0f3de9bdadbd2607e77e4fc8d91313c739c87da3a74c617af2`；测试 SHA-256：`a3978e5741eddda4e2a05221f9619ac0bab04ccb6e7f264732b1555c668e9548`。两轮结束后副本源码与测试恢复原字节，并与主工作区核实相等。`git diff --check` 对该修复及 tui 文档通过。

可查产物：`/tmp/ruukoto-tui-exit-negative-mutated.log`、`/tmp/ruukoto-tui-exit-negative-restored.log`、`/tmp/ruukoto-tui-exit-negative-review.json` 和 `/tmp/ruukoto-tui-exit-negative-review.py`。JSON 记录命令、哈希、退出码、平台、计时和导入重定位。这里的失败是预期行为断言失败，不是复制、导入、启动异常或监护强退。

## 证据表述与未验证项

03 初稿把 Linux 修复后的7.38/9.2秒写为“完整文件”；Linux 执行者已确认它们是带 test-name-pattern 的同一窄场景完整进程，非32全部25用例。实施者已改成“同一窄场景的测试进程正常退出”，本审查读回确认，表述问题已关闭。其旧32整文件25/25结果是另外的 Node24 76.927秒，不能混用。本审查没有亲自执行 Linux，也不把执行者记录当成自己的重跑。

Linux 受控机制可以解释原 CI 中32进程不退出，但旧 CI 无句柄栈，不证明历史那一次一定由此应答触发。03和笔记目前保留了这一区分。macOS 新回归直接证明修复可检出，不代替新候选完整 check 或原四格 CI；真实模型与 IM 未运行。完整检查仍由实施者收集，本轮没有与其并发运行其他测试。
