# Agent Note: Child service operations belong to original work and recover under original authorization

Status: implemented

## Problem

[Child inspections](2026-10-17-personal-subagent-inspection.md) are read-only, while [service operations](2026-10-17-personal-service-operations.md) originate independently from trusted host APIs. Wrapping host request directly loses child-tool ownership. Existing cancellation waits for inspections, not proof that restart stopped.

## Decision

Delegate only the existing restart operation and original-evidence reads; main accesses them through delegation. The service Task belongs to original WorkTask in the same root conversation, not the short-lived tool. Native durable owned-task waiting/cancellation handles it. A terminal Task is not external stopping: work release still verifies unknown effects, original launcher/command-unit stopping and pre-approval inspections. Unknown-operation recovery verifies original identity without resending restart.

Tool admission and service Task commit together, pinning tool/execution generation, current child input, mapped owner source, work and original permissions/entry. The tool Task determines request key. Cross-turn instructions cannot change delegation permissions; persistent context is not authority. Before execution, verify original work active/not canceled, group not paused and entry active. Approval/standing-authorization consumption retains the service contract. Recovery checks immutable admission and original assistant toolCall bidirectionally; deleting child relationships cannot turn the operation into a legacy host request.

Normal work completion joins child conversation and service Tasks. Cancellation first persists work/owned-service cancellation, then stops both. Faulted service Tasks retain unknown occupancy until effect/stopping facts permit cleanup. Whole cancellation/reporting waits through member WorkTasks; independent host service operations are not automatically grouped. Original-source gates cover other members, append and continuation while main/independent work continues.

Tools wait internally for approval and return final results. Return/evidence pages share original mode, approval basis and consumption fact. A manual approval that creates standing authorization remains manual for this operation; only a later automatic match reports standing authorization. Terminal results omit the wait itself, so executed does not imply approval-free execution. No duplicate approval records or wait timing is added; existing persisted fields and tool results reconstruct the facts.

Canceling before approval consumption can leave a generic interrupted tool result even when the service record proves non-execution. Identity reuse preserves this history; the model must not infer unknown effects from that text alone. Tool returns, evidence reads, work results and summaries share a current service-fact projection: original effect/code, approval consumption, effect/original-launcher stopping verification and whether verification is still needed. launcherStopped=false alone does not mean whole-work stopping is unverified; original work and pre-approval inspections are independently verified.

Child requests supplement only this identity's service results already present in current input. Ownership follows the original terminal tool result entry and exact actual toolResult comparison, not callId that can recur across generations. Compacted-away operations and other identities are not injected. Results not matched to service operations still verify this identity's original terminal tool, result entry and assistant; original pre-admission errors are allowed without injected operation facts. Unknown/ambiguous call references reject before provider. Input/payload evidence retains the projection without overwriting old tool results/answers. Facts inherit no old approval, clear no unknown occupancy and authorize no rerun. Main summaries query these facts by original work rather than prioritizing generic interruption text over host-verified outcomes.

Local service details may approve once or reject only the original pending operation. Telegram still requires its original menu; local controls cannot decide on its behalf. Child pre-approval inspection admission and approval consumption separately check work/group pauses transactionally; preflight is not the cancellation gate.

The new extension exists in main and child configuration. Idle profiles upgrade atomically; pending old work rejects upgrade, and missing extensions make old code reject recovery. No duplicated execution state, helper protocol, shared package, command or dependency is introduced.

## Related decisions

The original active-note audit searched Personal durable, child service, fixed read-only checks, service cancellation and unknown effects. Migration, background/model work, inspection ownership, service configuration/operations and owner recovery retain separate decisions. This supersedes only their no-child-service-writes restriction. Native execution and Coding service callers remain separate consumers. No note was wholly absorbed or invalidated.

[Scheduled work](2026-10-18-personal-durable-scheduled-work.md) permits sources mapped to independent scheduled input with pinned original mode/IM target. Schedules/children neither match, create nor restore standing service grants. One-use approval still verifies original admission; full access skips per-operation approval according to its original mode.

## Alternatives considered

- Call host request directly: maximum reuse, but it knows only root source and cannot prove actual child tool/original-work permissions or join member cancellation.
- Make the child tool own the service Task: direct cleanup, but tool/service belong to child/root conversations and tool cancellation cannot retain long-lived work/unknown facts.
- Keep independent background service plus a work index: preserves old records, but needs custom cancellation/waiting; native same-conversation task ownership already supplies it.
- Rewrite old results or inject every identity's history: rewriting confuses historical/current facts; full history adds irrelevant context. Refresh only located current-input results and query original operations.

## Verification

Original permissions, original-key recovery, cancellation windows, no replay of unknown effects, immutable admission and complete input evidence are covered by the offline `.scratch/personal-pi-durable/issues/21-subagent-service-operations.md`.

## Consequences

External effects and SQLite remain non-atomic; even consumption before dispatch conservatively pauses after interruption. Real systemd, IM and owner experience require separate verification, not offline substitutes.
