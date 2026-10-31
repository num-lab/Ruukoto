# Agent Note: Separate Computer and Web Search settings categories

Status: implemented

## Problem

Cua configuration/manual recovery were hidden among MCP services; Desktop had no Web Search management for Tavily credentials or enablement. The owner requested separate categories.

## Decision

Computer is a managed category in Code/PA sidebar groups using the [settings container](2026-10-21-desktop-settings-shell.md); [settings design](2026-10-28-desktop-settings-demo-design.md) replaces old target tabs with groups. Code manages local Cua Driver, PA Linux desktop sandbox, including recovery controls. Storage remains [Cua MCP service configuration](../architecture/2026-10-23-cua-official-mcp.md). MCP pages show HTTP only; each category filters and claims same-name conflicts by service class.

CodeMcpState shares its entire state machine via `mode: mcp | computer`; computer `select(null)` makes a cua-mac draft and filters conflicts by mode. PersonalSettingsPageState maps computer to `revisions.mcp` and the existing save operation.

Web Search is a plain Code-only category with immediate actions, no draft/target tabs. Dedicated `web_search_save_credential`/remove_credential store the fixed `web-search` binding with fixed host/purpose, accepting no caller-selected name/host/purpose. Reuse `list_credentials`; sort effective bindings by name like resolveCredential. CLI-created bindings are read-only with original-command guidance.

The original project switches reused `set_project_web_search`, local snapshot webSearch/settingsVersion and optimistic revisions, with conflict reselection/event refresh. [Instance-wide Web Search](../simplification/2026-10-25-web-search-global-toggle.md) later replaces the project list with one global switch and `set_web_search`. General add/remove credential writes stay unavailable to Desktop. PA remote tools' apiKeyEnv/web-search configuration is not overwritten through a new remote protocol.

## Alternatives considered

- General credential writes reuse operations but lose the purpose-restricted desktop boundary; use two narrow operations.
- A read-only page still depends on CLI and fails the requested management goal.
- Separate Computer storage/operations conflict with the existing MCP decision and require needless migration.
- PA remote web-search editing expands remote management/worker scope; the owner approved Code only.

## Consequences

Desktop manages Code Web Search independently. Computer services/recovery appear only in their own category. Fixed binding name `web-search` matches the agent export; same-name incompatible scope fails with `credential_scope_mismatch`, without replacement/deletion. `test/desktop-settings-computer.test.ts`, `test/desktop-settings-web-search.test.ts` and MCP/backend/Personal tests cover wiring. Real desktop interactions and Tavily connectivity remain external acceptance.
