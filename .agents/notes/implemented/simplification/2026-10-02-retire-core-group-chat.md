# Agent Note: Retire core QQ group chat and retain read-only historical records

Status: implemented

Original identifier: ADR 0014; core retirement supersedes the original group-chat design recorded below.

## Problem

Built-in chat mapped login-account/group pairs to qq_group sessions inside core. Main had to explicitly accept a fixed result snapshot before notification. This coupled group chat to Runtime, data scope, and sending, while [two products](../architecture/2026-10-02-two-agent-products.md) chooses an independently optional group extension that owns sessions/history/sends and can stop without affecting main.

Retirement must preserve four things: historical session/inbox/outbox/inbound/acceptance evidence and revocation; safe cleanup of queued/running/unstarted/pending/unknown work without replay; pre-send provenance checks for existing accepted-result references; and group-data isolation independent of role rows, so archives cannot become ordinary sessions or source-access bypasses.

## Decision

Core group retirement was delivered by historical agent-direction issue 20; role/type/tool contraction by issue 23. Current new personal entry/strict profile policy is separately owned; this note describes retained legacy records and safety, not a promise of old-profile migration in the new durable product.

### Stop collecting and executing group content

Only main is bootstrapped in orchestrator ROLE_DEFINITIONS. New instances have no chat role; old agent_roles rows remain archive identifiers. Remove chat prompts/tool category, Driver/context qq_group branches and recall filtering, and QqStore group writes. Keep actual historical AgentRoleId.chat, storage CHECK values, and qq_group kind. Owner QQ private/Telegram behavior is not changed by group retirement.

The formal extension remains future scope: independent, optional, possibly same repository, not a SubAgent. Its interface/result integration is not designed and no code was moved into it. Core retirement/record protection does not depend on its delivery.

The QQ adapter handles owner-private messages and group_recall only. Group messages create no inbox/session/task/reply/body storage/per-message log; core no longer collects group content. message_sent self echoes, request events, and meta events also create no tasks.

Observe group_recall only for existing historical inbox rows: set recalled=1/recalled_at idempotently, never cancel/dispatch/reply. Unknown messages are not claimed known-recalled. Recall can only be observed while NapCat is connected and the account remains in the group; disconnected/left-group recalls have no compensation.

Remove allowed-group writes. Protocol v14 removed qq_group_update and rejected incompatible clients; legacy CLI `ruukoto qq group add|remove` and TUI `/qq groups` only report retirement. Remove configuration-center group UI. Keep qq_config.groups as historical display data in qq status / /qq. qq_configure/qq_set_enabled/status apply to private entry; max_reply_chars still caps private replies. queue_ttl_ms has no reader and leaves the configuration type, while the old column remains without migration. These are historical shared-entry interfaces, not new durable commands.

### Archive access and identity

Keep qq_sessions mappings, qq_group sessions/history, qq_inbox status/recall/time/reply/config associations, qq_outbox sends, group inbound events, chat tasks, and chat_result_acceptances in place without deleting/rewriting bodies. Existing owner APIs suffice: qq inbox / qq_inbox_list adds acceptance (time/accepting task/reason/snapshot) and sourceProblem (null if valid, otherwise missing/inconsistent archive/main unavailable/recalled). Unaccepted rows have both empty. If main is missing, show any task acceptance and an explicit unverifiable-main reason, not unaccepted/usable. qq outbox lists sends and owner read_history reads group history.

Central session identity marks qq_group and chat-role sessions retired with core_group_chat_retired. submit rejects invalid_state with historical lookup guidance; continue goes through submit and also rejects. createSession exposes no kind and creates ordinary dev only; role projects or projects containing non-dev sessions reject ordinary creation. open_workspace/root migration use the same exclusion for all role/group projects, not just chat, preventing a dev session from reading group raw history under that project identity. A dequeue guard cancels any queued retired-session task that somehow bypassed admission.

### Idempotent startup cleanup, never replay

