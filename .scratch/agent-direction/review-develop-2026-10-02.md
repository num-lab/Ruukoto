# develop 五次提交及修复复查记录

评审日期：2026-10-02（Asia/Tokyo）。

当前复查到 `a8e2ff7`：R1–R5 已在 `87f1e63` 修复，R6、R8 已在 `3ebaa5f` 修复，R7 的并发残留及 R9 已在 `bdf7346` 修复，均经后续复查确认。第四轮新增一个由 `bdf7346` 引入的 P2 回归 R10：无法核实锁持有者被误判为锁竞争。当前待处理项仅为 R10；下文保留各轮发现时的行为、位置与验证记录。

## 评审范围

首轮基准提交：`ff289e2a4ee5281ffc6ea81f7c9ddeda79893e20`。目标提交：`606e15f930e2988c2e277756d733cfdd600fd604`。首轮 R1–R5 的代码位置与行号对应该目标提交，问题描述保留发现时的行为；当前修复状态见文首及后续各轮复查记录。

```bash
git diff ff289e2...606e15f
git log ff289e2..606e15f --oneline
```

按时间顺序审查以下提交：

1. `42fb710`：ruukoto-code 产品入口与两产品独立启动（工单 01）。
2. `f18470d`：TUI 打开时按需拉起本机后台（工单 02）。
3. `6f38667`：开发机执行边界验证与记录（工单 03）。
4. `e7b4d11`：开发机受限与完全访问接入开发任务（工单 04）。
5. `606e15f`：按工作区创建和切换开发会话（工单 05）。

依据：[方向规格](spec.md)、[ADR 0017](../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)、[运行说明](../../docs/runtime.md)，以及工单 [01](issues/01-independent-products.md)、[02](issues/02-coding-daemon.md)、[03](issues/03-execution-boundary-proof.md)、[04](issues/04-desktop-execution.md)、[05](issues/05-workspace-sessions.md)。

## Standards

### R1 — [P2] 旧项目认领绕过目录身份去重

位置：[src/core/store.ts](../../src/core/store.ts)，`attachProjectRoot`，第 165—169 行。关联工单：[05](issues/05-workspace-sessions.md)。

`attachProjectRoot` 直接更新根目录字段，只依赖 `root_real` 唯一索引，没有复用 `findProjectByRoot` 对 realpath 或 dev+ino 的身份判断。Linux bind mount 别名可能具有不同 realpath、相同 dev+ino；两个旧项目分别认领这两个路径后，会留下同一目录身份的两个工作区，后续自动归属取决于查询顺序。

复现证据：在临时 Store 中先创建根目录身份为 `/first`、dev=1、ino=2 的工作区，再将另一个旧项目认领为 `/bind-alias`、dev=1、ino=2，更新成功且保留两个工作区。本次使用合成目录身份验证存储逻辑，没有执行真实 Linux bind mount 探针。

修复建议：更新前复用现有目录身份查询，拒绝已归属其他项目的目录。验收时应覆盖相同 dev+ino、不同 realpath 的认领冲突，以及同项目相同身份的幂等认领；冲突后不得新增归属或事件。

### R2 — [P2] SQLite 根目录冲突匹配错误

位置：[src/core/store.ts](../../src/core/store.ts)，`isRootDirClash`，第 1885—1887 行。关联工单：[05](issues/05-workspace-sessions.md)。

代码通过索引名 `idx_projects_root_real` 判断冲突，但 node:sqlite 对该部分唯一索引实际返回 `UNIQUE constraint failed: projects.root_real`。旧项目认领已占用的相同 realpath 时，原始异常未被转成 `StoreConflictError`，控制面返回 `internal_error`，客户端将明确的归属冲突视为应答丢失，进入应答丢失处理。

复现证据：临时 Store 中认领已占用的根目录，抛出 `Error / ERR_SQLITE_ERROR`，错误正文包含 `projects.root_real`，没有索引名。

