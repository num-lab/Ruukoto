# Agent Note: Host-owned read-only review of GitHub PR events with fixed notifications

Status: implemented

Original identifier: ADR 0013.

[The personal product entry](../simplification/2026-10-18-personal-product-entry.md) removes GitHub auto-review and old webhook settings from new personal. This note governs retained legacy code/history only; Coding does not gain personal IM or review entry points from it.

## Problem

The owner wants a PR event to trigger read-only review and one report for that revision. The original daily-agent issue 08 depended on retired dedicated drafts; restoring REST collection/draft/publish machinery through webhook would recreate two GitHub paths. Untrusted PR material must not gain code execution, comments, merge, or publishing. Retiring fixed coding must preserve review provenance and notification authorization.

## Decision

- Webhook only verifies, registers, and starts host orchestration. Trusted startup config fixes listener/port/webhook credential/repository ID/notification channel. Verify HMAC-SHA256 over raw bytes, then delivery ID, event/action, repository, and PR fields. Cap requests at 1 MiB; truncate PR body to 4,000 characters with a marker before snapshot/model input. Persist normalized snapshot and deduplicate `(github, delivery ID)` before 2XX; async review does not delay response. Read through [ordinary MCP](../architecture/2026-09-23-mcp-client.md), store full review as ordinary Artifact and revision/validity in Task result. No REST fallback, draft tables, or publish state machine returns.
- For each revision the host creates a fresh fixed-main parent task, new work, and new SubAgent with `hostReview: { sourceEventId }`, not via a model tool or main's ordinary delegation quota. Host fixes role/project/session/directory/confirm mode. Each revision gets new context; idle preserves identity/history but neither host nor main can continue/reuse this untrusted-PR reviewer. Main/owner may explicitly close it.
- Reviewer tools are `read`, `read_artifact`, and task-enabled locally declared read MCP only. Assembly, pre-model send, and invocation agree. No PR code execution, bash, delegation, write/unknown MCP, or obedience to PR privilege/publishing instructions. Parent has no tools; result wake allows only `subagent_result` and historical read-only `coding_result`. Writes/comments/merge require the owner's trusted entry and normal approvals, never webhook authority.
- Legacy review sessions live in main project; GitHub MCP/credentials are configured there and enabled only for host-review tasks, not main itself or ordinary SubAgents. Never automatically migrate coding-project configuration or broaden credential scope. The owner creates main-scoped read credentials and configures them; old settings remain until explicitly removed. Missing configuration is reported as unavailable data.
- Enabling webhook authorizes one main summary per valid inbound event to the configured fixed owner/channel. Pin target at registration and create the public outbox operation in the summary-result transaction with `sourceKind=inbound_event`, key=event ID. This is separate from owner_reply/final-report authority; no second owner_reply. Model cannot choose target/key/additional sends. Disable/rebind/observed stale revision cancels unsent notifications; in-flight facts remain, unknown never resends, explicit rate refusal retries only the same operation under [Telegram rules](2026-09-24-telegram-owner-entry.md).

## Revision evidence and retired-role cleanup

Signed snapshots retain head/base SHA, updatedAt, closed, and draft status. Compare observed updatedAt; equal timestamp with different revision is conservatively stale. Original reports stay immutable; current validity is `result_ref.review.staleReason`. Review checks head/base before and after MCP collection, explicitly reporting incomplete/unverifiable data. Missing/late events or later remote changes mean local validity is relative to observed snapshots, not a guarantee of latest remote state or the former publish-time verification.

Capture complete paginated review history. Failed pagination produces a partial artifact and `captureError`, requiring owner verification, never a complete-report claim. Recheck revision at dequeue; stale queued review cancels with no model call or notification.

Originally main delegated to fixed coding. Issue 19 temporarily adopted existing `deleg:<parent>:review` children to avoid duplicates; issue 23 removed that branch with fixed-role retirement. Old queued children cancel; running children recover interrupted/unknown and retain result/artifact lookup without new notifications. If a crash left an old child created while its event stayed registered, cleanup can precede a fresh read-only SubAgent review; this never replays an unknown write. Historical revisions/validity/text remain.

## Alternatives considered

- **Restore REST collection, drafts, and publishing:** direct reuse of the original spec's workflow, but the owner already retired it. MCP/ordinary artifacts/results avoid a dedicated branch and webhook publishing authority.
- **Reuse a reviewer across revisions:** retains PR background and fewer identities, but mixes old diff/report evidence with new head and could carry untrusted context into other owner work. Use fresh contexts.
- **Automatically move coding MCP/credentials to main:** easier upgrades, but credential-scope changes are authorization decisions. Preserve old config; require owner-created main scope.

Historical offline provenance: `.scratch/daily-agent/issues/08-github-events.md`, `.scratch/agent-direction/issues/19-github-subagent-review.md`, and `23-contract-legacy-roles.md`.

## Consequences

Events, revisions, complete/partial reports, stale reasons, summaries, and send keys remain traceable. Duplicate delivery/recovery reuse work/tasks/artifacts/keys. A valid signature proves event source, not trust in PR instructions or permission to run/publish code.

Fresh reviewers and immutable artifacts add retained records. Host reviews can run concurrently without a separate quota; sustained cost/backlog would require a host-review cap. Configuration/credential scope changes need owner action. Missing new events cannot prove remote stability. Real connectivity/delivery requires independent acceptance.

## Verification

Historical first delivery passed typecheck/diff checks; full suite was 437 total, 436 passed, one gated model skip. Tests 42-46 used local HTTP/MCP/model/notification mocks for signatures, limits, dedupe, five recovery windows, tool allowlists, staleness, target changes, unknown sends, and partial capture.

Issue 19 recorded passing `test/45-github-events.test.ts`, `test/46-github-recovery.test.ts`, related regressions/typecheck for full new-work flow, quota exemption/no reuse, reviewer-only MCP, old/new staleness, nonduplicating recovery, and unchanged notification scope. Offline smoke-19 passed 8/8 on macOS arm64 and tx Linux x64 with real backend/control/SQLite/JSONL/Docker worker/loopback signed webhook, but mock model/MCP/notification platform. Full checks had a preexisting test/32 worktree-path assertion failure absent in main checkout. Issue 23 smoke passed 5/5 per platform for cleanup/no replay/read compatibility/no old-review notifications.

Real GitHub webhook delivery, GitHub MCP, and Telegram/QQ were not exercised. Loopback/mock smoke is not a real-platform loop. This migration reruns no runtime tests; current operation guidance is [usage](../../../../docs/usage.md), not the offline scripts.
