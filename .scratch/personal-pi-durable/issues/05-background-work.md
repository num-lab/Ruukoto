# Durable 长期子 Agent 与后台工作归属

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)的工作归属前提，落实[规格](../spec.md) A3/A8/A9 中可独立交付的宿主 API。拥有者的完整方案确认和接手授权继续有效。子会话固定空工具，主会话现有只读检查保持；不接入写操作、审批、权限模式、IM 或正式入口；追加说明、模型委派工具与最终外发在后续入口接入时完成，本任务不代表完整 A3。

## 方案

1. `openPersonalHarness` 返回后台工作管理 API。首次委派在同一 durable commit 创建 ownerless 长期 Conversation、显式模型/扩展/空工具配置、background Task、来源与 requestId 事实及单工作占用；再次委派复用身份和上下文。来源必须是已进入主会话的原生拥有者 input；同请求键异参拒绝，重复键返回原工作。
2. 自定义 Task 通过原生 `Conversation.submit` 的稳定键恢复同一 Submission；该受理与前述 commit 之间存在恢复窗口，不声称原子。Task 保存 Submission 引用并等待其完成，进度和终态读原生 Task/Submission，不镜像运行状态。工作结果留在子会话，主聊天继续；不自动向主会话注入结果。
3. 取消先提交不可撤销的取消事实，再请求原生 Task abort；恢复时 Task 同样检查该事实并停止。abort handler 对目标 Conversation.abort 并等待闲置，再在同一 commit 释放占用及结束 Task。未完成取消时拒绝复用/关闭身份；关闭空闲身份仅保存关闭事实，保留历史。
4. 注册独立扩展名和业务文档版本，调度前拒绝已有工作扩展/记录的缺失索引或不支持版本；旧无工作档案可在静止时启用。模型变化有未决工作时拒绝；空闲时显式同步所有长期会话，避免保留已不可用 provider。模型请求证据按持久 ProviderDoc.sessionId 归属实际 Conversation，来源缺失/歧义时零 provider 请求。provider prepare/onPayload 在发出前复核占用与取消事实，不依赖 beforeRequest hook。
5. 只修改个人 app、独立窄测试与相应文档/笔记；本机 CLI/API 的产品交互保持后续任务范围。检查为四份 personal 测试、静态及构建；独立审查亲验竞态和回归反证。Linux 在隔离副本验证，不把只读工具取消记为真实副作用停止证明。

## 进展与交接

- 当前角色：实施者；基点 `74c9223`，工作区原为干净；独立方案及实现审查 `next_scope_review` 均通过上述空工具范围，无未解决阻断。本窄任务工程验收通过，不表示总迁移完成。
- 下一角色：实施者继续总工单的权限/审批、长期授权、有副作用执行及未知效果暂停；之后接入模型委派、追加说明、固定回报和实际 IM/CLI 工作操作。拥有者的向导体验仍在工单 03 待验收，不阻塞本宿主 API。
- 影响面：`personal-harness.ts`、新工作模块、测试；`personal-model.ts` 的 provider 包装契约保持；同步个人模块、产品边界、测试映射及 pre-push-checks。
- 内容：实现与材料由本工单同批提交承载，以相对基点的 diff 和内容快照核对。源码、测试、文档、skill 与笔记共 11 文件的[快照](../evidence/05-background-work.sha256) SHA-256 为 `341ea9c6ed7761ba8f1463f8d319026bd0ff75ba1ad5ca829f3cbd80e94bc111`；工单和证据不参与自指快照。

## 验收与证据

- 重复键去重/异参拒绝、同身份忙碌拒绝、上下文保留后复用及显式关闭拒绝新委派。
- A 工作取消不影响主会话和 B；取消持久化后崩溃、受理窗口、迟到完成与复用竞态不产生第二项执行。
- 重启恢复原身份/Task/Submission；缺索引、版本或扩展时零模型请求；模型变更覆盖所有会话。
- 子会话请求证据仅归属实际会话，缺来源时不发请求；存储失败不报告成功、不释放仍待核实的占用。
- 工程验收通过；产品验收不适用本宿主 API 切片：没有新增面向拥有者的操作流程。实际 IM/CLI 工作交互仍在总工单待验收。

