# Cua 新方案审查

日期2026-10-23，代码基线 `14ee3d007bac3bb99cf104ad55c8aeccb7aa50a4`。拥有者明确撤销跨产品桌面独占并要求回滚；旧审查结论只对外部归档中的旧方案有效。

## 对象与结论

独立执行上下文 `/root/cua_replan_review` 只读核对现行规格、调查、01–05、决定及必要基线调用方，结论通过，无剩余阻断。[独立报告](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/replan-review/REPORT.md)与[文件指纹](/Users/eitrous/Developer/ruukoto-backups/cua-before-rollback-20261023-130957/replan-review/scope.sha256)保存在仓库外。指纹覆盖最终被审契约、工单和决定，排除此审查索引，避免自引用；状态/交接在通过后按审查建议更新。

唯一发现的遗漏是Personal HTTP互锁对MCP endpoint的假设；03已补personal-tools.ts与personal-mcp.ts的传输分支及窄回归，审查者复核通过。现有64项工具上限足够，不新增全局独占或全量测试要求。

## 实际检查

- 作者：完整备份逐项哈希/链接校验、Git bundle verify、回滚前内容未变检查、回滚后干净工作区确认；见[备份索引](archive.md)。
- 作者：npm run check:static通过（lint、全部typecheck、verify-notes、check:docs）；本任务本地文档链接与单一末尾换行检查通过；git diff --check通过。
- 独立审查：官方资料与基线调用方核对，四份相关归档文件SHA抽核；没有重新计算整个备份。
- 产品代码、测试、依赖、deploy及docs与14ee3d00一致；当前只新增或修改规划材料和笔记互链。

01资料任务已resolved；02/03可按范围实施，04/05等待对应前置。没有运行新的Cua、GUI、真实模型或远端实验，当前通过不代表正式产品已实现。未提交或推送本轮规划；后续实施者从01入口读取本规格，不从归档继续旧探针。
