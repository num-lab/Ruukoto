# personal-tools 本机审批用例超时：独立诊断

对象：主工作区 HEAD 28c033f7 的 `test/personal-tools.test.ts:438`。父任务提供的 macOS 完整 baseline 中该用例8992.137125ms失败，`PersonalError(control_response_lost)` cause为timeout。该日志没有记录route，单凭旧日志不能精确识别原请求；本次已复现相同错误并定位到 `POST /tools/decide`。主工作区与root编辑副本均未修改，诊断代码和记录只放本目录。

## 结论

CI 失败来自同进程夹具的应答消费竞争。服务端已把审批决定提交并调用 `res.end(200)`，随后 durable 唤醒已批准工具，同步核实文件保护范围；测试客户端与后台共用事件循环，尚未消费应答就被这段同步工作阻塞，恢复时已到期的5秒timer先销毁请求。独立客户端进程能在相同后台阻塞期间收到已提交应答，不发生假超时。

保护扫描是真实生产逻辑，但“已应答仍超时”的本轮回归不需要改产品。最小修复只把此用例的审批POST放到独立Node子进程，异步execFile等待，调用原personalControl且保持原5秒期限；其余认证HTTP、状态、产物导出、重复导出拒绝、授权和撤销断言不变。不删保护检查、不改成full_access、不重试、不增加期限，也不以单跑偶尔通过宣称修好。

## 已执行反馈环与证据

| 探针 | 结果 | 证据 |
| --- | --- | --- |
| 原窄用例，无改动 | 1通过；测试体5005.445792ms，总6579.324875ms | `original.log`；说明原问题受时序影响 |
| 全调用追踪（node:test mock记录每次fs调用） | 同型失败；decide5396ms、server finish200后client timeout | `instrumented.log`；此探针记录开销放大故障，不用它估性能 |
| 轻量直接计数，不记录每次fs参数 | 1通过；decide2485ms | `light-trace.log`；5次根扫描与调用栈明确 |
| 同进程client；只在res.end后第一轮扫描阻塞5200ms | 1失败；decide7666ms，control_response_lost/timeout | `post-response-delay.log`；确定可控反例 |
| 独立Node client；同样位置、同样5200ms阻塞 | 1通过；child自身HTTP1238.573542ms，父直到8935ms后收child结果 | `child-post-response-delay.log`；仅客户端进程边界改变 |

原窄命令：

```sh
node --import tsx --test --test-name-pattern='durable 本机入口：真实认证接口' test/personal-tools.test.ts
```

轻量追踪：

```sh
node --import tsx --test --test-name-pattern='durable 本机入口：真实认证接口' /tmp/ruukoto-personal-tools-diagnosis-28c033f7/light-trace.test.mts
```

受控红例：

```sh
RUUKOTO_DIAGNOSTIC_SCAN_DELAY=5200 node --import tsx --test --test-name-pattern='durable 本机入口：真实认证接口' /tmp/ruukoto-personal-tools-diagnosis-28c033f7/post-response-delay.test.mts
```

受控绿例：

```sh
RUUKOTO_DIAGNOSTIC_SCAN_DELAY=5200 node --import tsx --test --test-name-pattern='durable 本机入口：真实认证接口' /tmp/ruukoto-personal-tools-diagnosis-28c033f7/child-post-response-delay.test.mts
```

各次原始输出已经保存，没有为写日志再次执行。绿例仅将POST /tools/decide通过async execFile交给 `child-control.mts`；该脚本导入原仓库personalControl，未传timeout参数，独立记录HTTP耗时。父进程等待是异步的，未用execFileSync/spawnSync阻塞server。临时测试的相对import重定位到原仓库，node_modules链接到原依赖，所有产品代码均是原版。

## 关键时序

受控红例：client-start2161ms，server-request2162ms；前两轮复核后server-end3129ms（约968ms）；3130ms进入后续工具扫描并注入5200ms；9830ms附近恢复后client先到期，抛control_response_lost。服务端finish200出现在9827ms，并不能把它误读成“直到9827ms才写应答”；真正调用end在3129ms。

受控绿例：父client-start1725ms，child加载后server-request2668ms；server-end3898ms（服务端受理到end1230ms）；3899ms开始同一5200ms阻塞。child原personalControl独立在1238.573542ms内收完应答；父进程受同步工作阻塞，到10660ms才执行execFile完成回调。父等待8935ms不等于HTTP超时。整条用例随后继续通过原产物导出、已存在目标拒绝、授权创建和撤销。

## 五轮保护扫描

共同底层为 `packages/agent/src/execution/approved-ops.ts:114` identityOverlap → :120 identityCovers → :126 isProtectedPath。受限文件入口的保护根由 `apps/ruukoto/src/personal-command-config.ts:23` personalProtectedRoots给出，含档案、仓库代码树和拥有者相关目录；探针没有改变这些根或返回的目录内容。

| 次序 | 实际调用方 | 与应答的关系 |
| --- | --- | --- |
| 1 | personal-tools.ts:151 toolDecide → :155 active → :119 verifyPersonalTools → personal-tools-config.ts:43 personalReadPath → :37 assertGrantNotProtected | 决定事务内，核实workspace |
| 2 | toolDecide → active → personal-tools.ts:131 preparePersonalFile → personal-tool-io.ts:42 isProtectedPath | 决定事务内，核实待批准目标 |
| 3 | personal-tools.ts:287 工具消费开始事务 → active → :119 verifyPersonalTools | res.end之后，工具恢复执行前核实workspace；受控阻塞放在此处 |
| 4 | 工具消费开始事务 → active → :131 preparePersonalFile → personal-tool-io.ts:42 | res.end之后，工具执行前复核固定目标 |
| 5 | personal-tools.ts:293 executePersonalFile → personal-tool-io.ts:98 isProtectedPath | res.end之后，真正文件I/O前复核 |

轻量探针在一次decide等待窗口统计到readdir 59,145次、stat/lstat 668,663次，5轮扫描每轮约0.45–0.55秒（当前本机树，非跨机器性能保证）。控制器的决定提交仍在前两轮完成后应答；不应为此删除消费前或I/O前的安全核实。

## 最小补丁与审查范围

`client-boundary.patch` 只修改 `test/personal-tools.test.ts`：导入execFile/promisify，审批POST调用改为独立Node的原personalControl。使用--eval避免新增永久helper；模块URL和目录/operation使用参数传递，不经shell，不把token或模型凭据写进参数。子进程失败使execFile拒绝，仍会让用例失败。

受控绿例已验证相同的独立子进程调用路径；绿例用独立临时脚本以输出诊断耗时，交付patch将相同一行调用内联到--eval。该patch尚未应用到任何仓库副本，其实际文件的定向验证由实施者应用后完成。现有用例即承载新进程边界，不需要另加同义测试；可保留本受控红绿证据供独立复核。

未验证：未重跑完整personal-tools文件、全套check、Linux或CI。审批应答前两轮在本次受控对照中小于5秒；本结果不承诺任意巨大保护树的处理时间，也不声称保护扫描成本已降低。

交接归档：关键红绿输出和交付补丁见 [fixtures/control](fixtures/control/)。诊断用临时测试文件仍在上述原 `/tmp` 目录，不属于可发现测试集合；原源码可由 `28c033f7` 恢复，本文记录注入窗口和固定扰动以供重建。
