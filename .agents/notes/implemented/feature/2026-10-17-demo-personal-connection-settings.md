# Agent Note: Demo PA remote-connection settings

Status: implemented

## Problem

The Ruukoto main-session entry replaced global target switching. The owner then requested PA remote settings. The real backend accepts an SSH host alias and remote control directory; the mutable demo cannot establish a connection.

## Decision

Add a PA remote-connection category in the existing Dialog/Tabs with shadcn fields for `host` and `controlDir` only. Keep the backend default `/var/lib/ruukoto/control` and an empty host instead of inventing a configured server. Native required/pattern validation matches backend character ranges. Save applies the pair to App memory; reopening shows saved values and closing discards edits. Save feedback uses an in-dialog `role=status`, cleared on input changes so modal accessibility does not hide feedback outside it.

Add no password, token, port, authentication mechanism or real SSH. The page/feedback explicitly describe simulation, not a successful connection. Refresh resets it. Production migration must use the existing main-process configuration API and complete validation. [Main-session isolation](2026-10-17-demo-personal-main-tab.md) and inspector restrictions remain; settings do not restore global target switching. The [desktop proposal](../../proposed/architecture/2026-10-15-desktop-client.md) retains real SSH/permission behavior.

## Alternatives considered

- A real PA connection proves end-to-end behavior, but the browser demo lacks the main-process bridge. Complete the approved UI design first.
- Restoring target selection/old SSH dialog reuses placeholders but reintroduces global switching and omits directory editing in settings.
- Applying each keystroke removes save state but can apply an incomplete host/directory pair. Use explicit save.

## Consequences

Both targets can open PA configuration. Valid saved values persist in memory; empty/invalid inputs cannot save. Main session, inspector and Code behavior remain unchanged. Controls retain keyboard/theme/layout conventions. Historical regressions/screenshots remain in the offline PA-settings work item.

Engineering checks and browser interaction at 949 px passed historically; narrower layout still required manual acceptance. Browser validation is design feedback, not production path normalization, socket-length or permission verification. Refresh loses settings and no real PA connectivity is established.
