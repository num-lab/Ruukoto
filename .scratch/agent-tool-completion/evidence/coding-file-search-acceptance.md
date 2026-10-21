# Coding 文件检索实施与验收

## 对象与范围

拥有者2026-10-21要求接手[工单01](../issues/01-coding-file-search.md)，授权实施已审方案中的 Coding 文件检索。交付 list_files/search_files、worker 内真实 rg、范围与停止、原字节产物、工具装配、执行前提和文档；不实施个人 durable、结构化提问或后台执行，不提交、合并或部署。

共享参数、schema、argv 和解码位于 packages/agent/src/file-search.ts，实际扫描位于 tool-worker/file-search.ts；既有 exports 通配可覆盖，无新增包入口。普通、Plan、只读/写入 SubAgent、宿主固定评审及原工作流入口同步，旧显式角色快照不自动扩大。宿主固定评审定义摘要变化后，旧固定评审按现有校验明确拒绝，需重新发起；未迁移或改写旧记录。

## 工程检查

环境为 macOS arm64、Node 24.15.0、rg 15.2.0；执行 npm run setup 安装两份锁文件依赖并接入原钩子，执行 npm run build:native、npm run build:worker、npm run build:script 准备真实制品。check:static 完整通过；不跑全仓 check。

| 实际执行 | 结果与覆盖 |
| --- | --- |
| npx tsx --test test/07-real-tools.test.ts test/file-search.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts | 36通过、1仅Linux路径用例跳过；真实工具闭环、完整与partial产物、过滤/边界/预算、工具装配与账本 |
| npx tsx --test --test-name-pattern='主动取消' test/file-search.test.ts | 后增取消用例1通过；等待真实检索组停止、保留部分计数；运行代码及旧用例未变 |
| npx tsx --test test/111-workflow-capabilities.test.ts test/113-workflow-source-capabilities.test.ts test/workflow-role-integration.test.ts | 34通过；默认继承、显式角色限制、来源、撤销、原生 reviewer 与 verify |
| npx tsx --test --test-name-pattern='ruukoto-code.*reviewer\|general 与 full_access' test/workflow-role-integration.test.ts | 原生原字节补修后定向2通过，复核来源保护与验证能力 |
| npx tsx --test test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/native-linux-identity.test.ts | 32通过；原生依赖、硬链接/别名、只读覆盖和既有Linux身份/停止契约 |
| test/45-github-events.test.ts、46-github-recovery.test.ts、58-plan-mode.test.ts、98-development-tools.test.ts、subagent-role-library.test.ts | 实际按文件名加入首批定向命令，均通过；固定评审名单、Plan实际请求、rg环境前提和角色目录 |
| git diff --check；npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts | 通过；无悬空锚点，旧无代码锚点提示未扩大处理 |

首次工作流批次因新工作副本缺 build:script 制品失败，构建后同三文件34项通过。实施中旧白名单、空结果夹具断言与原生越界拒绝码的失败均已修复并复验；partial产物用例也改为只计检索产物，不把模型请求快照混入。上述失败不记为通过。

## 平台与边界

macOS 的真实原生 worker 用例证明只读来源可搜索且OS拒写，显式 glob 不扩大范围，链接及目录替换被拒。Linux 在 ssh tx 的独立 /tmp 检出运行，预先把系统发行包 rg 14.1.0 解包为临时工具链；没有改系统安装或服务器既有项目，没有把下载接进应用。Node 24.21.0、bubblewrap 与 user systemd scope 的真实执行通过。

Linux 搜索与101原生测试11通过、1仅macOS用例跳过；独立原生探针7组通过且停止核实为true，覆盖列→搜→读、过滤、权限、保护来源、非法UTF-8及目录替换。新增取消用例另增量1通过。完整环境、命令、日志和对应SHA见[平台汇总](coding-file-search-linux/encoding-final-summary.json)与[取消增量](coding-file-search-linux/cancel-summary.json)。两份汇总分别保留增量前后的测试SHA，运行代码相同。

Linux 负例发现原生别名预检默认UTF-8枚举会在搜索前误查替换字符路径。现改为 Buffer 原字节枚举、身份和范围比较；macOS 的硬链接、只读/APFS别名用例及Linux真实非法UTF-8编码失败已分别复验。根本问题及额外读取代价见[决策笔记](../../../.agents/notes/implemented/feature/2026-10-21-controlled-file-search.md)。

## 实际模型与接口验收

macOS confirm/native，实际模型 magpie/workbuddy-ai/deepseek-v4.1-flash 完成 list_files→search_files→read，正确报告 docs/target.txt、第2行命中及仅第5行读取后才可知的随机验证值；默认隐藏、ignored与二进制诱饵未列出。4份实际请求、原工具结果、JSONL与选择记录见[模型汇总](coding-file-search-model/summary.json)及其同目录after/baseline证据，不包含模型认证配置。

同模型、同输入、独立空会话的实际请求对比：toolSchemas 9383→10493（+1110），systemPrompt 1503→1503。基线使用当前代码仅过滤两个新工具，非旧提交运行。模型验收之后只调整越界路径拒绝顺序、原生原字节预检、注释和检查；schema与正常工具结果未变，模型原快照及原worker SHA仍原样保留，不冒充最终制品快照。

产品验收在工具接口层通过：实际模型能依据路径和行号继续读取，定向测试证明 limit/长行/整体预览裁剪后仍能读取完整证据，退出2/预算/取消明确标部分而非全部命中；没有新增客户端主观交互或待决定产品取舍。个人端及其他切片不在本次验收中。

## 独立实现审查

独立上下文 implementation_review 直接读取工单、规格、实际diff、测试与文档，审查参数/argv、过滤、预算、原始证据、范围、取消停止和工具装配。亲跑搜索、原生、显式reviewer/default verify，并以临时真实worker主动取消作补充；越界拒绝顺序问题修复后无阻断。后续原生 Buffer 补修独立复核，101五项及原生搜索通过，另用临时探针核实中文路径、相邻前缀、同权限/漏授权硬链接与重复文件根，无新增阻断。

Linux由独立上下文search_scope实跑，真实模型由platform_probe实跑；两者分别提供原始证据，不将作者自检当作独立审查。工程验收通过，相关代码与文档无未解决阻断。

## 未覆盖与交付限制

没有运行全仓 check、CI完整平台/Node矩阵、个人 durable或其他切片；没有提交、合并、部署或改现有档案。大目录仍受10秒/8 MiB预算，二进制候选完整检查会增加读取成本；只读工具不提供跨调用快照，后续read仍重新核实对象。
