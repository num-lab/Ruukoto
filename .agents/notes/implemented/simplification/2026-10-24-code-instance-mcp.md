# Agent Note: Code MCP uses instance configuration without project compatibility

Status: implemented

Instance configuration/credential authority remains. [MCP host simplification](2026-10-26-mcp-host-responsibilities.md) updates SDK wiring, discovery and tool signatures. Version numbers below identify historical incompatible changes, not current constants. [Coding message control](../feature/2026-10-28-coding-message-control.md) retains strict version transitions without restoring old-store migration.

## Problem

Code MCP tied service definitions, credentials and authorization to projects. Settings required workspace/legacy-source selection and duplicated services across workspaces. On 2026-10-24 the owner requested removal of workspace MCP configuration and backward compatibility, followed by plan revision, independent review and implementation. The original work item is offline at `.scratch/desktop-settings/issues/03-code-mcp.md`.

## Decision

Each Code backend instance owns one set of MCP services with instance-unique names, including ordinary HTTP and existing Cua. Remove workspace configuration, sources, project overrides and default-source inference, without a workspace enablement layer. Management works without workspaces/sessions. Every workspace assembles from the same enabled services/tool allowlists, narrowed by existing role, Plan, workflow, review and Cua eligibility. Personal keeps independent profiles, services/secrets and format compatibility.

At first write, MCP credentials bind purpose=mcp, actual endpoint host, authorization header and operations=['mcp'], with no project/repository scope. Each CredentialStore's ownership supplies instance isolation, not a new global credential center. Service save/every send verifies those conditions. Existing project/repository-limited, general-HTTP or wrong-purpose bindings fail; their scope is not stripped and anonymous fallback is forbidden. Other purposes retain their own project limits. Lists expose metadata only; referenced credentials cannot be deleted.

Desktop's dedicated entry and CLI/TUI add_credential share first-write restrictions. Selecting purpose=mcp immediately validates authorization and writes strict MCP operation scope; service binding then checks actual host/endpoint. Invalid same-name bindings reject rather than changing old scope through token rotation. Valid rotations retain purpose restrictions. Dedicated/general remove_credential checks instance-service references. Terminals can configure authenticated services from empty profiles without bypassing UI restrictions.

Task pinning, version conflicts, service identity, allowlists, local effect declarations, one-use approval consumption, disable-before-new-call checks, lost-response verification and no unknown-effect replay remain. Main tasks, workflow capability digests, SubAgent role checks and pre-send checks read the same instance selection. Removing projects grants no out-of-scope role tools or non-main Cua access. Changes affect subsequent calls in every workspace; new tools become available only to the next task. Already-started calls are not promised revocation.

## Removal and incompatible transition

Remove mcp_services.project_id, its project foreign key/project-name index, replacing them with instance-unique names. Remove project ownership from MCP configuration types, management requests/events/lists and credential-reference views. Remove mcp_sources, listWorkspaceConfigSources, Desktop workspaceId/sourceId and candidate pages, CLI MCP --project and TUI project selection. Tasks, sessions and other business records keep their project identities. New protocol rejects old MCP ownership arguments and unsupported operations explicitly: never silently interpret old arguments as global writes. No aliases, dual reads, fallback or old-source mapping.

The original transition introduced Code schema 51/protocol 40 and strict current-version-only opening, removing schema 49-to-50 MCP/Cua migration and old configuration conversion. Later versions supersede those numbers without restoring compatibility. Preserve old profiles in place and reject new-code opening; never clear tables, merge service names, upgrade credentials or rewrite version numbers automatically. A new directory starts with empty MCP configuration for owner re-entry/dedicated credentials. No one-shot importer preserves in-place upgrade. Legacy-instance import removes MCP copying/project remapping and does not bring services/secrets into new instances.

This transition affects the entire Code database: old sessions/persistent state cannot continue in place under new code. Original SQLite, JSONL, artifacts and credential files remain unmoved/unchanged/undeleted. A new data directory must not share the old credential directory; old history is not promised to appear automatically. Independent old-version inspection is not a new-code compatibility layer. Any future requirement to continue old history in place must revisit this decision explicitly, not add hidden migration during implementation.

