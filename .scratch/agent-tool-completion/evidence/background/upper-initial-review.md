# 后台执行上层独立实现审查

2026-10-21，只读审查主线；审查者未写本次上层文件。macOS 持久低层由本审查者实施，故不在独立结论范围内。

## 结论

所审上层未发现可复现的阻断。启动前与交接前资格、取消、目录和关闭屏障分别在受信入口/事务核实；交接后取消原 Task 不级联停止独立后台。启动与停止竞争以 starts/stops Promise 串行，stopOnce 等待同次启动；Store 已认领但平台尚无证据时原指纹进入低层，未核实保留 process 占用。停止回执、双流 EOF、worker 输出完成与日志 partial 各自传递；新 worker 的 process_output_complete 在 child.close 且队列已排空后出现。

## 独立执行证据

- `npx tsx --test test/background-processes-core.test.ts`：12/12 通过，包含事务回滚、无空窗交接、Task终态不释放独立占用、关闭屏障、取消/权限/快照拒绝、分页与损坏记录。
- `/tmp/rk-runtime-background-review.mts`：真实临时 Db/Store 与 RuntimeBackgroundProcesses。handoff等待期间先closeSession落屏障，再放行，得到 background_closed；后台stopped/verified而原Task占用保留。另一条人为建立已claimLaunch+fingerprint但平台目录缺失的记录，经recover得到stop_unverified并保留独立占用。
- `/tmp/rk-background-output-review.mts`：离线真实macOS进程向stdout写入已确认接受的2MiB后立即请求停止。停止前捕获1,769,472字节，停止后2,097,152/2,097,152齐全；停止proof exited:true/outputComplete:true。
- `/tmp/rk-background-review.mts`：`printf done; exit 7`输出4字节并保存code:7观察；独立worker保持到显式stop，stop核实成功。按当前“直到显式停止”的边界不作为阻断。

审查时发现上层输出完成不能仅依赖helper EOF的风险；主线随后已增加worker close/输出完成回执和drain式shutdown，此项以最终代码核对，不将旧实现列为现存问题。

## 未覆盖

未审macOS低层作者自有改动；未重复真实Linux、模型、浏览器或客户端验收。未构造数据库提交持续失败、实际磁盘满或断电。上层源码若有实质变化，需重核相关结论。

## 所审文件SHA-256

```json
{
  "packages/agent/src/execution/background.ts": "06a86646463968b3ece9114a7af643ce74b97fd18b0a418db1701c37d2fbaed7",
  "packages/agent/src/tool-worker/background-worker.ts": "ff229746218f8b326388c93ce2adeefba5661fc2fc659822b4cddd2859ab0a39",
  "packages/runtime/src/background-processes.ts": "f222cb1926c3a44844f504ba9b2254b85f80186d295bdd153708395debea33e0",
  "packages/agent/src/driver.ts": "5244420293bed4cdd43ea0f47ac71fdecaacf7cae95c8685daa39a4b09b9bac3",
  "packages/core/src/background-processes.ts": "898bb714fb8d8269c692769663d4b509dbb132589e0f58fcc32489f63205bfc1",
  "packages/runtime/src/runtime.ts": "5510fe04291a30b437e2a67ea8f45451dfe8374c14dcc602bf3681b8c288424a"
}
```
