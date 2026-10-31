# Agent Note: Preserve original profile and maintenance identity in Personal settings pages

Status: implemented

[Direct Personal save](../simplification/2026-10-28-desktop-personal-direct-save.md) supersedes generic confirmation/original-form-revision constraints. [HOME skills](../simplification/2026-10-28-home-skills-discovery.md) makes Skills fixed-source/read-only while retaining legacy-maintenance queries. [Settings versions](../architecture/2026-10-25-personal-settings-versions.md) replaces universal stop-save-start with ordinary save, per-object waiting, and original-key verification. [Tailscale connections](../architecture/2026-10-24-personal-tailscale-https.md) unifies chat/settings connections. Original profile/authentication/draft/legacy-recovery rules remain.

## Problem

[Settings planning](../../proposed/feature/2026-10-21-desktop-settings-management.md) covers both products, but Code provider catalogs, workspaces, credential stores, and local pickers cannot represent Personal. The original [SSH management connection](2026-10-21-personal-settings-ssh.md) also had no identity/status relationship with old Personal chat.

## Decision

Models, Skills, and MCP use the shared settings dialog and Code/Personal navigation groups from [Demo design](2026-10-28-desktop-settings-demo-design.md), through one Host's restricted settings entry. Opening a page queries the remote profile, sharing a controller's in-flight read. Returned profile pins ownership; old chat status neither establishes management connectivity nor invalidates requests. Drafts stay in memory. [Shell guards](2026-10-21-desktop-settings-shell.md) protect navigation; page generations discard late replies and reject another profile's response. Reuse UI primitives/styles and shared safe skill-body rendering, not a synthetic configuration provider.

Models edit real single-model fields and environment references, using the original parser for field errors. Explicit tests connect separately; edits invalidate old test results. The original Skills page distinguished library-configuration and managed-manifest revisions, browsed remote directories, previewed/imported with program-obtained identity, kept external sources read-only, and logically removed packages without deleting old references. HOME discovery now replaces those mutation controls with fixed-source reads.

MCP uses real single-service fields, explicit anonymous auth or remote private credential files. Fetch the full original allowlist/tool definitions page by page before editing rather than save summary rows. Tool selection grants allowlisting, not invented Code effect classes; remote annotations do not remove approval. Legacy configuration import has separate confirmation and blocks adding services whose disabled state cannot be represented beforehand. Host preflight reads one configuration at a time and MCP/tool definitions in small pages so a valid large configuration does not exceed limits before paging.

The original maintenance interaction showed scope/impact and required stop/save/start confirmation. Save-and-continue retained intended navigation while temporarily replacing the leave prompt with maintenance confirmation, navigating only after verified save/start or returning to the leave choice on cancel. Host owns preflight, stop proof, locked save, and recovery. Busy state lists pending work without canceling it. Saved-not-started/unknown maintenance retains pending state and allows original-config read, explicit original-service recovery, or completion of manual verification, never blind resubmission. Later direct-save/version decisions supersede ordinary-save restrictions, not legacy pending recovery. Read-only/offline/missing-credential/conflict failures retain comparable drafts.

[Machine settings](2026-10-21-personal-settings.md) gives managed changes consistent saved/target receipts so Host resumes after manifest commit without treating save as model/MCP test success. The original slice did not claim Desktop chat readiness merely from settings connectivity; later Tailscale wiring owns that. [Cua management](../architecture/2026-10-23-cua-official-mcp.md) owns fixed-sandbox selection/online pause-resume outside config stop-save-start.

## Alternatives considered

A Personal-as-Code provider shares forms/state but invents catalogs, workspaces, credential semantics, and hot-save behavior. Old chat online status saves a read but incorrectly blocks a separate valid management connection. Automatic shutdown shortens interaction but conceals operational impact and confuses save with testing; the original maintenance flow made that explicit, with later scoped save simplification separately approved.

## Consequences

Both shells manage three real configuration families through shared Host without new bridge methods, dependencies, or local secrets. Legacy maintenance still needs the supported original service/environment and original-request verification. Unknown outcomes require comparison, not promised automatic draft recovery/rollback. Later ordinary saves may leave the page under their superseding rules. Automated state/protocol/browser substitutes prove engineering only; real Linux service, credentials, and native dual-shell experience remain separate acceptance.
