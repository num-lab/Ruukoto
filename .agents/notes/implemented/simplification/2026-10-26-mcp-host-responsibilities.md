# Agent Note: Narrow MCP host responsibilities and remove unnecessary mechanisms

Status: implemented

## Problem

After comparing built-in Pi MCP, the owner requested the purpose of each additional mechanism and removal of overengineering, then explicitly requested a Pi integration/simplification plan and implementation on 2026-10-26. Original implementation order/acceptance, contracts, pinned upstream research and P0 experiments are offline at `.scratch/pi-mcp-comparison/issues/01-pi-mcp-migration.md`, `.scratch/pi-mcp-comparison/spec.md`, `.scratch/pi-mcp-comparison/research.md` and `.scratch/pi-mcp-comparison/evidence/2026-10-26-p0.md`. P0 exposed missing public error-provenance information; the owner approved a read-only SSE parsing adjustment. Authorization covered repository/isolated-test profiles, not real-profile cutover/deployment.

Ordinary HTTP MCP unresolved calls occupied origin+pathname and blocked general HTTP to the same origin. Without original SSE recovery identity, child work stayed running even after human confirmation that the business effect occurred. This blocked this instance, not remote concurrency; one URL is not one business resource. Original consumers/counterexamples are personal-mcp.ts, personal-tools.ts and personal-mcp.test.ts.

## Decision

For the current personal-use, two-product scope, retain no escalation, no credential leakage, no repeated execution of one approval, no automatic unknown-write replay and reconstructable model input. Pi owns general MCP protocol/discovery; the host owns product authorization, evidence and real resource management.

Code uses official Pi 1.3.0 MCP/tool_search extensions. Personal keeps durable and reuses the same-version standalone pi-mcp package, not a new runtime. Retain HTTP/Bearer/Cua scope and remove the old general client, duplicate discovery catalog/search implementation. Do not add OAuth, arbitrary stdio or Resources. Thin execution wrapping around official factories owns only call identity, actual-pre-send authorization and result artifacts, not another MCP runtime.

Credential simplification retains the minimum useful fingerprints. New/rebound credentials hash the normalized token actually sent. Real token changes use explicit existing settings rotation and invalidate old approvals. v4 migration may retain old references/full-byte digest semantics; explicit rebinding adopts normalized-token digests. Cua combines recovery actions but keeps old begin facts, avoiding historical rewrites just to delete fields. Old durable SSE recheck Tasks retain only non-network retirement definitions. Ordinary unknown operations append human completion facts without changing original evidence. Format/eligibility/stop limits remain explicit.

| Mechanism | Purpose | Decision |
| --- | --- | --- |
| Service allowlists, operation snapshots and single-use approvals | Prevent target/argument substitution or repeated approval execution | Retain through Pi hooks/existing approvals, not a separate MCP approval system. |
| Personal approval for every MCP call and unknown-write classification of read failures | Avoid trusting remote read hints without local classification | Reuse owner-confirmed Code read/write/unknown classification. Authorized reads skip per-call approval; writes/unknown retain rules. |
| Credential target/purpose isolation, revocation and no anonymous fallback | Prevent secret leakage and post-revocation use | Retain in existing credential/authentication interfaces, without duplicate OAuth or synonymous validation layers. |
| Full credential-file byte fingerprint | Prevent same-path token replacement retaining old approval | Protect account/permission binding and pending approvals without treating newlines/managed refresh as permanent outages; silent external account replacement still cannot bypass checks. |
| Configuration revision, service identity and lost-response readback | Prevent stale forms, same-name recreation errors and duplicate submission | Retain shared product configuration protections. |
| Whole-definition deep equality, including descriptions | Keep model-seen definitions aligned with execution | Record model-seen definitions and retain schema, eligibility and authorization-relevant checks. Description/unrelated metadata changes do not alone reject; equal schema never proves unchanged service implementation. |
| Mandatory full JSON-RPC/cursor persistence per call | Original-stream queries, audit and reconnect recovery | Replace with pre-send operation identity, target/arguments, authorization/start records and unknown when results are absent. Model-seen definitions/content remain complete in sessions/artifacts. |
| Indefinite ordinary HTTP endpoint/origin occupancy | Prevent tool/delegation bypass of unknown operations | Remove generic URL-wide blocking. Hard-pause original-work automatic continuation/retry; allow unknown reports and explicit owner completion/new-work choices without claiming remote stopping. |
| Cross-restart original-SSE recheck Tasks/management | Recover late terminal responses | Retire. Pi handles in-session stream recovery; the generic host does not promise cross-restart original-result recovery or require cursors for human completion. |
| Persistent image/long-result artifacts and bounded input | Reopen original history without exhausting input | Retain common artifacts/validation, remove equivalent MCP-only duplication. Pi temporary files do not replace persistent history. |
| Cua fixed program/target, main-only serial connection, observations and stopping | Prevent wrong desktops, crossed input or old actions invalidating observations | Retain: real shared desktops differ from URL occupancy; a working stdio connection is not lifecycle management. |
| Separate human begin-recovery and screenshot steps | Record recovery choice and bind a new observation | Combine interaction while retaining original stopping, new screenshot identity/final acceptance and explicit unsaved-state-loss choice before sandbox stop. |

