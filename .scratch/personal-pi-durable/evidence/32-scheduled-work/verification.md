# 32 定时工作工程核实

2026-10-18 接手；基线 `eb0f77c9d2e7adffc784f14064a0e1a51b1d9642`，开始工作区干净。实际变更范围由 `change-scope.json` 持有；最终源码指纹另存 `source-sha256.txt`。本机 macOS、Node 24.15.0；Linux 为 `ssh tx` 的 Linux 6.8.0-117-generic、Node 24.21.0，非 CI Node 22.19/24.15 完整矩阵。实施验收时尚未提交、推送、部署或切换正式入口；后续提交交接由工单持有。

## 已验行为

真实 Harness 与 SQLite 覆盖独立会话/输入反链、可控时间接纳/漏期合并、固定创建模式与工具/资料配置、主聊天并行、全部成员收尾、未知 HTTP 写入跨取消与重启不重发、浏览器暂停与停止核实、模型 SDK 参数规范化恢复。固定原入口审批不消费或创建长期服务授权；模式变更不改写原计划。完整配置相等是保守上限，新增或撤销配置均需核实后取消重建旧计划。

本机控制用实际认证 HTTP server；双平台用真实宿主收件/菜单/持久回执及 HTTP/IM 传输替身，覆盖草稿中的权限名和工作命令只作正文、原确认去重、跨入口拒绝、长报告全文查询和重启后零重发。浏览器组合使用实际会话 documents 与原生 Tasks，BrowserManager 方法为替身，没有实际打开 Chrome。

原始日志字节另存 `raw-logs.tar.gz`；相邻 `.log` 统一末尾一个换行，并在提交前去掉展示文件的8处行尾空白；原始日志字节、空输出与尾部空行均保留在归档。

## 检查记录

| 检查 | 结果与证据 |
| --- | --- |
| 静态门禁 | `check-static.log` 首轮通过；`check-static-final-retry.log` 最终完整 `npm run check:static` 通过；新增启动测试另以 `typecheck-final-test.log` 全根类型检查通过 |
| 构建 | `build.log`、`build-final.log` 均为 `npm run build` 通过记录；最终产物包含恢复审计修复，无依赖或脚本变更 |
| 新增定时六文件 | `scheduler-final-macos.log`：54/54；`scheduler-final-linux.log`：六文件及完整权限套件96/96；`startup-final-macos.log`、`startup-final-linux.log`各2/2，补证损坏扩展拒绝及终态监督器重建，均零跳过 |
| 已有调用方20文件 | `regression-macos.log`：522项，516通过、5失败、1个Linux限定跳过；失败含父项，实际4个叶用例。下文逐项修复与定向复核，没有把该轮记成通过 |
| CLI及命令权限夹具 | `fixture-regression-macos.log`：4/4；`command-scope-final-macos.log`：5/5，覆盖full_access未知、配置损坏及复用的新来源 |
| 服务权限与历史恢复 | `permissions-final-macos.log`：完整42/42，零跳过；`permission-regression-macos.log`单独复核换代/旧无快照3/3 |
| 双产品入口 | `products-regression.log`：71/122共18/18、零跳过；`cli-final-linux.log`另在Linux复核本机sudo/helper命令桩及实际HTTP/子进程2/2，覆盖本机宽回归唯一Linux限定跳过 |
| 模型可见文本 | `model-text/evidence.md`、三份HTTP请求及持久payload；3次HTTP请求均与实际会话记录深相等。字符/4只是粗估，不是实际token或计费 |

首轮已有调用方失败分别是 CLI 工具列表漏新增3个调度工具、命令 confirm/full_access 夹具在已冻结本机来源后才改默认模式，以及共享严格来源解析误拒绝旧无快照服务记录。工具列表按当前装配同步；命令夹具改为先选模式再接纳来源，复用时提交新的拥有者输入；服务恢复只对真实定时分支使用严格新来源，ROOT 历史恢复保留旧规则，活动消费仍要求原快照与原入口。未删除任何负例或放宽生产执行门禁。

