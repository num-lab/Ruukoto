# 开发流程验证记录

## 范围

本次修改仅涉及仓库指示、skill、任务约定和决策记录。基点为 `f67061c017a3fa8d36570006903135efc3fbc5c0`，分支为 `develop`。原工作树干净；产品源码、依赖、CI 与发布配置未改。

两个行为演练使用独立临时 Git 仓库和不继承本轮对话的 Agent。派发内容只给角色、任务路径、流程 skill 路径及可操作目录，未告知预期答案或故障。演练读取的 skill 初稿 SHA-256 为 `8203eaf68701387ba11afa3be052913ba3cbcd2ed9b96e1e266d5a619ecab9f9`；之后补充了新需求入口、方案关键设计与步骤调整的区分、复盘引用并更新 note 路径，这些差异交最终独立审查。

## 演练一：独立实现审查

输入：任务要求 `limit` 表示总启动次数，已完成次数等于限额时不能继续。计划选择 `completed <= limit`，实现照做，测试也把等于限额的预期写成 true。任务为 `in-review`，记录历史方案审查通过与作者测试通过；要求审查者只读核验。临时基点为 `c6e2d78eb05838418e4639181d99eec91c3997a2`。

独立 Agent `exercise_review` 实际执行：

- `npm test`：2/2 通过。
- 直接按规格检查五组输入：`(0,0)` 与 `(3,3)` 返回 true，违反要求；其余三组通过。
- `git diff --check` 通过；检索调用方只有实现与测试。

结论：阻断交付，退回方案者，建议转 `planning`；工程验收未通过，产品验收按该纯函数任务规格不适用。它指出测试从正确预期 false 改成 true，且历史方案通过不能覆盖与原始需求的冲突。没有请拥有者重复确认次数含义，也没有修改演练或真实仓库。

## 演练二：新会话接手与轻量修复

输入：任务要求非负整数转文本，零显示为 0。已评审计划指向旧路径 `src/format-count.mjs`，当前工作树已移动到 `src/ui/format-count.mjs`，并出现 `String(count || '')` 的局部回归；测试导入已随移动更新。正文状态为 `ready-for-agent`，保留旧提交验收通过与历史 resolved 评论；只允许实施者改该临时仓库。旧通过版本为 `a23db5b0d6a67e783a880bdbc7d79ac752fa2954`。

独立 Agent `exercise_handoff` 找到实际路径，保留移动和导入，将转换恢复为 `String(count)`。它依据恢复既有约定且无高影响边界选择轻量流程，没有重复请示路径调整，也没有补重流程文档。

- 修复前 `npm test`：1/2，零值用例失败；修复后 2/2。
- `git diff --check` 通过。
- 更新工单有效路径，说明旧通过结论不能覆盖当前工作树，并记录本次文件哈希与验证；工程验收通过，产品验收按规格不适用，任务 resolved。

这是轻量路径的作者验证，没有冒称独立实现审查。只改临时仓库，没有提交或发布。

## 仓库检查

- `npm run check:static` 的 lint、各 workspace 类型检查、notes 检查均通过；首次在工单说明篇幅检查处失败。整理正文后，`npm run check:docs` 的链接、源码引用、篇幅和段落检查通过；未提高篇幅上限。
- `uv run --with pyyaml python /Users/eitrous/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/development-workflow` 通过。系统 Python 缺 PyYAML，验证使用临时工具环境，未增加仓库依赖。
- 最终独立审查与收尾检查结果由[工单](issues/01-establish-workflow.md)记录。

## 证据边界

演练证明上述输入下的实际处理，不证明所有模型、客户端或长期开发都可靠；没有实际调用 Astra、Opus 与 Sol 完成跨供应商接力。两个演练均不涉及真实外部平台，不能作为真实平台验收证据。未运行全量产品测试、真实模型测试或部署验收，因为本次没有对应产品改动。