Cleanup runs every startup without a one-time flag, changing only nonterminal rows. Generic recover first marks running tasks interrupted, with unknown effects/no replay and no continued group execution. After retireGitHubModule and before orchestrator.start, retireLegacyRoles transaction marks pending group sends unknown and corresponding inbox reply_unknown; cancels queued group tasks with core_group_chat_retired; and marks other nonterminal registered/queued inbox, including completed-but-unreplied work, skipped without sending.

Orchestrator startup drops every un-dispatched qq_group inbound event, records inbound.skipped, skips inbox, and cancels nonterminal task. Existing sweepPendingResults reconciles results; no parallel cleanup mechanism. Existing sends never resend; late receipts record facts only. Repeated starts do not mutate already-terminal outcomes.

### Accepted results remain a narrow exception

Main-only chat_result_list/accept works only on archived completed chat tasks with recorded results. list returns source metadata (task/event/account/group/message/completion/accepted), not group body or result text. accept saves a bounded snapshot from that task's final answer, at most 1000 Unicode characters, with source task/accepting task/host operation/reason and chat_result.accepted event. It does not collect untriggered group content or copy history.

The exception exposes only that fixed snapshot to main; raw group history/artifacts/group-sourced memory remain denied. Coding and SubAgent references cannot use it, including delegation. Group completion never wakes main or creates owner_reply. Main explicitly queries/accepts, then can reference `{kind:'chat_result', task_id}` in notifications and the historical notification-plan path. Acceptance is not send authority. Original per-send approval, including the former full-access exception, is superseded where specified by [current-account full access](../feature/2026-10-12-full-access-current-account.md) and [generic schedules](../feature/2026-10-12-generic-scheduled-tasks.md); source/revocation checks remain independent.

Recheck host provenance/recall at acceptance, notification approval commit, query, and pre-send. Missing/inconsistent archive, unavailable main, recalled source, or snapshot version/hash mismatch cancels with source_revoked and reason, never sends from copied text alone.

Recall conservatively invalidates if the trigger was recalled, or a recalled inbox row in the same account/group was registered before source task end and its recall time is unknown or no earlier than task start. This may reject a summary that did not actually use that message. Already-copied main history or sent material is not retroactively deleted, and unmarked paraphrases cannot be identified.

### Data boundaries and original import rules

AccessScope.isQqGroupProject uses sessions.kind=qq_group, not chat row or renameable project name. Main/retired coding cannot read group raw history/artifacts/group-derived memory even with cross-project grants; main SubAgents have no bypass. chat_result is only for main/notifications, not delegation. Owner control and owner-granted group-to-ordinary-dev access remain owner choices, not revoked by role deletion. Other identity/send restrictions never loosen automatically.

The historical [personal import](../architecture/2026-10-05-personal-instance-import.md) moved chat role/group sessions and qq_sessions/qq_inbox/qq_outbox/chat_result_acceptances with main; [Coding import](../architecture/2026-10-04-legacy-instance-import.md) excluded role/group sessions and acceptance. The later [personal entry](2026-10-18-personal-product-entry.md) does not support those old imports; do not treat this archive description as current activation guidance.

## Original group design retained for interpreting records

The removed path used selected groups, structured @ trigger, same-group FIFO, five-minute expiry, and recall handling. All groups shared an empty chat-tool policy, but each account/group had independent project/session/empty directory in qq_sessions with kind=qq_group.

Register inbox first, dedup account:group:message_id, with registered -> queued -> done/reply_failed/reply_unknown/skipped. Then source=qq_group, target_role=chat, external_id=inbox key, actor=speaker. Orchestrator used the original inbox request key and agent_id=chat, retaining recall marks. Transition to that former path verified old tasks/backfilled associations to avoid new-key duplicates; same-millisecond ties used durable registration order.

Acceptance validates precisely: agent_id=chat, completed with recorded result; session kind qq_group and matching inbox/group/session; inbound done/source qq_group/target chat with matching task_id/external_id/actor. Any mismatch rejects, rather than accepting a plausible body.

