# Agent Note: Reuse artifacts and model restoration for MCP images

Status: implemented

[MCP host simplification](../simplification/2026-10-26-mcp-host-responsibilities.md) owns current result provenance and new ordinary-operation records. Image ordering, original bytes, artifact ownership, and non-replay after image failure remain here.

## Problem

Code MCP result shaping ignored images, and throwing isError lost attachments. Personal saved complete replies but gave models only summaries. [Cua observation](2026-10-23-cua-official-mcp.md) must become real model input recoverable from history. Image failure must not turn a received action reply into unknown effects.

## Decision

Shared stateless mcp/images.ts validates inline images by original content index: at most four, each <=8MiB. Check count/encoded length before decoding, then canonical base64, JPEG/PNG/WebP signature, declared MIME, and SHA-256. A problem occupies the original content position while other valid images remain usable. Audio/resource links report their type without downloading. Text preview stays bounded; image handling is independent of text truncation.

Code writes immutable ArtifactStore images first and returns empty visual blocks carrying ruukotoMediaRef. SDK history preserves content order, original toolCallId, and references; task.tool_result records artifact IDs. Existing presend validation checks hash/ownership and restores original bytes, while prompt snapshots retain references. Empty bodies prevent Pi from resizing original screenshots again. An MCP-specific tool_result hook sets isError from host details rather than throwing away error attachments. Old text results, ordinary HTTPS, authority, and error classification keep their paths except later explicitly superseded host records.

Personal commits the full reply before saving private images and batch registerImages under the original pi.tool Task. Validate the same Task before image writes, respecting durable's no-task-table-read-after-write constraint. Optional version-1 imageProjection and immutable ruukoto.mcp-images entries save ordered text/image references and image problems. Recovery verifies entry backlinks, original response indexes, and hashes. Provider restores through original result/media backlinks. Original request/reply evidence stays; new image-aware pages replace base64 with references. Old records without projections retain summaries and are not rewritten at startup. Normal image-processing failures become image problems; registration transaction failure rolls back before recording a problem, without changing original effect/code/remoteEnded.

[Image reads](../bug-fix/2026-10-12-read-images.md) and [Personal media](2026-10-18-personal-browser-media.md) retain local-read/provider rules. [Personal MCP](2026-10-17-personal-durable-mcp.md) retains complete replies and unknown occupancy; this adds image paging. [Transport reuse](2026-10-17-mcp-transport-reuse.md) owns HTTP and does not by itself establish stdio integration.

## Alternatives considered

Base64 as tool text is simplest but provides no visual input and can be corrupted by text truncation. Full image bodies in Code SDK history reuse local read behavior but duplicate storage and may resize screenshots again. Reusing old ArtifactStore/Task Store in Personal creates a second runtime authority; share validation only and use existing media ownership. Per-image commits avoid transaction read/write ordering but leave partial registration/projection; use same-Task batching and one projection commit.

## Consequences

Actual provider inputs can be reconstructed by original tool, content order, and hash. Bad, oversized, or unpersistable images after a complete reply never instruct replay of the original action. Files/database are not cross-store atomic; transaction failure can leave private unreferenced image files. Signature checks do not guarantee model decoding, and unscaled screenshots can still exceed provider image budgets.

Offline validation/mock providers do not prove real vision quality. The separate Cua transport slice owns its 48MiB stdio-message budget and pre-action refusal for nonvision models; ordinary HTTPS tools cannot reject every text model merely because result type is unknown. Historical implementation and product acceptance are in the offline copies of `.scratch/cua-integration/issues/02-mcp-images.md` and `05-acceptance.md`.
