# 控制面路径按显式产品解析，后台可由外部 node 拉起

Status: resolved

## 目标与边界

实现[规格 R7](../spec.md)中控制面一侧的前提：一个进程能同时解析两个产品的路径，`ensureBackend` 能用调用方给的 node 与 bin 拉起后台。TUI 与 CLI 行为不变。

## 方案

1. `packages/control/src/connect.ts` 的 `defaultDataDir`、`defaultAgentDir`、`controlDirFor` 增加可选的 `ProductType` 参数；不传时仍调用 `productFromEnv()`，现有调用方不改。`dirEnvFor` 已经支持显式产品；`socketPathFor` 只做路径拼接，不需要扩展。`resolveClientConfig` 保持原样，03 调用时会同时显式传入 `dataDir` 与 `controlDir`。`defaultPendingDir` 不改，05 按连接目标把目录直接传给 `PendingRequestStore(dir)`。
2. `EnsureBackendOptions` 新增 `spawnExecPath`，不传时为 `process.execPath`。第 161 行的 `spawn(process.execPath, argv, …)` 改为使用这个参数。`spawnArgv` 仍然只放固定 bin 及其参数；detached、unref、探测优先、实例锁仲裁的行为都不变。
3. spawn 失败的处理：把第 170 行丢弃错误的 `child.on("error", () => {})` 改为记下系统错误的 `code`。方案者已实测，可执行文件缺失时 `code` 为 `ENOENT`，没有执行权限时为 `EACCES`。轮询仍然先探测：如果并发启动的另一个后台已经就绪，照常按复用返回；否则立即返回按 `code` 分类的错误，不再等待 `exitGraceMs`。错误要写明可执行文件的路径和修复指引：`ENOENT` 是"找不到 node"，`EACCES` 是"node 不可执行"，其他情况附上 `code`。分类只看 `code`，不解析错误消息，也不依赖日志内容。
4. 文档：`docs/modules/control.md` 的对外接口补上显式产品参数、`spawnExecPath`，以及 spawn 失败时的返回结果。

## 进展与交接

- 当前：实现、文档、定向验收与独立实现审查通过，工程验收完成；无剩余阻断，产品验收不适用。
- 下一步：本单无待办；03 可使用显式产品路径与 `spawnExecPath`，继续承担登录 shell 环境和真实 Electron 启动链路验收。
- 基点：方案基于 `develop` @ `4611eff`，本轮实施基于 `b4ac27d`（已包含 01 的共享投影抽取）。
- 阻塞：无。

## 验收与证据

工程验收通过：作者定向回归、静态检查与独立实现审查均通过；执行材料见下节及 Comments。

- 显式产品：在 `test/71-product-entry.test.ts` 中，全局产品固定时交替解析两个产品，数据、agent、控制目录与 socket 各自正确；两个产品的环境覆盖变量同时存在时互不串用；不传参数时行为不变。
- 外部可执行文件：在 `test/72-on-demand-backend.test.ts` 中，`spawnExecPath` 指向一个与宿主路径不同的临时包装脚本，脚本先写一个标记文件，再 `exec` 真实的 node。断言标记文件存在，且经固定 bin 拉起的后台完成了真实的控制面握手。只传 `process.execPath` 的用例无法证明新参数生效，不作为这一项的证据。
- 失败分类：`spawnExecPath` 指向不存在的路径时，返回的错误包含该路径与"找不到 node"的修复指引；指向没有执行权限的文件时，返回"不可执行"；两者都不再报"服务进程已退出且控制面未就绪"。另加一条：spawn 失败而另一个后台已经就绪时，按复用返回成功。
- 回归：门控、并发收敛、日志尾部的既有用例通过；`test/06-connectivity.test.ts` 与 `test/29-cli-entry.test.ts` 不回归。

产品验收不适用：本单只扩展控制面库接口，保留 CLI／TUI 调用约定，不交付桌面界面或主观体验。

## 实施与验证

2026-10-15，macOS Apple Silicon、Node v24.15.0，实施基点 `b4ac27d`。

