# Coding 持久提问实施验收

2026-10-21，macOS arm64、Node 24.15.0、Electron 44.7.2。接手[工单](../issues/02-coding-owner-questions.md)时，工作区已有未提交实现而正文仍称未实施；本轮核对现状、修复审查发现、完成最终组合验收并保存证据。基点为 `88a0e2a9eb28886b4e9c9a506d3eb115b511234a`；[被审文件摘要](owner-question-review-snapshot.json)记录最终代码、测试与文档，不把先前实现重复记为本轮新写。

## 范围与行为

交付 Coding 普通开发会话及 Plan 的 `ask_user`、持久问题与回执、可信回答同事务唯一入队，以及 TUI/Desktop 逐题作答、取消和重连。个人 durable、后台进程及工作流原 ask 不在本切片内。设计依据见[实现笔记](../../../.agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md)。

| 验收要求 | 实际证据 |
| --- | --- |
| 参数校验、同操作去重、单个待答批次、终态与来源限制 | `test/owner-question-tools.test.ts`；SubAgent、工作流、定时及内部来源拒绝，不借完全访问扩大资格 |
| 当前轮三层收窄、普通聊天保留问题、当前模式续接、回答不批准操作 | `test/owner-questions.test.ts`；实际 SDK 请求、历史和 prompt 快照断言，原工作流114回归 |
| 双答/答取消仲裁、旧版本与同键异参、事务故障零续接、应答丢失原键恢复、重启唯一入队 | `test/owner-questions.test.ts`；真实控制面和SQLite断言，客户端pending守护用例 |
| 显式取消活动原任务使问题失效 | 新增控制面取消集成用例；独立审查在隔离副本撤掉 Runtime 接线后得到 `pending !== stale`，证明能捕获回归 |
| 最长题目/答案、全局快照预算及迟到页不回滚 | 存储分页、完整控制帧、TUI/Desktop主动补读及查询代次用例 |
| 两端逐题、自由文本、返回、取消、原键恢复 | [客户端离线记录](owner-question-clients.md)、[真实PTY夹具](owner-question-tui-pty.mts)、下述 Electron 实验 |
| 版本与离线导入不丢新资料 | `test/owner-question-import.test.ts`；schema47、协议34精确拒绝，含问题或回执的源明确拒绝导入 |

## 工程检查

`npm run check:static`、`git diff --check`通过；最终静态检查覆盖本轮补修与文档。按影响选择窄测，不运行全仓 check。

| 实际执行 | 结果 |
| --- | --- |
| `test/owner-question-tools.test.ts`、`test/owner-questions.test.ts`、`test/owner-question-import.test.ts` | 独立后端审查亲跑原18条通过；新增活动任务取消窄测另1条通过 |
| `test/66-control-seam.test.ts`、`test/114-workflow-owner-input.test.ts` | 后端审查亲跑29条通过，原工作流业务回答保持独立 |
| `test/owner-question-clients.test.ts`、`test/13-tui-state.test.ts`、`test/desktop-composer.test.ts` | 客户端审查亲跑原41条通过；新增72列长选项窄测另1条通过 |
| `test/12-reconnect-pending.test.ts`、`test/14-tui-app.test.ts`、`test/41-desktop-stream.test.ts`、`test/38-desktop-main.test.ts` | 客户端审查亲跑130条通过，无跳过 |
| `test/01-concurrency.test.ts`、`test/03-lifecycle.test.ts`、`test/04-crash-recovery.test.ts`、`test/05-overflow-db.test.ts`、`test/07-real-tools.test.ts`、`test/08-approvals.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、`test/62-tool-availability.test.ts`、`test/66-control-seam.test.ts`、`test/94-task-ending.test.ts`、`test/114-workflow-owner-input.test.ts`、`test/36-event-flow-state.test.ts`、`test/37-view-browser.test.ts` | 组合187条：186通过，08外部文件审批的第二次待审批查询超时；随后只复跑该用例1条通过，不把首次执行记为全绿 |
| `test/38-desktop-build.test.ts`、`test/18-model-selection.test.ts`、`test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts` | 37条通过，含实际构建的终端vendor引用及SDK上下文回归 |
| `npm run desktop:build`；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` | Electron三个目标、制品核实、目录应用打包与ad-hoc签名通过；没有发布 |

各组有重复用例，表中不相加为唯一测试总数。构建中 `inlineDynamicImports` 有既有弃用提示，不影响构建和签名；没有借本切片整理无关构建选项。

## 真实模型与实际文本

同一显式 `agentrouter/deepseek-v4-flash` 配置、新隔离普通 Coding 完全访问会话，最终模型用例1通过、0跳过。模型提问后自然结束，待答不占目录；普通新聊天保持问题，专用入口的实际单选和随机自由回答唯一续接，原文进入SDK JSONL和真实请求。完整系统提示、工具定义、提问结果、历史和回答请求见[最终证据](owner-question-model-final/summary.json)及其同目录文件；[逐条文本核对](owner-question-model-final/agent-facing-audit.md)覆盖实际请求的 J1–J8，未触发错误分支另以源码核对。

