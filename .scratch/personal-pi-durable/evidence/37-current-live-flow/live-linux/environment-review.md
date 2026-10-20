# 37 Linux 隔离部署独立审查

2026-10-18，独立上下文 linux_preflight 只读核对本机与 tx；没有读取 private、环境变量、control.token 或 SQLite 正文，没有调用模型、IM、服务动作或控制 API。

结论：隔离准备无阻断。build.json 的 250 份源码两端 SHA-256 全部相符；284 个运行包的 package.json 全部相符。实际 worker 的 SHA-256 为 c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3。仅核对包清单，未声称逐字节审计全部依赖。

实际安装 helper 与当前源码仅两处部署路径常量差异，逐字节验证通过；SHA-256 为 63c7e1833b067a092432ad770d028a8b3f1c63be54ac1810aa55e39728451944。helper、policy、ops 及父路径权限正确；白名单仅新测试 unit，检查身份为 1003:1003。测试 unit 使用 eitrous、Restart=no、无网络及文件系统限制；审查时 active，计数为 1。标准 helper、策略哈希及生产后台 PID 3963064、active/running、NeedDaemonReload=no 保持。

server-1 PID 3592597、原 starttime 1175699382 与 cwd 匹配；control.sock 为 0600 且正在监听，owner.sqlite 的独占写锁由该 PID 持有。serve 位于登录会话 session-268006.scope，清理须按原 PID/starttime 和命令原 scope 核实，不能停止整个登录会话。该临时前台后台不构成正式 systemd 部署验收。

真实流程及最终清理由主 Agent 继续验收，本审查不替代这些证据。
