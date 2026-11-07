# Agent Note: Publish Personal final files against validated report coverage

Status: implemented

[Complete Telegram delivery](2026-11-06-personal-telegram-delivery.md) adds original-byte document uploads for committed publication members, with separate text/file outcomes and the same 8 MiB completeness limit. Desktop authentication and preview/save rules remain here; QQ media stays in its later milestone.

[Inbound attachments](2026-11-07-personal-inbound-attachments.md) adds exact-work granted originals to eligible publication sources. It reuses the publication and delivery rules here without granting another work's artifacts or replaying business effects.

## Problem

Personal retains immutable operation artifacts, but an artifact alone does not mean the owner requested its delivery or that it satisfies current work requirements. Automatically displaying every screenshot would expose intermediate captures. Repeating a write after a failed transfer would repeat a completed business effect. [Issue #43](https://github.com/num-lab/Ruukoto/issues/43) requires explicit final-file publication, bounded authenticated delivery and native preview/download under the existing report and authority rules.

## Decision

Child work uses `publish_output` only for an owner-requested final file or screenshot. The tool records a data-only immutable intent with its original model call, source, work and actual request instruction snapshot. It accepts an artifact returned by that same work or a successful, stopped `write_file` operation. Write-derived outputs save the original complete UTF-8 parameters without reading or rewriting the target. Other artifacts retain their original bytes, MIME, identity, size, hash and partial flag. Same-key recovery returns the saved intent; unsuccessful storage never authorizes replay of the original business operation.

Output eligibility follows the exact accepted-note snapshot. An amendment excludes older unpublished intents, including an intent whose tool response was lost before safe replay. The existing [report publication](2026-11-04-personal-report-publication.md) process records eligible output IDs in immutable member coverage and freezes those IDs in its validated publication. Registered intents are unavailable through desktop reads until that publication commits. Historical coverage is reconstructed at its original entry boundary, so later work and amendments cannot change a published attachment. Original tool, request, source, permission, entry binding and full work provenance are verified on reopen.

Each delegation may register at most eight current final files. Excess registration fails explicitly and leaves completed effects and earlier files intact. The limit bounds metadata within existing timeline and event frames; no file is silently omitted. Names are basenames of at most 128 characters, MIME is bounded, and desktop metadata exposes publication/output IDs without artifact identities or server paths.

Authenticated `GET /desktop/output` establishes committed publication membership before returning a chunk. Each chunk contains at most 128 KiB of original bytes plus the same metadata. Existing remote authentication and profile binding run before and after the backend read, including revocation while a read waits. The complete-output limit remains 8 MiB. Partial and oversized capture stays visible as undeliverable; it cannot become a complete preview or download by reading every saved chunk.

The Node desktop host accumulates at most 8 MiB, verifies contiguous offsets, unchanged metadata, canonical base64, exact byte length and final SHA-256, then uses the native platform. Renderer requests carry only original connection/publication/output identity. One transfer runs per host; connection changes invalidate late results. Both maintained hosts use native save dialogs and Quick Look. After the chooser, the host rechecks authentication against the original published file before saving. A 0600 temporary file beside the destination is synced and renamed; failed transfers leave the previous target intact. Preview files use private temporary directories; the host closes the original viewer and reclaims its files on replacement, connection replacement or shutdown. Delivery failure is reported independently and never calls business execution.

MyGo's save chooser waits for an explicit native choice after its private pipe write completes. The exact Personal save request and its `output_choose` callback have no response deadline while waiting for the owner; pipe writes and other requests retain their bounded deadlines. Context cancellation, pipe closure and application shutdown still reject pending requests. A generic 60-second response deadline incorrectly closes a healthy connection when the owner spends longer choosing a destination. Extending that deadline only moves the same failure to a later human action, so save selection follows dialog lifetime and authentication is checked again afterward. This specializes the [MyGo transport](2026-10-17-desktop-mygo-experiment.md) without changing unknown-effect or replay rules.

During MyGo shutdown, the private pipe still accepts the original `output_close_preview` callback and its response. New native operations and credential requests remain fenced. The Node host waits for the verified viewer stop before removing its temporary directory; suppressing that cleanup reply after entering shutdown leaves the last preview file behind. EOF settles pending callbacks even if host shutdown already began, so a lost pipe cannot leave cleanup waiting indefinitely. A failed stop remains a reported cleanup failure and does not authorize deleting files still in use.

Before enabling output capability on an old profile, the host checks original pending inputs/work/questions, unresolved effects, directory claims, browser bindings and retained interactive/Cua executions before opening the Harness. The original version must finish, cancel or recover them. This activation changes configuration and adds a new output index; it does not rewrite history or reinterpret uncertain effects. Existing schedules keep their captured tool ceiling; comparison ignores only the newly introduced capability when absent from their scope. Direct scheduled conversations exclude `publish_output`.

The settings blocker scanner accepts both historical evidence text and native immutable effect claims. Full family recovery verification still proves those claims; a successful human claim does not establish stopping.

This extends [original-byte artifacts](2026-10-17-personal-tools-access-artifacts.md) and partially supersedes the file-loop milestone's deferred preview/download. Report generation, validated text publication and source authorization retain their owning decisions. The linked Telegram delivery decision supersedes its previously deferred media transfer; QQ media remains in its later milestone.

## Alternatives considered

- Publish every captured artifact automatically: avoids a new tool, but confuses intermediate state with requested final output and bypasses amendment validation.
- Download arbitrary artifact IDs: reuses storage readers, but exposes unregistered or unpublished artifacts and conversation-level ownership is too broad for reused children.
- Read a successful write target again: obtains current disk bytes, but adds another operation and can deliver changed contents under the old write's identity. Preserve the completed write's exact content instead.
- Embed complete bytes in timeline JSON: simplifies one request, but exceeds existing response limits and prevents per-chunk authentication. Keep bounded reads and final integrity verification.
- Use renderer download links: smaller UI code, but both native hosts block browser downloads and must own destination selection and filesystem access.
- Page an arbitrary number of attachment descriptors: preserves unlimited count, but adds a second pagination flow without a demonstrated need. Reject excess registrations with an explicit eight-file limit.

## Consequences

Publishing copies successful write content into the immutable artifact store. A crash between byte publication and intent commit can leave an orphan private file; it never permits business replay. Every chunk revalidates the stored file, so an 8 MiB transfer trades repeated hash work for original-byte certainty. Safe read retries may start another download, while successful writes, intents and committed publications retain their identities. Native dialogs/viewers and old-profile transition need real-platform evidence beyond deterministic helper tests. Acceptance evidence and request-size measurements belong to the Issue; this note records the maintained contract.
