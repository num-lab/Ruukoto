# Agent Note: Stage inbound images, promote them to task artifacts, and restore before sending

Status: implemented

Original identifier: ADR 0024.

## Problem

Owner-private Telegram/QQ images must be downloaded, validated, and durable before task creation, but task artifacts require an existing task owner. Reception, task creation, and files have crash windows; duplicates and resumed tasks must find the same image without spreading download URLs, credentials, or full base64 through history.

## Decision

Before registering an ordinary inbound event, download/validate/persist images in a separate staging and rejection ledger keyed by source, external message ID, and image order. Do not create task artifacts early or persist download URLs/credentials. Accept JPEG/PNG/WebP only, at most four images/message and 8 MiB/image, matching declared MIME to magic bytes; network errors get at most three attempts.

After task creation, prepare immutable artifact files, then atomically commit event task_id/artifact_refs, image artifact metadata, and staging ownership in SQLite. Files and SQLite are not atomic together: deterministic artifact IDs, content hashes, and restart checks make file-present/metadata-absent retryable. Recover downloaded-but-unregistered, registered-but-taskless, and created-but-unpromoted states through the original message key. An incomplete download without a recoverable source rejects explicitly. Clean unbound staging after 24 hours while retaining its status; task-bound images remain.

History and prompt snapshots store stable image references/metadata, not repeated base64. Context budgeting uses image placeholders; immediately before provider send, restore from task artifacts and verify ownership, MIME, length, and hash. `resumesTaskId` chains retain source images. This preserves the distinction between [complete history](2026-09-19-preserve-session-history.md) and [request compaction](2026-09-26-lossy-context-compaction.md).

Text accompanying an image never enters the IM approval-command parser. If the selected model lacks image support, reject with a retained reason; do not send a text-only substitute or switch models. Download exhaustion, format/limit rejection, and unsupported model each use one of three host-fixed plaintext receipts, deduplicated through the public outbox using rejection-ledger message ID. Model text does not determine error explanations.

Historical [Coding import](2026-10-04-legacy-instance-import.md) and [personal import](2026-10-05-personal-instance-import.md) exclude staging/rejection ledgers. Promoted images travel with task artifacts and retain media metadata; existing personal-import sending invalidation still applies. These are not new durable import support.

## Entry and recovery details

Telegram selects the largest `message.photo` PhotoSize and downloads via getFile. QQ uses only OneBot image-segment url/file, never arbitrary URLs from message text. Caption/QQ text remain in the same user message, with platform image order preserved. Telegram advances offset only after a final decision, including permanent rejection. QQ retains rejection after adapter retries exhaust. Old-generation redelivery remains subject to its original pinned-target checks and cannot be wrapped as a new-entry message.

A corrupted image explicitly finishes its already-created task while allowing later text work. Fixed image-rejection and ordinary failure receipts must not duplicate one another. [Personal browser/media ownership](2026-10-18-personal-browser-media.md) owns Pi 1.3.0 durable binding, acceptance, and recovery; this note retains shared-assembly media/security rules.

## Alternatives considered

- **Store full base64 in JSONL.** History would carry replay bytes directly, but initial and resumed turns repeatedly persist the same image and blur history versus request input. Keep stable references and restore image blocks before send.
- **Create artifacts during reception.** Avoids promotion, but lacks a task owner and leaves half-bound references if task creation fails. Stage idempotently by external message first; a rejection record is not an ordinary InboundEvent.

Original rationale is historical offline `.scratch/agent-direction/issues/25-multimedia-messages.md`, especially history semantics and the requirements discussion.

## Consequences

Original images remain replayable by task reference; reception, rejection, and ownership are verifiable, and image captions cannot authorize operations. Deterministic IDs/hashes/recovery pay for the filesystem/SQLite window. Unbound data lasts only 24 hours; unrecoverable downloads reject. No transcoding, resizing, SVG/GIF, image replies, OCR, external vision service, or automatic model switching is introduced.

## Verification

Historical issue 25 recorded passing typecheck/diff checks, a full suite with 995 passed/zero failed/one gated model skip, related checks 41/41, and model-pinning/diagram checks 5/5. Tests 90/95/96/97/98 used real Runtime/SQLite/files with mock platforms/models to inspect HTTP image payloads, two-level resume, compaction, redelivery, crash windows, capability rejection, and receipt idempotence. The offline issue held complete logs and Linux approval logs.

Real Telegram Bot API/NapCat downloads, real vision recognition, and real replies were not exercised. tx test/08 16/16 proves approval regression only, not real IM image acceptance. This migration reruns none of these runtime tests.
