# 分析委托独立实现审查

审查对象：基点 `dcf094a` 后未提交的个人分析委托切片，工单 13、共享规格、AGENTS/development-workflow/error-handling/agent-facing-text/prose-standard 规则及直接调用方。审查上下文 `delegation_implementation_review`，主工作区只读。结论：返工后无未解决实现阻断；不代表完整迁移或外部产品验收通过。

## 核对范围

直接读取 personal-delegation、work、work-tools、work-controls、Harness、控制面、CLI、Telegram 收件/菜单与文档；按函数名检索全部调用方。核对同轮归组、跨轮固定权限/入口/本次说明来源、取消不可撤回与占用释放、全部成员未知效果传播、恢复双向关系与版本、历史单项隔离，以及本机/TG菜单零模型控制。沿实际 provider 两次记录边界检查子请求拦截。

## 发现与返工

首次独立故障探针发现：跨轮显式续派的 instructionSource 可以被替换为任意存在的同入口旧输入，恢复只检查 pi.user 存在及 entry 先后，未核实真实当次说明；原探针以 Missing expected rejection 失败。实施者新增同事务不可改写的 ruukoto.analysis-admission，绑定成员、委托、原来源/权限/入口、本次说明和模型调用；组内追加也保存原接纳证据。恢复逐字段核对，并检查 assistant.byTaskId 与调用 owner。

原探针及组内追加的同类独立反例现均拒绝恢复，零新模型请求。隔离副本只撤掉这两处接纳记录比对，两个反例重新以 Missing expected rejection 失败；见 admission-mutation.diff/log，说明用例确能捕获此回归。

## 亲跑证据

- 最新 personal-delegations、personal-work-notes、personal-work-tools、personal-work-controls 窄集：69/69，零失败、零跳过；覆盖同轮/跨轮、登记与取消两种事务顺序、HTTP 前零子请求、强杀恢复、有效旧输入错绑、文档新版本及既有单项行为。
- 服务用例的分析委托分组：3/3，确认终态成员的续派说明或追加来源效果未知也暂停整组的新成员/追加/子请求；取消、其他分析与主聊天继续。
- 独立探针中的四项：续派来源错绑、组内追加来源错绑、9 个成员与 9 份委托的双层分页、dcf094a 原源码读取新档案以 extension_missing 拒绝且零模型。旧源码依赖复用当前根与 apps/ruukoto 各自安装的依赖，未改部署。
- 第五项本地 HTTP 实收模型请求：核完整 background_work 描述/schema 含新动作、原入口/暂停/空闲非完成与无汇总语义，子会话空工具；完整 HTTP 请求与 durable ruukoto.model-request.payload 深等。完整请求保存 actual-model-input.json，使用测试凭据。

最终独立探针合跑 5/5，服务组重跑 3/3；见 independent-probes.log、service-group.log。source-manifest 在最终检查时未变化。summary.json 记录命令与结果，source-manifest.json 记录复审源文件哈希。probe.test.ts 为临时审查探针，带当前工作区绝对 imports；复现时替换为待审工作区。旧版本探针还需导出 dcf094a 的 apps/ruukoto/src 到 ./old，并复用其根及 app 依赖；突变试验位于独立 mutation 副本。

## 未覆盖

未独立重跑全量静态/构建、Linux、Coding 全套、真实模型、真实 Telegram 或人工产品体验；根上下文承担已安排的静态/构建、personal 全回归和跨平台证据。没有声称最终汇总、原入口最终外发、外部工具归属、QQ 或正式切换已完成。模型快照限无服务配置的主会话与空工具子会话；服务启用装配以根上下文快照为准。
