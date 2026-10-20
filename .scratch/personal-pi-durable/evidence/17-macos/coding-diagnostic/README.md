# macOS 额外 Coding 回归诊断

2026-10-17，日本时间 16:21 起只读检查原回归进程 72239；没有终止进程、解除占用、修改源码或测试，也没有另跑基点 122。诊断产物仅写在本目录。当前环境为 macOS 27.0.1 / arm64、Node 24.15.0。

## 实际失败与证据

原回归最终执行 381 项，380 通过、1 失败，耗时 223730.766375 ms；唯一失败为 `test/122-workflow-code-acceptance.test.ts` 等待“六输入整项回报”超时，不能记为该集合全通过。原始摘要见 [regression-excerpt.log](regression-excerpt.log)，超时时完整工作流快照见 [failure.json](failure.json)。

`verify_3` 的原生监督器报告 `identity_unavailable`，其执行 `stopVerified=false`；工作流快照为 `paused`、`reason=write_result_missing`、`stopUnverified=true`。运行中只读 SQLite 查询还观察到该 Task 的 agent/worktree 两处占用仍保留。`change_6=failed`、`verify_6=skipped` 符合用例预期；模型 Task 为 completed 本身不代表工作流步骤成功。

16:21:09 对进程 72239 采样 3 秒，2349 个主线程采样中 2281 个停在 `kevent`；同期 `ps` 的 CPU 为约 1–2%，没有持续忙循环证据。原回归前部没有测试结果输出，是 Node 测试输出等待该文件收尾的表现；稍后原生错误已写入日志。样本见 [process-sample.txt.gz](process-sample.txt.gz)。该观测不解释更早的瞬时 CPU 峰值。

`native-macos-supervisor.c` 对身份核实失败采取保守处理：同 UID 进程枚举或已登记成员身份查询无法核实即保留 uncertain，最后不得给出停止证明。现有日志没有记录失败查询的 PID、返回值或 errno，无法进一步断言具体 syscall 失败原因。初查时 worker、workflow-script 与 native supervisor 的文件时间均为当天 15:46；`worker/native-macos-supervisor --check` 返回 `{"launchdVerified":true}`。因此没有缺构建产物证据；16:29 的其他构建已更新产物，不能用它反推失败时的二进制字节。

## 本轮变更作用面

运行 `node .scratch/personal-pi-durable/evidence/17-macos/coding-diagnostic/probe.mjs`，通过 esbuild 只解析并转译仓库输入，未执行模块顶层代码。`scope.json` 保存结论，[import-graph.json.gz](import-graph.json.gz) 保存完整输入依赖与源码哈希。第三方包视为 external，类型 import 经擦除；此图不把 `new URL` 指向的 worker 产物当作 import。

122 的静态运行时依赖图有 130 个仓库输入。公共 testkit 会加载旧个人产品装配，其个人 app 输入只有 `product.ts`、`scheduler-tools.ts`、`service-tools.ts` 与 `service-helper.ts`。相对基点 `a8fd60c` 的源码变更与该图的交集仅为 `service-helper.ts`；本轮 durable Harness、报告、服务配置、检查、操作与服务实现均不在图内。122 又显式传入 Coding 产品能力声明覆盖 testkit 的默认个人产品。

`service-helper.ts` 的实际差异仅将 `ServiceState` 从 interface 改为 type alias。使用 esbuild 0.28.1，以相同 `loader=ts`、`format=esm`、`target=node24` 转译基点和当前内容，JavaScript 逐字节相同，SHA256 均为 `93903e130c311da412c8f33b4d5bc7eb9ec74e2cc56eb93eb8cf77f6597da82b`；可读产物见 [service-helper-emitted.js](service-helper-emitted.js)。探针用 assert 同时守住变更交集与产物相等，条件变化会失败。

122、testkit、原生执行入口及监督器源码、工作流步骤/编排源码均与基点逐字节相同，逐文件哈希见 [unchanged-execution-source.json](unchanged-execution-source.json)。这些事实支持将本次失败归为额外 Coding 原生执行证据缺口；它们不构成基点也必然失败的证明，也不替代一次成功的 Coding 验收。

## 验收结论与后续

本诊断不扩大个人 durable 检查修复范围。个人定向用例、独立审查、Linux 探针等各自按原证据判定；原 381 项集合保留 1 项失败，完整迁移仍须沿总工单保留真实模型、IM 与产品验收的未完成项。不能以作用面无运行行为变化为由声称迁移全部通过。

安全后续是按需要在隔离 Linux 环境定向复跑 122，或另立 macOS 原生监督器身份查询诊断；保留原错误与占用语义，不手动解锁、不改弱停止核实，也不凭缺少成功证据再编造一次通过。本轮没有执行上述额外复跑，具体失败 PID/errno 仍未知。
