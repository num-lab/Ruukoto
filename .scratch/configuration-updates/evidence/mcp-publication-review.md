# MCP 按服务发布的独立审查

## 对象与发现

审查上下文 execution_migrations 独立读取原实现 personal-mcp.ts（SHA-256 d815d294c855dfef5003f64a14139cdfd9112d875e4b4b7a484a91e0443d2794）、规格的 MCP 服务隔离要求与 SDK 提交顺序。本记录只覆盖该模块发布竞态，不作为命令/服务迁移的独立验收，也不代表整个运行时切片通过。

原 update 在 await commit 之前从闭包 config 合成完整候选；两个服务可同时从旧对象合成，后提交的一项覆盖先提交的其他服务，而两项持久选择都已发布。真实 SDK MemoryStorage/Harness 的受控交错复现：A 提交等待时发起 B，原实现最终实际标签为 [a,b-new]，A 新标签丢失。

另一个恢复路径是 A 发布、B 发布后再核实 A 原版本。实际 A 已是候选，但重新给全局配置使用 A 的 generation 会触发 mcp_generation_reused，不能完成原回执。

## 修正与验证

模块只串行“读取实际 config、合成指定服务、提交选择、替换内存对象”这一短段；CUA 检查、停止及连接关闭不占该队列。相同服务配置已实际存在时只核实该 scope 的选择，保留其他服务的全局 generation。原存储失败仍向调用方传播，finally 释放短队列，不吞掉失败或重发业务。

新增 test/personal-mcp-publication.test.ts，使用真实 SDK MemoryStorage/Harness 阻挡第一次配置提交、交错第二个服务，并核对内存配置、模块配置文档、两个 scope 的选择及原版本再次核实。修复后通过；撤去修复运行同一用例，在丢失 A 标签的断言失败。保留短串行而撤去重复发布保护时，用例在再次核实 A 处以 mcp_generation_reused 失败。所改模块与新用例 ESLint 通过。

这是修正作者对回归的自检；最终补丁的独立实现验收由主工单另行记录。未执行真实 MCP、CUA 或模型请求，不将内存交错用例作为外部环境验收。
