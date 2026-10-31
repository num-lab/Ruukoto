# Agent Note: Snapshot selected Desktop files before binding them to tasks

Status: implemented

Related: [Coding message ordering and steering](../feature/2026-10-28-coding-message-control.md).

## Problem

The approved Desktop attachment button needed real file input, while submit accepted only strings. Inserting a path would read later file contents and depend on original-file permission. Putting full base64 in submission/JSONL would exceed the 1MiB control frame and duplicate storage.

## Decision

The main-process system picker owns source-file selection; renderer supplies neither paths nor uploaded bytes. Main uses a non-symlink-following descriptor for bounded reads and verifies file state before/after. Within one pinned instance, each file uploads to protected backend staging in 192KiB chunks. Existing inbound-image limits apply: four files per selection, 8MiB each. Ordinary and empty files are accepted. Staging reference, metadata, hash, and instance are fixed. Replaying the same chunk is idempotent; missing chunks, conflicting content, instance changes, or corruption fail.

Optional submit/continue `attachments` carry only stable ID, safe filename, and size. Main retains pending-verification requests unchanged. Backend compares authoritative staging metadata and includes it in the idempotency digest; requests without attachments keep their old digest. Queuing requires valid attachments or nonempty text. Finalize files first, then bind task, immutable artifact metadata, and `task.attachments` provenance event in one SQLite transaction. Files and SQLite are not atomic: transaction failure can leave immutable orphan files. Matching ID/hash retries are safe; committed history/artifacts are not rolled back.

Driver restores owner attachments only from `task.attachments` and the continuation chain, never arbitrary task artifacts. Ordinary references live in user-message `ruukotoAttachmentRefs`; context explains utf8/base64 reads through `read_artifact`. Images reuse `ruukotoMediaRefs` and restore visual bytes just before sending. Original user text gains no local paths. History exposes only safe filename/size to renderer and retains attachment-only input. Branching verifies provenance events before freezing references. Every artifact with `contentHash` forbids append and verifies the original-byte hash when read.

[Inbound images](2026-10-07-inbound-image-staging.md) keeps visual restoration and image persistence; [artifact export](../feature/2026-10-14-artifact-file-export.md) keeps artifact scope/export. This note owns the Desktop owner-selected-file input path.

## Alternatives considered

Granting read access to the original file reuses normal read tools but allows content changes/disappearance and exposes a path instead of fixed content. A snapshot grants no neighboring-file access. Showing filenames alone is smallest but leaves the model unable to read real attachments. A new table is unnecessary because artifacts and durable events already represent ownership/provenance. Staging manifests do not duplicate a bound flag alongside SQLite.

## Consequences

Ordinary attachments are byte-readable through `read_artifact`, not automatically converted into parseable documents. Visual images remain JPEG, PNG, and WebP only. Unsubmitted/removed staged snapshots are retained to protect unresolved requests and restart recovery. There is no automatic cleanup; per-file/selection limits do not bound cumulative disk use. Future cleanup must avoid pending submissions. Desktop migration owns the protocol bump so old backends cannot silently ignore attachments.