随后另从固定 HEAD 导出独立基线源码，8个 workspace 包均解析到基线副本，使用同模型与同种会话取实际快照。对比见[量化](owner-question-model-baseline/comparison.json)：systemPrompt `1506 → 1506`，toolSchemas `11022 → 11463`（+441），工具 `31 → 32`，唯一新增工具为 `ask_user`；共同工具只补缺省空 required 数组。基线请求被真实服务以400拒绝（缺省 required 被解释为 null），故其任务失败，只用实际发送前快照作量化，不记为基线功能通过。此反例也证明SDK装配修复的必要性。

最终同一任务登记前后，toolSchemas `11463 → 863`，只保留三个宿主状态查询，systemPrompt均1506；回答续接恢复11463。这是状态比较，区别于前段的实施前后比较。最终证据中较早记录的“无可信实施前对照”保留当时事实，后补基线由本段及独立目录说明。入库prompt JSON仅补文件末尾单换行，逐份验证JSON值相同；manifest和summary分别保存导出文件sha256与原始artifactSha256。

模型配置未入库，证据按实际 API key 精确匹配扫描通过；Runtime停止后清理新建凭据档案。真实模型仅覆盖普通Coding完全访问；Plan及来源限制有离线SDK/资格回归，不外推为各身份真实模型验收。

## 真实客户端交互

Python PTY 在90×28真实终端运行TUI、临时Runtime和ControlServer，模型mock。四轮分别验证含 q 的中文自由文本、显式取消、单选加自由文本，以及5个长选项的PgDn续读和正确选择。最后一轮逐输入分段断言最后选项尾部出现在翻页阶段，初始页不可见，不靠后续核对页补全文；每轮核对原始答案/无续接及退出alt screen恢复。完整脚本命令为 `npx tsx .scratch/agent-tool-completion/evidence/owner-question-tui-pty.mts`。

Electron 使用当前生产构建的main/preload/renderer，两个独立进程与客户端数据目录，真实Runtime/ControlServer，模型mock。[夹具](owner-question-electron-harness.mts)是交互后台与CDP实验入口，非单命令自动GUI测试；仅在临时构建副本设置隐藏BrowserWindow并抑制通知，不改正式应用源码。通过CDP操作实际渲染控件：选项以ArrowUp/Enter选择“共享”，中文自由输入“真实 Electron 中文 q 回答”，上一题/下一题保留答案，核对页见[1160×780截图](owner-question-electron-review.jpg)。

原回答完成事务后扣住应答，确认客户端pending已保存原键 `5bc21f29-0b54-434b-85dc-88aa6000348f` 及完整答案；随后停止并重启同档案Runtime，真实socket断开触发重连。恢复后pending为0，仍只有原续接 `task_0ad8b88372b0b029d7fceffc`；第二窗口实时显示相同答案及终态，其旧参数经实际IPC晚提交被拒。第二批从第二窗口测试取消→返回回答→确认取消，两窗口均显示取消且无续接。持久白名单导出并断言的[结果](owner-question-electron-result.json)为两批问题、一答一取消、两次提问加一次续接共3个任务；[760×500恢复截图](owner-question-electron-recovered.jpg)保留题目、实际答案与终态，诊断无新增页面异常。

这里证明隐藏Electron真实渲染、CDP键盘/文本、双客户端状态和真实传输断线；没有声称前台人工输入法、两个窗口同时点击竞速或其他平台Electron通过。真正并发消费由离线真实控制面双客户端竞争用例证明。两个Electron已退出，Runtime、临时档案和控制目录已清理。

## 独立实现审查与交付

独立上下文 `owner_question_backend_review` 直接读取要求、代码、测试与文档，覆盖core/agent/runtime/control/导入。未发现功能阻断；指出活动提问任务的取消接线缺回归，补测后亲跑通过，并在隔离副本撤掉两处接线取得失败反例。累计亲跑48条通过，共享工作区只读。

独立上下文 `owner_question_client_review` 覆盖TUI/Desktop/view/pending与文档，亲跑原171条通过，并亲跑真实PTY前三轮。发现TUI SelectList硬截长选项，复现相同长前缀的尾部不可读；修复为编号全文换行正文后，新增窄测及原反例均通过，阻断关闭。随后直接核对四轮PTY、Electron夹具、截图与白名单JSON的归属和关系，无新阻断。真实模型由独立上下文 `owner_question_agent_evidence` 复跑并保存，实际文本及基线分开核对。

工程验收通过，无未解决阻断；产品验收在本工单列出的结构化交互与工具接口范围通过，使用既有控件，没有待拥有者决定的新产品取舍。没有运行全仓check、CI完整Linux/Node矩阵、前台IME或其他切片；没有提交、合并、部署或修改日常档案。schema47/协议34要求新档案及匹配代码，旧库不自动迁移；含问题记录的导入明确拒绝，原资料保留。
