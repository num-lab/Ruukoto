# Agent Note: Personal settings use authenticated backend queries and bounded machine management

Status: implemented

[Settings save/effect versions](../architecture/2026-10-25-personal-settings-versions.md) supersedes blanket offline-save/unrelated-work preflight: ordinary settings can save online/offline with versioned receipts and effect recovery. [HOME skills discovery](../simplification/2026-10-28-home-skills-discovery.md) supersedes library configuration/managed skill mutation; old configuration/maintenance receipts remain historical and new skill queries are read-only at fixed directories. Authentication, profile identity, revisions, and bounded protocol remain here.

## Problem

[Desktop settings](../../proposed/feature/2026-10-21-desktop-settings-management.md) needs new durable Personal model/skill/MCP management. Existing [local management](../architecture/2026-10-17-personal-local-management.md) offers interactive wizards/business queries, not revisions/profile identity/machine protocol. Desktop reading active SQLite, parsing wizard prose, or testing models in an SSH shell would bypass backend exclusivity or use different credentials from the real service.

## Decision

`ruukoto settings` accepts one v1 JSON request on stdin, at most 128 KiB, and returns one product-marked success/structured-error JSON on stdout, at most 256 KiB. Fixed operations reject unknown fields; no commands, SQL, arbitrary file access, or lifecycle templates. Authenticated Unix-socket GET/POST /settings lets the lock-owning backend query metadata, paged MCP services/full one-service definitions, blockers, preflight, explicit model tests, and lifecycle. Model/MCP configuration reads do not network.

Try the live backend first. Only unavailable connection or lost response permits attempting the original profile lock; lock contention rejects, and disconnection is not proof of shutdown. Offline queries also hold the lock. Original saves/MCP format migration/managed mutations required stopped+locked operation; ordinary-save behavior now follows the save/effect successor.

Profile identity hashes canonical remote path and directory device/inode without changing profile.json or base format. Model, original skill-source, and MCP revisions hash raw configuration bytes, with missing for absence. Original offline maintenance rechecked identity/revision/business format/unresolved client input/input/work/unknown resource state under the same lock, even for identical config, then reused existing save/single-file replacement; never claimed a multi-file transaction. Those broad blockers remain historical maintenance rationale, not a blanket rule for current ordinary saves.

### Original maintenance preflight

Online/offline maintenance checked unanswered questions, unreleased directory claims, and unresolved question/background-completion receipt files. A finished startup/question task did not prove resolution; missing indexed question records rejected preflight before stopping service. Shared classification covered tool/MCP/browser/command/service/application unknown effects and service-inspection/browser-binding stop facts; task terminal did not mean external completion. Online queried Harness read-only; offline read Storage while locked. Output capped at 32 blockers but still validated later versions/references; unknown/corrupt hidden rows could not be bypassed by deleting indexes or truncating display. Current operation-specific save/effect rules supersede unrelated-work blocking.

### Actual-backend model tests

Configuration stores credential environment-variable names only. Read/preflight report whether the actual backend has that reference; offline is unverified. An explicit test uses selected draft plus actual backend credentials for fixed ping, max output one token, no tools, deadline 30 seconds; return only fixed success/timeout/missing-credential/failure diagnostics, never model body or SDK error, and create no main work. Settings socket idle/client total timeout is 35 seconds versus ordinary control 5 seconds; receiving timeout stays 10 seconds. Saving does not imply tested connectivity.

Before send, persist selection/fixed input/budget as `ruukoto.settings-model-test`; actual onPayload saves the request body under the same test key. Either persistence failure sends zero HTTP; authentication headers are excluded. Diagnostic data entries have no model messages and do not enter main conversation/work. Fixed tests have no system prompt/tool schema; actual request and records are checked field by field.

### Skills: original management and current read-only discovery

