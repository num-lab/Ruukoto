# oracle Node22 模型流强杀窄例诊断

本轮只写本机/tmp与远端 `~/.local/ruukoto39/diagnostics/`，未改产品、原测试、live-profile、真实后台或隧道。所有请求为loopback MockModelServer，真实模型/IM均为0。原测试SHA256为35295ae007d7c2bcb426b371a92566d4ce478efe0ff9482efbba3554cc0e2481，与本机相同。

## 可确定的事实

原派生诊断本身有两个错误：child eval绝对路径被写成 `/current/test/apps/...`，先发生ERR_MODULE_NOT_FOUND；异常处理随后直接打开尚不存在的SQLite，ERR_SQLITE_ERROR覆盖了等待超时。故不能据该派生轮得出“原stock在5秒时没有创建库”。原stock两轮超时日志继续保留。

修正派生路径、先保存stdout/stderr/child PID/exit/files，再在存在时读SQLite；原5秒wait和15秒用例预算均未动。Node22 v2通过1/1；还原stock相对eval导入的v3通过1/1，partial标记4892ms到达；加三个阶段stdout时间点的v4通过1/1，标记4959ms到达，仅余41ms预算。两轮成功时calls=1、child仍存活，stderr只有SQLite实验警告。

v4以成功JSON文件mtime近似保存时刻计算：spawn到eval静态导入完约4500.9ms，eval到Harness打开84ms，打开到submit5ms，submit到持久partial约369.1ms。前后两个估算受保存时刻误差影响；它们不是原失败轮的耗时。Node24.15执行原版stock同窄例通过1/1，用例约4171.47ms。

## 三假设结论与剩余范围

H1“启动/准备耗时挤压5秒”得到本轮直接时间证据支持；H2“进入partial前报错”仅在被改坏的派生诊断成立；H3“partial未观察或calls不再等于1”在本轮成功现场没有出现。原stock失败时的完整状态仍缺，不能据后续绿测认定唯一原因、关闭原失败或宣称没有产品缺陷。下一次若再现，安全派生诊断已能先保存原错误与现场，避免诊断遮蔽。

## 证据

- `/tmp/ruukoto39-node-stream-diagnosis-summary.json`：命令对象、结果、边界与逐文件哈希。
- `/tmp/ruukoto39-node-stream-diagnostics.json`：远端派生源码、成功状态、各源码SHA；没有改动当前检出。
- `/tmp/ruukoto39-node-stream-phase-timing.json`：阶段时间的计算与近似限制。
- `/tmp/ruukoto39-node22-stream-v2.log`、`-v3-stock-relative.log`、`-v4-phase.log`：三轮窄结果。
- `/tmp/ruukoto39-node24-stream-stock-control.log`：Node24原版对照。

未扩大或重复宽批次，未改预算，未操作生产资源。原stock两次失败仍是最终验收的未归因记录。
