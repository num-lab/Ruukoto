# Agent Note: Manage configuration through authenticated desktop settings

Status: proposed

[Single product](../../implemented/architecture/2026-11-10-single-product.md) retires Personal configuration, remote pairing and maintenance scope. This proposal retains combined software-work settings acceptance; delivered pages do not alone prove the remaining native experience.

## Problem

Configuration needs a stable entry independent of the selected chat. Mixing form drafts with changing connection state can send an old save to a new instance, while resolving live authentication during listing can execute credential commands or refresh OAuth unexpectedly.

## Proposal

Keep Models, Skills, MCP, Computer and Web Search in the existing settings container. [Settings shell](../../implemented/feature/2026-10-21-desktop-settings-shell.md) owns form protection and request tickets; [visual design](../../implemented/feature/2026-11-07-desktop-visual-alignment.md) owns presentation. Configuration requests bind the activated profile and original operation across asynchronous reads and saves.

Models display provable redacted credential locations without resolving dynamic secrets. Replacing/removing an owner-selected stored entry does not imply every environment/directory source disappeared; configured is not tested. Connection tests remain explicit. Online and offline configuration share semantics, with core storage activation preceding offline writes and model readiness.

MCP is instance-wide without workspace/source selectors. Service allowlists, effect classifications, credential purpose/endpoint binding and versioned saves remain authoritative. Computer uses fixed managed Cua configuration and original stop/fresh-image recovery, not arbitrary stdio. Broader configuration does not widen old task, role, workflow, schedule or approval authority.

Skills come from the backend account’s fixed HOME directory and have read-only catalog/diagnostics. [HOME discovery](../../implemented/simplification/2026-10-28-home-skills-discovery.md) supersedes managed import/enable/remove. Original skill snapshots remain immutable and future references prevent casual physical deletion; this is not a reason to restore a management API.

After a lost save response, query the original outcome/current version instead of resending. Preserve drafts and original instance identity until resolved; concurrent changes must not silently cross forms or instances. Backend revision/authorization checks remain authoritative even when a page hides routine refresh controls. Ordinary saves do not imply service/account lifecycle operations.

## Alternatives considered

- Direct desktop file edits or assembled shell commands: fewer APIs, but bypass locks, revisions and original-operation recovery and broaden renderer powers.
- One generic hot-configuration framework: unifies forms, but adds indirection beyond existing module ownership. Share only the settings container and actual request contracts.
- Resolve authentication while listing sources: gives apparent current validity, but can execute commands or refresh OAuth. Show known locations and test explicitly.
- Move/delete skill packages when idle: reduces retained files, but old snapshots can still be consumed by future work. Fixed HOME discovery and preserved historical references avoid pretending idle means unreferenced.

## Acceptance criteria

Verify settings without an open conversation, instance-wide MCP, read-only skills, provider/model gates, credential redaction, original-key lost saves and configuration readback after close/reopen. TUI/offline entry semantics agree with Desktop. Actual Electron/MyGo interaction must cover themes, focus, selection, conflict and recovery; SSR/mock services establish only their own scope. Missing model/native/Linux evidence remains explicit, and the retired PA portion is not planned rather than passed.

## Risks

Saved and applied model state can differ while tasks retain their original stack. Display names are not execution identity. A changed or disconnected profile cannot become a new destination for retained drafts. Real Cua stopping and full fresh-image display remain separate from configuration success. Combined engineering and owner-experience acceptance stays open where evidence is absent.
