# MCP 共享传输本机验收

macOS / Node 24.15.0，基点 9243e63。真实 SDK 与回环 HTTP 替身验证共享传输；没有连接真实 MCP 服务，不将这些材料作为 Linux 执行、远端停止、模型或 IM 证据。

- tests-final.log：新传输、旧 24-mcp、25-mcp-write 与 71-product-entry 四文件最终 75/75，无跳过。transport-pagination-final.log 是其中新传输 16/16，不重复计数。
- tests.log 与 transport-final.log：分页修复前的 72/72 及新接口 13/13，作为中间过程保留，不累计到最终用例数。
- build-final.log、static-final.log 和 docs-final.log：最终构建、静态与文案收窄后的文档检查通过。build.log/static.log 是分页前相同入口检查；static-initial-failure.log 保留初次测试使用 ES2024 withResolvers 导致的类型失败，改用本地 deferred 后通过，未修改编译目标或依赖。
- independent-review/：独立审查者亲跑分页前最终新传输 13/13、McpError 原对象及零外调探针；撤空 token guard 的两项与撤普通异常分类的两项均预期失败。分页探针确认当前和旧 HEAD 都接受 17 页，证明该缺口是继承问题。
- independent-pagination/：补充方案复核后亲跑 16/17 页与 65 工具三项 3/3；独立副本仅撤 SDK listMaxPages 后，17 页拒绝用例预期失败。两处文档已收窄，不把 SDK 重复游标结束规则说成完整性保证；最终审查无未解决阻断。

source-manifest.json/source-tested.tar.gz 固定最终 7 个实施、测试及说明文件；source-manifest-before-pagination.json/source-before-pagination.tar.gz 固定分页前内容。独立 manifest 的三源哈希分别与对应快照/当前内容相符；material-verification.json 持有日志核对结果。reproduction.tar.gz 包含各独立隔离副本、探针与原始日志，依赖软链不入归档；复跑需将 node_modules 接到相同锁定依赖。展示日志规范终尾换行，两份负例日志另清理空白行尾空格以满足提交门禁，原始字节仍在归档中，校验记录同时保存规范前后长度与哈希，测试结果不变。change-scope.json 是基点到本轮工作区的范围导航，不作行为证据。

独立终审结论：纯传输不加载旧 Db/Pi，旧接口、exports、McpError instanceof 与凭据检查保持；普通 resolver 异常和空 token 请求前拒绝；取消、关闭、超时、断线及 401 不重发。SDK 原生 16 页限额与 64 工具上限已由窄例及反证覆盖。根代理的最终组合、构建/静态日志由审查者阅读，和审查者亲跑检查分开记账。

工程验收通过；本片无新增用户入口，产品验收不适用。个人 durable MCP 原调用/响应持久化、工作占用/未知暂停、真实 MCP 与完整迁移继续待实施和验收。拥有者已授权本次提交；提交前核对 7 文件、两阶段源码归档及两组独立证据哈希均相符，实施未改，沿用已验结论。未跑全仓 check、Linux、真实模型或 IM，未推送或部署。