Ordinary HTTP business effects and remote completion remain distinct. Completion follows source/resource separately: original work must not automatically resend or delegate a retry; reports can end with unknown outcomes and owners can end logical work, retaining old unknown records. No timeout auto-release, fake stopping from human statements or next step depending on unknown results. Before releasing a SubAgent, locally owned execution must still be verified stopped. Real shared-resource occupancy is not released by report termination.

With custom cross-restart stream recovery removed, full protocol envelopes cease to be mandatory persisted evidence for every call. Business-call records still commit before sending; failed recording means zero sends, and restart never reexecutes a started call without results. Existing raw evidence/history remains immutable. Original POST session-expiry rejection is distinct from lost responses after admission; client-synthesized errors are not remote terminal proof.

Original Cua evidence covered formal desktops, models, lost-response cold recovery and owner acceptance of new observations, retained offline at `.scratch/cua-integration/evidence/05-acceptance.md`. Mac idle-connection cleanup still produced identity_unavailable and freezing; not all stopping checks passed. Whether idle disconnection without pending writes can require only re-observation needs separate verification. This change does not remove stopping criteria or add global locks/gateways.

## Related decisions

The audit searched MCP, endpoint occupancy, SSE, credential fingerprints, tool signatures and Cua. Partial supersessions preserve original decisions/other constraints; no note is wholly absorbed and sealed archives remain frozen.

- [MCP client](../architecture/2026-09-23-mcp-client.md): replaces protocol, naming, SDK reconstruction and independent catalogs; retains allowlists, argument checks, secret isolation and history.
- [Personal MCP](../architecture/2026-10-17-personal-durable-mcp.md), [transport reuse](../architecture/2026-10-17-mcp-transport-reuse.md): replaces URL occupancy, cross-restart stream rechecks and old client, retaining unknown facts, no replay and one runtime authority.
- [Write approvals](../feature/2026-09-23-mcp-write-tools-approval.md), [instance configuration](2026-10-24-code-instance-mcp.md): retain authorization, isolation and concurrent-save protection with local effect classification.
- [MCP images](../architecture/2026-10-23-mcp-image-results.md), [official Cua](../architecture/2026-10-23-cua-official-mcp.md): retain historical media/real desktop protection, replacing separate public begin-recovery interaction.
- [Code on-demand discovery](../feature/2026-10-25-code-tool-discovery.md): Pi owns search/naming/branch discovery state; each selection/call still narrows to current source eligibility.
- [Configuration proposal](../../proposed/architecture/2026-10-25-operation-scoped-configuration.md), [save/publication](../architecture/2026-10-25-personal-settings-versions.md): retain per-object publication, save/effect receipts and original selections, narrowing excessive format-migration/ordinary-unknown blocking.

Other command/background/source/configuration/history notes keep independent rules. Non-MCP desktop settings are unaffected. The [rejected Cua proposal](../../rejected/architecture/2026-10-22-cua-integration.md) still rejects global exclusivity/custom gateways.

## Error-provenance exception after P0

Pinned Pi 1.3.0 synthesizes local failures after admitted-SSE response loss as ordinary JSON-RPC errors. Public callbacks give no provenance, and a real server can return identical errors. Loopback comparison proves send/onMessage alone cannot make the required distinction; neither message parsing nor default remote-completion classification is acceptable.

