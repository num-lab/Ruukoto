# Agent Note: Personal analysis delegations own cross-turn membership and cancellation

Status: implemented

## Problem

[Model background analysis](2026-10-17-personal-model-work.md) and [additional instructions](2026-10-17-personal-work-notes.md) manage individual executions, not multiple analyses and continuation within one delegation. Closing the whole delegation when the original input is answered forces later main-Agent work into a new delegation. Canceling one member is not whole-delegation cancellation.

## Decision

A durable document stores original owner input, original permissions/fixed entry, member work references and irrevocable whole-delegation cancellation. Existing WorkTask/Submission and child occupancy remain authoritative for execution, progress and stopping proof. The first model delegate creates/joins a delegation from the unique current original input. Across turns, the model references a known delegation; the host verifies that current instructions still come from the original entry and pins original authorization. Current instructions are independently recorded for recovery and unknown-effect pauses. Historical and trusted-host individual work is not grouped automatically.

Members and native execution register transactionally. Whole cancellation marks all members in one transaction; existing work observers join child conversations/background compaction and preserve occupancy if stopping is unverified. Continuation, append and provider checks enforce whole cancellation and unresolved service effects from every member instruction source. New instructions cannot expand old delegation permissions. Main and other delegations continue. Control-plane/Telegram delegation menus remain distinct from individual-analysis menus.

The model interface distinguishes persistent agent identity from delegation. When the owner explicitly assigns independent new work this turn, main may reuse an idle, open agent with verified stopping and omit delegation to create a current-turn delegation. Canceled/sealed original delegations still reject continuation/append. Descriptions, fields and cancellation errors explain this conditional path so the prohibition on retrying unknown old effects does not become a ban on independent work. Source, occupancy, permission and unknown-effect checks remain: new delegation cannot resend original work.

Delegation transactionally appends immutable ruukoto.analysis-admission, pinning tool, work, delegation, original input, current instructions, permissions and entry. Grouped additions pin original instructions with ruukoto.work-note-admission. Merely proving an instruction is a valid old pi.user or predates the tool does not establish that it is this call's instruction; recovery compares admission fields individually.

A new extension name prevents old code recovering new relationships. Recovery checks original input, permissions, fixed entry, members, instruction sources and tool calls bidirectionally, without guessed ownership. [Final reports](2026-10-17-personal-delegation-reports.md) summarize after main explicitly seals the delegation and pin the original entry. Individual completion/analysis cancellation alone does not establish complete business delivery; external-tool ownership requires its own capability implementation.

## Related decisions

The original active-note audit searched durable, delegation, cancellation, source and final reports. [Migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md), [background work](2026-10-17-personal-background-work.md), model work, additional instructions, [host controls](2026-10-17-personal-work-controls.md) and [service effects](2026-10-17-personal-service-operations.md) retain their individual-work, authorization and stopping rules. Shared delegation/reporting remains for Coding. No note was wholly absorbed or invalidated.

## Alternatives considered

- Seal and send a read-only report when the original input is answered: easy automatic cleanup, but prevents cross-turn arrangement. Persist ownership/cancellation first and add final reporting separately.
- Add a parent Task and reparent every member: native owned abort is available, but changes WorkTask recovery/lifecycle. Reuse cancellation observers and create a coordinator only when reporting needs one.
- Recover instruction links from latest pi.user/order: no extra entry, but another valid old input could pass. Record immutable evidence in the active-input verification transaction.
- Infer historical membership from common source/latest input: fewer relationships, but conflates independent work. Preserve historical and host-created individual work unchanged.

## Verification

Multiple members/cross-turn continuation preserve original authorization. Whole cancellation handles registration/finalization races without affecting other delegations or closing identities. Another member/new instructions cannot bypass unknown service effects. Missing relationships reject recovery before a request. CLI/Telegram original-entry menus and model tools share facts; input snapshots contain actual new tool text. Original evidence is offline at `.scratch/personal-pi-durable/issues/13-analysis-delegations.md`.

## Consequences

Analysis members continue across turns and cancel together using native progress/stopping facts. The cost is bidirectional member/instruction relationships and immutable admissions, not another execution state machine. Independent host service APIs are not automatically grouped/canceled with analysis; [child service operations](2026-10-17-personal-subagent-service-operations.md) separately gives child-owned services their WorkTask relationship. Final reporting follows the linked decision; complete external permissions and product acceptance are not established by this slice.
