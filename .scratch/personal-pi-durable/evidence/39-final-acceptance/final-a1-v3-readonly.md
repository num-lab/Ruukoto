# A1 当前 v3 只读证据收束

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

审查日期：2026-10-19。只读规格、39/38/36交接、入库证据、原日志及当前源码指纹；未运行测试、探针、模型、IM、网络或生产操作，未读取凭据，未改根工作区。

结论：现有叶证据可以收束 A1 的当前受影响范围。本次未发现原38失败分组中仍完全缺少当前有效覆盖、必须新增执行的具体文件或场景；不需要再跑全仓或重新 setup。余项是 Agent 完成失败账本、写清证据复用范围与历史限制，并固定发布 commit。原17/native101的精确原因仍未查明，不能写成已修复；也不应仅因旧现场不能重现而无限新增验收门槛。

## 当前候选

亲自逐字节核对 `candidate-current-source.json` 的649项，当前根工作区全部匹配，差异0。两OS的 `final-v3-artifacts.json` 均记录同一来源清单 SHA256 `59c4bcac4716b860185df732b96fb3c6f5ada0b383572f31e72016d62b3d0c34`、649/649匹配及两产品包成员。实际解析分别为个人 Pi AI/durable 1.3.0、Coding Pi AI/agent 0.85.1。v3仍为未提交工作区，制品来源可以核对，但尚无发布 commit。

v3相对接手基线的运行代码变化集中个人装配十文件及共享 `approved-ops.ts`、`native.ts`；其余变化为相关测试。Coding入口、依赖声明、锁文件及旧格式没有新增行为变化。38的干净完整workspace安装、两app实际解包12项、Coding升级4项及36旧schema/JSONL/产物保持证据可按原范围接续；新app成员指纹、两OS构建和晚变化的实际源测试补齐差异，不能把旧制品称为v3本身，也无需机械再安装。

## 原38分组对应的有效叶证据

以下路径均相对 `.scratch/personal-pi-durable/evidence/`。每行是一个范围，不相加为新的累计测试数。

| 原失败或受影响范围 | 可用于当前候选的证据与边界 |
| --- | --- |
| 退役工具调用方15个block | `38-product-entry/tool-retirement/`三文件35项和`retired-callers/`四文件25个不同用例保留有效资料、身份、权限与恢复契约；退役通知/取消工具用例随功能退出，不能按旧工具名要求恢复。 |
| 112脚本预算/等待、118重复回答事件数 | `39-final-acceptance/macos/coding-audit-{112,118}.log.gz`分别整文件14/14、10/10；原`script_cpu_limit`和63≠61保留为历史结果，当前通过只证明当前文件场景，不解释原宽批次同因。 |
| 125/22/45/83 | `/tmp/ruukoto39-coding-audit-groups-summary.json`及对应单文件原日志首轮exit0；未降等待或改断言。83超时不能并成native回收失败。 |
| snapshot及workflow-role | `39-final-acceptance/native-protection/author-delivery.json`绑定86项回归包含两文件；86项有末段stat守卫变化，不能称完整最终源码一次86全绿。最终边界/native/snapshot/122的18项、独立8项边界及2项入口、原15秒双进程反例先红后绿补齐受影响差异；最终v2双进程两份均exit0。角色业务无后续独立delta，按变动范围接续已有叶证据。 |
| personal-tools超时、personal-command-work中断、32文件中断 | `39-final-acceptance/macos/original-personal-failures.log.gz`覆盖三文件，75/75，0取消/跳过。后续来源边界787项中的两个失败均为命令报告结果新增offset/totalChars后的旧精确对象断言；`macos/report-registration-root.log.gz`完整命令/夹具40/40及v2三条命令门禁补测覆盖相应返工，不能留下这两个已被明确替代的旧断言当作当前红项。32实现没有本轮delta；75项不解释原批次13分钟停滞。 |
| 共享原生保护扫描改动 | `native-protection/author-delivery.json`、`native-batch-review.md`、真实Linux `native-file-bind.json`；原15秒并行负载反例先红后绿。Linux22/24的`final-native*.log.gz`各45项中44过、1个mac专用跳过；mac独占`macos-exclusive.log.gz`44/44覆盖该平台。目录时间戳夹具修订及32轮不可见变化的限制原样保留，不承诺文件系统原子快照。 |
| Coding六输入及生命周期/旧数据 | 36两OS独立安装构建、受影响生命周期/SubAgent/工作流与旧格式档案证据；本轮最终native18项含122，另`native-protection/a1-first-fault-evidence.tar.gz`的真实原沙箱122完成且全部stopVerified、无残占用。首个诊断副本的绝对依赖链接错误是前提失败，保持原记录，不算产品通过或真实停止故障。 |
| 入口与Node差异 | mac22入口49/49、Linux24入口/原生/CLI93过1平台跳过；Linux22模型流强杀首轮失败保留，由`linux/node-stream-diagnosis.md`及ready最终cleanup两Node各27/27的具体修订证据接续。个人晚owner/report/scheduler变化已经由mac22/24和Linux22/24的v2窄集及v3引用/只读门禁补齐。v3 reports整文件37项及静态属于根执行证据，不升级成完整CI四格全量。 |

## 最终账本需要怎样写

原17 macOS是监督器身份查询失败，原17 Linux是完全访问local组停止未核实；原38 native101是另一轮`reaped=false/identity_unavailable`。三者保持独立，既不能由snapshot重复扫描或一次尾帧竞态统称根因，也不能从后来成功倒推当时未发生。原17旧工作已`write_result_missing`，不重放它的写操作。缺PID/返回值/errno/完整回执时序就明确说历史原因未知。

可审表述：当前候选在所列Coding、原生停止/保护、入口和旧数据场景取得有效叶证据；历史停止失败未稳定复现，精确OS触发未归因，保留安全暂停及占用规则，未声称修复原失败或全仓CI通过。原宽批次不是当前候选完整检查，失败和中断记录继续保留；已有受影响范围由本表逐项接续。

39/36/38正文仍写有“原因未归因持续阻断”的旧交接口径。最终验收应由负责Agent在39现行正文明确将其收束为上述历史限制并引用当前有效证据；不能留下旧门槛与新结论矛盾，也不能修改Comments原事实。这个工作是失败账本和验收陈述的收束，不需要新的OS探针或拥有者重复操作。

发布前固定实际 commit、锁依赖及两OS制品指纹，并把根持有的v3构建实际退出状态纳入最终清单。两个构建gzip日志到达两产品pack输出，但日志本身不编码退出值；沿用原执行返回事实，不为补一条文字再构建。

未检查全仓每个用例、完整CI四格或生产环境；这些没有被本审查冒称通过。仍有历史停止故障未归因的风险，处置保持原安全边界。
