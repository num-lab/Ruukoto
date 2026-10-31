# Agent Note: Render Effort levels as a thick segmented track

Status: implemented

## Problem

A labeled vertical radio list consumed space and obscured Effort's ordered-intensity meaning. The owner requested a thick slider.

## Decision

`composer.tsx` provides EffortSlider: equal-width levels in a rounded thick track. Selected and preceding segments use `--bg-surface-hover`; the selected segment uses `--selection-surface` and heavier type. Replace the radio list below the retained DropdownMenuLabel. Unavailable models disable selection; unknown thinkingLevels for an uncatalogued model display its current level read-only. No model means no control.

Segments remain DropdownMenuItem with `role="menuitemradio"`, preserving menu keyboard navigation, Enter and close-on-selection without another primitive/dependency. Append scoped `.effort-*` overrides in style.css. Explicit levels persist per session; model changes retain `selectionForModel` fallback rules. This supersedes only the Effort radio-list presentation in [the model menu](2026-10-16-demo-header-model-menu.md), not placement/persistence/disable rules.

## Alternatives considered

- A true draggable slider has closer semantics but needs custom focus/arrows inside Radix menus and precise pointer targeting. Menu-item segments reuse existing behavior.
- Taller radio rows are smaller changes but still lack positional-track meaning.
- Moving the track to composer controls crowds model/mode controls in narrow layouts; keep it in the menu.

## Consequences

All levels/current position fit compactly. Text becomes 12 px; long names such as Minimal share segment width, so more than five levels would crowd the menu, beyond the current catalog. Keyboard order follows left-to-right DOM order even when Up/Down looks horizontally mapped. Screen readers announce menuitemradio selection, not a continuous slider.