修复建议：沿用 `isCreateRequestIdClash` 的列名匹配方式。验收时应确认同 realpath 冲突返回明确的 `duplicate`，事务不留下新会话或根目录归属，客户端不进入应答丢失处理。

## Spec

### R3 — [P2] 后台探测忽略已配置的令牌来源

位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，`ensureBackend`，第 69—72 行；就绪轮询也采用相同读取方式。关联工单：[02](issues/02-coding-daemon.md)。

探测直接调用 `readOwnerToken` 读取控制目录的 `owner.token`，绕过支持 `RUUKOTO_OWNER_TOKEN` 和 `RUUKOTO_OWNER_TOKEN_FILE` 的 `resolveOwnerToken`。后台与拥有者使用不同 UID、原令牌文件不可读但拥有者持有有效副本时，既有客户端能够认证，新增探测却报告认证失败，TUI 在解析正常客户端配置前退出，不能复用已运行后台。

复现证据：通过真实 Runtime/socket，将后台已加载的令牌文件移到 `RUUKOTO_OWNER_TOKEN_FILE` 指定位置；`resolveOwnerToken` 配合控制面探测可以认证，`ensureBackend` 却返回认证失败。该复现模拟原文件不可读的读取结果，没有创建不同 UID 的部署。

修复建议：首次探测及就绪轮询复用客户端的令牌来源规则，同时允许尚未启动、尚无令牌的后台继续进入启动流程。验收时覆盖环境令牌、令牌副本和默认文件；有效凭据应复用后台，错误凭据应明确拒绝且不重复启动。

### R4 — [P2] npm start 路径无法按需启动后台

位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，默认启动参数，第 88—89 行。关联工单：[02](issues/02-coding-daemon.md)。

运行说明支持 `RUUKOTO_PRODUCT=ruukoto-code npm start -- …`。该路径由 tsx 执行 `src/cli.ts`，因此 `process.argv[1]` 指向 TypeScript 文件；按需启动却使用裸 `node` 派生 `src/cli.ts server`，没有 TypeScript loader。后台加载含参数属性的类时发生语法错误，按需启动失败。

复现证据：macOS 本机 Node 24.15.0，使用默认派生路径调用 `ensureBackend` 返回 `ok: false`，日志包含 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，指向 `src/agent/model-selection.ts` 的 TypeScript 参数属性。以下命令也可单独确认被派生的后台入口错误：

```bash
RUUKOTO_PRODUCT=ruukoto-code node src/cli.ts server
```

修复建议：使用能够加载 TypeScript 的固定服务入口，或为 TypeScript 入口配置 loader。验收时分别覆盖真实 bin 入口与文档支持的 npm start 入口；两者都应能首次拉起后台，并在再次打开时复用同一实例。

### R5 — [P2] 旧项目候选与后台认领条件不一致

位置：[src/control/workspace.ts](../../src/control/workspace.ts)，`findWorkspaceProjects`，第 73—76 行；后台拒绝点见 [src/runtime/runtime.ts](../../src/runtime/runtime.ts)，第 1053—1055 行。关联工单：[05](issues/05-workspace-sessions.md)。

含普通 dev 会话及群聊或角色会话的混合旧项目会成为目录候选，但 `openWorkspace` 随后拒绝认领整个项目。唯一候选场景下，路径入口自动发送必遭拒绝的 `project_id`，不能创建工作区会话。候选筛选与后台防御条件不一致，破坏工单 05 要求的目录打开及旧数据兼容路径。

复现证据：通过真实 Runtime 创建含普通 dev 和 `qq_group` 会话的旧项目，客户端候选为 `mixed`，对应 `open_workspace` 请求返回 `invalid_params`，未创建工作区。现有 test/74 只覆盖纯角色、纯群聊项目拒绝认领，另有断言要求混合旧项目保留在普通选择列表，未覆盖这条路径入口。

