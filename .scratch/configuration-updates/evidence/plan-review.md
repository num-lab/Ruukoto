# 配置更新方案审查

## 对象与范围

本次仅审查方案，基点为 991820a74304aa4d017a99bad70338adb8087fc0。对象为[规格](../spec.md)、[实施工单](../issues/01-remove-global-restrictions.md)和[决策提案](../../../.agents/notes/proposed/architecture/2026-10-25-operation-scoped-configuration.md)。工作区只新增方案资料，并给 16 篇相关旧笔记增加提案链接；旧实现约束未被写成已解除。

## 独立方案审查

2026-10-25，独立上下文 configuration_plan_review 直接读取需求范围、三个核心文件、相关源码和已安装 SDK。结论：方案审查通过，无未解决阻断；不代表实现或产品验收通过。

| 审查发现 | 最终方案修订 |
| --- | --- |
| SDK generation 只固定 provider/modelId，按同名覆盖 provider 会误路由旧请求 | 每配置版本使用不可复用 provider ID；先注册再更新 AgentDoc，冷恢复先恢复旧 provider，最后释放旧引用 |
| 首次配置无根会话，不能直接向 ROOT_CONVERSATION_ID 写 entry | 复用公共 createSession 与 session-scoped 设置文档；初始格式与无根初始化证明同事务保存 |
| MCP A 待生效时 B 保存会改变整文件，可能使 A 无法核实或被提前发布 | 文件保存未知时封闭该文件；已证明保存后按服务独立生效，沿完整后继保存链核实 |
| Storage 错误会关闭 Session，不能保证所有故障都只影响单一目标 | 区分对象发布/应答故障与共享存储失效，后者保留实例停止与重开恢复 |
| 迁移写新记录后崩溃，旧格式标记仍可能让旧程序打开档案 | 先持久发布旧程序拒绝的迁移中标记，再事务迁移，最后完成标记 |
| 旧 MCP 历史只在启动追加，无法证明离线修改后改回没有实质变化 | 每次保存记录版本链；连续展示变更兼容移到该基础完成后的阶段 4 |

审查者亲验两项只内存断言，均通过：MemoryStorage + createSession 可在无根会话时写 session 文档，向不存在的根追加 entry 会拒绝；openNodeSqliteStorage(":memory:") + createSession 可同事务初始化格式与设置操作 family，ROOT_CONVERSATION_ID 仍不存在。未写文件、未启动服务、未访问网络。

审查者还核对旧请求/审批、定时范围、命令/helper 配置归属、秘密引用和旧 maintenance 回执兼容。没有未决定的关键目标或需拥有者再拍板的范围；实施阶段仍需用故障注入和真实环境证明方案。

## 文件指纹

| 文件 | SHA-256 |
| --- | --- |
| spec.md | 055ce556ec43643cb0e9a64a9732572853bddc9962f0b625434c37b96473f3c6 |
| 决策提案 | 744d654cbae30b1da9ef0ef2517b3c3a5d7214d8829ec3685815f3cece9a2892 |
| 工单审查时 | 6ef39ad4fa4cb1c48228d4c8758047be1deb61741ec60590ac367d2e6e6781be |
| 工单交付时 | e0e331589fa3497cdbe940330ed9b251cdf237721ca3e5206978f5bdfa15c024 |
| 工单提交时 | 3042f176f645708fe0bf5ad6783c713439a24bf315c51f9f6ca9cc2e7894dced |

审查通过后仅将工单标为 ready-for-agent、同步当前角色/验收结论并追加审查记录；规格、阶段、文件范围与验收内容不变。上述两份工单指纹明确区分已审实施内容与交付状态同步。任何后续实质变化均需复审受影响部分。

拥有者随后明确要求提交，工单仅同步提交授权与入库交接状态。独立审查者再次核对规格/提案指纹一致、16 篇旧笔记只加互链且无运行代码改动；本次没有技术方案变更，不重做已完成的方案审查。

## 文档检查

方案者实际运行 npm run check:static，通过 lint、全工作区/基础验证包 typecheck、verify-notes、check:docs；212 篇笔记结构与链接通过，271 份受检 Markdown 的链接/锚点/换行及常驻预算通过。git diff --check 通过。

常规 Markdown 门禁不扫描 .scratch，另用仓库 markdown-scan 的解析器对三份工单/规格/审查文件执行链接、锚点、单段单行和唯一末尾换行断言，通过。

工程与产品行为均未实施、未验收。未运行全量 npm run check、应用行为回归或真实 Linux、模型、IM、Electron/MyGo；这些验证按工单阶段执行，不能把本轮静态通过记为在线更新已经可用。
