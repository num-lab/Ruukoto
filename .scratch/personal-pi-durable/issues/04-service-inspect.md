# Durable 服务状态检查与共享 helper 传输

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)阶段 2，先交付一个完整的只读外部调用，对应[规格](../spec.md) A7/A8/A9 的服务检查子项。拥有者确认及接手授权沿总工单生效。正式入口、部署与有副作用操作均不切换；权限三模式、审批、长期授权、工作暂停与服务重启仍由后续切片完成，不能用本任务代替 A5/A6。

`openPersonalHarness` 可由可信宿主显式提供 service helper 配置，模型只能给精确单元名，不能选 helper、策略、sudo 或执行身份。本机向导仍为空工具会话，不新增尚未就绪的服务配置交互。读取状态不引入旧 Runtime/Task/ApprovalGate/ArtifactStore。

## 方案

1. 从旧 `service-tools.ts` 提取不依赖旧状态及 Pi 的 `service-helper.ts`；旧工具复用并保留类型导出，helper 动词/应答协议与 Coding 依赖不变；共享解析明确拒绝重复前缀和无效基本字段。旧错误措辞保持可兼容，新增输出上限只由新调用方传入。提取在独立工作副本完成，主工作区只由主上下文写入。
2. 新个人工具只提供 `service_inspect`：使用固定 helper 的 inspect；执行前检查宿主配置，实际 helper 继续验证本机、服务白名单与修订。恢复只重复无写入效果的 inspect；不安装 restart。
3. 原始 stdout/stderr 和可信应答以 durable entry 保存，`read_service_inspection` 按同会话、指定 entry 类型每页 4096 字符读取原文；工具结果给固定状态、观察时间和证据引用；单次输出有硬上限，超限/协议错误/记录失败不报告成功。正常输出保留原始字节。新工具定义进入现有 provider 请求证据；无配置时继续原空工具行为。
4. durable 保存 helper 配置指纹。重开缺配置或配置变化时在 resume 前拒绝，避免以新的服务配置恢复旧调用；不把缺失配置解释为空工具。已有空工具隔离档案可在无未决输入/任务时启用检查，不重写旧资料。
5. 同步个人模块、产品/工具适用范围、决策笔记及测试映射；不改正式 bin、根启动或部署配置。新增定向测试用真实 SQLite、模型替身和真实子进程 helper 替身，覆盖输入证据、结果、拒绝、配置恢复与中断。共享提取回归既有服务/授权用例；Linux 真实 helper 另查环境前提并登记证据缺口。

## 进展与交接

- 当前角色：实施者；本窄任务工程验收通过，独立实现审查无未解决阻断。总工单阶段 2 继续，不据此完成 A5/A6/A7。
- 当前内容：分支 `Eitrous/migrate-to-pi-durable`，实施基点 `fe8cbb9`；工作区原为干净。本轮个人 Harness/服务工具、共享 helper 提取、窄测试、文档与笔记由本工单同批提交承载；以相对基点的 diff 和[内容快照](../evidence/04-service-inspect.sha256)核对，快照 SHA-256 `43c1432ea54f31bec7789629fd837798402b35614bbcea658a66810d25291e20`，共 15 个源码、测试、笔记与文档文件；工单正文不参与自指哈希。
- 下一角色：实施者继续总工单的 durable 工作归属、权限/审批及有副作用工具；只读 helper 传输可直接复用。拥有者的隔离向导体验仍在工单 03 等待，不阻塞后续实现。
- 阻塞与恢复条件：本窄任务无阻断。真实 Linux 已有旧 helper 可用，但白名单测试服务未安装；后续完整服务管理验收仍需当前部署版本和实际测试服务，不能以未安装状态的观察代替。

## 验收与证据

工程验收通过，仅限宿主 API 的只读服务检查与证据读取。产品验收不适用：本任务没有面向拥有者的配置或新操作流程，IM/CLI 服务配置与真实产品体验仍留在总工单。已安装运行中的服务、写入授权与真实服务重启均未通过本任务验收。

