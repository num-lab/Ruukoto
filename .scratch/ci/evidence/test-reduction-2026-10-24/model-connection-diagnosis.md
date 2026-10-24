# MockModelServer 空闲连接复用诊断

本次建议仅把 `test/helpers/mock-provider.ts` 的 SSE 成功响应头 `Connection: "keep-alive"` 改为 `Connection: "close"`。不改任何超时，不加重试，不增加 macOS 独占组。补丁为 `connection-close.patch`。

## 原始 83 失败的已知事实

`observed83.json` 是新一轮全量检查的诊断输出：父 Task 已失败，错误为 `Connection error.`；capture/create 宿主 Task 与子 Task 均成功，宿主单元 `stopVerified: true`，occupancy 为空；待测 controlledWorkCopy 尚未启动，`launches: 0`、`requests: []`。模型 mock 只收到父首轮与子首轮，父第二轮尚未进入 mock。原用例等待的是“目标临时单元已产生”，不是 `rt.stop()` 卡死。

这次历史失败没有保留下层 fetch/socket 原因，不能声称历史错误已经直接证明是 ECONNRESET。下面的纯 HTTP 实验复现了与该快照一致的失效链，足以支持修复 fixture 中可复现的空闲复用竞态。后段受证据目录复制污染的 workflow 用例不属于本结论。

## 自然空闲超时红绿

实验使用实际 MockModelServer 源码副本、已安装 Pi provider、Node 内置 fetch；没有 Runtime、工作进程、Git 操作或真实模型。Node v24.15.0、Undici 7.24.4；HTTP server 保持原有 `keepAliveTimeout = 5000`、`keepAliveTimeoutBuffer = 1000`。第一轮返回工具调用，等待 100ms 使连接空闲，在 `setImmediate` 的 check phase 继续，以 `Atomics.wait` 阻塞本实验进程事件循环 6300ms，然后立刻发送工具结果后的第二轮请求。这是人为控制调度的复现实验，未修改 server 空闲超时，也未主动关闭连接。

原始 fixture 在第二轮只记录到一次服务端请求。6433ms 的首个 socket.destroy 调用来自 `Socket.socketOnTimeout (node:_http_server:836:10)`，随后 `read ECONNRESET` → `fetch failed` → Pi `Connection error.`。收尾阶段的 `closeAllConnections()` 调用发生在失败之后，与自然超时调用栈分别保留。自然调用栈还单独保存在 `natural-timeout-stack.json`；完整事件为 `red-source-immediate-stack-6300.json`。

只替换同一份 fixture 的响应头后，第二轮以正常 `stop` 完成，服务端收到两次请求；连接在各响应结束后关闭。assert 版本的红绿命令如下，cwd 为仓库根目录：

```sh
node --import tsx /tmp/ruukoto-model-keepalive-diagnosis/probe-original.mts red-source-immediate-stack 6300 100
node --import tsx /tmp/ruukoto-model-keepalive-diagnosis/probe-fixed.mts green-source-immediate-stack 6300 100
```

原版退出 1，6.473s，断言 `error !== stop`；仅改单行的版本退出 0，6.443s。两份原文快照为 `mock-provider-original.ts`、`mock-provider-fixed.ts`，命令输出为 `red-source.log`、`green-source.log`。这两次验证使用实际源文件修改，不依赖 response.writeHead wrapper。

此前 `probe.mts` 的观测版分别比较原样、Connection: close、keepAliveTimeout=0：原样失败，另两种成功，记录于 `comparison-results.json`。观测版无断言，命令退出状态均为 0，不能把观测版的失败结果写成命令退出 1。关闭空闲计时虽然也绿，却扩大了 fixture 生命周期；每次响应后关连接直接移除不受测试契约要求的连接复用，改动更小。

早期普通 block、warm、yield、deadline、timeout-gate 实验未触发失败，表明“空闲超过 6 秒”不是充分条件，需要特定调度次序。另一个 `manual-close` 实验通过主动 `closeIdleConnections()` 产生 ECONNRESET，只是人工反例，不是自然超时证据。Undici 的 KEEP_ALIVE timer 使用原生 timer；不要将本问题归因于未经证实的 fast timer 漂移。

## SSE 与调用方审查

`delayed-sse.mts` 使用仅改单行的 fixture，返回带 20ms 块间隔的文本，通过实际 Pi provider 验证全部三个 text_delta 拼接结果、最终 stop、usage 100/10 与一次服务端请求。命令退出 0，输出保存在 `delayed-sse.log`。这验证 Connection: close 不会在响应结束前截断 SSE。

```sh
node --import tsx /tmp/ruukoto-model-keepalive-diagnosis/delayed-sse.mts
```

`mock-consumers.txt` 保存 `test/`、`verification/foundation/` 中引用 MockModelServer 或 PersonalMockModelServer 的 81 个文件，包括 helper 本身、testkit 与 foundation setup；通过 testkit 间接使用的用例也受该修改影响。调用方关注请求数、模型消息、工具调用配对与 SSE 完成行为，未发现模型 HTTP 同连接复用契约。对上述测试目录的 `keepAlive|keep-alive|remotePort|connectionCount|same.?socket|socket.?reuse|复用连接|连接复用` 检索结果保存在 `reuse-search.txt`：除 mock 响应头外，连接计数断言只命中无关的 OneBot WebSocket fixture。MCP/SSH/OneBot 连接生命周期由其他 fixture 覆盖，不受此一行影响。

模型调用错误链为：fetch 底层异常被 OpenAI client 转为 APIConnectionError `Connection error.`，Pi 流以 error 结束，Driver 将该错误持久化为失败 Task。mock 在收到完整请求体后才追加 calls，故父第二轮在请求到达前连接失败与 observed83 的两次 calls 一致。

## 后续验证归属

root 负责应用补丁并运行 83 目标与选定组合，然后在整个仓库冻结写入的条件下跑全量。此报告不把纯 HTTP 探针替代集成或 CI 验收；仍需同一候选的最终检查。所有本次诊断输出仅写 /tmp，未改主工作区。
