# Agent Note: One backend owns the personal profile and exposes local management

Status: implemented

[Configuration saving and activation](2026-10-25-personal-settings-versions.md) narrows the original stop/global-idle rules. [Tailscale HTTPS/WebSocket](2026-10-24-personal-tailscale-https.md) adds a separate remote entry without replacing the local socket, single Harness, or lock. [Atomic token publication](../bug-fix/2026-10-24-personal-token-atomic-publish.md) owns publication details; authentication and refusal of malformed existing tokens remain.

## Problem

[The durable migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) keeps a guided CLI, requires work to survive client disconnection, and gives the running backend exclusive Harness ownership. Reusing the old CLI/developer/configuration stack would reintroduce the retired Runtime and control protocol. Upstream admission deduplicates by request ID/type without comparing bodies, and cannot atomically commit admission with host documents.

## Decision

The personal app owns the entry. The default profile is `~/.ruukoto-durable/`; `RUUKOTO_PERSONAL_DIR` selects a separate new profile. Development ignores inherited profile directories and uses the first 12 SHA-256 characters of checkout realpath for an external development profile. Configuration, backend, and clients never read old profiles or copy old credentials. Child environments remove old `RUUKOTO_*` configuration and reintroduce only the personal directory, current model, and credential variables for enabled IM.

Local chat uses the current main session; the [service wizard](2026-10-17-personal-service-configuration.md) and [IM entry](2026-10-17-personal-telegram-entry.md) add their own capabilities. Bins, root start, compatibility command, and deployment wiring belong to [the product entry](../simplification/2026-10-18-personal-product-entry.md); production handoff requires separate acceptance.

The ordinary CLI starts a detached backend and leaving the wizard does not stop its work. Development instead owns its foreground Node-watch backend and stops it on exit. Its `--config` menu uses the same profile without source watching; menu code changes require reopening. Development rejects enabled QQ/Telegram before modifying configuration, tokens, or runtime facts, and never connects them. This distinction replaces the original note's ambiguous claim that every menu-owned backend stops when the menu exits.

### Lock and interface lifetime

The backend obtains the SQLite instance lock before reading runtime configuration, owns the Harness, and exposes authenticated HTTP over a Unix socket, not the old control protocol. This local entry opens no TCP listener; the later remote entry is separate. Each start publishes a fresh token in a mode-0600 regular file; every request authenticates. A malformed existing token refuses startup rather than being silently overwritten. Directories are 0700, and configuration, logs, pending client files, and socket are 0600. Only the lock holder may write configuration or remove a stale socket: inability to connect is not proof the backend stopped. Temporary-file rename replaces one file, not an atomic transaction with durable storage.

[Work controls](2026-10-17-personal-work-controls.md) query original work, page results, record cancellation, and close idle identities over the same interface without another Harness. A stop request finishes its response, stops admission, drains in-flight handlers, then closes the Harness. Harness fault shutdown also runs `beforeUnlock` to drain the interface/handlers before releasing the profile lock. Cleanup failure retains the lock and reports rather than letting another instance overwrite a live socket. Passing an already-held named profile lock transfers release responsibility to Harness; `close()` waits for cleanup.

The guided menu groups chat, work/schedules, approvals/verification, permissions/data, configuration, and maintenance, reusing capability managers. Authenticated local mode selection shares the local/Telegram default; QQ has its own. Changes affect only newly admitted input. Local management may inspect and version-revoke service grants, including old-entry grants, but creation remains tied to an original IM pending operation. Both IM platforms answer `/帮助` and `/状态` in the host, displaying configuration/history provenance separately. Memory, skills, and history use their existing tools/managers, not another IM business state machine.

### Input identity and lost responses

Before admission, a program-generated UUID selects a `ruukoto.local-input` document. Its SHA-256 fingerprint uses JSON-string encoding so lone UTF-16 surrogates remain distinguishable. Current records also pin local permission mode/version and an admission entry; work continuations include their work identity in the digest. These are admission facts, not a second task-state authority. Same-key/different-body or ownership conflicts fail. If the fingerprint commits but submission does not, querying never executes it: the owner explicitly chooses continuation with the original key. Durable remains authoritative for input, task, and result.

