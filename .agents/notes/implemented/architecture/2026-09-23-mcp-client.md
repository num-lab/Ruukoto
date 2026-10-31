# Agent Note: MCP is an owner-controlled external tool entry

Status: implemented

Original identifier: ADR 0006.

[MCP host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md) replaces the original protocol client, naming, discovery, and SDK-rebuild rules. [Instance MCP](../simplification/2026-10-24-code-instance-mcp.md) replaces Code's project configuration/credential scope. [Tool discovery](../feature/2026-10-25-code-tool-discovery.md), [managed Cua stdio](2026-10-23-cua-official-mcp.md), and [inline images](2026-10-23-mcp-image-results.md) extend the original interface. This note preserves the historical implementation decision while retaining owner allowlists, secret isolation, parameter validation, and no automatic replay of uncertain writes; historical project/HTTP-only claims are not current product limits.

## Problem

Personal needed owner-configured external tools, initially official remote GitHub MCP. A third-party server controls tool names, descriptions, schemas, read-only hints, results, and actual implementation. Merely configuring a server cannot grant authority to model/task text to add services, widen tools, or give project commands arbitrary network/credential access around [access modes](../feature/2026-09-19-explicit-access-modes.md) and [execution isolation](2026-09-20-tool-worker-per-task-container.md).

## Decision

Treat MCP as a controlled external-tool entry, not a network/credential grant to ordinary commands. The owner configures services through trusted authenticated management, never repository auto-discovery, model output, or task text. Retain endpoint, credential reference, explicit tool allowlist, enabled state, and comparable configuration version. Remote hints/descriptions do not authorize tools; unlisted tools do not register or execute in any mode.

Owner-declared string allowlist entries denote read tools. Explicit `write`/`unknown` entries use [MCP approval](../feature/2026-09-23-mcp-write-tools-approval.md)'s concrete operation scope, one-shot consumption, and uncertain-result handling. The initial client delivered reads first while writes were separately accepted; [current-account full access](../feature/2026-10-12-full-access-current-account.md) later supersedes the original all-modes per-operation approval requirement, not allowlist or source checks.

Credential values stay in CredentialStore and never enter model context, tool results, events, or logs. Bind credentials to configured host, MCP purpose, authorization header, and applicable scope; resolve them before each request so revocation takes effect without falling back to anonymous. Endpoint pinning refuses redirects and never forwards authentication to a different target. The owner explicitly trusts the remote executor: an allowlist limits exposed/callable tools, not hidden server behavior, and a token may authorize more than one repository.

Cancellation/timeout/close ends local waiting, not necessarily remote execution. An already sent uncertain call is not automatically retried; late results after close/timeout are discarded and reconnect does not replay it. HTTP transport or local process stop cannot prove remote business effects stopped.

GitHub remains an ordinary MCP service: no service-name branch, GitHub-specific operation/storage dependency, or fallback to old REST. [GitHub retirement](../simplification/2026-09-23-retire-github-module.md) owns removal/migration independently.

## Original implementation and later replacements

The initial client used project-owned `mcp_services` introduced in schema v8, unique by `(project_id, name)`. It stored ID/project/slug/endpoint/credential binding name/allowlist/enabled/config version, never secret values. Every field change incremented version, expected-version mismatch returned `version_conflict`, and configuration plus `mcp.service_changed` committed together. Original authenticated `mcp_configure/list/set_enabled/remove/check` and `ruukoto mcp`/configuration UI returned redacted views; check displayed the endpoint before contacting it. Current Code is instance-scoped, independently stored per instance and separate from Personal, with no project/repository MCP credential scope; the linked instance decision also retires incompatible old parameters rather than silently widening them.

The original credential configurator required `purpose=mcp`, matching host, and `authorization`, rejecting incompatible scope or narrowing it to project plus MCP operation. Generic HTTP and other projects could not borrow the binding. This project rule is historical; current per-request purpose/host/operation and per-instance ownership checks remain, without claiming workspace isolation.

Production endpoints accept HTTPS; loopback HTTP exists for test services, and userinfo is rejected. Pinned fetch contacts only the configured origin/path and rejects every redirect. The original transport was Streamable HTTP with manually configured credentials and no stdio, OAuth, resources, prompts, sampling, elicitation, or server-requested client execution capabilities. Arbitrary stdio/OAuth/resources are still not added merely by protocol support; Cua is a later explicitly managed stdio exception with fixed target/program and real stop/recovery requirements.

Originally each task reread configuration, discovered and pinned tools, and owned its connection until task end/cancel/backend shutdown; authenticated sessions were not shared across projects. Removal/disable/version change/allowlist removal/revocation/host mismatch refused later calls before networking. Additions never broadened an existing task by reconnecting. The original signature combined service version and exposed name/description/schema digest; a changed signature rebuilt SDK session from the same history and rebound hooks because then-current tool lists were fixed at session creation. Explicit initialization failure recorded `mcp.service_unavailable` and omitted that service's tools, while other tasks/tools continued. Definitions counted toward context budget.

