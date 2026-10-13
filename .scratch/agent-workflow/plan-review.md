# 工作流独立方案审查

审查者为独立上下文 `workflow_plan_review`，日期 2026-10-12，代码基点 `d1b1b543c3ad6063331bbe1bf6328396392f38e4`。本文件记录审查与证据，不属于自身内容指纹范围；源码与其他 code-desktop 任务不属于本任务改动。

## 首轮结论与修订

首轮审查发现两项 P2 方案阻断，均可在已确认授权范围内修正，不阻断隔离候选实验本身。

| 问题 | 依据 | 方案修订 |
| --- | --- | --- |
| 原发起任务结束后，工作副本创建与汇总缺少真实执行归属 | Runtime.executeWorkCopy 要求活动父任务及其 Driver；删除核实会丢失 worker、操作账本和占用归属 | 运行派生短期宿主操作任务，真实持有执行和停止事实，保留普通 Driver 路径；03/04 增加父任务结束与停止未核实的验收 |
| 验证未绑定最终汇入的实际字节 | work-copy 汇总时重新取完整差异，普通工作又可以继续委派修改 | 宿主冻结补丁、摘要与基线，独立验证绑定同一成果；汇总重核当前版本并套用冻结补丁；检查在独立验证副本/临时区落盘，04 增加验证后变化负例 |

首轮被审范围为工单 01–07、规格、实施计划、Claude Code 调研、脚本运行候选以及工作流 proposed 笔记，共十二份文件。按路径排序后，将每项 `SHA-256`、两个空格、路径和换行拼接，再求 SHA-256，整体摘要为 `1e3c77406c22ab7b70b5e07a23f3afd87b84edd81def66b3734e304af0b6a05d`。上述修订使首轮对相关内容的判断失效，需下述复核结论。

## 范围确认

首版将批量代码修改限定为 Git 工作区是新增范围提议，Q11 原始确认没有该限制。审查者要求在最终共同理解中明确交拥有者决定；拥有者于 2026-10-13 对包含该范围及完整计划的 Q12 回复「接受」，现已记为规格 A12。非 Git 分析及其他业务工具保持适用。

## 复核

同一独立审查上下文已完成复核：两项 P2 均解除，受影响内容没有新的方案阻断。短期宿主操作任务的真实执行归属与停止核实、验证所绑定的冻结成果及汇总再核实均已覆盖，03/04 的实施步骤与负例同步。

2026-10-12 复核时，Git 工作区要求仍是待拥有者确认的范围提议；2026-10-13 已确认，02 可以进入实验，03 及之后仍以隔离实验实际通过为前置。方案审查不能替代实验。

修订后十二份文件清单如下；采用与首轮相同算法，整体摘要为 `5998edcbbca886ef07158cdbe3233dd04ce8d27952bc1efcdc9d4a9c51bc5421`。本文件只记录证据，不参与自身指纹。

```text
7518f700598045047546609662403ca074eee0a3d3e889de388c51b0f5f7f65e  .agents/notes/implemented/feature/2026-10-12-agent-workflows.md
98fbcc5e7d3ba3e6a55c08bc9a94390d39349b38750b435f4d18c8cea4cae4c8  .scratch/agent-workflow/claude-code-research.md
73233be66b6e779d3f4ebc6cc74682fffe01315dffe9bac8d3a0543ec53c8d3a  .scratch/agent-workflow/implementation-plan.md
c6c708b4dd02661c722ebae0fb27b232a7cb3373f58cce300096bc1be457bdfe  .scratch/agent-workflow/issues/01-workflow-design.md
d6ce04df3014081b4810379ada684ad52dd5e93207ce22e7a3d62b5d6e1f6c39  .scratch/agent-workflow/issues/02-script-isolation.md
2ae4c991b38dad83e8f190be25af522cd54f33f99fc2ffe24c38719b47da3be2  .scratch/agent-workflow/issues/03-runtime-and-store.md
7c4fa3cd0c70dc82a029014e36473d3e30cd3a8bfe57d71f85522de7682472f3  .scratch/agent-workflow/issues/04-step-capabilities.md
6ade6d572253c10b9b3633645430dbfc5d93d55d4046ff373de3fe039ad19cb5  .scratch/agent-workflow/issues/05-owner-input-and-delivery.md
9c73b15a015a95f6ecf21a8581acdf374654abe987672ca86bad7fb09212f782  .scratch/agent-workflow/issues/06-library-and-ui.md
4a7848d2c8280419502bcc178dbddba47af5849d270289631c42a91569cb4845  .scratch/agent-workflow/issues/07-acceptance.md
c9c1282326ebe1d2a6d5b2303f8ffeea8e8f8555bdf91011bf22247b5b99e985  .scratch/agent-workflow/script-runtime-research.md
21c1c91a86fbe712d38173efe60691b7c1b61ae988951af0d3ea3bbfbe9447ea  .scratch/agent-workflow/spec.md
```

## 验证范围

首轮审查者亲自运行 `npm run verify-notes`、`npm run check:docs`，均通过；另用仓库 Markdown AST 检查本任务十二份文件的相对链接、锚点、跨行段落、空白与唯一末尾换行，零问题。后续复核只重查受影响内容。

复核时审查者再次运行上述两项命令，并检查含当时审查记录在内的十三份 Markdown，均通过。方案者另核对十三份资料的本地链接、空白与末尾换行，以及计划引用的二十八个既有测试入口确实存在。回填本次审查结论只修改本证据文件，不改变上述十二份被审内容。

未实施产品代码，未运行应用测试、解释器四格实验、真实 worker、模型或 IM。方案审查不能替代这些实施与外部验收证据。

## 最终确认回填

2026-10-13 回填 Q12，规格增加 A12、计划与决定将 Git 范围写为已确认，01 的方案交付完成，02 可接手；04/07 同步范围与验收引用。同一独立审查者轻量复核通过，无阻断：没有新增技术契约，当前正文没有遗留待确认事项，03–07 仍保留前置依赖；历史 Comments 与旧指纹保留。

审查者亲跑 `npm run verify-notes`、`npm run check:docs`，并补检十三份 Markdown 的链接、锚点、段落、空白和唯一末尾换行，均通过。方案者也执行两项门禁和本地链接/空白检查。十二份被审文件仍排除本审查记录，按既定算法的新整体 SHA-256 为 `2a86b8bcbf25ca1bb2ed48cfea2f2abae77c03443a4492fdf0436a84f67833b3`；先前指纹仅代表当时内容，不覆盖本次回填。

本轮只验证确认回填；没有运行应用测试或外部实验，功能仍未实现。