- `connect.ts` 的三个目录函数接受可选 `ProductType`，默认仍调用 `productFromEnv()`；调用方、exports、`resolveClientConfig` 与 `defaultPendingDir` 无需改动。
- `ensureBackend` 使用独立的 `spawnExecPath`，按系统 `code` 报告 spawn 失败；循环先探测，spawn 失败后连到另一后台返回 `{ ok: true, spawned: false }`。detached、unref、实例锁仲裁与普通退出日志分支沿用。
- `docs/modules/control.md` 已同步接口与失败行为；决定就地补入桌面客户端提案，整体提案仍为 proposed，不将其他桌面工单标为完成。CLI／TUI 入口、命令与操作步骤未变，不需修改 README、usage、development 或检查命令。
- `npx tsx --test --test-name-pattern='显式产品|外部 node' test/71-product-entry.test.ts test/72-on-demand-backend.test.ts`：7/7 通过。带空格的包装脚本写标记后执行真实 Node，经固定 bin 完成认证握手；ENOENT／EACCES 来自真实 OS spawn；其他码与错误消息矛盾的用例使用模拟 EIO。并发复用将启动前两次连接及首次轮询探测设为不可达，经过一次 poll，确保真实 ENOENT 事件已送达后下一轮才能连接真实后台，断言完整复用结果与确实执行过 spawn；此处经独立审查补强，最终复核见 Comments。
- `RUN_MODEL_CHECK=0 npx tsx --test test/71-product-entry.test.ts test/72-on-demand-backend.test.ts test/06-connectivity.test.ts test/29-cli-entry.test.ts`：54 通过、0 失败、1 跳过，约 27 秒；06 的真实模型连通性按默认离线约定跳过，不能视为真实模型通过。既有门控、并发收敛、锁败者等待、日志尾部、产品与 CLI 用例均通过。后台、socket 与 SQLite 真实，模型打桩。
- `npm run check:static`、`git diff --check` 通过；并发用例按审查补强后再次执行静态检查，通过。`npm run change-scope -- --base b4ac27d` 核实改动只覆盖本单 7 个文件，无依赖、配置或导出变更。

未运行全量 `npm run check`、Linux／Node 22、真实 Electron 或真实模型；前者不在本单最小检查集，Electron 整体链路归 03，平台矩阵与真实模型不作为本单已通过的证据。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

### 2026-10-15 独立方案审查

对象：`43c16ac` 上的本单方案，对照当前规格 R7、R19、桌面客户端提案、03／05／08 的交接与实际调用方；相关 control 与 core/product 源码相对方案基点 `4611eff` 未变。按共享接口与进程启动契约采用重流程，假定使用规模为单一拥有者、两个连接目标、桌面端与 TUI 可同时拉起本机后台。结论：需修订，暂不能交实施；下一责任人为方案者。

1. **P1：第 2 步误把启动参数注入当成可执行文件注入，外部 Node 实际无法启动。** [ensure-backend.ts](../../../packages/control/src/ensure-backend.ts) 的 `EnsureBackendOptions` 只有 `spawnArgv` 与 `env`，第 161 行固定调用 `spawn(process.execPath, argv, …)`；因此当前接口始终启动宿主可执行文件。把外部 Node 路径放在 `spawnArgv` 首项只会把它变成脚本参数。实测在 Node 宿主下传 `[process.execPath, 固定 bin, "server"]`，返回启动失败，日志含 `SyntaxError`：Node 二进制被当成 JavaScript 解析。桌面主进程同样不能靠这两个现有参数选择 R7 要求的外部 Node。

修订要求：给 `ensureBackend` 增加独立的可执行文件参数（如 `spawnExecPath`），缺省仍为 `process.execPath`；`spawnArgv` 保持只含固定 bin 与其参数，沿用 detached、unref、探测优先和实例锁仲裁。同步说明 `spawn` 失败的处理：现有 `error` 监听丢弃原因，隔离探针把宿主 `execPath` 临时设为不存在的路径后，只得到「服务进程已退出且控制面未就绪」及空日志指引，无法指导修复 Node。应按系统错误 `code` 区分缺失／不可执行，保留可读的修复指引，不能靠解析消息或空日志分类；并发胜者已经就绪时仍可复用，不误杀后台。

