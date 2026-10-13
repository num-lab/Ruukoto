# 工作流脚本运行候选核实

核查日期：2026-10-12。范围为[规格 A3](spec.md)的受限 JavaScript 执行；只读核查由 `workflow_feasibility` 完成，未安装依赖或运行实验。这是候选依据，不是隔离能力已验收的证明。

## 首选实验方案

将 QuickJS WASM 的同步构建放进独立子进程，仅暴露编排函数，经有界消息调用宿主 Agent。候选为 `quickjs-emscripten-core` 加一个 release-sync WASM 包；上游提供拆包方式与 Promise 桥，`agent()` 可以返回解释器内的 Promise，结果到达后由宿主推进待执行任务，无须采用 Asyncify。[项目说明与 Promise 桥](https://github.com/justjake/quickjs-emscripten#promises)

现有 [WorkerLauncher](../../packages/agent/src/execution/launchers.ts) 和原生后端提供进程启动、停止与核实的基础，但入口固定为工具 worker，尚无脚本反向发起宿主请求的协议。后续应评估复用生命周期而新增固定编排入口，避免将 Runtime、Node 对象或凭据直接提供给脚本。[Node 22.19 子进程](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#child_processforkmodulepath-args-options)、[Node 24.15 子进程](https://nodejs.org/download/release/v24.15.0/docs/api/child_process.html#child_processforkmodulepath-args-options)

## 已知边界

- 包声明 Node `>=16` 并提供 ESM，WASM 路线不依赖每个平台编译 Node 原生扩展；上游当前 CI 主要覆盖 Ubuntu 与 Node 22，不能据此声称 Node 22.19／24.15 × macOS／Linux 四格已通过。[包声明](https://github.com/justjake/quickjs-emscripten/blob/main/packages/quickjs-emscripten/package.json)、[上游 CI](https://github.com/justjake/quickjs-emscripten/blob/main/.github/workflows/main.yml)
- QuickJS 有内存、栈和中断回调限制；长内建操作及时响应中断仍需验证，父进程应独立计时并保留强制停止路径。解释器堆上限不能表述为整个 Node/WASM 进程的 RSS 上限。[QuickJS C API](https://bellard.org/quickjs/quickjs.html#Memory-handling)、[上游中断问题记录](https://github.com/justjake/quickjs-emscripten/issues/219)
- `node:vm` 官方明确不是安全机制。Worker 的 `resourceLimits` 不覆盖 ArrayBuffer 等外部内存，不能单独支撑此隔离承诺。[Node VM](https://nodejs.org/download/release/v24.15.0/docs/api/vm.html)、[Worker 限制](https://nodejs.org/download/release/v22.19.0/docs/api/worker_threads.html#new-workerfilename-options)
- `isolated-vm` 能提供 V8 isolate，但官方处于维护模式且需要原生构建与特定启动要求，列为备选。QuickJS-ng 变体也可在首选候选不满足要求时评估；本轮不引入两套解释器。[isolated-vm](https://github.com/laverdet/isolated-vm#compatibility)、[QuickJS-ng](https://github.com/quickjs-ng/quickjs/releases/tag/v0.17.0)

## 实施前置实验

使用假 Agent，在四格运行矩阵验证串行与并发 Promise、拒绝与错误传递、死循环与微任务循环中止、长字符串操作、内存与递归超限、取消后迟到结果、消息洪泛与超大结果、脚本访问宿主能力的拒绝，以及打包后的 WASM 加载与句柄回收。实验需要明确解释器限制、宿主消息限制与进程停止分别保证什么；未满足的隔离或停止条件应阻止后续实现声称受限执行可用。