Before sending, each client exclusively creates its own `pending-<UUID>.json` (or work-continuation counterpart) with original key/body, avoiding a shared overwriteable slot. Only a query confirming the original submission permits deletion; configuration/startup does not clear pending files. After response loss, query first; if absent, offer original-key continuation or retention, never automatic resend/new key. Client files grant no execution authority and are not atomic with the backend database. Bodies may temporarily exist in several local client records.

Request bodies are bounded at 128 KiB, input at 16 KiB, responses at 256 KiB, and client total time at five seconds; backend receive timeout is ten seconds and idle connection timeout fifteen. Recent diagnostics scan 64 entries, display at most 16 messages and 8192 characters per message, and label truncation/interrupted fragments. Full durable history remains intact; this is not a complete history export. Internal errors return safe guidance, not stacks, credentials, or request bodies, and terminal output filters control characters.

### Configuration scope and evidence

The original implementation shared an unresolved-work check for configuration and Harness startup. It exempted only fully verified scheduler supervisors: correct index, version, root conversation, backend ownership, and empty arguments. Open scheduled runs, active ordinary tasks, queued/placed input, and capability-specific unknown effects still blocked. Whole normalized model configuration, including endpoint/API/credential variable changes under the same model name, was checked before save; identical configuration remained usable for recovery. IM disablement remained possible despite pending approvals.

Those broad save barriers and permanent command/service path restrictions are historical. [Settings activation](2026-10-25-personal-settings-versions.md), [request configuration](2026-10-25-personal-request-configuration.md), [execution versions](2026-10-25-personal-execution-configuration-versions.md), and [IM updates](2026-10-25-personal-im-updates.md) now own object-scoped saving and activation. They retain original-operation identity and the single writer, not global shutdown as a normal prerequisite.

Real-model acceptance uses an explicit switch and owner-selected model in a temporary profile. Two inputs straddle stopping and creating a new backend process; the second recovers a random marker only from durable history, while four request-evidence records are checked for credential absence. Only the selected model is extracted; credentials travel in temporary process environment, never personal configuration. SSH stdin may transfer the selected configuration in memory without adding runtime legacy-config import. Missing prerequisites exit 2; cleanup removes only this run's directory after verified stop.

## Alternatives considered

- Let CLI reopen Harness: no local protocol, but two writers violate exclusive ownership.
- Reuse ControlServer/ConfigTui/runDev: mature interaction and monitoring, but imports old Runtime/catalog/projection authority.
- Rely only on durable request IDs: minimal code, but different bodies silently return the old submission and lost responses lack original-request evidence.
- Ignore supervisor tasks independently in each configuration function: locally simple, but misses startup/open runs and can exempt tasks with wrong ownership. Reuse complete relationship verification.
- Check model changes only on startup: shorter saves, but loses the original file first and misses same-ID endpoint changes. Verify the whole candidate before saving.
- Release the lock before listener cleanup: shorter shutdown, but a new instance could replace the socket while old cleanup still targets it. Keep the lock through cleanup.

## Consequences

Isolated configuration and session checks become repeatable without changing Coding's runtime authority. Costs are a local request protocol, per-input admission facts, temporary client bodies, and protected diagnostics. The backend does not automatically restart. Narrow tests use real sockets/processes/SQLite and model substitutes; real models, IM, tools, permissions, and owner experience still require their own acceptance and do not follow from these tests.

[Profile foundations](2026-10-17-personal-durable-foundation.md), [backend/terminal separation](2026-09-19-detach-terminal-from-task-runtime.md), [two products](2026-10-02-two-agent-products.md), and [guided human interaction](../process/2026-10-14-progressive-human-interaction.md) retain their independent decisions. The original note search found partial overlaps but no fully absorbed/archive candidate. [Persistent owner questions](../../proposed/feature/2026-10-21-persistent-owner-questions.md) retains the broader proposal; [implemented owner questions](../feature/2026-10-21-personal-owner-questions.md) now provides local selection, answers, and original receipts under these lock/recovery rules.