Group replies used separate qq_outbox, not public notifications. Existing send records never replayed; leftover or cancellation-in-flight sends became unknown and late receipts only added facts. Original context excluded recalled messages and, because old quotes lacked message IDs, conservatively excluded old quoted interactions after any group recall. That execution-time filter is removed because core runs no group tasks.

Historical schema v17 added chat_result_acceptances keyed by main_project_id/task_id with unique accepted_by_op_id plus accepting task/reason/summary/time, and inbox config_version/reply_to_message_id/recalled_at. Preserve existing sessions/keys/history/send ledgers. Old unknown recall times were set to migration time, conservatively invalidating summaries without changing originals. Real NapCat/QQ required separate owner-authorized validation.

## Alternatives considered

- **Keep built-in chat long term:** proven separate sessions/isolation/acceptance/recall with no migration, but retains core runtime/data/send coupling and prevents independent extension evolution.
- **Keep it behind a switch:** usable before extension delivery, but retains every inbox/session/dispatch/reply/recovery write path that the direction removes.
- **Continue inbox/log collection:** records interim group activity, but core has no use for that content and would keep collecting it despite retirement.
- **One-time retirement marker:** matches old GitHub retirement, but state-based changes are naturally idempotent; another marker is unnecessary.
- **New owner acceptance-list operation:** directly lists receipts, but each belongs to inbox and can include current validation there without new protocol.
- **Revoke owner-created group-to-dev grants:** closes all outgoing group paths, but role retirement does not authorize revoking the owner's ordinary-project/control access decisions.
- **Per-message model-read provenance graph:** precise recall impact without false rejection, but first release did not add per-context read graphs. Use the conservative time window; if false rejection matters, record actually read message IDs as a separate upgrade.

Historical offline provenance: `.scratch/agent-direction/spec.md`, issues `20-retire-core-group-chat.md` and `23-contract-legacy-roles.md`, plus the original daily-agent issue 09/personal-agent issue 07. Current source checks are in `packages/channels/src/chat-result-tools.ts`; no removed task link is treated as a live requirement.

## Consequences

Core collects/executes no new group content while preserving source/recall/acceptance/send auditability. Startup never replays group work/sends; unverified sources block external reuse and removing a role cannot widen access.

There is no group capability until an independently designed extension exists. Unobserved disconnected recalls can leave snapshots apparently valid. Conservative-window false rejects have no fresh replacement because core cannot rerun group tasks. Copies/paraphrases are not reclaimed. In-flight upgrade work is interrupted/nonresumable and completed-but-unsent messages get no reply. Compatibility types/CHECKs/kind/tools/group-config/TTL column/recall path remain as long as old records need inspection; they are not active group features.

## Verification

`test/85-retire-core-group-chat.test.ts` maps six acceptance areas: no chat boot/new group side effects; unchanged private/Telegram; archive lookup and rejected dev conversion/submit/continue/workspace claim; isolation without chat row; revoked/tampered/missing source blocks; queued/running/pending/un-dispatched cleanup stable over three starts with zero sends/models. `test/helpers/legacy-group-archive.ts` seeds pre-retirement core v24 shapes because current code cannot create them.

`test/26-qq.test.ts` retains transport/config/group identity; `test/48-chat-results.test.ts` covers metadata/snapshots/forgery/time-window/v16-to-v17; `test/49-chat-result-flow.test.ts` covers seeded acceptance/approval/recall/no snapshot-only sends. These references preserve original test strategy; current strict schemas/successors determine active applicability.

Historical offline smoke-20 generated old data with real code `e542261`, old CLI, and mock OneBot, SIGKILLed backend, opened the same profile with retirement-era code, and restarted again on macOS and tx Linux/Docker. Models/platform were mocked. Real groups/NapCat were not tested; a tx production-copy rehearsal required ruukoto-backend access and lacked owner authorization, so was not performed. This migration reruns none of these runtime tests or old-profile upgrades.
