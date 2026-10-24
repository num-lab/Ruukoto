# 最终 PTY 与模型替身增量验证

本轮在 `oracle-4c24g` 的 `/tmp/ruukoto-reduce-linux-20261024.G82oCL/src` 执行，Linux arm64。先前冻结版完整 `npm run check` 与本轮分开记录；本轮只验证随后修改的 PTY、模型替身响应头及相关工作副本目标，没有再跑 Linux 全套，也没有改主工作区。

同步主工作区的 `test/helpers/mock-provider.ts`、`test/15-tui-pty.test.ts`、`test/83-subagent-worktrees.test.ts`。前两份分别为 SSE `Connection: close` 加笔记锚点、已完成真实延迟红绿的 PTY v2 加笔记锚点；83 相对远端冻结版仅增加失败时的现场诊断。同步前后逐文件 SHA-256 一致，最后复核三份文件零差异。

| 内容 | 实际结果 | Node 汇总 | 完整进程 |
| --- | --- | --- | --- |
| Node 22.19.0：完整 15 PTY 文件 | 4/4 通过，0 跳过 | 55.299s | 55.603s |
| Node 22.19.0：83 的 integrate 临时 worker call 停止场景 | 1/1 通过，0 跳过 | 16.411s | 16.584s |
| Node 24.15.0：同一 83 目标 | 1/1 通过，0 跳过 | 14.053s | 14.155s |
| Node 24.15.0：20ms 块间隔 SSE | 完整文本、stop、usage 和请求数断言通过 | 非 node:test 探针 | 0.707s |

各轮顺序执行，退出码均为 0，无监督超时、无遗留自有进程；没有扩大既有用例期限或新增重试。83 的名称筛选为 `后台停止覆盖 SDK 中的 integrate 临时 worker call`。SSE 探针直接导入远端正式模型替身与已安装 Pi provider，收到三个 text_delta，拼接结果等于全部预期文本，stopReason=stop、usage.input=100、usage.output=10、服务端收到一次请求。该验证使用本地 HTTP 替身，不是外部真实模型验收。

| 文件 | SHA-256 |
| --- | --- |
| `test/helpers/mock-provider.ts` | `8c3c5b85a196096ee436ed4f733147e9609f37ac46ecc6c50444e1f4013abed1` |
| `test/15-tui-pty.test.ts` | `1650c6bf1cb384d95b7a419ccdb804136b3649ccc7234d219c8642a1690d9fe1` |
| `test/83-subagent-worktrees.test.ts` | `68f54743a7a643cc39682c095c2fc1d8c228896f5f785a8e2543020e39d9e862` |

可移植 SSE 探针只替换两处导入路径，指纹为 `b4fb91f7adfcb92ef254bdcadfa3f3717450121ec41830dcf43617b0425e1737`。原纯 HTTP 空闲复用红绿与历史故障归因的限制由 `/tmp/ruukoto-model-keepalive-diagnosis/diagnosis.md` 持有；本轮集成通过不补造历史 ECONNRESET 的缺失现场。

本地结果为 `/tmp/ruukoto-linux-final-fixtures/final-fixture-checks/`，其中 `node22-pty`、`node22-83`、`node24-83`、`node24-delayed-sse` 各含 output.log/result.json。源码指纹为 `manifest.json`，执行后复核为 `source-verification-after.json`；原始包为 `/tmp/ruukoto-linux-final-fixtures/linux-evidence.tar.gz`。

PTY 12 秒受控红绿及 v1 失败的完整记录另见 `/tmp/ruukoto-pty-workflow-fixture-fix/linux-report.md` 与对应 `linux-evidence.tar.gz`，不将旧候选失败隐藏，也不把受控延迟当成历史实际延迟。