The owner chose to retain Pi 1.3.0 and permit read-only SSE response-origin parsing without weakening S3/A4 source/completion requirements. This narrow protocol exception reuses maintained eventsource-parser as a declared direct dependency and Pi's public JSON-RPC parser. It observes actual HTTP bytes before giving them to Pi, without asynchronous tee, response rewriting or changed Pi recovery arguments. Responses bind original client/transport instance plus request ID, avoiding repeated IDs across services/reconnections. Necessary persistence precedes byte delivery. Normal EOF supplies the parser's terminating blank line; canceled/broken streams do not. The observer records received responses only: no sends, retries, second client or cross-restart cursor. Observation failure remains unknown; upstream still owns connections, execution, discovery and recovery.

A future public upstream source API could remove this parsing. Read-only inspection of released 1.4.0 found the same gap, so a current-version upgrade alone did not solve it. Treating every protocol error as unknown would preserve no-replay but force human completion for actual remote terminal errors too, so it was not chosen. CallToolResult.isError remains separate from protocol errors.

P0 also showed official 404 reconnection leaves old detached clients outside default shutdown. The host retains only lifecycle handles for already-created transports, cleaning retired transports after original operations stop and joining cleanup before SDK destruction. It neither reuses connections nor owns a second client; close is not Cua stopping proof. Official registration still needs explicit MCP wildcard eligibility and a thin empty OAuth interface. Actual authentication uses original resolver; configuration/credential authority does not migrate to Pi default files.

## Alternatives considered

- Retain every host mechanism and replace transport only: easiest regression/recovery preservation, but leaves indefinite ordinary-read blocking, rotation friction and duplicate recovery workflows.
- Adopt Pi defaults and delete host evidence: least code/broad compatibility, but violates cross-restart approvals, unknown-write no-replay, historical media and Cua stopping.
- Retain product guarantees, narrow ordinary-HTTP recovery promises and reuse Pi: removes protocol duplication/excess pauses, at the cost of human inspection instead of guaranteed automatic lost-result recovery. Chosen.

## Verification

- Target/argument changes or revocation after approval yield zero sends. Rejection/repeated approval never duplicates operations; pre-send persistence failure sends nothing.
- Crash after a write but before result persistence never resends on reopen. Original work cannot continue automatically; it can report unknown and the owner can explicitly end it. Unrelated queries/independent work are not indefinitely blocked by URL.
- Authorized reads skip per-call approval; remote hints cannot escalate. Account/permission replacement invalidates pending approvals; managed refresh does not permanently disable all future calls.
- Model-seen definitions/text/images reconstruct after reopen without history rewriting. Protocol rejection, remote results and synthetic client failures do not collapse into success or non-execution.
- Cua target binding, per-instance serialization, original-action no-replay, stop verification, new-observation acceptance and sandbox-stop confirmation retain counterexamples and required hardware evidence.

## Consequences

Ending work with an unknown result does not stop remote execution. Owners must know this and use actual business state to resolve later conflicts; simplification is not timeout unlocking. A service needing automatic cross-restart recovery/resource exclusivity must be evaluated from real receipts/resource identities, not restored URL assumptions.

Both products pin Pi 1.3.0. Code uses public factories/explicit host extensions; Personal uses the same client version. Configuration/operation versions preserve historical entries. The original change raised Code protocol 41 to 42 without SQLite layout change, retaining then-schema 53; later constants supersede these historical numbers. Engineering checks/independent implementation review depend on final combined evidence. Isolated HTTP, Faux models and stdio processes do not establish real HTTPS write services, models, IM or Cua; missing product prerequisites retain resumption conditions. Cua idle disconnect remains frozen under original stopping criteria.

SDK system prompts/tool registration remain in JSONL. Host compaction indices count conversation messages only, matching context assembly; request snapshot v1 still separately records system prompt, tools and conversation. SDK shutdown belongs to one Driver execution, and a new execution waits for close. Stop failure retains original SDK/rebuild requirement. Closing a session stops only its owned Cua; instance shutdown performs global stopping so unrelated child cleanup cannot interrupt main's computer connection.

Fixed tool direct/deferred identities publish together to official registry and host eligibility wrapper, so official prompts reflect the actual available path. Do not edit prompt text to hide registry inconsistency. Exposure changes enter existing selection and publish only without in-flight calls.