修复建议：使目录候选筛选符合后台可认领条件，保留混合旧项目中普通会话的查看与切换能力。验收时覆盖混合旧项目的目录打开，避免自动发出必遭拒绝的认领请求；纯角色、纯群聊项目仍应受到后台保护。

## 验证记录

评审期间执行以下检查：

```bash
npm run typecheck
npx tsx --test test/07-real-tools.test.ts test/30-workspace-entry.test.ts test/67-visual-docs.test.ts test/71-product-entry.test.ts test/72-on-demand-backend.test.ts test/73-desktop-execution.test.ts test/74-workspace-sessions.test.ts
```

类型检查通过；相关测试共 63 项，全部通过，无失败或跳过。五个发现通过额外临时复现确认，现有测试通过不代表覆盖了这些边界。临时复现未新增持久回归测试。

执行与停止路径未发现本次新增的可确认缺陷；基线已存在的问题不计入上述五项。本次评审未重新执行全量 `npm test`、真实模型调用或 Linux 部署隔离验证。

## 第二轮复查：87f1e63

复查日期：2026-10-02（Asia/Tokyo）。修复提交：`87f1e638d52e30a7f019148c840f32d4f7d0ab1c`（`fix: 修复评审 P2 问题 R1–R5`）。本轮先审查 `606e15f...87f1e63` 的修复，再补查 `ff289e2...87f1e63` 的原实现；下列 R6–R8 的行号均对应 `87f1e63`。

### 修复核验

R1–R5 已确认解决：

- R1：更新根目录归属前按 realpath 或 dev+ino 检查占用者，跨项目别名认领被拒绝；同项目相同身份重复认领不新增事件。
- R2：真实 SQLite 根目录唯一约束错误能够转换为 `duplicate`。新增控制面用例主要命中前置占用检查，本轮另以临时 Store 验证绕过预查后的 SQLite 异常转换。
- R3：有效环境令牌或令牌副本能够复用后台；首次无令牌时仍能进入启动和就绪轮询。
- R4：`src/cli.ts` 入口经固定 bin 成功按需拉起后台，并可优雅停止。
- R5：真实 TuiApp、FakeTerminal 和 Runtime/socket 验证混合旧项目的路径入口进入新工作区，原普通 dev 会话仍保留在旧项目中。

### Standards

R1、R2 的修复符合目录身份与冲突处理要求，未发现本次修复新增的可确认规范问题。

### Spec

#### R6 — [P2] ruukoto stop 可能停止错误产品

状态：已在 `3ebaa5f` 修复，第三轮复查通过。以下保留第二轮发现时的行为和位置：[src/cli.ts](../../src/cli.ts)，第 116—118 行；身份注入入口见 [bin/ruukoto.mjs](../../bin/ruukoto.mjs)。关联工单：[01](issues/01-independent-products.md)。

个人产品 bin 没有固定 `RUUKOTO_PRODUCT`，CLI 会采信继承的环境变量。如果 shell 导出 `RUUKOTO_PRODUCT=ruukoto-code`，运行个人产品的 `ruukoto stop` 实际使用开发产品的目录和 socket，可能停止开发后台并中断其任务，违反工单 01 的产品独立与停止互不影响要求。

复现证据：使用隔离的 data、agent、control 目录启动两个真实 bin 后台；在子进程环境设置 `RUUKOTO_PRODUCT=ruukoto-code` 后运行 `node bin/ruukoto.mjs stop`，命令返回 0，开发后台退出 0，个人后台仍可握手应答。模型层打桩，进程与控制面真实；所有临时后台和目录已清理。

修复建议：在个人产品 bin 固定 `ruukoto` 身份，保留 `npm start` 通过环境变量选择产品的能力。验收时在继承相反产品环境变量的情况下分别调用两个真实 bin，确认每条入口的启动、查询和停止均只作用于指定产品。