更早组合曾暴露将数据当作原生 `runtime.commit` 返回状态的错误，已改为闭包取值，真实 SQLite 组合随后通过。服务旧夹具 `calls.log` 轮询曾读到半行 JSON，定向复跑通过；原读取器与本次前的 HEAD 相同，改为只解析已换行的完整记录，完整坏行仍报错。保留首轮失败日志和之后复核，不把重跑抹成首轮通过。

Linux 完整 `npm run setup -- --skip-hooks` 因磁盘 ENOSPC 未完成，见 `linux-setup.log`；直接使用半解包依赖也因缺typebox失败，见 `scheduler-linux.log`，不是行为测试通过。随后在本次独立 `/tmp/ruukoto-32-linux.tezhsC` 副本按原锁文件执行 `npm ci --omit=dev --ignore-scripts` 成功（`linux-production-deps.log`），再以实际tsx/SDK 1.3.0运行定时六文件26/26。68个Linux个人源码/测试/锁文件指纹与根工作区一致，见 `linux-source-sha256.txt`；验证后已删除本次临时Linux副本释放空间，未清理其他工作目录。这不代表完整Linux开发安装或CI矩阵通过。

## 独立审查与返修

实施前独立方案审查对象工单 SHA-256 为 `1928379e5b8e17855c27703f0425decf5c193f08748a40aa8d91d6cfe26a4cd0`，无方案阻断。核心、浏览器与入口作者各用独立工作副本，汇总后由不同执行上下文交叉审查实际源码、要求和最窄证据。

独立审查发现并修复：浏览器暂停须观察会话记录、停止失败仍占用；无原输入的失败收尾不得解析虚假来源；第三方SDK规范化参数必须用实际工具定义恢复；监督器及汇总/答案/取消/结果的单向证据不足；跨到期点关闭但尚未扫描时漏记合并范围。审查者在真实Harness/SQLite构造的6个损坏恢复反例和1个普通时钟交错反例均先红后绿，最终结论见 `independent-review.md`，54项捕获stdout转录与最后4项原始日志分别归档，原始/转录来源明确区分。该审查不覆盖作者自己的browser实现；browser及共享source接线由另一执行上下文 `/root/scheduled_scope_audit` 独立核对并运行相关窄例，确认未知停止/固定模式/长期授权门无未修阻断。

最终核心作者以35/35自验恢复变更；审查者另构造7个独立先红后绿反例并实际运行54/54组合、取消跨期4/4。两处最终启动接线由核心作者作为非作者独立核实2/2，撤去对应两行后0/2、还原后2/2。CLI/命令及JSONL夹具改法又经入口作者只读独立复核，保留了三模式与身份复用、原执行一次及完整坏行失败的意图。

审查报告中的 scheduler SHA `a7bef953…` 与根最终 `c280a0df…` 仅差入口决策笔记锚点从总提案改为本篇implemented，已直接diff核实；Harness与records指纹相同。更早实际模型文本测量的source SHA记录的是测量快照，之后恢复逻辑改变未改变所测schema/prompt正文。

最终静态首轮在新增marker测试报AgentDoc.extensions联合类型未收窄（`check-static-final.log`），测试改用Array.isArray断言后完整静态与启动回归通过，没有改变生产行为。

## 待验与恢复条件

真实模型自主选择工具、短周期任务的子工作/审批/整项总结，以及专用 QQ/Telegram 原平台的一次实际最终送达尚无本轮隔离模型配置和专用测试目标，不能把本机HTTP替身记成真实平台通过。须准备独立个人档案、明确模型配置、专用拥有者目标及短周期计划后补验，包含等待/取消/未知核实期间的主聊天和菜单体验。

真实 Linux systemd/helper/原生命令与实际 Chrome 的定时组合、视觉模型截图和操作者体验仍待具备环境后验证；已有实现的外部证据不替代新定时组合。未运行全仓 `npm run check`；本次不改共享包/依赖/脚本，已按个人调用方选择定向检查。

33记忆/技能/历史与34应用数据尚无实现，当前只交付共同可核实定时来源；两单接入后在原工单及39组合验收。正式入口与生产接管仍由38–40持有。
