# Agent Note: Quieter Desktop notices and inspector entry points

Status: implemented

## Problem

The toast always carried a green success dot, even for errors, sat over the composer at the bottom of the window, could not be dismissed and disappeared without motion. The offline state printed raw socket errors such as `connect ENOENT …/control.sock` as its main sentence and showed a no-network icon while still connecting. The inspector new-tab page repeated a 22px heading and a description under every entry. Sparkles stood for both Personal and SubAgent tabs, while the sidebar used a chat icon for Personal. The inspector toggle stayed visible but disabled without a conversation, and the new-chat composer was pinned to the bottom of an empty canvas.

## Decision

The toast has no status dot, sits centered 56px from the top below the header, dismisses on click and leaves with a 180ms `toast-out` before removal; it still expires after five seconds and enters from slightly above. The connection empty state shows a spinning loader while connecting and the no-network icon otherwise; its sentence is the status detail or generic guidance, and the raw error, when present, appears separately as selectable caption-sized monospace text. The new-tab page lists one 36px row per entry with a 16px icon and title only. Personal uses `MessagesCircle` in the tab bar and its empty state, matching the sidebar; SubAgent tabs use `Bot`, matching agent activity. Without a current Code conversation the inspector toggle is not rendered. The new-chat workspace picker and composer are vertically centered with a 10vh bottom offset. The composer context ring is drawn thinner at 16px so it no longer reads as an unselected radio button.

This changes the toast motion in [motion polish](2026-10-19-desktop-motion-polish.md) and the always-available inspector toggle from the [header model menu](2026-10-16-demo-header-model-menu.md) when no conversation exists; other decisions in those notes remain.

## Alternatives considered

A toast component with variants and an action area would separate errors from notices, but every current message is a notice or failure and none has an action, so the dot is removed instead. Keeping descriptions as tooltips retains the text without layout cost, but the entry titles already name the tool. Disabling rather than hiding the toggle preserves header layout, but a control that can never act without a conversation adds noise.

## Consequences

Messages no longer cover the composer and can be cleared early; multiple messages are still joined in one toast. Raw errors remain available for diagnosis without leading the explanation. Renderer tests cover the new-tab markup and the hidden toggle; toast placement and motion are reviewed through screenshots.
