# Node24 与 CI 预算验证

对应[工单06](../../issues/06-node24-ci-budget.md)，实施基点 `947bba81`，本机 macOS arm64 / Node24.15.0。CI job 为 90 分钟，保留 ubuntu-24.04 与 macos-15、固定 Node24.15.0；原文件并发和离线策略不变。最低运行版本为 >=24.15，Node22 版本门禁负例仍保留，历史 Node22 验证不改写。

## 旧 CI

[40079786517](https://github.com/num-lab/Ruukoto/actions/runs/40079786517) 运行 `5cd1ec5a`，Linux/Node24.15 成功，用时约 31 分 3 秒；其余三格在约 45 分钟取消，逐 job annotation 均为超过 45m0s。原 API 响应见 previous-run.json。新预算未在远端运行，不能把旧成功或取消改记为新配置通过。

## 本地结果

| 内容 | 结果 |
| --- | --- |
| setup 与桌面版本门禁两个完整文件 | 62/62，0 跳过；包含登录 shell/受管两条真实子进程 probe 路径 |
| 37 scheduler、49 chat result、64 ledger、104 workflow script | 62/62，0 跳过 |
| 38 desktop build、MyGo、99 workspace | 20/20，0 跳过，含真实 Electron bundle 与产物检查 |
| foundation | 7 通过、1 项真实模型按既有离线开关跳过 |
| npm run build | 退出 0，工作流 target 为 node24.15 |
| npm run desktop:mygo:build | 退出 0，实际 Node sidecar、renderer、Go 应用构建与签名核实完成 |
| 静态门禁 | lint、全部 typecheck、verify-notes 通过；首次 check:static 因 AGENTS 4355/4350 字符失败，压缩同一段措辞后 check:docs 全部通过，未提高预算 |
| CI YAML 与依赖锁 | 实际解析 YAML 核实两 OS、固定版本和 90 分钟；12 个本仓 manifest/两个 lock 逐 JSON 核实仅本仓 engines 变化，第三方依赖、解析与完整性不变 |

以上定向测试共 151 通过、1 项外部真实模型跳过，无失败或取消；原日志压缩保存，同名 SHA 和 Node 汇总在 results.json。未机械重跑整个应用集合，也未运行新远端 CI。

## 独立审查

[方案审查](plan-review.md)与[实现审查](implementation-review.md)无阻断。审查者亲自执行版本边界 2/2，真实 Db/Store/SchedulerStore 的 11 条分支断言均通过，覆盖四个调度 ID 字段、首次接收与重复接收 JOIN、负例及零事件。证据在 independent-checks.tar.gz；这些结果独立列示，不再加入上表通过数。

## 交接

当前工程检查完成，待授权推送后运行 Node24 两个平台的完整 CI，进入 foundation 且正常退出才算远端验收。Node22 和 Node24.15 之前的环境须先升级；增加 job 时限不代表已解决全部 CI 失败原因。未推送或部署。
