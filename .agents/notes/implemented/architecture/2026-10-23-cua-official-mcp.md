# Agent Note: Use official Cua MCP and narrow exclusivity and recovery scope

Status: implemented

[MCP host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md) updates client ownership, Personal v4 and combined recovery interaction. Fixed programs, persistent connections, real stopping proof, no original-action replay and acceptance of a specific new observation remain. [Instance MCP](../simplification/2026-10-24-code-instance-mcp.md) retires Code project configuration and schema 49-to-50 migration, not persistent connections, unresolved recovery or Personal formats. Historical choices below remain explicitly distinguished from current behavior.

## Problem

The earlier plan expanded computer operation into cross-product target claims, HTTP bridging and a persistent original-receipt execution service, repeatedly extending prototype/hardware acceptance work. On 2026-10-23 the owner withdrew cross-product same-desktop exclusivity, requested external preservation of experiments and rollback to before e8479aa1. First-release environments remained local Mac for Code and an independent Linux sandbox for Personal, with unchanged permissions and accepted human-verified recovery.

## Decision

Use official MCP directly: fixed cua-driver mcp --direct on Mac and cua --embedded mcp with the existing Linux sandbox, using maintained MCP stdio transport, now Pi-owned. Normal CLI entry prefers an existing daemon, so the host explicitly selects embedded. Trusted host code fixes program/arguments and retains tool approval/model loops; it does not expose arbitrary-command stdio configuration. Ordinary HTTP authentication remains separate, with later recovery simplification governed by its own note. Original upstream/fixed-source research is offline at `.scratch/cua-integration/research.md`.

Each product instance keeps one main-session computer connection with serialized calls. Remove cross-product, cross-instance and cross-alias target claims; no root registry, global lock or custom HTTP executor. Humans/other controllers can still change the desktop, so observations must refresh and users avoid parallel control. Independent Mac/Linux environments do not share a desktop.

Existing product operation ledgers retain launch identity, requests, results and recovery facts. Cua need not recover lost original receipts across processes. Unknown actions freeze this profile's computer entry. After verifying original stopping, the owner inspects and begins read-only recovery; accepting a specific new observation permits new work. Neither original unknown nor remoteEnded is fabricated. Personal records Cua-specific settlement and shares unresolved predicates across work, sources, reports, settings and saves. Linux CLI close is not guest stopping; whole-sandbox stopping, when needed, requires the owner's choice and preserves disk.

[Personal recovery responses](../bug-fix/2026-10-23-personal-cua-recovery-response.md) saves received original responses separately from acceptable screenshot observations, retaining failures and not overwriting history on re-observation.

Images reuse ArtifactStore/Personal media. A 48-MiB SDK message cap applies before aggregation/JSON parsing. [Delivered-observation eligibility](../feature/2026-10-31-cua-batch-eligibility.md) later replaced the binding-level observed flag with per-window snapshot/screenshot grants derived from projected content, narrowed the image-model preflight to image-producing calls, and added allowlisted `get_guide` plus a canonical `run_steps` subset under one batch approval. Original schema and model-restricted schema are separately recorded. Host rejects target overrides, file output, scripts and lifecycle tools. MCP management selects fixed programs/existing sandboxes and actually displays recovery images. Real desktop/model acceptance is distinct from offline engineering checks; original interfaces/boundaries are offline at `.scratch/cua-integration/spec.md`.

## Management and permission preflight

Owners choose computer type through existing MCP settings/wizards. Host discovers installed programs, verifies versions and hashes automatically. Linux reads only the current account's official sandbox state, using fixed local Docker to verify container identity/isolation/stop policy; it creates no sandbox and changes no policy. Saves retain revision/unresolved-action checks. Missing environment reports only computer prerequisites; ordinary chat/HTTP settings remain available.

Code reads the fixed Driver dump-docs static catalog and filters by existing allowed tools/schema limits. Native supervisor supplies read-only AXIsProcessTrusted/CGPreflightScreenCaptureAccess checks under the same launching-host responsibility chain as direct Driver. No fake session, model task or extra computer runtime is created for settings checks. Permission bits establish only current-host preflight, not actual ScreenCaptureKit capture; another daemon's permission does not transfer. Existing persistent connections perform Linux connection/user-scope checks.

