# Agent Note: Integrate Cua computer operation through controlled MCP for both products

Status: rejected — The owner withdrew cross-product desktop exclusivity and chose direct official MCP

This records the rejected rationale, not implementation guidance. [Official MCP integration](../../implemented/architecture/2026-10-23-cua-official-mcp.md) supersedes it. Complete experiments remain outside the repository; the offline provenance index is `.scratch/cua-integration/archive.md`.

## Problem

The owner required Cua in ruukoto-code and Personal, initially local macOS and an independent Linux desktop sandbox under existing MCP permissions. MCP then supported HTTP only while Cua normally used stdio. Neither product delivered MCP images to vision models, and generic MCP had no persistent computer-target occupancy. Configuration alone could enable calls without screenshots and misdirect actions after reconnection/multiple sessions. Original scope/contracts/acceptance are offline at `.scratch/cua-integration/spec.md`.

## Proposal

Retain each product's models, sessions and permissions, preferring a fixed executor's stdio-to-Streamable-HTTP bridge. Shared agent code handles protocol/stateless image validation; Code keeps core/Runtime ledgers, Personal keeps durable. Each reuses its media artifacts/provider chain. Inline MCP images extend the former text-only result limit while old history remains readable.

The owner explicitly registers/binds a computer target. Source, configuration revision and approval are checked immediately before sending; remote read-only annotations do not authorize. The target binds persistently to main. Pause/handoff/unbind first verifies in-flight actions. Executor-side target identity establishes exclusivity, not URL, HTTP session or local in-memory mutex. Models use only bound targets and actual window references.

Bridging is a candidate, not a claim that an existing gateway provides durable receipts/exclusivity. Original probe 01 must first pin versions, target claim/release, cross-call sessions and original-result querying. If insufficient, revise the adapter and independently review before business tools. Production endpoints stay HTTPS; using loopback HTTP in local products requires a separate explicit decision. The probe's offline path is `.scratch/cua-integration/issues/01-transport-and-lifecycle-probe.md`.

After sending, unknown effects and remote completion remain separate. Original-stream/operation queries only read existing receipts, never repeat actions. Bridge close/Cua session termination is not stop proof without actual verification. Gateway-generated HTTP/JSON-RPC errors, response-budget interruption and parsing failures do not prove downstream non-execution; classify from sends and original downstream terminal evidence. Image validation/persistence failure after terminal response preserves execution facts and reports result-processing failure only.

## Related decisions

The original proposed/implemented audit searched Cua, MCP, browser, images, occupancy and recovery. No same-topic proposal existed then; other desktop-style hits were unrelated, with no whole absorption/obsolete proposal migration.

| Decision | Proposed relationship |
| --- | --- |
| [MCP client](../../implemented/architecture/2026-09-23-mcp-client.md) | Retain HTTP/auth/tool definitions; extend inline images with cross-links, not rewrite original decisions. |
| [Transport reuse](../../implemented/architecture/2026-10-17-mcp-transport-reuse.md) | Retain host credentials/stateless interfaces; consumers own computer binding. |
| [Personal MCP](../../implemented/architecture/2026-10-17-personal-durable-mcp.md) | Retain original request/approval/completion evidence; add connection lifetime/image projection. |
| [Personal browser/media](../../implemented/architecture/2026-10-18-personal-browser-media.md) | Reuse image facts/provider checks, not browser execution ownership. |
| [MCP writes](../../implemented/feature/2026-09-23-mcp-write-tools-approval.md) | Retain permissions/approval while extending incomplete-response classification/downstream terminal checks. |

Legacy MCP writes treated HTTP/JSON-RPC errors as known. Gateway-generated errors cannot prove downstream Cua completion, so this proposal explicitly extends classification. Original slice 02 would mark incomplete reads, budgets/truncation as unknown for all MCP write/unknown calls. Slice 03 would check downstream terminal evidence only for explicit computer targets. Other ordinary MCP errors/history would not be rewritten retroactively, and approvals/local effect classes remain. [Image reading](../../implemented/bug-fix/2026-10-12-read-images.md) and [progressive interaction](../../implemented/process/2026-10-14-progressive-human-interaction.md) retain visual-input/management constraints.

## Alternatives considered

- Cua CLI plus skill: cheapest trial, but production still needs screenshot records, target occupancy and no replay. Arbitrary shell cannot provide these guarantees; CLI suits isolated probes.
- Cua TypeScript SDK in both products: avoids HTTP bridge and gives structured results, but needs dual approval adapters, process/native-library lifecycle and remote recovery. Keep as a fallback if probe 01 disproves bridging, not two production routes.
- Arbitrary stdio in generic MCP: useful for more services, but broadens host-account execution/child cleanup. Only fixed Cua execution is required, not a platform.
- Configure an existing HTTP gateway alone: least code, but images, cross-call references and exclusivity remain missing. Successful discovery is not feature completion.

## Acceptance criteria

Prove original specification R1-R8 individually. Probe 01 needs actual dual-platform transport, permissions, targets and failure evidence; 02-04 provide narrow regressions/real wiring; 05 uses both production entries to verify randomized screens, action counts, screenshot history and complete export. Record real models, actual execution and human experience separately. Target changes/restart cannot bypass unknown results. Missing external prerequisites leave acceptance pending. These were rejected-plan requirements, not claims that the replacement implements withdrawn global exclusivity.

## Risks

Bridge/Cua session lifetimes may not match per-call Personal connections. Target claims/original-result queries may need a narrow executor adapter; experiment before approval. Native permissions, Linux desktop and HTTPS are delivery prerequisites, not automatically provisioned in model tasks. Screenshots expose visible desktop contents under original conversation permissions/history retention; human takeover cannot recall sent data. Per-call Personal approvals affect interaction speed; the owner may explicitly choose existing full access for continuous work, without automatic escalation.
