# Agent Note: Retire the dedicated GitHub module in favor of ordinary MCP tools

Status: implemented

Original reference: ADR 0007

The legacy shared Runtime retains this retirement/export code; current Personal durable does not reintroduce the old GitHub business module or webhook assembly. Schema v8-to-v9 and control protocol v7-to-v8 below describe the original retirement, not current supported database upgrades. Current `Db` rejects a stored schema version different from its current version; the retirement routine can still process legacy GitHub tables present in a supported-format database.

## Problem

Historical personal-agent issue 06 delivered a dedicated GitHub module: REST PR/CI collection, draft/publication state machines, repository bindings, `github_*` control operations and CLI/TUI entries. Once the [generic MCP client](../architecture/2026-09-23-mcp-client.md) existed, GitHub could be an ordinary MCP service. Keeping both would duplicate the same capability with separate authorization, approval and result display, while retaining GitHub-specific runtime branches. The owner wanted GitHub treated like other tool services.

Retirement also had to preserve old state: repository bindings, draft versions and publication operations in three tables, old `github_publish` approvals, scoped credentials and historical events. Deleting them would lose history. Reusing an unresolved publication or consumed approval could send a comment twice; converting old authorization into broader MCP access could expand authority without the owner knowing.

## Decision

- GitHub uses generic MCP configuration, discovery, invocation, approval, result storage and display. The dedicated `packages/agent/src/github/` client/collect/store/tools/publish modules and their Runtime, Driver, control, CLI and TUI wiring were removed. Do not retain two business implementations or a GitHub-specific adapter selected by service name. Service examples and [MCP usage](../../../../docs/usage.md#51-mcp-services) may name GitHub.
- Retirement did not wait for write support. The initial MCP replacement registered/executed read-only tools only. Generic [MCP write approval](../feature/2026-09-23-mcp-write-tools-approval.md) was separately accepted, including concrete operation scope, one-time approval consumption and unknown-result recovery; it does not restore draft/publication-intent entries.
- Do not reproduce every old workflow guarantee. Fixed PR/CI revision checks, the draft state machine and owner-only creation of publication intent retired with the module. An Agent can compose ordinary tools when these steps are needed, but a generic MCP call does not automatically provide them. Record missing capabilities rather than secretly falling back to REST.
- Keep old tables `github_repo_bindings`, `github_drafts` and `github_publish_ops` as read-only history after retirement; never drop them. Fresh databases do not create them. The one-time resumable retirement routine invalidates unconsumed old approvals, settles unresolved publication facts without sending anything, exports each draft version as an artifact of its original task and writes `github-archive-manifest.json` with secret-free binding configuration.
- Old credentials and authority do not transfer. Keep credential host, scope and secret unchanged. `CredentialStore.getForUse()` continues rejecting uses outside legacy `github_read`/`github_publish` scope, and same-name rotation preserves scope. Repository bindings do not become MCP grants; old approvals do not become MCP authorization or calls. New access comes from explicit service configuration, tool allowlists and remote credential permissions.
- Remove old `github_*` control operations. The retirement incremented protocol v7 to v8 so mismatched clients were rejected; a compatible current client invoking an old operation receives `unknown_op`. The shared CLI's `github` compatibility branch only prints a static migration/archive notice and exits 1, with no network request, publication mapping or help entry. Its historical text still names `ruukoto mcp configure`; the current shared Coding command is `ruukoto-code mcp configure`, not the new Personal entry. TUI `/github` is removed and treated as unknown.
- Retain `github.binding_changed`, `github.draft_saved`, `github.draft_stale`, `github.publish_requested`, `github.publish_settled` and `github_publish` scope types for historical display. Only the retirement routine produces new `github.publish_settled` records to settle old operations; it does not restart the business workflow. Auto-review displays the historical scope as owner review rather than generating it anew.
- Generic control authentication, access modes and one-time approval keep their [access-mode](../feature/2026-09-19-explicit-access-modes.md), [execution-worker](../architecture/2026-09-20-tool-worker-per-task-container.md) and [auto-review](../feature/2026-09-22-auto-review-mode.md) rules. Full-access account/environment and derived host-task authority follow [current-account full access](../feature/2026-10-12-full-access-current-account.md).
- GitHub inbound events are separate. The retained shared `packages/channels/src/github/` code can validate/register/orchestrate PR webhooks under [GitHub event review](../feature/2026-09-24-github-event-review.md). It does not restore REST collection, drafts, publication state or REST fallback; GitHub content still comes through MCP. The event-review note owns current product-assembly limits.

## Retirement procedure

[retireGitHubModule](../../../../packages/channels/src/github-retirement.ts) runs during shared Runtime startup. It is not a general old-schema importer.

### Trigger and transaction

Return immediately if there are no `github_%` tables or `meta.github_retirement_done` exists. The original v8-to-v9 change removed creation SQL for the three tables without dropping existing ones; retirement checks table presence rather than relying on that old schema number. Supported-format databases can retain those legacy tables.

In one transaction, set unconsumed `pending` or `approved` confirmations with `scope.kind = 'github_publish'` to `stale`. Leave consumed approvals intact as evidence that sending may have begun. Classify each still-pending publication by its linked confirmations:

- A consumed approved confirmation means `effect_unknown`.
- No confirmation also means `effect_unknown`: old full-access publication could have no approval, so absence does not prove no send.
- Confirmations exist but none was consumed: `canceled`, because execution had not consumed approval.

Do not rewrite terminal publication records. Each newly settled operation records its original pending state and evidence-based retirement reason in `error_message`, then appends `github.publish_settled` under the original draft's task/conversation when available. Confirmation rows have no reason column; publication errors/events and the manifest's `retiredConfirmations` count record retirement. No requests are sent and no operation becomes an MCP call.

### Drafts and manifest

Export each draft version as `github-draft-archive-<draft-id>-v<version>` under its original task/conversation using `ArtifactStore` and existing ownership. Content includes source ID/version, repository binding, full body and SHA-256, analyzed revisions, evidence artifact references and that version's publication records. Existing messages, events, tool results and artifact IDs remain readable. A completed export is reused. A partial export from interruption is preserved; retry creates a new complete artifact rather than overwriting it. Per-version failure is recorded in manifest `errors`. Artifact filesystem writes are outside the settlement transaction, not atomic with SQLite.

Write `<dataDir>/github-archive-manifest.json` with `retiredAt`, `reason`, `drafts`, `bindings`, `publishOps`, `retiredConfirmations` and `errors`. Bindings contain only non-secret configuration and credential names, never secret values. The manifest reflects final database state for that attempt. Rerunning resumes exports without duplicating complete artifacts, but it is not byte-identical: the timestamp, newly retired-approval count and remaining errors can change between incomplete attempts.

Set `meta.github_retirement_done` only when every export succeeds. Otherwise startup will try again; preserve all original tables in every outcome. The routine never reads or writes `CredentialStore`, and cannot change old host/scope/secret values. A manifest write failure prevents the completion marker and remains a startup failure, rather than claiming a finished archive.

## Alternatives considered

- **Keep REST collection/publication indefinitely, using MCP only for reads.** The REST implementation was tested and could bridge MCP's initial read-only limit. The owner explicitly rejected long-lived dual implementations and GitHub-specific runtime business logic. One generic path is the requirement, even with a temporary write gap.
- **Keep a GitHub adapter above MCP.** Reusing `GitHubStore`, argument translation and a `github_mcp_read` operation class could retain repository bindings and single-repository checks. This would rename rather than remove the dedicated module and might introduce an adapter only to delete it during retirement. Remote credential permissions define repository scope instead.
- **Finish generic MCP writes/approval before retirement.** This avoids an interruption in publishing. The owner accepted read-only replacement and a temporary write gap; generic writes were a separate work item, not a dependency for deleting the old module.
- **Fall back to REST for MCP gaps.** Some old features might lack corresponding tools. Fallback would conceal missing capability and recreate two paths. Record gaps openly.
- **Delete old tables and history.** This avoids permanent compatibility storage/code. Drafts, publication records and uncertain effects must stay inspectable; the old rows also prove sending may already have started. Retain read-only tables and export every draft body version.
- **Cancel every pending publication.** This is simple and prevents replay, but consumed approvals or full-access sends may already have produced a remote comment. Calling all of them canceled would misstate what happened. Use canceled only when non-execution is proved, otherwise `effect_unknown`.
- **Convert old repository bindings/approvals into MCP authority.** Upgrade would need less reconfiguration. Old approvals are bound to particular publication operations and drafts, and a repository-limited token must not silently become a broad token. Require new explicit configuration rather than changing authority without the owner.

The alternatives and confirmations are preserved in the offline personal-agent spec's 2026-09-22 interview boundary and issues `16-mcp-github.md`, `17-replace-github-module-with-mcp.md` and 18, including their supplemental implementation plans and interview comments. They are provenance, not active repository-local tickets.

## Consequences

One MCP tool path serves GitHub and other services, removing roughly 2,100 lines of dedicated implementation at the original retirement. Old pending operations never auto-send; uncertain outcomes remain unknown. Draft/publication history is readable as ordinary artifacts and credential scope is not implicitly widened.

The tradeoff is weaker workflow enforcement. Fixed-revision checks, draft state and owner-only publication-intent creation are no longer runtime guarantees. Agents must explicitly compose checks when a task needs them. Repository isolation is also coarser: the former repository-ID binding check is gone, and generic MCP has no argument-level single-repository guard beyond the configured remote credential's rights.

The original read-only transition had a write gap; current writes use generic MCP write tools/approval. The owner must explicitly configure credentials and allowed tools, not reuse legacy bindings or approvals as grants. Old tables and archival type/display branches remain indefinitely, so fresh and retained-history databases differ. Retirement only runs at backend startup; incomplete exports retry on later starts without deleting originals. An unsupported old database must first follow the explicitly supported retention/import policy, not be opened by assuming this routine upgrades it.

## Verification

`test/17-github-retirement.test.ts` embeds the old v8 table layout and multi-version drafts, pending/approved/consumed confirmations, publication outcomes, historical events and scoped credentials. Its current fixture adds those legacy tables/data to a current-format database; despite stale historical fixture comments, it does not downgrade the schema version. Real shared Runtime startup exercises fresh databases without old tables; approval invalidation and evidence-based terminal states; retained tables; per-version artifacts readable through `read_artifact`; secret-free manifest; idempotent complete-export reuse; inaccessible old control operations; unchanged credential scope; event replay; and retry that completes a partial archive without modifying its original record.

`test/08-approvals.test.ts` retains the scoped-credential rule: generic `http_request` cannot borrow an incompatible credential, and same-name rotation preserves scope. `test/13-tui-state.test.ts` checks archival event display and removal of `/github` guidance. `test/24-mcp.test.ts` uses an in-process mock Streamable HTTP service to cover the generic path without the old module.

Real GitHub MCP read-only connectivity needs the owner's separately configured read-only credential and the [MCP usage procedure](../../../../docs/usage.md#51-mcp-services). The listed cases describe maintained test coverage, not a new runtime or real-service test result from this documentation migration.
