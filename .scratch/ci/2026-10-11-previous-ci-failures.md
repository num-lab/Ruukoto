# 2026-10-11：上一轮 CI 失败修复

来源为 [5e84daa 的 CI](https://github.com/num-lab/Ruukoto/actions/runs/38114738658)。macOS / Node 22 有 test03、21、22 三项失败，macOS / Node 24 有 test21、86、100，Ubuntu / Node 22 仅 test21，Ubuntu / Node 24 有 test21、86。后续 ed5a598 的四个矩阵先被 proposed 目录断链挡住，没有运行到应用测试；断链已在 `3d83e8c` 修复。

## 原因与修复

| 失败 | 已核实的原因与处理 |
| --- | --- |
| test21：分类数 `14 !== 13` | 工作清单分类已登记，旧测试仍要求 13；更新为 14，并检查工作清单标签及旧记录零用量 |
| test86：sent 事件全为 task 的断言失败 | 事件保存发送当时的 pending，消息行在冲刷后记录实际投递；用 gate 固定发送方忙碌，严格检查 pending、唯一投递任务、来源及历史不变 |
| test22：取消审查时调用数 `0 !== 1` | in_progress 落盘早于模型服务接收请求；用 responder 开始信号同步，并在迟到响应生成后检查 superseded 与未消费 |
| test03/100：子进程停止后占用未释放或回收返回 false | CI 未保存 ps 的原始错误或输出，尚不能确定远端精确原因；已确定性复现短暂查询失败立即放弃阶段预算的问题，改为在原预算内继续核实，查询超时与休眠按剩余预算收紧，耗尽后不再重查 |

审查修复同样覆盖人工抢先、权限变化与后台重启，不新增生产等待接口、不靠延长超时或固定 sleep。语义与取舍见[异步测试阶段核实](../../.agents/notes/implemented/testing/2026-10-11-await-observed-async-phases.md)。

## 已完成的验证

- `npx tsx --test test/21-context-breakdown.test.ts`：8/8；旧的分类用例单跑可稳定复现失败。
- test86 在固定忙碌 gate 下旧断言失败，修复后 `test/86-subagent-messaging.test.ts` 9/9；test62/80/92/91 共 45/45。
- 审查请求发送前门控：旧取消断言稳定为 0，新版同门控通过。test22/58/63 共 38/38；人工抢先、取消、权限变化、后台重启四项用例四并发复跑 12 轮，共 48/48。

- 最终停止用例 `test/100-worker-stop.test.ts`：34/34。真实忽略 TERM 的进程组前两次查询注入失败，随后使用宿主 `/bin/ps` 核实退出；同一夹具导入隔离的旧 HEAD 实现连续两次返回 false，最终实现通过。持续错误、不完整输出与零预算首次核实另用明确回调覆盖。
- 预算控时负例：修复前 TERM 20ms / KILL 0ms 在模拟时刻 0、55、55 发起查询，超时均为 2000ms；修复后只在 0、20 查询，超时为 20、1ms，休眠为剩余 15ms。未知回执仍不能算成功。
- `npm run check:static`：最终修改通过；`check-note-anchors.ts` 无悬空锚点，`git diff --check` 通过。

所有模型调用均为桩；OS 进程回收用例使用真实进程，查询故障为夹具注入，不能写成已经捕获远端 OS 的原始错误。

## 平台检查

| 环境 | 命令与结果 |
| --- | --- |
| 本机 macOS 27.0 / Node 24.15.0 | build、check:static 通过；全量 `npm run test:app` 为 1120 项，1119 通过、1 项真实模型跳过；`npm run test:foundation` 为 9 通过、1 项真实模型跳过 |
| `ssh tx` 隔离检出 / Node 24.21.0 | 初版修复的 build、check:static 与全量应用测试通过：1116 项，1110 通过、6 项平台或真实模型跳过；SDK 依赖补齐后 foundation 为 9 通过、1 项真实模型跳过。停止预算与最终查询夹具更新后 test03/100 为 40/40 |
| 本机 macOS / Node 22.19.0 | 最终 test03/21/22/86/100 定向检查 74/74，exit 0 |
| `ssh tx` 隔离检出 / Node 22.19.0 | 同一组最终定向检查 74/74，exit 0；Node 使用 npm 临时缓存，没有替换系统 Node |

macOS 全量复跑使用只有诊断输出区别的临时监督器二进制；其安全判定与正式源码一致。完成后重新 `npm run build:native` 恢复正式二进制，`test/101-native-macos-helper.test.ts` 五项实际 OS 用例 5/5；最终查询夹具调整后 test100 另验 34/34，无需重复与其无关的全部应用测试。

Node 22 两平台均运行 `npx --yes --package=node@22.19.0 node --import tsx --test test/03-lifecycle.test.ts test/21-context-breakdown.test.ts test/22-auto-review.test.ts test/86-subagent-messaging.test.ts test/100-worker-stop.test.ts`。测试与源码使用最终修改版本，不把 Node 22 定向结果写成该版本全量矩阵已经运行。

Linux 的原 `npm run check` 在应用测试通过后，因隔离目录缺少 `verification/foundation/node_modules/.bin/pi` 使 RPC 用例报 ENOENT，模型服务夹具未关闭导致进程继续等待。只终止已核实属于本次检出的精确测试与 SSH 进程，执行 `npm run setup -- --skip-hooks` 补独立依赖后 foundation 通过；不将原整条 check 记录为 exit 0，也不重复已通过的应用测试。未操作在线个人 Agent 或系统 sandbox profile。

## 额外观察与限制

首次本机 Node 24 全量检查为 1114 通过、1 失败、1 跳过：macOS 监督器控制通道回收用例返回 `identity_unavailable`。原日志缺少具体 PID、libproc 字节数与 errno；原用例单跑、顺序 10 次配合约 59,166 次短命进程退出、带身份诊断的全量复跑均未再现。临时诊断只记录失败身份查询，未修改归属、观察窗口或信号规则；最终正式二进制五项通过。此单次身份查询不可用的精确原因仍未捕获，不把未核实改为成功，也不声称原生监督器的未知归属限制已经消除。

停止查询夹具初版使用 PATH 中的临时脚本模拟前两次失败。在本机重核时，9 次带回执运行中有 8 次脚本尚未开始就耗尽 200ms 查询预算；这些运行的 KILL 成功、最终原组明确消失，脚本计数却不存在。最终改为直接注入前两次回调错误并恢复真实系统查询；持续失败与不完整输出也使用明确回调，避免命令启动延迟遮蔽待验路径。未延长停止预算，未扩大信号处理范围。

上述结果来自本地与隔离目录的验证，验证结束时尚未重新运行远端 CI。原 CI 的 `ps` 错误与首次本机监督器身份错误均未被精确捕获，已区分确定性回归、真实 OS 证据和仍未确定的原因。
