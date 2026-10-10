Status: resolved

# scratch 移到 .scratch/ 并入库

范围见 [spec](../spec.md)。`.agents/scratch/` 目前被 gitignore，ADR、`docs/release-acceptance.md`、测试注释与 verification README 链接到其中的文件，在新检出上都是死链。

## 做法

1. 把 `.agents/scratch/` 整体移到仓库根 `.scratch/`，原有的 `.DS_Store` 不入库。
2. `.gitignore`：删除 `.agents/scratch`，在 `*.log` 之后加 `!.scratch/**/*.log`，让 19 个证据日志（约 216K）入库。
3. `.dockerignore` 和 `deploy/systemd/README.md` 的 rsync 排除项改为 `.scratch`；`eslint.config.mjs` 的 ignores 加 `.scratch/**`（原来由 `.agents/**` 覆盖，scratch 里有大量 `.mts` 冒烟脚本）。
4. 已跟踪文件里的 `.agents/scratch` 一律改为 `.scratch`。相对链接的 `../` 层数不变，因为两者都从仓库根算起。涉及：`docs/release-acceptance.md`、`docs/runtime.md`、`docs/adr/*`、`docs/agents/issue-tracker.md`、`AGENTS.md`、`deploy/systemd/README.md`、6 个测试文件注释、`verification/foundation/README.md`、`verification/foundation/scripts/native-isolation/README.md`。**`verification/archive/` 不改。**
5. scratch 文件内部：正文里写的 `.agents/scratch/` 路径同样改为 `.scratch/`；指向仓库其他文件的相对链接少了一层目录，`../` 要减一层（例如原 `.agents/scratch/<feature>/issues/x.md` 里的 `../../../../src/...` 改为 `../../../src/...`）。scratch 内部文件互相之间的链接不变。
6. 提交前扫描凭据：在本次正则扫描（token、私钥、密码，未命中）之外，再人工看一遍 `release-24-linux-logs/` 与 `*-results.md` 的内容。

## 验收

- [x] `git grep -n "\.agents/scratch"` 只命中 `verification/archive/`，以及本工单与 spec 里的叙述。
- [x] `git status` 显示 `.scratch/` 下的 md、mts、py、sh、log 全部可跟踪。
- [x] 一个脚本检查 `.scratch/`、`docs/`、`test/`、`verification/foundation/` 里所有相对 Markdown 链接都指向存在的文件。不需要永久保存这个脚本，结果记在 Comments。
- [x] `npm run check:static` 通过（确认 eslint 不扫 `.scratch/`）。

## Comments

2026-10-09：完成，未提交。

- 移动：8 个功能目录整体移到 `.scratch/`，没有同名冲突；`.agents/scratch/` 已删除。移动前的备份在本机 `/tmp/rk-scratch-move/backup`，提交后可以删。
- scratch 内部改写：用一次性脚本（`/tmp/rk-scratch-move/rewrite.py`，未入库）改了 92 个文件。凡是相对路径恰好回到仓库根的，`../` 少一层；所有 `.agents/scratch` 字样改为 `.scratch`。改写范围包括 md、mts、py、sh，日志保持原样。冒烟脚本里 `"../../.."` 形式的根目录解析和 `../../../src` 形式的 import 也一并改了。脚本只报出一处路径落在 scratch 之外：工单 agent-direction/24 链到 `.agents/skills/visual-docs/`，已手工改为 `../../../.agents/skills/visual-docs/SKILL.md`。工单 05 删除这个 skill 时要处理这条链接。
- 已跟踪文件：19 个文件里的 `.agents/scratch` 改为 `.scratch`。`.gitignore` 删除旧规则，加 `!.scratch/**/*.log`；`.dockerignore`、rsync 排除项和 eslint ignores 已同步。`verification/archive/` 没有改。
- 凭据：扫描了 token、私钥、Bearer、API key、密码以及公网 IP，没有凭据。命中项只有 sudoers 的 NOPASSWD 行、鉴权方式说明和 3 个 198.18.x.x 基准测试网段地址。
- 验证：`git status` 显示 `.scratch/` 下 171 个文件全部可跟踪，其中日志 19 个（`git check-ignore -v` 命中的是取反规则）。用一次性脚本检查 `.scratch`、`docs`、`test`、`verification/foundation`、`deploy`、`AGENTS.md`、`README.md`、`CONTEXT.md` 与 `.agents/notes` 里的 607 条相对 Markdown 链接，没有失效（排除 node_modules）。25 个 `.mts` 冒烟脚本用 `esbuild --bundle --packages=external` 检查，全部能解析，但没有运行。`npm run check:static` 退出码 0，用时约 8 秒。
- 已跟踪文件里还剩的 `.agents/scratch` 只在 `verification/archive/`；未跟踪的叙述性提及只在本目录与决策 note 里。
