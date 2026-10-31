# Agent Note: Personal background work occupies long-lived independent conversations

Status: implemented

## Problem

The [Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) requires a responsive main chat, reusable long-lived SubAgents and cancellation without identity closure. Giving a one-shot tool Task ownership of Conversation ties context lifetime to cancellation. Queueing another work item directly into the same child also lets Conversation.abort cancel the wrong input.

## Decision

The trusted host manages background work through openPersonalHarness().work. A SubAgent identity is an ownerless Conversation. Each delegation is a main-owned background ruukoto.background-work Task linked through the ruukoto.subagents index. Identity creation, explicit configuration, Task registration, source and occupancy commit together. A work key's SHA-256 pins content, source, target and label: same-key/different-arguments fails; repetition returns original work. Originally the source had to be an owner's native input already placed in main, never a queued input or report; the scheduled-source extension is described below. The index records identity, closure and occupancy, not duplicate Task execution state.

The initial child configuration explicitly installs personal-subagent prompts, the personal-background-work task extension and no tools. Long-lived context is not external-execution permission. [Model work](2026-10-17-personal-model-work.md) adds source checks, queries and cancel/close to the same transaction registration. [Host menus](2026-10-17-personal-work-controls.md) provide independent IM/CLI controls; [additional instructions](2026-10-17-personal-work-notes.md) remain within the original work's rounds. Later capability decisions, not this initial empty-tool configuration, authorize child tools and automatic reporting.

Work Tasks use native admission with personal-work:<taskId>, save the Submission reference and wait. Admission cannot share the host registration commit; recovery uses the original key across that window rather than adding a queue/state machine. Task/Submission directly supplies progress/results, and the answer stays in the original child conversation. Completion retains identity/context; closing records closure without deleting history.

Cancellation first commits a ruukoto.work cancellation fact. Waiting and recovering Tasks observe it; model tools/trusted APIs can additionally call native abortTask. Both paths stop the target Conversation including background compaction. Normal-answer/failure cleanup also stops remaining background execution. Only verified conversation stopping permits comparing occupancy against this Task and releasing it in the same terminal Task commit. A cancellation committed before abortTask still ends aborted; an identical checkpoint cannot be used to demand upstream rescheduling. Unexpected faults preserve occupancy; terminal state is not stopping proof.

Provider prepare and onPayload uniquely locate the actual Conversation through persisted ProviderDoc.sessionId and recheck active occupancy/cancellation in the same evidence commit. Missing/ambiguous sources or idle/closed/canceled child identities reject requests, without relying solely on a skippable beforeRequest hook. Each conversation owns its generation/compaction evidence. Before recovery, verify document versions, bidirectional identity/conversation and work/occupancy/native-Task relationships and sources. Old profiles without work support gain the extension only when no inputs/tasks are pending. Idle model synchronization updates every long-lived conversation; pending work rejects model changes.

## Later capability and source decisions

[Child inspection ownership](2026-10-17-personal-subagent-inspection.md) first replaced part of the empty-tool boundary with fixed read-only checks. [Child service operations](2026-10-17-personal-subagent-service-operations.md), [durable commands](2026-10-17-personal-durable-commands.md), [durable MCP](2026-10-17-personal-durable-mcp.md) and [tools/access/artifacts](2026-10-17-personal-tools-access-artifacts.md) subsequently define other configured tools. Empty tools describes the initial slice or a child with no enabled capabilities, not the current product-wide limit. Work lifecycle, source authorization and actual stopping proof remain required.

[Scheduled work](2026-10-18-personal-durable-scheduled-work.md) extends the original source restriction to actual independent scheduled inputs. ROOT still owns Tasks; children inherit no standing authorization. Every request/recovery verifies original schedule admission. Sealing after the first answer forbids new derived work; the run releases only after actual execution, unknown facts and stopping proof are settled.

## Related decisions

The original audit searched durable, long-lived SubAgents, background work, cancellation and ProviderDoc. The [migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md), [profile foundation](2026-10-17-personal-durable-foundation.md), [local management](2026-10-17-personal-local-management.md) and [service inspection](2026-10-17-personal-service-inspect.md) retain their separate decisions. [Shared delegation](2026-10-03-work-delegation-subagent-task.md) and [restart recovery](2026-10-05-subagent-restart-recovery.md) remain in the shared foundation, not transplanted into durable. The [background Bash proposal](../../proposed/feature/2026-10-14-bash-background-lifecycle.md) owns OS processes and is unrelated to this initial model-work slice. No note was wholly absorbed or marked for archive.

## Alternatives considered

- Build a generic unknown-effect framework first: prepares for every write tool, but without consumers obscures real receipt/permission differences. Establish ownership with model work, then integrate actual writes.
- Let the tool Task own the child: automatic cancellation and less code, but no identity lifetime across work. Use an independent long-lived conversation and explicit current-work cancellation.
- Wait only for ordinary idle: follows upstream defaults and saves a stop, but background compaction can cross into the next work. Stop across background work before atomic occupancy release.

## Consequences

Durable still owns work/history; main does not wait for background Tasks. Single-work occupancy makes cancellation precise and original-key recovery avoids guessing duplicate admission. The cost is more business relationships and recovery checks. Broken relationships preserve occupancy and reject recovery; deleting an index cannot bypass them. Initial empty-tool cancellation checks prove model/framework stopping, not OS descendants or external effects; later capability-specific evidence is required for those.

Original acceptance and uncovered scope remain offline at `.scratch/personal-pi-durable/issues/05-background-work.md`. Full migration, product interaction and deployment remain separate acceptance obligations.
