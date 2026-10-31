# Product Migration and Acceptance Records

This page preserves first-phase migration evidence and its limits. Current Personal runs independent durable; legacy Personal imports, development conversations, workflows and GitHub auto-review are retired from its composition. Use [usage](usage.md), [deployment](../deploy/systemd/README.md) and current GitHub work items for present operations. Historical counts do not establish acceptance of a current candidate or production cutover.

Historical local Issue numbers below identify the original `agent-direction` or `personal-agent` work streams, not GitHub Issue numbers. The complete original record is preserved in the pre-governance backup and baseline `155ba39f85ce25a3fcd230f6459d18ef2f910c7c`; [governance Issue #1](https://github.com/num-lab/Ruukoto/issues/1) tracks migration of still-relevant work. Raw private logs are not republished here.

## First-Phase Behavior

The first release split Coding on development machines from Personal on Linux, each with independent profiles, control endpoints and model configuration. At that time there were two legacy-import directions; Personal now starts with a blank durable profile instead. Development launcher profiles/lifetimes also changed afterward; current paths are in [development](development.md#development-instances).

Coding organizes workspaces/conversations, starts a backend on demand and continues ordinary-product tasks after TUI exit. Restricted execution now uses native sandboxes and fails when unavailable; current full access uses the starting account. Git-writing delegation uses work copies and explicit integration into the parent's pending changes, preserving both sides on conflict; non-Git writes use directory occupancy.

QQ/Telegram owner entries share Personal main and retain original-platform approval/report destinations. Service management is scoped inspection/restart, with exact versioned standing grants reverified on use. Revoked/mismatched/unknown permissions return to individual approval. Long work does not block main from answering new input. Offline destinations wait; changed bindings do not redirect and unknown sent effects do not automatically replay.

SubAgent identity, work and task are distinct. Verified task completion returns a child to idle for reuse; closure is explicit. Work cancellation stops its active/queued tasks but retains identity, history, artifacts and changes. Late results cannot reactivate canceled work. Shared-runtime restart interrupts ordinary delegated tasks and preserves unverified occupancy; host-fixed PR review had separate recovery rules.

Fixed coding/chat roles and core group-chat creation retired, retaining read-only history. Cross-product shared memory, email, GitHub comment conversations and the standalone QQ group extension remain later scope. One-time historical memory import was not cross-product synchronization.

## Joint Acceptance: 2026-10-06

The order was local code changes/checks, then IM service management, then collaboration/recovery/reporting. Only the macOS Coding path below used a real model. The owner had no independent real IM test entry, so both platforms remained simulated; daily bindings were not used.

The Linux exercise first rewrote system-resource paths with [its preparation script](../verification/archive/release-24-prepare.py.txt), then removed exercise backends/services/profiles/helper/policy/sudoers/ledger. Archived raw09/10 scripts still target fixed shared paths; that one-off preparation does not make today's raw archives safe to run.

| Check | Environment | Result and limit |
| --- | --- | --- |
| Local repair, before/after checks, TUI exit/continue/reconnect | macOS arm64/Node24.15, real `mirasim/kimi-k3`, then-default container, production bin/PTY | smoke24 5/5 including upgrade; original check script bytes unchanged, before failed/after passed; task still running at TUI exit, terminal outcome/artifacts visible after reconnect |
| Independent product installation, upgrade and stop | macOS and tx, two isolated npm-ci checkouts each, baseline `1aba2f1` | macOS included in5/5; Linux upgrade4/4; mock models; other product PID/work continued, original history/instanceId retained |
| Restricted execution and unavailable full-access entry | macOS Docker Desktop and native Linux Docker, real workers/files/network/processes | smoke04 6/6 each; mock model; edits/checks, one-use outside approval and reclamation |
| Linux Coding full access, old design | tx runtime through temporary fixed sudo/systemd, UID/GID986 | One task/four tools, actual before-fail/after-pass; owner token/core DB denied; mock model; not macOS full-access evidence |
| IM service management/standing grant | tx systemd/sudo/root helper/test service/ledger | smoke09 14/14, smoke10 14/14; real restart and grant save/use/revoke/invalidation, simulated model/OneBot/Bot API |
| Same-work collaboration | tx runtime/control/SQLite/JSONL/container | smoke13 6/6; bidirectional messages, sources, stale-scope rejection after reuse, explicit close/restart; mock model |
| Recovery and original-entry final report | tx container/CLI/restart/SIGKILL/outbox | smoke15 8/8 and historical smoke18 7/7; responsiveness, pinned destination, offline waiting, rebinding invalidation and unique report; mock model/platforms |
| Import→restart→collaborate→cancel→conflict→revert | macOS runtime/SQLite/JSONL/Git/files | test91 1/1; local execution/mock model, no isolation claim; two restarts, no late-message model call, zero-write conflict, preserved source bytes, blocked/clean revert |
| Revert status response fix | Both historical import directions, real DB/receipts | test85 plus old Personal-import test86 12/12; blocked response stayed `applied`, successful response `reverted` |

The batch fixed falsely reporting a blocked revert as `reverted` while storage remained `applied`. It also limited configuration root-directory descriptions to the Coding product. Final macOS application tests:915 total,913 pass,1 skip,1 failure. The failure was test08 DNS: `nonexistent.invalid` resolved to `198.18.0.71`; clean `33571b4` reproduced the timeout. This is not a full pass. Linux:915 total,914 pass,1 skip,0 failures. Types/diagram checks passed on both. Five initial Linux failures were independently reproduced and fixed: distinct-inode fixtures, checkout-name assumptions, worker/model readiness and product-specific configuration display.

The original release work remained awaiting owner acceptance with real IM and then-missing macOS full-access evidence outstanding. Later evidence below must not retroactively rewrite that run.

## Current Rerun Entry Points

A complete checkout contains maintained [smoke scripts](../verification/smoke/README.md). Prepare with setup and the checks appropriate to current scope; native Coding requires Linux prerequisites and a build, then `npm run test:native`. Personal durable uses separate capability/final acceptance. Historical Docker results are not results of the current native scripts.

```bash
npm run test:upgrade
npm run test:release-model -- --models /path/to/models.json --model provider/model
```

Model and upgrade checks are independent. Model smoke preflights the selected configuration/authentication/effort/budget offline before TUI startup. It neither inherits model-key environment nor reads daily/adjacent auth files. Missing prerequisites exit2, not pass.

Current upgrade defaults to `8bccb8f` with `ruukoto-code` identity; historical `1aba2f1` used the old Coding name. Alternative baselines need matching current identity, entry and protocol. A trusted `SMOKE24_BASE_TAR` can supply a baseline absent from local history. [Privileged archives](../verification/archive/README.md) remain nonexecutable until system writes have isolated resources and cleanup contracts.

## Existing Capability Evidence

Real process/storage/OS evidence is distinct from real model/platform evidence. Unless explicitly named, models and IM/GitHub/MCP services below were substitutes. Linux means isolated tx exercises, not a production switch.

| Original work | Maintained test reference | Historical real evidence and limitation |
| --- | --- | --- |
| 01 product entries | `test/71-product-entry.test.ts` | macOS concurrent bins, independent stop and product-directory rejection; mock models |
| 02 on-demand backend | `test/72-on-demand-backend.test.ts` | macOS process/socket/SQLite/PTY start/reuse; manual IME/resize incomplete |
| 03 execution boundary | Container worker/probes | macOS Docker VM and tx files/processes/network/UID; old dedicated-account policy |
| 04 development execution | `test/73-desktop-execution.test.ts`, `test/07-real-tools.test.ts` | Both platforms' container edits/checks/approvals/stopping; later current-account evidence is separate |
| 05 workspace/conversation | `test/74-workspace-sessions.test.ts` | macOS actual bin/directory identity/control/history |
| 06 workspace settings | `test/75-workspace-settings.test.ts` | Two workspaces, revision conflict, revocation and restart; no external model/MCP/Jev |
| 07 legacy organization | `test/76-legacy-workspace-data.test.ts` | Both platforms' preview/apply/revert/restart and exact history/artifact bytes; no scope expansion or sync |
| 08 IM approvals | `test/77-im-approvals.test.ts` | Real backend/approval/outbox recovery, simulated OneBot/Bot API |
| 09 service management | `test/78-linux-service-management.test.ts` | tx actual systemd/sudo/helper/restart and identity rejection; inspection/allowlisted restart only |
| 10 standing grants | `test/79-standing-permissions.test.ts` | tx save/use/revoke and unknown-effect invalidation; no real-platform rate limit/redelivery |
| 11 delegation | `test/80-subagent-delegation.test.ts` | Both platforms' JSONL/container reads, responsive parent and delivery; mock model/IM |
| 12 reuse/close | `test/81-subagent-reuse-close.test.ts` | Stale scope rejected after reuse, CLI closure/history retained; approval does not carry over |
| 13 work messages | `test/86-subagent-messaging.test.ts` | Bidirectional source-bound/idempotent messaging, CLI/restart; joining limited to read-only work |
| 14 whole-work cancellation | `test/82-subagent-cancel-work.test.ts` | Actual container stop, unrelated work continues, late facts retained; not Agent closure |
| 15 restart | `test/86-subagent-recovery.test.ts` | Initial macOS container/SQLite/CLI recovery; crash shapes partly SQL-seeded; later Linux smoke separate |
| 16 parallel worktrees | `test/83-subagent-worktrees.test.ts` | Two actual copies, parent unchanged, read-only shared Git and non-Git serialization; no child commit/push |
| 17 integration | `test/84-subagent-integrate.test.ts` | Real Git/container idempotency, zero-write conflict, retrieval after cancel/close, parent itself a worktree; no implicit commit |
| 18 owner final reply | `test/84-im-final-delivery.test.ts` | Both platforms' container/outbox/offline/rebinding/SIGKILL; simulated model and IM |
| 19 PR review | Tests42–46 | Actual backend/container/revision/recovery; simulated GitHub/MCP/notifications; no comment conversation |
| 20 group retirement | `test/85-retire-core-group-chat.test.ts` | Old code produced real records, then upgrade/finalization/idempotency; no real group/NapCat |
| 21 Coding import | `test/85-legacy-instance-import.test.ts` | Both process smokes; representative macOS old-profile import/read/revert; no tx production DB, no credential import |
| 22 old Personal import | Retired Personal-import test86 | Process smokes and representative macOS data; platform offsets/handoff simulated, no tx production DB; no longer a current Personal operation |
| 23 fixed-role retirement | `test/87-retire-coding-role.test.ts` | Two-version bins, SIGKILL and old-task finalization; old CHECK/role identifiers remained readable |

## Installation, Upgrade and Cutover

Coding installs the complete workspace and builds workers/supervisors, configures models, then opens a directory. Legacy import is preview→reviewed plan→apply→receipt verification; newer target facts can block revert. See [usage](usage.md#61-import-a-legacy-instance).

Personal deployment starts a new durable directory with explicit credentials/native/helper configuration. Old profiles stay archived, never resumed/imported. Production cutover separately verifies old services/independent units stopped and fixes platform boundaries. Code rollback uses another blank profile rather than replaying old inbound/send/schedule backups. Both products upgrade independently; history and unknown effects remain.

## Acceptance Boundaries

Later current-account full-access evidence covers both products on macOS and tx Linux: actual runtime/SDK/worker, starting UID/GID, inherited user environment/synthetic credentials, outside-workspace reads/writes, local HTTP, normal/attributed-descendant stop and retained unknown stopping after forced worker death. Models were mocked, credentials synthetic and production deployment unchanged. Restricted native file/network denial was also verified. See the [full-access decision](../.agents/notes/implemented/feature/2026-10-12-full-access-current-account.md); old dedicated-account evidence describes only its original design.

First-phase history did not establish real QQ/Telegram approval formatting, rate limits/redelivery, original-entry asynchronous delivery or tx production cutover. New Personal evidence/residual gaps belong to current work tracking. Automated PTY does not establish every Linux IME/resize/reconnect interaction. Do not mark these passed without matching environment and candidate evidence.

## Historical Verification

The compact ledger retains distinct measured conclusions without treating superseded command behavior as current instructions. Detailed original assertions/commands remain in the historical baseline described at the top.

| Date / check | Environment | Recorded result and important limit |
| --- | --- | --- |
| Early offline integration | macOS Node24.15/local | 43 checks: concurrency16, tools3, approvals11 (crash/DNS/migration), artifacts5, modes/auth8; passed |
| Early history/TUI batch | macOS mock model/fake terminal/PTY | 37 new checks,81 including regressions; passed. Manual80×24, Chinese IME candidate/resize details only partly checked |
| 2026-09-21 Linux end-to-end | tx real deepseek-flash/container | CLI submit→execution→artifact→status passed; target-machine manual TUI reconnect not run |
| Early model connectivity | macOS | Not run in that batch; missing credentials skip, not pass |
| SQLite v1→v2 | macOS | Transaction/reopen passed: old tasks default confirmation, old approvals stale, history/events retained |
| Historical Docker probes | Docker Desktop VM |32/32 with readiness/completeness; not current native proof |
| Container worker smoke | Docker Desktop / tx |9/9 initial; tx2026-09-26 13/13 including four same-path mount checks, UID/GID1003 |
| 2026-09-21 real Coding | tx Ubuntu24.04, deepseek-flash | Confirm-mode container writes owned by UID1003; separate `test:model` command not run |
| Dedicated execution account | tx systemd255 | sudo/UID986/env/cgroup/injection rejection/idempotent stop passed; corrected inverted exec-stop exit convention. Sep26 real full-access checked ruukoto-exec, ACL/Git/HOME, denied owner token and inactive final unit |
| Shared Git mount | tx | Grant validation/idempotency and same-path read-only grant tested; initial shared-worktree metadata case not separately tested |
| Host prerequisites | tx Ubuntu24.04/Linux6.8/Docker29.5.2 | Sep21 probes32/32 plus worker9/9; Linux bind mounts required matching workspace UID permissions |
| Old GitHub module | macOS | Original19 checks retired. Replacement retirement4 cases covered v8 migration, stale approvals, publication terminal state, secret-free archive, idempotency, inaccessible old ops, preserved credentials/history |
| 2026-09-21 offline suite | tx Node24.21 |125/125 across17 files. Fixed PTY descendant-pipe hang with detached process-group cleanup; macOS regression also passed |
| Real GitHub MCP/Tavily | Owner credentials required | Not verified; simulated APIs never counted as real connectivity |
| Web Search batch | macOS mock Tavily/real host/runtime |9 new cases,184 total with0 failures/1 gated-model skip; defaults/source/time, quota5, frozen/narrowed scope, HTTP/errors/oversize, no timeout replay, injection bounds/redaction and schema6→7 |
| Old QQ group entry | macOS mock OneBot/model, real adapter/runtime |20 cases passed across identity/reconnect/dedup/FIFO/expiry/withdrawal/no-unknown-replay/context isolation; no real group/NapCat/Linux deployment, later retired |
| Group retirement | macOS real runtime/SQLite/socket, v24 seeded archive |6 acceptance cases; no new group work, private/TG retained, archive isolation, revoked/tampered sources and idempotent finalization over3 starts. Old-code Linux upgrade recorded separately; no real group |
| 2026-10-05 SubAgent recovery | macOS mock/local with SQL-seeded crash state |3/3: queued interruption/no replay, retained occupancy/pause, explicit resume and host-fixed-review exception |
| 2026-10-05 recovery smoke | macOS actual container/CLI, mock model |8/8; preserved occupancy despite backend_restart pause, no residual containers; not real IM or unseeded crash evidence |
| 2026-10-02 product entries | macOS actual bins/socket/SQLite |14/14 suite and10/10 manual process smoke; independent stop, environment/product mismatch |
| 2026-10-02 on-demand startup | macOS actual bins/socket/SQLite, mock model |8/8 including concurrent slow-winner reuse, startup-log/auth diagnostics, client exit and replay; real PTY no-model smoke5/5 |
| 2026-10-02 container boundary | Docker Desktop29.8.0/Linux VM aarch64 |16/16 for each of `/var/folders` and `/Users`; real compiler/process/network/UID/read-only/capability/same-path/descendant controls |
| Old macOS Seatbelt probe | macOS27 arm64 |Oct2 “file rules not executed” conclusion corrected Oct8: `/tmp` vs `/private/tmp`; not evidence Seatbelt filesystem denial is impossible |
| 2026-10-08 native candidates | macOS27/Darwin27/arm64, txUbuntu24.04.4/x86_64 |macOS detached posix_spawn/launchd reclamation failed; NOTE_TRACK ENOTSUP. Linux `/tmp` bwrap had2 host controls pass and35 unavailable/exit2 before sandbox startup; no policy change |
| 2026-10-04 parallel worktrees | macOS Docker29.8 and txUID1003 |9/9 each: actual concurrent branches, unchanged parent, readonly Git metadata/hooks, non-Git serialization and zero residues; changing bundled worker required image rebuild |
| 2026-10-05 integration | macOS/tx real Git/container, mock model |7/7 each: add-N/diff/check/apply without changing parent HEAD, one event/idempotency, zero-write conflict, post-close retrieval, nested-worktree shared-Git mount and no residues |
| 2026-10-02 deployment recheck | tx Linux6.8.0-117/Docker29.5.2/systemd255 |32/32; mechanism hashes matched Sep26 snapshot except display-only worker change; active old backend, execUID986/containerUID1003,0600 token and wrappers verified |
| 2026-10-02 product execution | macOS/tx actual container, mock model |smoke04 6/6 each; then-current default-container tests73 4/4 and07 5/5. These defaults are superseded |
| 2026-10-02 macOS full access | macOS |Unverified under the old dedicated-account design: same-account0600 token was readable and no verified local wrapper existed. The later current-account decision changes that policy explicitly |
| 2026-10-02 workspaces | macOS runtime/socket/SQLite/fake terminal, mock model |15/15 plus actual-bin smoke6/6: real directory identity/aliases, distinct same-name roots, multi-repository roots, idempotency, legacy claims/protected roots and history |
| 2026-10-03 service offline | macOS mock IM/model/helper with production-shaped protocol |22/22: original approvals, rejection/tampering/no execution, identity/product/config/platform guards, revisions, duplicate claims, unknown effects, partial artifacts and post-status failure retaining command result |
| 2026-10-03 service real Linux | tx systemd255/sudo/helper/test service, mock IM/model |14/14 across3 idempotency runs, last on final source. Verified one restart/approval, account/policy/token denial, stale unit revisions, infrastructure rejection and kill9 unknown-effect recovery. Replaced broken sudo fd3 protocol with prefixed stderr reply |

Native follow-up details, including later Linux52+2 pass and macOS retained-unverified outcomes, are maintained in the [native probe guide](../verification/foundation/scripts/native-isolation/README.md). They do not erase earlier failures or remove the need for current product acceptance.