Recovery UI binds original operation/current observation and pages protected original images. Desktop accepts only after all images load; CLI opens verified images in the system viewer for human confirmation. Starting re-observation clears old selection, failure leaves no old-image acceptance, and backend rejects stale observations. Code pause disables new calls before verifying original stopping. Personal normal pause persists a separate host fact, restores it on cold start and checks before sends, closing CLI after in-flight work ends; continuation re-observes. Pause does not fabricate unknown recovery, and closing settings does not stop background actions.

Settings use current stage, screenshot and button order rather than resident implementation warnings or raw evidence prose. Backend guarantees belong in the operation manual; actual failures display at occurrence. Linux whole-sandbox stopping warns that unsaved state is lost and requires confirmation.

## Sending and historical compatibility

Each stdio call rebinds original request/response hooks and transactionally records request/approval consumption before actual write. When SDK local waiting ends, send eligibility immediately expires while evidence writes drain. Slow persistence cannot cause first send after timeout/cancel or contaminate the next call. Connection exit invalidates observations; close is not stopping proof.

The original Code implementation saved MCP facts in tool_ops and migrated schema 49 to 50 while retaining HTTP configuration/history; protocol 38 rejected old clients. Instance MCP later removed that migration and project configuration. Personal originally introduced MCP v3 for Cua while reading old v1/v2 and HTTP history unchanged, with old code rejecting the new format and no unrelated profile-version bump. Current v4 follows host simplification. Both products preserve launch identity after startup failure and freeze computer access if stopping is unverified, while ordinary chat continues.

## Related decisions

| Record | Relationship |
| --- | --- |
| [Rejected Cua proposal](../../rejected/architecture/2026-10-22-cua-integration.md) | Retains why bridging was once chosen; new requirements replace global exclusivity/custom executor. |
| [MCP client](2026-09-23-mcp-client.md), [transport reuse](2026-10-17-mcp-transport-reuse.md) | Adds Cua-specific stdio without weakening HTTP authentication/cancellation limits. |
| [Personal MCP](2026-10-17-personal-durable-mcp.md) | Adds Cua-specific human settlement without changing remoteEnded meaning. |
| [Personal media](2026-10-18-personal-browser-media.md), [MCP write tools](../feature/2026-09-23-mcp-write-tools-approval.md) | Reuses images/approval and never retries because result processing fails. |

Other desktop-settings hits were unrelated. Dedicated execution-recovery/HTTP-fix notes after e8479aa1 left the current tree in the owner-requested rollback. Their full external-archive provenance is `.scratch/cua-integration/archive.md`, not current implemented decisions.

## Alternatives considered

- Existing HTTP gateway: reuses transport, but adds service, TLS, authentication and process-lifetime translation. Fixed official local stdio programs already serve both environments.
- Custom executor: global locks/original receipt queries, but chiefly supports withdrawn guarantees and still cannot reconstruct lost Cua receipts.
- Native Cua SDK: direct calls/structured errors suit embedded computer-control apps, but products already have MCP approvals/results; another SDK adds duplicate tool adapters.
- Arbitrary stdio configuration: more general, but enlarges host command execution. Add only the two controlled Cua launch configurations.
- Temporary settings MCP connection: direct discovery/permission checks, but another persistent identity/failure recovery. Use fixed static catalog/same-host OS preflight for Code; main owns real connections.
- Remove unknown state: least code, but repeats actions after lost post-submission responses. Keep existing ledgers/human recovery and the approved no-replay guarantee.

## Consequences

An instance keeps continuous observations/per-call authorization without unknown-action replay, gateways, global locks or an executor database. Lost responses require human stopping/site verification; reapproval/reconfiguration/general HTTP effect explanations do not clear Cua freezes. Mac direct permissions depend on actual launching host. Linux whole-sandbox stopping loses unsaved state but preserves disk. Other products, instances and humans can still interfere; instance bindings cannot prevent it.

Original connection/recovery evidence is offline at `.scratch/cua-integration/issues/03-target-lifecycle.md`, with selection/pause/image viewing at `.scratch/cua-integration/issues/04-configuration-and-deployment.md`. Node 22/24 stdio fixtures and product recovery consumers did not themselves establish production, real-model or desktop acceptance. Later real-machine evidence is assessed in host simplification, including unresolved Mac idle-stop failures, not promoted to universal success here. HTTP defects remain separately maintained; rolled-back full HTTP fixes/old desktop probes are not restored by this decision.
