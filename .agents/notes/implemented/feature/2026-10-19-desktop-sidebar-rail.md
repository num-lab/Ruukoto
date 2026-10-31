# Agent Note: Keep an icon rail when the left sidebar collapses

Status: implemented

## Problem

The collapsed left sidebar had zero width, opacity zero, inert content, and no pointer events. Only its title-bar toggle remained accessible. The owner wanted roughly two icons' width with Personal and Settings icons, avoiding expansion just to open either.

Hiding the entire sidebar would remove rail controls from the accessibility tree. A zero-width sidebar with fixed-width content would also overflow into clipping. The former native toggle endpoint, 84px, assumed zero sidebar width and traffic-light spacing rather than a rail.

## Decision

`.app-window` supplies one `--sidebar-rail` value of 48px:

- Collapsed sidebar width becomes the rail width, retaining opacity/pointer events and `is-collapsed` as the selector switch.
- `sidebar-content` uses the same width. Direct children other than window-control space, `.personal-row`, and `.sidebar-bottom` use display:none; workspace heading, filter, and tree leave both rendering and accessibility trees.
- Personal and the following Scheduled placeholder move down 10px in both states; their original 10px gap decreases by 4px. Collapsed rows become centered 30px squares with hidden text, keeping icons stationary during the transition. Settings stays centered in `.sidebar-bottom`. Existing buttons and aria-labels remain without new wrappers. Scheduled still only shows a message, not real scheduling data.
- Hide the left resize handle while collapsed because the rail is fixed-width.
- Native title-bar left padding becomes `--sidebar-toggle-closed + 30px - --sidebar-rail`, preserving the first tab's relation to the toggle. Collapsed `--visible-left-width` is the rail width for inspector-width limits.

Settings can open without sidebar=true, keeping the rail collapsed. Closing keeps existing focus return to the collapse button. Personal only switches target; it no longer appends a Ruukoto top tab. Both openSession and notification navigate open top tabs only for Code. Expanded Personal uses the full rounded selected row; collapsed equal width/height produces square selected/hover blocks through the same rounding rule.

## Alternatives considered

Separate rail DOM duplicates state/focus and revives toggle handoff problems. Keeping inert makes icons decorative; keeping aria-hidden but not inert makes visual and accessible interaction disagree. Hide only unavailable items instead. A 44px rail fits one icon/padding, but 11px margins around the collapsed square align with expanded spacing and better match the requested width. Moving the toggle to the rail edge would overlap Personal/Settings; retain its title-bar placement and account for the rail.

## Consequences

Personal and Settings remain one click away with the same sidebar DOM/toggle and focus lifecycle. The fixed 48px rail is coupled to 30px control squares; additional row/settings entries need a new width allocation. The collapsed workspace tree does not render and rebuilds on expansion, while filter/scroll state follows existing components. Keyboard/pointer resizing and reduced motion retain existing rules. Backend requests and snapshot fields do not change.