The original implementation reused `ManagedSkillsStore`, separate source/manifest revisions, online read-only list/detail/import preview, and stopped+locked import/enable/remove with identity/revision/blocker rechecks. Owner-selected library/import directory enumeration capped at 1000 children and 50 ordinary subdirectories/page, without files/arbitrary reference text; preview/commit revalidated all package content. Invalid external libraries produced management diagnostics while model/MCP/current-config reads stayed available for repair, but execution still rejected invalid libraries. Fixed profile-managed paths were marked Personal source, not GUI-local paths.

Original mutation receipts returned saved target/committed identity/state/revision without bodies, avoiding false failure after commit from an oversized response. Details were separate reads. Failed manifest commit retained old manifest and valid orphan content; lost import responses required preview-identity/revision readback, not automatic resend. HOME discovery now removes these mutation/library controls while keeping history/receipts. [Foundation](../architecture/2026-10-17-personal-durable-foundation.md) and [skills/history](../architecture/2026-10-18-personal-memory-skills-history.md) retain layout/request evidence.

### MCP and large configurations

Queries expose private credential-file references/digests and anonymous/valid/missing/invalid status, not secret bytes. Valid file does not prove remote authentication; invalid never falls back anonymous. Replace endpoint query values with fixed placeholders. Save can restore hidden values only when original service identity and redacted endpoint match exactly; other placeholder endpoints reject. Discovery is explicit owner action and lists definitions without business calls; owner selects allowlist. Host assigns new generations. Original v1 -> v2 used explicit mcp.migrate rather than silent form conversion; later MCP format rules belong to [Personal MCP](../architecture/2026-10-17-personal-durable-mcp.md) and its successors.

Hash configuration with fixed-buffer streaming SHA-256, not machine-request limits on already-valid files. Page definitions by service/tool; mcp.get defaults to one tool. mcp.set-enabled/remove/save-service update by original service identity and use the same generation rules; omitted tools preserve the complete old allowlist. Small edits therefore need not roundtrip all configuration or shrink schemas. config.save still means full replacement. Requests/responses remain bounded; a single oversized tool fails explicitly.

Lifecycle reports running state/current process/development-manager flag and unverified original launch environment, not automatic restoration or service management. [SSH maintenance](2026-10-21-personal-settings-ssh.md) separately verifies exact systemd authorization/original supervisor. Shell credentials cannot prove the original service can restart.

## Related decisions

The original audit found partial overlap with desktop proposal/local management/foundation/skills/MCP/product entry; each retains planning, exclusivity, layout, request evidence, external recovery, or bin wiring. Work/command/service/browser/Telegram/schedule behavior is not redefined here. No complete absorption or archive change was needed.

## Alternatives considered

- **Desktop directly edits remote files/SQLite:** one less protocol, but bypasses online ownership and cannot atomically compare/save offline revisions under the profile lock.
- **Parse interactive wizard text:** reuses prompts, but unstable and unable to reliably distinguish field error, rejection, or lost response.
- **Test via SSH shell then start service:** simple, but shell environment does not establish service credentials; offline must remain unverified.
- **Add permanent profile-format identity:** portable across moves, but alters existing base markers. Path/device/inode digest is enough to reject wrong/replaced profiles without format migration.
- **Echo or reconstruct MCP query values:** echo risks secrets; reconstruction loses fields. Strict original-identity/redacted-value matching preserves them.

## Consequences

Chat/recovery remains independent of desktop and introduces no legacy Runtime. Machine/live interfaces reuse personal save/credential checks. Costs are versioned protocol, byte revisions, and bounded preflight; moving directories requires reselecting identity. Explicit model tests can incur cost. Narrow tests use real Unix sockets/stdin children/temp profiles/SQLite/local model service for unknown operations/versions, authentication, identity/revision, lock contention, original blockers, single-file failure, redaction, output caps, and timeout. They do not prove real model authentication or production SSH/systemd recovery. This migration reruns no runtime/deployment tests; ordinary saves and skills follow their current successors.
