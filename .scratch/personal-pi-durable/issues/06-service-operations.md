# Durable 服务操作、单次审批与效果核实

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)阶段 2，落实[规格](../spec.md) A5/A6/A9 的服务写操作窄切片。完整方案确认与本轮接手授权继续有效。沿现有可信宿主 API 提供独立后台服务工作，不向主模型或子模型装配写工具，不改变正式入口、不实际部署。长期授权须绑定原 IM 待审批，本任务不建立替代的本机自由授权入口；三模式的通用执行、子工作授权、原 IM 审批和长期授权继续待实施。

## 方案

1. 宿主显式启用服务操作；`service.request` 引用已进入主会话的拥有者输入，固定精确单元、模式、请求键和来源，在同一 durable commit 建立 background Task 与操作事实。同键异参拒绝，重复键返回原引用。模式默认自动审查，服务写操作在自动审查和请求确认下均人工决定，完全访问免逐次审批。
2. 只读 preflight 保存 helper 状态、原始证据、本机/策略/单元修订。审批引用原操作及修订，不接受新参数；决定持久化、单次使用，取消或来源失效拒绝消费。消费事务同步重读策略，helper 在真正写入前复核修订。审批等待重启后恢复，禁止把批准直接视为执行成功。
3. 消费与“执行已开始”事实及恢复 checkpoint 同 commit，然后在当前 invocation 调 helper 一次。恢复只进入核实，不重发。可信 launched:false 记未执行，可信命令应答含非零退出如实记已执行；其余结果未知。原始字节与结论同 commit 保存；存储失败后保留已开始事实，重开转未知。
4. 未知操作停止其固定命令单元并核实完整应答；停止未核实继续保留目标占用。未知工作等待拥有者提供已生效/未生效证据；核实效果与确认命令单元停止均满足后才结束。取消先落盘再 abort；不把停止命令单元当作撤回服务重启。相同来源的未结束服务操作串行，不能预排另一目标绕过未知暂停；未知时不能换键重试，相同目标在未结束时不能由其他工作重试，主聊天与独立目标继续。
5. 操作只存业务事实、证据和引用，执行状态以原生 Task 为准。启动前核对扩展版本、来源、Task 双向关系与活动目标占用；显式启用不能改变未完成输入的工具。模型工具保持原样。检查新增窄测试、现有四文件、静态和构建；Linux 替身进程恢复与真实 systemd 分开记录。

停止核实另需证明旧 restart helper 不会迟到派发：保护的 claim 保存 Linux 进程身份，stop-op 在启动进程仍活跃、身份未知或旧 claim 不可核实时返回未停止；身份核实结束后再查命令单元；仅有 not-found 还需原 --wait 成功、实际见过单元的持久回执或跨 boot 等证明，排除已经发送但尚未处理的 D-Bus 创建请求。新个人实现只信显式的启动进程退出证明；旧 helper 应答不能释放占用。该前提在隔离工作副本并行修改 helper 与替身，汇总后重定验证范围，不实际部署。

## 进展与交接

- 当前角色：实施者，基点 `66295bf`，接手时工作区干净；首次 `npm run setup` 已通过。
- 影响面：新个人服务操作模块、`personal-harness.ts` 装配和恢复核实、复用的服务应答校验、新窄测试；helper 启动进程停止核实及替身；同步个人模块、部署协议说明、检查导航及决定。旧 Runtime、Coding、依赖、正式入口不变，不安装修改后的 helper。
- 独立方案审查：`permission_survey` 根据当前源码和 1.3.0 原语审查，补充启动进程组与 D-Bus 延迟核实后无阻断；同来源未结束服务操作串行纳入范围。决定见[决策记录](../../../.agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md)。

## 验收与证据

