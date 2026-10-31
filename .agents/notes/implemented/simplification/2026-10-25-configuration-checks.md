# Agent Note: Check only relevant execution use and credentials during configuration edits

Status: implemented

## Problem

Code treated provider/model display names, ordering, and genuinely new models as changes to existing execution, blocking edits during running/queued tasks. Personal MCP re-evaluated every credential on every save, so one stale credential blocked disable/delete and edits to unrelated services. Coding file search cached a missing rg until worker exit and always recommended restarting.

## Decision

RuntimeModels compares provider/model execution fields, ignoring both name fields and matching existing definitions by unique model ID. Other known and unknown fields retain deep comparison. A new ID is non-execution-changing only if absent from the SDK's current catalog too; first declaring a built-in ID in models.json is still an override. Shared catalog validation rejects duplicate IDs. Reference checks, revision comparison, full-stack preparation, publication, rollback, and stop waiting retain their owners.

Personal MCP save reuses `validatePersonalMcpCredentials` only for new services, disabled-to-enabled changes, and changes to credential or Cua binding. Disable/delete reads no old credential; unchanged authentication on other services is outside this save's validation. Real discovery, invocation, and recovery still verify original credentials per request and never downgrade invalid auth to anonymous. This slice does not relax pending-operation or profile-lock requirements; the complete configuration-update flow owns online save.

Coding worker calls `resolveFileSearchExecutable` for each search against its currently visible PATH. Personal host already did so. Diagnostics recommend installing in the existing PATH and retrying, reserving restart advice for backend-environment changes. Execution remains in the original sandbox; installation does not expand an existing unit's mounts.

This partly implements [operation-scoped configuration](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md), limited to Code presentation changes, MCP credential checks, and rg discovery. Other online application/migration/recovery remains with that proposal. [RuntimeModels](../architecture/2026-10-23-runtime-models.md), [Code model settings](../feature/2026-10-21-code-model-settings.md), [Personal MCP](../architecture/2026-10-17-personal-durable-mcp.md), and [controlled search](../feature/2026-10-21-controlled-file-search.md) keep stack, credential location, execution, and data boundaries except the explicitly replaced all-credentials-on-save rule.

## Alternatives considered

Removing all catalog occupancy checks is shorter but allows address/auth/capability/built-in overrides to change old execution. Skipping credentials only on disable rescues one action but still blocks unrelated edits. Restarting for every rg installation works but unnecessarily interrupts the backend when PATH is unchanged. Check actual execution/auth changes and rediscover through the existing helper.

## Consequences

Display-only edits and genuinely new models need not wait for same-provider tasks; existing SDK sessions/task selections remain. Bad MCP credentials can be disabled/deleted, while new/enabled/changed authentication and real calls still reject invalid references. Tests cover running, queued, awaiting-confirmation, built-in override, duplicate IDs, bad credentials, and same-process installation/rediscovery. Mock models/local workers do not substitute for real-model, IM, or native Linux acceptance.

Native-unit toolchains/mounts are fixed at launch. Installation into a custom directory invisible to an old unit requires new-unit toolchain verification, not adding path authority to the old sandbox.