验收须证明实际使用了指定可执行文件：使用与宿主路径不同且可辨认的入口（例如临时包装脚本写标记后执行真实 Node），经固定 bin 完成真实控制面握手；只注入 `process.execPath` 会让忽略新参数的实现也通过。另覆盖缺失可执行文件的原因与修复指引，并沿用门控、并发收敛与日志尾部回归。`docs/modules/control.md` 除路径参数外，也应说明该启动参数及失败结果；决定的落点沿用桌面客户端提案。

产品调用方核对：

- 三个路径函数增加可选 `ProductType`、缺省仍调用 `productFromEnv()`，可以保留 CLI／TUI 的产品环境约定；`dirEnvFor` 已支持显式产品，`socketPathFor` 只拼路径，无需扩展。验收应复用 [test/71-product-entry.test.ts](../../../test/71-product-entry.test.ts)，覆盖固定全局产品下交替解析两产品、双方环境覆盖同时存在、agent 目录，以及未传参数的既有行为。
- `resolveClientConfig` 内部仍会按全局产品补默认值，但已经允许同时传入 `dataDir` 与 `controlDir`；03 可显式传全两者，或由方案者选择给此聚合入口透传产品参数。`ensureRuukotoCodeBackend` 的现有生产调用方只有单产品 TUI；桌面端用目录完整的 `ensureBackend` 即可，无需为本单改所有 TUI 调用方。
- [pending-requests.ts](../../../packages/control/src/pending-requests.ts) 的 `defaultPendingDir` 也读取全局产品，但 [05](05-code-submit-and-controls.md) 已要求按目标在应用数据目录分开保存；现有 `PendingRequestStore(dir)` 足以落实，不要求新增产品参数。其余 `productFromEnv()` 调用位于单产品 CLI／TUI；`ControlConnection` 本身不读取全局产品。

03 交接提醒（不另计本单阻断）：路径解析与令牌解析仍读取主进程环境，`ensureBackend.env` 只传给子进程；不能只传登录 shell 环境给子进程便声称完成 R7 的环境一致性。03 须在解析路径和令牌前采用登录 shell 环境，或显式传递所需值，并以路径覆盖变量只存在于登录 shell 的情况验收。08 的 SSH 令牌继续直接交给目标连接，不经 Code 的全局令牌解析。

本轮证据：macOS、Node v24.15.0；两个隔离启动探针已执行，临时目录已清理，未修改实现。`npx tsx --test --test-name-pattern='ruukoto（默认产品）|ruukoto-code：独立档案根' test/71-product-entry.test.ts` 为 3/3 通过；`npx tsx --test --test-name-pattern='门控：|按需拉起：后台不存在|并发拉起收敛|启动失败给出明确状态' test/72-on-demand-backend.test.ts` 为 4/4 通过，后台为真实 bin／socket／SQLite，模型打桩。这些只证明既有行为与方案缺口，不代表外部 Node 能力验收通过。未运行真实 Electron、Linux／Node 22、06／29 全文件回归或全量检查；本轮只更新本单审查与交接，保留工作区其他修订。

记录检查：`npm run check:static` 与 `git diff --check` 通过；本单另行检查了 5 个相对链接、单一状态字段、段落换行与文件末尾换行，均通过。

### 2026-10-15 方案修订

方案者按首轮审查修订，拥有者确认的范围不变。

- P1：第 2 步新增 `spawnExecPath`，`spawnArgv` 只放固定 bin 及其参数；第 3 步改为按系统错误 `code` 分类 spawn 失败，探测仍然优先。验收用一个写标记文件的包装脚本，证明实际调用的是指定的可执行文件，另外覆盖缺失、不可执行两种失败，以及另一个后台已就绪时按复用返回。
- 实测（macOS、Node v24.15.0）：detached spawn 一个不存在的路径，`error.code` 为 `ENOENT`、`exitCode` 为 -2；spawn 一个没有执行权限的文件，`error.code` 为 `EACCES`、`exitCode` 为 -13；两种情况的 `pid` 都是 `undefined`。
- 产品调用方核对的结论已写进第 1 步。03 交接提醒已写进 [03](03-desktop-skeleton.md) 的第 2 步与验收。

### 2026-10-15 第二轮方案审查

对象：`43c16ac` 上的未提交修订，本单复审前 SHA-256 前缀为 `93614b816df3`；同步核对 03 的环境与启动参数交接、桌面客户端提案及当前源码。结论：方案通过，首轮 P1 在方案层解除，无新增阻断，可以交实施；本结论不代表实现验收，也不代表 03 整单审查通过。

