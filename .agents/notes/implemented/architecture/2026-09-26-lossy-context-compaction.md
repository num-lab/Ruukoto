# Agent Note: Lossy model-context compaction with checkpoints and stable prefixes

Status: implemented

Original reference: ADR 0016

The checkpoint/JSONL mechanism below belongs to Coding and the former shared Personal assembly. Current Personal uses native durable history and compaction under [Personal information ownership](2026-10-18-personal-memory-skills-history.md), not this SQLite checkpoint table. Both preserve the distinction between complete history and a bounded model view. The original main/coding/dev/chat role split is historical, not a reason to restore retired roles; see [the two products](2026-10-02-two-agent-products.md).

## Problem

[Complete session history](2026-09-19-preserve-session-history.md) initially rejected lossy summaries: select complete interactions newest first within budget and evict older interactions whole. With a 1M-token model window and an estimated input allowance of about 606,000 tokens, almost nothing was evicted. Obsolete tool output repeatedly consumed attention and money. Once the budget was exceeded, dropping the oldest interaction on each call changed the prefix and defeated prompt caching across the remaining history.

Lossy processing has the same cache constraint. Rewriting each message as it gets older invalidates later cached content on every call. Transformations therefore need to be infrequent batches whose persisted results can be reused unchanged.

## Decision

This supersedes only the original refusal to use lossy summaries in [complete session history](2026-09-19-preserve-session-history.md). History remains complete, append-only and retrievable; loss applies only to the model request view.

- Non-restricted shared conversations use compaction. Restricted execution profiles, including SubAgents and the legacy host GitHub-review SubAgent, pass `compaction: null`: no checkpoint compaction and no eviction marker, with the existing whole-unit budget eviction. Retired chat, `qq_group` and fixed coding-role conversations are read-only archives. [Side chat](../feature/2026-10-29-coding-side-chat.md) has independent compaction over its frozen parent snapshot and its own later history, not live parent references.
- Each conversation has at most one active checkpoint. It stores clearing/summarization boundaries, the rolling summary and a fingerprint of the covered message prefix. A fixed checkpoint and fixed selector inputs deterministically produce the same view.
- Create a checkpoint only when the pre-eviction view estimate exceeds the high-water mark: 200,000 estimated tokens by default, capped by the input budget. Compact toward the low-water mark in one batch: clear older tool results first, then summarize earlier conversation if necessary. Whole-unit eviction is the final fallback.
- Between checkpoints, compaction does not progressively rewrite old messages. Each compaction causes one prefix change; this does not promise cache hits despite other reference/configuration changes or fallback eviction.
- Cleared results, summaries and eviction markers identify their coverage and how to recover originals with `history_read`/`history_search`. Repeat a tool only when its read is safe to repeat; a compaction marker never authorizes replaying a write.
- Use the owner's optional summary model, otherwise the conversation's selected model. Configuring another model sends the covered earlier conversation, including tool results, to that provider. A configured but unavailable model fails summarization instead of silently changing provider or cost.
- Summarization failure degrades to clearing, subject to the minimum-gain rule, without itself stopping the task. Mandatory-content overflow (`context_budget_exceeded`) and provider overflow (`context_overflow`) still stop under their existing rules, not as emergency triggers for compaction.
- Disable pi's own shared-session compaction. Its compaction entries change SDK branch messages and their selector/Jev/selection-record ordinals, and its trigger does not understand this budget or mandatory content. Reuse only its exported `generateSummaryWithUsage`; [history preservation](2026-09-19-preserve-session-history.md) owns the automatic setting and event veto. This is not the policy for Personal durable compaction.
- A summary is fallible reference material, never an owner instruction or authorization. Original owner words prevail. Summary instructions distinguish owner requirements from instructions found in tools, files and pages, so external instructions are not promoted into owner requests. Shared system text in `packages/agent/src/session-factory.ts` explains the literal product markers `[压缩摘要]`, `[已清理]` and `[较早的 … 未进入本次上下文]`, and original-text lookup.

