# 2026-10-11：macOS 未知孤儿夹具的 CI 失败修复

来源为 [2d1aea5 的 CI](https://github.com/num-lab/Ruukoto/actions/runs/38127175560)。Ubuntu / Node 22、Ubuntu / Node 24、macOS / Node 24 均通过；唯一失败为 macOS 15 / Node 22.19.0 的 `test/101-native-macos-helper.test.ts` 最后一项。

## 失败与反馈

CI 的 `reaped: false` 与未知归属原因断言通过，失败只发生在停止回执后的固定 80ms 心跳增长断言：`未知归属孤儿在返回后仍写心跳，没有被监督器误杀`。用例 4450ms 包含固定 3200ms 清理等待，不能由它单独推出 3 秒夹具寿命到期或实际误杀。

本机使用 Node 22.19.0、正式原生监督器二进制，分别构造两个最窄扰动，均保留原有严格回收断言：

| 扰动 | 旧夹具 | 新夹具 |
| --- | --- | --- |
| 心跳间隔由 20ms 改为 500ms | 相同的停止后心跳断言失败，3472ms | 1/1 通过，1073ms |
| Python 父亲延迟 2 秒退出，恢复监督器前暂停 350ms | 未核实与原因断言通过，最后心跳断言失败，3813ms | 1/1 通过，2599ms |

两种扰动只改变夹具时序，不改 C 监督器。首拍发生时父亲仍可能存在，恢复观察后监督器可以合法累计并回收这条父子链；固定短窗也不能排除写入调度迟延。原 CI 没有记录父亲寿命与逐拍时刻，不能确定它遇到上述哪一条，但两项夹具缺口均已确定性复现并消除。

## 修复

子进程 `setsid` 后先确认 `ppid == 1`，再写就绪身份与首拍；宿主见首拍后才能恢复监督器。这样用例测试的确是已经被收养、父链已消失的新孤儿。

停止回执后在原有 5 秒等待期限内等新的心跳，仍要求 `reaped: false` 及 `unknown_new_orphan` / `observation_interrupted`。心跳永久采用 500ms，超过旧 80ms 窗口；重新改成固定短窗会由同一用例检出。通过 `release` 文件结束夹具，`finally` 同样释放，已报告就绪的孤儿还要等心跳文件关闭后的 `finished` 标记再删目录；20 秒自限时仅在测试宿主中断时兜底。没有向未知 PID 发信号，没有修改生产归属、信号策略或观察窗口。

同步选择与备选方案归[异步测试阶段核实](../../.agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md)。临时红绿反馈测试文件只用于捕获，验证后删除，不入库。

## 最终检查

- 本机 macOS 27.0 / Node 22.19.0：正式 `test/101-native-macos-helper.test.ts` 为 5/5；`RUN_MODEL_CHECK=0 npx --yes --package=node@22.19.0 node --import tsx --test test/*.test.ts` 全量为 1120 项，1119 通过、1 项真实模型跳过，exit 0；未知孤儿用例在全量并发下通过。
- 本机 macOS 27.0 / Node 24.15.0：同一 helper 文件 5/5，exit 0。
- `npm run check:static` 通过，`check-note-anchors.ts` 无悬空锚点，`git diff --check` 通过。临时扰动测试文件已全部删除；C 监督器与生产入口没有改动。

本轮改动只有 macOS 测试夹具及其说明，不重复已经在本次 CI 通过的 Linux 与 Node 24 全量矩阵，也不运行真实模型。上述结果是本机验证，远端 macOS 15 CI 尚待推送后复跑。
