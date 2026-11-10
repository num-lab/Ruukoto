# Development and Verification

Run commands at the repository root. `packages/*` and `apps/*` use npm workspaces and the root lockfile; `verification/foundation/` has its own package and lockfile. Application and foundation tests share helpers from root `test/`.

```bash
npm run setup
npm run check
```

`setup` checks [prerequisites](../README.md#quick-start), runs `npm ci` for both package trees and installs the Git-managed pre-commit hook. Initial installation needs network access. `check` uses mock models and temporary data, not model credentials, Docker, real IM or a running product backend. Linux native tests need the [system prerequisites](../deploy/native/README.md). Dependency changes update both the relevant manifest and lockfile, then rerun setup.

The macOS native supervisor and MyGo CGO require Command Line Tools' Clang. [Native probes](../verification/foundation/scripts/native-isolation/README.md) describe platform setup and real boundary checks; offline local tests do not prove OS isolation.

## Collaboration

Use the GitHub Issue as the handoff entry. The [development workflow](../.agents/skills/development-workflow/SKILL.md) defines review and acceptance. Roles do not prescribe models. Keep engineering evidence separate from owner experience decisions and raw evidence outside the repository.

## Daily Feedback

| Command | Scope and output |
| --- | --- |
| `npm run build` | Native supervisors, retained tool/script workers and WASM, then the sole application package; applications run source through tsx |
| `npm run build:worker` | Retained tool and background worker assets |
| `npm run desktop:mygo` / `npm run desktop:mygo:build` | Build and launch / only build MyGo; macOS arm64 and Go ≥ 1.27.1; see [desktop development](desktop-development.md) |
| `npm run desktop:build` | Build desktop targets, inspect artifacts and ad-hoc sign `dist/mac-arm64/ruukoto.app`; root build does not package Electron |
| `npm start -- <arguments>` | Sole `ruukoto` entry; default activated root `~/.ruukoto/single-v1` |
| `npm run dev`, `npm run dev -- --config` | Checkout-isolated backend/TUI or configuration for the same fresh profile |
| `npm run build:script` | Build `worker/workflow-script.mjs` and copy its WASM; run before script tests |
| `npm run lint` | Correctness and key conventions, not repository-wide formatting |
| `npm run typecheck` | Root tests/scripts, each workspace and foundation package |
| `npm test` | All application and foundation offline tests; real-model cases remain disabled |
| `npm run check:static` | Lint, types, notes and documentation checks |
| `npm run check` | Prerequisites, build, static checks and all offline tests; stop at the first failed stage |
| `npm run test:app` | All application tests; at most two ordinary files in parallel, with macOS shared-UID fixtures first and serial |
| `npm run test:app -- --shard=1/4` | One deterministic file shard; macOS shared-UID fixtures all belong to shard 1 |
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
| TUI CLI/development entry and profile handoff | `29-cli-entry`, `32-dev`, `71-product-entry`; MCP uses `mcp list`/`mcp cua` and rejects old `--project` |
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
| SubAgents, roles, snapshots and work copies | Search `subagent-role`, `subagent-definition`, `workspace-snapshot`, `subagent-workspace-snapshot`, `work-copy-host`; add affected parent-delivery and lifecycle consumers |
| TUI and configuration UI | `13-tui-state`, `14-tui-app`, `15-tui-pty`, `33-config-tui` |
| Desktop | Terminal changes require `desktop-terminal`; see [desktop test navigation](desktop-development.md#test-navigation) for both hosts |
| Shared view and browser constraints | `36-event-flow-state`, `37-view-browser`; TUI consumers also 13/14/34/19 |
| Scheduling and time rules | `code-scheduler-core`, `code-scheduler`, `code-scheduled-sources`, `desktop-scheduled` |

Names in the table refer to files under `test/` with the `.test.ts` suffix unless a glob is shown. Record failures by test name, assertion and environment. Distinguish regressions from missing prerequisites, reproduce independently, then repair. Default checks and CI do not retry. [Historical acceptance](release-acceptance.md) does not prove the current checkout passes. Todo marker rules live in [AGENTS.md](../AGENTS.md).

## Commits and CI

Pre-commit runs `git diff --cached --check`, `scripts/check-staged-eol.mjs` and `npm run check:static`. The first rejects whitespace and trailing blank lines; the second requires exactly one final newline. The full offline suite belongs to `check` and CI.

Setup inspects existing `core.hooksPath` and pre-commit configuration before installing dependencies. A conflict stops installation without replacing hooks. To retain custom hooks, add static checks there first and use `npm run setup -- --skip-hooks`. To adopt repository hooks, back up and move the old configuration, then run default setup. `git config --show-origin --get core.hooksPath` identifies its source. An existing setting pointing to this checkout's `.githooks/` is reused after executable-entry verification.

Without `core.hooksPath`, linked worktrees share a hooks directory. Setup installs a fixed forwarder that runs the current checkout's `.githooks/pre-commit`, so switching branches or deleting another worktree does not change this checkout's hook entry. Old checkouts without the hook or `check:static` are explicitly skipped; that compatibility does not count as verification of those branches.

CI covers the full check on macOS and Linux through four isolated application-test shards per OS, pinned to Node 24.15.0 with a 90-minute job limit. See [CI execution](ci.md) for commands, prerequisites, shard isolation and timing comparisons. Local `npm run check` remains unsharded.

`worker/` is generated. The agent package pins QuickJS core and release-sync WASM; lockfiles determine `node_modules/`. Build retained workers before their targeted consumers. Databases, tokens and credentials stay in activated or temporary test profiles, never the worktree. Linux user-systemd execution remains required independently of retired Personal deployment.

## External Acceptance

[External development acceptance](development-acceptance.md) owns native/model/client prerequisites and retained workflow, question and schedule checks. Use fresh isolated profiles and explicitly selected model configuration, preserving daily profiles and old pending records. Required Linux, real-model and actual TUI/Electron/MyGo evidence remains unverified until exercised; offline mocks are not a substitute.

## Development Instances

The sole development launcher defaults to the TUI and selects four raw roles under `~/.ruukoto-dev/<checkout-identity>/`. Core then activates `single-v1` using exactly the daily algorithm.

```bash
npm run dev
npm run dev -- ../my-project
npm run dev -- --config
npm run dev -- --desktop
```

Configure models in this new resolved `agentDir` through `--config`; no old configuration, credentials or history are silently imported. All children receive the complete canonical raw tuple, not resolved role paths.

| Launcher behavior | Guarantee |
| --- | --- |
| No workspace | Fresh selector draft; first send allocates in this profile; see [usage](usage.md#22-software-work) |
| Workspace argument | Existing directory, mutually exclusive with `--config`; normal identity and protected-root checks; source reload does not create another conversation |
| Environment | Clears inherited daily paths, owner-token and execution overrides; forwards its complete raw selection; native prerequisites fail explicitly |
| Process ownership | Owns this backend and frontend process group; TUI/config exit, Ctrl+C and terminal closure clean up; an existing external backend is rejected, never attached or stopped |
| Reload | Watches `packages/*/src/` and `apps/*/src/`; backend changes restart gracefully; UI-only changes do not restart the backend; view belongs to the task UI; launcher changes require manual restart |
| UI recovery | Saves conversation/draft per instance; current journals retain original request keys for reconciliation; malformed records remain visible without replay or conversion to new input |
| Configuration | Missing models enter offline setup first; backend starts only after successful save and lock release; cancel/failure leaves it stopped |

The configuration UI follows backend reload and restores its section. Resolver-owned `single-v1/logs/backend.log` and `dev.log` remain separate from interactive input; command history, reload state and pending journals are likewise profile-qualified.

## Desktop Client

`npm run dev -- --desktop` uses the checkout-isolated profile and is mutually exclusive with `--config` and a workspace argument. electron-vite rebuilds desktop dependencies and handles HMR; the launcher owns backend shutdown. See [desktop development](desktop-development.md) for builds, native-state isolation and acceptance.

The [standalone desktop demo](../verification/desktop-demo/README.md) installs independently of Electron and the backend. Approved baselines remain byte-for-byte fixtures; the maintained demo and its checks live under `verification/`.

## Timing Baselines

[Historical development timings](development-baselines.md) record revisions, platforms and coverage limits. Use them to choose feedback paths, not as evidence that today's checkout passes.