## Mechanism

[Context assembly](../../../../docs/modules/agent-context.md#main-flows) describes the request flow. `packages/agent/src/context-selector.ts` owns pure planning/selection; `compaction.ts` owns fingerprints, entry references and summary calls; `context-assembly.ts` owns orchestration, persistence and cancellation. Historical implementation provenance is offline `.scratch/personal-agent/issues/30-context-compaction.md`, not a current work entry.

### Checkpoint storage and invalidation

`context_checkpoints` has a partial unique index for one `status = 'active'` row per conversation. Inserting a checkpoint supersedes the old row in the same transaction. `summarized_count` (S) replaces the first S conversation messages with a summary; `cleared_count` (C, at least S) clears eligible results in [S, C). The SHA-256 fingerprint covers roles, timestamps and tool-call IDs in the first C messages, relying on immutable history rather than hashing every content byte. Pi 1.3 system entries remain in JSONL but are excluded from these conversation ordinals.

Other fields retain `summary`, `summary_until` (timestamp of message S, UTC ISO), `cleared_refs` (toolCallId to original session entry ID), `cleared_results`, `summary_model`, `summary_status` (`ok | failed | none`), `summary_error`, `prompt_version` (`compaction-v2`), `usage`, `estimate_before`, `estimate_after`, `task_id`, `call_index`, `manual_request_id` and `created_at`. Automatic checkpoints identify a task/call; manual checkpoints use an independent request and null task/call fields under [manual compaction](../feature/2026-10-11-manual-context-compaction.md).

The original implementation added the table and `selection_records.checkpoint_id` through idempotent schema/column setup; schema 34 rebuilt the old table for manual provenance while retaining rows and the active index. These are historical migration steps, not permission to open arbitrary old databases: current `Db` rejects a stored schema version different from its current version.

Every call validates the active checkpoint. Fewer than C messages or a mismatched fingerprint invalidates it immediately and selection proceeds without it. A valid persisted checkpoint survives backend restart without generating another summary.

### Boundaries and thresholds

S and C fall only at complete-interaction boundaries or the start of completed batches in the current task. Let H' be the smaller of `SelectorBudgetConfig.compactionHighWater` and the input budget. The default high-water value is 200,000 and belongs to the configuration version. Low water is 0.5 H', protected tail 0.15 H', and minimum gain 0.2 H', all using existing selector estimates. Apply the active checkpoint first, then plan only when the view before budget eviction exceeds H'.

The protected tail accumulates complete units newest first to 0.15 H', retaining at least the newest batch. Mandatory units and this tail cannot be covered. Neither boundary crosses the current task's latest successful `todo_write` batch: otherwise an old checklist that ceases to be mandatory later could change its view between checkpoints. Layer one advances C to the eligible tail boundary. If still above low water, layer two chooses the smallest eligible S boundary estimated to reach it, with S no greater than C. If estimated gain, budgeting the summary at its length limit, is below 0.2 H', create no checkpoint and make no summary call.

### Clearing and rolling summaries

Layer one replaces an entire tool result in [S, C) when its text exceeds 2,000 characters or it contains an image. The product placeholder records tool name, original text length, success/error and `history_read session_id=<session> entry_id=<entry>`; `toolCallId` and `isError` remain unchanged, preserving pairing. Resolve entry IDs once when creating the checkpoint by matching tool-call ID and timestamp in the session file, then persist them. Missing/unreadable source entries produce the existing unavailable-reference placeholder, not a fabricated entry. `skill` and `todo_write` results, call arguments, owner text and assistant text are not cleared by this layer. Independent per-result view caps still apply outside checkpoint clearing.

Layer two sends the previous summary plus original messages [old S, new S). Product instructions remain Chinese: preserve paths, commands, function names and exact errors; put owner requirements and confirmed decisions in Constraints & Preferences and Key Decisions; unfinished work, blockers and next actions in Progress and Next Steps; distinguish owner words from instructions inside external material; target about 4,000 characters, merging or dropping the least relevant old entries when needed. This is a prompt-level target, not a hard 4,000-character truncation.

Resolve the model through the catalog and call `modelRuntime.streamSimple`, as auto-review does, rather than the final main-request wrapper. Supply no thinking setting or retry policy: the summary helper makes one attempt. The timeout is 180 seconds and the requested output ceiling is 16,384 tokens, capped by the model maximum; empty/error/length-limited results fail. Automatic summarization rejects a covered-input estimate exceeding the summary model's allowance. The `shortcut:` in `compaction.ts` records the missing chunked-rolling path for small-window summary models. Manual compaction adds complete-request accounting and waits for underlying cancellation under its own decision.

Stopping a task aborts summary work alongside Jev. After the wait, a stopped or replaced task makes no main-model request. Otherwise assembly reloads selection inputs because memory and other references may have changed.

### View, fallback and failures

The summary is a marked user-role reference containing S, its ending timestamp and the summary text. It follows prefix references (project instructions, skill catalog and memory), then comes any eviction marker and history [S, n), with [S, C) cleared, followed by current-task input. If S extends into the current task, its mandatory original input follows the summary; continuation provenance and plan text remain before that input. Jev only selects units in [S, n), never the summary itself.

If still over budget, retain units newest first and evict older complete interactions or current-task batches. Compaction-enabled conversations get a marker with the count and UTC ISO range. Count budget eviction only, not Jev rejection, and reserve the longest marker estimate before selection. Restricted non-compacting conversations retain their former unmarked eviction behavior.

Summary error, timeout, output limit, input limit or unavailable model keeps only layer one if clearing meets minimum gain. Persist `summary_status = failed` and the reason. Within that task, do not try summarization again until the view grows another 0.2 H': start cooldown from the post-clearing estimate if a clearing-only checkpoint was useful, otherwise from the original estimate. Cooldown is in memory, so restart permits another attempt. Failure with insufficient clearing creates no checkpoint but still records a finished compaction event with null `checkpointId`. Checkpoint persistence or invalid final request selection is not a summary-model failure and does not gain a silent fallback.

### Configuration and records

`<agentDir>/summary-model.json` stores `{provider, modelId}`, without thinking level, and participates in configuration revision fingerprints, rollback snapshots and offline configuration like `default-model.json`. `set_summary_model` accepts provider/model_id, both null to clear, and expected revision; `get_model_config` returns `summaryModel`. Save validates the catalog entry. The configuration UI shows the selection or current-conversation-model fallback, offers an unset choice and explains where conversation data goes. Online and offline paths reject deleting a referenced provider/model. This is configuration-center state, not a startup argument. Each summary reads current configuration rather than task-pinning it; an explicitly configured model that cannot resolve fails, never silently falls back. Offline saving holds the exclusive configuration lock without revision negotiation. [Runtime models](2026-10-23-runtime-models.md) owns shared configuration behavior.

Selection records store `checkpoint_id` (null for old records) and `compactionSummary` estimates, not thousands of per-message summarized/cleared exclusions. `/context` shows checkpoint coverage and time, clearing count, source task/call and summary model/failure. Reusing an existing summary with `summary_status = none` and null model is shown as inherited, not newly generated. Counts mean total S, not only this incremental summary's input; the event display shows summarized count only when a new summary succeeds. `/prompt` is unchanged.

`task.context_compaction` emits `started` before calling the summary model and `finished` when recording its outcome, including coverage, estimates and model/status. A created checkpoint and its finished event commit together. Failure without a checkpoint still finishes the display with its reason. Cancellation during the wait produces no completed compaction event; task termination changes the pending TUI row to an incomplete, task-ended result.

## Deferred chat window

The same design discussion proposed batch eviction of older QQ-group/chat messages, recovered through that group's history, with a separate decision before implementation. It was never implemented: [core group-chat retirement](../simplification/2026-10-02-retire-core-group-chat.md) made these conversations read-only. A future external group-chat module owns its own conversations/history under the product split.

## Alternatives considered

- **Use pi's built-in compaction.** It already triggers near the window limit, creates structured summaries and updates a previous summary. Its persisted compaction entries alter branch messages and selector/Jev/record ordinals, and its trigger does not know mandatory content or this budget. Reuse its summary function only.
- **Remain lossless and only evict whole interactions.** This avoids summary mistakes, extra model cost and external transmission. At a 1M window, eviction starts only after roughly 400,000 Chinese characters; stale tool output is repeatedly billed and distracts the model. Keep whole-unit eviction as a marked fallback after compaction.
- **Rewrite older messages on every call without checkpoints.** No new table, fingerprints or invalidation logic would be needed. Position-dependent rewriting changes the view of the same message over time and invalidates subsequent cached prefixes. Persist infrequent batch transformations instead.
- **Maintain a separate current-task summary after its input.** This was the initial layout when S entered the current task. One rolling summary is simpler state, so extend it and place the original task input after it. The first call of the following task incurs one extra cache miss.
- **List every cleared/summarized message in each selection record.** Each record would be self-contained, but thousands of old summarized messages would be repeated per call. Store the checkpoint ID and obtain coverage there.
- **Call the summary through `originalStreamFn`.** It would reuse the conversation path, but the summary model can differ from the conversation model. Use `modelRuntime.streamSimple` instead.
- **Fall back to the conversation model when a configured summary model is unavailable.** More summaries would succeed, but provider and cost would change without the owner's knowledge. Fail visibly instead.
- **Use absolute low-water/tail/gain thresholds, including a 30,000-token tail.** These are easy to read but do not adapt to input budgets below 200,000. Ratios of H' retain the original default values and scale down; only high water is separately configurable.
- **List covered task IDs in markers.** IDs would be more precise, but branch messages do not carry them and `history_search` supports since/until. Use UTC ISO ranges.

These alternatives come from the original decision and offline personal-agent issues 27, 29 and 30, including their confirmed scope and comments. They are historical rationale, not active local tickets.

## Consequences

Obsolete tool output stops recurring after high water, and checkpoint changes replace per-call aging rewrites. JSONL bytes remain unchanged. Markers point back to originals, and summary failures can degrade to clearing without aborting the task. Retrieval availability does not guarantee that the model will think to retrieve the right evidence.

Summaries can omit, distort or repeat injected instructions; prompts reduce but cannot eliminate that risk. Each summary costs a model call, may take one or two minutes, and invalidates the compacted prefix once. A separate summary provider receives earlier conversation/tool content. Extending S into the current task adds a cache miss at the next task's first call, and in-memory failure cooldown resets on restart.

The covered segment must fit the summary model; chunked rolling is not implemented. Only high water is configurable; other ratios are fixed and estimates are not provider-usage calibrated. [Manual compaction](../feature/2026-10-11-manual-context-compaction.md) is implemented separately; still absent are cached-prefix summary requests, automatic pre-compaction memory writes, clearing of call arguments, asynchronous summary precomputation, per-model thresholds, estimate calibration and a monotonic eviction boundary that drops once toward roughly 75% rather than churning the prefix one unit at a time. Frequent `history_read` recovery of cleared output is the signal to increase clearing thresholds or protect more tail. Historical issue 30 retains the original daily-count/gain query rationale in the offline archive.

## Verification

`test/61-context-compaction.test.ts` contains mock-model coverage for no compaction below H', the 2,000-character/image clearing rule and exemptions, intact pairing/call arguments, at most ten checkpoints across 100 calls growing by about 0.05 H', prefix reuse between checkpoints, current-task input placement, model selection without thinking options, failure/cooldown, eviction markers, mandatory overflow, no main request after stop, restricted profiles and online/offline summary-model configuration.

Its backend integration reads actual disk JSONL to check the unchanged original prefix, retrieves a placeholder's original through `history_read`, then restarts to verify checkpoint reuse without a new summary. An in-memory message array cannot prove that loss is confined to the model view. These describe maintained regression coverage, not a new real-model or runtime test result from the documentation translation.