修订覆盖了首轮缺口：`spawnExecPath` 与 `spawnArgv` 分开，默认执行路径不变；`spawn` 错误按系统 `code` 分类，先探测再报告失败；带执行标记的包装脚本能够区分是否真正使用新参数。路径函数、聚合入口与待确认记录的调用范围已明确，03 已接收登录 shell 环境必须同时用于路径、令牌与子进程的要求。实例锁竞争的退出码分支与 `spawn` 错误事件分支不同，新增失败处理不需要改变锁败者等待胜者的规则。

实施交接（现有验收的具体断言）：并发复用用例必须先实际触发本次 `spawn` 的 `error`，再让随后的控制面探测成功，并断言完整结果为 `{ ok: true, spawned: false }`。如果用例一开始就有在线后台，函数会在首次探测直接返回，覆盖不到新增失败分支；生产代码目前循环中的成功返回只看 `lostLockRace`，实施时也要让 `spawn` 失败归为复用。此项是落实方案第 3 步所称的「按复用返回」，不新增产品要求。

本轮证据：macOS、Node v24.15.0。独立执行包装脚本对照：向当前未改动的 `ensureBackend` 传入 `spawnExecPath` 后，真实后台可以握手，但标记文件不存在，证明拟定标记断言能捕获忽略新参数的回归；直接用 `spawn(包装脚本, 同一固定 bin 参数)` 启动后，标记与认证握手均通过，包装脚本路径含空格。两次后台均已停止，临时目录已清理；后台为真实 bin／socket／SQLite，模型打桩。另独立核实缺失文件产生 `ENOENT`、退出码 -2，无执行权限产生 `EACCES`、退出码 -13，两者均无子进程 PID。上述正例验证启动方式的可行性，未替代待实现的 `ensureBackend` 集成验收。

`npx tsx --test --test-name-pattern='并发拉起中败于实例锁的一侧' test/72-on-demand-backend.test.ts` 为 1/1 通过。相关实现与首轮相同，未重复首轮 7 项测试；未运行真实 Electron、Linux／Node 22、06／29 全文件回归或全量检查。本轮只更新本单状态与复审记录，保留其他工作区修订。

本轮记录检查：`npm run check:static` 与 `git diff --check` 通过；本单 6 个相对链接、单一状态字段、段落换行与文件末尾换行另行检查通过。

### 2026-10-15 独立实现审查与工程验收

对象：`b4ac27d` 上本单 7 个未提交改动文件，对照现行工单、规格 R7、相关决定、调用方与实际代码；审查者使用独立执行上下文，只读主工作区。结论：实现验收通过，无剩余阻断或非阻断意见；本单标为 resolved，不代表桌面端其他工单或整体 R7 已交付，不授予提交、合并或发布权限。

审查核实三个路径函数的显式产品与缺省调用、外部 Node 与固定 bin 参数分离、按系统 code 分类、探测优先、复用归属、实例锁与日志分支，以及文档事实一致。审查者亲自执行新增 7 项，全部通过；在独立临时副本恢复旧路径实现，2 项失败；恢复旧后台实现，3 项失败；将 spawn 失败后的复用结果改为 `spawned: true`，并发用例失败。临时副本均已清理。

审查中发现原并发用例不能检出将错误处理移到循环探测前的回归：首次循环探测已经开始后才等错误，顺序错误也能通过。实施者按审查建议补强为启动前两次及首次循环探测不可达，经过一次 poll 确保错误已经到达，下一轮探测才连接真实后台，并要求至少四次连接。审查者在临时副本确认修订后的当前实现通过、错误优先变异失败；最终主工作区执行 `npx tsx --test --test-name-pattern='实际 spawn 失败后仍先探测' test/72-on-demand-backend.test.ts` 为 1/1 通过，验收缺口已解除。生产实现未因审查修改，四文件回归其余证据仍有效。

作者在最终测试修订后重跑 `npm run check:static` 通过，审查者另执行 `git diff --check` 通过。产品验收不适用的理由沿用正文；未重跑全量、Linux／Node 22、真实 Electron 或真实模型，限制已如实保留。工单当前状态、6 个相对链接与改动文件末尾换行另行核实。
