# 工单 29 独立终审

审查者：`/root/search_transport`，独立于通用工具、配置、来源、产物、IO 和入口接线的实现上下文。该审查者曾实现 Tavily transport，因此本文不把 transport 实现或其脱敏测试计作独立通过；该叶模块由另一上下文核实。

审查基点为 `93eac52`，在隔离 worktree `/tmp/ruukoto-29-search` 同步根最新运行源码与测试。审查只读根目录，反例修改只发生在隔离副本且均已恢复。最终 28 份受影响运行源码和测试与根目录逐字节相同，详见 [源码 SHA-256](source-hashes.json)。根后续的 Linux、静态检查和真实产品验收另由工单持有。

## 结论

当前主实现没有本次独立终审尚未解决的阻断。按当前源码，原生工具接纳、审批消费、自动审查、原字节引用、开始后不重放，以及未知 HTTP 对工作、子身份和报告的暂停与恢复均有实际证据。此结论不代替真实 Linux、模型、IM 或操作者验收，也不授予提交、发布或生产切换权限。

## 检查与证据

| 对象 | 命令或入口 | 实际结果 |
| --- | --- | --- |
| 主子工具、自动审查成功/拒绝/非法/失败/length/error、资料授权、产物损坏、SIGKILL、权限快照、HTTP/MCP 占用、配置写盘失败重试 | `RUUKOTO_TOOLS_EVIDENCE=.scratch/personal-pi-durable/evidence/29-macos/independent-review/model-requests npx tsx --test test/personal-tools.test.ts test/personal-tools-config.test.ts` | [初轮日志](core-and-config.log)：12 项 core 和 3 项 config，共 15/15；100.81 秒；无跳过。 |
| SDK 数字文本标准化恢复、SDK 拒绝意图计额度、搜索普通视图与原 JSON 分工、审查请求证据缺失/损坏 | 下方新增用例命令 | [最终新增用例日志](latest-added-core.log)：4/4；26.43 秒；无跳过。 |
| 普通文件修改、二进制引用读取和导出、关闭重开 | `node --import tsx --input-type=module < .scratch/personal-pi-durable/evidence/29-macos/independent-review/scenarios/harness.mjs` | [日志](harness.log)：原文和产物一致；重开保留 2 项操作、1 份产物。 |
| native SDK 把 `content: 123` 转成 `"123"` 后执行并恢复 | 同上，脚本换为 `scenarios/coercion.mjs` | [日志](coercion.log)：写入、读取、`read_artifact`、导出、重开均通过。 |
| 自动审查请求和取消 | 同上，脚本换为 `scenarios/auto-review.mjs` | [日志](auto-review.log)：一次无工具审查；claim、payload 和结论可恢复；另一审查已发出后取消，未写审查结论且没有开始文件读取。 |
| 未知 HTTP、取消、子占用、重启和报告恢复 | 同上，脚本换为 `scenarios/unknown-recovery.mjs` | [日志](unknown-recovery.log)：远端只收到 1 次 POST；业务效果核实不能单独释放占用；独立核实结束后取消工作释放，原报告恢复为 `local/completed`。 |
| 截短后的失败分类 | `npx tsx --test --test-name-pattern='截短已开始后异常' test/personal-tool-io.test.ts` | [恢复修复后的日志](regression-truncate-restored.log)：1/1。 |
| 文件写后强杀的恢复事实 | `npx tsx --test --test-name-pattern='durable 文件写入：写后强杀' test/personal-tools.test.ts` | [新增强杀日志](file-write-kill-recovery.log)：1/1；1.96 秒；文件实际已写，观察提交前 SIGKILL，恢复为 `effect_unknown/stopped=true`，不覆盖拥有者后续内容，核实效果后原来源恢复。 |
| 真实本机认证管理路由 | `npx tsx --test --test-name-pattern='durable 本机入口：真实认证接口' test/personal-tools.test.ts` | [本机接口日志](local-control-real-routes.log)：1/1；5.26 秒；实际后台与认证客户端完成 pending→批准、产物读取和独占导出、资料授权及撤销。 |

本机路由用例的首轮夹具误用了 `POST /input`，触发既有 `control_route_missing`；改成既有 `POST /inputs` 后重跑通过，没有修改运行源码。[夹具首轮日志](local-control-initial-fixture.log)保留该次失败，不计作通过。

新增用例命令：`npx tsx --test --test-name-pattern='SDK转换|SDK失败|审查证据' test/personal-tools.test.ts`。

