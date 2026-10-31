# Agent Note: Publish macOS restricted-start markers only after writing them completely

Status: implemented

## Problem

Trusted Node wrote `native-started` directly before loading the worker, creating the file before its contents. The host checked every ten milliseconds and could reject empty content as a corrupt marker, leaving stop unverified. Controlled Node 22/24 write windows reproduced the race. It can break real restricted tool startup, but historical reviewer timeouts without a complete child-task trace are not uniquely attributable to it.

## Decision

The trusted bootstrap fully writes `native-started.tmp` in the same private temporary directory, renames it to `native-started`, and only then imports the worker. `prepareNativeLaunch` creates a fresh 0700 directory each time; production callers never reuse prepared inputs. The fixed temporary name adds no cross-task sharing, lock or permission. Temporary files are not startup evidence. A write or rename failure terminates bootstrap without loading the worker.

The host still requires both supervisor `started` and a complete marker. Missing markers wait within the existing five-second budget; invalid/unreadable markers fail immediately. Machine-readable error classification, attached unit identity, the twelve-second stop budget, and retention of occupation/directories while stop remains unverified are unchanged. Atomic rename guarantees complete publication to readers, not power-loss durability or atomicity with other state.

This supplements [native execution](../architecture/2026-10-10-native-execution-sandbox.md) without changing platform/stop boundaries. The regression follows [observable async phases](../testing/2026-10-11-await-observed-async-phases.md), releasing the write only after the host observes its window. [Token publication](2026-10-24-personal-token-atomic-publish.md) uses the same primitive but has different ownership. Linux durable identities and persistent macOS backgrounds do not consume this marker.

## Alternatives considered

- Retrying empty content weakens corrupt-marker rejection and makes readers responsible for incomplete publication.
- Longer startup deadlines or warm tests cannot eliminate the create/write window.
- A general publishing helper or new startup protocol expands callers unnecessarily; use the existing local temporary-file/rename idiom.

## Consequences

Successful publication exposes only a complete final marker. Interruption before rename may leave a temporary file, retained/cleaned by the existing unit lifecycle. Real Seatbelt cases add controlled open/write barriers while retaining host-FD noninheritance, missing-marker rejection and stop identity checks. Invalid values, write errors and rename errors prove the worker never loads. A negative `stop=false` result is not rewritten merely because exit is observed later. Historical review and evidence remain in the offline CI atomic-marker work item.