#### R7 — [P2] 历史日志导致启动失败被误判为锁竞争

状态：已修复；`3ebaa5f` 排除了历史日志污染，`bdf7346` 排除了并发日志对锁竞争分类的影响，第四轮复查通过。以下保留第二轮发现时的行为和位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，第 134—138 行，尤其是对 `logTail(logPath)` 的锁竞争判断。关联工单：[02](issues/02-coding-daemon.md)。

`spawn.log` 持续追加，日志尾部可能包含上一次启动的“实例锁冲突”。本次后台因缺少模型等原因退出时，代码仍可能把 `lostLockRace` 设为 `true`，跳过启动失败分支；按默认配置会等到 60 秒截止后报告就绪超时，并丢失 `no_model` 的模型配置指引。这不符合工单 02 对启动失败状态的要求。

复现证据：在临时 `spawn.log` 留下历史锁错误，再用真实 bin 启动缺少模型的后台，日志尾部同时包含历史锁错误和本次 `no_model`。为避免长等待，将 `deadlineMs` 缩短为 1800、`exitGraceMs` 缩短为 100，结果仍误报“等待后台就绪超时”；默认 60 秒行为由同一分支和默认截止参数推导，未等待完整 60 秒。

修复建议：依据当前子进程本次启动的错误判断锁竞争，不能将共享追加日志中的历史错误或其他启动进程的错误当作当前进程的退出原因。验收时同时覆盖历史锁错误后发生普通启动失败，以及真实并发锁竞争后复用胜者；前者应保留启动失败原因和配置提示，后者仍应等待并复用胜者。

#### R8 — [P2] 协议不兼容错误被替换为令牌检查提示

状态：已在 `3ebaa5f` 修复，第三轮复查确认原版本提示问题已解决；修复引入的断线回归另记为 R9。以下保留第二轮发现时的行为和位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，第 95—99 行；原始错误在 `probeControlPlane` 第 33—34 行被吞掉。关联工单：[02](issues/02-coding-daemon.md)。

后台返回 `protocol_version` 后，探测只返回 `false`，socket 可连分支统一提示核对令牌。ruukoto-code 的 TUI 随即退出，无法进入原有连接层的协议错误展示路径，拥有者看不到版本不兼容及升级指引。工单 02 明确要求不兼容版本给出明确状态。

复现证据：通过本地 Unix socket 模拟旧版本服务端的 v8 拒绝响应，返回与真实 ControlServer 相同形状的 `protocol_version` 错误。直接 ControlClient 显示“服务端 v8，请求 v9；请升级客户端”，`ensureBackend` 却只输出核对 `RUUKOTO_OWNER_TOKEN` 或令牌文件的提示。本次验证使用协议响应模拟，没有运行旧版本完整后台。

修复建议：保留并展示具体认证或协议拒绝原因。验收时分别覆盖错误令牌和不兼容协议；协议拒绝应显示版本与升级指引，不启动第二个后台，也不提示用户修改有效令牌。

### 本轮验证记录

复查期间执行：

```bash
npm run typecheck
npx tsx --test test/30-workspace-entry.test.ts test/67-visual-docs.test.ts test/72-on-demand-backend.test.ts test/74-workspace-sessions.test.ts
```

类型检查通过；相关测试共 46 项，全部通过，无失败或跳过。R1–R5 的补充核验及 R6–R8 的临时复现范围见各条记录；已有测试通过未覆盖这三个残留问题。本轮没有重新执行全量 `npm test`、真实模型调用或 Linux 部署隔离验证，也未新增持久回归测试。

## 第三轮复查：bfcd077

复查日期：2026-10-02（Asia/Tokyo）。本轮审查 `87f1e63...bfcd077`，包含修复提交 `3ebaa5f`（R6–R8）及文档提交 `bfcd077`。目标提交为 `bfcd077a0f0b4d1c0e2f24910523969f534401b3`；以下位置与行号对应该提交。

