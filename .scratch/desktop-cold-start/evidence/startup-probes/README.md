# 本地 Code 后台冷启动分阶段测量

本目录是 c19d63e 上的临时只读诊断。仅运行显式临时 data/agent/control 的正式 ruukoto-code bin，固定本地 MockModelServer 模型配置；未执行任务或工具，未连接、停止或重启日常后台，未改仓库源码。后台进程不存在称为本次冷启动；系统文件缓存、共享 tsx 缓存没有清除，因此不能称整机或磁盘冷缓存启动。

基点：`./node_modules/.bin/tsx /tmp/ruukoto-connect-cold.mts > /tmp/ruukoto-connect-cold-c19d63e-baseline.jsonl`，此旧脚本显式 --tools mock，只供先前测量可比，不作为真实工具路径代表。三次总连接时间为 1612.941、1413.275、1409.502ms。

主矩阵：`./node_modules/.bin/tsx /tmp/ruukoto-code-cold-stages/measure.mts --modes=none,light --tools=coding,mock --rounds=3 --restarts=2 --tag=matrix`。coding 不传 --tools，采用产品默认 native 后端与真实编码工具；mock 显式 --tools mock。每个模式与工具组合创建三个全新空档案，每个档案正常停止后再启动两次。只保证启动装配真实，未执行任务，因此不代表 native 任务沙箱校准或工具工作进程执行耗时。matrix-results.json 是完整原始数据，matrix.jsonl 是逐轮时间；`node /tmp/ruukoto-code-cold-stages/summarize.mjs matrix` 生成中位数和阶段摘要。

轻量观察器 observer.mjs 在子进程 Node preload 注册同步 load hook，仅在 bin/main/cli 三个模块的既有代码中加入阶段 mark，不改变逻辑；事件保存在内存，到 socket 监听与进程退出时写 JSON，避免每次同步写盘。其余模块调用原 loader。保留 Node preload、bin body、tsx register、main import/body、runCli/runServer、Runtime import/start、ControlServer import/start/listening 阶段。父进程同时记录 spawn、探测连接尝试、auth/ping、ensure 返回和正式握手，socket ready 到 ensure 返回用跨进程墙钟相减，精度约 1ms；同进程阶段用 performance.now。

无探针对照：默认 coding 新空档案三样本总时间中位 1209.811ms，轻量探针 1209.538ms；已有空档案六样本 808.779ms 与 807.663ms。整体差小于 2ms，不能据此断言探针完全无开销，因为 200ms 轮询将小的 ready 时间差量化或掩盖；主矩阵也未交替每一对 none/light，保留顺序与原始样本。

深层定位：`./node_modules/.bin/tsx /tmp/ruukoto-code-cold-stages/measure-deep.mts --modes=deep --tools=coding --rounds=2 --restarts=1 --tag=deep`。observer-deep.mjs 在原三模块之外，仅给 Runtime 模块加入 Db、构造器、模型配置、恢复与编排器阶段。deep-results.json 表明新库 Runtime.start 454/442ms 中 orchestrator.start 占 433/427ms，Db 仅 3.5/3.2ms；重启 Runtime.start 约 13.6ms。首次改变 Runtime 模块的插桩使其导入阶段增至 777ms，下一轮恢复 643ms；因此不可把 deep 首轮总量当作正式运行速度。

目录定位：`./node_modules/.bin/tsx /tmp/ruukoto-code-cold-stages/measure-dir.mts --modes=deep --tools=coding --rounds=1 --restarts=1 --tag=dir`。observer-dir.mjs 仍仅四个模块，额外区分角色创建时 resolveUsableDir 与 assertGrantNotProtected。新库 Runtime.start424ms 中编排器404ms、目录解析402ms、保护路径检查401.8ms；正常停后同档案再启跳过角色创建，Runtime.start13.6ms。原始数据见 dir-results.json。

所有成功启动都经已认证控制面 stop，等待精确捕获的子进程 exit0，再删除临时档案；异常仅向当前 fixture 捕获的独立子进程发信号，绝不使用按名称广泛 pkill。各 tag-cleanup.json 保存退出记录，最终 source-hashes.json 保存当前生产源码与临时脚本 hash。测量仅在代理间分时运行，没有与依赖图代理同时执行重负载计时。