| 对象 | 实际证据与结论 |
| --- | --- |
| macOS 离线 | 作者在 Node 24.15.0/npm 11.12.1 执行 `npx tsx --test test/personal-work.test.ts test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts`，最终 85/85、零跳过，约 6.06 秒；其中工作 26 项。真实 SQLite、HTTP、子进程和进程强杀，模型及 helper 为替身。覆盖同键去重、上下文复用、来源拒绝、并行聊天、取消与迟到结果、登记写失败、两处强杀恢复、HTTP 前检查、双向关系损坏及在途 background 压缩的正常/取消收尾。 |
| Linux 离线 | 独立上下文 `linux_readiness` 经 `ssh tx` 在 `/dev/shm` 隔离副本按原锁安装，334 packages、27 秒，Node 24.21.0/npm 11.19.0；`RUN_MODEL_CHECK=0` 执行同四文件，最终 85/85、零跳过，进程约 18.69 秒。419 份[受测源码指纹](../evidence/05-linux/source.sha256)与本地完全一致，清单 SHA-256 `1b822037a4bc31c7b686d3e5450194963fe7a4fb9b4d472c6bcce3d949180039`。完整[输出](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F05-linux%2Ftests.stdout.log)、[环境](../evidence/05-linux/environment.txt)、[命令与退出码](../evidence/05-linux/tests.json)和[安装配置](../evidence/05-linux/setup.json)入库。 |
| 构建与静态 | 作者在最终运行时代码执行 `npm run build`、`npm run check:static` 通过，新工作模块进入个人包。没有修改依赖、锁文件、正式入口、共享包或部署；Coding 包内容保持同一指纹，不因此声称完整 Coding 运行时验收。 |
| 模型可见文本 | 独立审查捕获真实 mock HTTP 的 system 与 tools，按 `context-selector.ts` 的 calibration=1 算法（chars/4 与 CJK 补足分别取整）估算：主会话 systemPrompt 47→47、toolSchemas 0→0；子会话新增 systemPrompt 0→83、toolSchemas 0→0。实际子提示与源码相同，子请求为空工具；窄测试核对请求体与所在会话的持久证据，不代表真实模型任务完成质量。 |
| 独立实现审查 | `next_scope_review` 直接读取有效规格、代码及上游 1.3.0，亲跑最终四文件 85/85、新工作 26/26；亲跑 `check:docs`、`verify-notes`、`git diff --check` 通过。审查确认主聊天隔离、原生状态权威、取消窗口、背景压缩停止、恢复关系核对及文档边界，无未解决阻断。 |
| 隔离反证 | 同一审查者在保留根/app 两层 Pi 依赖解析的隔离副本，先跑 HTTP 闸与后台压缩各 3/3 基线；分别只撤正常收尾、abort handler 的 `background:true`，对应真正后台压缩子例均以 completed≠aborted 失败；只撤 provider 工作检查，取消子例真实 HTTP 次数 2≠1 失败。三变体均退出 1，主源码指纹不变，副本已清理。初次漏 app 层依赖的副本基线不计证据。 |

Linux [证据清单](../evidence/05-linux/evidence.sha256) SHA-256 为 `b26243c2d6e97b8c29943a8c1365b3935a01dbe7d68b877dbb90d8c080356001`。作者、审查者和远端测试实例均已清理；远端[清理记录](../evidence/05-linux/cleanup.json)确认本轮副本已删除且关联进程为零，清理前进程/socket 也均为零。没有读取真实凭据或操作真实模型、IM、helper 和服务。

未跑全量 `npm run check`、Node 22、真实模型/IM 或 Coding 正式入口回归；后者代码和依赖未受本轮修改。不提供外部工具停止、审批或未知写入安全证据。旧无工作档案若有未决输入，本版本明确拒绝启用工作扩展，需要用对应旧版本处理完成后再升级；已存在后台工作档案的断链则保留现场并拒绝恢复。

## Comments

2026-10-17：独立只读调查建议先完成具有实际模型工作消费者的工作生命周期，避免提前增加无写工具使用的通用效果核实框架。调整技术施工顺序，不改变确认目标和总验收标准。

2026-10-17：独立方案审查收窄为子会话固定空工具，完成宿主生命周期、请求证据归属和恢复核对。预审发现取消同 checkpoint 无进展、反向索引核对与后台压缩证据缺口，均已修正并用窄测试及隔离反证核实。macOS/Linux 最终各 85/85，独立实现审查无阻断；只结束本窄任务，继续总工单。
