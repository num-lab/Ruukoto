# 脚本隔离实验与验证证据

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../git-history-cleanup/archive.md)。

对应[工单 02](../issues/02-script-isolation.md)、[规格 A3](../spec.md)和[实施计划第二节](../implementation-plan.md#二受限脚本与步骤结果)。2026-10-13 接手基点 `481e42979fb414bd4559857a0b136be27b01f9f9`；实验在临时目录运行，正式接线在同一工作区完成，没有调用真实模型或 IM。

## 实验与选择

先在 `/tmp/ruukoto-script-isolation.AY4CGx` 安装两项 0.32.0 固定依赖，QuickJS 官方拆包和 Promise 资料见[候选核查](../script-runtime-research.md)。同步 release-sync 支持普通 JavaScript 控制流与 Promise 桥；去掉 Node/直接 I/O、模块、时钟、随机数和定时器后，四类编排原语仍可通过 JSON 调用假 Agent。

[`child.mjs`](child.mjs) 与 [`runner.mjs`](runner.mjs) 是独立 API 探针；macOS 两版本各十八项，原始消息和 stderr 在 `results-darwin-v22.19.0.json`、`results-darwin-v24.15.0.json`。普通计算中断、内存/栈超限、Promise 拒绝和句柄泄漏检测符合预期；长内建由父进程 SIGKILL 后等待 close。三种故意无界/中断后继续清理的微任务负例触发上游 abort，这些失败保留为边界事实，不记成正常清理通过。最终入口每批让出事件循环，异常中断后直接退出进程，父进程核实原进程组已停止。

[`experiment.mjs`](experiment.mjs) 是最终假 Agent 与专用宿主的独立可运行快照，含三十七项检查：四类原语、串并行/分支/循环、拒绝、能力获取失败、模块/语法错误、微任务/纯计算/长内建、堆/栈、超大输入输出、未等待调用、未决请求/进度/发送队列限制、UTF-8 与坏帧、取消迟到、启动失败/迟到单元、停止未核实、JSON 原型与全局改写、异常退出及转换中的死循环。每个故意失败还断言可见结果和停止事实；内存/栈另有无需计时的 InternalError 检查。

原型四格通过后，依赖才进入 agent 包并选定固定入口。`*-final.log` 是原型 release-sync 外部加载结果；`*-bundled.log` 是首次自包含正式 JS 与同目录 WASM 的 35/35，旧快照与哈希分别为 `experiment-35.mjs`、`artifacts-35.json`。独立审查补同步启动异常和合法 32 并发加长微任务两条回归后，`*-accepted.log` 使用最终正式资产四格重跑，各 37/37、零跳过；`artifacts.json` 记录最终资产大小和 SHA-256，旧四格不覆盖新队列实现。macOS arm64 使用本机 Node 24.15.0 和 `/Users/eitrous/.npm/_npx/992a19d7d9bf36d4/node_modules/node/bin/node` 22.19.0；Linux x64 使用 `ssh tx` 上临时目录内的 `node@22.19.0`、`node@24.15.0`，均亲跑 `--version`，没有把服务器默认 24.21.0 当作目标版本。

| 环境 | 原型 | 最终正式打包资产 |
| --- | --- | --- |
| macOS / Node 22.19.0 | 35/35 | 37/37，macos-node22-accepted.log |
| macOS / Node 24.15.0 | 35/35 | 37/37，macos-node24-accepted.log |
| Linux / Node 22.19.0 | 35/35 | 37/37，linux-node22-accepted.log |
| Linux / Node 24.15.0 | 35/35 | 37/37，linux-node24-accepted.log |

日志含特定样例的墙钟耗时，不是资源配额或性能保证。QuickJS 堆、栈、WASM 线性内存、V8 old space 与消息限额分别核实；没有整个进程 RSS 上限，长内建的及时停止来自父进程。停止未核实与异常退出以可控 LaunchedUnit 注入证明事实传播；正常、故意脚本失败和取消用实际进程组核实回收。

## 复跑

在仓库根运行，Node 必须由调用环境选择到准确版本；Linux 在 `ssh tx` 的独立目录执行相同命令。原始 API 探针依赖根安装，结果按当前平台/版本写回当前探针目录，复现时宜先复制到独立检出。

```sh
npm run setup -- --skip-hooks
npm run build:script
npx tsx --test test/104-workflow-script.test.ts
node .scratch/agent-workflow/isolation-evidence/runner.mjs
```

要复跑最终四格，把 experiment.mjs、构建出的 workflow-script.mjs 与 workflow-script.wasm 三个文件复制到同一个新临时目录，再运行 `node --test <临时目录>/experiment.mjs`；该 JS bundle 不需要其他项目源码或模型配置。快照与最终源码测试仅固定入口路径不同，包含相同的三十七个用例；独立审查记录由工单持有。

## 正式接线

`npm run build` 通过，`build.log` 保存原始构建输出；`npm run typecheck` 通过。`test/104-workflow-script.test.ts`、`test/100-worker-stop.test.ts` 和 `test/101-native-execution.test.ts` 初次联合运行 70/70，原始输出为 `formal-tests.log`；后续修复没有修改共享执行代码，最终 104 源码检查 37/37，保存为 `formal-tests-final.log`。最终静态检查与独立审查由[工单](../issues/02-script-isolation.md)记录，旧日志不覆盖新增用例。

持久运行、来源授权、依赖校验、取消实际步骤和模型输入落盘由后续工单实现；产品体验不适用本单，真实模型和 IM 未运行。
