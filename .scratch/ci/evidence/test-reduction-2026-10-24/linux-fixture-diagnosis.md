# Linux 新发现夹具失败：共享 scenario 与 Cua 大帧预算

对象：HEAD 28c033f7 原版 Linux baseline 的 `desktop-personal-settings.test.ts:155` 和 `cua-mcp.test.ts:147`。本审查只读主/编辑工作区，补丁、隔离副本与日志均在本目录。实际窄验证环境为 Node v24.15.0、macOS darwin arm64；Linux现场由linux_diagnosis提供，本文明确区分。

## Desktop Personal：两种竞态与失败后清理

`test/desktop-personal-settings.test.ts:48` 父进程h.write先读JSON合并patch，再用writeFileSync截断写同一scenario.json；`:77`生成的SSH脚本write也直接截断覆盖。子进程读出s后，`:87`先追加inspect到calls日志，再于`:94`无条件write(s)，最后进入inspect-wait轮询。父用例看到inspect日志即可释放gate，因此父读JSON能落在子进程open(O_TRUNC)和写完之间，出现Unexpected end of JSON input。

原`:155`的finally又先调用h.write，再调用h.close。前一个调用同样可能读到半写JSON并抛错，于是h.close完全没有执行，remote HTTP server仍监听。linux_diagnosis已从 `/proc/net/unix` 核实原pid3583151的fd33/socket98986986仍LISTEN `/tmp/rk-settings-WTKzBW/remote.sock`；这不是把esbuild IPC误当根因。现场目录为 `oracle-4c24g:/tmp/ruukoto-reduce-linux-20261024.G82oCL/full-app/desktop-personal-hang/`，含unix-sockets.txt；root授权后的定向终止单独记录manual-reap.json，不算原文件通过。

只改atomic rename不足：inspect仍将旧整份s写回。父释放gate把fault删除后，慢子进程将旧s发布回来，fault又变成inspect-wait，出现3秒夹具管理超时。故最小完整修复包括三点：父/子用同目录各自PID临时文件后rename；inspect成为纯读取，只stop/start保存维护状态；gate释放放进try，h.close放其finally，释放自身出错也执行清理。

补丁：`desktop-settings.patch`，仅改 `test/desktop-personal-settings.test.ts` 的四处夹具代码，不改产品Controller、协议、权限或超时。临时文件各进程独立；同进程h.write本来就是同步顺序操作，不需要另加锁框架。

## 受控反例与红绿

使用原测试函数与实际PersonalSettingsController/SSH替身。在SSH写入发布目的地时注入500ms停顿；暂停期间通过marker让父确认已到达窗口再进行原gate释放。原写法暂停在scenario.json截断后，atomic版本暂停在临时文件截断后。inspect移为纯读后不会执行这项写入，仍由同一inspect已登记marker推进父级。所有原行为断言保留。

临时测试另加只用于诊断的t.after安全兜底：记录原finally是否调用close及server是否仍监听，再关闭漏掉的资源，避免重现后留下自己的悬挂进程。这个诊断兜底不在交付补丁中。

| 副本 | 实测结果 | 原清理与残留 |
| --- | --- | --- |
| `original.test.mts` | 1失败，SyntaxError: Unexpected end of JSON input；测试体632.402583ms | `closesBeforeSafetyCleanup=0`、`serverStillListening=true`，复现失败后跳过close |
| `atomic-only.test.mts` | 1失败，error !== ready，management_timeout；测试体3009.78625ms | JSON半写消失，但旧inspect整份快照复写gate，不能完成共享读取 |
| `fixed.test.mts` | 1通过，测试体749.72025ms | close=1、serverStillListening=false；共享读取、旧页失效、写互斥、一次inspect/一次settings.read和零stop/start/save断言全通过 |

三个原始输出在 `original.log`、`atomic-only.log`、`fixed.log`。实际命令分别为：

