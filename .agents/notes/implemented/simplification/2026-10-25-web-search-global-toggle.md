# Agent Note: One instance-wide Web Search switch

Status: implemented

## Problem

Original Web Search configuration used projects.web_search, set_project_web_search and project.settings_changed. Owners did not use per-project variation, enabling/disabling whole instances instead. A project-by-project Desktop list magnified unused granularity after Web Search became its own category.

## Decision

Store one explicit switch in core meta under `web_search`, value `{version, state}`, enabled by default with version starting at one. Store.getWebSearch/setWebSearch use expected-version conflicts (`version_conflict`), same-value idempotency without events, and transactional `web_search.changed`.

Control uses `set_web_search { enabled, expected_version? }`, shared by the [Desktop category](../feature/2026-10-25-desktop-computer-websearch-settings.md), configuration-center root section and top-level `ruukoto web-search <on|off>`. Delete the project column; this decision introduced schema 52 from 51 under strict old-data refusal.

ConnectSnapshot.webSearch and the event synchronize Desktop ViewState and configuration center. Task tool assembly, SubAgent precheck and execution gates read the global switch, retaining immediate disable/next-task enable semantics. Project settings events/version now protect instructions only. Workflow configuration summaries use the instance state; switch changes invalidate running workflow source verification and require repinning, like MCP changes.

## Alternatives considered

- Credentials as enablement remove switches but lose temporary shutoff without removing search credentials and leave only credential management.
- Retain an unused project column: fewer migration steps but violates deletion-first; column removal/schema bump follows existing policy.
- Put it in runtime configuration: control writes/events already use meta and snapshots, so another location is unnecessary.

## Consequences

Per-project variation and `ruukoto project web-search` disappear; the top-level command/root configuration section replaces them. The original schema transition requires a new compatible data directory, not migration claims. Snapshot consumers historically default missing backend state to enabled under existing compatibility handling. Tests cover store idempotency/conflict/events, three-stage disabling, root menus and desktop settings. Real Desktop/TUI interaction and Tavily remain external acceptance.