Original exposed names were `mcp_<service>_<remote>` normalized lowercase with invalid characters replaced, a 64-character cap/hash suffix, and collision refusal. Both schemas had to be plain object-root JSON schemas no larger than 16 KiB and compilable through TypeBox, with discovery/page/description/time bounds in `MCP_LIMITS`. Invalid schemas disabled their tool rather than bypassing validation through a cast. Current Pi 1.3.0 owns naming, discovery, and registry updates, while host authorization and actual argument validation remain. Descriptions/unrelated metadata no longer invalidate calls merely by changing; model-visible definitions remain recorded.

The old result path distinguished transport error from tool `isError`, preserving text/structured output and describing but not opening image/audio/resource types. Above 32 KiB inline output used ArtifactStore with preview/reference; the 1 MiB hard capture bound marked partial content. Inline images now use the linked image decision, while long results and actual model media still require durable provenance rather than temporary Pi files. Names, descriptions, and results remain untrusted external data.

Shared transport interface ownership is in [transport reuse](2026-10-17-mcp-transport-reuse.md), current code in `packages/agent/src/mcp/transport.ts`, and current operation in the [usage manual](../../../../docs/usage.md). The old `mcp/client.ts` and project wrapper are retired. Pi handles connection/protocol/discovery/recovery, with narrow host per-request credential/evidence hooks. The host simplification also removes generic indefinite URL occupancy and cross-restart SSE recovery: unknown operations retain facts and block automatic continuation/retry of their work, but may be explicitly ended by the owner without claiming remote stop. Managed Cua's real shared-resource restrictions remain distinct.

## Alternatives considered

- Keep REST collection/publishing with a GitHub-specific authorization adapter: preserves existing approved PR/CI writes during transition, but the owner explicitly chose ordinary MCP. Two tool implementations would duplicate exposure and authorization; no REST fallback was retained, and temporary loss of GitHub writes was accepted.
- Implement protocol/transport/cancellation locally: no new dependency in the then-dependency-free project, but the official TypeScript client already supplied these mechanisms. Use the locked SDK and verify negotiated recovery rather than maintaining a compatibility layer. The later move to Pi changes the dependency, not this rationale.
- Update tools in-place through the old SDK API: least rebuild cost and originally preferred, but its creation-time allowlist could not safely replace definitions. Rebuild from the same history was the original solution, now replaced by Pi-owned registration.
- Rediscover during a task/reconnect: immediate additions/schema changes, but could expand the task's authority. The original task-pinned approach prevented that; current discovery remains constrained by host eligibility.
- Trust server read-only hints/descriptions: less owner classification, but server-controlled claims cannot prove no writes. Use owner effect classification.
- Automatically load repository MCP configuration: convenient project setup, but repository content cannot add services or grant authority.
- Spawn arbitrary stdio under backend identity: standard local transport without remote hosting, but restricted tasks would acquire backend privileges absent account/file/network/reaping design. Remote GitHub supported PAT and did not need local spawn; later managed Cua required a separate decision.

These are recorded alternatives from retired `.scratch/personal-agent/issues/16-mcp-github.md` and its specification (offline provenance), not newly invented options.

## Consequences

MCP and builtin tools share product lifecycle, operation records, results, and artifacts; GitHub needs no privileged special case. Disablement/revocation prevents subsequent unauthorized requests, and credential bodies stay outside model-visible records. Remote authority still depends on actual credentials/server implementation: there is no client parameter-level or token-internal single-repository isolation guarantee.

The original costs were HTTP-only/manual credentials, task-bound tool refresh, and signature-triggered SDK rebuild. Managed Cua, instance configuration, and Pi discovery have superseded parts of those costs, not eliminated remote trust or unknown-effect limits. Original real GitHub read connectivity remained unverified pending an owner-supplied independent read-only PAT; simulations are not evidence that this external acceptance later passed. [Desktop settings](../../proposed/feature/2026-10-21-desktop-settings-management.md) reuses configuration/discovery with its own delivery status.

Historical `test/24-mcp.test.ts` used an in-process Streamable HTTP server through real host paths to assert exact requests without credentials: configuration/version/schema migration, paging, name collisions/unsupported schemas, parameter refusal before send, structured output and `isError` versus transport errors, artifact overflow, auth-unavailable behavior, timeout/disconnect no-retry, cancellation cleanup, task-to-task refresh, runtime disable/revoke zero-send, old cross-project isolation/second-service reuse, definition budgeting, and crash recovery marking uncertain calls without replay. Those old project/naming/SDK tests describe their original implementation; current replacements need their corresponding acceptance rather than claiming this historical suite proves them.
