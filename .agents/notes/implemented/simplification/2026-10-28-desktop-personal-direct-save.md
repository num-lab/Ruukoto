# Agent Note: Save Personal desktop settings directly

Status: implemented

## Problem

Ordinary edits required viewing save impact and a generic confirmation. Old form profile/revisions gated saves, refreshing drafts caused conflicts, and unknown results locked the settings window. The owner requested direct save.

## Decision

PA model/MCP/Computer saves and enable/delete/migrate/withdraw submit directly. Remove generic configuration-confirmation state/dialog/navigation continuations. Sandbox stop and ending unknown business calls retain their specific consequence confirmations. Normal pages show business fields/results, not permanent profile-path/maintenance explanations.

Renderer generates an operation key and sends business data only; IPC carries the key to the host for receipt-based recovery. The host reads profile/latest file revisions from the current authenticated connection and fills existing v2 fields; stale form metadata does not gate saving. A save may therefore overwrite concurrent changes to the same object. Service-scoped operations preserve other unedited MCP services. Authentication, one writer, commit-time revision checks, durable version chains and receipts remain. Pre-read failure/known-unsent requests leave no acceptance association; unknown results verify the original key.

Refresh retains drafts and permits saving. During PA save/unknown outcome, navigation/closing is allowed; the container retains original page instances by source-bearing instanceId/category so unregistered/failed drafts survive. Leaving clears Computer image-acceptance eligibility; actual disconnect still invalidates old responses. Code and PA connection settings retain original navigation protection.

Settings reads verify saved/waiting/unknown operations by original key, not just local acceptance associations. Pages with unsettled operations refresh every two seconds, stopping on unmount or read failure; failures stay visible and confirmed apply failure requires an owner decision. Background reads preserve open service editors. Confirmed save clears that submission's draft state; confirmed nonsave retains retryable drafts. Automatic verification never resubmits, and reopening resumes queries.

## Related decisions

This supersedes save confirmation, stale-form revisions and maintenance interaction in [Personal pages](../feature/2026-10-21-desktop-personal-pages.md), plus PA-wide navigation locking in [settings container](../feature/2026-10-21-desktop-settings-shell.md). Other product/recovery duties remain. [Settings versions](../architecture/2026-10-25-personal-settings-versions.md) and [HTTPS](../architecture/2026-10-24-personal-tailscale-https.md) retain backend/authentication/receipt contracts. The [overall proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md) links successors rather than restoring old maintenance workflow.

## Alternatives considered

- Rename the button only: smaller, but keeps generic confirmation/stale-draft conflicts/window locking.
- Remove remote identity/revision protocol: fewer fields, but breaks version-chain/original-operation recovery. Let the host provide them instead.
- Resave automatically on unknown outcome: makes buttons usable but risks duplicate acceptance. Query the original operation.

## Consequences

Ordinary saves take one submission and pending work does not lock other settings. Last-saved content may overwrite external changes to the same object, and unsettled forms remain in process memory. Real Desktop/PA experience gaps remain in the offline direct-save work item.
