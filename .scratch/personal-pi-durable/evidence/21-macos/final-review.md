# 独立实现终审

对象：窄工单 21 的子服务 restart、原工作权限与来源、task-owned 生命周期、审批与恢复入口、对应测试和文档。基点 b385f7a；最终内容 SHA-256 见 final-review-scope.json（26 个实施文件，与作者 source-manifest.json 和当前文件逐项一致；工单进展/证据元数据排除）。

结论：当前代码、文档与最终工程材料无未解决阻断，本片工程验收通过；完整迁移和真实环境验收不在这一结论内。

## 独立核实

直接核对规格、当前工单、相关既有笔记、完整变更、所有受影响调用方，以及 Pi 1.3.0 TaskOptions/TaskRuntime 和 scheduler 的 ownership、background、abortOwned、ownedTasks、waitForTask、terminal/completing 语义。按单拥有者个人后台负载评估；复用现有服务操作与 helper，没有新增通用外部执行状态机。

确认服务 Task 由原 WorkTask 持有且不带 background；原宿主操作保持独立 background，取消不误归组。新服务在同事务固定原 tool/generation/child inputs、映射后的全来源、权限/入口与不可改接纳；恢复双向核对。服务审批前检查接纳和批准消费均在事务内检查原工作及整组暂停。未知恢复不重发 restart；正常与取消收尾均等待 native Task，并另核实终态/faulted 的外部未知和审批前检查；双事实才释放占用。本机决定仅限非 Telegram；子证据读取限原子会话。

审查发现并已修正：审批前检查曾只保留 origin 来源；preflight 与检查接纳之间的取消窗口曾可登记新检查；消费前 faulted 曾在实际模型输入中表现为无结果的成功工具调用。后两项独立探针均先亲见原失败、修正后通过。另修正了新 Telegram 用例误取旧 Task 的时序窗口，以及 Linux HTTP 用例新增拒绝历史后仍断言列表一条的过期断言；文档中“模型写工具未接入”旧句已同步。

## 亲验

- `npx tsx --test --test-name-pattern='子服务|服务审批向导|认证前' test/personal-service-operations.test.ts test/personal-telegram-permissions.test.ts test/personal-cli.test.ts`：32/32 通过；实际 stdout 入库为 review-focused.log。覆盖三模式/原权限、批准消费、原键/实际 SIGKILL 恢复、接纳写失败、审批/检查/restart/未知取消、在线 faulted 两分支、精确取消窗口、封组等待双事实、长证据分页/跨子拒绝、空闲升级/未决拒绝、后来说明来源暂停、独立宿主不误取消、Telegram 原入口/长期授权/撤销/换代和混合来源、本机认证及两个决定动作。
- 临时目录 review-probes.mts 中两个独立缺陷探针，修正后 2/2 通过；与上述纳入仓库的回归重叠，不累加为新唯一场景。另执行成功工具往返捕获用例，核对 1 次 helper 桩 restart、4 次实际 mock HTTP 请求及 2 条原生工具结果。
- `npm run verify-notes`、`npm run check:docs`、`git diff --check` 通过。最终测试文件的 TS18048 修正仅拆开存在性断言，独立读码确认无运行行为变更。
- model-snapshots/ 保存 b385f7a 与最终源码的主/子实际 HTTP 输入、统一字符/4估算和当前 service_restart→read_service_operation→完整回答。主 systemPrompt 58→74、toolSchemas 768→770；子 systemPrompt 36→38、toolSchemas 249→503。估算不是 tokenizer 计数；快照没有 HTTP 头、凭据或用户真实资料。

未亲验 Linux/systemd、真实模型或 IM、拥有者产品体验；不把本机 mock/可执行 helper 桩计作这些证据。没有执行全仓检查或提交/部署。

## Linux 最后测试同步复核

终审后 Linux 专用 HTTP 场景仅新增 `await p.harness.waitForTask(approval.taskId, context)`：在原拒绝决定已保存、重开 Harness 之后等原审批 Task 终态，再登记新操作。`canDecide=false` 不能证明原 Task 已结束，该等待关闭测试先后窗口；没有改变生产代码或测试要求。已直接复核此行及全部调用，当时 25 个实施文件与作者清单完全一致。当前机器不执行 Linux 专用场景，最终 Linux 增量结果另归执行证据。

已读取本机完整结果 411 项：410 通过、1 项 Linux 专用跳过、0 失败；构建与最终 static 日志通过，Coding 打包 SHA-1 保持 5af04e561c9fbf84bf29f8237e3655e563ea5ed9。读取真实 PTY 结果为 12 步/12 次认证请求，批准和拒绝各一次，源码哈希相符；HTTP 使用本机桩，没有 helper/systemd/模型/平台操作，产品体验仍待拥有者。

模型快照 comparison-first-sample.json 保留首次采样原记录；comparison.json 同时列初次与最终实际重采的时间、源码和材料哈希，并补最终源码哈希。工具定义与系统提示未变；数字保持此前估算。

## 最后笔记互链复核

新增 proposed 总方案到 implemented 子服务工作的落地指针，并把新笔记的总方案名称改为相对链接。两个目标均存在，proposed 状态、正式未切换和完整迁移待验保持；没有改变产品要求。独立执行 verify-notes 通过。最终实施清单增至 26 文件，现已与作者清单和当前字节逐项校验相同；生产与运行时测试不受此增量影响。

## 最终工程材料与交接

作者 26 文件清单 SHA-256 为 75abfe52405fab31be3c6e07885a4afa7ae9eb34f56bcd8b19f1ef6739d58144，与独立审查 scope 和当前字节完全一致。逐项重算 Linux 1394 文件最终 tested manifest 中的本片实现哈希，差异恰为两篇笔记互链、products 与 usage 两篇文本；运行时代码和全部测试一致。工单 21 已改为准确列出这四篇差异，未把 Linux 代码与测试通过说成全文档同快照。

直接读取 Linux 原始日志、执行器和步骤记录：个人 12 文件 394/394、产品入口 17/17，合计 411 个唯一通过；CLI 最终等待增量后整文件 26/26 为重复集合，不叠加。构建与四个记录步骤退出码均为零；setup 另有起止及 exit 0 记录。Linux 使用真实 Unix socket、子进程、实际 SIGKILL 和生产 sudo/-n 接线的可执行命令桩，没有实际 sudo 提权、真实 systemd/模型/IM。此前失败或中止是有说明和修正的历史记录，不是当前未解决失败。

重算 42 项 Linux 材料的字节数和 SHA-256，全部相符。三份本机日志原字节 gzip 的摘要及其只规范行尾空白的阅览副本均相符，未改变原测试结果。最终模型快照、首次采样原记录、实际重采记录、PTY 输入/源码哈希均相符。

核对清理脚本与原证明：只删除本次 /tmp 与 /dev/shm 两个专属根目录；不保存 argv/environment 字节，不向进程发信号。记录中没有本次残留进程或新增僵尸，七条既有 PID/PPID/comm 前后不变；我另通过 ssh tx 只读亲查两根目录现均不存在。没有重跑已通过的运行时测试。

工单 21 的 ready-for-human、工程验收通过与产品/真实环境待验，以及总工单 in-progress、未提交/未推送/未部署和下一实施范围，均与实际材料一致。最终材料审查无未解决阻断；完整 A1–A12、正式入口切换和拥有者体验仍未计通过。机器核对结果另存 final-evidence-check.json。
