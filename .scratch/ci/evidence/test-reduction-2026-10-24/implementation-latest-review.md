# 测试精简最终候选：独立只读审查

结论：当前实现没有新的阻断发现；主工单仍不能记为工程验收完成。最终本机完整检查尚在执行，同一候选提交的 GitHub macOS/Linux × Node22.19/24.15 四格仍待授权和真实结果。旧 Linux 绿色轮与定向补验不替代最终候选四格。

## 范围与身份

基点为 `28c033f7`；完整工作区 diff 已保存为 `full.diff`，代码范围 `git diff 28c033f7 -- packages apps test verification/foundation/test` 保存为 `code.diff`，SHA-256 `9e2b21912ceec8021b60f62bafc969ce495df3f2ecf02cc16f8fdcc165b6d17e`，与实施者最终完整检查的指纹一致。新 02/03/04 工单、implemented 笔记与实际证据索引也已阅读；这些未提交新文件不包含在普通 git diff 中。

结合此前完整实施审查、五项独立变异与各增量报告复核全量改动面。当前 35 个已改源码/测试文件与此前负例审查副本逐字一致；其余差异逐项对照迁移/SSH/macOS 夹具/个人 token/PTY/HTTP 的报告和实际源码。SSH、macOS 身份夹具、TUI guard 与32回归的哈希与各自独立审查完全一致；记录见 `source-identity.json` 和 `since-prior-review.diff`。

本轮不运行 native、PTY 或应用测试，不写仓库。只执行源码读取、字节/引用核对与 `git diff --check 28c033f7`（退出0）。三份模块报告仍覆盖原294个应用文件名，当前290个应用文件、6个foundation文件；变更常驻Markdown及新工单/笔记本地链接无缺失，见 `document-check.json`。文件名覆盖仅证明清单完整，不替代先前逐断言审查。

## Standards

没有新增的标准阻断。生产改动被限制在独立工单03的计时器守门、04的令牌发布，以及已有Demo缺失事件补齐；没有新依赖、框架、产品预算、skip、重试或并发/平台矩阵修改。产品决定已有入口Note锚点和对应模块文档；临时诊断和旧失败的事实未被改记为通过。

`personal-control.ts:149` 的临时写入及rename发生在原档案锁内。`readPersonalToken` 仍先拒绝坏旧值；`personal-profile.ts:26`只增加普通文件名，现有lstat类型校验仍拒绝符号链接/目录，取锁后权限收紧仍覆盖临时文件。成功发布前客户端只可能读到缺失或旧完整值；不是SQLite/JSONL跨介质事务，也没有断电持久化承诺。写/rename异常沿原control_start_failed与profile.release路径处理，未引入按message判别或错误自动重试。

本次清理位于 `test/personal-entry.test.ts:27` 的局部 helper。children→models→directories 串行，各组逆序；一项失败只收集、不阻断余下释放，stderr用规定前缀报告，最终AggregateError保持失败。该诊断行有必要：已读独立探针证明node:test在body失败时隐藏after聚合错误。这里没有跨文件通用清理抽象，没有给生产停止添加宽范围信号。

## Spec

原R1/R2/R3已关闭的结论保持：SSH在推进模拟时间前核实实际监听及重连timer登记；存储Key不重写目录有真实字节断言；省略模型名称/凭据有真实保存链路。命令损坏仍分别恢复独立的已关闭档案，模型审查六种端到端结果未被解析器替代；四输入仍实际三并发、第四排队成功与七次步骤尝试，必要停止/恢复/冻结/归属断言未删。迁移使用真实Db/Store，事务、回滚和事件断言仍落真实SQLite。旧入口删除按正式入口退役，与旧档案可读/可导入边界分开。此前有效负例和一次无效node变异均保留原记录。

### HTTP替身

`test/helpers/mock-provider.ts:136` 仅把成功SSE响应的Connection设为close；没有修改request、SDK重试或超时。先前本人已亲自执行原文副本/单行修复副本：原版自然socketOnTimeout→ECONNRESET→Connection error.，第二轮未抵达，断言退出1；修复同序列退出0。实际Pi的三个延迟text_delta、stop和usage通过。主实施者也独立重跑原/修复，退出1/0。全量81个直接引用文件及间接testkit调用没有已发现的模型HTTP复用契约；其他真实连接生命周期由相应fixture承担。

