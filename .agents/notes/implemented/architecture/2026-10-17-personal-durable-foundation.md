# Agent Note: Personal profiles and request evidence precede recovery

Status: implemented

[Token publication](../bug-fix/2026-10-24-personal-token-atomic-publish.md) defines allowed authentication temporary files; they never become authentication sources, and old-profile rejection remains. [Personal settings](../feature/2026-10-21-personal-settings.md) adds the optional managed-skills root to strict layout/permission classification without changing locking, unknown-directory rejection or historical evidence requirements.

## Problem

The [Personal migration](../../proposed/architecture/2026-10-17-personal-pi-durable.md) requires an independent profile, one owning process, refusal to execute unknown versions and reconstructable model input. Pi 1.3.0 SQLite has no process lock, missing extensions are ignored, and ordinary beforeRequest exceptions do not prevent requests. Connecting Harness alone cannot meet these requirements.

## Decision

The foundation lives in `apps/ruukoto/src/personal-*.ts`, called by production Personal entry points, isolated tests and [local bootstrap/management](2026-10-17-personal-local-management.md). [Product entry](../simplification/2026-10-18-personal-product-entry.md) owns entry points/artifacts. Personal pins chord, pi-ai and pi-durable 1.3.0. At the original migration boundary, Coding retained Pi 0.85.1; its current package dependencies also use 1.3.0. Product assemblies do not exchange SDK objects. The overall migration remains proposed; this note owns only delivered foundation constraints.

A profile is an independent ordinary directory with a strict format marker. It accepts only known regular files and designated locally managed sockets, rejecting old directories, linked files and unsupported product/Pi/business-extension versions. Directories are 0700 and files 0600. An EXCLUSIVE transaction in owner.sqlite owns the instance lock; the lock file is never deleted. SQLite/OS releases it on normal close or process crash. [Local management](2026-10-17-personal-local-management.md) owns management-interface cleanup order. This database stores no runtime state.

managed-skills shares name classification with other top-level private directories; layout checks and post-lock chmod do not maintain separate lists. lstat first rejects links, wrong owners and group/other permissions on the managed root. After acquiring the EXCLUSIVE lock, before reading configuration or starting Harness, reuse [managed-content checks](../feature/2026-10-21-managed-skills.md). chmod does not repair invalid permissions, links or hard links. Missing optional roots do not change PERSONAL_FORMAT. Private staging, partial temporary manifests and valid orphaned packages allow reacquiring the lock, but do not count as installed skills and are not automatically deleted. Unknown top-level/management nodes remain rejected.

Persistent conversations, inputs, answers and request evidence go only to personal.sqlite. Before resuming scheduling, verify business format, every conversation's extension references/versions and then live Task definition versions. The main conversation's model changes explicitly while idle. Changing models with unfinished work rejects recovery, preventing old requests from silently reaching a different model. Incomplete first-initialization databases are also rejected: preserve the directory and choose an empty one rather than guessing missing state.

At the provider boundary, commit normalized input first; at the actual API onPayload boundary, commit the final request body. One request key joins both entries, preserving existing payload rewriting. [Background work](2026-10-17-personal-background-work.md) uses persisted ProviderDoc.sessionId to place evidence in the actual calling conversation, not main. Failed recording prevents the provider/HTTP request without relying on hook exception behavior. Request bodies exclude authentication headers; credentials still resolve through environment variables. Persistence failure causes durable to close Harness and then release the instance lock; no host loop automatically reopens it.

## Related decisions

The original active-note audit searched Personal durable, instance locks, input snapshots and model context. The [migration proposal](../../proposed/architecture/2026-10-17-personal-pi-durable.md) retains unfinished scope and proposed status. [Two products](2026-10-02-two-agent-products.md) and [session history](2026-09-19-preserve-session-history.md) continue to constrain Coding and retained old-format data. No other decision required absorption, deletion or archiving.

## Alternatives considered

- PID files and stale-lock deletion: straightforward, but PID reuse and concurrent access to different inodes after unlink require another protocol. Use a SQLite lock released with its connection.
- Check only task definitions or trust durable errors: less host code, but missing extensions are ignored and old business versions could execute current code. Verify each reference before recovery.
- Record in beforeRequest: closest to input assembly, but 1.3.0 reports ordinary hook errors and continues. Provider/HTTP boundaries enforce zero requests after recording failure.
- Replace bin as soon as the foundation works: earlier access, but IM, permissions and business tools were incomplete, violating the full-capability acceptance-before-cutover decision. The foundation initially stayed in isolated acceptance scope; the later product-entry decision owns replacement.

## Consequences

[Personal data ownership](2026-10-18-personal-memory-skills-history.md) owns the independent product's new history, memory, skills and request references; other foundation requirements remain.

Durable owns execution/history; the host adds profile protection and request evidence. The two request records duplicate normalized input, a storage cost for auditability. SQLite WAL/NORMAL establishes process-crash recovery, not retention of the latest commit through power loss. Foundation tests cannot replace complete business-tool, compaction, real-model or IM acceptance. [Service inspection](2026-10-17-personal-service-inspect.md) extends trusted host APIs and read-only external calls; [model work management](2026-10-17-personal-model-work.md) is installed on main. Children pin tools from currently enabled capabilities without inheriting parent chat.
