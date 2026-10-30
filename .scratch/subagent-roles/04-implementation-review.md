# 工作流共享角色与接口升级独立实现审查

结论：工单 04 工程实现审查通过，无未解决阻断；联合产品、真实模型与最终 Linux 组合验收归 05。审查依据为[规格](spec.md)、[工单](issues/04-workflow-integration.md)、计划第四节、实际调用方与仓库规则，作者总结只作导航。

[生产/测试清单](evidence/04-production-inputs.sha256)固定 12 个生产文件和 28 个测试/smoke 调用文件，SHA-256 为 `5295b93d01abc7a2c9eb4b5ca3cf14f86c790caa6e77733447cd59d55098659c`。本单相对接手前源码的范围、原文归档、独立补丁、验证命令与首次失败由[工程记录](evidence/04-implementation.md)持有；不把 02/03 未提交 diff 全部算为 04，也不覆盖历史证据。

[最终输入](evidence/04-implementation-inputs.sha256)固定 77 项要求、规则、源码、实际文档/笔记与工程记录，清单 SHA-256 为 `5ce4bfcdc1348e74df2ed1efeb57293213ce5a3042e110268517ee37330f4ac8`；排除自身、审查报告及状态交接，避免循环摘要，工单状态和计划由最终交接核实。

## 独立归属

| 上下文与原记录 | 独立审查范围 | 本人作者部分的交叉覆盖 |
| --- | --- | --- |
| workflow_audit，[正文](evidence/04-workflow-review.md)、[输入](evidence/04-workflow-review-inputs.json)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-independent-review.tar.gz) | 全部 04 生产接线、core/library 版本、普通旧接口、恢复/消费/冻结/汇入、实际新测试及文档；没有编写生产实现 | 无作者生产部分；独立探针与回归判断不当作生产实现 |
| version_audit，[正文](evidence/04-delegate-runtime-review.md)、[输入](evidence/04-delegate-runtime-review-inputs.json)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-version-review.tar.gz) | root 的 workflow/runtime/ToolRouter 与普通委派作者的旧 mode 替换；亲自复现和重验可信注入执行器回归 | 本人 core/workflow、schema/protocol、workflow-library 由 workflow_audit 及 root 核实，不自授独立通过 |
| delegate_upgrade，[作者记录](evidence/04-role-test-author.md)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-delegate-author.tar.gz) | 普通旧接口迁移与九例真实 Runtime/Driver/native 测试的作者执行证据；不算本人的独立审查 | 普通委派实现由上述两审查者核实；新测试由 workflow_audit 直接读实际断言，主仓最终串行全组执行 |

生产改动均有非作者上下文读取和核实；共享文件按实际作者改动归属判断。审查者在独立副本执行，主工作区保持一个写入者。

## 阻断闭环与证据边界

零工具 passed 文本原可获得验证资格，已要求非空真实编码账本，并重验拒绝汇入。已完成步骤在恢复/结果消费时缺角色、执行或基线记录原可能漏检，现由默认严格装配在相应消费点核实，保留 Task/尝试/字节。独立探针亲自实际写入、读取后在 ask 阶段损坏记录，确认 paused 或 stale_answer，未发新模型请求。

新增消费核实曾破坏可信宿主注入 workflowAgent 的既有合同；两个非作者上下文发现并验证。修复沿原 preflight 装配边界注入验证责任，默认 Driver 仍固定安装严格回调，agent()/integrate() 直接断言保留，没有按记录缺失降级。修补前 0/2、修补后 2/2 与默认缺记录负例由原审查持有，主仓 107/109/115 最终 18/18。

新九例原夹具与旧 wait 调用已修正，105 增补非法参数、112 增补已保存 passed 后账本效果未知、普通工具增补真实 SDK 旧 mode 拒绝。最终主仓六文件串行 43/43，build、静态通过；最终提示文字重新实际量化。审查正文内的早期“最终套件待运行”只描述当时阶段，最终结果以工程记录和原日志为准。

首轮 208 项交叉集有 7 失败：5 个可信注入回归已修复并重验；另 2 个 HTTP 审批零调用断言原样单独通过，首次原因未知。作者阶段 native 停止异常与夹具失败也保留，未冒充首次全绿。版本审查者最初测试 stdout 未重定向，原始包明确保存的是实际工具响应事后摘录，并注明首次失败阶段未保存完整源码摘要；不能把摘录称为完整原始 stdout。

## 最终交接

04 为 ready-for-human，工程实现及独立审查已完成；05 为 ready-for-agent，继续真实模型、最终双平台组合及主观体验验收。未执行全仓 check、Linux 新接口、真实模型或外部平台；未提交、推送或部署。总角色决定转 implemented 只表示施工落地，不代表 05 验收完成。

最终交接再由 workflow_audit [只读核对](evidence/04-handoff-review.md)：77/77 与 40/40 逐项及摘要一致，状态、笔记生命周期、原始失败和最终量化记录准确，无未解决阻断；未改代码或重复 native。
