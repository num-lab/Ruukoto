# Agent Note: Auto-review uses an independent model call to decide bounded read approvals

Status: implemented

Original identifier: ADR 0005.

[Native execution](../architecture/2026-10-12-personal-native-sandbox.md) supersedes container routing; [current-account full access](2026-10-12-full-access-current-account.md) owns later account/environment/full-access rules. Review eligibility, no-tool input, owner fallback, races, and one-use consumption remain here. Personal durable wiring is separately owned and is not inferred from shared-runtime symbols below.

## Problem

Confirm interrupts the owner for every out-of-scope operation; full access exposes the account's full permissions. The owner needs restricted execution with some reads decided automatically. Review input may contain injected approval instructions, models may fail or time out, and results may race owner decisions, cancellation, or mode changes. None may let the model expand authority.

## Decision

- `AccessMode` is `confirm | full_access | auto-review`. The owner selects session defaults through `set_session_mode` / TUI `/mode`, or a task through submit/continue/switch_mode. New tasks pin the selected mode; changing the session default does not rewrite existing tasks. Plan uses auto-review, not a fourth access policy.
- Auto-review and confirm use the same native restricted worker. Full access uses the current account and is rejected by native launchers. Missing backend/policy/worker artifacts fail `execution_unavailable`, never full-access/local fallback. The original task-container routing is historical.
- Already-authorized operations run normally. Eligible out-of-scope reads get one independent, no-tool review call in `packages/agent/src/review.ts`, using the task-pinned `modelSelection` and existing model runtime. Independence means separate input/no tools, not another provider or Agent session; there is no review-model picker.
- `classifyForReview` runs first. Only `file_operation` with `access=read`, or credential-free `http_request` using case-insensitive GET/HEAD, may reach the model. Writes, credentials, other methods, generic `tool`, `mcp_tool`, `app_data_change`, `notification`, and `service_operation` go directly to the owner. Historical `github_publish` is read-compatible only after module retirement. A matching valid service standing permission follows its separate host authorization without starting review. New scope kinds default to owner approval. GET/HEAD is eligibility, not proof of safety.
- Approve only reads relevant to the owner's explicit request, with a definite target, no credentials, and no outward private-data transfer. Decisions are `approve`, `reject`, or `ask_owner`: clearly unrelated/suspicious/dangerous requests reject; insufficient context or uncertain target/data use asks the owner.
- Model unavailability/failure, malformed output, missing essential text, excessive input, or timeout asks the owner with a reason and leaves approval pending. One deadline-bounded attempt per approval, no retry loop. Constants are `REVIEW_TIMEOUT_MS=30_000`, `REVIEW_MAX_TOKENS=1024`, `REVIEW_INPUT_CAP_BYTES=8*1024` (aligned with `PARAMS_INLINE_CAP`), and `REVIEW_POLICY_VERSION=auto-review-v1`; evolve the version when policy changes.
- Input is the backend-saved original owner request, necessary task context, immutable parameters, and approval scope. Project instructions, webpages, tool output, and model claims are data, never authorization; do not send raw credentials, unrelated history, or ungranted material. No output can change mode, policy, paths, credential scope, or project-data grants.
- Record conclusion, reason, actual model, and policy version on the existing approval. `decision_source` identifies the final authority, separate from the review suggestion. Old rows without review metadata display as historical manual approval; no second approval service/token is introduced.
- Approved operations still consume once via `Store.consumeApproval`, use immutable saved arguments, pin HTTP addresses, and follow no redirects. A late automatic result cannot replace an owner decision or stale request. Automatic rejection records known non-execution and attributes rejection to auto-review, not the owner; a revised request may be submitted anew.

## Review call

`createApprovalReviewer().review()` returns `ask_owner` and a reason for empty `task.input`, original request or parameter JSON above 8 KiB, or failed model resolution. Never approve a truncated input or summary; truncation is display-only.

`modelRuntime.streamSimple(...).result()` receives a system policy and a user message containing policy version/data-only warning, original request, tool name, scope JSON, and immutable parameter JSON. Instructions embedded in parameters/paths/URLs, including claims of prior authorization, cannot supply authority. An independent timer/Internal AbortController enforces timeout and links external cancellation, rather than relying on HTTP timeout.

`parseReviewOutput` accepts JSON with an optional code fence only, one of the three decisions, and a nonempty reason truncated to 500 characters. Other wrappers/invalid JSON ask the owner. Recorded model is `provider/modelId`. External cancellation throws `ReviewAbortedError`; callers handle cancellation rather than writing a fresh ask_owner after owner takeover/task stop. Review starts only for auto-review tasks with pinned selection and a configured reviewer; otherwise the approval is manual with no review fields.

