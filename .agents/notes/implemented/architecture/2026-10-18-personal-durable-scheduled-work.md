# Agent Note: Personal scheduled runs own whole work through independent sources

Status: implemented

[Online IM updates](2026-10-25-personal-im-updates.md) pins handles/configuration versions for admission/report sending. Original plans retain creation-source/scope limits. [Request configuration](2026-10-25-personal-request-configuration.md) narrows request selection and continuous MCP-label compatibility; [execution configuration versions](2026-10-25-personal-execution-configuration-versions.md) owns command/service migration. Other creation-scope, permission and whole-work cleanup rules remain.

## Problem

The [Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) preserves [generic scheduled tasks](../feature/2026-10-12-generic-scheduled-tasks.md): independent context, pinned authorization and whole-work reporting. Earlier durable source checks treated every non-main tool as long-lived child work and accepted only ROOT owner input in delegation/recovery. Copying main tools or reusing old scheduler storage cannot prove source and misses unknown pauses/creation permission limits.

## Decision

Personal adds scheduler documents, entries and native Tasks, reusing only time rules from @ruukoto/channels/scheduler/time.ts. Plan, immutable version and original due time uniquely identify a run. Run admission, independent Conversation and native-Task backlinks commit together. Task/Submission remains execution authority, without old SchedulerStore or a second ledger. Plan changes cancel/recreate.

Source resolution distinguishes main owner input, scheduled runs and their derived work. A scheduled input belongs to its own Conversation/persisted entry and references plan creation source, but neither reexecutes the creation message nor fabricates ROOT pi.user. Execution, approval consumption, request evidence and recovery use the same source facts. Global evidence/management Tasks may live in ROOT; storage location is not execution source.

Plans pin creation mode, tool/material ceilings and an optional fixed report target. Later defaults, new tools/grants and child history cannot expand them. Execution still verifies current effective scope, objects and configuration/credentials. The original implementation compared complete configuration: tools/extensions, material grants, MCP, command/service policy-content fingerprints and browser configuration, excluding default mode. This conservatively stopped old plans on any change, even narrowing or unrelated material additions, avoiding a separate dynamic-intersection recovery contract. Current request-configuration rules permit only their explicitly verified MCP-label compatibility, and command/service configuration versions prevent changing back from reviving old scopes. Unprovable creation ceilings stop affected execution with queryable reasons. Approval target is separate from authorization source: schedules/children may request one-use approval at the original entry but cannot match/create/expand standing service grants.

Scheduled context has its own business tools and restricted delegation entry. schedule_create.instruction documents target actions delegate/list/result/cancel and automatic host finalization, so main does not write its own report/progress protocol into instructions. Children belong to the same run. After the first answer, the host seals membership and joins all derived work, external effects and stopping verification. Final summarization stays in that independent Conversation, with query-only input granting neither operations nor new derived work, never queued in main. Unknown facts hard-block further execution/summary; owner verification permits only evidence-supported next steps.

Each plan has at most one unfinished run. Due times during activity record a coalesced interval; after closure, scheduling resumes from future cycles. Downtime recovery with no active run admits at most the latest occurrence. Cancellation first persists rejection of new admission/derivation, then stops all admitted execution and waits for verification. Late results remain facts without reviving runs or sending successful reports. Unexpected terminal state is not external stop proof.

Summary input requests business results, failures and omissions, not evaluation of later delivery status. The host records/query-exposes sending. Run result, closure and one final-send intent commit together, with a separate durable send Task. Offline/rate-limit waiting does not occupy the next cycle. Lost responses/restart after send starts retain effect_unknown without new-key retry. Targets pin creation-time platform, account, owner and generation. No creation target means local records only; later configuration cannot add one. Before sending, recheck generation, revocation and cancellation.

[Memory/skills/history](2026-10-18-personal-memory-skills-history.md) uses the same sources. [Durable application data](2026-10-18-personal-durable-app-data.md) separately owns its native-source and dual-database receipt recovery. A source interface does not establish capability-combination acceptance. Original implementation, independent review and external evidence are offline at `.scratch/personal-pi-durable/issues/32-scheduled-work.md`.

## Related decisions

[Personal conversation background processes](../feature/2026-10-21-personal-background-processes.md) starts only from actual main owner sources. Schedules explicitly exclude process tools; source scope includes shared directory-claim version without expanding permission.

The original implemented/proposed audit searched scheduling, Personal durable, sources, permissions and whole-work reports; rejected notes had no same-topic match. Migration/generic scheduling retain product/time/delivery decisions; this note owns durable wiring. [Background work](2026-10-17-personal-background-work.md), [child services](2026-10-17-personal-subagent-service-operations.md), [general tools](2026-10-17-personal-tools-access-artifacts.md) and [browser/media](2026-10-18-personal-browser-media.md) extend to scheduled sources while retaining their own mechanisms. No note was wholly absorbed, deleted or archived.

## Alternatives considered

- Execute/delegate under the plan creator's main input: tools work directly, but each occurrence impersonates new owner input and can leak defaults, main context or old one-use approvals. Use independent verifiable sources.
- End runs on first answer or explicit report: less host code, but omits unfinished children/unknown effects and allows a missing model call to skip cleanup. Host seals and finalizes whole work automatically.
- Explain actions only in scheduled context: correct target tools, but main can still write its own completion protocol into creation instructions. Explain target actions/sealing at schedule_create.instruction without new tools or rewritten plans.
- Wait for delivery before another cycle: simpler run/delivery story, but offline platforms stop completed business from recurring. Commit closure/send intent together and recover delivery separately.
- Reuse old SchedulerStore/Runtime/outbox: complete features, but two Personal execution authorities and old protocol dependencies contradict the migration. Reuse stateless time calculation/transport only.

## Verification

Actual assembled-request regressions inspect main creation parameters, independent-summary body boundaries, four-action tool definitions and persisted input/payload. One-child/local completion follows the production scheduler chain. Original evidence/pending checks cover time/DST, missed cycles/restart deduplication, independent main chat, all derived work, unknown/canceled/late outcomes, frozen creation scope/revocation, no standing grants, fixed approvals/reports and real models/original IM. Before recovery, bidirectionally audit plan/run/task/conversation/submission/source and immutable admissions; missing or unsupported versions reject execution. Missing source, cancellation, exceeded permissions and failed request evidence need counterexamples with zero provider/external calls.

## Consequences

Independent sources reuse delivered tools/stopping proof without new dependencies or legacy execution ledgers. Adapting a shared helper does not replace checking each recovery consumer. Browser process identity, bindings, screenshot ownership and human pauses must isolate actual conversations. Full access retains backend-account authority; snapshots cannot reclaim escaped processes/external services, and unknown stopping/effects retain occupancy. Missing combined 33/34 or real-platform evidence leaves acceptance pending without lowering complete migration requirements.
