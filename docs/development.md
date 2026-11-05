# Development and Verification

Run commands at the repository root. `packages/*` and `apps/*` use npm workspaces and the root lockfile; `verification/foundation/` has its own package and lockfile. Application and foundation tests share helpers from root `test/`.

```bash
npm run setup
npm run check
```

`setup` checks [prerequisites](../README.md#quick-start), runs `npm ci` for both package trees and installs the Git-managed pre-commit hook. Initial installation needs network access. `check` uses mock models and temporary data, not model credentials, Docker, real IM or a running product backend. Linux native tests need the [system prerequisites](../deploy/native/README.md). Dependency changes update both the relevant manifest and lockfile, then rerun setup.

The macOS native supervisor and MyGo CGO require Command Line Tools' Clang. [Native probes](../verification/foundation/scripts/native-isolation/README.md) describe platform setup and real boundary checks; offline local tests do not prove OS isolation.

## Collaboration

Use the GitHub Issue and current role as the handoff entry. The [development workflow](../.agents/skills/development-workflow/SKILL.md) defines plan review, implementation review and acceptance. Roles do not prescribe models. Record engineering evidence separately from owner experience decisions; keep raw evidence outside the repository.

## Daily Feedback

| Command | Scope and output |
| --- | --- |
| `npm run build` | Native supervisors, tool/script workers and WASM, then both products' `dist/*.tgz`; applications run source through tsx |
| `npm run build:worker` | Shared `worker.mjs`, `background-worker.mjs`, Personal command, file-search, file-operation and app-data workers. File-operation regressions: `npx tsx --test test/personal-file-io.test.ts test/personal-tools.test.ts test/personal-tool-io.test.ts test/personal-tool-fifo.test.ts`; SQLite jobs: `npx tsx --test test/personal-app-data.test.ts test/personal-app-data-io.test.ts` |
| `npm run desktop:mygo` / `npm run desktop:mygo:build` | Build and launch / only build MyGo; macOS arm64 and Go ≥ 1.27.1; see [desktop development](desktop-development.md) |
| `npm run desktop:build` | Build three desktop targets, inspect artifacts and ad-hoc sign `dist/mac-arm64/Ruukoto.app`; root build does not package Electron |
| `npm start`, `npm run personal:durable` | Personal menu, default `~/.ruukoto-durable/`; `RUUKOTO_PERSONAL_DIR` selects a profile; see [management](usage.md#25-personal-agent-management) |
| `npm run dev`, `npm run dev -- --config` | Watched Personal development backend / non-watched menu for the same checkout-specific profile; enabled QQ/Telegram prevents startup |
| `npm run build:script` | Build `worker/workflow-script.mjs` and copy its WASM; run before script tests |
| `npm run lint` | Correctness and key conventions, not repository-wide formatting |
| `npm run typecheck` | Root tests/scripts, each workspace and foundation package |
| `npm test` | All application and foundation offline tests; real-model cases remain disabled |
| `npm run check:static` | Lint, types, notes and documentation checks |
| `npm run check` | Prerequisites, build, static checks and all offline tests; stop at the first failed stage |
| `npm run test:app` | Application tests; macOS runs specified native-stop/background-recovery fixtures serially before the batch with at most two files in parallel |
| `npm run test:foundation` | Foundation offline tests only |
| `npm run change-scope -- --base <ref>` | Committed, staged, unstaged and untracked paths relative to the merge base |

While editing, run static checks and targeted tests. Use the [change-scope checklist](../.agents/skills/pre-push-checks/SKILL.md); full `check` is for an explicit request, CI diagnosis or genuinely repository-wide changes. Name files in targeted commands:

```bash
npx tsx --test test/71-product-entry.test.ts test/32-dev.test.ts
npx tsx --test verification/foundation/test/03-tools.test.ts
```

Find tests by feature with `rg --files test`. Skill tests isolate HOME.

| Changed area | Useful starting tests |
| --- | --- |
| TUI CLI/development entry, product declarations, Coding dev | `29-cli-entry`, `32-dev`, `71-product-entry`; MCP uses `mcp list`/`mcp cua` and rejects old `--project` |
| Personal `personal-*.ts` (Pi 1.3.0) | Select configuration and entry cases from [pre-push checks](../.agents/skills/pre-push-checks/SKILL.md); real prerequisites below |
| Personal work questions and native recovery | `personal-work-questions`, `personal-desktop-actions`, `personal-desktop-events`, `desktop-personal-native`, `desktop-personal-recovery`; add the changed execution families |
| Personal service helper and `deploy/systemd/ruukoto-service.mjs` | `service-helper-transport`, `service-helper-stop`, `78-linux-service-management`, `79-standing-permissions`, `personal-services`, `personal-service-operations` |
| Runtime/control task lifecycle | `01-concurrency` through `05-overflow-db`, `66-control-seam`, `94-task-ending` |
| Side chat | `127-side-chat` |
| Agent tools and skills | Tool/permission groups in pre-push checks; fixed HOME, old snapshots and retired operations |
| Browser | `browser-tools`, `browser-lifecycle` |
| Coding conversation backgrounds | `background-processes`, `background-processes-recovery`; real acceptance remains separate |
| Script worker | `104-workflow-script`, `100-worker-stop` |
| Test runner batching and exit | `124-test-app-runner`; the script owns the exclusive shared-UID fixture list |
| Workflow persistence, coordinator, steps and host operations | `105-workflow-runtime` through `113-workflow-source-capabilities`, plus `workflow-*.test.ts` for role/version changes |
| Answers, delivery and waiting | `114-workflow-owner-input`, `115-workflow-final-delivery`, `125-agent-wait*.test.ts` |
| Coding input lifecycle | `coding-input-store`, `coding-input-runtime`, `coding-input-client-lifecycle`, `sdk-steering-contract`; add `message-recall`, `queue-guidance-*`, `owner-question-*`, 12/13/14/15, 41 and 66 by impact |
| Workflow library and entry | `117-workflow-library` through `120-workflow-cli`, 126 sidebar/recovery; mock models |
| Four-input Coding acceptance | `122-workflow-code-acceptance`: three actual concurrent slots, fourth queued, independent verification and real integration |
| Agent context and models | `18-model-selection`, `60-context-prefix`, `61-context-compaction`, `98-media-model-pinning` |
| SubAgents, roles, snapshots, worktrees and imports | 80–87, 91, 95; search `subagent-role`, `subagent-definition`, `workspace-snapshot`, `subagent-workspace-snapshot`, `work-copy-host` |
| TUI and configuration UI | `13-tui-state`, `14-tui-app`, `15-tui-pty`, `33-config-tui` |
| Desktop | Terminal changes require `desktop-terminal`; see [desktop test navigation](desktop-development.md#test-navigation) for both hosts |
| Shared view and browser constraints | `36-event-flow-state`, `37-view-browser`; TUI consumers also 13/14/34/19 |
| Shared QQ/Telegram/scheduler adapters | `26-qq`, `37-scheduler-outbox`, `38-telegram-owner`, `40-qq-private`, `89-im-entries` |

Names in the table refer to files under `test/` with the `.test.ts` suffix unless a glob is shown. Record failures by test name, assertion and environment. Distinguish regressions from missing prerequisites, reproduce independently, then repair. Default checks and CI do not retry. [Historical acceptance](release-acceptance.md) does not prove the current checkout passes. Todo marker rules live in [AGENTS.md](../AGENTS.md).

## Commits and CI

Pre-commit runs `git diff --cached --check`, `scripts/check-staged-eol.mjs` and `npm run check:static`. The first rejects whitespace and trailing blank lines; the second requires exactly one final newline. The full offline suite belongs to `check` and CI.

Setup inspects existing `core.hooksPath` and pre-commit configuration before installing dependencies. A conflict stops installation without replacing hooks. To retain custom hooks, add static checks there first and use `npm run setup -- --skip-hooks`. To adopt repository hooks, back up and move the old configuration, then run default setup. `git config --show-origin --get core.hooksPath` identifies its source. An existing setting pointing to this checkout's `.githooks/` is reused after executable-entry verification.

Without `core.hooksPath`, linked worktrees share a hooks directory. Setup installs a fixed forwarder that runs the current checkout's `.githooks/pre-commit`, so switching branches or deleting another worktree does not change this checkout's hook entry. Old checkouts without the hook or `check:static` are explicitly skipped; that compatibility does not count as verification of those branches.

CI runs macOS and Linux with Node 24.15.0 and a 90-minute job limit. It installs rg, prepares Linux native namespaces and delegated user scopes, then runs `npm run setup -- --skip-hooks` and `npm run check`. Missing Python/PTY is a failure, not a reason to skip terminal cases. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` avoids downloading or running Electron; desktop types, lint and pure logic still run.

`worker/` is generated. The agent package pins QuickJS core and release-sync WASM; lockfiles determine `node_modules/`. Build workers before targeted Personal command, search, file-operation and app-data tests; real Linux/browser/computer/process checks and real-model routing have separate acceptance. Databases, tokens and credentials stay in product or temporary test profiles, never the worktree.

The file-I/O regression set exercises actual FIFO stalls, worker exits and SIGKILL recovery, not only delayed Promises. Run it on macOS and an isolated Linux checkout before accepting lifecycle changes. Defaults are a 120-second job deadline, a 5-second termination grace and four occupied slots per profile; neither deadline nor termination request releases a started worker. Preserve the approved-capacity-denial/old-key counterexample, original unknown-write claims, and stop/reopen evidence. The [Personal lifecycle](modules/personal-durable.md#file-operation-lifecycle) explains the recovery limits.

## External Acceptance

[External development acceptance](development-acceptance.md) owns the commands and prerequisites for native probes, real models, Coding questions/schedules and the Personal amendment/report loop. Use fresh isolated profiles and explicit credentials, preserving daily profiles and pending records. Report missing prerequisites as unverified; offline mocks do not establish real client or platform acceptance.

After building workers, the optional-family model command is `RUN_MODEL_CHECK=1 RUN_PERSONAL_M2_MODELS_FILE=/absolute/models.json npx tsx --test test/personal-m2-model-acceptance.test.ts`; use `RUN_PERSONAL_M2_MODEL=provider/model` for multiple configured models. [M2 execution acceptance](development-acceptance.md#personal-m2-execution) also requires separate real Linux browser/computer/process and synchronous SQLite evidence.

Work-question model acceptance uses `RUN_MODEL_CHECK=1 RUN_PERSONAL_M3_MODELS_FILE=/absolute/models.json npx tsx --test test/personal-m3-model-acceptance.test.ts`; select `RUN_PERSONAL_M3_MODEL=provider/model` for multiple models. It covers concurrent questions, original-work continuation, cancellation and retained permissions. Fixed recovery and both native hosts additionally require isolated Linux and signed-client interaction evidence.

## Development Instances

Personal development uses the production CLI composition with a separate profile; Coding development has its own launcher and defaults to the TUI.

```bash
npm run dev
npm run dev -- --config
npm run code
npm run code -- ../my-project
npm run code -- --config
npm run code -- --import-models ~/.ruukoto-code/agent
```

Personal uses `~/.ruukoto-durable-dev/<checkout-realpath-hash12>/`, ignoring inherited production and legacy directory variables. Old `~/.ruukoto-dev/` profiles remain archives. Models and service credentials are not copied: configure models with `--config`, and supply credentials through this process's environment.

Root and app dev scripts enter the same thin tsx launcher. Without arguments it hosts `node --watch --import tsx`, forwards stop signals and waits for exit; a source change stops the old backend before restarting it. Watch can await corrected source after startup failure. `--config` opens the same profile's menu in-process without watching; any backend it starts stops when the menu exits. Reopen the menu after configuration-source edits. Enabled QQ/Telegram makes development startup reject without connecting, changing configuration or advancing sending generations; use the production entry with a separately chosen new profile for real IM exercises.

Coding uses `~/.ruukoto-code-dev/<repository>-<hash>/`, including `data/agent/control/pending/logs`, isolated locks and control endpoints. `--import-models` copies only `models.json` and `auth.json`, not service credentials or default-model files. `--config` also supports initial setup.

| Coding launcher behavior | Guarantee |
| --- | --- |
| Workspace argument | Existing directory, mutually exclusive with `--config`; normal identity and protected-root checks; source reload does not create another conversation |
| Environment | Clears inherited product paths, production owner token, service settings and execution overrides; fixes Coding identity/profile; disables QQ/Telegram; native prerequisites fail explicitly |
| Process ownership | Owns this backend and frontend process group; TUI/config exit, Ctrl+C and terminal closure clean up; an existing external backend is rejected, never attached or stopped |
| Reload | Watches `packages/*/src/` and `apps/*/src/`; backend changes restart gracefully; UI-only changes do not restart the backend; view belongs to the task UI; launcher changes require manual restart |
| UI recovery | Saves conversation and ordinary draft per instance; secrets must be reentered; old pending continue/answer records retain their original instance and key for verification without conversion or replay |
| Configuration | Missing models enter offline setup first; backend starts only after successful save and lock release; cancel/failure leaves it stopped |

The configuration UI follows backend reload and restores its section. `backend.log` and `dev.log` stay separate from interactive input.

## Desktop Client

`npm run code -- --desktop` uses the isolated Coding profile and is mutually exclusive with `--config` and a workspace argument. electron-vite rebuilds desktop dependencies and handles HMR; the launcher owns backend shutdown. See [desktop development](desktop-development.md) for builds, downloads and acceptance.

The [standalone desktop demo](../verification/desktop-demo/README.md) installs independently of Electron and the backend. Approved baselines remain byte-for-byte fixtures; the maintained demo and its checks live under `verification/`.

## Timing Baselines

[Historical development timings](development-baselines.md) record revisions, platforms and coverage limits. Use them to choose feedback paths, not as evidence that today's checkout passes.
