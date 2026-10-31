# Agent Note: Give Coding session background processes independent directory occupancy

Status: implemented

[Code scheduled work](2026-10-25-code-scheduled.md) extends eligible provenance to trusted scheduled root turns and continuations, distinguishing `coding-schedule` from `coding-owner`. Authorization, launch-once, directory handoff, and stop verification remain. A run cannot close while its background execution is active or stop-unverified; canceling its plan stops the run's background work without releasing unverified occupancy.

## Problem

Ordinary bash reclaims temporary execution at call/task completion, so a development service cannot remain available to later tools or owner turns. Keeping a process group alone loses launch/output/recovery identity; keeping the original task's occupancy lets task settlement or queue recovery incorrectly release it.

## Decision

Expose `process_start/status/output/stop` to eligible full-access Coding input. Background execution belongs to the session independently of the initiating Task and Driver worker. Ordinary bash remains foreground. Plan/restricted input, child work, workflows, and internal summaries cannot launch; the later Code-schedule exception requires verified provenance. A later restricted owner turn may inspect the original record and request trusted stop, but does not inherit full-access browser authority.

Persist `starting` before launch. At a sequential tool boundary, verify the temporary worker and descendants stopped, then atomically transfer root occupancy from `task_id` to `process_id`, save the reference snapshot, and enter the current turn's conversation phase. Claim launch only once immediately before dispatch; recovery and repeated original operations never dispatch the command again. Task termination/cancellation, `agent_wait`, and `resume_queue` cannot release transferred occupancy. Even the same session must stop the background process before editing, preserving a single writer. A new observation turn without prior `agent_wait` uses the saved background references without reloading workspace instructions, skills, or MCP.

Observation exposes only this session's status/logs/stop, questions, and a browser with still-valid full-access provenance. Assembly, pre-send, and actual calls share that eligibility. Observation identity persists until directory reacquisition, so a just-stopped process does not make status unavailable before business tools recover. After a pending question, retain only no-external-effect status/logs and end the turn under the question protocol. Invalid original provenance or directory identity records stop and prevents model requests relying on invalid references. Changing the session default does not revoke original execution.

### Stop identity and output

Linux reuses machine/boot/scope/InvocationID/cgroup dev/ino identity and fingerprint, stopping through the verified directory FD. macOS persistent supervision stores machine, boot, evidence-directory dev/ino, random token, fingerprint, and supervisor uniqueid/start/pidversion. Recovery signals only matching identities through atomic kernel operations. A private successful-stop receipt requires managed execution and confirmed descendants stopped plus EOF on both pipes.

Full access conservatively checks unknown orphans only against verified scope: historical managed PGIDs/SIDs and known member PIDs form a refusal set, accumulated by complete samples. It does not accumulate host scope before the root establishes its own group/session, and never uses that set as a signal target. This avoids classifying separately created browser daemons as unknown descendants while remaining conservative about ordinary descendants of managed ancestors that changed group/session. The old restricted mode retains all-UID orphan checking. A killed supervisor without a receipt stays `stop_unverified`; never follow up with a bare-PID kill. Full access cannot guarantee recovery of deliberately detached processes or external services.

The independent worker reuses the data/result byte protocol but records launch receipt, root command exit, output drain, and whole-unit stop separately. Root exit records only code/signal and does not kill surviving descendants; execution remains until explicit/lifecycle stop. Combined stdout/stderr is capped at 16 MiB; short writes continue, while write failure/budget exhaustion preserves captured bytes, marks partial, and stops. Private regular log files are checked for identity, length, and SHA-256. Pages contain at most 32 KiB with text and base64; decoding never alters original bytes. Missing drain proof or host crash remains partial. Stop proves neither external business outcome nor rollback.

### Client barriers and persistence

Ending all session backgrounds saves an original request key, accepted-event watermark, and fixed target set, also blocking earlier accepted starts not yet handed off. Repeating that key never expands to later starts. Closing a window, archiving, switching sessions, or disconnecting does not stop execution. Clients save the key before sending; an unknown response permits status lookup and explicit same-key verification, not a new close request. Unreadable original directories or corrupt records prevent creating a fresh end key.

Query generations discard stale queries only. Stop/end replies are checked against original session/instance, live refresh must retain action results, and late old-session replies cannot affect the new session. Application shutdown drains original executions; restart verifies stop and never restarts services.

The original change introduced schema 49 and protocol 37; these are historical versions, not current constants. Protocol 37 jointly covered [desktop search](2026-10-21-desktop-spotlight-search.md), persistent questions, and session backgrounds to prevent partially capable peers sharing a handshake version. Exact-version refusal and retaining old profiles for matching code remain. Offline import refuses background records or close barriers rather than dropping facts and enabling execution. SQLite state/events commit together; logs, platform evidence, and JSONL are not atomic with SQLite.

## Alternatives considered

- Remove ordinary bash cleanup: few changes, but inherited pipes can hang calls, task completion still loses ownership, and recovery lacks trustworthy identity.
- Reuse the original task key or allow background/foreground co-occupancy: fewer query changes and live editing, but settlement/recovery can release it incorrectly and arbitrary shell cannot prove a single writer. The owner chose stop-before-edit for the first version.
- Rewrite all cross-platform execution: superficially uniform, but Linux primitives and the macOS identity supervisor already exist. Add persistent mode and reuse the protocol instead.
- Create a new close key after response loss: simpler client code, but may stop executions started after the original request. Retain its target set and verify the same key.

## Consequences

Services survive tool calls and owner turns while single-writer and no-replay recovery rules remain. Unverified stop keeps the directory occupied, and macOS cannot automatically clear it without supervisor evidence. Retained logs have no global disk quota. Historical implementation/review and real platform/model/browser/client gaps were held by retired `.scratch/agent-tool-completion/issues/03-coding-background-processes.md` (offline provenance); static checks or exit codes do not prove business success.

This implements the Coding slice of [the background proposal](../../proposed/feature/2026-10-14-bash-background-lifecycle.md). [Personal backgrounds](2026-10-21-personal-background-processes.md) now implements its separate durable records and main/child/schedule provenance checks, reusing low-level execution/log/stop primitives rather than Coding Store. [Full access](2026-10-12-full-access-current-account.md), [unverified-stop retention](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md), [wait/report ownership](../architecture/2026-10-14-agent-wait-and-report-ownership.md), and [Linux execution identity](../architecture/2026-10-17-native-linux-execution-identity.md) retain their independent rules. The original audit found no fully absorbed/archive candidate.
