# Agent Note: Export complete artifacts through verified paging

Status: implemented

## Problem

Control-plane `read_artifact` returns at most 720KiB per page, while CLI stdout defaults to one 256KiB page. Redirecting stdout can truncate a large screenshot and overwrite an existing destination before an interrupted download finishes. Image artifacts already have immutable MIME/SHA-256 metadata suitable for full-content verification.

## Decision

Shared `read-artifact --output <file>` reads from offset zero in 720KiB pages on one authenticated connection and accepts only complete artifacts. The first reply verifies task/artifact IDs, total bytes, and image hash metadata. Every page must keep metadata identical, use canonical base64, and have the length required by the remaining content. Images also verify actual file signature and full SHA-256. Text uses existing metadata, page lengths, and total bytes without inventing a hash.

Write only an exclusive 0600 temporary file beside the destination. After complete reading/verification, close and atomically rename it. Failure preserves the previous target; normal error cleanup removes the temporary file. A hard kill can leave a protected temporary file, never misidentified as the exported destination. `--output` is mutually exclusive with `--offset`/`--length`. Existing single-page stdout slices still accept partial artifacts.

[Agent browser](2026-10-14-agent-browser.md) retains browser ownership/actions; this note implements its independent file retrieval. [Image reads](../bug-fix/2026-10-12-read-images.md) and [inbound staging](../architecture/2026-10-07-inbound-image-staging.md) own visual input/persistence and supply MIME/hash. [GitHub retirement](../simplification/2026-09-23-retire-github-module.md) owns server-side archive generation. Model-query restrictions for delegation/worktrees/reviews do not change owner CLI export.

## Alternatives considered

Larger single pages would exceed the 1MiB frame after base64/JSON and still not fit arbitrarily large results. Paging preserves the protocol. Accumulating all pages in memory is easy but unbounded; writing directly destroys the original target on failure. Temporary-file paging holds only one page in memory. Making stdout complete by default changes slice semantics and still leaves a partial redirected target; explicit output preserves old callers and verified replacement.

## Consequences

Large images/results escape CLI single-page limits. Changed metadata, missing bytes, corrupt images, and read/write failures report explicitly. Choosing the path authorizes replacement; new target mode is 0600. Text lacks a preexisting content hash, so equal-length changes cannot be additionally proven absent. Artifact format/protocol stay unchanged, with no automatic retry or resume.

## Verification

`test/29-cli-entry.test.ts` uses both real bins with Runtime/ControlServer to export a valid PNG larger than 720KiB, checking two pages, bytes, SHA-256, and 0600. It retains binary slices and rejects conflicting options, missing output paths, and partial artifacts. Real second-page file loss, truncation, changed DB metadata, and equal-length corruption preserve the old destination and remove temporary files.
