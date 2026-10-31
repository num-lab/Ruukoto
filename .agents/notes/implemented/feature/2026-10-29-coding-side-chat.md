# Agent Note: Run tool-free side chat under a distinct host-owned Coding identity

Status: implemented

## Problem

The owner needs a persistent multiround side discussion while the main Code task continues. A normal branch freezes history but switches user sessions, competes for cwd occupancy, and permits project history/memory/coding tools. It cannot provide the requested isolation/concurrency merely by appearing in an overlay.

## Decision

### Identity and snapshot publication

Persist parent ordinary Code session and child in `side_chats`, unique by both parent and side ID. Named `side` identity is neither ordinary dev nor SubAgent. Queries/events/reconnect snapshots expose the binding; messages/task parameters/mode choices cannot create or alter it. Only ordinary Code sessions create side chat; no nesting or ordinary branching from side chat.

First `/side` captures a safe source prefix through [branch snapshot](2026-10-11-branch-session-snapshot.md) parsing/provenance/file-preparation/publication, sharing `snapshotSources` and `prepareSessionHistoryFile` without a general session-derivation framework. Uniqueness also covers prepared receipts: two clients cannot pin different snapshots and race publication. Retry uses the original prefix; a new open request for an existing side chat returns its original binding.

Fsync preparation before atomically publishing session/binding/completed receipt/event in SQLite, then respond/broadcast. Files and SQLite are not atomic; recovery verifies the receipt's original file rather than resnapshotting current parent history. Empty source gets independent empty JSONL. Complete malformed lines or missing published history fail explicitly, not partially publish or silently recreate.

### Tool-free execution and context

Reuse Driver, SDK session, task ledger, streaming, compaction, and usage. `SESSION_TOOL_CATEGORIES.side=[]` and explicit SDK `tools: []` install neither default tools nor MCP; routing rejects by identity too. The side-Q&A system prompt explains the first safe snapshot and asks the owner for missing data. Old coding instructions in copied history cannot enable new tool/work-management behavior.

Side tasks own their lifecycle but acquire no cwd or execution unit and do not reuse the conversation phase's waiting/resource-reacquisition semantics. Ordinary submit rejects `identity.kind === "side"`; dedicated `submit_side_chat` retains idempotency/model-configuration checks/cancel/terminal/restart handling while skipping coding launcher/occupancy/permission prerequisites. No generic client "skip occupancy" flag exists. One backend transaction admits at most one nonterminal side task (`side_busy`); UI keeps the next draft.

Restart interrupts queued as well as running/awaiting-confirmation side tasks without replay, unlike ordinary queues retained for owner recovery. New side input remains possible; parent pause/occupancy verification is independent. ContextSendBlocked/ContextOverflow for toolClass side does not call pauseQueue. After failure, a new explicit submit is allowed with all pre-send checks. Corrupt data/configuration/budget still fails; no automatic resend or release of abnormal execution occupancy. No side queue recovery/manual compaction command.

Each submission pins the parent's currently selected model/reasoning level; same-key replay never reselects. Side chat exposes no access-mode switch and inherits no execution capability. Provider throttling/configuration errors keep existing handling.

Context includes the fixed source history and its own later history, not a main-task continuation/checklist/result/wake relationship. `loadPinnedContext` reads no project instructions, memories, or continuation sources for side identity. Load no skills/roles, expand no `/skill`, and inject no derived checklist, Plan, or resource-phase prompt; Driver claims no parent reports/results and Jev filtering is off. Ordinary JSONL lacks original reference blocks, so inheriting safe history is not inheriting the parent's complete model input.

Side is not `restricted: true`: that disables compaction without excluding every checklist/report input. The full handleContext/assemble/prepareSend/capturePromptSnapshot/afterSend chain preserves budget/pairing/images/recording/usage under the side session's own ID. Verify actual model payload and empty tools.

### Data and client isolation

One target-session-identity policy governs Agent readability in Driver dataSessionReadable, artifact access, and AccessScope sourceRefAccessible. Apply it to broad history search, explicit session/task/entry reads, direct artifact IDs, memory provenance, and automatic injection. No separate side-memory store: empty tools prevent writes, and other Agents cannot cite side data as readable memory sources.

Create no parent-result delivery. Exclude side from ordinary session/workspace-chat/search/branch lists. Authenticated owner control still reads side history/prompt/usage. Snapshots retain sideChats bindings and side tasks for reconnect; the owner's complete event stream is not model input and must not be deleted on that assumption.

TUI reuses overlay placement and SessionView history/draft/scroll, with independent focus instead of switchSession(sideId). Ctrl+C/Esc/paging route by focus first. Side interruption targets its own task, never ordinary `/interrupt` inferred from the main view. Drafts remain editable during generation; side_busy rejects submission without losing them. Narrow terminals keep overlay/main status visible, without a new horizontal split.

`/side` parses before ordinary submit/steer and cannot send parent input, release its wait, or alter its approval. Schema 55/protocol 46 introduced persistent identity under [strict format replacement](../simplification/2026-10-24-code-instance-mcp.md): no old-schema migration or cross-instance side import. Old SQLite/JSONL/artifacts/credentials stay in place; a new profile does not silently continue old sessions.

Related history, work/SubAgent, native-execution, waiting, steering, and version decisions retain their owners. This deliberately does not borrow conversation-phase/delivery eligibility. The original side-chat keyword audit found no prior same-feature proposal to absorb/archive.

## Alternatives considered

- Overlay an ordinary branch: greatest reuse, but its tools/occupancy/project readability break isolation/concurrency. Reuse its snapshot mechanism, not identity.
- Send a temporary parent question then delete it: avoids a new session, but cannot ensure exclusion from later requests and conflicts with guidance/approval/authoritative JSONL.
- Use a SubAgent: already independent/concurrent, but delegation/result return is not direct owner conversation.
- Keep context/client model calls in memory: short path, but loses restart recovery and bypasses request keys/configuration locks/audit/backend lifecycle.
- Add read-only files/search: answers more questions, but expands tools/execution/concurrency beyond the confirmed context-only first version.
- Refresh parent context on every follow-up: stays current, but creates implicit changing input. The owner chose a fixed first snapshot.

## Consequences

The fixed snapshot can become stale and may itself be compacted under context budgets. Side history requires retention like parent history; concurrent calls add cost/provider throttling. Strict schema transition needs matching profiles/clients. Application data-read isolation is not OS secrecy against full-access tasks.

`test/127-side-chat.test.ts` covers unique/reopened binding, frozen snapshot, empty source, malformed/missing/identity-mismatched history without partial binding, tool-free payload/prompt, idempotency/conflicts, side_busy, ordinary-submit rejection, parallel parent/no queue pause, queued restart interruption, and unavailable product capability. Real TUI focus/height and real-model behavior remain pending when prerequisites are missing. Former `.scratch/coding-side-chat/spec.md` and issue 01 are offline provenance for confirmed requirements/evidence, not maintained task entries.
