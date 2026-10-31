# Agent Note: Manage Code model credentials by configuration location

Status: implemented

[Non-executing configuration checks](../simplification/2026-10-25-configuration-checks.md) permits display-name changes, unique-ID ordering and genuinely new model IDs; execution fields, built-in overrides, duplicate IDs and references retain validation.

## Problem

Desktop could select session models but not manage provider catalogs/defaults. Removing an auth.json credential may still leave SDK catalog/environment fallbacks; reporting no credential would mislead owners. Full auth resolution may execute secret commands, expand environment templates or refresh OAuth and must not run merely to open settings.

## Decision

Reuse model files. [RuntimeModels](../architecture/2026-10-23-runtime-models.md) owns online revisions, apply latch, model stack and rebuild rollback. Desktop and online/offline TUI share pure model-config metadata reads: stored entry type, catalog apiKey and specific header locations. Show runtime overrides only when the SDK directly proves them. A location's existence is not authentication validity; legacy `configured` means only a stored entry. Members/thinkingLevels come from SDK registration; show unknown levels explicitly, without auth filtering or guessing.

Stored API-key save/remove affects only the selected provider's auth.json entry. Explain that OAuth replacement/removal does not revoke remote tokens. Catalog secrets edit one selected provider/model/modelOverrides field while writing the full redacted catalog, retaining advanced fields/placeholders. Settings never change process environment. Clear submitted secrets; pending verification stores operation/original instance/revision, not secret bodies.

Forms retain read revision, draft and original submission under existing navigation protection. Conflicts retain drafts and reread current state. Lost responses never auto-resend; read-only verification checks original instance/location, not secret equality or actual authentication. User-triggered model tests run directly without extra confirmation/success prose. Yellow/green/red dots mean untested/success/failure, with failure detail on the dot. Results belong only to that provider/model/revision; draft or revision changes reset them. Instance defaults affect later sessions only. Catalog events invalidate session/new-chat menus, prevent old pages replacing new catalogs, and reread runtime defaults.

Overview directly edits default model, Effort and summary model on selection, with right-aligned 240 px model and 80 px Effort controls wrapping in narrow windows. One full provider dialog handles add/edit, connection, stored key, capabilities and advanced catalog secrets. SDK-supported API types are choices; existing custom types remain. Generate new provider IDs internally; owners supply model IDs. Delete is red at bottom-left, Save bottom-right. Remove routine explanations, autosave/saving/draft and default-save-success prose, while retaining OAuth consequences, errors, conflicts and unknown outcomes.

Closing the dialog discards the draft directly, but issued operations keep pending state and overview verification; close never cancels accepted writes. If closed during catalog submission, do not continue to stored-key save after verification. Catalog and stored key use separate revisions: save changed catalog and successfully reread first, then submit the locally held key with its new revision; key-only updates skip catalog. First-step failure/unknown stops the sequence. Second-step failure preserves the fact that catalog saved, without rollback or automatic resend; a secret must be reentered actively.

Environment/overrides/credential-command output cannot supply a complete redaction dictionary. Management errors use fixed actionable diagnostics with safe codes/rollback facts, never raw SDK/remote bodies. Catalog reconstruction/single-field edits retain JSON own fields including prototype-like names; existence tests use own properties to avoid inherited values or lost headers.

TUI header inputs are masked too. Defer model-config events for one editing action, retaining its opening catalog/revision; invalidate/refresh afterward. Concurrent OAuth/catalog edits therefore conflict against the original revision rather than silently replacing it mid-input.

## Related decisions

This implements the model slice of the [settings proposal](../../proposed/feature/2026-10-21-desktop-settings-management.md). [Settings container](2026-10-21-desktop-settings-shell.md) retains form/navigation ownership and [approved Desktop design](../architecture/2026-10-15-desktop-shadcn-demo.md) retains visual origins.

## Alternatives considered

- Treating auth.json configured as authentication is simple but ignores active catalog/environment fallback.
- Full SDK auth resolution reveals more but may run commands, OAuth refresh or network; reserve it for execution/explicit tests.
- Nested provider/default detail pages shorten one screen but add repeated navigation. Direct defaults and one provider dialog reduce steps.
- Unified credential storage normalizes sources but replaces existing configuration and broadens migration/security scope unnecessarily.

## Consequences

Both interfaces share source semantics instead of misreporting fallback as deletion failure/unavailable providers. Pure metadata cannot prove environment/remote auth; explicit tests remain useful. Isolated configurations, mock providers and real local control plane support regressions. Real models, Electron/MyGo experience and quit/reopen require separate environment evidence.
