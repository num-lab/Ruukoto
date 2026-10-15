普通委派旧接口升级独立副本记录

- npm run build：通过。
- npx tsc --noEmit：通过。
- 15 个改动文件定向 eslint --max-warnings=0：通过。
- npm run check:static：lint、root+workspace+foundation typecheck、verify-notes 通过；最后 check:docs 因基线副本未包含两个 .scratch 文档而失败。补齐这两个原始 Markdown 后，单跑 npm run check:docs 全部通过。verify-notes append-only 检查因无 .git 跳过，seal hash 核实通过。
- npx tsx --test test/subagent-role-runtime.test.ts test/80-subagent-delegation.test.ts test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/91-release-acceptance.test.ts test/92-subagent-lifecycle.test.ts test/workspace-snapshot-runtime-boundaries.test.ts test/125-agent-wait.test.ts：104/104 通过，0 skipped，耗时 86.8 秒。
- 未执行 smoke、真实模型或 Linux；这些调用点仅参数迁移。
