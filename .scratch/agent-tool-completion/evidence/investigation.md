# 工具补齐方案：源码调查

## 内容与范围

调查日期2026-10-21，分支develop，读取时HEAD为`224cfd7cc00662b3ef60d8a6f54bdcfe5de6e34a`。本轮写`.scratch/agent-tool-completion/`、两篇2026-10-21 proposed笔记并更新原后台proposed笔记；另给下列12篇implemented笔记各追加2行提案反链，不改其原决定。运行代码未改，已有`.gitignore`修改和`.playwright-mcp/`未跟踪内容不属于本任务，未纳入审查对象。

反链文件为implemented下的architecture/{2026-09-20-tool-worker-per-task-container、2026-10-10-native-execution-sandbox、2026-10-14-agent-wait-and-report-ownership、2026-10-17-personal-durable-commands、2026-10-17-personal-local-management、2026-10-17-personal-telegram-entry、2026-10-17-personal-tools-access-artifacts、2026-10-18-personal-memory-skills-history}.md，bug-fix/2026-10-11-preserve-unverified-worker-stop.md，feature/{2026-10-13-workflow-owner-input-and-delivery、2026-10-14-agent-browser}.md及process/2026-10-14-progressive-human-interaction.md；全部相对`.agents/notes/`。

拥有者原始需求：“我想先补齐文件检索、后台进程、提问，需要你来制定方案”。随后逐项确认“两端规划，先Coding Agent”“跨消息保留，直到显式停止或会话关闭”“首版先停后台再改代码，保留现有占用规则”。这些是目标依据，具体schema和技术取舍为本轮拟定方案，未声称运行代码实施获准或已经验收。

## 关键源码事实

| 位置 | 已核实事实及方案影响 |
| --- | --- |
| `packages/agent/src/tool-router.ts:791` | Coding基础工具为read/edit/write/bash/request_file_access/http_request/read_artifact，bash参数仅command/timeout；检索和受管后台是新增接口 |
| `packages/agent/src/tool-worker/protocol.ts`、`worker.ts:142` | worker只接受四种编码工具，Shell收尾回收原组；新增检索须入worker，后台不能只保留一个PID |
| `packages/agent/src/tool-availability.ts:41`、`driver.ts:595` | 只读/写子角色及额外过滤是显式名单；新工具须同时改装配、发送前与调用门 |
| `packages/agent/src/tool-router.ts:189` | launchSpec绑定当前工作目录、角色保护、原生readRoots和授权；不在宿主另跑rg |
| `packages/core/src/store.ts:2679`、`:939` | 占用绑定Task，终态按Task释放；后台跨轮须增加独立持有者 |
| `packages/agent/src/driver.ts:1154`、`packages/runtime/src/agent-wait.ts:177` | 等待先停当前执行再让目录；后台占用不能被一并释放 |
| `packages/agent/src/execution/native-linux.ts:36`、`native-macos.ts:18` | 受限执行不开放一般网络；首版后台开发服务不能承诺受限浏览器预览 |
| `packages/agent/src/execution/native-linux-identity.ts:128` | 已有持久Linux执行scope/invocation/cgroup核实，可复用低层实现 |
| `packages/runtime/src/runtime.ts:3455` | 普通submit具有事务入队路径；问题消费应与此组合，不能先answered再异步submit |
| `packages/runtime/src/runtime.ts:3581` | 会话存档仅隐藏，运行任务继续；存档不能被偷偷改为关闭 |
| `apps/ruukoto/src/personal-tools.ts:33`、`:102`、`:290` | 个人通用工具无目录检索，资料范围由tools配置/授权核实，read_file只接普通文件 |
| `apps/ruukoto/src/personal-command-work.ts:237`、`personal-harness.ts:584` | 个人命令每次两分钟且收尾停止，不直接列为main工具；后台是显式新增主会话能力 |
| `apps/ruukoto/src/personal-telegram.ts:61`、`:169` | 输入经main队列，原生后台Task后以稳定键admission；提问不能Promise阻塞main |
| `apps/ruukoto/src/personal-source.ts:14` | 当前来源类型无问题回答，新增answer-admission必须扩展可信来源核实 |
| `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:24` | 上游已有ls/find/grep定义，但实现含rg/fd动态下载及raw spawn，不能直接注册宿主版本 |
| `packages/core/src/db.ts:15`、`types.ts:22` | 读取时schema46、协议33；本方案不预约后续版本号，现有精确版本拒绝规则须保留 |

## 取证边界

作者及只读子代理检查了实际源码、工具注册和对应决策；没有运行真实模型、IM、原生进程或新的工具实现。提案描述的是待实现行为，不是现有能力。未读取生产凭据或实例配置，不能据此声称生产MCP、模型和平台前提成立。

独立方案审查须重新读原需求、共享规格、三篇笔记和四张工单，核对源码及历史约束；精确文件快照和结论另记[审查记录](plan-review.md)。
