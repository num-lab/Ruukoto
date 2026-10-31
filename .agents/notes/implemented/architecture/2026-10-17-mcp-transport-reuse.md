# Agent Note: MCP transport receives host credentials without owning legacy projects

Status: implemented

[MCP host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md) replaces the old SDK implementation, discovery limits and cross-restart original-stream verification with Pi MCP. Host-owned resolution, pinned targets, secret isolation and the inability of cancellation to prove remote stopping remain. [Cua](2026-10-23-cua-official-mcp.md) adds controlled stdio and per-call evidence hooks; products own target binding, persistent connections and recovery.

## Problem

The [Personal durable migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) reuses only lower-level capabilities without task state. The [MCP client's](2026-09-23-mcp-client.md) public connection API required McpServiceConfig/CredentialStore, forcing Personal HTTP reuse to fabricate legacy project/configuration objects. These were type imports: the problem was public interface coupling, not loading old core at runtime.

## Decision

mcp/transport.ts owns SDK transport, endpoint validation, target-pinned fetch, discovery, calls and error classification. connectMcpEndpoint accepts service identity, fixed endpoint, timeouts, an optional per-request token resolver and host request/response recording hooks. It does not accept arbitrary fetch, headers, OAuth refresh or request configuration. Callers own/close connections; transport owns no tasks, approvals, projects or credential store. Current protocol implementation follows Pi MCP under the superseding note.

The trusted host resolver verifies original credentials' target, purpose and source scope; the interface grants none of these permissions itself. Only absent resolver means anonymous. An empty token or ordinary resolver exception fails that request before sending with static auth_failed, without anonymous fallback or secret-bearing exception text. Host-thrown McpError retains classification/readable explanation; callers must keep that explanation secret-free.

The original mcp/client.ts adapter retained McpServiceConfig/CredentialStore, calling getForUse on every request to check projectId/mcp scope and host. It re-exported original symbols with one McpError constructor shared by both entries. Runtime, tool plans, router and Driver retained entry/call/close ownership without data/dependency/exports changes. Configuration still owned purpose/header validation; that wrapper was not a claim of complete per-request purpose checking. [Instance MCP](../simplification/2026-10-24-code-instance-mcp.md) later removes project scope, and Pi integration replaces the old client while retaining product credential ownership.

The original locked SDK used listMaxPages to cap discovery at 16 requested pages, raising too_many_pages if another page was required, and capped successful lists at 64 tools with each page's timeout. Its no-cursor listTools already aggregated pages, so a surrounding loop could not enforce request count; SDK limits replaced redundant manual pagination. Repeated cursors followed SDK termination rules without another protocol test. These numeric limits belong to that replaced implementation, not a promise about current Pi discovery.

HTTP close, cancellation and timeout end local waiting only. Remote MCP work may continue; neither client shutdown nor Linux local-scope stopping proves remote exit. [Write approval](../feature/2026-09-23-mcp-write-tools-approval.md) retains unknown-effect/no-replay rules. The original [Personal consumer](2026-10-17-personal-durable-mcp.md) pinned complete requests/responses and used shared original-SSE GET recovery only for late terminal replies matching the original call, never resending tools/call. Cursor and same-event response were persisted together, with missing evidence remaining unknown. Cross-restart stream recovery is now retired under host simplification; this records its original decision, not a current transport capability.

## Related decisions

The original active-note audit searched MCP, credentials, cancellation, stop proof and durable. Migration, client, write approval and [full-access commands](2026-10-17-personal-full-access-commands.md) retain permission, HTTP cancellation and local command-stopping decisions. This note owns interface responsibilities between transport and legacy assembly. Other execution/business/channel/scheduler notes are unrelated; no note was wholly absorbed or obsolete.

## Alternatives considered

- Construct legacy project/credential objects for connectMcpService: almost no shared change, but Personal has no legacy project, and fabricated objects reintroduce the old domain without accurately expressing Personal source scope.
- Copy a Personal client: independent product changes, but protocol, pinned targets, limits and error classification have no product differences; duplication creates two security implementations.
- Keep the old pagination loop: fewer edits, but the SDK aggregates every page on its first iteration, violating the declared 16-page cap. Use SDK limits/structured errors.
- Treat a persistent Linux worker or HTTP DELETE as remote stop proof: uniform command-like interface, but these prove only local process/transport-session termination, not remote tool exit. There was no new stdio requirement in this slice.

## Consequences

Products share transport without legacy project ownership; compatibility adapters originally retained old callers. Hosts still verify authorization per request. Lost HTTP results have no generic remote stopping proof. Original durable consumers therefore conservatively retained unknown occupancy; current ordinary-HTTP logical completion follows the superseding decision without rewriting remote facts or replaying writes. Original regression/independent review is offline at `.scratch/personal-pi-durable/issues/27-mcp-transport.md`. Transport tests do not establish real MCP, model or IM availability.
