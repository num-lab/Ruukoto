# Agent Note: Desktop appearance follows a persisted host preference

Status: implemented

## Problem

The renderer started every launch in dark mode from `useState(true)`, never persisted a choice and ignored the system appearance. The window's native vibrancy material followed the system rather than the app, so a dark page over a light system rendered a gray, washed-out sidebar. `index.html` had no initial class, so the first frame could flash light before React switched to dark.

## Decision

`DesktopAppearance` (`apps/desktop/src/shared/bridge.ts`) is `"system" | "light" | "dark"`, default `"system"`. Each host owns the preference in its own user-data directory as `desktop-preferences.json` with shape `{ "v": 1, "appearance": "system" }`, written by temp file and rename. A missing file resolves silently to `"system"`; corrupt content, an unknown value or another read failure resolves to `"system"` with one `[ruukoto:desktop]` stderr line. Electron implements this in `apps/desktop/src/main/appearance.ts` and MyGo in `apps/desktop/mygo/appearance.go`; the bridge exposes `appearance()` and `setAppearance(value)` through trusted-sender IPC, and invalid values are rejected with `invalid_params`.

Hosts apply the preference to the native appearance source before the window exists: Electron `nativeTheme.themeSource`, MyGo `mygo.Theme.SetSource`. The native material and the page's `prefers-color-scheme` then agree. The renderer never reads the stored value to choose colors: `main.tsx` sets `html.dark` from `matchMedia("(prefers-color-scheme: dark)")` synchronously before React renders and on each `change` event. The stored value only drives the System/Light/Dark segmented control in Settings → Appearance. Control+Shift+L stores the explicit opposite of the current effective scheme.

## Alternatives considered

Renderer `localStorage` would avoid host IPC, but the host could not read it before creating the window, so the vibrancy material and first frame would still disagree. Deriving `html.dark` from the stored value would duplicate the host's resolution of `"system"` and could diverge from the native material. A two-state toggle keeps the old control but cannot follow the system, which the owner requested.

## Consequences

Theme changes propagate through the native appearance, so the renderer has one source and terminal, CSS and vibrancy stay consistent. Chromium dispatches `prefers-color-scheme` changes during rendering updates, so a hidden or fully occluded window applies a change only once it is visible again; automated CDP checks must bring the window to the front. Tests cover preference loading and saving, the three-option control and the absence of descriptions; native vibrancy, MyGo appearance and first-frame paint on real macOS remain manual acceptance.
