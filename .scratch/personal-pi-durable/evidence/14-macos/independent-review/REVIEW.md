独立实现审查由 `summary_design` 上下文执行，2026-10-17；直接读取总规格、工单、实际源码与公开 SDK。当前无未解决阻断。

被审 `personal-report.ts` SHA-256 为 `86d69195425b7eab9151c30ebfb6d6d7bbbeabf1bb348b5cb0615cf8214fddd5`，`personal-harness.ts` 为 `c3e97305aace25305abbe70d8becf1eeb3947d2a29c2111e7338656a4cc773db`；与最终源码一致。之后仅新增菜单用例，作者完成对应窄验证。

- 亲跑报告与服务两文件 61/61；修正后报告、CLI、模型工具、宿主控制与委托五文件 90/90。
- 独立精确取消窗口 5/5：admission 前后、发送领取前后；发送领取先提交时保留真实 sent，其他顺序零外发，主聊天继续。
- 排队报告的整项取消和原生 abort 探针 3/3：只撤回报告输入，其他已排队拥有者输入保持 queued，随后正常回答，零报告请求与外发。
- 停用 Telegram 并移除 token，真实强杀在 pending→send 之前恢复，探针 1/1：旧报告取消，不读取停用凭据。
- 8 次实际 HTTP 请求与 durable payload 逐份深等；覆盖主、子、汇总及汇总内 progress 工具轮次。完整系统提示、工具定义及报告输入见 [输入快照](model-input.json)。子会话工具为空；未取启用服务时的完整请求快照。
- 亲跑 verify-notes、check:docs 与 diff --check 通过。修复了停用凭据先读取导致 faulted，以及最后未知检查与 ready 检查之间的竞态；复核相关修复。

最终只筛「独立探针」重新执行 10/10、零跳过，命令/退出码/源码哈希见 [元数据](independent-probes.json)，完整 stdout/stderr 见 [日志](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F14-macos%2Findependent-review%2Findependent-probes.log)。

探针代码保存在 [probe.mts](probe.mts)，其绝对 import 指向本轮主检出，原临时目录的 node_modules 是该检出的软链。停用凭据探针首次因探针本身字符串换行转义失败，输入快照探针首次因省略的空 tools 被误断言为数组失败，修正探针后通过；两者不是产品通过记录。

Linux、真实 PTY、真实模型和 IM 不属于此独立审查亲验证据；分别沿本轮对应材料记录。显式封组的真实模型执行习惯与拥有者体验仍待验。
