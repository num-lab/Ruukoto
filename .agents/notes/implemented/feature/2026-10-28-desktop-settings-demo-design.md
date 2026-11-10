# Agent Note: Use Demo-tested navigation and cards for settings

Status: implemented

This supersedes in-page Code/Personal tabs and shadcn Field layout in [the settings shell](2026-10-21-desktop-settings-shell.md). Form protection, tickets, and request ownership remain.

[Visual alignment](2026-11-07-desktop-visual-alignment.md) supersedes navigation grouping, native Select controls and dialog dimensions while preserving the shared settings composition and state contracts.

## Problem

The old dialog had eight vertical categories, with separate horizontal Code/Personal tabs in Models, Skills, MCP, and Computer. Target/category decisions were split and tab semantics repeated. Each category owned model-settings-* classes and Field layout, creating inconsistent density, widths, and group headings. The independent settings prototype, now under `verification/desktop-settings`, verified a single navigation level grouped by Code/Personal plus shared headings, cards, rows, and controls.

## Decision

The Demo structure/style is the sole settings implementation:

- One-level navigation offers Appearance, Models, Skills, MCP, Computer, Web Search and archived sessions for the sole local product.
- Settings categories determine the page, while activated instance identity determines request ownership. There are no PA categories or product-target controls.
- Shared components live in components/settings.tsx (Shell, NavItem, NavSection, Page, Subpage, Group, Card, List, ListItem, Row) and components/controls.tsx (Button, Select, Switch, Segmented, Input, Search, Tag, Notice). settings.css keeps Demo's light/dark palettes, dimensions, and control values rather than mapping to Desktop tokens. The dialog is bounded by `min(1240px, 100vw - 200px)` by `min(860px, 100dvh - 120px)` to avoid macOS traffic lights. Other values follow Demo. Delete old model-settings-* styles and settings-ui.tsx.
- Each page uses heading/group/card/row. Detail editing expands within list rows from page state, consistently in SSR/runtime. Adding MCP opens a secondary page with a complete form and ends on save/cancel.
- Validation errors appear on the owning control's SettingsRow.error, not an untitled separate row.
- Skills removes expansion, body, disable, and remove actions. Search sits beside the All skills group heading in settings-group-search, <=260px and wraps below in narrow windows. MCP removes reread-configuration and uses arrow list actions. Select is content-width with a cap; Segmented icons are 13px.
- SettingsList rows have equal height, one-line ellipsized title/description, and nonwrapping right controls. Back/close hover changes text color only. Both primary and secondary pages fade at the top; secondary content fades below its back bar.
- SettingsContentsProps.pages is keyed by every SettingsCategory rather than four managed categories, so tests can replace any page.

## Alternatives considered

Retaining Tabs with new styling leaves two-level target/category selection and duplicated target tabs. Partial migration puts two control/card/row systems in one interaction and defers the same choice to every later page. Keeping shadcn Field/Select/Item reuses a library but requires overriding every tested density/width/group detail, effectively maintaining two rule sets.

## Consequences

Settings retains one-level navigation without product switching. State tests and SSR assertions cover structure; real Electron/MyGo themes, focus and backend integration still need product acceptance. Historical failures and evidence remain historical, not current acceptance.
