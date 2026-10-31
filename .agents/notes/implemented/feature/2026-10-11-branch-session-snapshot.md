# Agent Note: Publish session branches from strict history snapshots and bounded sources

Status: implemented

[Coding side chat](2026-10-29-coding-side-chat.md) reuses safe history and prepare/publish while narrowing identity, tools, and data access; it does not change ordinary branches.

## Problem

The owner confirmed that `/branch` must create an independent session while the source may still run, retaining history, applicable settings, and readable references without inheriting task/approval/work-management authority. `/new` is empty; pi branching does not provide Ruukoto's strict history parsing, request idempotency, bounded provenance, or cross-file recovery.

## Decision

Runtime fixes the source, prepares the file, then publishes the session. Core history/branch owns strict read-only parsing, preparation receipts, and source verification; agent prepares independent JSONL and adapts context. Core neither writes history nor depends on other workspaces. Control accepts source ID, optional task ID, name, and idempotency key, never client-generated authority lists or history paths.

### Independent history and state

Pin source-file identity and byte limit, then determine the branch point from complete JSONL lines and the entry chain. Pair tool batches by host task and call round. Roll back only an unclosed active tail batch; missing pairs in old terminal tasks are historical facts and must not truncate later conversation. A specified task cuts at its completion marker after host verification of ownership/completion. A complete user message may be last; exclude partial tail lines and reject complete malformed lines. Never modify the source.

The new file has its own header, pi ID, and host session ID; copied entries preserve body/order/IDs/provenance. Copy original project identity, organization ownership, verified cwd, and independent settings with initial versions. The directory remains shared and ordinary occupancy still applies.

Copy a compaction point only if coverage and fingerprint match the snapshot; assign a new record ID and retain generation provenance. Derive the checklist from the last successful `todo_write` arguments inside that snapshot so model/TUI agree, without copying tool ledgers. Do not copy tasks, queues, approvals, temporary grants, work/SubAgent identities, notifications, or usage.

### Prepare, publish, recover

A durable branch-request record owns idempotency/recovery; unpublished requests have no selectable sessions row. After initial validation/snapshot read, one transaction fixes parameter fingerprint, target ID, name/number, source range/fingerprint, applicable settings, checkpoint content, and source allow-list. Same-key differing parameters conflict; identical parameters reuse that record. Allocate automatic numbering in that transaction. Later source appends/settings changes cannot alter the request.

Agent exclusively writes/fsyncs the target preparation file and installs the final file. Runtime then atomically publishes session, sources, active checkpoint, completed receipt, and creation event in SQLite, responding/broadcasting after commit. File and SQLite commits are not atomic; the preparation record bridges them.

Restart/same-key retry uses only that record and verified files. Verify an already installed file by its target preparation digest. Rebuild only from the recorded original source prefix after verification, never branch from newer history. Unverifiable source/directory identity or missing/changed required prefix fails explicitly without publishing a partial session. Clean only this request's target preparation file, never source data. A missing published history file is corruption; do not let the SDK silently create an empty history.

### Read-only source eligibility

The host-verified allow-list binds original task/session/artifact and branch range. Partial artifacts retain their captured byte limit/state; images retain immutable references/content verification; SubAgent results refer only to already completed tasks/artifacts. IDs in user/model prose are not authority.

Reads intersect existing history/artifact/image/result permissions with that allow-list. Revocation cannot be undone by branching; corrupt images reject the model call. Rebranching inherits only ancestor entries still inside the snapshot and their original limits, not every current ancestor object. Existing same-project access rules remain: this list is not a time snapshot of the entire project.

Source eligibility never authorizes delegation, reuse, messaging, cancellation, closing, or integration. Source tasks are absent from new-session active lists and accumulated usage. The branch creates its own work through normal submission.

### Client agreement

Response, durable event, queries, and reconnect snapshot project identical name/source/ownership/settings/version data. The initiating client installs the complete result before switching and retains inherited settings without generic cross-session propagation overwriting them. Other clients only update lists. Lost response retains the original key for verification; only explicitly invoking the command again creates a new key. Per-task desktop branching follows [message actions](2026-10-28-desktop-message-actions.md).

[History preservation](../architecture/2026-09-19-preserve-session-history.md) remains authoritative. Compaction, workspace organization, Plan, SubAgent messages/results, work copies, and native stop rules retain their independent semantics. Branching creates no execution environment and releases no source occupancy.

## Alternatives considered

- Direct SDK `createBranchedSession`/`forkFrom`: minimal code and existing pi header/ID generation, but the former changes the manager/reorders some entries and the latter reads permissively. Neither provides bounded provenance/preparation receipts. Retain SDK format/opening, not its source-file branching path.
- Create sessions first, copy later, delete on failure: reuses `/new`, but exposes selectable sessions without history during copy/crash and cannot undo broadcast events by deletion. Prepare before publication.
- Store only a parent ID and recursively open ancestors: compact and convenient for repeated branching, but leaks later artifacts/reused results and risks confusing read eligibility with management authority. Save concrete objects/ranges.
- Clone tasks/tool ledgers/artifacts: easier projection reuse, but duplicates activity/approval/usage and obscures original data identity. Copy conversation and necessary derived state, reference other data read-only.

## Consequences

Independent history costs disk but separates future conversation/derived state. Parsing still uses whole-file memory; revisit streaming if peak memory impedes backend progress. Source corruption or revoked grants can invalidate references. Shared cwd is neither file isolation nor rollback. Preparation receipts recover only in the original instance; import retains published names/bounded sources and rejects incomplete source objects, with revert covered by session/file ledgers. The checklist comes from history and adds a fallback reference block to branch context, not new ordinary-session selection rules.

`test/102-branch-session.test.ts` covers real JSONL/SQLite/Runtime/control with simulated model payloads: safe tails, repeated call IDs, old orphans, same-key concurrency, publication failure/real SIGKILL windows, repeated-branch images/partial artifacts/completed results, denied original-work management, two clients, and no erroneous CAS. Related history/checklist/compaction/TUI/import/lifecycle tests covered their affected scopes. Real platforms/models were not part of offline verification. Former `.scratch/agent-direction/issues/28-branch-session.md` is historical offline provenance for the confirmed behavior, not a live task entry.