## Persistence, events, and races

Nullable `confirmations` fields preserve legacy rows: `review_status` goes from `in_progress` to `done`, `asked_owner`, or `superseded`; null means manual/unreviewed. `review_decision` is separate from final status; `review_reason`, `review_model`, and `review_policy_version` preserve evidence. `decision_source` is `owner`, `auto_review`, or separately authorized `standing_permission`.

`task.awaiting_confirmation` can carry review status/model/policy. Owner fallback emits `task.confirmation_reviewed` with ask_owner/reason; automatic resolution emits `task.confirmation_resolved` with auto_review/reason. TUI distinguishes reviewing, owner-wait with reason, and decided result/reason/model/policy/source, including after reconnect.

Register the waiter before starting review so synchronous completion has a recipient. Automatic respond uses a conditional update requiring pending approval, original permission version, and task running/awaiting_confirmation. Losing the race marks in-progress review superseded without persisting its decision. Ask-owner updates only pending rows and emits nothing if the owner already won. Manual TUI/IM decision writes owner source and supersedes in-progress review in the same update. Wait completion/mode switch/cancellation aborts review; task stop aborts all its reviews. Terminal tasks or changed permissions stale pending and approved-but-unconsumed approvals and supersede active review together. Restart does not leave permanent reviewing state, reuse approval, or replay operations.

There is a confirmed implementation gap: `ApprovalGate.runAutoReview` commits automatic state via `store.respondConfirmation` and its resolved event in two separate `withTx` calls; `markReviewAskedOwner` likewise separates state and reviewed event. A crash between them can leave a decision without its event. This migration checked current source and preserves the gap rather than claiming the repository's atomic-state/event rule is satisfied. The historical offline visual-docs-review issue 06 also noted it; current source, not that removed task record, establishes the gap.

## Alternatives considered

- **Review advice only, owner always decides:** no model-granted permission, but retains every interruption and contradicts the confirmed decision-making semantics.
- **Separate review provider/model configuration:** appears more independent, but separate no-tool input meets the chosen boundary; reuse pinned selection and record actual model/version instead of adding configuration.
- **Automatically approve all credential-free GET/HEAD:** no injection surface or latency, but reads can exfiltrate private data or hit unrelated targets. Methods only decide eligibility.
- **Truncate long input and review:** handles more requests, but authorizes unseen content. Ask the owner instead.
- **Retry failed review:** could avoid some manual work, but the confirmed policy is one bounded attempt and owner takeover on failure.
- **Tool-using reviewer or separate approval service:** could inspect targets, but exceeds the fixed evidence scope and duplicates conditional updates/one-use credentials. Use the existing approval record.
- **GitHub-specific auto-review:** would reuse the former publish path, but that module was being retired; integrate the common approval bridge and keep MCP writes owner-bound.

Original provenance is historical offline `.scratch/personal-agent/issues/12-session-mode-command.md`, `15-auto-review-mode.md`, `17-replace-github-module-with-mcp.md`, and `15-auto-review-plan.md`.

## Consequences

Eligible reads can continue without the owner while restriction and original-operation scope remain unchanged. Failure only returns to manual confirmation; authority and policy/model provenance stay inspectable. Each eligible read adds a model call and up to 30 seconds of reviewing, with owner takeover available. Writes/credentials/MCP/application changes/sends/service operations remain outside model approval except separately authorized host paths.

Quality depends on the task model; requests/parameters above 8 KiB cannot auto-approve. The state/event transaction gap remains unresolved. Local test workers provide no isolation. Expanding eligibility requires a deterministic-policy change and policy-version bump; changing review-model selection requires renewed injection/evidence review.

## Verification

`test/22-auto-review.test.ts` maps to real execution counts and consumption, rejection attribution, owner fallback/approval, zero model review for writes, invalid/timeout/late output, owner/cancel/version/restart races, reconnect snapshots, injected parameter instructions, classifier/parser/precondition branches, and old-CHECK migration. Current launcher cases cover native routing, missing worker output, and mode rejection; old Docker-routing evidence is historical. `test/10-access-modes.test.ts` covers persistence/pinning/overrides/conflicts/task switches and invalid-mode rejection. OS restriction needs real platform probes/smoke, not local routing tests. This migration reruns none of those runtime tests.
