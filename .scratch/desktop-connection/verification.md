# 启动连接优化验证

日期：2026-10-17。基点：e90b4fa。环境：macOS arm64、Node 24.15.0，本地真实 Code Runtime、Unix socket、SQLite；模型使用离线夹具，数据准备不计入连接耗时。本轮受验改动以[源码摘要](evidence/reviewed-source-sha256.json)固定。

## 回归与构建

| 检查 | 结果与证据 |
| --- | --- |
| npm run check:static | 通过，[日志](evidence/static.log) |
| desktop 全部定向文件，含 desktop-startup、control-readiness | 217/217，[日志](evidence/desktop-tests.log) |
| 12-reconnect-pending、66-control-seam、71-product-entry、72-on-demand-backend | 91/91，[日志](evidence/control-tests.log) |
| 32-dev 的启动就绪、已有实例、非 TTY 清理与已有 socket 门控 | 4/4，[日志](evidence/dev-tests.log) |
| go test -race ./...（apps/desktop/mygo） | 通过，[日志](evidence/go-tests.log) |
| npm run desktop:mygo:build | 构建及签名通过，[日志](evidence/mygo-build.log) |
| npm run desktop:build | 构建通过，[日志](evidence/electron-build.log)；另行 codesign --verify --deep --strict 通过 |

DesktopHost 的定向用例核实订阅前预热、重复订阅只读一次环境、正式快照一次、预热失败可见与显式重连可重试、关闭后不采用迟到环境。真实环境子进程测试分别覆盖登录 shell 与受管 Node，故意忽略 SIGTERM，取消返回时核实 PID 已消失。畸形 shell 路径也按原环境错误报告。

控制面用例核实 auth→ping、停止与畸形响应、ping 的认证／版本拒绝、超时、中断后 socket 消失重拉起、令牌优先级、锁竞争及已有后台复用。开发启动器的已有实例检查只确认 socket 存在，避免停止中的后台重复拉起；就绪等待仍须认证 ping。

## 同一后台交替测量

每种规模在同一 fixture 上交替运行 e90b4fa 的真实 ensureBackend 与当前实现，再执行同一正式 ControlConnection；每种实现 7 轮，表中为中位数，不含环境读取、窗口与 fixture 准备。会话数指额外创建的测量会话，不含夹具自带的系统会话。旧源码由 git show 在临时模块加载，不改当前工作区。原始[逐轮记录](evidence/paired-connection.jsonl)保留操作数与快照构建次数。

| 数据规模 | 原实现 | 当前实现 |
| --- | ---: | ---: |
| 1 会话，无任务 | 0.628 ms | 0.491 ms |
| 1 会话，4000 条历史任务 | 23.203 ms | 12.049 ms |
| 40 会话，各 40 条历史任务 | 51.290 ms | 24.495 ms |

旧实现每轮 2 auth、2 connect、2 snapshot；当前每轮 2 auth、1 ping、1 connect、1 snapshot。轻量探测节省的是重复快照，不能据此推导整机冷启动提速。

## 真实 MyGo 启动

使用独立 QA 名称、identifier、userData 的真实 Go/WKWebView 应用，资源复用生产构建，sidecar 内容 SHA256 与生产一致。通过 Node preload 被动记录环境读取、订阅、控制操作名和在线状态，不记录环境值、参数或令牌；探针核实登录环境仍指向隔离目录且仅允许连接隔离 socket。CUA 三轮均实际读到 work-0 工作区，再仅向 QA 窗口发送 Cmd+Q。没有停止或连接日常后台。

| 轮次 | 环境领先订阅 | 环境读取 | 订阅至在线 | 应用进程启动至在线 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 709 ms | 1910 ms | 1207 ms | 2808 ms |
| 2 | 134 ms | 788 ms | 658 ms | 972 ms |
| 3 | 160 ms | 768 ms | 612 ms | 937 ms |

三轮均只读取一次环境，操作顺序 auth→ping→auth→connect，只发布一次快照。第一轮与重测试并行，计时明显受负载影响；表中绝对应用时间只作执行记录，不用于提速归因。基点单轮则在订阅后约 4.7 ms 才开始环境读取，操作顺序 auth→connect→auth→connect。原始[汇总](evidence/mygo-summary.json)与[分轮记录](evidence/mygo/)含清理结果和资源摘要，均确认 app／sidecar 正常退出，临时数据、控制目录与 userData 删除，PID 消失。

## 独立审查与限制

验证材料也由 connection_plan_review 独立核对通过：从原始数据重算时间、中位数、操作数与快照数，核实源码摘要、QA 与生产资源一致，亲自严格验证两种应用签名，现查测试 app／sidecar 的 PID 均不存在；日志与清理结果支持报告。

connection_plan_review 在不同执行上下文独立审查方案和实现，无阻断；亲跑 72 条相关用例均通过。审查者在临时副本恢复 e90b4fa 的两处旧实现，新预热回归因构造时读取次数 0 而失败，新探测回归因发送 connect 而失败，见[负例](evidence/negative-controls.json)。

没有执行全量 npm run check、Linux 矩阵、真实模型、Personal SSH 或新的 Electron 交互验收。真实 MyGo 未在预热中途退出，关闭竞态与直接子进程回收由定向测试覆盖。登录脚本自行派生的后台进程不属于宿主回收范围。后台进程冷启动、快照 SQL 与分页不在本轮范围。
