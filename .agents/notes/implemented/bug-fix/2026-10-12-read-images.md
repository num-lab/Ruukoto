# Agent Note: Built-in read restores images from the same restricted read

Status: implemented

## Problem

The built-in `read` uses pi, but the ordinary and read-only SubAgent `ReadOperations` omitted the optional `detectImageMimeType`. Upstream therefore returned image bytes as UTF-8 text despite existing model-image and session-record support.

## Decision

Each `read` creates an image adapter. MIME detection invokes the original reader once and captures its raw Buffer; the upstream read returns that same Buffer. The existing `imageMime` supports JPEG, PNG and WebP; pi owns image processing and automatic resizing. No content survives between calls, so later reads observe file changes. The restricted reader still checks each path component, rejects symlinks and opens with `O_NOFOLLOW`; detection adds no second file-opening path.

ToolRouter returns image blocks unchanged. The SDK stores the complete `toolResult` in JSONL, and prompt snapshots retain the actual model image input. Local images need no new inbound-media reference format. Existing pre-send capability checks reject text-only models rather than silently dropping images. [Inbound image staging](../architecture/2026-10-07-inbound-image-staging.md) separately owns IM media staging and restoration.

The worker keeps its 4 MiB limit for a complete JSON frame. Upstream's default 4.5 MiB image budget measures base64 bytes and cannot guarantee transportability. An oversized message with `opId` becomes a small error result for that operation; only messages without `opId` are fatal. Fully captured raw bytes can still be finalized through normal artifact recovery, and later tools remain usable. Upstream decode/resize omission notices remain failures, not successful visual input.

## Alternatives considered

- Wiring upstream `detectSupportedImageMimeTypeFromFile` directly into both adapters is shorter and supports GIF/BMP, but its `open(path, "r")` follows the final symlink and introduces a replacement race after authorization. Reusing the restricted reader's Buffer preserves authorization and capture semantics; this change covers only the three maintained MIME types.
- Supplying a safely opened descriptor through `/dev/fd` retains upstream formats, but native path authorization need not allow that alias. Platform-specific policy expansion is unnecessary here.
- Raising the frame limit changes the process protocol; resizing again requires reconciling dimensions and coordinate mappings. Keep the limit and report an oversized result without killing the worker.

## Consequences

Ordinary and read-only SubAgents can read supported local images. Visual input, raw artifacts and history come from one authorized read; text and permission behavior remain unchanged. Detection reads the complete Buffer earlier, but there is still one read and one raw capture. Cancellation does not leave reusable content. Local images are limited to JPEG/PNG/WebP; oversized processed results can fail transport while raw content remains available. Real recognition quality requires external model acceptance, not mocked HTTP.

## Verification

`test/07-read-images.test.ts` covers ordinary, workspace-read-only and extra-root reads, signatures, one raw capture, unchanged text behavior, out-of-scope/symlink rejection, reads after an oversized result, mocked model HTTP images, JSONL and prompt snapshots, and text-only rejection before sending. The six added cases failed against the pre-fix worker. Historical execution and independent-review records belong to the offline `read-images` work item.