两次 core 执行期间测试文件增加了四项末尾用例，并把用例时间预算调整为 60 秒；已通过的前十二项主体与运行源码未变。因此前两行覆盖原 16 项 core 加 3 项 config 的 19 个不同用例；随后追加文件写后强杀的第 17 项 core、真实本机路由的第 18 项 core，均单独实跑通过；截短分支另增 1 项，合计 22 个不同的仓库用例。四个场景是附加流程复核，不折算为用例数量。[model-requests](model-requests/) 保存首轮测试生成的模拟模型原请求，未使用真实模型凭据或真实用户会话。

## 有效回归反证

两项反证均实际执行，失败后恢复原源码并以同一命令重新通过；没有把预期失败写成通过。[标准化结果](regression-result.json)和[截短结果](regression-truncate-result.json)记录命令、退出码，以及修改前、负例状态、恢复后的 SHA-256。

- 标准化：[负例补丁](regression-standardization.patch)仅把恢复时的标准化参数比较改回原始 assistant 参数比较。`SDK转换后的数字文本` 用例在写入 `"123"` 后重开失败，退出码为 1，错误为 `tool_record_invalid`，见[失败日志](regression-unfixed.log)。恢复补丁后同一用例退出码为 0，见[通过日志](regression-restored.log)。
- 截短：[负例补丁](regression-truncate.patch)仅把 `writing = true` 移回 `ftruncateSync` 返回后。用例真实截短后抛错，旧位置使 `effectUnknown` 为 `undefined`，断言失败并退出 1，见[原始失败日志（gzip）](regression-truncate-unfixed.log.gz)。恢复到截短前标记后同一用例退出 0，见[通过日志](regression-truncate-restored.log)。

补丁只用于隔离副本中的反证。复现时先应用对应负例补丁，运行各结果 JSON 中的命令，随后反向应用补丁并再次运行；两项补丁不可作为生产修复应用。

## 已修阻断复核

| 已发现的问题 | 现在的行为与依据 |
| --- | --- |
| 通用文件成功码与工具成功判别不一致 | `file_returned` 沿正常成功路径返回；主子读写与场景日志已通过。 |
| 提交后继续读取 durable transaction proxy，导致产物读/导出和重开失败 | 跨提交返回完整 plain JSON；产物、导出及重开已分别实跑。 |
| native SDK 参数转换后，恢复仍与原始参数直接比较 | 按同一工具 schema 复制并标准化原参数后核对；有效回归反证已完成。 |
| 自动审查接受错误或未完整结束的回复，实际 payload 缺少强引用 | 仅接受正常结束；输入、payload 引用和观察顺序均核对，缺失或损坏会拒绝恢复；六种结果与两个损坏用例通过。 |
| 自动审查取消后可能落迟到结论 | 取消前的 claim/payload 保留，取消不落 decision/observation；独立场景已实跑。 |
| 撤销后待审批无法结束，批准消费未复核配置和授权 | 未开始的原调用失效并可唤醒，消费前复核；确认/授权/撤销用例通过。 |
| 只在执行函数计搜索次数，漏掉 native schema 拒绝意图 | 从原生 `pi.tool` 和原 assistant 调用核算；五次非法后第六次合法仍拒绝，外调数为 0。 |
| HTTP 与 MCP 可换工具绕过原来源或端点暂停 | 主子消费检查共享来源，HTTP/MCP 交叉检查端点；仓库窄测与独立未知恢复场景均通过。 |
| terminal 工具仍待核实时可改配置，固定 tmp 文件又使保存失败后无法重试 | 保存前扫描未核实原操作，核实私有 tmp 后安全重试；配置失败前后两种情况均通过。 |
| 已实际截短后抛错仍可报告未执行 | 在截短前记录写入开始；有效回归反证已完成。 |
| 文件恢复与 HTTP 恢复的结束事实可能混同 | 文件同步写入后强杀恢复为 `effect_unknown/stopped=true`；HTTP 仍须独立核实远端结束。新增真实强杀用例验证文件不重写、保留拥有者后改内容，业务核实后解除原来源暂停。 |
| 新建文件祖先替换、HTTP 编码秘密及截界前缀泄漏、短写 | 已交 IO 叶模块修复；本文复核调用位置与 Linux 目录句柄拒绝回退的实现，不把其他上下文的 Linux/IO 实跑计作自己的独立验收。 |

## 未覆盖项

本报告在 macOS / Node 24.15.0 上执行；新建文件依赖 Linux 的已核实父目录句柄，macOS 明确拒绝新建，本文没有把覆盖现有文件的成功当作 Linux 新建或隔离通过。真实 Linux 目录竞态、执行隔离及 Linux 新增截短分支由主工单另存证据。

没有调用真实模型、真实 Tavily 或真实 Telegram/IM，也没有进行拥有者主观交互验收。本报告使用本地模拟模型与回环 HTTP，验证的是宿主数据、请求、取消及恢复流程。没有重复全仓 `npm run check`；最终静态和调用方回归由主工单持有。