```sh
node --import tsx --test --test-name-pattern='Personal 页面读取：切页与连接核实共享原查询' /tmp/ruukoto-linux-fixture-diagnosis-28c033f7/original.test.mts
node --import tsx --test --test-name-pattern='Personal 页面读取：切页与连接核实共享原查询' /tmp/ruukoto-linux-fixture-diagnosis-28c033f7/atomic-only.test.mts
node --import tsx --test --test-name-pattern='Personal 页面读取：切页与连接核实共享原查询' /tmp/ruukoto-linux-fixture-diagnosis-28c033f7/fixed.test.mts
```

## 其他 scenario 写入是否仍会覆盖字段

完整检索本文件全部h.write与子write(s)调用。唯一父进程在子操作尚未结束时写scenario的是首条inspect-wait的gate释放；修复后该子进程不再回写快照。其余父h.write都位于await controller.read/apply/request或assert.rejects完成之后：协议/身份变化、token轮换、http-secret、large、stop-hang超时后恢复、Cua断线/超限等。stop/start/save沿Controller.exclusive互斥，父不在它们执行中更新scenario；stop-hang的超时等待SSH close后才进入父h.write。start-reject、save-internal、disconnect清除一次故障的子写入也发生在其应答/退出之前，父在结果之后再改配置。

因此在当前用例调用顺序中未发现第二个共享整份快照并发写入者。atomic rename提供完整JSON发布，不是并发合并协议；未来若新增在stop/save/start飞行中h.write的用例，仍须为相应字段建立单写者或显式阶段握手，不能把rename当作防丢更新。当前不引入未被需要的锁或文件数据库。

## Cua：校准测试预算，保持产品限制

`test/cua-mcp.test.ts:145` 额外传入 `{ callTimeoutMs: 10_000 }`；生产 `packages/agent/src/mcp/transport.ts:35` 的 `MCP_LIMITS.callTimeoutMs` 一直是60_000，`:353` 使用 `opts.callTimeoutMs ?? MCP_LIMITS.callTimeoutMs`。原Linux日志由linux_diagnosis定位到output.log:10890：四张上限图调用在10秒override超时，测试体11828.9ms；不是48MiB字节预算拒绝。

`test/helpers/cua-stdio-fixture.mjs` 的images分支生成4张各8MiB的PNG签名数据，编码为单个JSON-RPC响应（base64合计约42.67MiB，低于48MiB聚合上限）；随后oversize分支发48MiB+1来验证拒绝且不伪造response。不能缩样本、删超限断言或提高产品60s/48MiB。

已安装SDK为 `@modelcontextprotocol/client` 2.0.0。其 `dist/src-D_zzAWoS.mjs:6648` ReadBuffer.append逐chunk使用Buffer.concat，`:6657`从累积buffer头查换行；大帧有重复复制/扫描成本。此静态事实解释为何字节边界测试不应额外假设10秒足够，但不把本次观察直接升级为必须改SDK的产品缺陷。本批不改依赖或传输实现。

补丁 `cua-default-budget.patch` 只把fixture({callTimeoutMs:10_000})改为fixture()，沿现有生产60s；4×8MiB、48MiB限制与超限原发送事实断言完整保留。

已在本机/tmp隔离副本实测通过：1测试，测试体4585.6655ms，总4797.625625ms。日志 `cua-default-budget-macos.log`，命令：

```sh
node --import tsx --test --test-name-pattern='48MiB聚合预算' /tmp/ruukoto-linux-fixture-diagnosis-28c033f7/cua-default-budget.test.mts
```

Linux同Node24.15 arm64的默认60s定向验证由linux_diagnosis在原轮结束后补；写报告时尚未取得结果，不用macOS通过替代Linux证据。

未执行：未重跑全套、未修改主/编辑副本、未提高产品期限；当前证据是受控本机红绿及Linux现场归属，补丁应用后的实际文件组合和Linux定向结果仍需实施者补齐。

交接归档：关键红绿输出和交付补丁见 [fixtures/desktop](fixtures/desktop/)。诊断用临时测试文件仍在上述原 `/tmp` 目录，不属于可发现测试集合；原源码可由 `28c033f7` 恢复，本文记录注入窗口和固定扰动以供重建。