R6 已确认修复：个人产品 bin 固定身份，两条真实 bin 在继承相反产品环境变量时各自查询和停止指定产品，另一后台仍可握手。R8 的原版本提示问题已确认修复：协议拒绝保留版本及升级指引，对外布尔探测接口仍兼容开发实例。R7 的历史日志路径已修复，但并发窗口仍有遗漏。本轮确认两个待处理的 P2 问题：Standards 轴为 R7 残留，Spec 轴为新回归 R9。

### Standards

#### R7 复查 — [P2] 仍受其他启动进程的日志污染

状态：已在 `bdf7346` 修复，第四轮复查通过；沿用 R7 编号。以下保留第三轮发现时的位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，第 174—179 行；共享日志来源见第 147—155 行。关联工单：[02](issues/02-coding-daemon.md)。

`logStart` 按启动时刻记录共享日志的字节起点，可以排除旧内容，但同一窗口内另一启动进程的锁错误仍落在该切片中。当前进程因 `no_model` 等普通原因退出时，仍可能被误判为锁竞争，跳过启动失败分支并丢失配置指引。原 R7 修复建议明确要求不能使用“其他启动进程的错误”判断当前进程退出原因；源码的近似隔离注释也承认这一上限，当前实现尚未满足该要求。

复现证据：同一控制目录并行两次 `ensureBackend`，实际派生子进程 A、B；B 延迟 100ms 输出锁错误后退出，A 延迟 350ms 输出 `no_model: 未找到可用模型` 后退出。两者日志起点均覆盖 B 的输出，A 最终误报“等待后台就绪超时”，没有模型配置提示。使用 `deadlineMs=1700`、`exitGraceMs=100`；子进程、共享文件和函数路径真实，启动输出内容模拟。默认 60 秒等待由同一分支及默认参数推导，未等待完整 60 秒。

修复建议：按当前子进程归属收集退出输出，避免使用包含其他进程内容的共享切片判断锁竞争。验收时应保留历史日志用例，并新增并发子进程各自失败的场景；普通启动失败须保留其实际原因和配置提示，真实锁竞争仍须等待并复用胜者。

### Spec

#### R9 — [P2] 探测期间后台退出被误判为认证拒绝

状态：已在 `bdf7346` 修复，第四轮复查通过；原问题由 `3ebaa5f` 引入。以下保留第三轮发现时的位置：[src/control/ensure-backend.ts](../../src/control/ensure-backend.ts)，`probeWithReason` 第 50—51 行；短路跳过可达性检查见第 126 行。关联工单：[02](issues/02-coding-daemon.md)。

连接建立后的所有异常都被标为 `rejected, connected=true`，后续直接认为后台仍可连，不再检查当前 socket。后台在认证或握手期间退出时，TUI 会误报后台仍在运行并要求核对令牌，直接退出，不能完成工单 02 要求的“后台不存在时按需拉起”。真实 ControlClient 将传输断线标为 `outcome=disconnected`，这不属于后台明确拒绝。

复现证据：本地 Unix socket 收到认证请求后关闭监听、删除 socket 并断开连接，没有发送拒绝应答。通过真实 ControlClient 和 `ensureBackend` 调用，结果为 `socket_absent=true`、`spawn_attempted=false`，仍显示后台在运行和令牌检查提示；是否尝试启动通过仅写临时标记的 `spawnArgv` 检查。该复现模拟后台退出时的 socket 行为，没有启动并杀死完整 Runtime。

修复建议：区分后台明确拒绝与传输中断；对断线重新检查当前 socket，不以曾经连接成功证明后台仍在运行。验收时覆盖认证和握手期间退出：socket 已不可达时应进入按需启动流程；真正的错误令牌或协议拒绝仍应保留对应指引，并且不重复拉起后台。

### 本轮验证记录

复查期间执行：

