# Agent Note: Cua delivered-observation eligibility and bounded run_steps batch

Status: implemented

Builds on [official Cua MCP](../architecture/2026-10-23-cua-official-mcp.md) for issue #32. Fixed program, managed connection, deferred discovery, approvals, operation ledger and image artifacts are unchanged.

## Problem

Code's computer-use loop previously required one model round trip per action and one approval interruption per write, while a single binding-level "observed" flag authorized every subsequent write from any image-bearing result. Truncated projections, stale snapshots, other-window observations, predicate-only `verify_state` results and write-result images were indistinguishable from usable observations, and upstream `run_steps` (64 steps, aliases, shorthand, `wait_for`/`expect`, `foreground_fallback`) was far broader than an acceptable first delivery.

## Decision

Observation authorization follows what was actually persisted and projected to the model, per execution and per window. `get_window_state` (and a batch's trailing observation) records upstream `snapshot_id`/`invalidated_snapshot_ids`/`capture_id`/degraded metadata plus the delivered tree text and image presence; `get_desktop_state` records a desktop screenshot fact. Element actions require a token whose snapshot is still current and whose row appears in the delivered text; coordinate actions require a delivered screenshot for their target window (or the desktop fact); writes without a resolved target need the current window context. `verify_state`, write results and undelivered or truncated-away content never authorize. Re-read attempts, invalidation notices, freezing, closing and rebinding drop the corresponding grants, and a `capture_id` must match the delivered frame when known. The image requirement for calling is narrowed to calls that can return images (`get_desktop_state`, `get_window_state`/`run_steps` observations unless `include_screenshot:false`), so text-only models can still perform tree-only flows; service registration no longer requires a vision model.

`get_guide` joins the read-only set behind the owner allowlist and the existing deferred `tool_search` discovery. `run_steps` joins the write set only as a canonical subset: `{tool,args}` steps, at most eight, the ten action tools only, one `pid`/`window_id` batch window, mandatory `observe` (a `get_window_state` argument object confined to the same window), no `wait_for`/`expect`/check-only/script steps, no `foreground_fallback`, bounded `delay_ms` (≤2 s), step `timeout_ms` (≤10 s) and text (≤1024 chars). Host validation rejects aliases, shorthand forms, nested session/target/window/file-output/`from_zoom` fields and type or enum violations before send, so upstream normalization and fallbacks are unreachable from out-of-subset input; nested protected fields are checked at their actual locations. The batch is one write operation: one approval binds the complete parameters, is consumed once inside the existing pre-dispatch re-verification, and a lost or incomplete reply freezes the computer as effect-unknown exactly like other sends. Approval surfaces render ordered step summaries over the complete parameters, and the TUI refuses approval until every parameter page has been loaded contiguously.

## Alternatives considered

- Keep the single `observed` flag: least code, but cannot express tree-only eligibility, window identity or truncated-projection denial required by the issue.
- Expose upstream `run_steps` verbatim and rely on upstream validation: inherits 64-step budgets, conditional steps and retargeting the issue explicitly excluded; host-side rejection also produces better model-facing errors than remote failures.
- A second element index beside upstream snapshots: duplicate state that can diverge; snapshot ids, invalidation lists and delivered text already carry sufficient provenance.
- Per-step approvals or mid-batch revocation promises: the remote batch executes atomically once sent; honest single-approval binding plus unknown-effect freezing matches actual control.
- Keep requiring a vision-capable model for the whole service: simpler, but makes tree-only flows impossible for text models; per-call image requirements cover the only calls that can return images.

## Consequences

Unobserved or wrongly-targeted writes fail locally with zero send and a corrective message. Batches cannot self-authorize through their own observation payload: the trailing observation is recorded under the same delivered-content rules, so a `run_steps` result only authorizes later work where its window and content actually reached the model. Personal/Linux paths share none of this behavior: `run_steps`/`get_guide` exist only in the Mac allowlist sets, and Linux keeps its sandbox argument injection. Real-driver and real-model acceptance remain external verification.
