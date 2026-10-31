# Agent Note: Code MCP settings preserve source identity and scope credentials on creation

Status: implemented

[Instance MCP](../simplification/2026-10-24-code-instance-mcp.md) supersedes workspace/legacy-project source management. This note retains the original decision and still-applicable credential scoping, service identity, conditional revisions and original-instance verification.

## Problem

Workspace organization can include sessions from several legacy projects while MCP configuration/credentials remain with original projects. Guessing a project can overwrite the wrong same-named service. Saving a general credential before later narrowing it can leave broadly usable secrets after conflict/cancellation.

## Decision

The original backend paged workspace/original-session projects with names and service counts, preferring current source only when truly part of that workspace. Empty workspaces defaulted to themselves. Writes used original projects, service identity and read revisions. Updates supplied original service_id, rejecting deleted/recreated names transactionally rather than turning edits into creates. New services saved disabled with expected revision zero, never enabled temporarily for discovery. Instance MCP later replaces that source-selection model.

Desktop exposes only MCP-specific credential creation/removal. Initial storage originally used `scope={projectId,operations:['mcp']}` and the applicable source, with resolved endpoint host, authorization header and MCP purpose; same-name replacement is forbidden. Lists contain metadata/references only and retain compatible existing credentials. Removal requires matching MCP-only scope and zero references. Credential and service writes are separate, not atomic; failed/canceled service saves leave restricted credentials available for explicit cleanup.

Updates first resolve the effective credential reference, then check existence, host, purpose, header and scope. Omission retains the reference; null clears it. Sending rechecks purpose/header and never falls back to anonymous on invalid references. Enable/disable configuration and its event share a transaction.

HTTP `mcp_check` reuses initialization/discovery, including disabled services, without business-tool calls. Owners choose allowed tools individually and classify effects; new tools default to unknown effects, and remote read-only annotations never grant local permission. Check errors use fixed actionable text rather than potentially token-reflecting remote bodies. [Cua management](../architecture/2026-10-23-cua-official-mcp.md) owns fixed classification/manifests, host prechecks, observation acceptance and per-service pause.

The settings container binds instance/source/draft/submission and guards navigation. Secrets exist only in local submit parameters and clear on submit, discard, disconnect or generation change. Conflicts preserve drafts and reread current values. Lost responses never auto-resend: verify read-only against original instance/source; failed verification remains unresolved. Disabling only affects later calls, not already emitted remote work.

## Related decisions

This implements the Code MCP slice of the [settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md). [Settings container](2026-10-21-desktop-settings-shell.md), [MCP client](../architecture/2026-09-23-mcp-client.md), [write approvals](2026-09-23-mcp-write-tools-approval.md) and [transport reuse](../architecture/2026-10-17-mcp-transport-reuse.md) retain navigation/runtime/approval-consumption rules.

## Alternatives considered

- Managing only the workspace project is smaller but originally missed organized legacy sessions; explicit source selection preserved ownership until instance migration.
- Saving general credentials then narrowing uses fewer operations but leaves excessive permissions after failure/cancel. Scope the first write.
- Checking unsaved forms avoids one save but creates another discovery/secret route; disabled saved drafts already work.
- Auto-deleting credentials with a service saves a step but can break other references. Show references and require explicit backend-checked cleanup.

## Consequences

Code MCP management works without an open session and does not infer ownership from display organization. Partial credential/service success remains visible without broadening secrets. Real local control-plane and isolated loopback MCP tests cover management; mocked discovery proves neither real HTTPS interoperability nor two-shell experience/business authorization acceptance.
