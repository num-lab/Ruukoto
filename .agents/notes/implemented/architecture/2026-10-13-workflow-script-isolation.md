# Agent Note: QuickJS/WASM 固定编排入口

Status: implemented

## 问题

[工作流方案](../../implemented/feature/2026-10-12-agent-workflows.md)需要执行模型生成的 JavaScript，不能把 Node、凭据、文件或网络能力交给编排脚本。同步 WASM、异步宿主调用、恶意脚本与整进程回收需要实测，不能依据上游兼容声明放行。

## 决定

`packages/agent/src/script-worker/` 使用 `quickjs-emscripten-core` 与 `@jitl/quickjs-wasmfile-release-sync` 0.32.0；只有 agent 包声明依赖，根 lockfile 固定解析。固定 worker 打包包含解释器 JS，从同目录加载复制出的 WASM，目标为 Node 22.19；脚本文本与 JSON 参数只走专用 stdio 协议，不成为 Node 入口或 argv。

脚本在 QuickJS 中只能经四类 Promise 原语请求宿主。进程环境只有固定 LANG；不传来源访问模式、工作区、凭据或 Runtime 对象。宿主回调负责授权、持久状态与真实步骤，本入口不实现协调器或产品工具。解释器移除模块加载、时钟、随机数与未管理定时器；输入和结果使用捕获的 JSON 原语，保留 `__proto__` 字段，脚本改写全局 JSON/Promise 不能改变宿主转换。

沿用[停止事实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)：先建立独立 UUID 的 starting 占位，启动后保留 LaunchedUnit 身份；取消覆盖启动期间的迟到单元，停止 Promise 缓存 false 与异常原因。固定 worker 不提供外部进程派生接口，因此复用原进程组的 TERM/KILL 与停止核实，不改现有工具 launcher。来源为完全访问也不能改变解释器能力；步骤工具仍沿[原有来源授权](../feature/2026-10-12-full-access-current-account.md)。

### 中止与回收

纯计算使用 QuickJS interrupt；微任务每批 64 个让出事件循环，并检查解释器时间。独立父进程从发送 start/reply 到相应 idle 计累计墙钟时间，默认 10 秒；宿主等待不计，启动另限 10 秒。长内建和转换可能迟迟不执行 interrupt，所以父进程必须能停止整个单元。

[宿主派发修复](../bug-fix/2026-10-22-workflow-host-idle-dispatch.md)规定 call 只登记，最新 idle 停计后才派发本批回调，避免管道分帧时把宿主同步工作计入脚本预算。

实测无限 Promise 链在 interrupt 后清理 runtime 可能触发上游断言，且 executePendingJobs 可能仍返回 success。异常路径发送有界失败后退出进程，回收整个 WASM；不把 dispose 当成可靠的异常回收条件。正常路径释放 deferred、结果句柄、context 和 runtime，完成帧后还须通道排空、正常退出及进程组核实，异常退出保留已收到结果但不报成功。取消后不登记或推进迟到调用，宿主实际步骤仍由回调的持有者停止。

### 限额

脚本 128 KiB、帧 1 MiB、排队发送 4 MiB、未决宿主请求 32 个、进度 256 次及 256 KiB；QuickJS 堆 32 MiB、栈 256 KiB、WASM 线性内存 64 MiB、Node V8 old space 64 MiB。解释器堆、WASM、V8 和消息限制各有对象，均不承诺整个进程 RSS 上限。稳定键语法和原语类别由入口校验；键的幂等、依赖、资料与业务 schema 校验归后续协调器。

## 既有笔记审计

按 QuickJS、WASM、工作流、worker 与停止核实检索 proposed、implemented，rejected 目录不存在。工作流总提案部分重叠，保留其未实施的持久运行、能力与交互要求，本篇只持有实际脚本选择；停止保留笔记部分重叠，复用其生命周期，不取代任务收尾决定；完全访问、原生沙箱与工具 worker 部分重叠，保留其工具边界，本篇独立约束编排脚本。其他命中是既有产品装配或无关功能，不吸收。

## 备选方案

- `node:vm` 或 Worker：可直接复用 JavaScript 与 Promise；前者不提供安全隔离，后者的资源限制不覆盖全部外部内存，不能作为模型脚本的能力边界。
- Asyncify QuickJS：能将异步宿主调用写成同步桥；脚本使用 Promise 即可表达编排，release-sync 已通过实验，不引入另一构建。
- 复用 ToolWorkerHost 或将脚本当作 bash：已有工具执行与停止路径；协议和能力不同，来源为完全访问还会继承用户环境，因此只复用执行身份和核实函数。
- 只使用 interrupt 与 dispose：代码少且普通计算有效；长内建迟迟不中断，无限 Promise 异常清理会 abort，必须保留父进程强制回收。

## 后果

同步 WASM 无平台原生解释器扩展，两产品可复用相同库层入口。每次执行创建独立进程，承担启动和 WASM 初始化成本；以进程退出作为完整回收保证，避免跨运行残留。没有 OS 层进程 RSS 配额；如果以后需要这种保证或外部子进程能力，须重新设计平台限制与回收，不能沿用本篇实验结论。

四格假 Agent、打包路径、故意失败与原始结果见[隔离证据](../../../../.scratch/agent-workflow/isolation-evidence/README.md)。它证明脚本入口，不代表持久工作流、真实步骤、模型或 IM 产品验收。