此前普通block等未触发失败的探针、人工closeIdleConnections反例和自然超时反例在报告中有区分。83历史快照只证明父请求Connection error、子任务/宿主准备已成功、目标controlled单元未启动；没有底层socket取证，文档未把机制复现冒称历史ECONNRESET直接证据。83新增catch只打印现场再重抛，原60秒等待、条件与后续stop验证未改。

### PTY v2

`test/15-tui-pty.test.ts:80/:258` 将这一条工作流测试从绝对秒数输入改为上一动作后的输出门。每次动作先追加新segment，下一门只看该段，不复用更早层级的文字；●/○区分工作流焦点，末步使用增量重绘实际包含的聊天和模型标记。原21个动作、宽窄尺寸、40秒驱动期限、页翻转/窗口/导航分段断言、两次真实模型聊天、后台waiting/问题pending、唯一工作流和退出终端恢复都保留。没有把关闭终端当作后台取消。缺标记会超时并失败，不会被当成跳过或提前成功。

主实施者报告该固定源码的15/83/workflow-role/workspace组合45/45，完整116.681s。本轮未独立重复平台运行；这条组合结果不等同于最终完整check或远端平台证据。

### token与失败清理

04的常驻回归在真实子进程内停在open/truncate之后、写内容之前；原始直接写入会暴露control_token_invalid，修复只暴露control_unavailable，finally放行后继续原启动中关闭意图和真实SIGTERM/SIGHUP、原锁释放断言。CLI原用例扩展了写入失败、rename失败、旧字节保持、临时文件类型拒绝、残留tmp恢复和0600。无认证放宽或“读到坏值重试”。

已读6项首次/轮换控制证据、4项发布失败边界，以及真实bin经过认证就绪后body失败的清理记录；Node22/24入口与CLI各38/38保持明确适用范围。独立cleanup多失败探针确认剩余child/model/directory释放均执行、最终非零退出；故意rm失败遗留只在证据保存后按精确路径回收。原始历史after错误没有直接取得，报告以证据限制表述，没有反推具体异常。

## 验收缺口与全量结束后的文档收尾

1. 最终本机 `npm run check` 正运行于上述9e2b219指纹。结束后记录退出码、墙钟、应用/foundation实际通过/跳过/失败/取消及剩余进程；只有实际自然完成才填通过。root已冻结整个仓库，本审查仅写/tmp。
2. 原GitHub四格仍未授权运行；需要同一候选提交、每格进入foundation且正常退出、零非预期失败/取消、job总墙钟小于45分钟。30分钟仍是独立优化目标，不因本地通过而关闭该要求。
3. 当前 `docs/development-baselines.md:51`、`linux-diagnosis.md:3` 以97d1794定位旧Linux完整绿色轮，并只特别指出它早于token修复。建议全量结束后同批补明该轮也早于最新PTY v2、HTTP Connection:close及cleanup stderr增量，防止读者把早期全量与后续定向拼成最终候选全量；旧结果和日志保持原样。
4. `02-reduce-test-suite.md:87` 的“下一步核实15/83”是最终修复前状态，证据README的“失败归属”也仍说PTY正在核实。全量结束后同步为“修复及45/45组合已完成、本机实际结果、远端待授权”，并关联最终源码指纹/报告。03当前最窄红绿已齐，下一责任可改成实际尚缺的完整与平台证据。现在保持in-progress没有提前验收问题。
5. 1627.057s受污染轮保持失败诊断：15/83较早发生有自己的证据；后四项与误复制/清理重叠，其中仅一项直接记录lstat错误路径，不能声称四项都已被精确归因。45/45组合为后续受控恢复证据，不能重写旧轮。旧125及122缺精确历史证据仍明确保留。

标准轴无新的代码阻断；规格轴的未完成项为最终本机完整结果与待授权的同候选四格。没有要求扩大实现或追加平台负载。
