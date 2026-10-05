Status: needs-triage

# 工作副本：创建、复核、汇总收成一个模块

## 目标

SubAgent 工作副本（宿主生成的 worktree）的创建、复核与汇总由一个模块负责，容器执行作为注入依赖；SubAgent manager 只钉定 `write_target`。来源：2026-10-05 架构审查的候选 08。

## 背景

2026-10-05 核对（develop d109dbe）：

- `subagents.ts`（1713 行）里约 420 行 git/fs 逻辑：`integrate` 与 `parseIntegrationOutput`（1000–1183）、`assertWorktreeCopy` / `findRepoRoot` / `resolveCommonGitDir`（1227–1306）、`prepareWriteTarget`（1308–1461）；另有 `runtime.ts:490` 的 `createWorktreeInContainer` 与 2111–2160 的授予路径保护。
- 容器入口已是依赖（`subagents.ts:218`，Runtime 在 :702 注入），测试却在 `test/83-subagent-worktrees.test.ts:403–416` 用 `(rt as any).createWorktreeInContainer` 替换 Runtime 的方法。
- 汇总的 applied / already / conflict / 空差异矩阵现在只能经真实容器测。

## 待访谈

- 授予路径保护（`validateGrantedPaths` 拒绝覆盖 `agent-work/worktrees` 的读写授予）是否随迁。
- 测试替身用预制输出，另留一条真实 git 冒烟。

## 相关 ADR

- ADR 0021 §3「宿主永不执行 git」：替身只在测试，宿主上没有任何东西跑 git——必须保持。

## Comments