Before switching, stop original tasks/managed processes and verify unresolved Cua/effects using the original version. Configuration, serviceId, approvals and recovery observations do not transfer between instances. New profiles/deleted services are not stopping proof and cannot clear old computer occupancy. Cua keeps one main connection/serialized calls per instance with vision, human recovery and pre-send checks unchanged.

## Related decisions

The original active-note audit searched MCP, credentials, sources, workspaces and Cua. Partial supersessions retain old decisions with scope annotations; no delivered note is wholly absorbed/archived.

| Decision | Relationship |
| --- | --- |
| [MCP client](../architecture/2026-09-23-mcp-client.md) | Replaces project configuration/credential scope; retains transport, allowlists, pinning and unknown-effect rules. |
| [Code settings](../feature/2026-10-21-code-mcp-settings.md), [settings shell](../feature/2026-10-21-desktop-settings-shell.md) | Removes workspace/legacy-source management; retains first-write credential purpose, service identity, conditional versions and form verification. |
| [Desktop settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md) | Updates Code MCP plan/spec; original issue 03 reopened because prior engineering evidence did not cover new scope. |
| [Official Cua](../architecture/2026-10-23-cua-official-mcp.md) | Removes Code 49-to-50 compatibility/project configuration, retaining persistent connections, human recovery and Personal formats. |
| [Transport](../architecture/2026-10-17-mcp-transport-reuse.md), [write tools](../feature/2026-09-23-mcp-write-tools-approval.md) | Instance assembly retains applicable transport, approval and error semantics. |
| [Personal MCP](../architecture/2026-10-17-personal-durable-mcp.md), [rejected Cua](../../rejected/architecture/2026-10-22-cua-integration.md) | Unaffected by this Code scope change; retain their facts/history. |

## Alternatives considered

- Register globally but enable per workspace: shared connections with narrower workspace access, but still maintains authorization/selectors/default inheritance against the requested removal.
- Merge old project services globally once: preserves profiles/connections, but needs rules for names, credentials and enablement and expands originally project-limited access. The owner explicitly removed compatibility; reject/reconfigure instead.
- Hide workspace only in UI: smallest page diff, but backend, CLI, workflows and credentials still use projects, preventing empty-workspace configuration and misrepresenting capabilities. Remove ownership through storage and callers.

## Verification

- Configure services/credentials without workspaces/sessions. Two workspaces use one serviceId/version/catalog; disable applies before their next calls. Other Code instances/Personal remain independent.
- Main/workflow catalogs no longer filter by project; role/Plan/review/main-only Cua limits still reject excessive tools. New credentials work across this instance's workspaces. General HTTP, wrong purpose/host/header and project/repository-scoped bindings reject with zero sends.
- New tables have no MCP project column and unique names. Old schema/protocol/operations/ownership arguments/CLI --project fail without migration, global writes or network calls and preserve original data/sessions/configuration. Legacy import copies no MCP services/secrets.
- Preserve CRUD, same-name recreation conflicts, reference protection, disabled discovery, post-approval revocation, unknown effects, disconnect/instance-switch/lost-response checks. Real Electron/MyGo workspace-free/cross-workspace management, HTTPS and Cua require separate external acceptance, not stubs.

## Consequences

Enabled ordinary MCP services are available to every eligible workspace task in this instance. Remote scope still depends on service/token, not workspace isolation. Mistaken disable/edits affect multiple workspaces. Different accounts/permission sets should first use separate Code instances; same-instance isolation needs a new decision.

The incompatible change requires a new data directory/reconfiguration and prevents old sessions continuing in place. Preserve original profiles/unresolved operations and verify with original code. Removing compatibility is not deleting user data. Implementation changed only repository/isolated-test profiles, not real-profile cutover. Real Electron/MyGo, HTTPS MCP and Cua remain separately accepted; original engineering evidence belongs to the work item.
