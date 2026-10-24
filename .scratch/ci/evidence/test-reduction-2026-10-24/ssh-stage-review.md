# SSH 受控时钟与真实监听阶段：独立增量审查

对象：`test/38-desktop-personal.test.ts` 的新 READY 标记及 forwardOnline helper。被审最终文件 SHA-256 为 `5a7f861183767b8d295562bd2ebc35043a76422445a368e271774904c1169ddc`。主工作区只读，本轮不运行测试；Node22/24 受控晚监听红绿由 linux_diagnosis 执行。本审查直接读取 PersonalController、ControlConnection、SshProcess 及原 deadline/退避断言。

## 发现与关闭

最初补丁只修复 SIGTERM 后的三次转发重启：新进程写日志不等于 socket 已监听，控制连接失败后的重连 timer 也未必已经登记。增加真实 listen 回调发布 READY=pid，并在推进时钟前等待监听和 online/重连 timer，机制成立。

审查发现相同问题仍在首次 reset 连接和15秒读取超时后的恢复。前者可能先完成令牌读取、在尚未监听的 socket 上失败，reconnect 返回后只等待 online，冻结的重连 timer 无人推进；后者的模拟15秒不会推进真实子进程，直接 tick1000 后也可能在 listen 前失败并留下第二个 timer。Linux 执行者确认先前扰动只延迟 READY 已存在后的转发，尚未覆盖首次，因此不能以原绿灯排除该反例。

实施者已将该顺序提为局部 forwardOnline(h,t)，用于首次连接、每次重启、读取超时后的恢复。已读回确认，当前无未解决阻断。此修复只改测试阶段同步，不更改产品重连预算、期限或协议。

## 最终阶段顺序

READY 仅在真实 net.Server.listen 回调中写入，并携带本进程 PID；helper 读取最新非 reader 子进程，要求文件存在且内容等于该 PID。首次没有文件时继续等待，后续旧 PID 标记不能冒充新转发就绪。读取到写入中的空串/局部字符串只会继续等待，不解析 JSON；清理发生在等待结束之后。

监听就绪后，再等待 controller 已 online 或 ControlConnection.reconnectTimer 非空，只有后者才推进1000ms，然后等待真实认证/快照完成到 online。这里读取原计时器状态，不手工设置状态，不替换 IPC，也不注入成功结果。ControlConnection 每次真实连接仍重新读取 token、连接 Unix socket、认证并同步。

该1000ms属于恢复控制连接的计时推进，不替代被测 SSH forward 退避。连续失败仍先等 PersonalController.retry 登记，分别推进499/1、999/1、1999/1并核实前一毫秒零新增、最后一毫秒启动下一进程。每次在线后的三轮重启仍先用499/1核实退避归零，再调用 helper 完成真实连接。把监听等待放在此后，不会提前创建下一转发或抹掉精确边界断言。

读取期限仍在14999ms确认原 reader 存活，最后1ms触发回收并等待 reconnect 完成，核实超时状态与原 PID 已退出；只把之后的恢复阶段改成 helper。关闭后推进30000ms仍核实没有新 child。独立“读取中替换目标”用例继续使用真实 ignoreTerm 子进程与未模拟的 TERM→KILL 回收，未用 mock 时钟代替 OS 已停止证明。

waitForIo 使用真实 Date.now 和预先绑定的 node:timers/promises 延时；被模拟的只有 setTimeout。其五秒界限是阶段等待失败的诊断预算，不是被测15秒期限或指数退避。失败仍抛断言，由 finally 关闭本夹具资源；没有 skip、自动重试用例或降低断言。

## 验证范围

本轮 `git diff --check -- test/38-desktop-personal.test.ts` 通过。未运行任何新测试，也不冒称 Node22/24 红绿已经完成；Linux 执行者正在对全部 forward 的200ms真实晚 listen 同扰动，比较旧仅修重启版与当前首次/deadline/重启均同步版，覆盖两条 mock 用例。其实际退出码、计时和平台由后续证据记录。完整 macOS/Linux/四格 CI 仍不能由本静态结论替代。
