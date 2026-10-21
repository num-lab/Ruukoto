# 后台分页与客户端最终复核

结论：无未解决阻断。core 是本上下文作者，本节 core 内容仅算复核；UI、Runtime/control 调用路径为独立审查。

- BackgroundProcessView.source 只投影 kind/accessMode，不携带原输入、grants、参考快照或平台/日志身份；事件和查询复用同一投影。
- pageBackgroundProcesses 以完整 result JSON（processes、totalCount、nextOffset，含分隔符和容器）计入256 KiB预算，最多20项，按实际返回项数推进nextOffset。Runtime直接调用该页函数，快照另限后台列表128 KiB。
- TUI/Desktop 清单前后翻页均保存实际offset栈，日志另有字节offset栈；切会话清空清单与两类导航状态，迟到日志按独立读取代次拒绝。
- TUI结束动作此前回首页但保留旧栈；主实施者改为保持当前页后，独立公开按键probe确认请求序列0→2→5→结束后仍5→上一页2→上一页0。
- BackgroundEndGuard发送前调用list(true)；目录读取失败或记录损坏均禁止新发送/换键。显式重核只使用原键；未知应答后普通刷新不重发。

## 实际验证

- node --import tsx /tmp/ruukoto-background-offset-review-20261021.mts：输出offsets=[0,2,5,5]和afterBack=[0,2,5,5,2,0]，通过。
- npx tsx --test test/background-process-clients.test.ts test/background-processes-core.test.ts：27/27，通过，无跳过，371.141625ms。
- 此次只运行离线客户端/SQLite检查，没有启动macOS监督器。真实客户端完整链由另一独立上下文持有。

## 被检内容 SHA-256

- `packages/core/src/background-processes.ts`：`c37e6b1f07178f79c617f0e3aad0ce53c70beb176fc6caf2412c999581da9b13`
- `packages/runtime/src/runtime.ts`：`5510fe04291a30b437e2a67ea8f45451dfe8374c14dcc602bf3681b8c288424a`
- `packages/tui/src/tui/background-processes.ts`：`44250b6493d5260d13c0d7686ee996fdb20064bcae9859ab18f0910a0c6e9fe7`
- `apps/desktop/src/renderer/background-processes.ts`：`4a2599bb8e64c1fbfb8321a4dec064ab234c6abf945909dc661525a4163691c0`
- `packages/control/src/background-end.ts`：`5f36e3e59f0d0d58ccf3113172dc8c20a90548849b768a2599ce1a0a666edca5`
- `packages/control/src/pending-requests.ts`：`664fb693e649c02a094a68d28acf0f6a941bb8a5cb02b92542125afdf577afe0`
- `test/background-process-clients.test.ts`：`d3c790ae7878d9d07894b844172ea7f6992a855e715372bae8fb5505d481aaba`
- `test/background-processes-core.test.ts`：`889562cf6a23eeb68066bc34920492e802870e0e5d07f92f189e720f7ad85e0b`
