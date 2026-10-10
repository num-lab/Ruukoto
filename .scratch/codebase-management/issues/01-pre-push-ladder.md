Status: resolved

# 01 — 按改动面选检查，取代「收尾跑全量」

**What to build:** agent 改完一处后，能按改动面选出最窄的、能证明该改动正确的检查，而不是每批都跑约 200 秒的全量 `npm run check`。

**Blocked by:** 无，可立即开始

## 验收标准

- [x] `npm run change-scope -- --base <ref>` 输出带版本号的 JSON，含已提交／暂存／未暂存／未跟踪四类路径与解析后的 base／head／merge base 提交号。
- [x] `.agents/skills/pre-push-checks/SKILL.md` 给出改动面到命令的映射表，覆盖 `src/` 各区、`test/`、`docs/`、`.agents/notes/`、`verification/`、`deploy/`、`package.json`。
- [x] `AGENTS.md`、`docs/development.md`、`README.md` 三处不再写「收尾运行 `npm run check`」，改为「按改动面选检查」并链接 skill；全量只在明确要求、诊断 CI 或确实跨全仓时跑。
- [x] `docs/development.md` 保留全量 `check` 的命令说明，供 CI 与显式复跑使用。
- [x] 决策 note 与工单同批落盘。

## 依据

- `docs/development.md:30`、`README.md:86`、`AGENTS.md:5` 现在都指示收尾跑全量。
- 实测全量耗时：`check:static` 8.2 秒；应用全量测试 macOS 167 秒、Linux 495 秒（`docs/development.md` 的耗时基线表）。
- DSH 对应物：`scripts/change-scope.ts`（248 行）、`.agents/skills/dsh-pre-push-checks/SKILL.md`、根 `AGENTS.md`「Run relevant checks locally」小节。

## Comments

### 2026-10-10：范围

本批只建立阶梯与选择依据，不改任何现有测试、不删任何检查。全量 `check` 仍存在且仍是 CI 的入口，改的只是「默认该跑什么」。