- 默认/三模式、重复/异参、来源拒绝、单次批准、拒绝/取消/修订失效均不误执行；等待审批能重启恢复。
- 已生效至结果提交之间强杀进程，重开调用计数不增加；相同来源换键、相同目标其他来源被硬拒绝，主聊天与其他服务继续。
- 正常、非零退出、可信未启动、畸形/错操作应答、超时、结果落盘失败按事实分类；停止未核实不释放目标，拥有者核实不能替代停止证据。
- 缺配置/扩展、版本不符、来源/执行关系损坏在恢复前拒绝，零 restart；旧个人 API 回归保持。
- 独立实现审查 `service_review` 已通过最终运行时和文档，亲跑新服务工作 36/36、`check:docs`、`verify-notes` 和 `git diff --check` 通过，无剩余阻断。helper 独立审查 `helper_review` 亲跑 Linux root 4/4、旧服务/授权 50/50，启动器与 D-Bus 两项反证均能检出回归。
- macOS / Node 24.15.0 / npm 11.12.1：作者执行五份 personal 测试最终 121/121、零跳过；旧服务/长期授权 `test/78`、`test/79` 共 50/50。`npm run build` 和 `npm run check:static` 通过。四项生产 helper Linux 用例在 macOS 按平台跳过，不计通过；另由 Linux 实验覆盖。
- 真实模型、真实 IM、真实 systemd/测试服务和当前已部署 helper 未验证，不计完整 A5/A6/A7；CLI/HTTP 没有开放写入口，模型 tools/system 文本和既有证据测试保持原样，无新模型文本估算项。
- Linux / Node 24.21.0 / npm 11.19.0：`ssh tx` 隔离副本执行相同五份 personal 测试 121/121、旧 78/79 共 50/50、生产 helper 源码的 Linux root 进程回归 4/4，均零跳过；`RUN_MODEL_CHECK=0`，系统命令为文件桩，保留生产 root 路径信任校验。537 份[源码/测试指纹](../evidence/06-linux/source.sha256)运行前后与本地冻结内容一致，清单 SHA-256 `cc7a8d343cba6030bfb4a75538d6d2ed6628ba81fce624e9c49ce7356c004639`；[命令](../evidence/06-linux/commands.json)、[环境](../evidence/06-linux/environment.json)与[汇总](../evidence/06-linux/summary.json)可核对。先前无 Git 元数据与根盘 ENOSPC 的安装前提失败分别保留，转 `/dev/shm` 后原锁 setup 35.36 秒通过。
- [隔离反证](../evidence/06-linux/negative-checks.json)：分别撤掉进程组消失检查和 not-found 创建请求证明，对应“helper 已死但后代可派发”和“跨连接队列迟到创建”各以 true≠false 失败、退出 1；生产源码不变。
- [清理回执](../evidence/06-linux/cleanup.json)确认本轮远端源码/证据副本均删除，相关进程、socket 与 `/opt` 测试目录为零；未安装 helper 或改真实服务。旧部署版本缺新证明时保持未核实，新保证须部署对应 helper 后生效。
- 工程验收通过；产品验收不适用于本宿主 API 切片；实际 IM/CLI 操作和全部迁移验收仍在总工单待验收。

改动源码、测试、文档与笔记共 18 文件的[内容快照](../evidence/06-service-operations.sha256) SHA-256 为 `3f2d0c03c0e70faa4e15fd2eaad974a8009b53a1248b87ecffcd0f9ee7b94a0b`，不含工单与证据，避免自指。[macOS 证据清单](../evidence/06-macos/evidence.sha256) SHA-256 `ebdf2a1c6447dd8a55526c717653eaed2d33ca50d74924c4a2643725d48a8998`；[Linux 证据清单](../evidence/06-linux/evidence.sha256) SHA-256 `ba167cd744bb42985caa5905be4adcd16d184f8e6d7ddafcf2d095af680ada3e`。

反证输出、两次安装前提失败的 stdout 和源码补丁以 gzip 保留原始字节；[封装记录](../evidence/06-linux/compression.json)保存解压后的摘要，便于核实原始证据。

未跑全量 `npm run check`、Node 22 或真实模型/IM/systemd；未改依赖、旧 Runtime 或 Coding 运行逻辑。两次构建的 Coding 包 shasum 均为 `5af04e561c9fbf84bf29f8237e3655e563ea5ed9`，不据此声称完整 Coding 运行时验收。下一实施者继续总工单的真实拥有者入口、权限来源、原入口审批和长期授权，之后再装配模型写工具。

## Comments

2026-10-17：从总工单接手。只读调查确认原生 waiting 只等待 Task，审批使用持久 document watch；不以 unsafe 工具回放或提示词作为效果未知硬闸。服务操作独立于空工具子会话，避免宿主写入与子模型提前收尾导致占用释放。

2026-10-17：独立实现与文档审查通过。审查发现的同来源预排队、unanswered 来源恢复、意外终态占用、启用配置提交窗口和原生取消归属均修复并配回归。macOS/Linux 最终 personal 各 121/121、旧调用方各 50/50；Linux root helper 4/4 与两项反证通过，仅结束本窄任务。