| 对象 | 证据与结论 |
| --- | --- |
| macOS 离线 | 作者在 Node 24.15.0/npm 11.12.1 执行 `npx tsx --test test/personal-services.test.ts test/personal-durable.test.ts test/personal-cli.test.ts`，最终 59/59、零跳过，约 1.91 秒。真实 SQLite、模型替身、真实子进程；覆盖原始字节、输入/工具定义、分页与跨会话拒绝、缺配置/版本拒绝、helper 输出上限、记录失败和进程强杀后 safe 重跑。本轮测试进程已清理。 |
| 共享调用方回归 | 作者完整执行 `npx tsx --test test/78-linux-service-management.test.ts test/79-standing-permissions.test.ts`，最终 50/50、零跳过，约 13.85 秒。首轮有三条旧错误措辞断言失败，恢复兼容措辞后完整复跑通过。旧个人与 Coding 能力门、审批单次消费、长期授权及未知效果分类保留；不是新 durable 权限功能证据。 |
| 构建与静态 | 作者 `npm run build`、`npm run check:static` 通过，新模块进入个人包，Coding 包及依赖声明未改；初轮静态发现新增测试中 union/readonly 类型错误，修复后完整静态通过。 |
| Linux 离线 | 独立上下文 `inspect_plan_review` 在 `/dev/shm` 临时副本按原锁 `npm ci --ignore-scripts --omit=dev --no-audit --no-fund`，334 packages；Node 24.21.0/npm 11.19.0，`RUN_MODEL_CHECK=0` 跑同三文件 59/59、零跳过，约 6.8 秒。451 个[受测源指纹](../evidence/04-linux/source.sha256)的 manifest SHA-256 为 `241e70b1f249c7ee210cec8fa7fb843b89a22173c02d1cfa167b7652dd0b245e`，与当前运行时代码一致。 |
| Linux 真实只读 helper | 同一独立上下文以模型替身驱动新工具，通过 sudo 调用 root 0700 的 `/usr/local/libexec/ruukoto/ruukoto-service inspect ruukoto-service-test.service`，返回 not-found/inactive/dead。1 条捕获保存 stdout 195 B、stderr 573 B，3 次模型请求与 6 条请求证据对应；读原文无新增服务调用，重开字节保持，缺配置拒绝，策略指纹前后不变。详见[结果](../evidence/04-linux/real-helper-summary.json)与[探针源码](../evidence/04-linux/real-helper-probe.mts)。这是已部署旧 helper 的只读协议证据：测试服务未安装，未证明当前仓库 helper 部署或运行中服务管理。未更改策略/服务或执行 restart，未读取真实模型凭据。 |
| 模型可见文本 | 作者对两份实际 provider 请求按 chars/4 + CJK 补足估算：空工具到服务配置，systemPrompt 47 → 45，toolSchemas 0 → 401。窄测试另将实际请求体与持久请求证据逐项比较，工具结果与原文读取来自同一实际会话；不代表旧个人完整提示迁移量或真实模型工具选择能力。 |
| 独立实现审查 | `inspect_implementation_review` 直接读代码、有效规格与 pi-durable 1.3.0，亲跑新服务 19 + 基础 27 合计 46/46。共享两文件初轮 47/50，修正措辞后定向复跑三条 3/3；作者另有最终完整 50/50。亲跑 `check:docs`、`verify-notes`、`git diff --check` 通过，代码及同步文档无未解决阻断。 |
| 回归反证 | 同一审查者在必要文件的隔离副本先跑基线，再分别撤掉重复前缀拒绝和 reader 会话检查；duplicate 子例变为错误成功，跨会话读取变为放行，对应窄用例均退出 1。副本清理，主目录源码指纹不变。 |

Linux [证据清单](../evidence/04-linux/evidence.sha256) SHA-256 为 `5461a9a0477710e6e92b49b59f4d307058c196c1094d2afe3857f281368c5e99`，保存安装/离线记录、真实 helper 字节、请求记录与清理事实。远端本轮副本和临时档案已清理，[清理核实](../evidence/04-linux/cleanup.json)确认无残留进程。普通账户无法读取 root 0700 helper 内容计算文件指纹，本轮不扩大 sudo。

未跑全量 `npm run check`、Node 22、真实模型与真实 IM；没有部署、正式入口替换或服务写操作。本任务增加 A7/A8/A9 子项证据，总工单完整验收和产品切换仍待完成。

## Comments

2026-10-17：接手总工单，核实 HEAD 已包含两项基础交付。只读调查确认 helper 传输可独立复用，先完成无写入效果的检查调用，避免在长期工作归属建立前开放服务重启。

2026-10-17：独立只读上下文 `inspect_plan_review` 直接核对规格、当前调用方与 pi-durable 1.3.0 后通过方案；确认独立扩展引用与已有 root 显式 configure 为实施约束。共享传输在独立工作副本提取后由主上下文汇总，未复制旧状态机。

2026-10-17：完成独立实现审查、macOS/Linux 离线回归及现有真实 helper 的只读调用验证。窄任务工程验收通过，保存当前未提交内容与 Linux 证据；总工单继续推进权限、工作归属和有副作用工具。
