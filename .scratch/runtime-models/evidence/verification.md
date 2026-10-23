# RuntimeModels 验证

环境：macOS，Node 24.15.0；基点 develop / a4d2139e；验证对象为本次提交前的工作区内容。模型请求使用本地模拟 provider，配置文件、SQLite、控制面、Runtime 与客户端接线为真实实现。

## 作者检查

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsx --test --test-concurrency=2 test/31-model-config.test.ts test/86-subagent-recovery.test.ts test/104-manual-compaction.test.ts test/98-media-model-pinning.test.ts` | 48/48 通过，约 37 秒；覆盖配置、消息补投、压缩占用与媒体选择。此轮早于下述停止等待位置修正 |
| `npx tsx --test --test-name-pattern='配置停止等待\|模型配置解析完成\|认证仍在途\|门闩窗口' test/31-model-config.test.ts` | 停止顺序修正后 7/7 通过，约 7 秒；包括活动任务先中断、完整配置操作后收尾 |
| `npx tsx --test --test-concurrency=2 test/18-model-selection.test.ts test/22-auto-review.test.ts test/66-control-seam.test.ts test/desktop-settings-models.test.ts test/14-tui-app.test.ts test/33-config-tui.test.ts` | 最终源码 128/128 通过，约 108 秒；[输出](03-regression.txt) |
| `npm run check:static` | 最终源码 lint、根与全部 workspace/foundation typecheck、笔记及文档检查通过；[输出](04-static.txt) |
| `git diff --check` | 通过；新增源码与笔记另核实单一末尾换行 |

未运行全量 check、Linux、真实外部模型/IM 或生产部署验收；没有改变原生执行实现、协议、配置格式或 schema。上述测试不证明真实认证与服务连通性。

## 回归有效性

临时撤去 Runtime 对完整模型管理操作的等待，运行三个 `配置停止等待` 用例：rebuild、rollback、flush 均因「完整操作结束前不能关库」断言失败。试验在独占工作区执行，finally 恢复源码，未把临时变体用于交付；[失败输出](02-stop-negative.txt)。恢复后相关用例通过。

独立审查另用真实 Runtime 与在途任务复现等待位置过早的问题：probe 认证悬挂时，原顺序虽然设 stopping，仍未调用 Driver.requestStop，任务保持 running。等待位置已改为活动任务 requestStop 循环之后、Driver.dispose 之前。强化用例要求认证未结束时活动任务已经 interrupted，而 Driver、数据库和配置锁仍保留；释放认证后停止才能完成。

## 独立实现审查

2026-10-23，审查者 `/root/tui_architecture` 直接读取实现、调用方、测试及方案，亲自执行首轮定向 31/86 的 10 项用例；停止顺序修正后再执行重建、回滚、冲刷及活动任务停止的 4 项用例，全部通过。最终结论为无未解决阻断，`git diff --check` 通过。

被审实现见[未提交快照](05-implementation-review.patch)，包含 tracked diff、新增 models.ts 和 implemented 笔记，SHA-256：`8997de25f90ebccd9841fc72c6dd0bec5e9d710508a47b91d806b7bbc927d157`。后续只更新本工单及证据，不改实现。方案原始审查快照另见 [01-plan-review.patch](01-plan-review.patch)。

## 结论与限制

Runtime 从 5,845 行减至 5,425 行；独立模型配置模块 428 行。九个管理入口直接由控制面调用，运行时默认选择保留只读 getter；模型栈、门闩和完整操作各有唯一持有者。总量变化包含类型声明与新增停止保证，未把迁移行数宣称为总删减或性能提升。

连接测试的 30 秒计时不包括认证解析，也不是取消收尾证明；停止可能等待实际操作结束。共享 snapshotConfigFiles 把读取失败当缺失的既有风险未修改，仍需单独处理。文件更新与 SQLite 配置事件不是原子事务。
