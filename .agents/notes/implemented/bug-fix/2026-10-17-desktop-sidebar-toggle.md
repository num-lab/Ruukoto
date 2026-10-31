# Agent Note: Continuous sidebar-toggle motion

Status: implemented

## Problem

The sidebar collapse button and title-bar expand button were separate nodes. Switching state mounted the title-bar button before the sidebar width transition finished. Demo frame measurements showed x jumping from 210 to 268 before moving to 36: a 58px jump to the right. Native chrome also reserves traffic-light space.

## Decision

`app-window` owns one permanent button outside the sidebar's inert area, retaining its ref, focus, click, and keyboard entry points. `aria-controls` and `aria-expanded` expose state. Expanded `left` is sidebar width minus 42px; collapsed endpoints are 16px in Demo and 114px in Desktop. Desktop reserves another 30px on the left for search, as defined by the [search decision](../feature/2026-10-21-desktop-spotlight-search.md).

Button left and sidebar width use `200ms ease`. The button sits above the title bar and is explicitly `no-drag`. Collapsed title-bar padding is the button endpoint plus 30px, preserving tab endpoints; padding also transitions. Pointer and keyboard resizing disable the left transition. Reduced motion follows the global preference.

The [Desktop migration](../architecture/2026-10-17-desktop-demo-v4.md) still owns native traffic-light and glass layers. [File-tree feedback](../feature/2026-10-17-desktop-file-tree-loading.md) remains independent.

## Alternatives considered

Delaying the new button hides a one-way jump but leaves no usable button during handoff and complicates focus and rapid reversal. Compensating the new node's position still synchronizes two nodes and focus. One permanent button removes the handoff. Removing sidebar animation loses an existing interaction requirement.

## Consequences

The same DOM node moves continuously left during collapse and retains focus. Position constants remain coupled to the 26px button and title-bar spacing. The historical Demo frame record decreased monotonically from 210 to 36; source assertions and SSR protect the single node and its positioning owner. Native MyGo and window-size experience gaps are recorded in the offline copy of `.scratch/desktop-shadcn/issues/23-files-sidebar.md`.