```bash
npm run typecheck
npx tsx --test test/32-dev.test.ts test/67-visual-docs.test.ts test/71-product-entry.test.ts test/72-on-demand-backend.test.ts
```

类型检查通过；相关测试共 46 项，全部通过，无失败或跳过。R7 并发残留及 R9 断线回归通过额外临时复现确认，已有测试未覆盖这两条路径。本轮没有重新执行全量 `npm test`、真实模型调用或 Linux 部署隔离验证，也未新增持久回归测试。

## 第四轮复查：a8e2ff7

复查日期：2026-10-02（Asia/Tokyo）。本轮审查 `bfcd077...a8e2ff7`，包含修复提交 `bdf7346`（R7 并发残留与 R9）及文档提交 `a8e2ff7`。目标提交为 `a8e2ff724bab505f40121518c45451b8ab04c7cd`；以下位置与行号对应该提交。

R7 的原并发问题已确认解决：锁竞争按当前子进程的专用退出码 42 判断，共享日志文本不再改变分类，普通失败仍进入启动失败分支。R9 已确认解决：认证及握手期间断线、socket 消失时都会重新检查可达性并进入启动流程。本轮确认一个新增 P2 问题：Standards 轴为 R10，Spec 轴未发现其他新增的可确认问题。

### Standards

#### R10 — [P2] 无法核实锁持有者被误判为锁竞争

状态：待修复，由 `bdf7346` 引入。位置：[src/cli.ts](../../src/cli.ts)，第 144—146 行；身份核实失败的错误来源见 [src/core/instance-lock.ts](../../src/core/instance-lock.ts)，第 99—102 行。关联工单：[02](issues/02-coding-daemon.md)。

`InstanceLockError` 同时表示已确认的锁竞争和无法核实持锁进程身份，CLI 当前将两者统一转换为 `INSTANCE_LOCK_EXIT_CODE`（42）。身份核实失败时，后台明确要求人工确认锁；按需启动却把它当作有胜者待就绪的锁竞争，等待至总截止后只显示就绪超时，丢失人工处理指引。锁机制自身要求“无法核实进程身份时保留锁并要求人工处理”，该错误不应与确认的活后台竞争共用等待行为。

复现证据：通过真实 bin 和临时目录创建有效 `runtime.lock/owner.json`，记录的 PID 指向存活进程；子进程环境设置 `PATH=""`，使 `ps` 无法运行。后台实际退出 42，日志为“实例锁被 pid … 持有，但无法核实进程身份；请人工确认后删除 …”。调用 `ensureBackend` 并设置 `deadlineMs=3000`、`exitGraceMs=100` 后，它等到截止并报告“可能就绪较慢或有并发启动在途”，未展示人工核实说明。进程、锁、文件及 bin 入口真实，无模型调用；默认 60 秒行为由同一分支和默认参数推导，未等待完整 60 秒。

修复建议：仅为已确认的锁竞争返回专用竞争退出码，身份核实失败应按普通启动失败展示原始原因，并保留锁供人工处理。验收时分别覆盖已确认的活后台竞争、身份核实失败、可接管的遗留锁：竞争仍应等待并复用胜者，核实失败应及时保留人工处理说明且不得删除锁，遗留锁仍按既有安全规则接管。

### Spec

R7、R9 的原复现路径已通过。除上述 R10 外，未发现其他新增的可确认问题。

### 本轮验证记录

复查期间执行：

```bash
npm run typecheck
npx tsx --test test/12-reconnect-pending.test.ts test/29-cli-entry.test.ts test/32-dev.test.ts test/67-visual-docs.test.ts test/71-product-entry.test.ts test/72-on-demand-backend.test.ts
```

类型检查通过；相关测试共 78 项，全部通过，无失败或跳过。R10 经额外临时复现确认，现有测试未覆盖身份核实失败的退出码分类。本轮没有重新执行全量 `npm test`、真实模型调用或 Linux 部署隔离验证，也未新增持久回归测试。
