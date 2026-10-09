Status: ready-for-agent

# 收尾：入口文档、决策 note 转 implemented、完整验收

依赖：01–07。范围见 [spec](../spec.md)。

## 做法

1. AGENTS.md（编辑前读 mattpocock `writing-for-agents` skill）：
   - 目录导航删除「`docs/adr/` 说明架构决策」；`docs/` 一行列出 architecture、modules、usage、development、release-acceptance，并注明 `docs/agents/` 是 agent 配置例外；加上 `.scratch/` 一行（入库的工单与验证证据）。
   - Issue tracker 路径改为 `.scratch/<feature>/`（如果 01 已改，这里只核对）。
   - 核对 maintain-notes（02）与 writing-docs-for-human（06）两条指针都在，「可视化文档」小节已删（05）。
2. README「文档」一节、`docs/development.md`（第 161 行「CONTEXT.md 与 ADR 为准」、测试导航表）改指新结构。
3. 决策 note 按 maintain-notes 的流转规则转为 implemented：移到 `.agents/notes/implemented/process/`，文件名不变；`Status: implemented`；`## 方案` 改成现在时的 `## 决定`；验收标准与风险折进 `## 后果`（同时写代价和收益）。同步更新 spec 里指向它的链接。
4. 跑完整 `npm run check`。本机 test/08 DNS 用例若失败，先在基线上核对。
5. 新检出验证：在临时目录 `git clone` 本仓库，检查 notes、docs、release-acceptance 和 `.scratch/` 的相对链接全部有效。

## 验收

- [ ] 决策 note「验收标准」中的每一条都满足，逐条结果记入 Comments。
- [ ] `npm run check` 通过，并记录耗时与结果。
- [ ] `npm run verify-notes` 对 implemented 状态的决策 note 通过。

## Comments
