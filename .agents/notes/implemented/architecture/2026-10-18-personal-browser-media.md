# Agent Note: Let durable own personal browser and image provenance

Status: implemented

[Cua](2026-10-23-cua-official-mcp.md) reuses image records/provider checks, with computer-execution ownership separate from BrowserManager. [MCP image results](2026-10-23-mcp-image-results.md) reuses this media chain, verifying Task before registering multiple images from one original tool; providers create no extra runtime state.

## Problem

Personal artifacts/permissions were durable, but old browser tools depended on legacy tasks/approvals/artifacts and image staging on SQLite inbound state. Reusing entire classes would restore a second runtime authority. Browser prelaunch facts, unknown webpage effects, and actual model images must be verifiable from the new profile.

## Decision

Reuse BrowserManager for process/CLI/attachment only, with persistence callbacks that can await durable commit. Personal extensions own bindings and native-tool admission/start/observation/recovery. Browsers require full-access provenance from the owner main or explicitly authorized independent schedules, never children/restricted sources. Cancel/crash stops and verifies original execution without restoring pages or resending actions. Page effects and process stop are separate facts; unknowns enter existing provenance pause/report waiting.

Images use private immutable artifacts; durable stores received/rejected/bound references, not credential-bearing download sources. Inputs keep typed image references. Immediately before provider send, verify provenance/bytes/model capability and restore vision blocks; input/actual-payload evidence retains reconstructible references. Text/pages/model output cannot forge host bindings. Image-bearing text never enters approval-control parsing.

[Scheduled work](2026-10-18-personal-durable-scheduled-work.md) explicitly extends full-access browser use to independent scheduled sessions, each with its own binding/pause/stop/captures. Do not copy the main browser binding. Children remain ineligible. Paused schedules may query/stop/cancel, not replay page actions.

[Browser](../feature/2026-10-14-agent-browser.md), [inbound images](2026-10-07-inbound-image-staging.md), [image reads](../bug-fix/2026-10-12-read-images.md), and [personal tools](2026-10-17-personal-tools-access-artifacts.md) retain identity/media-limit/artifact/permission rules. This note owns durable assembly, not Coding storage migration; the original audit found no same-topic proposal to discard.

### Provenance and provider checks

Local admission pins authority for tools/derived work; a later default-mode selector cannot expand old queues. Filter browser definitions before provider send by actual root provenance, and recheck at execution. Artifact reads are independent of configured data directories, but a child still reads only its own artifacts. Insufficient vision capability produces fixed inbound feedback or a textual screenshot/local-image tool error; provider still rejects unknown/missing/modified images.

A delegation report is internal read-only reference input, not owner input. Browser eligibility identifies that entry kind and omits browser tools without sending it to an owner-only permission parser. Its own provider checks still verify original Task/input/member stopping/pause. Missing/unknown provenance fails. Treating a report as owner input would fail before report request evidence; inheriting the original owner's browser tools would turn a reference into new action authority. Remove only the browser definition.

Restore image bytes only just before provider send. Snapshot rewriting handles known image fields, not arbitrary JSON tool parameters. Equal-byte images with different origins retain mapping facts so deduplication cannot hide provenance. Inbound text retains artifact references; pi's text compaction summary is not vision detail, and original history remains. Commit invalidation before cleaning 24-hour unbound files. A completed download lacking a committed ready record recovers from original bytes without downloading again.

Responses-native tool images occur in function_call_output.output arrays, unlike ordinary message content. Snapshot parsing covers that actual location with the same byte/MIME/exact-count verification. Traverse only known image positions, never recursively interpret parameter JSON/output strings. Ignoring tool output undercounts valid screenshots and blocks requests; weakening total-count comparison would hide deleted/duplicate images, so expand known-position coverage instead.

## Alternatives considered

- Reuse old browser tools/InboundMediaStore: less adapter code, but restores old Task/Store facts contrary to one runtime authority. Reuse only stateless validation/process management.
- Submit base64 directly to durable: closest to native inputs, but repeats identical image bytes in history/requests. Store stable artifact references and restore at send.
- Queue synchronous persistence callbacks with an implicit flush: fewer shared-method changes, but each prelaunch point must reliably await persistence and can miss a flush. Make awaiting explicit.

## Consequences

Personal browser/media reuse independent implementations without old Runtime/Store authority. Shared persistence callbacks can await; Code retains its synchronous transaction callback and pause callers await persistence. Unknown personal actions close the old browser and may lose page evidence, without proving external effects or resending. Binding/configuration/admission/start/observation/pause/verification/backend-stop tasks have history reverse links; deleting an index cannot release an unknown claim.

Private byte files and durable commits are not atomic: bytes saved without a reference may remain as private residue. Bound images are retained and no whole-profile disk quota was added. No arbitrary platform file broadcast, automatic model switching, or child access to host browser was introduced.

Historical offline regressions, real macOS browser/SIGKILL/cancel, independent review, and Linux checks lived in `.scratch/personal-pi-durable/issues/30-browser-media.md` and remain offline provenance, preserving initial failures separately from fixes. Three-API transport/real-browser engineering evidence is separate from real vision-model/IM acceptance; missing prerequisites leave those items unverified, not covered by tool substitutes.
